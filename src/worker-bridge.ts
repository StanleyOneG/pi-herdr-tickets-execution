import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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
import type { CapturedModel, NativeEvidenceRecord, ThinkingLevel } from "./contracts.js";
import { RealGitWorktreeAdapter } from "./git-worktrees.js";
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
const NATIVE_EVIDENCE_CAPTURE_SCHEMA = Type.Object({});
const DECISION_SCHEMA = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 4_000 }),
  context: Type.String({ minLength: 1, maxLength: 4_000 }),
  options: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 20 }),
  recommendation: Type.String({ minLength: 1, maxLength: 4_000 }),
});
type DecisionInput = Static<typeof DECISION_SCHEMA>;
interface NativeExecutionProof {
  kind: "tests" | "reviews";
  codeStateDigest: string;
  completedAt: string;
  executionReference: string;
  sourceArtifact?: { reference: string; digest: string };
}
interface PendingSubagentLaunch {
  toolCallId: string;
  cwd: string;
  sourceSessionId: string;
  sourceSessionFile?: string;
  sourceSessionIdentities: Set<string>;
  codeStateDigest: string;
  args: unknown;
  launchedAt: number;
  sequence: number;
}
interface AsyncReviewLaunch extends PendingSubagentLaunch {
  runId: string;
  mode: "workflow";
  asyncDir: string;
}
type TerminalNativeEvidenceFailureKind = "review-rejected" | "capture-failed" | "revocation-failed";
interface TerminalNativeEvidenceFailure {
  kind: TerminalNativeEvidenceFailureKind;
  obligation: "tests" | "reviews";
  reason: string;
  sequence: number;
}
let sessionStartReason: WorkerReadinessReceipt["sessionStartReason"] | undefined;

export default function herdrWorkerBridge(pi: ExtensionAPI): void {
  sessionStartReason = undefined;
  const activeTools = new Set<string>();
  const observedCommandDigests: string[] = [];
  const nativeTestDiagnostics: string[] = [];
  const activeSubagentRuns = new Set<string>();
  const pendingSubagentLaunches = new Map<string, PendingSubagentLaunch>();
  const asyncReviewLaunches = new Map<string, AsyncReviewLaunch>();
  const pendingAsyncCompletions = new Map<string, unknown>();
  const terminalAsyncReviewRuns = new Set<string>();
  const consumedReviewerSessions = new Set<string>();
  const activeAsyncReviewCaptures = new Map<string, Promise<void>>();
  const terminalNativeEvidenceFailures = new Map<string, TerminalNativeEvidenceFailure>();
  const nativeExecutions = new Map<string, NativeExecutionProof>();
  let nativeEvidenceSequence = 0;
  let latestSuccessfulAsyncReviewSequence = 0;
  let failedBashCommand = false;
  let mutationToolUsed = false;
  let isAgentRunning = false;
  let challengeResponseRunning = false;
  const challengeTimer = setInterval((): void => {
    if (challengeResponseRunning) return;
    challengeResponseRunning = true;
    void respondToLifecycleChallenge().finally((): void => { challengeResponseRunning = false; });
  }, 50);
  challengeTimer.unref();
  const outstandingJobs = (): string[] => [
    ...(isAgentRunning ? ["pi-agent-run"] : []),
    ...[...activeTools].sort().map((id): string => `pi-tool:${id}`),
    ...[...activeAsyncReviewCaptures.keys()].sort().map((id): string => `native-async-review-capture:${id}`),
    ...[...terminalNativeEvidenceFailures].sort().map(([id, failure]): string =>
      `native-evidence-terminal-failure:${id}:${failure.kind}:${failure.reason}`),
  ];
  const recordTerminalEvidenceFailure = (
    id: string,
    kind: TerminalNativeEvidenceFailureKind,
    obligation: "tests" | "reviews",
    sequence: number,
    error: unknown,
  ): void => {
    terminalNativeEvidenceFailures.set(`${obligation}:${boundedDiagnostic(id)}`, {
      kind,
      obligation,
      reason: boundedDiagnostic(error instanceof Error ? error.message : String(error)),
      sequence,
    });
  };
  const clearRecoveredEvidenceFailures = (obligation: "tests" | "reviews", sequence: number): void => {
    for (const [failureId, failure] of terminalNativeEvidenceFailures) {
      if (failure.obligation === obligation && failure.sequence <= sequence) {
        terminalNativeEvidenceFailures.delete(failureId);
      }
    }
  };
  const invalidateObservedEvidence = async (
    id: string,
    obligation: "tests" | "reviews",
    cwd: string,
    sequence: number,
  ): Promise<boolean> => {
    try {
      await invalidateNativeExecutions(nativeExecutions, obligation, cwd);
      return true;
    } catch (error) {
      recordTerminalEvidenceFailure(id, "revocation-failed", obligation, sequence, error);
      return false;
    }
  };
  const retainFreshNativeExecution = async (
    toolCallId: string,
    obligation: "tests" | "reviews",
    cwd: string,
    sessionId: string,
    detail: string,
    sequence: number,
  ): Promise<void> => {
    if (!await invalidateObservedEvidence(toolCallId, obligation, cwd, sequence)) return;
    try {
      await retainNativeExecution(nativeExecutions, toolCallId, obligation, cwd, sessionId, detail);
      clearRecoveredEvidenceFailures(obligation, sequence);
    } catch (error) {
      recordTerminalEvidenceFailure(toolCallId, "capture-failed", obligation, sequence, error);
    }
  };
  const consumeAsyncReviewCompletion = (runId: string, payload: unknown): void => {
    const launch = asyncReviewLaunches.get(runId);
    if (!launch || terminalAsyncReviewRuns.has(runId)) return;
    terminalAsyncReviewRuns.add(runId);
    asyncReviewLaunches.delete(runId);
    pendingAsyncCompletions.delete(runId);
    const capture = (async (): Promise<void> => {
      try {
        await retainAsyncNativeReview(nativeExecutions, consumedReviewerSessions, launch, payload);
        latestSuccessfulAsyncReviewSequence = Math.max(latestSuccessfulAsyncReviewSequence, launch.sequence);
        clearRecoveredEvidenceFailures("reviews", launch.sequence);
      } catch (error) {
        nativeExecutions.delete(launch.toolCallId);
        let kind: TerminalNativeEvidenceFailureKind = isFileSystemError(error) ? "capture-failed" : "review-rejected";
        let reason = error instanceof Error ? error.message : String(error);
        try {
          await revokePublishedNativeEvidence();
        } catch (revocationError) {
          kind = "revocation-failed";
          reason = `${reason}; revocation failed: ${revocationError instanceof Error ? revocationError.message : String(revocationError)}`;
        }
        if (kind !== "revocation-failed" && launch.sequence < latestSuccessfulAsyncReviewSequence) return;
        recordTerminalEvidenceFailure(runId, kind, "reviews", launch.sequence, reason);
      }
    })().catch((error: unknown): void => {
      // This terminal guard must never reject: lifecycle remains fail-closed until a newer valid review proves capture recovered.
      nativeExecutions.delete(launch.toolCallId);
      recordTerminalEvidenceFailure(runId, "capture-failed", "reviews", launch.sequence, error);
    });
    activeAsyncReviewCaptures.set(runId, capture);
    void capture.then((): void => { activeAsyncReviewCaptures.delete(runId); });
  };
  pi.events.on("subagent:async-started", (payload: unknown): void => {
    const id = eventIdentity(payload);
    if (id) activeSubagentRuns.add(id);
  });
  pi.events.on("subagent:async-complete", (payload: unknown): void => {
    const id = eventIdentity(payload);
    if (!id) return;
    activeSubagentRuns.delete(id);
    const completion = objectRecord(payload);
    const toolCallId = typeof completion?.toolCallId === "string" ? completion.toolCallId : undefined;
    if (!asyncReviewLaunches.has(id) && toolCallId && pendingSubagentLaunches.has(toolCallId)) {
      pendingAsyncCompletions.set(id, payload);
      return;
    }
    consumeAsyncReviewCompletion(id, payload);
  });
  pi.on("session_start", (event, _ctx): void => {
    sessionStartReason = event.reason;
    activeTools.clear();
    activeSubagentRuns.clear();
    pendingSubagentLaunches.clear();
    asyncReviewLaunches.clear();
    pendingAsyncCompletions.clear();
    terminalAsyncReviewRuns.clear();
    consumedReviewerSessions.clear();
    activeAsyncReviewCaptures.clear();
    terminalNativeEvidenceFailures.clear();
    nativeEvidenceSequence = 0;
    latestSuccessfulAsyncReviewSequence = 0;
    observedCommandDigests.length = 0;
    nativeTestDiagnostics.length = 0;
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
    if (event.toolName === "edit" || event.toolName === "write") mutationToolUsed = true;
    if (event.toolName === "subagent") {
      const sourceSessionId = ctx.sessionManager.getSessionId();
      if (sourceSessionId) {
        const sessionFile = ctx.sessionManager.getSessionFile?.();
        pendingSubagentLaunches.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          cwd: ctx.cwd,
          sourceSessionId,
          ...(sessionFile ? { sourceSessionFile: sessionFile } : {}),
          sourceSessionIdentities: new Set([sourceSessionId, ...(sessionFile ? [sessionFile] : [])]),
          codeStateDigest: await captureCodeStateDigest(ctx.cwd),
          args: event.args,
          launchedAt: Date.now(),
          sequence: ++nativeEvidenceSequence,
        });
      }
    }
    await writeLifecycle(ctx, "working", outstandingJobs());
  });
  pi.on("tool_result", async (event, ctx): Promise<void> => {
    if (event.toolName !== "bash") return;
    failedBashCommand ||= event.isError;
    const command = event.input.command;
    if (typeof command !== "string" || command.length > 4_096) {
      nativeTestDiagnostics.push("The executed shell command exceeded the native-test provenance bound and was not accepted");
      return;
    }
    const commandDigest = createHash("sha256").update(command).digest("hex");
    observedCommandDigests.push(commandDigest);
    const testCommand = classifyNativeTestCommand(command);
    if (testCommand.status === "supported") {
      const sequence = ++nativeEvidenceSequence;
      if (!event.isError) {
        await retainFreshNativeExecution(
          event.toolCallId,
          "tests",
          ctx.cwd,
          ctx.sessionManager.getSessionId(),
          `bash:${commandDigest}`,
          sequence,
        );
      } else {
        await invalidateObservedEvidence(event.toolCallId, "tests", ctx.cwd, sequence);
        nativeTestDiagnostics.push("The directly executed native test command failed according to Pi's tool execution result; rerun it successfully after the final edit");
      }
    } else if (testCommand.status === "unsupported") {
      nativeTestDiagnostics.push(testCommand.diagnostic);
    }
  });
  pi.on("tool_execution_end", async (event, ctx): Promise<void> => {
    activeTools.delete(event.toolCallId);
    const pendingLaunch = pendingSubagentLaunches.get(event.toolCallId);
    const reviewSequence = pendingLaunch?.sequence ??
      (event.toolName === "subagent" ? ++nativeEvidenceSequence : nativeEvidenceSequence);
    if (event.toolName === "subagent" && event.isError && pendingLaunch && looksLikeAnyReviewRequest(pendingLaunch.args)) {
      await invalidateObservedEvidence(event.toolCallId, "reviews", ctx.cwd, reviewSequence);
    }
    if (event.toolName === "subagent" && !event.isError) {
      const asyncResult = parseAsyncLaunchResult(event.result);
      if (pendingLaunch && looksLikeReviewRequest(pendingLaunch.args) && (asyncResult || isAsyncLaunchLike(event.result))) {
        await invalidateObservedEvidence(event.toolCallId, "reviews", ctx.cwd, reviewSequence);
        if (asyncResult && await isBoundAsyncReviewLaunch(pendingLaunch, asyncResult)) {
          activeSubagentRuns.add(asyncResult.runId);
          asyncReviewLaunches.set(asyncResult.runId, {
            ...pendingLaunch,
            runId: asyncResult.runId,
            mode: asyncResult.mode,
            asyncDir: asyncResult.asyncDir,
          });
          const pendingCompletion = pendingAsyncCompletions.get(asyncResult.runId);
          if (pendingCompletion) consumeAsyncReviewCompletion(asyncResult.runId, pendingCompletion);
        }
      } else {
        const reviewResult = classifyNativeReviewResult(event.result);
        if (reviewResult === "passed") {
          await retainFreshNativeExecution(
            event.toolCallId,
            "reviews",
            ctx.cwd,
            ctx.sessionManager.getSessionId(),
            "subagent:structured-acceptance:no-blockers",
            reviewSequence,
          );
        } else if (reviewResult === "blocked") {
          await invalidateObservedEvidence(event.toolCallId, "reviews", ctx.cwd, reviewSequence);
        }
      }
    }
    pendingSubagentLaunches.delete(event.toolCallId);
    await writeLifecycle(ctx, "working", outstandingJobs());
  });
  pi.on("agent_settled", async (_event, ctx): Promise<void> => {
    isAgentRunning = false;
    await Promise.all([...activeAsyncReviewCaptures.values()]);
    const jobs = outstandingJobs();
    if (ctx.hasPendingMessages()) jobs.push("pi-queued-message");
    jobs.push(...await reconcileSubagentWork(pi, activeSubagentRuns));
    if (jobs.length === 0) {
      try {
        await produceNativeEvidence(nativeExecutions, nativeTestDiagnostics, ctx, false);
      } catch {
        jobs.push("native-evidence-capture-failed: the worker could not persist its execution-backed evidence index");
      }
    }
    await writeLifecycle(ctx, "settled", jobs);
  });

  pi.registerCommand("herdr-worker-ready", {
    description: "Report attempt-bound Pi identity and normal resource readiness to the local Herdr controller",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const receipt = collectWorkerReadiness(pi, ctx);
      await writeReceipt(receipt);
    },
  });

  pi.on("before_agent_start", (event): { systemPrompt: string } => ({
    systemPrompt: `${event.systemPrompt}\n\nHerdr native evidence requirements: run project-native tests through one directly executed bash test command after the final edit; shell wrappers, chaining, output claims, status masking, help/version/list/collect-only/no-run/dry-run modes, typecheck, and lint do not count as tests. Rerun an obligation successfully if a later test fails or review blocks on the same code state. Perform the implementation skill's final review with the installed subagent tool. Its ordinary asynchronous parallel code-review workflow is supported when every reviewer uses a fresh context, retains its output artifact, and ends with exactly one "Merge verdict: BLOCK", "Merge verdict: OK", or "Merge verdict: OK with notes" line. Foreground reviews remain supported when they return structured no-blocker acceptance metadata. The live worker bridge automatically captures execution-backed results when Pi settles on the unchanged final code state. Do not manufacture receipt files or substitute a prose completion claim.`,
  }));

  pi.registerTool({
    name: "herdr_capture_native_evidence",
    label: "Capture Native Implementation Evidence",
    description: "Produce immutable tests and review receipts only from successful ordinary implementation-skill executions observed by this live Pi process and bound to current Git content.",
    parameters: NATIVE_EVIDENCE_CAPTURE_SCHEMA,
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const produced = await produceNativeEvidence(nativeExecutions, nativeTestDiagnostics, ctx, true);
      const nativeEvidence = produced!.nativeEvidence;
      return {
        content: [{ type: "text", text: `Captured immutable native evidence from observed executions:\n${JSON.stringify(nativeEvidence, null, 2)}` }],
        details: { codeStateDigest: produced!.codeStateDigest, nativeEvidence },
      };
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
      const matchingNativeTest = [...nativeExecutions.values()].some((proof): boolean =>
        proof.kind === "tests" && proof.codeStateDigest === params.codeStateDigest);
      if (observedCommandDigests.length === 0 || (params.status === "blocked" && params.findings.length === 0) ||
        (params.status === "passed" && (!matchingNativeTest || params.findings.length > 0 || failedBashCommand || mutationToolUsed))
      ) throw new Error("Native verification requires an actual successful native test command on the submitted code state and no failed commands or mutations");
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
    piPid: process.pid,
    state,
    observedAt: new Date().toISOString(),
    outstandingJobs,
  })}\n`);
}

type NativeTestCommandClassification =
  | { status: "supported" }
  | { status: "unsupported"; diagnostic: string }
  | { status: "unrelated" };

function classifyNativeTestCommand(command: string): NativeTestCommandClassification {
  const trimmed = command.trim();
  const mentionsTestObligation = /\b(?:test|tests|pytest|jest|vitest|typecheck|lint)\b/i.test(trimmed);
  if (!mentionsTestObligation) return { status: "unrelated" };
  if (!trimmed || /[\r\n;&|`$()<>\\"']/.test(trimmed)) {
    return {
      status: "unsupported",
      diagnostic: "Native evidence requires one directly executed test command without echo/printf, shell wrappers, substitutions, redirections, chaining, or status masking",
    };
  }
  const tokens = trimmed.split(/\s+/);
  const normalizedTokens = tokens.map((token): string => token.toLowerCase());
  const executable = normalizedTokens[0];
  const hasOption = (option: string): boolean => normalizedTokens.some((token): boolean =>
    token === option || token.startsWith(`${option}=`));
  const hasNonExecutingMode = [
    "--help", "-h", "--version", "--dry-run", "--dryrun", "--no-run", "--if-present",
    "--ignore-scripts", "--passwithnotests", "--collect-only", "--collectonly", "--co",
    "--list", "--listtests", "--list-tests", "--showconfig", "--show-config", "--clearcache",
    "--markers", "--fixtures", "--fixtures-per-test",
  ].some(hasOption) ||
    (executable === "node" && ["-v", "--v8-options", "--completion-bash"].some(hasOption)) ||
    (executable === "go" && normalizedTokens[1] === "test" && (["-c", "-list"].some(hasOption))) ||
    (executable === "npx" && normalizedTokens.some((token, index): boolean =>
      token === "list" && normalizedTokens.slice(1, index).some((candidate): boolean => ["jest", "vitest"].includes(candidate))));
  if (hasNonExecutingMode) {
    return {
      status: "unsupported",
      diagnostic: "Help, version, list, collect-only, no-run, and dry-run modes do not execute tests and cannot satisfy native test evidence",
    };
  }
  const directPackageTest = (runner: string): boolean => {
    if (executable !== runner) return false;
    if (tokens[1] === "test") return true;
    return tokens[1] === "run" && (tokens[2] === "test" || tokens[2]?.startsWith("test:") === true);
  };
  const directNodeTest = (): boolean => {
    if (executable !== "node") return false;
    let sawTestMode = false;
    for (let index = 1; index < normalizedTokens.length; index += 1) {
      const token = normalizedTokens[index]!;
      if (token === "--test" || token.startsWith("--test=")) {
        sawTestMode = true;
        continue;
      }
      if (["-e", "--eval", "-p", "--print"].includes(token)) return false;
      if (token === "--import" || token === "--require" || token === "-r") {
        index += 1;
        if (index >= tokens.length) return false;
      } else if (!token.startsWith("-") && !sawTestMode) {
        return false;
      }
    }
    return sawTestMode;
  };
  const directNpxTest = executable === "npx" &&
    (["jest", "vitest"].includes(normalizedTokens[1] ?? "") ||
      (normalizedTokens[1] === "--yes" && ["jest", "vitest"].includes(normalizedTokens[2] ?? "")));
  const supported = directPackageTest("npm") || directPackageTest("pnpm") || directPackageTest("yarn") ||
    directPackageTest("bun") || directNodeTest() || directNpxTest || executable === "pytest" ||
    ((executable === "python" || executable === "python3") && tokens[1] === "-m" && tokens[2] === "pytest") ||
    (executable === "go" && tokens[1] === "test") ||
    (executable === "cargo" && tokens[1] === "test");
  if (supported) return { status: "supported" };
  return {
    status: "unsupported",
    diagnostic: /\b(?:typecheck|lint)\b/i.test(trimmed)
      ? "Typecheck and lint do not satisfy native tests; execute the project's actual required test command directly"
      : "Native evidence requires a supported directly executed test command; the observed invocation was not recognized and was not guessed",
  };
}

async function produceNativeEvidence(
  executions: Map<string, NativeExecutionProof>,
  testDiagnostics: string[],
  ctx: ExtensionContext,
  required: boolean,
): Promise<{ codeStateDigest: string; nativeEvidence: NativeEvidenceRecord[] } | undefined> {
  if (!required && (![...executions.values()].some((proof): boolean => proof.kind === "tests") ||
    ![...executions.values()].some((proof): boolean => proof.kind === "reviews"))) return undefined;
  const git = new RealGitWorktreeAdapter();
  const candidate = await git.captureCandidate({
    path: ctx.cwd,
    sourceBase: (await git.inspectWorktree(ctx.cwd)).head,
  });
  const selected = (["tests", "reviews"] as const).map((kind) =>
    [...executions.entries()].reverse().find(([, proof]): boolean =>
      proof.kind === kind && proof.codeStateDigest === candidate.codeStateDigest));
  if (selected.some((proof): boolean => proof === undefined)) {
    if (!required) return undefined;
    const testDiagnostic = selected[0] === undefined ? testDiagnostics.at(-1) : undefined;
    throw new Error(`Current Git code state lacks observed successful native tests or a structured no-blocker review; rerun the missing obligation before acceptance${testDiagnostic ? `. ${testDiagnostic}` : ""}`);
  }
  const endpoint = process.env[WORKER_BRIDGE_ENDPOINT_ENV];
  if (!endpoint || !isAbsolute(endpoint)) throw new Error("Attempt-bound worker bridge endpoint is unavailable");
  const evidenceDirectory = join(dirname(endpoint), "native-evidence");
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const nativeEvidence: NativeEvidenceRecord[] = [];
  for (const selectedProof of selected) {
    const [, proof] = selectedProof!;
    const completedAt = proof.completedAt;
    const id = randomUUID();
    let sourceArtifact = proof.sourceArtifact;
    if (!sourceArtifact) {
      const sourcePath = join(evidenceDirectory, `${proof.kind}-${id}-execution.json`);
      const source = `${JSON.stringify({
        schemaVersion: 1,
        producer: "pi-native-skill",
        kind: proof.kind,
        status: "passed",
        codeStateDigest: candidate.codeStateDigest,
        completedAt,
        executionReferences: [proof.executionReference],
      })}\n`;
      await atomicWritePrivateFile(sourcePath, source);
      sourceArtifact = { reference: sourcePath, digest: createHash("sha256").update(source).digest("hex") };
    }
    const manifestPath = join(evidenceDirectory, `${proof.kind}-${id}-receipt.json`);
    const manifest = `${JSON.stringify({
      schemaVersion: 1,
      kind: proof.kind,
      status: "passed",
      codeStateDigest: candidate.codeStateDigest,
      completedAt,
      artifacts: [sourceArtifact],
    })}\n`;
    await atomicWritePrivateFile(manifestPath, manifest);
    nativeEvidence.push({
      kind: proof.kind,
      status: "passed",
      codeStateDigest: candidate.codeStateDigest,
      evidenceReference: manifestPath,
      evidenceDigest: createHash("sha256").update(manifest).digest("hex"),
      completedAt,
    });
  }
  await atomicWritePrivateFile(join(evidenceDirectory, "latest.json"), `${JSON.stringify({
    schemaVersion: 1,
    producer: "herdr-worker-bridge",
    sessionId: ctx.sessionManager.getSessionId(),
    codeStateDigest: candidate.codeStateDigest,
    nativeEvidence,
  })}\n`);
  return { codeStateDigest: candidate.codeStateDigest, nativeEvidence };
}

async function retainNativeExecution(
  executions: Map<string, NativeExecutionProof>,
  toolCallId: string,
  kind: "tests" | "reviews",
  cwd: string,
  sessionId: string,
  detail: string,
): Promise<void> {
  const codeStateDigest = await captureCodeStateDigest(cwd);
  executions.set(toolCallId, {
    kind,
    codeStateDigest,
    completedAt: new Date().toISOString(),
    executionReference: `pi-session:${sessionId}:tool:${toolCallId}:${detail}`,
  });
}

async function invalidateNativeExecutions(
  executions: Map<string, NativeExecutionProof>,
  kind: "tests" | "reviews",
  cwd: string,
): Promise<void> {
  const codeStateDigest = await captureCodeStateDigest(cwd);
  for (const [toolCallId, proof] of executions) {
    if (proof.kind === kind && proof.codeStateDigest === codeStateDigest) executions.delete(toolCallId);
  }
  await revokePublishedNativeEvidence();
}

async function revokePublishedNativeEvidence(): Promise<void> {
  const endpoint = process.env[WORKER_BRIDGE_ENDPOINT_ENV];
  if (!endpoint || !isAbsolute(endpoint)) return;
  try {
    await unlink(join(dirname(endpoint), "native-evidence", "latest.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function captureCodeStateDigest(cwd: string): Promise<string> {
  const git = new RealGitWorktreeAdapter();
  const worktree = await git.inspectWorktree(cwd);
  const candidate = await git.captureCandidate({ path: cwd, sourceBase: worktree.head });
  return candidate.codeStateDigest;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function serializeBoundedToolArgs(args: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(args);
    return serialized.length <= 128 * 1024 ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeAnyReviewRequest(args: unknown): boolean {
  const serialized = serializeBoundedToolArgs(args);
  return Boolean(serialized && /review/i.test(serialized));
}

function looksLikeReviewRequest(args: unknown): boolean {
  const serialized = serializeBoundedToolArgs(args);
  return Boolean(serialized && /runs\.all/i.test(serialized) && /review/i.test(serialized) &&
    /standards/i.test(serialized) && /(?:\bspec\b|requirements?)/i.test(serialized));
}

function isAsyncLaunchLike(value: unknown): boolean {
  const details = objectRecord(objectRecord(value)?.details);
  return Boolean(details && typeof details.runId === "string" && Array.isArray(details.results) && details.results.length === 0);
}

function parseAsyncLaunchResult(value: unknown): { runId: string; toolCallId: string; mode: "workflow"; asyncDir: string } | undefined {
  const details = objectRecord(objectRecord(value)?.details);
  if (!details || details.mode !== "workflow" || typeof details.runId !== "string" ||
    eventIdentity({ id: details.runId }) !== details.runId || details.asyncId !== details.runId ||
    typeof details.toolCallId !== "string" || typeof details.asyncDir !== "string" ||
    !isAbsolute(details.asyncDir) || !Array.isArray(details.results) || details.results.length !== 0
  ) return undefined;
  return { runId: details.runId, toolCallId: details.toolCallId, mode: "workflow", asyncDir: details.asyncDir };
}

async function isBoundAsyncReviewLaunch(
  pending: PendingSubagentLaunch,
  result: { runId: string; toolCallId: string; mode: "workflow"; asyncDir: string },
): Promise<boolean> {
  if (!looksLikeReviewRequest(pending.args) || result.toolCallId !== pending.toolCallId) return false;
  const expected = join(piSubagentsTempRoot(), "async-subagent-runs", result.runId);
  if (resolve(result.asyncDir) !== expected) return false;
  try {
    await assertCanonicalDirectory(result.asyncDir, join(piSubagentsTempRoot(), "async-subagent-runs"));
    return true;
  } catch {
    return false;
  }
}

async function retainAsyncNativeReview(
  executions: Map<string, NativeExecutionProof>,
  consumedReviewerSessions: Set<string>,
  launch: AsyncReviewLaunch,
  value: unknown,
): Promise<void> {
  const completion = objectRecord(value);
  const timestamp = Number(completion?.timestamp);
  if (!completion || completion.id !== launch.runId || completion.runId !== launch.runId ||
    completion.toolCallId !== launch.toolCallId || completion.mode !== "workflow" || completion.success !== true ||
    completion.state !== "complete" || completion.cwd !== launch.cwd || completion.asyncDir !== launch.asyncDir ||
    !launch.sourceSessionIdentities.has(String(completion.sessionId)) ||
    typeof completion.completionOwnerId !== "string" || !completion.completionOwnerId ||
    !Number.isFinite(timestamp) || timestamp < launch.launchedAt || timestamp > Date.now() + 60_000 ||
    !Array.isArray(completion.results) ||
    completion.results.length !== 2
  ) throw new Error("Asynchronous native review completion was stale, unrelated, or incomplete");
  if (await captureCodeStateDigest(launch.cwd) !== launch.codeStateDigest) {
    throw new Error("Asynchronous native review did not complete on its launch code state");
  }

  const statusPath = join(launch.asyncDir, "status.json");
  const receiptPath = join(launch.asyncDir, "workflow-receipt.json");
  const statusFile = await readCanonicalBoundedFile(statusPath, [launch.asyncDir], 2 * 1024 * 1024);
  const receiptFile = await readCanonicalBoundedFile(receiptPath, [launch.asyncDir], 2 * 1024 * 1024);
  const status = parseJsonRecord(statusFile);
  const receipt = parseJsonRecord(receiptFile);
  const completionReceipt = objectRecord(completion.workflowReceipt);
  const workflowChildren = objectRecord(completion.workflowChildren);
  if (!status || !receipt || status.runId !== launch.runId || status.toolCallId !== launch.toolCallId ||
    status.mode !== "workflow" || status.state !== "complete" || status.cwd !== launch.cwd ||
    status.sessionId !== completion.sessionId || status.completionOwnerId !== completion.completionOwnerId ||
    status.workflowReceiptPath !== receiptPath || !Number.isFinite(status.endedAt) ||
    Number(status.endedAt) < launch.launchedAt || Number(status.endedAt) > timestamp ||
    receipt.version !== 1 || receipt.workflowRunId !== launch.runId || receipt.state !== "complete" ||
    !Number.isFinite(receipt.createdAt) || Number(receipt.createdAt) < launch.launchedAt || Number(receipt.createdAt) > timestamp ||
    completionReceipt?.path !== receiptPath || stableJson(completionReceipt.receipt) !== stableJson(receipt) ||
    stableJson(status.workflowChildren) !== stableJson(workflowChildren) ||
    stableJson(receipt.workflowChildren) !== stableJson(workflowChildren) ||
    !isCompleteWorkflowChildren(workflowChildren, launch)
  ) throw new Error("Asynchronous native review status or workflow receipt was stale or incomplete");

  const entries = objectRecord(receipt.entries);
  const steps = Array.isArray(status.steps) ? status.steps.map(objectRecord) : [];
  if (!entries || Object.keys(entries).length !== 2 || steps.length !== 2 || steps.some((step) => !step)) {
    throw new Error("Asynchronous native review child inventory was incomplete");
  }
  const results = new Map<string, Record<string, unknown>>();
  for (const resultValue of completion.results) {
    const result = objectRecord(resultValue);
    if (!result || typeof result.workflowKey !== "string" || results.has(result.workflowKey)) {
      throw new Error("Asynchronous native review result identities were incomplete");
    }
    results.set(result.workflowKey, result);
  }

  if (!launch.sourceSessionFile) throw new Error("Asynchronous native review source session root was unavailable");
  const sessionRoot = join(dirname(launch.sourceSessionFile), basename(launch.sourceSessionFile, ".jsonl"));
  const outputRoots = [
    launch.asyncDir,
    join(dirname(launch.sourceSessionFile), "subagent-artifacts"),
    join(launch.cwd, ".pi", "subagents", "artifacts"),
    join(piSubagentsTempRoot(), "artifacts"),
  ];
  const reviewerSessions = new Set<string>();
  const roles = new Set<"standards" | "spec">();
  const reviewArtifacts: Array<{
    role: "standards" | "spec";
    workflowKey: string;
    reviewerSession: string;
    reference: string;
    digest: string;
    verdict: "OK" | "OK with notes";
    report: string;
  }> = [];
  for (const stepValue of steps) {
    const step = stepValue!;
    const key = typeof step.workflowKey === "string" ? step.workflowKey : "";
    const entry = objectRecord(entries[key]);
    const result = results.get(key);
    const artifactPaths = objectRecord(result?.artifactPaths);
    const continuation = objectRecord(entry?.continuation);
    const runIds = Array.isArray(continuation?.runIds) ? continuation.runIds : [];
    const childRunId = runIds.at(-1);
    const role = reviewRole(`${key} ${String(step.label ?? "")}`);
    const workflowChild = (workflowChildren!.children as unknown[]).map(objectRecord)
      .find((child): boolean => child?.childId === key);
    if (!entry || !result || !workflowChild || !role || roles.has(role) || entry.key !== key || entry.agent !== "reviewer" ||
      entry.requestedContext !== "fresh" || entry.resolvedContext !== "fresh" ||
      step.agent !== "reviewer" || step.status !== "completed" || step.parentWorkflowRunId !== launch.runId ||
      typeof childRunId !== "string" || eventIdentity({ id: childRunId }) !== childRunId ||
      step.async !== true || step.runId !== childRunId || result.runId !== childRunId ||
      workflowChild.runId !== childRunId || workflowChild.agent !== "reviewer" || workflowChild.state !== "completed" ||
      (entry.latestRunId !== undefined && entry.latestRunId !== childRunId) ||
      result.agent !== "reviewer" || result.success !== true || result.status !== "completed" ||
      result.outputState !== "present" || typeof step.sessionFile !== "string" || result.sessionFile !== step.sessionFile ||
      typeof entry.outputReference !== "string" || result.outputReference !== entry.outputReference ||
      typeof artifactPaths?.outputPath !== "string"
    ) throw new Error("Asynchronous native review child identity, role, freshness, or artifact binding was incomplete");

    const expectedChildAsyncDir = join(piSubagentsTempRoot(), "async-subagent-runs", childRunId);
    if (resolve(artifactPaths.outputPath) !== expectedChildAsyncDir) {
      throw new Error("Asynchronous native review child artifact did not identify its installed async run");
    }
    await assertCanonicalDirectory(artifactPaths.outputPath, join(piSubagentsTempRoot(), "async-subagent-runs"));
    const canonicalSession = await assertCanonicalRegularFile(step.sessionFile, [sessionRoot]);
    if (reviewerSessions.has(canonicalSession) || consumedReviewerSessions.has(canonicalSession)) {
      throw new Error("Asynchronous native review reused a reviewer session");
    }
    const { canonicalPath: reportPath, content: report } = await readCanonicalBoundedFile(
      entry.outputReference,
      outputRoots,
      256 * 1024,
    );
    const verdicts = [...report.matchAll(/^Merge verdict:\s*(BLOCK|OK with notes|OK)\s*\.?\s*$/gim)];
    if (verdicts.length !== 1 || verdicts[0]![1]!.toUpperCase() === "BLOCK") {
      throw new Error("Asynchronous native review reported a blocker or omitted its merge verdict");
    }
    reviewerSessions.add(canonicalSession);
    consumedReviewerSessions.add(canonicalSession);
    roles.add(role);
    reviewArtifacts.push({
      role,
      workflowKey: key,
      reviewerSession: canonicalSession,
      reference: reportPath,
      digest: createHash("sha256").update(report).digest("hex"),
      verdict: /^OK with notes$/i.test(verdicts[0]![1]!) ? "OK with notes" : "OK",
      report,
    });
  }
  if (roles.size !== 2 || !roles.has("standards") || !roles.has("spec")) {
    throw new Error("Asynchronous native review did not prove distinct Standards and Spec reviewers");
  }

  const completedAt = new Date(timestamp).toISOString();
  const endpoint = process.env[WORKER_BRIDGE_ENDPOINT_ENV];
  if (!endpoint || !isAbsolute(endpoint)) throw new Error("Attempt-bound worker bridge endpoint is unavailable");
  // A successful capture must also prove that a prior public-index revocation failure no longer exists.
  await revokePublishedNativeEvidence();
  const evidenceDirectory = join(dirname(endpoint), "native-evidence");
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const sourcePath = join(evidenceDirectory, `reviews-${randomUUID()}-async-execution.json`);
  const executionReference = `pi-session:${launch.sourceSessionId}:tool:${launch.toolCallId}:subagent:async:${launch.runId}`;
  const source = `${JSON.stringify({
    schemaVersion: 1,
    producer: "pi-native-skill",
    kind: "reviews",
    status: "passed",
    codeStateDigest: launch.codeStateDigest,
    completedAt,
    executionReferences: [executionReference],
    workflowReceipt: { reference: receiptPath, digest: createHash("sha256").update(receiptFile.content).digest("hex") },
    reviewArtifacts,
  })}\n`;
  await atomicWritePrivateFile(sourcePath, source);
  executions.set(launch.toolCallId, {
    kind: "reviews",
    codeStateDigest: launch.codeStateDigest,
    completedAt,
    executionReference,
    sourceArtifact: { reference: sourcePath, digest: createHash("sha256").update(source).digest("hex") },
  });
}

function isCompleteWorkflowChildren(value: Record<string, unknown> | undefined, launch: AsyncReviewLaunch): boolean {
  if (!value || value.version !== 1 || value.parentToolCallId !== launch.toolCallId ||
    value.workflowRunId !== launch.runId || value.inventoryComplete !== true ||
    value.workflowState !== "completed" || !Array.isArray(value.children) || value.children.length !== 2
  ) return false;
  const ids = new Set<string>();
  return value.children.every((childValue): boolean => {
    const child = objectRecord(childValue);
    if (!child || typeof child.childId !== "string" || ids.has(child.childId) || child.state !== "completed") return false;
    ids.add(child.childId);
    return typeof child.runId === "string" && Boolean(child.runId) && child.agent === "reviewer";
  });
}

function reviewRole(value: string): "standards" | "spec" | undefined {
  const standards = /\bstandards?\b/i.test(value);
  const spec = /\b(?:spec|specification|requirements?)\b/i.test(value);
  return standards === spec ? undefined : standards ? "standards" : "spec";
}

function parseJsonRecord(input: { content: string }): Record<string, unknown> | undefined {
  try {
    return objectRecord(JSON.parse(input.content));
  } catch {
    return undefined;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key): string => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function piSubagentsTempRoot(): string {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (configured) return resolve(configured);
  if (typeof process.getuid === "function") return join(tmpdir(), `pi-subagents-uid-${process.getuid()}`);
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    if (process.env[key]) return join(tmpdir(), `pi-subagents-user-${sanitizeScope(process.env[key]!)}`);
  }
  try {
    if (userInfo().username) return join(tmpdir(), `pi-subagents-user-${sanitizeScope(userInfo().username)}`);
  } catch {
    // Continue to the same home-directory fallbacks used by pi-subagents.
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(tmpdir(), `pi-subagents-home-${sanitizeScope(home)}`);
}

function sanitizeScope(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

async function assertCanonicalDirectory(path: string, trustedRoot: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Installed extension path was not absolute");
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(trustedRoot), realpath(path)]);
  if (canonicalPath !== resolve(path) || !isContained(canonicalRoot, canonicalPath)) {
    throw new Error("Installed extension path escaped its canonical root");
  }
  const file = await open(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isDirectory()) throw new Error("Installed extension path was not a directory");
  } finally {
    await file.close();
  }
  return canonicalPath;
}

async function assertCanonicalRegularFile(path: string, trustedRoots: string[]): Promise<string> {
  const result = await readCanonicalBoundedFile(path, trustedRoots, 16 * 1024 * 1024, false);
  return result.canonicalPath;
}

async function readCanonicalBoundedFile(
  path: string,
  trustedRoots: string[],
  maximumBytes: number,
  readContent = true,
): Promise<{ canonicalPath: string; content: string }> {
  if (!isAbsolute(path)) throw new Error("Artifact path was not absolute");
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) {
      throw new Error("Artifact was not a bounded regular file");
    }
    const canonicalRoots = await Promise.all(trustedRoots.map(async (root): Promise<string | undefined> => {
      try { return await realpath(root); } catch { return undefined; }
    }));
    const canonicalPath = await realpath(path);
    if (canonicalPath !== resolve(path) || !canonicalRoots.some((root): boolean => Boolean(root && isContained(root, canonicalPath)))) {
      throw new Error("Artifact path escaped its canonical trusted roots");
    }
    const canonicalFile = await open(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const canonicalMetadata = await canonicalFile.stat();
      if (canonicalMetadata.dev !== metadata.dev || canonicalMetadata.ino !== metadata.ino) {
        throw new Error("Artifact path changed during canonical validation");
      }
    } finally {
      await canonicalFile.close();
    }
    if (!readContent) return { canonicalPath, content: "" };
    const data = Buffer.alloc(metadata.size + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== metadata.size) throw new Error("Artifact changed while it was read");
    return { canonicalPath, content: data.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await file.close();
  }
}

function boundedDiagnostic(value: string): string {
  return value.replace(/[\r\n:]+/g, " ").slice(0, 500) || "unknown asynchronous evidence failure";
}

function isFileSystemError(value: unknown): boolean {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}

function classifyNativeReviewResult(result: unknown): "passed" | "blocked" | "unrelated" {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "unrelated";
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return "unrelated";
  const record = details as Record<string, unknown>;
  if (record.background === true || !Array.isArray(record.results) || record.results.length === 0) return "unrelated";
  let blocked = false;
  for (const value of record.results) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "unrelated";
    const child = value as Record<string, unknown>;
    if (!/review/i.test(`${String(child.agent ?? "")} ${String(child.task ?? "")}`)) return "unrelated";
    const report = child.structuredAcceptanceReport ??
      (child.acceptance && typeof child.acceptance === "object" && !Array.isArray(child.acceptance)
        ? (child.acceptance as Record<string, unknown>).childReport
        : undefined);
    if (child.exitCode !== 0 || child.error !== undefined ||
      !report || typeof report !== "object" || Array.isArray(report)
    ) {
      blocked = true;
      continue;
    }
    const acceptance = report as Record<string, unknown>;
    const criteria = acceptance.criteriaSatisfied;
    const findings = acceptance.reviewFindings;
    const passed = Array.isArray(criteria) && criteria.some((criterion): boolean =>
      Boolean(criterion) && typeof criterion === "object" && !Array.isArray(criterion) &&
      (criterion as Record<string, unknown>).status === "satisfied") && criteria.every((criterion): boolean =>
      Boolean(criterion) && typeof criterion === "object" && !Array.isArray(criterion) &&
      ["satisfied", "not-applicable"].includes(String((criterion as Record<string, unknown>).status))) &&
      Array.isArray(findings) && findings.length > 0 && findings.every((finding): boolean =>
        typeof finding === "string" && /^(?:no blockers?|none|no findings?)\.?$/i.test(finding.trim()));
    if (!passed) blocked = true;
  }
  return blocked ? "blocked" : "passed";
}

function eventIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  const id = typeof event.id === "string" ? event.id : typeof event.runId === "string" ? event.runId : undefined;
  return id && /^[A-Za-z0-9._:-]{1,500}$/.test(id) ? id : undefined;
}

async function reconcileSubagentWork(pi: ExtensionAPI, observed: Set<string>): Promise<string[]> {
  const hasSubagentTool = pi.getAllTools().some((tool): boolean => tool.name === "subagent");
  if (!hasSubagentTool) {
    return ["subagent-observer-unavailable: required subagent tool or provider adapter is not loaded"];
  }
  const requestId = randomUUID();
  const replyEvent = `subagents:rpc:v1:reply:${requestId}`;
  const reply = await new Promise<unknown>((resolvePromise): void => {
    let unsubscribe: (() => void) | void;
    const timer = setTimeout((): void => {
      if (typeof unsubscribe === "function") unsubscribe();
      resolvePromise(undefined);
    }, 500);
    unsubscribe = pi.events.on(replyEvent, (payload: unknown): void => {
      clearTimeout(timer);
      if (typeof unsubscribe === "function") unsubscribe();
      resolvePromise(payload);
    });
    pi.events.emit("subagents:rpc:v1:request", {
      version: 1,
      requestId,
      method: "status",
      source: { extension: "herdr-worker-bridge" },
    });
  });
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
    return ["subagent-observer-unavailable: status RPC did not answer; inspect subagent/provider status before acceptance"];
  }
  const envelope = reply as Record<string, unknown>;
  if (envelope.success !== true || !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
    return ["subagent-observer-unavailable: status RPC failed; inspect subagent/provider status before acceptance"];
  }
  const snapshot = (envelope.data as Record<string, unknown>).asyncSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return ["subagent-observer-unavailable: status RPC omitted its async snapshot"];
  }
  const projected = snapshot as Record<string, unknown>;
  const omitted = projected.omitted;
  if (projected.kind !== "pi-subagents.async-status-snapshot" || projected.version !== 1 ||
    !omitted || typeof omitted !== "object" || Array.isArray(omitted) || !Array.isArray(projected.runs)
  ) return ["subagent-status-unknown: async status snapshot was malformed; inspect active subagent/provider work"];
  const omission = omitted as Record<string, unknown>;
  if (!Number.isSafeInteger(omission.runs) || Number(omission.runs) < 0 ||
    !Number.isSafeInteger(omission.children) || Number(omission.children) < 0 ||
    typeof omission.byteLimitExceeded !== "boolean" || Number(omission.runs) > 0 ||
    Number(omission.children) > 0 || omission.byteLimitExceeded
  ) return ["subagent-status-unknown: async status snapshot was incomplete; inspect active subagent/provider work"];
  const active = new Set<string>();
  const pending = projected.runs.map((node): { node: unknown; depth: number } => ({ node, depth: 0 }));
  const visited = new Set<object>();
  const knownKinds = new Set(["subagent", "workflow", "step", "host-step"]);
  const knownStates = new Set(["queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected"]);
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!current.node || typeof current.node !== "object" || Array.isArray(current.node) ||
      visited.has(current.node) || current.depth > 8 || ++nodes > 20_000
    ) return ["subagent-status-unknown: async status descendants were malformed or exceeded their bound"];
    visited.add(current.node);
    const node = current.node as Record<string, unknown>;
    if (typeof node.id !== "string" || !node.id || node.id.length > 500 ||
      typeof node.kind !== "string" || !knownKinds.has(node.kind) ||
      typeof node.state !== "string" || !knownStates.has(node.state) ||
      (node.children !== undefined && !Array.isArray(node.children))
    ) return ["subagent-status-unknown: async status descendants were malformed or unknown"];
    if (["queued", "running", "partial", "paused"].includes(node.state)) active.add(node.id);
    for (const child of (node.children as unknown[] | undefined) ?? []) {
      pending.push({ node: child, depth: current.depth + 1 });
    }
  }
  observed.clear();
  for (const id of active) observed.add(id);
  return [...active].sort().map((id): string => `pi-subagent:${id}`);
}

async function respondToLifecycleChallenge(): Promise<void> {
  const endpoint = process.env[WORKER_BRIDGE_ENDPOINT_ENV];
  const nonce = process.env[WORKER_BRIDGE_NONCE_ENV];
  if (!endpoint || !nonce || !isAbsolute(endpoint)) return;
  const challengePath = join(dirname(endpoint), "lifecycle-challenge.json");
  const responsePath = join(dirname(endpoint), "lifecycle-challenge-response.json");
  try {
    const parsed = JSON.parse(await readBoundedRegularFile(challengePath)) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || parsed.nonce !== nonce || typeof parsed.challenge !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(parsed.challenge) || !Number.isSafeInteger(parsed.expectedPiPid) ||
      typeof parsed.requestedAt !== "string" || !Number.isFinite(Date.parse(parsed.requestedAt))
    ) return;
    await atomicWritePrivateFile(responsePath, `${JSON.stringify({
      schemaVersion: 1,
      nonce,
      challenge: parsed.challenge,
      piPid: process.pid,
      respondedAt: new Date().toISOString(),
    })}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Malformed or unsafe challenges are ignored; the controller fails closed on timeout.
    }
  }
}

async function readBoundedRegularFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 256 * 1024) {
      throw new Error("Worker bridge challenge is not a bounded regular file");
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== metadata.size) throw new Error("Worker bridge challenge changed while it was read");
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

async function writeReceipt(receipt: WorkerReadinessReceipt): Promise<void> {
  const endpoint = process.env[WORKER_BRIDGE_ENDPOINT_ENV]!;
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  await atomicWritePrivateFile(endpoint, `${JSON.stringify(receipt)}\n`);
}
