import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  type AdmissionSnapshot,
  type ApprovalRequest,
  type AcceptCandidateRequest,
  type BatchProposal,
  type CandidateReceipt,
  type CapturedModel,
  type ControllerResult,
  type ControllerStatus,
  type ExecutionAttempt,
} from "./controller.js";
import { isActiveExecutionLifecycle } from "./contracts.js";
import { FileWorkerBridgeTransport } from "./file-worker-bridge.js";
import { connectOrStartLocalController, localDaemonPaths, type ControllerClient } from "./local-daemon.js";
import { readProducedNativeEvidence } from "./native-evidence.js";
import { formatPreparationPreview } from "./presentation.js";
import { mapAcceptCandidateCommand } from "./presentation-mappers.js";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const SOURCE_EVIDENCE_SCHEMA = Type.Object({
  identity: Type.String({ minLength: 1 }),
  revision: Type.String({ minLength: 1 }),
  contentDigest: Type.String({ pattern: "^[a-fA-F0-9]{64}$" }),
  retrievedAt: Type.String({ minLength: 1 }),
  references: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});
const MODEL_SCHEMA = Type.Object({
  provider: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  thinkingLevel: StringEnum(THINKING_LEVELS),
  contextWindow: Type.Integer({ minimum: 40_000 }),
});
const PROPOSAL_SCHEMA = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1, maximum: 1 }),
  controllerName: Type.String({ minLength: 1 }),
  project: Type.Object({
    identity: Type.String({ minLength: 1 }),
    tracker: Type.Object({
      identity: Type.String({ minLength: 1 }),
      instructionSources: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      instructionEvidenceIdentities: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }),
  }),
  sourceEvidence: Type.Array(SOURCE_EVIDENCE_SCHEMA, { minItems: 1 }),
  spec: Type.Object({
    identity: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    evidenceIdentity: Type.String({ minLength: 1 }),
  }),
  tickets: Type.Array(
    Type.Object({
      identity: Type.String({ minLength: 1 }),
      title: Type.String({ minLength: 1 }),
      evidenceIdentity: Type.String({ minLength: 1 }),
      claimedBy: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    }),
    { minItems: 1 },
  ),
  dependencies: Type.Array(
    Type.Object({
      ticketIdentity: Type.String({ minLength: 1 }),
      prerequisiteIdentity: Type.String({ minLength: 1 }),
      kind: StringEnum(["ticket", "external"] as const),
      status: StringEnum(["in-batch", "resolved", "unresolved"] as const),
      evidenceIdentity: Type.Optional(Type.String({ minLength: 1 })),
    }),
  ),
  target: Type.Object({ branch: Type.String({ minLength: 1 }), baseCommit: Type.String({ minLength: 1 }) }),
  model: MODEL_SCHEMA,
  policy: Type.Object({
    concurrency: Type.Integer({ minimum: 1 }),
    context: Type.Object({
      requestedHandoffTokens: Type.Integer({ minimum: 1 }),
      reserveTokens: Type.Integer({ minimum: 1 }),
    }),
    maxHandoffReplacements: Type.Integer({ minimum: 0 }),
    maxRepairCycles: Type.Integer({ minimum: 0 }),
    requiredReviews: Type.Array(StringEnum(["standards", "spec"] as const)),
    implementationSkillTestingRequired: Type.Boolean(),
    checks: Type.Array(
      Type.Object({ command: Type.String(), source: Type.String(), evidenceIdentity: Type.String({ minLength: 1 }) }),
    ),
    setupOperations: Type.Array(
      Type.Object({
        kind: StringEnum(["dependency-install", "environment-template", "database-setup"] as const),
        packageManager: Type.Optional(StringEnum(["npm", "pnpm", "yarn", "bun"] as const)),
        mode: Type.Optional(StringEnum(["frozen", "regular"] as const)),
        source: Type.Optional(Type.String({ minLength: 1 })),
        destination: Type.Optional(Type.String({ minLength: 1 })),
        script: Type.Optional(Type.String({ minLength: 1 })),
        environment: Type.Optional(StringEnum(["development", "test"] as const)),
        purpose: Type.String({ minLength: 1 }),
      }),
    ),
  }),
  resources: Type.Array(
    Type.Object({
      kind: StringEnum(["dependencies", "environment", "database", "port", "external"] as const),
      description: Type.String({ minLength: 1 }),
      isolation: StringEnum(["isolated", "shared-safe", "serial-only", "unknown", "unsafe"] as const),
    }),
  ),
  ambiguities: Type.Array(Type.String({ minLength: 1 })),
});

const SUBMIT_SCHEMA = Type.Object({
  preparationId: Type.String({ minLength: 1 }),
  proposal: PROPOSAL_SCHEMA,
});
type SubmitInput = Static<typeof SUBMIT_SCHEMA>;

const ACCEPT_CANDIDATE_SCHEMA = Type.Object({
  attemptId: Type.String({ minLength: 1 }),
  candidateDigest: Type.String({ pattern: "^[a-fA-F0-9]{64}$" }),
});
type AcceptCandidateInput = Static<typeof ACCEPT_CANDIDATE_SCHEMA>;
const PREPARATION_ID_SCHEMA = Type.Object({ preparationId: Type.String({ minLength: 1 }) });
type PreparationIdInput = Static<typeof PREPARATION_ID_SCHEMA>;
const APPROVE_SCHEMA = Type.Object({
  preparationId: Type.String({ minLength: 1 }),
  evidence: Type.Array(SOURCE_EVIDENCE_SCHEMA, { minItems: 1 }),
});
type ApproveInput = Static<typeof APPROVE_SCHEMA>;

async function commandOutput(pi: ExtensionAPI, command: string, args: string[], cwd?: string): Promise<string | undefined> {
  try {
    const result = await pi.exec(command, args, { ...(cwd ? { cwd } : {}), timeout: 10_000 });
    return result.code === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function safeProjectIdentity(remote: string | undefined, root: string): string {
  if (!remote) return basename(root);
  try {
    const url = new URL(remote);
    return `${url.hostname}${url.pathname}`.replace(/\.git$/, "").replace(/^\/+/, "");
  } catch {
    const scp = remote.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
    if (scp) return `${scp[1]}/${scp[2]}`.replace(/\.git$/, "");
    return basename(root);
  }
}

interface GitContext {
  root: string;
  head: string;
  branch: string;
  projectIdentity: string;
  statePath: string;
}

async function gitContext(pi: ExtensionAPI, cwd: string): Promise<GitContext> {
  const root = await commandOutput(pi, "git", ["rev-parse", "--show-toplevel"], cwd);
  if (!root) throw new Error("Preparation requires a Git repository");
  const [head, branch, commonDir, remote] = await Promise.all([
    commandOutput(pi, "git", ["rev-parse", "HEAD"], root),
    commandOutput(pi, "git", ["branch", "--show-current"], root),
    commandOutput(pi, "git", ["rev-parse", "--git-common-dir"], root),
    commandOutput(pi, "git", ["remote", "get-url", "origin"], root),
  ]);
  if (!head || !branch || !commonDir) throw new Error("Git HEAD, branch, and common directory must be resolvable");
  const absoluteCommonDir = isAbsolute(commonDir) ? commonDir : resolve(root, commonDir);
  return {
    root,
    head,
    branch,
    projectIdentity: safeProjectIdentity(remote, root),
    statePath: join(absoluteCommonDir, "herdr", "controller-state.json"),
  };
}

function capturedModel(pi: ExtensionAPI, ctx: ExtensionContext): CapturedModel {
  if (!ctx.model) throw new Error("No Pi model is selected");
  return {
    provider: ctx.model.provider,
    id: ctx.model.id,
    thinkingLevel: pi.getThinkingLevel(),
    contextWindow: ctx.model.contextWindow,
  };
}

async function inspectAdmission(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  dependencies: HerdrExtensionDependencies,
): Promise<{ controller: ControllerClient; snapshot: AdmissionSnapshot }> {
  const git = await gitContext(pi, ctx.cwd);
  const model = capturedModel(pi, ctx);
  const [piVersion, herdrVersion, auth] = await Promise.all([
    commandOutput(pi, "pi", ["--version"], git.root),
    commandOutput(pi, "herdr", ["--version"], git.root),
    ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!),
  ]);
  const available = ctx.modelRegistry
    .getAvailable()
    .some((item): boolean => item.provider === model.provider && item.id === model.id);
  const instructionFiles = (ctx.getSystemPromptOptions().contextFiles ?? []).map((file): string => file.path);
  const snapshot: AdmissionSnapshot = {
    project: {
      root: git.root,
      identity: git.projectIdentity,
      head: git.head,
      branch: git.branch,
      instructionFiles,
    },
    runtime: {
      platform: process.platform as "linux" | "darwin",
      ...(piVersion ? { piVersion } : {}),
      ...(herdrVersion ? { herdrVersion } : {}),
      projectTrusted: ctx.isProjectTrusted(),
      skillCommands: pi.getCommands().filter((command): boolean => command.source === "skill").map((command): string => command.name),
      toolNames: pi.getActiveTools(),
    },
    model: {
      ...model,
      authenticated: auth.ok,
      available,
    },
  };
  return { controller: await dependencies.connectController(git.statePath), snapshot };
}

export interface HerdrExtensionDependencies {
  connectController: (statePath: string) => Promise<ControllerClient>;
  workspaceId: () => string | undefined;
}

const DEFAULT_EXTENSION_DEPENDENCIES: HerdrExtensionDependencies = {
  connectController: connectOrStartLocalController,
  workspaceId: (): string | undefined => process.env.HERDR_WORKSPACE_ID,
};

async function controllerFor(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  dependencies: HerdrExtensionDependencies,
): Promise<ControllerClient> {
  const git = await gitContext(pi, ctx.cwd);
  return dependencies.connectController(git.statePath);
}

function attemptSummary(attempt: ExecutionAttempt, status: ControllerStatus): string[] {
  const preparation = status.preparations.find((record): boolean => record.id === attempt.preparationId);
  const ticket = preparation?.proposal?.tickets.find((item): boolean => item.identity === attempt.ticketIdentity);
  const batch = preparation?.controllerName ?? attempt.preparationId;
  const ticketLabel = ticket ? `${ticket.title} (${ticket.identity})` : attempt.ticketIdentity;
  const lines = [`${attempt.id} ${attempt.lifecycle} ${ticketLabel} · batch ${batch}`];
  if (attempt.worktree) lines.push(`  worktree ${attempt.worktree.path} (${attempt.worktree.branch} @ ${attempt.worktree.head.slice(0, 12)})`);
  if (attempt.worker) {
    lines.push(`  worker ${attempt.worker.agentName} workspace=${attempt.worker.workspaceId} tab=${attempt.worker.tabId} pane=${attempt.worker.paneId} pid=${attempt.worker.piPid}`);
    lines.push(`  session ${attempt.worker.sessionId} ${attempt.worker.sessionFile}`);
  } else if (attempt.workerAllocation) {
    lines.push(`  allocation ${attempt.workerAllocation.agentName} workspace=${attempt.workerAllocation.workspaceId} tab=${attempt.workerAllocation.tabId} pane=${attempt.workerAllocation.paneId}`);
  }
  for (const decision of attempt.decisions.filter((item): boolean => item.state !== "delivered")) {
    lines.push(`  decision ${decision.id} ${decision.state}: ${decision.question}`);
    lines.push(`    context: ${decision.context}`);
    if (decision.options.length > 0) lines.push(`    options: ${decision.options.join(" | ")}`);
    lines.push(`    recommendation: ${decision.recommendation}`);
  }
  for (const reference of attempt.artifactReferences) lines.push(`  artifact ${reference}`);
  for (const receipt of attempt.candidateReceipts ?? []) {
    lines.push(`  candidate ${receipt.id} ${receipt.state} ${receipt.candidate.candidateDigest.slice(0, 12)}`);
    if (receipt.integration?.integratedCommit) lines.push(`    integrated ${receipt.integration.integratedCommit}`);
    for (const finding of receipt.findings) lines.push(`    finding ${finding}`);
  }
  for (const diagnostic of attempt.diagnostics) lines.push(`  attention ${diagnostic}`);
  return lines;
}

function renderControllerStatus(ctx: ExtensionContext, status: ControllerStatus): void {
  const preparationLines = status.preparations.map(
    (record): string => `${record.id} ${record.stage} ${record.controllerName}${record.proposalDigest ? ` ${record.proposalDigest.slice(0, 12)}` : ""}`,
  );
  const attemptLines = status.executionAttempts.flatMap((attempt): string[] => attemptSummary(attempt, status));
  const lines = [
    ...(preparationLines.length > 0 ? ["Preparations", ...preparationLines] : []),
    ...(attemptLines.length > 0 ? ["Attempts", ...attemptLines] : []),
    ...(status.hasMore ? ["More records are available through the paginated controller client."] : []),
  ];
  if (lines.length === 0) lines.push("No Herdr preparations or attempts in this repository");
  const activeCount = status.executionAttempts.filter(
    (attempt): boolean => isActiveExecutionLifecycle(attempt.lifecycle),
  ).length;
  const decisionCount = status.executionAttempts.reduce(
    (count, attempt): number => count + attempt.decisions.filter((decision): boolean => decision.state !== "delivered").length,
    0,
  );
  ctx.ui.setStatus("herdr-controller", `${activeCount} active · ${decisionCount} pending decision${decisionCount === 1 ? "" : "s"}`);
  ctx.ui.setWidget("herdr-controller", lines);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function refreshControllerStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  dependencies: HerdrExtensionDependencies,
): Promise<void> {
  const status = unwrapResult(await (await controllerFor(pi, ctx, dependencies)).status({ limit: 50 }));
  renderControllerStatus(ctx, status);
}

async function allControllerStatus(controller: ControllerClient): Promise<ControllerStatus> {
  const preparations: ControllerStatus["preparations"] = [];
  const executionAttempts: ControllerStatus["executionAttempts"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 2; page += 1) {
    const status = unwrapResult(await controller.status({ limit: 50, ...(cursor ? { cursor } : {}) }));
    preparations.push(...status.preparations);
    executionAttempts.push(...status.executionAttempts);
    if (!status.hasMore) return { preparations, executionAttempts, nextCursor: null, hasMore: false };
    if (!status.nextCursor || status.nextCursor === cursor) throw new Error("Controller status pagination did not advance");
    cursor = status.nextCursor;
  }
  throw new Error("Controller status exceeds its documented bounded capacity");
}

function commandArguments(args: string, count: number): string[] | undefined {
  const values = args.trim().split(/\s+/, count + 1);
  return values.length === count && values.every((value): boolean => value.length > 0) ? values : undefined;
}

function answerArguments(args: string): [string, string, string] | undefined {
  const match = args.trim().match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
  return match ? [match[1]!, match[2]!, match[3]!.trim()] : undefined;
}

function registerAttemptControl(
  pi: ExtensionAPI,
  dependencies: HerdrExtensionDependencies,
  name: string,
  description: string,
  operation: (controller: ControllerClient, attemptId: string) => Promise<ControllerResult<ExecutionAttempt>>,
  after?: (ctx: ExtensionContext, attempt: ExecutionAttempt) => void,
): void {
  pi.registerCommand(name, {
    description,
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        const values = commandArguments(args, 1);
        if (!values) throw new Error(`Usage: /${name} <attempt-id>`);
        const controller = await controllerFor(pi, ctx, dependencies);
        const changed = unwrapResult(await operation(controller, values[0]!));
        renderControllerStatus(ctx, {
          preparations: [],
          executionAttempts: [changed],
          nextCursor: null,
          hasMore: false,
        });
        after?.(ctx, changed);
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });
}

function preparationPrompt(preparationId: string, specReference: string, instructionFiles: string[]): string {
  return [
    "Prepare a Herdr ticket batch; do not implement any ticket.",
    `Preparation ID: ${preparationId}`,
    `Selected spec: ${specReference}`,
    `Loaded project instruction chain: ${instructionFiles.join(", ")}`,
    "Read the loaded project instructions completely, then follow their configured tracker instructions as human-readable prose.",
    "Using the project's configured tracker tools, retrieve the selected spec and every relevant ticket with comments, relationships, dependency evidence, and existing claims. Set claimedBy for every ticket to the readable claimant when claimed, or explicitly to null only after verifying no claim exists; never omit claim status. Do not assume GitHub or this extension repository's tracker.",
    "Read the project's coding standards, when present, to propose optional check commands and source/version evidence.",
    "Resolve no ambiguity by guessing. Record ambiguity in the proposal so deterministic validation blocks it.",
    "Plan safe reusable worktree setup and isolation for dependencies, environments, databases, ports, and external resources. Setup operations may be constrained dependency installs or copies from explicit public template files. Automated database scripts are not approvable in this slice: use an already isolated nonproduction database resource or record an ambiguity requiring clarification. Never propose blanket secret copying or production migrations.",
    "Use the captured model and thinking level, the current Git target/base, two workers by default, a ~190000-token handoff with required reserve, two handoff replacements, two repair cycles, required standards/spec reviews, and preserved implementation-skill testing.",
    "Create one unique source-evidence registry. For every source, include its tracker version, a SHA-256 digest of the retrieved requirement/comment content, retrieval timestamp, and canonical references; fields may reference one registry identity more than once but must not duplicate evidence records. Call herdr_submit_batch_proposal exactly once with that structured evidence. Do not call /skill:implement, start Herdr workers, mutate the tracker, or alter the parent spec.",
  ].join("\n\n");
}

function acceptancePrompt(receipt: CandidateReceipt): string {
  return [
    "Assess the native implementation-skill evidence for this already captured candidate; do not edit code or mutate the tracker.",
    `Attempt: ${receipt.attemptId}`,
    `Ticket: ${receipt.ticketIdentity}`,
    `Candidate receipt digest captured from actual Git state: ${receipt.candidate.candidateDigest}`,
    `Git code-state digest (stable across content-equivalent commits): ${receipt.candidate.codeStateDigest}`,
    `Source base: ${receipt.candidate.sourceBase}`,
    `Worker saved session: ${receipt.sessionId} at ${receipt.sessionFile}`,
    `Existing evidence references: ${receipt.evidenceReferences.join(", ") || "none"}`,
    "Use only evidence generated by the live worker bridge from actual ordinary implementation-skill executions. Do not write receipt files yourself or turn a completion sentence, prompt submission, idle status, or worker-reported hash into evidence.",
    "The worker bridge automatically captured its execution-backed tests and structured no-blocker foreground review at the settled worker lifecycle boundary. This dashboard session must not create or replace that worker-owned evidence index.",
    "Call herdr_accept_candidate exactly once with only the attempt ID and candidate digest. The tool independently resolves and validates the exact worker-owned evidence index for the captured worker session and rejects missing, stale, failed, ambiguous, or code-state-mismatched records.",
    "The controller will independently execute approved checks and separate fresh Standards and Spec reviews in isolated integration staging before advancing the batch branch. It will not close tracker issues.",
  ].join("\n\n");
}

function approvalPrompt(preparationId: string): string {
  return [
    `Revalidate preparation ${preparationId} for explicit approval; do not implement any ticket.`,
    "First call herdr_get_preparation with the preparation ID to read the frozen proposal. Then re-fetch every approved spec, ticket, external prerequisite, project/tracker instruction, and coding-standards source using the project's configured tracker instructions and normal tools.",
    "Recompute content digests and submit the canonical source references with a fresh retrieval timestamp. If a source changed, a ticket appeared, scope or requirements changed, or an approved check changed, include the current exact evidence; stale validation must require a renewed proposal.",
    "Call herdr_approve_batch once with the exact current evidence set. The controller will show the frozen preview and request durable human confirmation.",
    "Do not mutate a tracker, start a worker, or call an implementation skill.",
  ].join("\n\n");
}

function unwrapResult<T>(result: ControllerResult<T>): T {
  if (!result.ok) throw new Error(result.error.diagnostics.join("\n"));
  return result.value;
}

function diagnosticsFor(error: unknown): string[] {
  return error && typeof error === "object" && "diagnostics" in error
    ? (error as { diagnostics: string[] }).diagnostics
    : [error instanceof Error ? error.message : String(error)];
}

function reportError(ctx: ExtensionContext, error: unknown): void {
  ctx.ui.notify(diagnosticsFor(error).join("\n"), "error");
}

export function registerHerdrExtension(
  pi: ExtensionAPI,
  dependencies: HerdrExtensionDependencies = DEFAULT_EXTENSION_DEPENDENCIES,
): void {
  pi.registerCommand("herdr-prepare", {
    description: "Prepare a selected spec as a validated durable Herdr batch",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        if (!ctx.hasUI) throw new Error("Preparation requires an interactive Pi or RPC UI");
        const specReference = args.trim();
        if (!specReference) throw new Error("Usage: /herdr-prepare <configured-tracker-spec-reference>");
        const inspected = await inspectAdmission(pi, ctx, dependencies);
        const suggestedName = `${inspected.snapshot.project.identity} / ${specReference}`;
        const controllerName = await ctx.ui.input("Controller name", suggestedName);
        if (!controllerName) return;
        const record = unwrapResult(
          await inspected.controller.prepare(
            { specReference, controllerName },
            inspected.snapshot,
          ),
        );
        await pi.sendUserMessage(
          preparationPrompt(record.id, specReference, inspected.snapshot.project.instructionFiles),
        );
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });

  pi.registerCommand("herdr-approve", {
    description: "Revalidate and explicitly approve a prepared Herdr batch",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const preparationId = args.trim();
      if (!preparationId) {
        ctx.ui.notify("Usage: /herdr-approve <preparation-id>", "error");
        return;
      }
      await pi.sendUserMessage(approvalPrompt(preparationId));
    },
  });

  pi.registerCommand("herdr-accept", {
    description: "Capture a settled candidate and start evidence-bound acceptance reasoning",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        const values = commandArguments(args, 1);
        if (!values) throw new Error("Usage: /herdr-accept <attempt-id>");
        const controller = await controllerFor(pi, ctx, dependencies);
        const receipt = unwrapResult(await controller.captureCandidate({ attemptId: values[0]! }));
        await pi.sendUserMessage(acceptancePrompt(receipt));
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });

  pi.registerCommand("herdr-start", {
    description: "Start one ticket from an approved Herdr batch",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        const values = commandArguments(args, 2);
        if (!values) throw new Error("Usage: /herdr-start <preparation-id> <ticket-identity>");
        const workspaceId = dependencies.workspaceId()?.trim();
        if (!workspaceId) throw new Error("HERDR_WORKSPACE_ID is required to start a ticket from this Pi session");
        const controller = await controllerFor(pi, ctx, dependencies);
        const started = unwrapResult(await controller.startTicket({
          preparationId: values[0]!,
          ticketIdentity: values[1]!,
          workspaceId,
        }));
        renderControllerStatus(ctx, {
          preparations: [],
          executionAttempts: [started],
          nextCursor: null,
          hasMore: false,
        });
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });

  registerAttemptControl(
    pi,
    dependencies,
    "herdr-attach",
    "Focus and show how to attach to the exact owned worker",
    (controller, attemptId) => controller.attachAttempt({ attemptId }),
    (ctx, changed): void => {
      if (changed.worker) {
        ctx.ui.notify(`Focused the owned worker. Attach from another terminal with: herdr agent attach ${changed.worker.agentName}`, "info");
      }
    },
  );
  registerAttemptControl(
    pi,
    dependencies,
    "herdr-pause",
    "Pause controller automation for one attempt",
    (controller, attemptId) => controller.pauseAttempt({ attemptId }),
  );
  registerAttemptControl(
    pi,
    dependencies,
    "herdr-resume",
    "Explicitly resume a paused or restart-required attempt",
    (controller, attemptId) => controller.resumeAttempt({ attemptId }),
  );
  registerAttemptControl(
    pi,
    dependencies,
    "herdr-takeover",
    "Pause automation and focus an owned worker for human takeover",
    (controller, attemptId) => controller.takeOverAttempt({ attemptId }),
    (ctx, changed): void => {
      if (changed.worker) {
        ctx.ui.notify(`Automation is paused. Attach interactively with: herdr agent attach ${changed.worker.agentName} --takeover`, "info");
      }
    },
  );
  registerAttemptControl(
    pi,
    dependencies,
    "herdr-return",
    "Return a takeover attempt to controller automation",
    (controller, attemptId) => controller.returnAttempt({ attemptId }),
  );

  pi.registerCommand("herdr-questions", {
    description: "Show pending local decisions, context, options, and recommendations",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        const attemptId = args.trim();
        if (attemptId.includes(" ")) throw new Error("Usage: /herdr-questions [attempt-id]");
        const status = await allControllerStatus(await controllerFor(pi, ctx, dependencies));
        const attempts = attemptId
          ? status.executionAttempts.filter((attempt): boolean => attempt.id === attemptId)
          : status.executionAttempts;
        if (attemptId && attempts.length === 0) throw new Error(`Unknown execution attempt: ${attemptId}`);
        const pending = attempts.filter((attempt): boolean => attempt.decisions.some((decision): boolean => decision.state !== "delivered"));
        if (pending.length === 0) {
          ctx.ui.notify("No pending local decisions", "info");
          return;
        }
        renderControllerStatus(ctx, { ...status, preparations: [], executionAttempts: pending, hasMore: false, nextCursor: null });
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });

  pi.registerCommand("herdr-answer", {
    description: "Durably answer one pending local decision",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        if (!ctx.hasUI) throw new Error("Answering a local decision requires an interactive Pi or RPC UI");
        const values = answerArguments(args);
        if (!values) throw new Error("Usage: /herdr-answer <attempt-id> <decision-id> <answer>");
        const answeredBy = await ctx.ui.input("Record answer author", "local developer");
        if (!answeredBy?.trim()) return;
        const controller = await controllerFor(pi, ctx, dependencies);
        const answered = unwrapResult(await controller.answerDecision({
          attemptId: values[0],
          decisionId: values[1],
          answer: values[2],
          answeredBy: answeredBy.trim(),
        }));
        renderControllerStatus(ctx, {
          preparations: [],
          executionAttempts: [answered],
          nextCursor: null,
          hasMore: false,
        });
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });

  pi.registerCommand("herdr-status", {
    description: "Show durable Herdr preparation, attempt, session, and decision status",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        await refreshControllerStatus(pi, ctx, dependencies);
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });

  pi.registerTool({
    name: "herdr_accept_candidate",
    label: "Accept Herdr Candidate",
    description: "Submit candidate-bound evidence from the native implementation skill. The daemon independently stages, checks, reviews, and integrates the exact captured candidate; failures leave the accepted batch branch unchanged.",
    parameters: ACCEPT_CANDIDATE_SCHEMA,
    async execute(
      _toolCallId: string,
      params: AcceptCandidateInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const git = await gitContext(pi, ctx.cwd);
      const controller = await dependencies.connectController(git.statePath);
      const controllerStatus = unwrapResult(await controller.status({ limit: 50 }));
      const attempt = controllerStatus.executionAttempts.find((item): boolean => item.id === params.attemptId);
      const captured = attempt?.candidateReceipts?.find((receipt): boolean =>
        receipt.candidate.candidateDigest === params.candidateDigest);
      if (!attempt?.worker || !captured) throw new Error("Captured candidate or its exact worker identity is unavailable");
      const bridge = new FileWorkerBridgeTransport(localDaemonPaths(git.statePath).workerBridgeDirectory);
      const channel = await bridge.channelForAgent(attempt.worker.agentName);
      const nativeEvidence = await readProducedNativeEvidence(
        join(dirname(channel.endpoint), "native-evidence", "latest.json"),
        { sessionId: attempt.worker.sessionId, codeStateDigest: captured.candidate.codeStateDigest },
      );
      const command: AcceptCandidateRequest = mapAcceptCandidateCommand({ ...params, nativeEvidence });
      const accepted = unwrapResult(await controller.acceptCandidate(command));
      const status: ControllerStatus = { preparations: [], executionAttempts: [accepted], nextCursor: null, hasMore: false };
      renderControllerStatus(ctx, status);
      return {
        content: [{ type: "text", text: accepted.lifecycle === "accepted"
          ? `Accepted ${accepted.ticketIdentity} as ${accepted.acceptedCommit}. Tracker issues remain unchanged.`
          : `Candidate is ${accepted.lifecycle}; inspect its retained findings and evidence.` }],
        details: { attemptId: accepted.id, lifecycle: accepted.lifecycle, acceptedCommit: accepted.acceptedCommit },
      };
    },
  });

  pi.registerTool({
    name: "herdr_get_preparation",
    label: "Get Herdr Preparation",
    description: "Read one durable preparation so a reasoning session can inspect and revalidate its frozen proposal. Credentials and transcripts are never stored here.",
    parameters: PREPARATION_ID_SCHEMA,
    async execute(
      _toolCallId: string,
      params: PreparationIdInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const record = unwrapResult(
        await (await controllerFor(pi, ctx, dependencies)).getPreparation(params.preparationId),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
        details: { preparationId: record.id, stage: record.stage },
      };
    },
  });

  pi.registerTool({
    name: "herdr_submit_batch_proposal",
    label: "Submit Herdr Batch Proposal",
    description: "Submit the selected spec's complete structured batch proposal for deterministic validation and durable preview. This never starts workers or mutates a tracker.",
    parameters: SUBMIT_SCHEMA,
    async execute(
      _toolCallId: string,
      params: SubmitInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const controller = await controllerFor(pi, ctx, dependencies);
      const record = unwrapResult(
        await controller.submitProposal(
          params.preparationId,
          params.proposal as unknown as BatchProposal,
        ),
      );
      const text = unwrapResult(await controller.preview(record.id));
      ctx.ui.notify(text, "info");
      return { content: [{ type: "text", text }], details: { preparationId: record.id, proposalDigest: record.proposalDigest } };
    },
  });

  pi.registerTool({
    name: "herdr_approve_batch",
    label: "Approve Herdr Batch",
    description: "Validate freshly retrieved source versions, content digests, canonical references, and retrieval ordering; show the frozen preview; ask the human for explicit approval; and durably record it. This never starts workers.",
    parameters: APPROVE_SCHEMA,
    async execute(
      _toolCallId: string,
      params: ApproveInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      if (!ctx.hasUI) throw new Error("Batch approval requires an interactive Pi or RPC UI");
      const controller = await controllerFor(pi, ctx, dependencies);
      const proposed = unwrapResult(
        await controller.getPreparation(params.preparationId),
      );
      if (!proposed.proposal || !proposed.proposalDigest) throw new Error("Preparation has no proposal to approve");
      const proposalDigest = proposed.proposalDigest;
      const approvedBy = await ctx.ui.input("Record approval author", "local developer");
      if (!approvedBy) {
        return { content: [{ type: "text", text: "Approval cancelled; an author is required." }], details: {} };
      }
      const git = await gitContext(pi, ctx.cwd);
      const request: ApprovalRequest = {
        approvedBy,
        proposalDigest,
        projectHead: git.head,
        model: capturedModel(pi, ctx),
        evidence: params.evidence,
      };
      const validated = unwrapResult(
        await controller.validateApproval(params.preparationId, request),
      );
      const text = formatPreparationPreview(validated);
      const confirmed = await ctx.ui.confirm("Approve this exact Herdr batch?", text);
      if (!confirmed) {
        return { content: [{ type: "text", text: "Approval cancelled; the proposal remains unapproved." }], details: {} };
      }
      const approved = unwrapResult(
        await controller.approve(params.preparationId, request),
      );
      const result = `Approved ${approved.controllerName} at ${approved.approved?.approvedAt}; proposal ${approved.proposalDigest}. No worker was started.`;
      return { content: [{ type: "text", text: result }], details: { preparationId: approved.id, proposalDigest: approved.proposalDigest } };
    },
  });
}

export default function herdrPreparationExtension(pi: ExtensionAPI): void {
  registerHerdrExtension(pi);
}
