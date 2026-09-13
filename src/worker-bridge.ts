import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { atomicWritePrivateFile } from "./atomic-file.js";
import type { CapturedModel, ThinkingLevel } from "./contracts.js";
import {
  WORKER_BRIDGE_AGENT_ENV,
  WORKER_BRIDGE_ENDPOINT_ENV,
  WORKER_BRIDGE_NONCE_ENV,
  WORKER_DECISION_REQUEST_DIRECTORY_ENV,
  WORKER_DECISION_RESPONSE_DIRECTORY_ENV,
  WORKER_NATIVE_VERIFICATION_ENDPOINT_ENV,
  WORKER_REVIEW_ENDPOINT_ENV,
  WORKER_REVIEW_NONCE_ENV,
  type WorkerDecisionAnswer,
  type WorkerDecisionRequest,
  type WorkerReadinessReceipt,
} from "./worker-bridge-protocol.js";

const HISTORY_ENTRY_TYPES = new Set(["message", "custom_message", "compaction", "branch_summary"]);
const REVIEW_SCHEMA = Type.Object({
  kind: StringEnum(["standards", "spec"] as const),
  verdict: StringEnum(["passed", "blocked"] as const),
  candidateCommit: Type.String({ minLength: 1, maxLength: 4_096 }),
  reviewBase: Type.String({ minLength: 1, maxLength: 4_096 }),
  findings: Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 50 }),
});
type ReviewInput = Static<typeof REVIEW_SCHEMA>;
const NATIVE_VERIFICATION_SCHEMA = Type.Object({
  status: StringEnum(["passed", "blocked"] as const),
  candidateCommit: Type.String({ minLength: 1, maxLength: 4_096 }),
  codeStateDigest: Type.String({ pattern: "^[a-fA-F0-9]{64}$" }),
  findings: Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 50 }),
});
type NativeVerificationInput = Static<typeof NATIVE_VERIFICATION_SCHEMA>;
const DECISION_SCHEMA = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 4_000 }),
  context: Type.String({ minLength: 1, maxLength: 4_000 }),
  options: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 20 }),
  recommendation: Type.String({ minLength: 1, maxLength: 4_000 }),
});
type DecisionInput = Static<typeof DECISION_SCHEMA>;
let sessionStartReason: WorkerReadinessReceipt["sessionStartReason"] | undefined;

export default function herdrWorkerBridge(pi: ExtensionAPI): void {
  sessionStartReason = undefined;
  const activeTools = new Set<string>();
  const bashCommands = new Map<string, string>();
  const observedCommandDigests: string[] = [];
  let failedBashCommand = false;
  let mutationToolUsed = false;
  let isAgentRunning = false;
  const outstandingJobs = (): string[] => [
    ...(isAgentRunning ? ["pi-agent-run"] : []),
    ...[...activeTools].sort().map((id): string => `pi-tool:${id}`),
  ];
  pi.on("session_start", (event, _ctx): void => {
    sessionStartReason = event.reason;
    activeTools.clear();
    bashCommands.clear();
    observedCommandDigests.length = 0;
    failedBashCommand = false;
    mutationToolUsed = false;
    isAgentRunning = false;
  });
  pi.on("agent_start", async (_event, ctx): Promise<void> => {
    isAgentRunning = true;
    await writeLifecycle(ctx, "working", outstandingJobs());
  });
  pi.on("tool_execution_start", async (event, ctx): Promise<void> => {
    activeTools.add(event.toolCallId);
    if (event.toolName === "bash" && typeof event.args?.command === "string" && event.args.command.length <= 4_096) {
      bashCommands.set(event.toolCallId, event.args.command);
    }
    if (event.toolName === "edit" || event.toolName === "write") mutationToolUsed = true;
    await writeLifecycle(ctx, "working", outstandingJobs());
  });
  pi.on("tool_execution_end", async (event, ctx): Promise<void> => {
    activeTools.delete(event.toolCallId);
    const command = bashCommands.get(event.toolCallId);
    if (command !== undefined) {
      observedCommandDigests.push(createHash("sha256").update(command).digest("hex"));
      failedBashCommand ||= event.isError;
      bashCommands.delete(event.toolCallId);
    }
    await writeLifecycle(ctx, "working", outstandingJobs());
  });
  pi.on("agent_settled", async (_event, ctx): Promise<void> => {
    isAgentRunning = false;
    const jobs = outstandingJobs();
    if (ctx.hasPendingMessages()) jobs.push("pi-queued-message");
    await writeLifecycle(ctx, "settled", jobs);
  });

  pi.registerCommand("herdr-worker-ready", {
    description: "Report attempt-bound Pi identity and normal resource readiness to the local Herdr controller",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const receipt = collectWorkerReadiness(pi, ctx);
      await writeReceipt(receipt);
    },
  });

  pi.registerTool({
    name: "herdr_submit_acceptance_review",
    label: "Submit Acceptance Review",
    description: "Submit the final structured result for an attempt-bound fresh Standards or Spec review. Use blocked whenever any blocking finding remains.",
    parameters: REVIEW_SCHEMA,
    async execute(
      _toolCallId: string,
      params: ReviewInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const endpoint = process.env[WORKER_REVIEW_ENDPOINT_ENV];
      const nonce = process.env[WORKER_REVIEW_NONCE_ENV];
      if (!endpoint || !isAbsolute(endpoint) || !nonce) throw new Error("Attempt-bound review channel is incomplete");
      await atomicWritePrivateFile(endpoint, `${JSON.stringify({
        schemaVersion: 1,
        nonce,
        sessionId: ctx.sessionManager.getSessionId(),
        completedAt: new Date().toISOString(),
        ...params,
      })}\n`);
      return { content: [{ type: "text", text: `Recorded ${params.kind} review as ${params.verdict}.` }], details: { kind: params.kind, verdict: params.verdict }, terminate: true };
    },
  });

  pi.registerTool({
    name: "herdr_submit_native_verification",
    label: "Submit Native Verification",
    description: "Submit the final staged native verification result. A pass is accepted only when this Pi session observed successful test commands and no edit/write tools.",
    parameters: NATIVE_VERIFICATION_SCHEMA,
    async execute(
      _toolCallId: string,
      params: NativeVerificationInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const endpoint = process.env[WORKER_NATIVE_VERIFICATION_ENDPOINT_ENV];
      const nonce = process.env[WORKER_REVIEW_NONCE_ENV];
      if (!endpoint || !isAbsolute(endpoint) || !nonce) throw new Error("Native verification channel is incomplete");
      if (observedCommandDigests.length === 0 || (params.status === "blocked" && params.findings.length === 0) ||
        (params.status === "passed" && (params.findings.length > 0 || failedBashCommand || mutationToolUsed))
      ) throw new Error("Native verification result does not match observed test execution");
      await atomicWritePrivateFile(endpoint, `${JSON.stringify({
        schemaVersion: 1,
        nonce,
        sessionId: ctx.sessionManager.getSessionId(),
        observedCommandDigests: [...new Set(observedCommandDigests)],
        completedAt: new Date().toISOString(),
        ...params,
      })}\n`);
      return {
        content: [{ type: "text", text: `Recorded staged native verification as ${params.status}.` }],
        details: { status: params.status, observedCommands: observedCommandDigests.length },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "herdr_request_local_decision",
    label: "Request Local Decision",
    description: "Pause for one explicit local human decision when implementation cannot safely continue. Supply the exact question, bounded context, meaningful options and consequences, and a recommendation. Do not use this for routine status or a clarification you can resolve from approved sources.",
    parameters: DECISION_SCHEMA,
    async execute(
      _toolCallId: string,
      params: DecisionInput,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const answer = await requestLocalDecision(params, signal);
      return {
        content: [{ type: "text", text: `The local human explicitly answered: ${answer.answer}` }],
        details: { decisionId: answer.id, answeredAt: answer.answeredAt },
      };
    },
  });
}

export function collectWorkerReadiness(pi: ExtensionAPI, ctx: ExtensionCommandContext): WorkerReadinessReceipt {
  const endpoint = process.env[WORKER_BRIDGE_ENDPOINT_ENV];
  const nonce = process.env[WORKER_BRIDGE_NONCE_ENV];
  const agentName = process.env[WORKER_BRIDGE_AGENT_ENV];
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const paneId = process.env.HERDR_PANE_ID;
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (
    !endpoint || !isAbsolute(endpoint) || !nonce || !agentName || !workspaceId || !tabId || !paneId ||
    !sessionFile || !isAbsolute(sessionFile) || !ctx.model || !sessionStartReason
  ) {
    throw new Error("Attempt-bound worker bridge identity is incomplete");
  }
  const options = ctx.getSystemPromptOptions();
  const model: CapturedModel = {
    provider: ctx.model.provider,
    id: ctx.model.id,
    thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
    contextWindow: ctx.model.contextWindow,
  };
  return {
    schemaVersion: 1,
    nonce,
    observedAt: new Date().toISOString(),
    sessionStartReason,
    workspaceId,
    tabId,
    paneId,
    agentName,
    piPid: process.pid,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile,
    cwd: ctx.cwd,
    mode: ctx.mode,
    initialHistoryEntries: ctx.sessionManager.getBranch()
      .filter((entry): boolean => HISTORY_ENTRY_TYPES.has(entry.type)).length,
    model,
    commands: pi.getCommands().map((command) => ({
      name: command.name,
      source: command.source,
      sourceInfo: { ...command.sourceInfo },
    })),
    toolNames: pi.getActiveTools(),
    contextFiles: (options.contextFiles ?? []).map((file): string => file.path),
  };
}

export async function requestLocalDecision(input: DecisionInput, signal?: AbortSignal): Promise<WorkerDecisionAnswer> {
  const requestDirectory = process.env[WORKER_DECISION_REQUEST_DIRECTORY_ENV];
  const responseDirectory = process.env[WORKER_DECISION_RESPONSE_DIRECTORY_ENV];
  const nonce = process.env[WORKER_BRIDGE_NONCE_ENV];
  if (!requestDirectory || !responseDirectory || !isAbsolute(requestDirectory) || !isAbsolute(responseDirectory) || !nonce) {
    throw new Error("Attempt-bound local decision channel is incomplete");
  }
  const id = randomUUID();
  const request: WorkerDecisionRequest = {
    schemaVersion: 1,
    nonce,
    id,
    requestedAt: new Date().toISOString(),
    ...input,
  };
  await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
  await mkdir(responseDirectory, { recursive: true, mode: 0o700 });
  await atomicWritePrivateFile(join(requestDirectory, `${id}.json`), `${JSON.stringify(request)}\n`);
  const responsePath = join(responseDirectory, `${id}.json`);
  for (;;) {
    if (signal?.aborted) throw new Error("Local decision wait was interrupted; the durable question remains pending");
    try {
      const data = await readFile(responsePath);
      if (data.byteLength > 256 * 1024) throw new Error("Local decision answer exceeds its bound");
      const answer = JSON.parse(data.toString("utf8")) as WorkerDecisionAnswer;
      if (answer.schemaVersion !== 1 || answer.nonce !== nonce || answer.id !== id ||
        !Number.isFinite(Date.parse(answer.answeredAt)) || typeof answer.answer !== "string" ||
        !answer.answer.trim() || answer.answer.length > 4_000) throw new Error("Local decision answer is malformed or stale");
      await unlink(responsePath);
      return answer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve): void => { setTimeout(resolve, 100); });
  }
}

async function writeLifecycle(
  ctx: ExtensionContext,
  state: "working" | "settled",
  outstandingJobs: string[],
): Promise<void> {
  const endpoint = process.env[WORKER_BRIDGE_ENDPOINT_ENV];
  const nonce = process.env[WORKER_BRIDGE_NONCE_ENV];
  if (!endpoint || !nonce || !isAbsolute(endpoint)) return;
  const lifecycleEndpoint = join(dirname(endpoint), "lifecycle.json");
  await atomicWritePrivateFile(lifecycleEndpoint, `${JSON.stringify({
    schemaVersion: 1,
    nonce,
    sessionId: ctx.sessionManager.getSessionId(),
    state,
    observedAt: new Date().toISOString(),
    outstandingJobs,
  })}\n`);
}

async function writeReceipt(receipt: WorkerReadinessReceipt): Promise<void> {
  const endpoint = process.env[WORKER_BRIDGE_ENDPOINT_ENV]!;
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  await atomicWritePrivateFile(endpoint, `${JSON.stringify(receipt)}\n`);
}
