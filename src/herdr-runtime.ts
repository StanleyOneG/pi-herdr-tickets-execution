import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { atomicWritePrivateFile } from "./atomic-file.js";
import { readBoundedRegularFile } from "./bounded-regular-file.js";
import { ORCHESTRATOR_TOOL_NAMES, type DurableHandoff, type HandoffBinding, type OrchestratorCommand } from "./coordination-contracts.js";
import { isOrchestratorCommand, isContextSample } from "./coordination-validation.js";
import { retainHandoff } from "./handoff-artifact.js";
import { readProducedNativeEvidence } from "./native-evidence.js";

import type {
  AcceptanceReviewPort,
  AcceptanceReviewRecord,
  CapturedModel,
  NativeVerificationPort,
  NativeVerificationRecord,
  WorkerAllocation,
  WorkerDispatchAcknowledgement,
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
  WORKER_NATIVE_VERIFICATION_ENDPOINT_ENV,
  WORKER_READINESS_COMMAND,
  WORKER_REVIEW_ENDPOINT_ENV,
  WORKER_REVIEW_NONCE_ENV,
  type WorkerBridgeChannel,
  type WorkerDecisionRequest,
  type WorkerBridgeTransport,
  type WorkerCommandSource,
  type WorkerReadinessReceipt,
} from "./worker-bridge-protocol.js";

const execFileAsync = promisify(execFile);
const REQUIRED_SKILLS = ["skill:implement", "skill:tdd", "skill:code-review", "skill:handoff"];
const REQUIRED_TOOLS = ["read", "bash", "edit", "write", "subagent"];
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
export class HerdrWorkerRuntime implements WorkerRuntimePort, AcceptanceReviewPort, NativeVerificationPort {
  private readonly channels = new Map<string, WorkerBridgeChannel>();
  private readonly dispatchStartedAt = new Map<string, number>();
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
    this.promptTimeoutMs = positiveTimeout(options.promptTimeoutMs ?? 30_000);
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
      ...(channel.reviewEndpoint ? ["--env", `${WORKER_REVIEW_ENDPOINT_ENV}=${channel.reviewEndpoint}`] : []),
      ...(channel.nativeVerificationEndpoint ? [
        "--env", `${WORKER_NATIVE_VERIFICATION_ENDPOINT_ENV}=${channel.nativeVerificationEndpoint}`,
      ] : []),
      "--env", `${WORKER_REVIEW_NONCE_ENV}=${channel.nonce}`,
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

  async start(input: {
    allocation: WorkerAllocation;
    cwd: string;
    model: CapturedModel;
    contextLimit?: number;
    orchestration?: { preparationId: string; generation: number };
    unmanaged?: true;
  }): Promise<WorkerIdentity> {
    const channel = this.channels.get(allocationKey(input.allocation));
    if (!channel) throw new Error("Worker bridge channel is unavailable after allocation");
    const contextLimit = input.contextLimit;
    if (input.unmanaged === true) {
      if (contextLimit !== undefined || input.orchestration) throw new Error("Unmanaged Pi sessions cannot receive managed coordination settings");
      await atomicWritePrivateFile(join(dirname(channel.endpoint), "coordination.json"), JSON.stringify({ role: "unmanaged" }));
    } else if (input.orchestration) {
      if (!Number.isSafeInteger(contextLimit) || contextLimit === undefined || contextLimit <= 0) throw new Error("Orchestrator context limit is invalid");
      await atomicWritePrivateFile(join(dirname(channel.endpoint), "coordination.json"), JSON.stringify({
        role: "orchestrator",
        contextLimit,
        lease: { ...input.orchestration, sessionId: "pending-readiness" },
      }));
    } else {
      if (!Number.isSafeInteger(contextLimit) || contextLimit === undefined || contextLimit <= 0) throw new Error("Implementation context limit is invalid");
      await atomicWritePrivateFile(join(dirname(channel.endpoint), "coordination.json"), JSON.stringify({ role: "implementation", contextLimit }));
    }
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
    const identity = identityFromReceipt(receipt, channel, input.allocation, input.cwd, input.model, sessionFile, input.orchestration ? "orchestrator" : "implementation");
    if (input.orchestration) {
      await atomicWritePrivateFile(join(dirname(channel.endpoint), "coordination.json"), JSON.stringify({
        role: "orchestrator",
        contextLimit,
        lease: { ...input.orchestration, sessionId: identity.sessionId },
      }));
    }
    const current = parseAgent(await this.command(["agent", "get", input.allocation.agentName], 10_000));
    assertOwnedAgent(current, identity);
    await this.assertLiveBridge(identity, channel);
    return identity;
  }

  async inspect(identity: WorkerIdentity): Promise<WorkerObservation> {
    const current = parseAgent(await this.command(["agent", "get", identity.agentName], 10_000));
    assertOwnedAgent(current, identity);
    let lifecycle: Awaited<ReturnType<NonNullable<WorkerBridgeTransport["readLifecycle"]>>>;
    if (this.options.bridge.channelForAgent && this.options.bridge.readLifecycle) {
      const channel = await this.options.bridge.channelForAgent(identity.agentName);
      await this.assertLiveBridge(identity, channel);
      lifecycle = await this.options.bridge.readLifecycle(channel);
      if (lifecycle && (lifecycle.piPid !== identity.piPid || lifecycle.sessionId !== identity.sessionId)) throw new Error("Worker lifecycle receipt belongs to another Pi process or session");
      if (lifecycle?.model && !sameModel(lifecycle.model, identity.model)) throw new Error("Managed session changed its approved model or thinking level");
      if (lifecycle?.context && !isContextSample(lifecycle.context)) throw new Error("Managed session returned invalid context occupancy");
    }
    const status = agentStatus(current);
    const dispatchStartedAt = this.dispatchStartedAt.get(allocationKey(identity));
    const hasFreshLifecycle = lifecycle !== undefined &&
      (dispatchStartedAt === undefined || Date.parse(lifecycle.observedAt) >= dispatchStartedAt);
    const settled = hasFreshLifecycle && lifecycle?.sessionId === identity.sessionId && lifecycle.state === "settled" &&
      (status === "idle" || status === "done");
    return {
      identity: structuredClone(identity),
      status,
      artifactReferences: [],
      settled,
      outstandingJobs: settled ? lifecycle!.outstandingJobs : ["Pi has not reported agent_settled"],
      ...(hasFreshLifecycle && lifecycle?.context && isContextSample(lifecycle.context) ? { context: lifecycle.context } : {}),
      safeToCheckpoint: settled && lifecycle?.safeToCheckpoint === true,
    };
  }

  async dispatchImplementation(
    identity: WorkerIdentity,
    ticketReference: string,
    prerequisiteEvidence: string[],
    handoffReference?: string,
  ): Promise<WorkerDispatchAcknowledgement> {
    if (!bounded(ticketReference) || /[\r\n\0]/.test(ticketReference) || !validStringArray(prerequisiteEvidence, 50, false) ||
      prerequisiteEvidence.some((item): boolean => /[\r\0]/.test(item))
    ) throw new Error("Ticket reference or prerequisite evidence is unsafe for interactive dispatch");
    if (handoffReference !== undefined && (!bounded(handoffReference) || !isAbsolute(handoffReference) || /[\r\n\0]/.test(handoffReference))) throw new Error("Invalid durable handoff reference");
    const channel = await this.coordinationChannel(identity);
    await this.assertDispatchable(identity);
    await this.beginDispatch(identity, channel);
    const implementationPrompt = prerequisiteEvidence.length === 0
      ? `/skill:implement ${ticketReference}`
      : `/skill:implement ${ticketReference}\n\nThe controller verified these in-batch prerequisites as accepted and present on the batch branch even though tracker issues may remain open:\n${prerequisiteEvidence.map((item): string => `- ${item}`).join("\n")}`;
    const prompt = handoffReference
      ? `${implementationPrompt}\n\nContinue this ticket in this same worktree from the bounded handoff at ${handoffReference}. Re-read relevant code and evidence; preserve outstanding checks, findings and decisions. Do not import the prior transcript.`
      : implementationPrompt;
    const result = await this.command([
      "agent", "prompt", identity.agentName, prompt,
    ], this.promptTimeoutMs);
    const agent = parseAgent(result);
    assertOwnedAgent(agent, identity);
    return { identity: structuredClone(identity), status: agentStatus(agent), artifactReferences: [] };
  }

  async dispatchSupervision(identity: WorkerIdentity, packet: string): Promise<void> {
    if (Buffer.byteLength(packet) > 32_000) throw new Error("Supervisory packet exceeds context bound");
    const data = JSON.parse(packet.slice(packet.lastIndexOf("\n\n") + 2)) as { preparationId: string; generation: number; contextLimit: { handoffTokens: number } };
    const channel = await this.coordinationChannel(identity);
    await atomicWritePrivateFile(join(dirname(channel.endpoint), "coordination.json"), JSON.stringify({
      role: "orchestrator", contextLimit: data.contextLimit.handoffTokens,
      lease: { preparationId: data.preparationId, generation: data.generation, sessionId: identity.sessionId },
    }));
    await this.assertDispatchable(identity);
    await this.removeCoordinationRecord(channel, "orchestrator-operation.json");
    await this.beginDispatch(identity, channel);
    const result = parseAgent(await this.command(["agent", "prompt", identity.agentName, packet], this.promptTimeoutMs));
    assertOwnedAgent(result, identity);
  }

  async nextOrchestratorCommand(identity: WorkerIdentity): Promise<OrchestratorCommand | undefined> {
    const channel = await this.coordinationChannel(identity);
    const path = join(dirname(channel.endpoint), "orchestrator-operation.json");
    try {
      const raw = JSON.parse((await readBoundedRegularFile(path, 32_000, "Orchestrator operation")).toString("utf8")) as Record<string, unknown>;
      if (raw.nonce !== channel.nonce || !isOrchestratorCommand(raw.command) || raw.command.sessionId !== identity.sessionId) throw new Error("Stale orchestration operation");
      // Ownership generation in the controller fences any in-flight command across rotations.
      await unlink(path);
      return raw.command;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async requestHandoff(identity: WorkerIdentity, binding: HandoffBinding): Promise<void> {
    const channel = await this.coordinationChannel(identity);
    await atomicWritePrivateFile(join(dirname(channel.endpoint), "coordination.json"), JSON.stringify({ role: "handoff", binding }));
    await this.assertDispatchable(identity);
    await this.removeCoordinationRecord(channel, "handoff-receipt.json");
    await this.beginDispatch(identity, channel);
    const prompt = [
      "/skill:handoff Continue this ticket's implementation in a fresh Pi session in the same worktree.",
      "Write a bounded redacted Markdown checkpoint, not a conversation transcript. Do not change code or commit.",
      `Include these exact controller bindings: ${JSON.stringify(binding)}`,
      "Include changes, completed and outstanding checks, review findings, unresolved decisions and the next implementation action.",
      "Use the installed skill's actual output path, then call herdr_submit_handoff with that path. Do not invent a filename or claim receipt without a file.",
    ].join("\n\n");
    const result = parseAgent(await this.command(["agent", "prompt", identity.agentName, prompt], this.promptTimeoutMs));
    assertOwnedAgent(result, identity);
  }

  async captureHandoff(identity: WorkerIdentity, binding: HandoffBinding): Promise<DurableHandoff> {
    const channel = await this.coordinationChannel(identity);
    return retainHandoff(dirname(channel.endpoint), channel.nonce, identity.sessionId, binding);
  }

  async readNativeEvidence(identity: WorkerIdentity, codeStateDigest: string): Promise<import("./contracts.js").NativeEvidenceRecord[]> {
    const channel = await this.coordinationChannel(identity);
    return readProducedNativeEvidence(join(dirname(channel.endpoint), "native-evidence", "latest.json"), { sessionId: identity.sessionId, codeStateDigest });
  }

  async retire(identity: WorkerIdentity): Promise<void> {
    const observation = await this.inspect(identity);
    if (!observation.safeToCheckpoint || !["idle", "done"].includes(observation.status)) throw new Error("Worker is not at a safe retirement boundary");
    await this.command(["tab", "close", identity.tabId], 10_000);
    const deadline = this.now() + 10_000;
    for (;;) {
      try { process.kill(identity.piPid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
      if (this.now() >= deadline) throw new Error("Worker retirement is not confirmed");
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async beginDispatch(identity: WorkerIdentity, channel: WorkerBridgeChannel): Promise<void> {
    if (!this.options.bridge.invalidateLifecycle) throw new Error("Worker lifecycle invalidation transport is unavailable");
    await this.options.bridge.invalidateLifecycle(channel);
    this.dispatchStartedAt.set(allocationKey(identity), this.now());
  }

  private async removeCoordinationRecord(channel: WorkerBridgeChannel, name: string): Promise<void> {
    try {
      await unlink(join(dirname(channel.endpoint), name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async coordinationChannel(identity: WorkerIdentity): Promise<WorkerBridgeChannel> {
    const current = parseAgent(await this.command(["agent", "get", identity.agentName], 10_000));
    assertOwnedAgent(current, identity);
    const channel = this.channels.get(allocationKey(identity)) ?? await this.options.bridge.channelForAgent?.(identity.agentName);
    if (!channel) throw new Error("Owned coordination channel is unavailable");
    await this.assertLiveBridge(identity, channel);
    return channel;
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

  async close(identity: WorkerIdentity): Promise<void> {
    const observation = await this.inspect(identity);
    if (!observation.settled || !["idle", "done"].includes(observation.status) ||
      !Array.isArray(observation.outstandingJobs) || observation.outstandingJobs.length > 0
    ) throw new Error("Owned worker is not settled with no outstanding Pi work for cleanup");
    await this.command(["tab", "close", identity.tabId], 10_000);
  }

  async verify(input: Parameters<NativeVerificationPort["verify"]>[0]): Promise<NativeVerificationRecord> {
    if (!this.options.bridge.waitForNativeVerification) {
      throw new Error("Structured native verification transport is unavailable");
    }
    const verificationIdentity = createHash("sha256")
      .update(`${input.candidateCommit}\0${input.codeStateDigest}`)
      .digest("hex").slice(0, 20);
    const prompt = [
      "/skill:implement Verification-only acceptance gate for an already staged candidate.",
      `Candidate commit: ${input.candidateCommit}`,
      `Controller-observed Git code-state digest: ${input.codeStateDigest}`,
      "Read and follow the installed implementation skill and project instructions for their existing testing and code-review obligations.",
      "Re-run every required native test against this exact staged code state. Use bash only for those test commands; use read/grep/find/ls for inspection.",
      "Do not edit or write files, commit, repair findings, invent fallback commands, waive missing tests, or perform delivery/tracker operations.",
      `Retained source evidence references: ${input.evidenceReferences.join(", ")}`,
      "If required tests cannot be identified or executed, submit blocked with findings.",
      "Finish by calling herdr_submit_native_verification exactly once with the supplied candidate commit and code-state digest, pass only after all required tests and native review obligations succeed, and include every blocking finding.",
    ].join("\n\n");
    return this.runIsolatedAcceptance({
      workspaceId: input.workspaceId,
      agentName: `verify-${verificationIdentity}`,
      cwd: input.cwd,
      model: input.model,
      prompt,
      missingChannelMessage: "Native verification bridge channel is unavailable",
      unsettledMessage: "Native verification Pi session has not settled or still has outstanding work",
      waitForReceipt: (channel) => this.options.bridge.waitForNativeVerification!(channel, 10_000),
      validateReceipt: (receipt, identity, channel): NativeVerificationRecord => {
        if (receipt.nonce !== channel.nonce || receipt.sessionId !== identity.sessionId ||
          receipt.candidateCommit !== input.candidateCommit || receipt.codeStateDigest !== input.codeStateDigest
        ) throw new Error("Native verification receipt is stale or mismatched");
        return {
          status: receipt.status,
          candidateCommit: receipt.candidateCommit,
          codeStateDigest: receipt.codeStateDigest,
          freshSessionId: receipt.sessionId,
          observedCommandDigests: [...receipt.observedCommandDigests],
          findings: [...receipt.findings],
          evidenceReference: channel.nativeVerificationEndpoint!,
          completedAt: receipt.completedAt,
        };
      },
      passed: (record) => record.status === "passed" && record.findings.length === 0,
    });
  }

  async review(input: Parameters<AcceptanceReviewPort["review"]>[0]): Promise<AcceptanceReviewRecord> {
    if (!this.options.bridge.waitForReview) throw new Error("Structured review transport is unavailable");
    const digest = createHash("sha256")
      .update(`${input.kind}\0${input.candidateCommit}\0${input.reviewBase}`)
      .digest("hex").slice(0, 20);
    const prompt = [
      `Perform a fresh-context ${input.kind} acceptance review of the staged candidate.`,
      `Review base: ${input.reviewBase}`,
      `Candidate commit: ${input.candidateCommit}`,
      `Inspect the actual diff with git diff ${input.reviewBase}..${input.candidateCommit}.`,
      input.kind === "standards"
        ? "Read and apply the project's coding standards and normal review guidance."
        : "Read the approved spec/ticket evidence and verify every applicable requirement without widening scope.",
      `Approved evidence references: ${input.evidenceReferences.join(", ")}`,
      "Do not edit files, repair findings, reuse another review, or claim a pass with unresolved blockers.",
      "Finish by calling herdr_submit_acceptance_review exactly once with this kind, review base, candidate commit, verdict, and all blocking findings.",
    ].join("\n\n");
    return this.runIsolatedAcceptance({
      workspaceId: input.workspaceId,
      agentName: `review-${digest}`,
      cwd: input.cwd,
      model: input.model,
      prompt,
      missingChannelMessage: "Review bridge channel is unavailable",
      unsettledMessage: "Fresh review Pi session has not settled or still has outstanding work",
      waitForReceipt: (channel) => this.options.bridge.waitForReview!(channel, 10_000),
      validateReceipt: (receipt, identity, channel): AcceptanceReviewRecord => {
        if (receipt.nonce !== channel.nonce || receipt.sessionId !== identity.sessionId || receipt.kind !== input.kind ||
          receipt.candidateCommit !== input.candidateCommit || receipt.reviewBase !== input.reviewBase
        ) throw new Error("Fresh review receipt is stale or mismatched");
        return {
          kind: receipt.kind,
          verdict: receipt.verdict,
          candidateCommit: receipt.candidateCommit,
          reviewBase: receipt.reviewBase,
          freshSessionId: receipt.sessionId,
          findings: receipt.findings,
          evidenceReference: channel.reviewEndpoint!,
          completedAt: receipt.completedAt,
        };
      },
      passed: (record) => record.verdict === "passed" && record.findings.length === 0,
    });
  }

  private async runIsolatedAcceptance<TReceipt, TRecord>(input: {
    workspaceId: string;
    agentName: string;
    cwd: string;
    model: CapturedModel;
    prompt: string;
    missingChannelMessage: string;
    unsettledMessage: string;
    waitForReceipt: (channel: WorkerBridgeChannel) => Promise<TReceipt>;
    validateReceipt: (receipt: TReceipt, identity: WorkerIdentity, channel: WorkerBridgeChannel) => TRecord;
    passed: (record: TRecord) => boolean;
  }): Promise<TRecord> {
    const allocation = await this.allocate({
      workspaceId: input.workspaceId,
      agentName: input.agentName,
      cwd: input.cwd,
    });
    let identity: WorkerIdentity | undefined;
    let shouldClose = false;
    try {
      identity = await this.start({ allocation, cwd: input.cwd, model: input.model, unmanaged: true });
      const channel = this.channels.get(allocationKey(allocation));
      if (!channel) throw new Error(input.missingChannelMessage);
      await this.command([
        "agent", "prompt", identity.agentName, input.prompt,
        "--wait", "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", "300000",
      ], 305_000);
      const record = input.validateReceipt(await input.waitForReceipt(channel), identity, channel);
      const settled = await this.inspect(identity);
      if (!settled.settled || !["idle", "done"].includes(settled.status) ||
        !Array.isArray(settled.outstandingJobs) || settled.outstandingJobs.length > 0
      ) throw new Error(input.unsettledMessage);
      shouldClose = input.passed(record);
      return record;
    } finally {
      if (identity && shouldClose) {
        try { await this.close(identity); } catch { /* Preserve the saved acceptance session when cleanup fails. */ }
      }
    }
  }

  async focus(identity: WorkerIdentity): Promise<void> {
    const current = parseAgent(await this.command(["agent", "get", identity.agentName], 10_000));
    assertOwnedAgent(current, identity);
    if (agentStatus(current) === "unknown") throw new Error("Owned Herdr worker state is unknown");
    await this.command(["agent", "focus", identity.agentName], 10_000);
  }

  private async assertLiveBridge(identity: WorkerIdentity, channel: WorkerBridgeChannel): Promise<void> {
    if (!this.options.bridge.challengeLifecycle) {
      throw new Error("Worker lifecycle challenge transport is unavailable");
    }
    await this.options.bridge.challengeLifecycle(channel, identity.piPid, this.bridgeReadyTimeoutMs);
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
  role: "implementation" | "orchestrator",
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
  const requiredTools = role === "orchestrator" ? ORCHESTRATOR_TOOL_NAMES : REQUIRED_TOOLS;
  if (!requiredTools.every((name): boolean => receipt.toolNames.includes(name)) || receipt.contextFiles.length === 0) {
    throw new Error("Pi managed session is missing required capability tools or project instruction resources");
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
