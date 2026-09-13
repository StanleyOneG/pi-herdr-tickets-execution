import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  CapturedModel,
  WorkerAllocation,
  WorkerIdentity,
  WorkerObservation,
  WorkerRuntimePort,
  WorkerStatus,
} from "./contracts.js";
import {
  WORKER_BRIDGE_AGENT_ENV,
  WORKER_BRIDGE_ENDPOINT_ENV,
  WORKER_BRIDGE_NONCE_ENV,
  WORKER_DECISION_REQUEST_DIRECTORY_ENV,
  WORKER_DECISION_RESPONSE_DIRECTORY_ENV,
  WORKER_READINESS_COMMAND,
  type WorkerBridgeChannel,
  type WorkerDecisionRequest,
  type WorkerBridgeTransport,
  type WorkerCommandSource,
  type WorkerReadinessReceipt,
} from "./worker-bridge-protocol.js";

const execFileAsync = promisify(execFile);
const REQUIRED_SKILLS = ["skill:implement", "skill:tdd", "skill:code-review", "skill:handoff"];
const REQUIRED_TOOLS = ["read", "bash", "edit", "write"];
const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export const WORKER_BRIDGE_EXTENSION_PATH = fileURLToPath(new URL("./worker-bridge.ts", import.meta.url));

export interface HerdrCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HerdrCommandExecutor {
  execute(args: string[], options: { timeoutMs: number }): Promise<HerdrCommandResult>;
}

export class ExecFileHerdrCommandExecutor implements HerdrCommandExecutor {
  async execute(args: string[], options: { timeoutMs: number }): Promise<HerdrCommandResult> {
    try {
      const result = await execFileAsync("herdr", args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: options.timeoutMs,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
      return {
        code: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
  }
}

export interface HerdrWorkerRuntimeOptions {
  executor: HerdrCommandExecutor;
  bridge: WorkerBridgeTransport;
  bridgeExtensionPath?: string;
  shellReadyTimeoutMs?: number;
  agentStartTimeoutMs?: number;
  bridgeReadyTimeoutMs?: number;
  promptTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Production WorkerRuntimePort adapter for an owned ordinary interactive Pi TUI in Herdr. */
export class HerdrWorkerRuntime implements WorkerRuntimePort {
  private readonly channels = new Map<string, WorkerBridgeChannel>();
  private readonly shellReadyTimeoutMs: number;
  private readonly agentStartTimeoutMs: number;
  private readonly bridgeReadyTimeoutMs: number;
  private readonly bridgeExtensionPath: string;
  private readonly promptTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: HerdrWorkerRuntimeOptions) {
    this.bridgeExtensionPath = options.bridgeExtensionPath ?? WORKER_BRIDGE_EXTENSION_PATH;
    if (!isAbsolute(this.bridgeExtensionPath)) throw new Error("Worker bridge extension path must be absolute");
    this.shellReadyTimeoutMs = positiveTimeout(options.shellReadyTimeoutMs ?? 30_000);
    this.agentStartTimeoutMs = positiveTimeout(options.agentStartTimeoutMs ?? 60_000);
    this.bridgeReadyTimeoutMs = positiveTimeout(options.bridgeReadyTimeoutMs ?? 10_000);
    this.promptTimeoutMs = positiveTimeout(options.promptTimeoutMs ?? 1_800_000);
    this.pollIntervalMs = positiveTimeout(options.pollIntervalMs ?? 100);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds): Promise<void> =>
      new Promise((resolve): void => { setTimeout(resolve, milliseconds); }));
  }

  async allocate(input: { workspaceId: string; agentName: string; cwd: string }): Promise<WorkerAllocation> {
    if (!bounded(input.workspaceId) || !HERDR_AGENT_NAME.test(input.agentName) || !isAbsolute(input.cwd)) {
      throw new Error("Herdr allocation request is incomplete or unsafe");
    }
    const channel = await this.options.bridge.openChannel(input.agentName);
    if (
      !isAbsolute(channel.endpoint) || !bounded(channel.nonce) ||
      !channel.requestDirectory || !isAbsolute(channel.requestDirectory) ||
      !channel.responseDirectory || !isAbsolute(channel.responseDirectory)
    ) throw new Error("Worker bridge channel is incomplete");
    const result = await this.command([
      "tab", "create",
      "--workspace", input.workspaceId,
      "--cwd", input.cwd,
      "--label", input.agentName,
      "--env", `${WORKER_BRIDGE_ENDPOINT_ENV}=${channel.endpoint}`,
      "--env", `${WORKER_BRIDGE_NONCE_ENV}=${channel.nonce}`,
      "--env", `${WORKER_BRIDGE_AGENT_ENV}=${input.agentName}`,
      "--env", `${WORKER_DECISION_REQUEST_DIRECTORY_ENV}=${channel.requestDirectory}`,
      "--env", `${WORKER_DECISION_RESPONSE_DIRECTORY_ENV}=${channel.responseDirectory}`,
      "--no-focus",
    ], 15_000);
    const tab = object(result.tab);
    const pane = object(result.root_pane);
    const tabId = text(tab.tab_id);
    const paneId = text(pane.pane_id);
    const workspaceId = text(tab.workspace_id) ?? input.workspaceId;
    if (!tabId || !paneId || workspaceId !== input.workspaceId) throw new Error("Herdr returned a mismatched tab allocation");
    const allocation = { workspaceId, tabId, paneId, agentName: input.agentName };
    this.channels.set(allocationKey(allocation), channel);
    return allocation;
  }

  async start(input: { allocation: WorkerAllocation; cwd: string; model: CapturedModel }): Promise<WorkerIdentity> {
    const channel = this.channels.get(allocationKey(input.allocation));
    if (!channel) throw new Error("Worker bridge channel is unavailable after allocation");
    await this.waitForShell(input.allocation.paneId);

    const started = await this.command([
      "agent", "start", input.allocation.agentName,
      "--kind", "pi",
      "--pane", input.allocation.paneId,
      "--timeout", String(this.agentStartTimeoutMs),
      "--",
      "--name", input.allocation.agentName,
      "--model", `${input.model.provider}/${input.model.id}`,
      "--thinking", input.model.thinkingLevel,
      "-e", this.bridgeExtensionPath,
    ], this.agentStartTimeoutMs + 5_000);
    const startedAgent = parseAgent(started);
    assertAllocation(startedAgent, input.allocation);
    const sessionFile = agentSessionFile(startedAgent);

    await this.command([
      "agent", "prompt", input.allocation.agentName, WORKER_READINESS_COMMAND,
    ], 10_000);
    const receipt = await this.options.bridge.waitForReadiness(channel, this.bridgeReadyTimeoutMs);
    const identity = identityFromReceipt(receipt, channel, input.allocation, input.cwd, input.model, sessionFile);
    const current = parseAgent(await this.command(["agent", "get", input.allocation.agentName], 10_000));
    assertOwnedAgent(current, identity);
    return identity;
  }

  async inspect(identity: WorkerIdentity): Promise<WorkerObservation> {
    const current = parseAgent(await this.command(["agent", "get", identity.agentName], 10_000));
    assertOwnedAgent(current, identity);
    return { identity: structuredClone(identity), status: agentStatus(current), artifactReferences: [] };
  }

  async dispatchImplementation(identity: WorkerIdentity, ticketReference: string): Promise<WorkerObservation> {
    if (!bounded(ticketReference) || /[\r\n\0]/.test(ticketReference)) throw new Error("Ticket reference is unsafe for interactive dispatch");
    await this.assertDispatchable(identity);
    const result = await this.command([
      "agent", "prompt", identity.agentName, `/skill:implement ${ticketReference}`,
      "--wait", "--timeout", String(this.promptTimeoutMs),
    ], this.promptTimeoutMs + 5_000);
    const agent = parseAgent(result);
    assertOwnedAgent(agent, identity);
    return { identity: structuredClone(identity), status: agentStatus(agent), artifactReferences: [] };
  }

  async deliverDecision(identity: WorkerIdentity, decisionId: string, answer: string): Promise<WorkerObservation> {
    if (!this.options.bridge.channelForAgent || !this.options.bridge.deliverDecision) {
      throw new Error("Structured worker decision transport is unavailable");
    }
    const current = parseAgent(await this.command(["agent", "get", identity.agentName], 10_000));
    assertOwnedAgent(current, identity);
    const channel = await this.options.bridge.channelForAgent(identity.agentName);
    await this.options.bridge.deliverDecision(channel, {
      schemaVersion: 1,
      nonce: channel.nonce,
      id: decisionId,
      answeredAt: new Date().toISOString(),
      answer,
    });
    return { identity: structuredClone(identity), status: agentStatus(current), artifactReferences: [] };
  }

  async nextDecision(identity: WorkerIdentity): Promise<WorkerDecisionRequest | undefined> {
    if (!this.options.bridge.channelForAgent || !this.options.bridge.nextDecisionRequest) return undefined;
    const current = parseAgent(await this.command(["agent", "get", identity.agentName], 10_000));
    assertOwnedAgent(current, identity);
    const channel = await this.options.bridge.channelForAgent(identity.agentName);
    return this.options.bridge.nextDecisionRequest(channel);
  }

  async acknowledgeDecision(identity: WorkerIdentity, decisionId: string): Promise<void> {
    if (!this.options.bridge.channelForAgent || !this.options.bridge.acknowledgeDecisionRequest) {
      throw new Error("Structured worker decision transport is unavailable");
    }
    const channel = await this.options.bridge.channelForAgent(identity.agentName);
    await this.options.bridge.acknowledgeDecisionRequest(channel, decisionId);
  }

  async focus(identity: WorkerIdentity): Promise<void> {
    const current = parseAgent(await this.command(["agent", "get", identity.agentName], 10_000));
    assertOwnedAgent(current, identity);
    if (agentStatus(current) === "unknown") throw new Error("Owned Herdr worker state is unknown");
    await this.command(["agent", "focus", identity.agentName], 10_000);
  }

  private async assertDispatchable(identity: WorkerIdentity): Promise<void> {
    const current = parseAgent(await this.command(["agent", "get", identity.agentName], 10_000));
    assertOwnedAgent(current, identity);
    if (!["idle", "done"].includes(agentStatus(current))) {
      throw new Error("Owned Herdr worker is not settled for a new implementation prompt");
    }
  }

  private async waitForShell(paneId: string): Promise<void> {
    await this.command([
      "pane", "wait-output", paneId,
      "--regex", "\\S",
      "--source", "recent-unwrapped",
      "--timeout", String(this.shellReadyTimeoutMs),
    ], this.shellReadyTimeoutMs + 5_000);
    const deadline = this.now() + this.shellReadyTimeoutMs;
    for (;;) {
      const result = await this.command(["pane", "process-info", "--pane", paneId], 10_000);
      const info = object(result.process_info);
      const reportedPane = text(info.pane_id);
      const shellPid = positiveInteger(info.shell_pid);
      const foregroundGroup = positiveInteger(info.foreground_process_group_id);
      const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes.map(object) : [];
      const shellOwnsForeground = reportedPane === paneId && shellPid !== undefined && foregroundGroup === shellPid &&
        processes.length > 0 && processes.every((process): boolean => positiveInteger(process.pid) === shellPid);
      if (shellOwnsForeground) return;
      if (this.now() >= deadline) throw new Error("Herdr pane shell did not become ready");
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async command(args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
    const executed = await this.options.executor.execute(args, { timeoutMs });
    if (executed.code !== 0) throw new Error("Herdr command failed or timed out ambiguously");
    let parsed: unknown;
    try {
      parsed = JSON.parse(executed.stdout);
    } catch {
      throw new Error("Herdr returned malformed JSON");
    }
    const envelope = object(parsed);
    if (envelope.error !== undefined) throw new Error("Herdr returned an operation error");
    return object(envelope.result);
  }
}

function identityFromReceipt(
  receipt: WorkerReadinessReceipt,
  channel: WorkerBridgeChannel,
  allocation: WorkerAllocation,
  cwd: string,
  model: CapturedModel,
  herdrSessionFile: string,
): WorkerIdentity {
  if (!validReceipt(receipt) || receipt.nonce !== channel.nonce || receipt.sessionStartReason !== "startup") {
    throw new Error("Pi worker readiness receipt is malformed, stale, or not a fresh startup");
  }
  if (
    receipt.workspaceId !== allocation.workspaceId || receipt.tabId !== allocation.tabId ||
    receipt.paneId !== allocation.paneId || receipt.agentName !== allocation.agentName ||
    receipt.cwd !== cwd || receipt.sessionFile !== herdrSessionFile || receipt.mode !== "tui" ||
    receipt.initialHistoryEntries !== 0 || !sameModel(receipt.model, model)
  ) throw new Error("Pi worker identity, freshness, cwd, session, or model does not match its allocation");
  const skills = receipt.commands.filter((command): boolean => command.source === "skill");
  if (!REQUIRED_SKILLS.every((name): boolean => skills.some((command): boolean => validSkillSource(command, name)))) {
    throw new Error("Pi worker is missing a required native skill or source provenance");
  }
  if (!REQUIRED_TOOLS.every((name): boolean => receipt.toolNames.includes(name)) || receipt.contextFiles.length === 0) {
    throw new Error("Pi worker is missing normal tools or project instruction resources");
  }
  return {
    ...structuredClone(allocation),
    piPid: receipt.piPid,
    sessionId: receipt.sessionId,
    sessionFile: receipt.sessionFile,
    cwd: receipt.cwd,
    model: structuredClone(receipt.model),
    mode: "tui",
    initialHistoryEntries: 0,
    skillCommands: skills.map((command): string => command.name),
    toolNames: [...new Set(receipt.toolNames)],
    contextFiles: [...new Set(receipt.contextFiles)],
  };
}

function validReceipt(value: unknown): value is WorkerReadinessReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as WorkerReadinessReceipt;
  return receipt.schemaVersion === 1 && bounded(receipt.nonce) && Number.isFinite(Date.parse(receipt.observedAt)) &&
    ["startup", "reload", "new", "resume", "fork"].includes(receipt.sessionStartReason) &&
    [receipt.workspaceId, receipt.tabId, receipt.paneId, receipt.agentName, receipt.sessionId, receipt.sessionFile, receipt.cwd]
      .every(bounded) &&
    positiveInteger(receipt.piPid) !== undefined && isAbsolute(receipt.sessionFile) && isAbsolute(receipt.cwd) &&
    ["tui", "rpc", "json", "print"].includes(receipt.mode) && Number.isSafeInteger(receipt.initialHistoryEntries) &&
    receipt.initialHistoryEntries >= 0 && validModel(receipt.model) && Array.isArray(receipt.commands) &&
    receipt.commands.length <= 200 && receipt.commands.every(validCommandSource) &&
    validStringArray(receipt.toolNames, 200, false) && validStringArray(receipt.contextFiles, 200, true) &&
    receipt.contextFiles.every(isAbsolute);
}

function validCommandSource(value: unknown): value is WorkerCommandSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as WorkerCommandSource;
  const source = command.sourceInfo;
  return bounded(command.name) && ["extension", "prompt", "skill"].includes(command.source) &&
    !!source && bounded(source.path) && isAbsolute(source.path) && bounded(source.source) &&
    ["user", "project", "temporary"].includes(source.scope) && ["package", "top-level"].includes(source.origin) &&
    (source.baseDir === undefined || (bounded(source.baseDir) && isAbsolute(source.baseDir)));
}

function validSkillSource(command: WorkerCommandSource, name: string): boolean {
  return command.name === name && command.source === "skill" && command.sourceInfo.path.endsWith(".md");
}

function validModel(value: unknown): value is CapturedModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as CapturedModel;
  return bounded(model.provider) && bounded(model.id) &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(model.thinkingLevel) &&
    positiveInteger(model.contextWindow) !== undefined;
}

function sameModel(left: CapturedModel, right: CapturedModel): boolean {
  return left.provider === right.provider && left.id === right.id && left.thinkingLevel === right.thinkingLevel &&
    left.contextWindow === right.contextWindow;
}

interface HerdrAgent {
  agent: string;
  agent_status: string;
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  agent_session: { kind: string; value: string; agent?: string; source?: string };
}

function parseAgent(result: Record<string, unknown>): HerdrAgent {
  const raw = object(result.agent);
  const session = object(raw.agent_session);
  const agent: HerdrAgent = {
    agent: text(raw.agent) ?? "",
    agent_status: text(raw.agent_status) ?? "",
    pane_id: text(raw.pane_id) ?? "",
    tab_id: text(raw.tab_id) ?? "",
    workspace_id: text(raw.workspace_id) ?? "",
    agent_session: {
      kind: text(session.kind) ?? "",
      value: text(session.value) ?? "",
      ...(text(session.agent) ? { agent: text(session.agent)! } : {}),
      ...(text(session.source) ? { source: text(session.source)! } : {}),
    },
  };
  if (!agent.agent || !agent.agent_status || !agent.pane_id || !agent.tab_id || !agent.workspace_id) {
    throw new Error("Herdr returned incomplete agent identity");
  }
  return agent;
}

function assertAllocation(agent: HerdrAgent, allocation: WorkerAllocation): void {
  if (
    agent.agent !== "pi" || agent.pane_id !== allocation.paneId || agent.tab_id !== allocation.tabId ||
    agent.workspace_id !== allocation.workspaceId || !["idle", "done"].includes(agent.agent_status)
  ) throw new Error("Started Herdr agent does not match its durable allocation or readiness state");
}

function assertOwnedAgent(agent: HerdrAgent, identity: WorkerIdentity): void {
  if (
    agent.agent !== "pi" || agent.pane_id !== identity.paneId || agent.tab_id !== identity.tabId ||
    agent.workspace_id !== identity.workspaceId || agentSessionFile(agent) !== identity.sessionFile
  ) throw new Error("Herdr pane occupant or saved Pi session changed");
}

function agentSessionFile(agent: HerdrAgent): string {
  if (agent.agent_session.kind !== "path" || !isAbsolute(agent.agent_session.value)) {
    throw new Error("Herdr did not report a saved Pi session path");
  }
  return agent.agent_session.value;
}

function agentStatus(agent: HerdrAgent): WorkerStatus {
  if (["idle", "working", "blocked", "done", "unknown"].includes(agent.agent_status)) {
    return agent.agent_status as WorkerStatus;
  }
  return "unknown";
}

function allocationKey(allocation: WorkerAllocation): string {
  return `${allocation.workspaceId}\0${allocation.tabId}\0${allocation.paneId}\0${allocation.agentName}`;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("External response is malformed");
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
   return typeof value === "string" && value.length > 0 && value.length <= 4_096 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4_096;
}

function validStringArray(value: unknown, max: number, absolute: boolean): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item): boolean => bounded(item) && (!absolute || isAbsolute(item)));
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Runtime timeout must be a positive integer");
  return value;
}
