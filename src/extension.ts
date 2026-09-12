import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";

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
  PreparationController,
  type AdmissionSnapshot,
  type ApprovalRequest,
  type BatchProposal,
  type CapturedModel,
  type ControllerResult,
} from "./controller.js";
import { JsonControllerStateStore } from "./state-store.js";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const sourceEvidenceSchema = Type.Object({
  identity: Type.String({ minLength: 1 }),
  revision: Type.String({ minLength: 1 }),
  contentDigest: Type.String({ pattern: "^[a-fA-F0-9]{64}$" }),
  retrievedAt: Type.String({ minLength: 1 }),
  references: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});
const modelSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  thinkingLevel: StringEnum(thinkingLevels),
  contextWindow: Type.Integer({ minimum: 40_000 }),
});
const proposalSchema = Type.Object({
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
  sourceEvidence: Type.Array(sourceEvidenceSchema, { minItems: 1 }),
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
  model: modelSchema,
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

const submitSchema = Type.Object({
  preparationId: Type.String({ minLength: 1 }),
  proposal: proposalSchema,
});
type SubmitInput = Static<typeof submitSchema>;

const preparationIdSchema = Type.Object({ preparationId: Type.String({ minLength: 1 }) });
type PreparationIdInput = Static<typeof preparationIdSchema>;
const approveSchema = Type.Object({
  preparationId: Type.String({ minLength: 1 }),
  evidence: Type.Array(sourceEvidenceSchema, { minItems: 1 }),
});
type ApproveInput = Static<typeof approveSchema>;

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
): Promise<{ controller: PreparationController; snapshot: AdmissionSnapshot }> {
  const git = await gitContext(pi, ctx.cwd);
  const model = capturedModel(pi, ctx);
  const [piVersion, herdrVersion, auth] = await Promise.all([
    commandOutput(pi, "pi", ["--version"], git.root),
    commandOutput(pi, "herdr", ["--version"], git.root),
    ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!),
  ]);
  const available = ctx.modelRegistry
    .getAvailable()
    .some((item) => item.provider === model.provider && item.id === model.id);
  const instructionFiles = (ctx.getSystemPromptOptions().contextFiles ?? []).map((file) => file.path);
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
      skillCommands: pi.getCommands().filter((command) => command.source === "skill").map((command) => command.name),
      toolNames: pi.getActiveTools(),
    },
    model: {
      ...model,
      authenticated: auth.ok,
      available,
    },
  };
  return { controller: createController(git.statePath), snapshot };
}

function createController(statePath: string): PreparationController {
  return new PreparationController(new JsonControllerStateStore(statePath), {
    now: (): Date => new Date(),
    generateId: (): string => randomUUID(),
  });
}

async function controllerFor(pi: ExtensionAPI, ctx: ExtensionContext): Promise<PreparationController> {
  const git = await gitContext(pi, ctx.cwd);
  return createController(git.statePath);
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

export default function herdrPreparationExtension(pi: ExtensionAPI): void {
  pi.registerCommand("herdr-prepare", {
    description: "Prepare a selected spec as a validated durable Herdr batch",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        if (!ctx.hasUI) throw new Error("Preparation requires an interactive Pi or RPC UI");
        const specReference = args.trim();
        if (!specReference) throw new Error("Usage: /herdr-prepare <configured-tracker-spec-reference>");
        const inspected = await inspectAdmission(pi, ctx);
        const suggestedName = `${inspected.snapshot.project.identity} / ${specReference}`;
        const controllerName = await ctx.ui.input("Controller name", suggestedName);
        if (!controllerName) return;
        const record = unwrapResult(
          await inspected.controller.prepare({ specReference, controllerName }, inspected.snapshot),
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

  pi.registerCommand("herdr-status", {
    description: "Show durable Herdr preparation status",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        const status = unwrapResult(await (await controllerFor(pi, ctx)).status());
        if (status.preparations.length === 0) {
          ctx.ui.notify("No Herdr preparations in this repository", "info");
          return;
        }
        ctx.ui.notify(
          status.preparations
            .map((record) => `${record.id} ${record.stage} ${record.controllerName}${record.proposalDigest ? ` ${record.proposalDigest.slice(0, 12)}` : ""}`)
            .join("\n"),
          "info",
        );
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });

  pi.registerTool({
    name: "herdr_get_preparation",
    label: "Get Herdr Preparation",
    description: "Read one durable preparation so a reasoning session can inspect and revalidate its frozen proposal. Credentials and transcripts are never stored here.",
    parameters: preparationIdSchema,
    async execute(
      _toolCallId: string,
      params: PreparationIdInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const status = unwrapResult(await (await controllerFor(pi, ctx)).status());
      const record = status.preparations.find((item) => item.id === params.preparationId);
      if (!record) throw new Error("Unknown preparation ID");
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
    parameters: submitSchema,
    async execute(
      _toolCallId: string,
      params: SubmitInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const controller = await controllerFor(pi, ctx);
      const record = unwrapResult(
        await controller.submitProposal(params.preparationId, params.proposal as unknown as BatchProposal),
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
    parameters: approveSchema,
    async execute(
      _toolCallId: string,
      params: ApproveInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      if (!ctx.hasUI) throw new Error("Batch approval requires an interactive Pi or RPC UI");
      const controller = await controllerFor(pi, ctx);
      const status = unwrapResult(await controller.status());
      const proposed = status.preparations.find((item) => item.id === params.preparationId);
      if (!proposed?.proposal) throw new Error("Preparation has no proposal to approve");
      const approvedBy = await ctx.ui.input("Record approval author", "local developer");
      if (!approvedBy) {
        return { content: [{ type: "text", text: "Approval cancelled; an author is required." }], details: {} };
      }
      const git = await gitContext(pi, ctx.cwd);
      const request: ApprovalRequest = {
        approvedBy,
        projectHead: git.head,
        model: capturedModel(pi, ctx),
        evidence: params.evidence,
      };
      const validated = unwrapResult(await controller.validateApproval(params.preparationId, request));
      const text = unwrapResult(await controller.preview(validated.id));
      const confirmed = await ctx.ui.confirm("Approve this exact Herdr batch?", text);
      if (!confirmed) {
        return { content: [{ type: "text", text: "Approval cancelled; the proposal remains unapproved." }], details: {} };
      }
      const approved = unwrapResult(await controller.approve(params.preparationId, request));
      const result = `Approved ${approved.controllerName} at ${approved.approved?.approvedAt}; proposal ${approved.proposalDigest}. No worker was started.`;
      return { content: [{ type: "text", text: result }], details: { preparationId: approved.id, proposalDigest: approved.proposalDigest } };
    },
  });
}
