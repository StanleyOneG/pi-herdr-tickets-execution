import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createConnection } from "node:net";
import test, { afterEach } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  PreparationController,
  type AdmissionSnapshot,
  type ApprovalRequest,
  type BatchProposal,
  type ControllerResult,
  type ControllerState,
  type ExecutionAttempt,
  type PreparationRecord,
  type SetupRuntimePort,
  type SourceEvidence,
  type WorkerAllocation,
  type WorkerIdentity,
  type WorkerObservation,
  type WorkerRuntimePort,
} from "../src/controller.js";
import { RealGitWorktreeAdapter } from "../src/git-worktrees.js";
import {
  HerdrWorkerRuntime,
  type HerdrCommandExecutor,
  type HerdrCommandResult,
} from "../src/herdr-runtime.js";
import { registerHerdrExtension } from "../src/extension.js";
import { FileWorkerBridgeTransport } from "../src/file-worker-bridge.js";
import { LocalControllerDaemon, UnixControllerClient } from "../src/local-daemon.js";
import { digest } from "../src/policy.js";
import type {
  WorkerBridgeChannel,
  WorkerBridgeTransport,
  WorkerDecisionRequest,
  WorkerLifecycleReceipt,
  WorkerNativeVerificationReceipt,
  WorkerReadinessReceipt,
  WorkerReviewReceipt,
} from "../src/worker-bridge-protocol.js";
import { formatPreparationPreview } from "../src/presentation.js";
import { LocalSetupRuntime } from "../src/setup-runtime.js";
import { JsonControllerStateStore } from "../src/state-store.js";
import herdrWorkerBridge from "../src/worker-bridge.js";

interface TestRepository { root: string; statePath: string; head: string }

const roots = new Set<string>();
const actor = Symbol("execution test actor");

afterEach(async (): Promise<void> => {
  await Promise.all([...roots].map(async (root): Promise<void> => {
    await rm(root, { recursive: true, force: true });
    await rm(join(dirname(root), `.${basename(root)}-herdr-worktrees`), { recursive: true, force: true });
    roots.delete(root);
  }));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function rawControllerRequest(
  socketPath: string,
  request: { id: string; token: string; method: string; params: unknown[] },
): Promise<{ id: string; ok: boolean; error?: string }> {
  return new Promise((resolveRequest, reject): void => {
    const socket = createConnection(socketPath);
    let body = "";
    socket.setEncoding("utf8");
    socket.once("connect", (): void => { socket.write(`${JSON.stringify(request)}\n`); });
    socket.on("data", (chunk: string): void => { body += chunk; });
    socket.once("error", reject);
    socket.once("end", (): void => {
      try {
        resolveRequest(JSON.parse(body.trim()) as { id: string; ok: boolean; error?: string });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function repository(): Promise<TestRepository> {
  const root = await mkdtemp(join(tmpdir(), "herdr-execution-"));
  roots.add(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test User");
  await writeFile(join(root, "README.md"), "project\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "initial");
  return { root, statePath: join(root, ".git", "herdr", "controller-state.json"), head: git(root, "rev-parse", "HEAD") };
}

function evidence(identity: string, retrievedAt = "2026-09-12T12:00:00.000Z"): SourceEvidence {
  return {
    identity,
    revision: "v1",
    contentDigest: createHash("sha256").update(identity).digest("hex"),
    retrievedAt,
    references: [`https://tracker.invalid/${identity}`],
  };
}

function admission(repo: TestRepository): AdmissionSnapshot {
  return {
    project: { root: repo.root, identity: "example/project", head: repo.head, branch: "main", instructionFiles: [join(repo.root, "AGENTS.md")] },
    runtime: {
      platform: process.platform === "darwin" ? "darwin" : "linux",
      piVersion: "0.85.1", herdrVersion: "0.8.2", projectTrusted: true,
      skillCommands: ["skill:implement", "skill:tdd", "skill:code-review", "skill:handoff"],
      toolNames: ["read", "bash", "herdr_submit_batch_proposal", "herdr_get_preparation", "herdr_approve_batch"],
    },
    model: { provider: "test", id: "reasoner", thinkingLevel: "high", contextWindow: 220_000, authenticated: true, available: true },
  };
}

function proposal(repo: TestRepository, claimedBy: string | null = null): BatchProposal {
  return {
    schemaVersion: 1,
    controllerName: "example / issue 4",
    project: { identity: "example/project", tracker: { identity: "tracker", instructionSources: ["AGENTS.md"], instructionEvidenceIdentities: ["instructions"] } },
    sourceEvidence: [evidence("instructions"), evidence("spec"), evidence("ticket-4")],
    spec: { identity: "spec-2", title: "Execution", evidenceIdentity: "spec" },
    tickets: [{ identity: "ticket-4", title: "Controller", evidenceIdentity: "ticket-4", claimedBy }],
    dependencies: [],
    target: { branch: "main", baseCommit: repo.head },
    model: { provider: "test", id: "reasoner", thinkingLevel: "high", contextWindow: 220_000 },
    policy: {
      concurrency: 1,
      context: { requestedHandoffTokens: 190_000, reserveTokens: 22_000 },
      maxHandoffReplacements: 2, maxRepairCycles: 2,
      requiredReviews: ["standards", "spec"], implementationSkillTestingRequired: true,
      checks: [], setupOperations: [],
    },
    resources: [
      { kind: "dependencies", description: "isolated", isolation: "isolated" },
      { kind: "environment", description: "isolated", isolation: "isolated" },
      { kind: "database", description: "isolated", isolation: "isolated" },
      { kind: "port", description: "isolated", isolation: "isolated" },
      { kind: "external", description: "safe", isolation: "shared-safe" },
    ],
    ambiguities: [],
  };
}

class ControlledWorker implements WorkerRuntimePort {
  allocations = 0;
  beforeAllocate: (() => Promise<void>) | undefined;
  starts = 0;
  dispatches = 0;
  deliveries: string[] = [];
  inspections = 0;
  focuses = 0;
  status: WorkerObservation["status"] = "working";
  mismatch = false;
  missingSkill: string | undefined;
  failAt: "allocate" | "start" | "dispatch" | undefined;
  beforeStart: (() => Promise<void>) | undefined;
  mutateIdentity: ((identity: WorkerIdentity) => WorkerIdentity) | undefined;

  async allocate(input: Parameters<WorkerRuntimePort["allocate"]>[0]): Promise<WorkerAllocation> {
    this.allocations += 1;
    await this.beforeAllocate?.();
    if (this.failAt === "allocate") throw new Error("token=secret allocation failed");
    return { workspaceId: input.workspaceId, tabId: `tab-${this.allocations}`, paneId: `pane-${this.allocations}`, agentName: input.agentName };
  }

  async start(input: Parameters<WorkerRuntimePort["start"]>[0]): Promise<WorkerIdentity> {
    this.starts += 1;
    await this.beforeStart?.();
    if (this.failAt === "start") throw new Error("provider credential details");
    const identity: WorkerIdentity = {
      ...input.allocation,
      piPid: 4242,
      sessionId: `session-${input.allocation.tabId.slice("tab-".length)}`,
      sessionFile: `/saved/session-${input.allocation.tabId.slice("tab-".length)}.jsonl`,
      cwd: input.cwd,
      model: input.model,
      mode: "tui",
      initialHistoryEntries: 0,
      skillCommands: ["skill:implement", "skill:tdd", "skill:code-review", "skill:handoff"]
        .filter((skill): boolean => skill !== this.missingSkill),
      toolNames: ["read", "bash", "edit", "write", "subagent"],
      contextFiles: [join(input.cwd, "AGENTS.md")],
    };
    return this.mutateIdentity?.(identity) ?? identity;
  }

  async inspect(identity: WorkerIdentity): Promise<WorkerObservation> {
    this.inspections += 1;
    return { identity: this.mismatch ? { ...identity, paneId: "foreign-pane" } : identity, status: this.status, artifactReferences: [] };
  }

  async dispatchImplementation(identity: WorkerIdentity): Promise<WorkerObservation> {
    this.dispatches += 1;
    if (this.failAt === "dispatch") throw new Error("prompt timeout with secret");
    return { identity, status: this.status, artifactReferences: ["/evidence/turn-1.json"] };
  }

  async deliverDecision(identity: WorkerIdentity, _decisionId: string, answer: string): Promise<WorkerObservation> {
    this.deliveries.push(answer);
    return { identity, status: "working", artifactReferences: [] };
  }

  async focus(): Promise<void> { this.focuses += 1; }
}

function controller(
  repo: TestRepository,
  worker: WorkerRuntimePort,
  instanceId = "controller-1",
  ids = ["preparation-1", "attempt-1", "decision-1"],
  setup?: SetupRuntimePort,
): PreparationController {
  const pending = [...ids];
  return new PreparationController(new JsonControllerStateStore(repo.statePath), {
    actorCapability: actor,
    now: (): Date => new Date("2026-09-12T14:00:00.000Z"),
    generateId: (): string => pending.shift() ?? "fallback-id",
    formatPreview: (record: PreparationRecord): string => formatPreparationPreview(record),
    execution: {
      owner: { instanceId, pid: 111 },
      git: new RealGitWorktreeAdapter(),
      worker,
      ...(setup ? { setup } : {}),
    },
  });
}

function value<T>(result: ControllerResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.diagnostics.join("\n"));
  return result.value;
}

function monitoredObservation(attempt: ExecutionAttempt, observation: WorkerObservation): {
  attemptId: string;
  controlGeneration: number;
  observation: WorkerObservation;
} {
  return {
    attemptId: attempt.id,
    controlGeneration: attempt.controlGeneration ?? 0,
    observation,
  };
}

async function approved(repo: TestRepository, worker: WorkerRuntimePort, claimedBy: string | null = null): Promise<{ controller: PreparationController; preparationId: string }> {
  const instance = controller(repo, worker);
  const prepared = value(await instance.prepare(actor, { specReference: "spec-2", controllerName: "example / issue 4" }, admission(repo)));
  const proposed = value(await instance.submitProposal(actor, prepared.id, proposal(repo, claimedBy)));
  const approval: ApprovalRequest = {
    approvedBy: "developer",
    proposalDigest: proposed.proposalDigest!,
    projectHead: repo.head,
    model: proposal(repo, claimedBy).model,
    evidence: [evidence("instructions", "2026-09-12T13:00:00.000Z"), evidence("spec", "2026-09-12T13:00:00.000Z"), evidence("ticket-4", "2026-09-12T13:00:00.000Z")],
  };
  value(await instance.approve(actor, prepared.id, approval));
  return { controller: instance, preparationId: prepared.id };
}

async function start(repo: TestRepository, worker: WorkerRuntimePort): Promise<{ controller: PreparationController; attempt: ExecutionAttempt }> {
  const ready = await approved(repo, worker);
  return {
    controller: ready.controller,
    attempt: value(await ready.controller.startTicket(actor, { preparationId: ready.preparationId, ticketIdentity: "ticket-4", workspaceId: "workspace-1" })),
  };
}

test("approved ticket start creates and persists an exact real Git worktree identity", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const { controller: instance, attempt } = await start(repo, worker);

  assert.equal(attempt.lifecycle, "running");
  assert.equal(attempt.originalCheckout?.head, repo.head);
  assert.equal(attempt.originalCheckout?.branch, "main");
  assert.equal(attempt.worktree?.head, repo.head);
  assert.equal(git(attempt.worktree!.path, "branch", "--show-current"), attempt.worktree!.branch);
  assert.equal(worker.dispatches, 1);
  const status = value(await instance.status(actor, { limit: 10 }));
  assert.equal(status.executionAttempts[0]?.worker?.sessionId, "session-1");
});

test("real worktree identity preserves a valid checkout path ending in whitespace", async (): Promise<void> => {
  const parent = await mkdtemp(join(tmpdir(), "herdr-execution-parent-"));
  roots.add(parent);
  const root = join(parent, "repository ");
  await mkdir(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test User");
  await writeFile(join(root, "README.md"), "project\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "initial");
  const repo: TestRepository = {
    root,
    statePath: join(root, ".git", "herdr", "controller-state.json"),
    head: git(root, "rev-parse", "HEAD"),
  };
  const worker = new ControlledWorker();

  const { attempt } = await start(repo, worker);

  assert.equal(attempt.lifecycle, "running");
  assert.equal(attempt.originalCheckout?.root, root);
});

test("duplicate start after dashboard object replacement returns durable ownership without launching again", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const first = await start(repo, worker);
  const dashboardReplacement = controller(repo, worker, "controller-1", []);
  const duplicate = value(await dashboardReplacement.startTicket(actor, {
    preparationId: first.attempt.preparationId, ticketIdentity: first.attempt.ticketIdentity, workspaceId: "workspace-1",
  }));

  assert.equal(duplicate.id, first.attempt.id);
  assert.equal(worker.starts, 1);
  assert.equal(worker.dispatches, 1);

  const concurrentRepo = await repository();
  const concurrentWorker = new ControlledWorker();
  const ready = await approved(concurrentRepo, concurrentWorker);
  const [left, right] = await Promise.all([
    ready.controller.startTicket(actor, { preparationId: ready.preparationId, ticketIdentity: "ticket-4", workspaceId: "workspace-1" }),
    ready.controller.startTicket(actor, { preparationId: ready.preparationId, ticketIdentity: "ticket-4", workspaceId: "workspace-1" }),
  ]);
  assert.equal(value(left).id, value(right).id);
  assert.equal(concurrentWorker.starts, 1);
  assert.equal(concurrentWorker.dispatches, 1);
});

test("dashboard attach focuses only the durably owned worker without changing its lifecycle", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);

  const attached = value(await running.controller.attachAttempt(actor, { attemptId: running.attempt.id }));

  assert.equal(attached.lifecycle, "running");
  assert.equal(worker.focuses, 1);
});

test("same-status mutation of a pre-existing dirty file stops resume without changing user content", async (): Promise<void> => {
  const repo = await repository();
  await writeFile(join(repo.root, "README.md"), "pre-existing edit\n");
  const worker = new ControlledWorker();
  const { controller: instance, attempt } = await start(repo, worker);
  assert.equal(attempt.originalCheckout?.changedFiles[0]?.path, "README.md");
  value(await instance.pauseAttempt(actor, { attemptId: attempt.id }));
  await writeFile(join(repo.root, "README.md"), "later edit with the same porcelain status\n");

  const resumed = value(await instance.resumeAttempt(actor, { attemptId: attempt.id }));
  assert.equal(resumed.lifecycle, "needs-attention");
  assert.deepEqual(resumed.diagnostics, ["Original checkout changed after its execution baseline"]);
  assert.equal(await readFile(join(repo.root, "README.md"), "utf8"), "later edit with the same porcelain status\n");
});

test("mutation of a baseline untracked file is content-sensitive and preserves the file", async (): Promise<void> => {
  const repo = await repository();
  await writeFile(join(repo.root, "notes.txt"), "pre-existing notes\n");
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  assert.equal(running.attempt.originalCheckout?.untrackedFiles[0]?.path, "notes.txt");
  value(await running.controller.pauseAttempt(actor, { attemptId: running.attempt.id }));
  await writeFile(join(repo.root, "notes.txt"), "changed notes\n");

  const resumed = value(await running.controller.resumeAttempt(actor, { attemptId: running.attempt.id }));
  assert.equal(resumed.lifecycle, "needs-attention");
  assert.equal(await readFile(join(repo.root, "notes.txt"), "utf8"), "changed notes\n");
});

test("an unrepresentable checkout filename fails closed without changing the file", async (): Promise<void> => {
  const repo = await repository();
  const rawPath = Buffer.concat([Buffer.from(`${repo.root}/`, "utf8"), Buffer.from([0xff])]);
  await writeFile(rawPath, "pre-existing bytes\n");
  const worker = new ControlledWorker();
  const ready = await approved(repo, worker);

  const attempt = value(await ready.controller.startTicket(actor, {
    preparationId: ready.preparationId,
    ticketIdentity: "ticket-4",
    workspaceId: "workspace-1",
  }));

  assert.equal(attempt.lifecycle, "needs-attention");
  assert.equal(worker.allocations, 0);
  assert.equal(await readFile(rawPath, "utf8"), "pre-existing bytes\n");
});

test("a redirected worktree root fails closed before Git creates a branch or checkout", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const ready = await approved(repo, worker);
  const adapter = new RealGitWorktreeAdapter();
  const plan = adapter.planTicketWorktree({
    originalRoot: repo.root,
    preparationId: ready.preparationId,
    ticketIdentity: "ticket-4",
  });
  const redirectTarget = await mkdtemp(join(tmpdir(), "herdr-worktree-redirect-"));
  roots.add(redirectTarget);
  await symlink(redirectTarget, dirname(plan.path), "dir");

  const attempt = value(await ready.controller.startTicket(actor, {
    preparationId: ready.preparationId,
    ticketIdentity: "ticket-4",
    workspaceId: "workspace-1",
  }));

  assert.equal(attempt.lifecycle, "needs-attention");
  assert.equal(worker.allocations, 0);
  assert.deepEqual(await readdir(redirectTarget), []);
  assert.equal(git(repo.root, "branch", "--list", plan.branch), "");
});

test("a foreign tracker claim fails closed before creating Git or worker ownership", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const ready = await approved(repo, worker, "another developer");

  const result = await ready.controller.startTicket(actor, {
    preparationId: ready.preparationId, ticketIdentity: "ticket-4", workspaceId: "workspace-1",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.error.diagnostics, ["Ticket has a foreign tracker claim: ticket-4"]);
  assert.equal(worker.allocations, 0);
  assert.equal((await new JsonControllerStateStore(repo.statePath).load()).executionAttempts.length, 0);
});

test("approved setup is durably completed in the real worktree before worker allocation", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const calls: Array<{ cwd: string; kind: string }> = [];
  const setup: SetupRuntimePort = {
    async execute(input): Promise<{ outcomeDigest: string }> {
      calls.push({ cwd: input.cwd, kind: input.operation.kind });
      return { outcomeDigest: createHash("sha256").update("setup evidence").digest("hex") };
    },
  };
  const instance = controller(repo, worker, "controller-1", ["preparation-1", "attempt-1"], setup);
  const prepared = value(await instance.prepare(actor, { specReference: "spec-2", controllerName: "example / issue 4" }, admission(repo)));
  const withSetup = proposal(repo);
  withSetup.policy.setupOperations = [{ kind: "dependency-install", packageManager: "npm", mode: "frozen", purpose: "Install exact dependencies" }];
  const proposed = value(await instance.submitProposal(actor, prepared.id, withSetup));
  value(await instance.approve(actor, prepared.id, {
    approvedBy: "developer", proposalDigest: proposed.proposalDigest!, projectHead: repo.head, model: withSetup.model,
    evidence: withSetup.sourceEvidence.map((item): SourceEvidence => ({ ...item, retrievedAt: "2026-09-12T13:00:00.000Z" })),
  }));
  worker.beforeAllocate = async (): Promise<void> => {
    const state = await new JsonControllerStateStore(repo.statePath).load();
    assert.equal(state.executionAttempts[0]?.setupOperations?.[0]?.state, "completed");
  };

  const attempt = value(await instance.startTicket(actor, { preparationId: prepared.id, ticketIdentity: "ticket-4", workspaceId: "workspace-1" }));

  assert.equal(attempt.lifecycle, "running");
  assert.equal(attempt.setupOperations?.[0]?.state, "completed");
  assert.equal(calls[0]?.cwd, attempt.worktree?.path);
  assert.equal(calls[0]?.kind, "dependency-install");
});

test("approved environment template setup copies only inside the real ticket worktree", async (): Promise<void> => {
  const repo = await repository();
  await writeFile(join(repo.root, ".env.example"), "PUBLIC_MODE=test\n");
  git(repo.root, "add", ".env.example");
  git(repo.root, "commit", "-qm", "add public environment template");
  repo.head = git(repo.root, "rev-parse", "HEAD");
  const worker = new ControlledWorker();
  const instance = controller(repo, worker, "controller-1", ["preparation-1", "attempt-1"], new LocalSetupRuntime());
  const prepared = value(await instance.prepare(actor, { specReference: "spec-2", controllerName: "example / issue 4" }, admission(repo)));
  const withSetup = proposal(repo);
  withSetup.policy.setupOperations = [{ kind: "environment-template", source: ".env.example", destination: ".env", purpose: "Create isolated public test environment" }];
  const proposed = value(await instance.submitProposal(actor, prepared.id, withSetup));
  value(await instance.approve(actor, prepared.id, {
    approvedBy: "developer", proposalDigest: proposed.proposalDigest!, projectHead: repo.head, model: withSetup.model,
    evidence: withSetup.sourceEvidence.map((item): SourceEvidence => ({ ...item, retrievedAt: "2026-09-12T13:00:00.000Z" })),
  }));

  const attempt = value(await instance.startTicket(actor, { preparationId: prepared.id, ticketIdentity: "ticket-4", workspaceId: "workspace-1" }));

  assert.equal(attempt.setupOperations?.[0]?.state, "completed");
  assert.equal(await readFile(join(attempt.worktree!.path, ".env"), "utf8"), "PUBLIC_MODE=test\n");
  await assert.rejects(readFile(join(repo.root, ".env"), "utf8"), { code: "ENOENT" });
});

test("an idle sample before worker activity does not become completion", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  worker.status = "idle";
  const running = await start(repo, worker);

  const sampled = value(await running.controller.recordWorkerObservation(actor, monitoredObservation(
    running.attempt,
    { identity: running.attempt.worker!, status: "idle", artifactReferences: [] },
  )));

  assert.equal(running.attempt.lifecycle, "running");
  assert.equal(sampled.lifecycle, "running");
  assert.equal(sampled.workerActiveAt, undefined);
});

test("controller rejects a non-string worker decision identity before persistence", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  const malformedObservation = {
    identity: running.attempt.worker!,
    status: "blocked",
    artifactReferences: [],
    decision: {
      transportId: 7,
      question: "Choose?",
      context: "A local choice is required.",
      options: ["A"],
      recommendation: "A",
    },
  } as unknown as WorkerObservation;

  const observed = value(await running.controller.recordWorkerObservation(
    actor,
    monitoredObservation(running.attempt, malformedObservation),
  ));

  assert.equal(observed.lifecycle, "needs-attention");
  assert.deepEqual(observed.decisions, []);
  assert.equal(value(await running.controller.status(actor, { limit: 10 })).executionAttempts[0]?.lifecycle, "needs-attention");
});

test("worker allocation is durable before readiness and dispatch", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  worker.beforeStart = async (): Promise<void> => {
    const state = await new JsonControllerStateStore(repo.statePath).load();
    const durable = state.executionAttempts[0]!;
    assert.equal(durable.lifecycle, "starting");
    assert.equal(durable.workerAllocation?.paneId, "pane-1");
    assert.equal(durable.worker, undefined);
    assert.equal(worker.dispatches, 0);
  };

  const { attempt } = await start(repo, worker);
  assert.equal(attempt.lifecycle, "running");
});

test("missing Pi identity, TUI freshness, model, skill, tools, context, and timeouts become attention", async (): Promise<void> => {
  const scenarios: Array<(worker: ControlledWorker) => void> = [
    (worker): void => { worker.missingSkill = "skill:implement"; },
    (worker): void => { worker.missingSkill = "skill:handoff"; },
    (worker): void => { worker.failAt = "start"; },
    (worker): void => { worker.failAt = "dispatch"; },
    (worker): void => { worker.mutateIdentity = (identity): WorkerIdentity => ({ ...identity, sessionId: "" }); },
    (worker): void => { worker.mutateIdentity = (identity): WorkerIdentity => ({ ...identity, cwd: "/foreign" }); },
    (worker): void => { worker.mutateIdentity = (identity): WorkerIdentity => ({ ...identity, model: { ...identity.model, id: "other" } }); },
    (worker): void => { worker.mutateIdentity = (identity): WorkerIdentity => ({ ...identity, toolNames: ["read"] }); },
    (worker): void => { worker.mutateIdentity = (identity): WorkerIdentity => ({ ...identity, contextFiles: [] }); },
    (worker): void => {
      worker.mutateIdentity = (identity): WorkerIdentity => ({ ...identity, mode: "rpc", initialHistoryEntries: 1 } as unknown as WorkerIdentity);
    },
  ];
  for (const configure of scenarios) {
    const repo = await repository();
    const worker = new ControlledWorker();
    configure(worker);

    const { attempt } = await start(repo, worker);
    assert.equal(attempt.lifecycle, "needs-attention");
    assert.equal(attempt.diagnostics.some((diagnostic): boolean => /secret|credential|api.?key/i.test(diagnostic)), false);
  }
});

test("normal worker commits preserve approved base provenance during dashboard attach", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  await writeFile(join(running.attempt.worktree!.path, "worker.txt"), "candidate\n");
  git(running.attempt.worktree!.path, "add", "worker.txt");
  git(running.attempt.worktree!.path, "commit", "-qm", "implement candidate");
  const candidateHead = git(running.attempt.worktree!.path, "rev-parse", "HEAD");

  const attached = value(await running.controller.attachAttempt(actor, { attemptId: running.attempt.id }));

  assert.equal(attached.lifecycle, "running");
  assert.equal(attached.worktree?.head, repo.head);
  assert.equal(attached.candidateHead, candidateHead);
  assert.equal(worker.focuses, 1);
});

test("worktree branch and worker occupant mismatches fail closed before resumed automation", async (): Promise<void> => {
  const branchRepo = await repository();
  const branchWorker = new ControlledWorker();
  const branchRun = await start(branchRepo, branchWorker);
  value(await branchRun.controller.pauseAttempt(actor, { attemptId: branchRun.attempt.id }));
  git(branchRun.attempt.worktree!.path, "checkout", "-qb", "foreign-branch");
  const branchResult = value(await branchRun.controller.resumeAttempt(actor, { attemptId: branchRun.attempt.id }));
  assert.equal(branchResult.lifecycle, "needs-attention");
  assert.match(branchResult.diagnostics[0]!, /worktree path, branch, or common directory/);

  const workerRepo = await repository();
  const occupant = new ControlledWorker();
  const workerRun = await start(workerRepo, occupant);
  value(await workerRun.controller.pauseAttempt(actor, { attemptId: workerRun.attempt.id }));
  occupant.mismatch = true;
  const occupantResult = value(await workerRun.controller.resumeAttempt(actor, { attemptId: workerRun.attempt.id }));
  assert.equal(occupantResult.lifecycle, "needs-attention");
  assert.deepEqual(occupantResult.diagnostics, ["Worker occupant or saved Pi session changed"]);
});

test("dashboard disappearance is inert while explicit controller restart blocks execution until resume", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  const inspectionsBefore = worker.inspections;
  const replacementDashboard = controller(repo, worker, "controller-2", []);

  const observed = value(await replacementDashboard.status(actor, { limit: 10 }));
  assert.equal(observed.executionAttempts[0]?.lifecycle, "running");
  assert.equal(worker.inspections, inspectionsBefore);

  const restarted = value(await replacementDashboard.controllerRestarted(actor));
  assert.equal(restarted[0]?.lifecycle, "restart-required");
  assert.ok(restarted[0]!.controlGeneration! > (running.attempt.controlGeneration ?? 0));
  assert.equal(worker.inspections, inspectionsBefore);
  const resumed = value(await replacementDashboard.resumeAttempt(actor, { attemptId: running.attempt.id }));
  assert.equal(resumed.lifecycle, "running");
  assert.ok(resumed.controlGeneration! > restarted[0]!.controlGeneration!);
  assert.ok(worker.inspections > inspectionsBefore);

  value(await replacementDashboard.pauseAttempt(actor, { attemptId: running.attempt.id }));
  const restartedWhilePaused = controller(repo, worker, "controller-3", []);
  const pausedRestart = value(await restartedWhilePaused.controllerRestarted(actor));
  assert.equal(pausedRestart[0]?.lifecycle, "paused");
  assert.equal(value(await restartedWhilePaused.resumeAttempt(actor, { attemptId: running.attempt.id })).lifecycle, "running");
});

test("restart preserves an unacknowledged starting attempt's concurrency slot until exact reconciliation", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const instance = controller(repo, worker);
  const batch = proposal(repo);
  batch.sourceEvidence.push(evidence("ticket-5"));
  batch.tickets.push({ identity: "ticket-5", title: "Next ticket", evidenceIdentity: "ticket-5", claimedBy: null });
  const prepared = value(await instance.prepare(actor, { specReference: "spec-2", controllerName: "starting restart" }, admission(repo)));
  const proposed = value(await instance.submitProposal(actor, prepared.id, batch));
  value(await instance.approve(actor, prepared.id, {
    approvedBy: "developer",
    proposalDigest: proposed.proposalDigest!,
    projectHead: repo.head,
    model: batch.model,
    evidence: batch.sourceEvidence.map((item): SourceEvidence => ({ ...item, retrievedAt: "2026-09-12T13:00:00.000Z" })),
  }));
  const running = value(await instance.startTicket(actor, {
    preparationId: prepared.id, ticketIdentity: "ticket-4", workspaceId: "workspace-1",
  }));
  const interrupted = JSON.parse(await readFile(repo.statePath, "utf8")) as ControllerState;
  interrupted.executionAttempts[0]!.lifecycle = "starting";
  interrupted.executionAttempts[0]!.artifactReferences = [];
  await new JsonControllerStateStore(repo.statePath).save(interrupted);

  const replacement = controller(repo, worker, "controller-2", []);
  const restarted = value(await replacement.controllerRestarted(actor));
  assert.equal(restarted[0]?.lifecycle, "restart-required");
  assert.equal(restarted[0]?.suspendedFrom, "starting");

  const competing = await replacement.startTicket(actor, {
    preparationId: prepared.id, ticketIdentity: "ticket-5", workspaceId: "workspace-1",
  });
  assert.equal(competing.ok, false);
  if (!competing.ok) assert.match(competing.error.diagnostics.join("\n"), /concurrency limit/);

  const resumed = await replacement.resumeAttempt(actor, { attemptId: running.id });
  assert.equal(resumed.ok, false);
  const retained = value(await replacement.status(actor, { limit: 10 })).executionAttempts[0]!;
  assert.equal(retained.lifecycle, "restart-required");
  assert.equal(retained.suspendedFrom, "starting");
  assert.equal(worker.dispatches, 1);
});

test("takeover retains a durable local answer and delivers it only after explicit return", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  const blocked = value(await running.controller.recordWorkerObservation(actor, monitoredObservation(
    running.attempt,
    {
      identity: running.attempt.worker!, status: "blocked", artifactReferences: ["/evidence/question.json"],
      decision: {
        question: "Which compatible format should be used?",
        context: "The approved requirements permit either format.",
        options: ["A", "B"],
        recommendation: "Use A for compatibility.",
      },
    },
  )));
  assert.equal(blocked.lifecycle, "pending-decision");
  assert.ok(blocked.controlGeneration! > (running.attempt.controlGeneration ?? 0));
  const decision = blocked.decisions[0]!;
  const dashboard = value(await running.controller.status(actor, { limit: 10 }));
  assert.equal(dashboard.executionAttempts[0]?.decisions[0]?.question, "Which compatible format should be used?");
  assert.deepEqual(dashboard.executionAttempts[0]?.artifactReferences, ["/evidence/turn-1.json", "/evidence/question.json"]);

  const takeover = value(await running.controller.takeOverAttempt(actor, { attemptId: running.attempt.id }));
  assert.equal(takeover.lifecycle, "takeover");
  const manualObservation = value(await running.controller.recordWorkerObservation(actor, monitoredObservation(
    blocked,
    { identity: running.attempt.worker!, status: "done", artifactReferences: [] },
  )));
  assert.equal(manualObservation.lifecycle, "takeover");
  const answered = value(await running.controller.answerDecision(actor, {
    attemptId: running.attempt.id, decisionId: decision.id, answer: "A", answeredBy: "developer",
  }));
  assert.equal(answered.decisions[0]?.state, "answered");
  assert.ok(answered.controlGeneration! > takeover.controlGeneration!);
  assert.deepEqual(worker.deliveries, []);

  const returned = value(await running.controller.returnAttempt(actor, { attemptId: running.attempt.id }));
  assert.equal(returned.lifecycle, "running");
  assert.ok(returned.controlGeneration! > answered.controlGeneration!);
  assert.equal(returned.decisions[0]?.state, "delivered");
  assert.deepEqual(worker.deliveries, ["A"]);
});

test("pause retains an explicit answer and resume delivers it after ownership checks", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  const blocked = value(await running.controller.recordWorkerObservation(actor, monitoredObservation(
    running.attempt,
    {
      identity: running.attempt.worker!, status: "blocked", artifactReferences: [],
      decision: { question: "Choose?", context: "A local choice is required.", options: ["A"], recommendation: "A" },
    },
  )));
  value(await running.controller.pauseAttempt(actor, { attemptId: running.attempt.id }));
  const answered = value(await running.controller.answerDecision(actor, {
    attemptId: running.attempt.id, decisionId: blocked.decisions[0]!.id, answer: "A", answeredBy: "developer",
  }));
  assert.equal(answered.lifecycle, "paused");
  assert.deepEqual(worker.deliveries, []);

  const resumed = value(await running.controller.resumeAttempt(actor, { attemptId: running.attempt.id }));
  assert.equal(resumed.lifecycle, "running");
  assert.equal(resumed.decisions[0]?.state, "delivered");
  assert.deepEqual(worker.deliveries, ["A"]);
});

test("an original-checkout mutation stops completion observation and preserves the change", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  await writeFile(join(repo.root, "README.md"), "unexpected worker-side mutation\n");

  const observed = value(await running.controller.recordWorkerObservation(actor, monitoredObservation(
    running.attempt,
    {
      identity: running.attempt.worker!,
      status: "done",
      artifactReferences: ["/evidence/summary.txt"],
    },
  )));

  assert.equal(observed.lifecycle, "needs-attention");
  assert.deepEqual(observed.diagnostics, ["Original checkout changed after its execution baseline"]);
  assert.equal(await readFile(join(repo.root, "README.md"), "utf8"), "unexpected worker-side mutation\n");
});

test("idle, done, and completion text can only produce completed-unaccepted lifecycle", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  const completed = value(await running.controller.recordWorkerObservation(actor, monitoredObservation(
    running.attempt,
    {
      identity: running.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: ["/evidence/summary.txt"],
      completionText: "Everything is accepted and the issue can close.",
    },
  )));

  assert.equal(completed.lifecycle, "completed-unaccepted");
  const state = JSON.parse(await readFile(repo.statePath, "utf8")) as ControllerState;
  assert.equal(JSON.stringify(state).includes('"lifecycle": "accepted"'), false);
});

test("unaccepted in-batch prerequisites prevent a dependent ticket from starting", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const instance = controller(repo, worker);
  const prepared = value(await instance.prepare(
    actor,
    { specReference: "spec-2", controllerName: "example / issue 4" },
    admission(repo),
  ));
  const dependentProposal = proposal(repo);
  dependentProposal.sourceEvidence.push(evidence("ticket-5"));
  dependentProposal.tickets.push({
    identity: "ticket-5",
    title: "Dependent controller work",
    evidenceIdentity: "ticket-5",
    claimedBy: null,
  });
  dependentProposal.dependencies.push({
    ticketIdentity: "ticket-5",
    prerequisiteIdentity: "ticket-4",
    kind: "ticket",
    status: "in-batch",
  });
  const proposed = value(await instance.submitProposal(actor, prepared.id, dependentProposal));
  value(await instance.approve(actor, prepared.id, {
    approvedBy: "developer",
    proposalDigest: proposed.proposalDigest!,
    projectHead: repo.head,
    model: dependentProposal.model,
    evidence: dependentProposal.sourceEvidence.map((source): SourceEvidence => ({
      ...structuredClone(source),
      retrievedAt: "2026-09-12T13:00:00.000Z",
    })),
  }));

  const result = await instance.startTicket(actor, {
    preparationId: prepared.id,
    ticketIdentity: "ticket-5",
    workspaceId: "workspace-1",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error.diagnostics, ["Ticket is blocked by in-batch prerequisites: ticket-4"]);
  }
  assert.equal(worker.allocations, 0);
});

test("worker completion cannot hide an unresolved local decision", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  const blocked = value(await running.controller.recordWorkerObservation(actor, monitoredObservation(
    running.attempt,
    {
      identity: running.attempt.worker!,
      status: "blocked",
      artifactReferences: [],
      decision: {
        question: "Choose the compatible format?",
        context: "The worker cannot continue without a local choice.",
        options: ["A", "B"],
        recommendation: "A",
      },
    },
  )));

  const completed = value(await running.controller.recordWorkerObservation(actor, monitoredObservation(
    blocked,
    {
      identity: running.attempt.worker!,
      status: "done",
      settled: true,
      outstandingJobs: [],
      artifactReferences: ["/evidence/early-summary.txt"],
      completionText: "Done despite the unanswered question.",
    },
  )));

  assert.equal(blocked.lifecycle, "pending-decision");
  assert.equal(completed.lifecycle, "pending-decision");
  assert.equal(completed.decisions[0]?.state, "pending");
});

test("malformed nested durable execution identity and lifecycle fail closed through status", async (): Promise<void> => {
  const corruptions: Array<(state: ControllerState) => void> = [
    (state): void => { state.executionAttempts[0]!.worker!.sessionId = ""; },
    (state): void => { state.executionAttempts[0]!.lifecycle = "claimed"; },
    (state): void => { state.executionAttempts[0]!.controlGeneration = -1; },
  ];

  for (const corrupt of corruptions) {
    const repo = await repository();
    const worker = new ControlledWorker();
    const running = await start(repo, worker);
    const state = JSON.parse(await readFile(repo.statePath, "utf8")) as ControllerState;
    corrupt(state);
    await writeFile(repo.statePath, JSON.stringify(state));

    const result = await running.controller.status(actor, { limit: 10 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.error.diagnostics, ["Controller state could not be read"]);
  }
});

class ControlledBridge implements WorkerBridgeTransport {
  readonly channel: WorkerBridgeChannel = {
    endpoint: "/tmp/herdr-worker-ready.json",
    nonce: "fresh-nonce",
    requestDirectory: "/tmp/herdr-worker-decisions/requests",
    responseDirectory: "/tmp/herdr-worker-decisions/responses",
    lifecycleEndpoint: "/tmp/herdr-worker-lifecycle.json",
    reviewEndpoint: "/tmp/herdr-worker-review.json",
    nativeVerificationEndpoint: "/tmp/herdr-worker-native-verification.json",
  };
  receiptFactory: (() => WorkerReadinessReceipt) | undefined;
  reviewReceiptFactory: (() => WorkerReviewReceipt) | undefined;
  nativeVerificationReceiptFactory: (() => WorkerNativeVerificationReceipt) | undefined;
  lifecycleOutstandingJobs: string[] = [];
  livePiPid = 4242;
  lifecycleChallenges = 0;

  async openChannel(): Promise<WorkerBridgeChannel> {
    return this.channel;
  }

  async waitForReadiness(): Promise<WorkerReadinessReceipt> {
    if (!this.receiptFactory) throw new Error("missing receipt");
    return this.receiptFactory();
  }

  async waitForNativeVerification(): Promise<WorkerNativeVerificationReceipt> {
    if (!this.nativeVerificationReceiptFactory) throw new Error("missing native verification receipt");
    return this.nativeVerificationReceiptFactory();
  }

  async waitForReview(): Promise<WorkerReviewReceipt> {
    if (!this.reviewReceiptFactory) throw new Error("missing review receipt");
    return this.reviewReceiptFactory();
  }

  async readLifecycle(): Promise<WorkerLifecycleReceipt> {
    return {
      schemaVersion: 1,
      nonce: this.channel.nonce,
      sessionId: "session-1",
      piPid: this.livePiPid,
      state: "settled",
      observedAt: "2026-09-12T15:00:01.000Z",
      outstandingJobs: [...this.lifecycleOutstandingJobs],
    };
  }

  async challengeLifecycle(_channel: WorkerBridgeChannel, expectedPiPid: number): Promise<void> {
    this.lifecycleChallenges += 1;
    if (this.livePiPid !== expectedPiPid) throw new Error("live Pi process changed");
  }

  async channelForAgent(): Promise<WorkerBridgeChannel> {
    return this.channel;
  }
}

class ControlledHerdr implements HerdrCommandExecutor {
  readonly calls: Array<{ args: string[]; timeoutMs: number }> = [];
  processChecks = 0;
  failImplementationPrompt = false;

  async execute(args: string[], options: { timeoutMs: number }): Promise<HerdrCommandResult> {
    this.calls.push({ args: [...args], timeoutMs: options.timeoutMs });
    if (args[0] === "tab" && args[1] === "create") {
      return response({ tab: { tab_id: "workspace-1:tab-1", workspace_id: "workspace-1" }, root_pane: { pane_id: "workspace-1:pane-1" } });
    }
    if (args[0] === "pane" && args[1] === "wait-output") return response({ matched: true });
    if (args[0] === "pane" && args[1] === "process-info") {
      this.processChecks += 1;
      return response({ process_info: this.processChecks === 1
        ? { pane_id: "workspace-1:pane-1", shell_pid: 500, foreground_process_group_id: 700, foreground_processes: [{ pid: 700 }] }
        : { pane_id: "workspace-1:pane-1", shell_pid: 500, foreground_process_group_id: 500, foreground_processes: [{ pid: 500 }] } });
    }
    if (args[0] === "agent" && args[1] === "start") return response({ agent: herdrAgent("idle") });
    if (args[0] === "agent" && args[1] === "get") return response({ agent: herdrAgent("idle") });
    if (args[0] === "agent" && args[1] === "prompt" && args[3]?.startsWith("/skill:implement")) {
      if (this.failImplementationPrompt) throw new Error("ambiguous timeout");
      return response({ agent: herdrAgent("working") });
    }
    if (args[0] === "agent" && args[1] === "prompt" && args[3] === "/herdr-worker-ready") {
      return response({ agent: herdrAgent("idle") });
    }
    if (args[0] === "agent" && args[1] === "prompt" && args.includes("--wait")) return response({ agent: herdrAgent("done") });
    if (args[0] === "agent" && args[1] === "focus") return response({ agent: herdrAgent("idle") });
    if (args[0] === "tab" && args[1] === "close") return response({ closed: true });
    throw new Error(`unexpected Herdr command: ${args.join(" ")}`);
  }
}

function response(result: unknown): HerdrCommandResult {
  return { code: 0, stdout: JSON.stringify({ id: "test", result }), stderr: "" };
}

function herdrAgent(status: "idle" | "working" | "blocked" | "done" | "unknown"): Record<string, unknown> {
  return {
    agent: "pi",
    agent_status: status,
    pane_id: "workspace-1:pane-1",
    tab_id: "workspace-1:tab-1",
    workspace_id: "workspace-1",
    cwd: "/ignored-in-favor-of-receipt",
    agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: "/saved/session-1.jsonl" },
  };
}

function readinessReceipt(cwd: string, agentName: string): WorkerReadinessReceipt {
  return {
    schemaVersion: 1,
    nonce: "fresh-nonce",
    observedAt: "2026-09-12T14:00:00.000Z",
    sessionStartReason: "startup",
    workspaceId: "workspace-1",
    tabId: "workspace-1:tab-1",
    paneId: "workspace-1:pane-1",
    agentName,
    piPid: 4242,
    sessionId: "session-1",
    sessionFile: "/saved/session-1.jsonl",
    cwd,
    mode: "tui",
    initialHistoryEntries: 0,
    model: { provider: "test", id: "reasoner", thinkingLevel: "high", contextWindow: 220_000 },
    commands: ["implement", "tdd", "code-review", "handoff"].map((name): WorkerReadinessReceipt["commands"][number] => ({
      name: `skill:${name}`,
      source: "skill",
      sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "skills", scope: "user", origin: "top-level" },
    })),
    toolNames: ["read", "bash", "edit", "write", "subagent"],
    contextFiles: [join(cwd, "AGENTS.md")],
  };
}

function receiptFor(executor: ControlledHerdr): WorkerReadinessReceipt {
  return readinessReceipt(
    executor.calls.find((call): boolean => call.args[0] === "tab")!.args[5]!,
    executor.calls.find((call): boolean => call.args[0] === "agent" && call.args[1] === "start")!.args[2]!,
  );
}

function herdrRuntime(executor: ControlledHerdr, bridge: ControlledBridge): HerdrWorkerRuntime {
  return new HerdrWorkerRuntime({
    executor,
    bridge,
    bridgeExtensionPath: "/package/src/worker-bridge.ts",
    shellReadyTimeoutMs: 1_000,
    agentStartTimeoutMs: 60_000,
    bridgeReadyTimeoutMs: 5_000,
    promptTimeoutMs: 120_000,
    pollIntervalMs: 1,
    sleep: async (): Promise<void> => {},
  });
}

test("authenticated Unix requests reject malformed method payloads at the daemon boundary", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  const socketPath = join(repo.root, ".git", "herdr", "payload-validation.sock");
  const daemon = new LocalControllerDaemon(running.controller, actor, socketPath, "test-token");
  await daemon.start({ markRestarted: false });
  try {
    const invalidDecisionIdentities = [7, null, true, []];
    const malformed: Array<{ method: string; params: unknown[] }> = [
      { method: "ping", params: [null] },
      { method: "prepare", params: [{ specReference: "spec-2", controllerName: "controller" }, null] },
      { method: "submitProposal", params: ["preparation-1", null] },
      { method: "approve", params: ["preparation-1", null] },
      { method: "preview", params: [null] },
      { method: "getPreparation", params: ["preparation-1", "extra"] },
      { method: "validateApproval", params: ["preparation-1", null] },
      { method: "startTicket", params: [{ preparationId: "preparation-1", ticketIdentity: null, workspaceId: "workspace-1" }] },
      { method: "captureCandidate", params: [{ attemptId: 4 }] },
      { method: "acceptCandidate", params: [{
        attemptId: "attempt-1",
        candidateDigest: "a".repeat(64),
        nativeEvidence: [{ kind: "tests", status: "passed", candidateDigest: "a".repeat(64), evidenceReference: "/claim", completedAt: "2026-09-12T15:00:00.000Z" }],
      }] },
      { method: "attachAttempt", params: [null] },
      { method: "pauseAttempt", params: [null] },
      { method: "resumeAttempt", params: [{ attemptId: 4 }] },
      { method: "takeOverAttempt", params: [{}] },
      { method: "returnAttempt", params: [{ attemptId: "attempt-1" }, null] },
      { method: "answerDecision", params: [{ attemptId: "attempt-1", decisionId: "decision-1", answer: null, answeredBy: "developer" }] },
      { method: "recordWorkerObservation", params: [{ attemptId: "attempt-1", controlGeneration: 0, observation: null }] },
      { method: "recordWorkerObservation", params: [{ attemptId: "attempt-1", controlGeneration: -1, observation: {
        identity: running.attempt.worker!, status: "working", artifactReferences: [],
      } }] },
      { method: "status", params: [{ limit: "10" }] },
      ...invalidDecisionIdentities.map((transportId): { method: string; params: unknown[] } => ({
        method: "recordWorkerObservation",
        params: [{
          attemptId: running.attempt.id,
          controlGeneration: running.attempt.controlGeneration ?? 0,
          observation: {
            identity: running.attempt.worker!,
            status: "blocked",
            artifactReferences: [],
            decision: {
              transportId,
              question: "Choose?",
              context: "A local choice is required.",
              options: ["A"],
              recommendation: "A",
            },
          },
        }],
      })),
    ];

    for (const [index, request] of malformed.entries()) {
      const response = await rawControllerRequest(socketPath, {
        id: `malformed-${index}`,
        token: "test-token",
        method: request.method,
        params: request.params,
      });
      assert.deepEqual(response, {
        id: `malformed-${index}`,
        ok: false,
        error: "Local controller request failed",
      });
    }
    const client = new UnixControllerClient(socketPath, "test-token");
    const attempts = value(await client.status({ limit: 10 })).executionAttempts;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.lifecycle, "running");
    assert.deepEqual(attempts[0]?.decisions, []);
  } finally {
    await daemon.close();
  }
});

test("remote daemon client serializes preparation and duplicate execution while client replacement is inert", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const instance = controller(repo, worker);
  const socketPath = join(repo.root, ".git", "herdr", "test-controller.sock");
  const daemon = new LocalControllerDaemon(instance, actor, socketPath, "test-token");
  await daemon.start({ markRestarted: false });
  try {
    const client = new UnixControllerClient(socketPath, "test-token");
    const competing = new LocalControllerDaemon(controller(repo, new ControlledWorker()), actor, socketPath, "other-token");
    await assert.rejects(competing.start({ markRestarted: false }), /already owns/);
    const prepared = value(await client.prepare(
      { specReference: "spec-2", controllerName: "example / issue 4" },
      admission(repo),
    ));
    const proposed = value(await client.submitProposal(prepared.id, proposal(repo)));
    value(await client.approve(prepared.id, {
      approvedBy: "developer",
      proposalDigest: proposed.proposalDigest!,
      projectHead: repo.head,
      model: proposal(repo).model,
      evidence: [
        evidence("instructions", "2026-09-12T13:00:00.000Z"),
        evidence("spec", "2026-09-12T13:00:00.000Z"),
        evidence("ticket-4", "2026-09-12T13:00:00.000Z"),
      ],
    }));
    const request = { preparationId: prepared.id, ticketIdentity: "ticket-4", workspaceId: "workspace-1" };

    const [left, right] = await Promise.all([client.startTicket(request), client.startTicket(request)]);

    assert.equal(value(left).id, value(right).id);
    assert.equal(worker.starts, 1);
    assert.equal(worker.dispatches, 1);
    const replacementClient = new UnixControllerClient(socketPath, "test-token");
    const status = value(await replacementClient.status({ limit: 10 }));
    assert.equal(status.executionAttempts[0]?.lifecycle, "running");
    const attached = value(await replacementClient.attachAttempt({ attemptId: status.executionAttempts[0]!.id }));
    assert.equal(attached.lifecycle, "running");
    assert.equal(worker.focuses, 1);
  } finally {
    await daemon.close();
  }
});

test("remote daemon rejects a held completion released after takeover and return", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  const socketPath = join(repo.root, ".git", "herdr", "monitor-controller.sock");
  let notifyInspectionStarted!: () => void;
  const inspectionStarted = new Promise<void>((resolve): void => { notifyInspectionStarted = resolve; });
  let releaseInspection!: () => void;
  const inspectionReleased = new Promise<void>((resolve): void => { releaseInspection = resolve; });
  let inspections = 0;
  const monitor = {
    async inspect(identity: WorkerIdentity): Promise<WorkerObservation> {
      inspections += 1;
      if (inspections === 1) {
        notifyInspectionStarted();
        await inspectionReleased;
        return { identity, status: "done", artifactReferences: ["/evidence/stale-monitor.json"] };
      }
      return { identity, status: "working", artifactReferences: [] };
    },
    async nextDecision(): Promise<WorkerDecisionRequest | undefined> { return undefined; },
    async acknowledgeDecision(): Promise<void> {},
  };
  const daemon = new LocalControllerDaemon(running.controller, actor, socketPath, "test-token", monitor);
  await daemon.start({ markRestarted: false });
  try {
    const client = new UnixControllerClient(socketPath, "test-token");
    await Promise.race([
      inspectionStarted,
      new Promise<never>((_resolve, reject): void => { setTimeout((): void => { reject(new Error("monitor did not inspect active worker")); }, 1_000); }),
    ]);

    const takeover = await Promise.race([
      client.takeOverAttempt({ attemptId: running.attempt.id }),
      new Promise<never>((_resolve, reject): void => { setTimeout((): void => { reject(new Error("monitor blocked dashboard takeover")); }, 1_500); }),
    ]);
    const takenOver = value(takeover);
    assert.equal(takenOver.lifecycle, "takeover");
    assert.ok(takenOver.controlGeneration! > (running.attempt.controlGeneration ?? 0));
    const returned = value(await client.returnAttempt({ attemptId: running.attempt.id }));
    assert.equal(returned.lifecycle, "running");
    assert.ok(returned.controlGeneration! > takenOver.controlGeneration!);
    releaseInspection();
    await new Promise((resolveWait): void => { setTimeout(resolveWait, 250); });
    const afterStaleObservation = value(await client.status({ limit: 10 })).executionAttempts[0]!;
    assert.equal(afterStaleObservation.lifecycle, "running");
    assert.equal(afterStaleObservation.artifactReferences.includes("/evidence/stale-monitor.json"), false);
  } finally {
    releaseInspection();
    await daemon.close();
  }
});

test("remote daemon records acknowledgement failures without losing the repeated decision or stopping other attempts", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const first = await start(repo, worker);
  const instance = controller(repo, worker, "controller-1", ["preparation-2", "attempt-2"]);
  const secondPrepared = value(await instance.prepare(
    actor,
    { specReference: "spec-2", controllerName: "example / issue 4 second batch" },
    admission(repo),
  ));
  const secondProposal = { ...proposal(repo), controllerName: "example / issue 4 second batch" };
  const secondProposed = value(await instance.submitProposal(actor, secondPrepared.id, secondProposal));
  value(await instance.approve(actor, secondPrepared.id, {
    approvedBy: "developer",
    proposalDigest: secondProposed.proposalDigest!,
    projectHead: repo.head,
    model: secondProposal.model,
    evidence: secondProposal.sourceEvidence.map((source): SourceEvidence => ({
      ...structuredClone(source),
      retrievedAt: "2026-09-12T13:00:00.000Z",
    })),
  }));
  const second = value(await instance.startTicket(actor, {
    preparationId: secondPrepared.id,
    ticketIdentity: "ticket-4",
    workspaceId: "workspace-1",
  }));
  const repeatedRequest: WorkerDecisionRequest = {
    schemaVersion: 1,
    nonce: "fresh-nonce",
    id: "decision-repeat",
    requestedAt: "2026-09-12T13:30:00.000Z",
    question: "Which compatible format should be used?",
    context: "The approved requirements permit either format.",
    options: ["A", "B"],
    recommendation: "Use A for compatibility.",
  };
  const acknowledged: string[] = [];
  const socketPath = join(repo.root, ".git", "herdr", "acknowledgement-failure-controller.sock");
  const monitor = {
    async inspect(identity: WorkerIdentity): Promise<WorkerObservation> {
      return { identity, status: "working", artifactReferences: ["/evidence/continued-monitor.json"] };
    },
    async nextDecision(identity: WorkerIdentity): Promise<WorkerDecisionRequest | undefined> {
      return identity.cwd === first.attempt.worker!.cwd ? repeatedRequest : undefined;
    },
    async acknowledgeDecision(_identity: WorkerIdentity, decisionId: string): Promise<void> {
      acknowledged.push(decisionId);
      throw new Error("token=secret acknowledgement failure");
    },
  };
  const daemon = new LocalControllerDaemon(instance, actor, socketPath, "test-token", monitor);
  await daemon.start({ markRestarted: false });
  try {
    const client = new UnixControllerClient(socketPath, "test-token");
    let attempts: ExecutionAttempt[] = [];
    for (let index = 0; index < 75; index += 1) {
      attempts = value(await client.status({ limit: 10 })).executionAttempts;
      const failed = attempts.find((attempt): boolean => attempt.id === first.attempt.id);
      const continued = attempts.find((attempt): boolean => attempt.id === second.id);
      if (failed?.lifecycle === "needs-attention" && continued?.artifactReferences.includes("/evidence/continued-monitor.json")) break;
      await new Promise((resolveWait): void => { setTimeout(resolveWait, 20); });
    }

    const failed = attempts.find((attempt): boolean => attempt.id === first.attempt.id)!;
    const continued = attempts.find((attempt): boolean => attempt.id === second.id)!;
    assert.equal(failed.lifecycle, "needs-attention");
    assert.deepEqual(failed.diagnostics, ["Worker monitoring failed or worker ownership changed"]);
    assert.equal(failed.diagnostics.some((diagnostic): boolean => /token|secret/i.test(diagnostic)), false);
    assert.deepEqual(failed.artifactReferences, ["/evidence/turn-1.json"]);
    assert.deepEqual(failed.decisions, [{
      id: repeatedRequest.id,
      transportId: repeatedRequest.id,
      state: "pending",
      requestedAt: "2026-09-12T14:00:00.000Z",
      question: repeatedRequest.question,
      context: repeatedRequest.context,
      options: repeatedRequest.options,
      recommendation: repeatedRequest.recommendation,
    }]);
    assert.deepEqual(acknowledged, [repeatedRequest.id]);
    assert.equal(continued.lifecycle, "running");
    assert.equal(continued.artifactReferences.includes("/evidence/continued-monitor.json"), true);
  } finally {
    await daemon.close();
  }
});

test("remote daemon rejects a held acknowledgement failure after takeover and return", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  const socketPath = join(repo.root, ".git", "herdr", "stale-acknowledgement-controller.sock");
  const request: WorkerDecisionRequest = {
    schemaVersion: 1,
    nonce: "fresh-nonce",
    id: "decision-held-ack",
    requestedAt: "2026-09-12T13:30:00.000Z",
    question: "Which compatible format should be used?",
    context: "The approved requirements permit either format.",
    options: ["A", "B"],
    recommendation: "Use A for compatibility.",
  };
  let decisionReads = 0;
  let notifyAcknowledgementStarted!: () => void;
  const acknowledgementStarted = new Promise<void>((resolve): void => { notifyAcknowledgementStarted = resolve; });
  let releaseAcknowledgement!: () => void;
  const acknowledgementReleased = new Promise<void>((resolve): void => { releaseAcknowledgement = resolve; });
  let notifyLaterInspection!: () => void;
  const laterInspection = new Promise<void>((resolve): void => { notifyLaterInspection = resolve; });
  const monitor = {
    async inspect(identity: WorkerIdentity): Promise<WorkerObservation> {
      notifyLaterInspection();
      return { identity, status: "working", artifactReferences: ["/evidence/post-stale-ack.json"] };
    },
    async nextDecision(): Promise<WorkerDecisionRequest | undefined> {
      decisionReads += 1;
      return decisionReads === 1 ? request : undefined;
    },
    async acknowledgeDecision(): Promise<void> {
      notifyAcknowledgementStarted();
      await acknowledgementReleased;
      throw new Error("held acknowledgement failed");
    },
  };
  const daemon = new LocalControllerDaemon(running.controller, actor, socketPath, "test-token", monitor);
  await daemon.start({ markRestarted: false });
  try {
    const client = new UnixControllerClient(socketPath, "test-token");
    await Promise.race([
      acknowledgementStarted,
      new Promise<never>((_resolve, reject): void => { setTimeout((): void => { reject(new Error("monitor did not acknowledge decision")); }, 1_000); }),
    ]);
    const recorded = value(await client.status({ limit: 10 })).executionAttempts[0]!;
    assert.equal(recorded.lifecycle, "pending-decision");
    assert.equal(recorded.decisions[0]?.id, request.id);

    const takenOver = value(await client.takeOverAttempt({ attemptId: running.attempt.id }));
    assert.equal(takenOver.lifecycle, "takeover");
    const returned = value(await client.returnAttempt({ attemptId: running.attempt.id }));
    assert.equal(returned.lifecycle, "pending-decision");
    assert.ok(returned.controlGeneration! > recorded.controlGeneration!);
    releaseAcknowledgement();
    await Promise.race([
      laterInspection,
      new Promise<never>((_resolve, reject): void => { setTimeout((): void => { reject(new Error("monitor did not continue after held acknowledgement")); }, 1_500); }),
    ]);

    let afterStaleFailure = value(await client.status({ limit: 10 })).executionAttempts[0]!;
    for (let index = 0; index < 25 && !afterStaleFailure.artifactReferences.includes("/evidence/post-stale-ack.json"); index += 1) {
      await new Promise((resolveWait): void => { setTimeout(resolveWait, 10); });
      afterStaleFailure = value(await client.status({ limit: 10 })).executionAttempts[0]!;
    }
    assert.equal(afterStaleFailure.lifecycle, "pending-decision");
    assert.deepEqual(afterStaleFailure.diagnostics, []);
    assert.equal(afterStaleFailure.decisions[0]?.id, request.id);
    assert.equal(afterStaleFailure.artifactReferences.includes("/evidence/post-stale-ack.json"), true);
    await new Promise((resolveWait): void => { setTimeout(resolveWait, 50); });
  } finally {
    releaseAcknowledgement();
    await daemon.close();
  }
});

test("remote daemon records sanitized monitor failures per attempt and still runs Git guardrails", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const first = await start(repo, worker);
  const instance = controller(repo, worker, "controller-1", ["preparation-2", "attempt-2"]);
  const secondPrepared = value(await instance.prepare(
    actor,
    { specReference: "spec-2", controllerName: "example / issue 4 second batch" },
    admission(repo),
  ));
  const secondProposal = { ...proposal(repo), controllerName: "example / issue 4 second batch" };
  const secondProposed = value(await instance.submitProposal(actor, secondPrepared.id, secondProposal));
  value(await instance.approve(actor, secondPrepared.id, {
    approvedBy: "developer",
    proposalDigest: secondProposed.proposalDigest!,
    projectHead: repo.head,
    model: secondProposal.model,
    evidence: secondProposal.sourceEvidence.map((source): SourceEvidence => ({
      ...structuredClone(source),
      retrievedAt: "2026-09-12T13:00:00.000Z",
    })),
  }));
  const second = value(await instance.startTicket(actor, {
    preparationId: secondPrepared.id,
    ticketIdentity: "ticket-4",
    workspaceId: "workspace-1",
  }));
  git(second.worktree!.path, "checkout", "-qb", "foreign-monitor-branch");

  const socketPath = join(repo.root, ".git", "herdr", "throwing-monitor-controller.sock");
  const monitor = {
    async inspect(): Promise<WorkerObservation> { throw new Error("token=secret monitor failure"); },
    async nextDecision(): Promise<WorkerDecisionRequest | undefined> { return undefined; },
    async acknowledgeDecision(): Promise<void> {},
  };
  const daemon = new LocalControllerDaemon(instance, actor, socketPath, "test-token", monitor);
  await daemon.start({ markRestarted: false });
  try {
    const client = new UnixControllerClient(socketPath, "test-token");
    let attempts: ExecutionAttempt[] = [];
    for (let index = 0; index < 75; index += 1) {
      attempts = value(await client.status({ limit: 10 })).executionAttempts;
      if (attempts.every((attempt): boolean => attempt.lifecycle === "needs-attention")) break;
      await new Promise((resolveWait): void => { setTimeout(resolveWait, 20); });
    }

    const failedMonitor = attempts.find((attempt): boolean => attempt.id === first.attempt.id)!;
    const failedMonitorWithGitMismatch = attempts.find((attempt): boolean => attempt.id === second.id)!;
    assert.equal(failedMonitor.lifecycle, "needs-attention");
    assert.deepEqual(failedMonitor.diagnostics, ["Worker monitoring failed or worker ownership changed"]);
    assert.equal(failedMonitor.diagnostics.some((diagnostic): boolean => /token|secret/i.test(diagnostic)), false);
    assert.equal(failedMonitorWithGitMismatch.lifecycle, "needs-attention");
    assert.deepEqual(failedMonitorWithGitMismatch.diagnostics, ["Ticket worktree path, branch, or common directory changed"]);
  } finally {
    await daemon.close();
  }
});

test("daemon process restart is nonexecuting until an explicit remote resume", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const running = await start(repo, worker);
  const replacement = controller(repo, worker, "controller-2", []);
  const socketPath = join(repo.root, ".git", "herdr", "restart-controller.sock");
  const daemon = new LocalControllerDaemon(replacement, actor, socketPath, "test-token");
  await daemon.start();
  try {
    const client = new UnixControllerClient(socketPath, "test-token");
    const restarted = value(await client.status({ limit: 10 })).executionAttempts[0]!;
    assert.equal(restarted.lifecycle, "restart-required");
    assert.equal(worker.dispatches, 1);

    const resumed = value(await client.resumeAttempt({ attemptId: running.attempt.id }));
    assert.equal(resumed.lifecycle, "running");
    assert.equal(worker.dispatches, 1);
  } finally {
    await daemon.close();
  }
});

test("file worker bridge rejects a FIFO receipt without waiting for a writer", async (): Promise<void> => {
  const repo = await repository();
  const bridge = new FileWorkerBridgeTransport(join(repo.root, ".git", "herdr", "bounded-worker-bridge"), {
    generateNonce: (): string => "bounded-nonce",
  });
  const channel = await bridge.openChannel("bounded-worker");
  execFileSync("mkfifo", [channel.endpoint]);
  const writer = spawn("sh", ["-c", "sleep 0.5; printf x > \"$1\"", "sh", channel.endpoint]);
  const startedAt = Date.now();
  await assert.rejects(bridge.waitForReadiness(channel, 2_000));
  assert.ok(Date.now() - startedAt < 250);
  if (writer.exitCode === null) writer.kill("SIGKILL");
  await new Promise<void>((resolvePromise): void => {
    if (writer.exitCode !== null) resolvePromise();
    else writer.once("close", (): void => resolvePromise());
  });
});

test("daemon routes a worker decision and stops on an execution-time checkout mutation", async (): Promise<void> => {
  const repo = await repository();
  const worker = new ControlledWorker();
  const instance = controller(repo, worker);
  const socketPath = join(repo.root, ".git", "herdr", "decision-controller.sock");
  const bridge = new FileWorkerBridgeTransport(join(repo.root, ".git", "herdr", "test-worker-bridge"), {
    generateNonce: (): string => "worker-nonce",
  });
  const channel = await bridge.openChannel("herdr-worker");
  let monitoredStatus: WorkerObservation["status"] = "working";
  const monitor = {
    async inspect(identity: WorkerIdentity): Promise<WorkerObservation> {
      return { identity, status: monitoredStatus, artifactReferences: [] };
    },
    async nextDecision(): Promise<WorkerDecisionRequest | undefined> { return bridge.nextDecisionRequest(channel); },
    async acknowledgeDecision(_identity: WorkerIdentity, decisionId: string): Promise<void> {
      await bridge.acknowledgeDecisionRequest(channel, decisionId);
    },
  };
  const daemon = new LocalControllerDaemon(instance, actor, socketPath, "test-token", monitor);
  await daemon.start({ markRestarted: false });
  try {
    const client = new UnixControllerClient(socketPath, "test-token");
    const prepared = value(await client.prepare(
      { specReference: "spec-2", controllerName: "example / issue 4" }, admission(repo),
    ));
    const proposed = value(await client.submitProposal(prepared.id, proposal(repo)));
    value(await client.approve(prepared.id, {
      approvedBy: "developer", proposalDigest: proposed.proposalDigest!, projectHead: repo.head,
      model: proposal(repo).model,
      evidence: [evidence("instructions", "2026-09-12T13:00:00.000Z"), evidence("spec", "2026-09-12T13:00:00.000Z"), evidence("ticket-4", "2026-09-12T13:00:00.000Z")],
    }));
    const running = value(await client.startTicket({ preparationId: prepared.id, ticketIdentity: "ticket-4", workspaceId: "workspace-1" }));
    const externalRequest: WorkerDecisionRequest = {
      schemaVersion: 1, nonce: channel.nonce, id: "worker-question-1", requestedAt: "2026-09-12T14:00:00.000Z",
      question: "Which approved format should be used?", context: "Both formats satisfy the frozen ticket.",
      options: ["A", "B"], recommendation: "Use A for compatibility.",
    };
    await writeFile(join(channel.requestDirectory!, `${externalRequest.id}.json`), JSON.stringify(externalRequest), { mode: 0o600 });

    let observed: ExecutionAttempt | undefined;
    for (let index = 0; index < 50; index += 1) {
      observed = value(await client.status({ limit: 10 })).executionAttempts[0];
      if (observed?.lifecycle === "pending-decision") break;
      await new Promise((resolveWait): void => { setTimeout(resolveWait, 20); });
    }
    assert.equal(observed?.decisions[0]?.id, "worker-question-1");
    const answered = value(await client.answerDecision({
      attemptId: running.id, decisionId: "worker-question-1", answer: "A", answeredBy: "developer",
    }));
    assert.equal(answered.decisions[0]?.state, "delivered");
    assert.deepEqual(worker.deliveries, ["A"]);

    monitoredStatus = "done";
    await writeFile(join(repo.root, "README.md"), "unexpected execution mutation\n");
    for (let index = 0; index < 50; index += 1) {
      observed = value(await client.status({ limit: 10 })).executionAttempts[0];
      if (observed?.lifecycle === "needs-attention") break;
      await new Promise((resolveWait): void => { setTimeout(resolveWait, 20); });
    }
    assert.equal(observed?.lifecycle, "needs-attention");
    assert.deepEqual(observed?.diagnostics, ["Original checkout changed after its execution baseline"]);
    assert.equal(await readFile(join(repo.root, "README.md"), "utf8"), "unexpected execution mutation\n");
  } finally {
    await daemon.close();
  }
});

test("ordinary implementation tool events produce candidate-bound native test and review receipts", async (): Promise<void> => {
  const repo = await repository();
  const bridgeDirectory = join(repo.root, ".git", "herdr", "native-producer");
  await mkdir(bridgeDirectory, { recursive: true });
  const previousEndpoint = process.env.HERDR_WORKER_BRIDGE_ENDPOINT;
  const previousNonce = process.env.HERDR_WORKER_BRIDGE_NONCE;
  const previousVerificationEndpoint = process.env.HERDR_WORKER_NATIVE_VERIFICATION_ENDPOINT;
  const previousReviewNonce = process.env.HERDR_WORKER_REVIEW_NONCE;
  process.env.HERDR_WORKER_BRIDGE_ENDPOINT = join(bridgeDirectory, "readiness.json");
  process.env.HERDR_WORKER_BRIDGE_NONCE = "native-producer-nonce";
  process.env.HERDR_WORKER_NATIVE_VERIFICATION_ENDPOINT = join(bridgeDirectory, "native-verification.json");
  process.env.HERDR_WORKER_REVIEW_NONCE = "native-verification-nonce";
  const hostHandlers = new Map<string, (event: any, ctx: any) => unknown>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
  const events = {
    on(name: string, handler: (payload: unknown) => void): () => void {
      const handlers = eventHandlers.get(name) ?? [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
      return (): void => { eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((item): boolean => item !== handler)); };
    },
    emit(name: string, payload: unknown): void {
      if (name === "subagents:rpc:v1:request") {
        const request = payload as { requestId: string };
        this.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          success: true,
          data: {
            asyncSnapshot: {
              kind: "pi-subagents.async-status-snapshot",
              version: 1,
              omitted: { runs: 0, children: 0, byteLimitExceeded: false },
              runs: [],
            },
          },
        });
        return;
      }
      for (const handler of eventHandlers.get(name) ?? []) handler(payload);
    },
  };
  const fakePi = {
    events,
    on(name: string, handler: (event: any, ctx: any) => unknown): void { hostHandlers.set(name, handler); },
    registerCommand(): void {},
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }): void { tools.set(tool.name, tool); },
    getAllTools: (): Array<{ name: string }> => [{ name: "subagent" }],
  } as unknown as ExtensionAPI;
  const context = {
    cwd: repo.root,
    sessionManager: { getSessionId: (): string => "native-session" },
    hasPendingMessages: (): boolean => false,
  };
  try {
    herdrWorkerBridge(fakePi);
    assert.ok(tools.has("herdr_capture_native_evidence"));
    await hostHandlers.get("tool_execution_start")!({ toolCallId: "review-call", toolName: "subagent", args: { task: "Review the implementation" } }, context);
    await hostHandlers.get("tool_execution_end")!({
      toolCallId: "review-call",
      toolName: "subagent",
      isError: false,
      result: { details: { runId: "review-run", results: [{
        agent: "reviewer", task: "Review the implementation", exitCode: 0,
        structuredAcceptanceReport: {
          criteriaSatisfied: [{ id: "review", status: "satisfied", evidence: "No blocking findings" }],
          reviewFindings: ["no blockers"], residualRisks: ["none"],
        },
      }] } },
    }, context);
    const candidate = await new RealGitWorktreeAdapter().captureCandidate({ path: repo.root, sourceBase: repo.head });
    const nodeHelpOutput = execFileSync(process.execPath, ["--test", "--help"], {
      cwd: repo.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(nodeHelpOutput, /Usage: node/);
    for (const [toolCallId, command] of [
      ["echo-call", "echo 'npm test'"],
      ["masked-call", "npm test || true"],
      ["node-script-call", "node helper.js --test"],
      ["npx-wrapper-call", "npx echo vitest"],
      ["typecheck-call", "npm run typecheck"],
      ["node-help-call", "node --test --help"],
      ["node-short-help-call", "node --test -h"],
      ["node-version-call", "node --test --version"],
      ["package-help-call", "npm test -- --help"],
      ["optional-package-call", "npm run test --if-present"],
      ["jest-list-call", "npx jest --listTests"],
      ["vitest-list-call", "npx vitest list"],
      ["pytest-collect-call", "pytest --collect-only"],
      ["go-list-call", "go test -list Test"],
      ["go-compile-call", "go test -c"],
      ["cargo-no-run-call", "cargo test --no-run"],
      ["cargo-list-call", "cargo test -- --list"],
      ["bun-dry-run-call", "bun test --dry-run"],
    ]) {
      const announcedCommand = toolCallId === "echo-call" ? "npm test" : command;
      await hostHandlers.get("tool_execution_start")!({ toolCallId, toolName: "bash", args: { command: announcedCommand } }, context);
      await hostHandlers.get("tool_result")!({ toolCallId, toolName: "bash", input: { command }, isError: false }, context);
      await hostHandlers.get("tool_execution_end")!({ toolCallId, toolName: "bash", isError: false, result: {} }, context);
      await assert.rejects(
        tools.get("herdr_capture_native_evidence")!.execute("rejected-capture", {}, undefined, undefined, context),
        /directly executed test command|typecheck and lint do not satisfy native tests|do not execute tests/i,
      );
    }
    await assert.rejects(tools.get("herdr_submit_native_verification")!.execute("rejected-verification", {
      status: "passed",
      candidateCommit: repo.head,
      codeStateDigest: candidate.codeStateDigest,
      findings: [],
    }, undefined, undefined, context), /actual successful native test command/i);
    await hostHandlers.get("tool_execution_start")!({
      toolCallId: "test-call",
      toolName: "bash",
      args: { command: "node --import tsx --test test/execution-controller.test.ts" },
    }, context);
    await hostHandlers.get("tool_result")!({
      toolCallId: "test-call",
      toolName: "bash",
      input: { command: "node --import tsx --test test/execution-controller.test.ts" },
      isError: false,
    }, context);
    await hostHandlers.get("tool_execution_end")!({ toolCallId: "test-call", toolName: "bash", isError: false, result: {} }, context);
    await tools.get("herdr_submit_native_verification")!.execute("accepted-verification", {
      status: "passed",
      candidateCommit: repo.head,
      codeStateDigest: candidate.codeStateDigest,
      findings: [],
    }, undefined, undefined, context);
    await hostHandlers.get("tool_result")!({
      toolCallId: "failed-test-rerun",
      toolName: "bash",
      input: { command: "node --import tsx --test test/execution-controller.test.ts" },
      isError: true,
    }, context);
    await assert.rejects(
      tools.get("herdr_capture_native_evidence")!.execute("stale-test-capture", {}, undefined, undefined, context),
      /lacks observed successful native tests/i,
    );
    await hostHandlers.get("tool_result")!({
      toolCallId: "successful-test-rerun",
      toolName: "bash",
      input: { command: "node --import tsx --test test/execution-controller.test.ts" },
      isError: false,
    }, context);
    await hostHandlers.get("tool_execution_start")!({
      toolCallId: "blocking-review-rerun",
      toolName: "subagent",
      args: { task: "Review the implementation again" },
    }, context);
    await hostHandlers.get("tool_execution_end")!({
      toolCallId: "blocking-review-rerun",
      toolName: "subagent",
      isError: false,
      result: { details: { runId: "blocking-review-run", results: [{
        agent: "reviewer", task: "Review the implementation again", exitCode: 0,
        structuredAcceptanceReport: {
          criteriaSatisfied: [{ id: "review", status: "not-satisfied", evidence: "A blocker remains" }],
          reviewFindings: ["blocker: native evidence is stale"], residualRisks: ["acceptance bypass"],
        },
      }] } },
    }, context);
    await assert.rejects(
      tools.get("herdr_capture_native_evidence")!.execute("stale-review-capture", {}, undefined, undefined, context),
      /structured no-blocker review/i,
    );
    await hostHandlers.get("tool_execution_start")!({
      toolCallId: "passing-review-rerun",
      toolName: "subagent",
      args: { task: "Review the corrected implementation" },
    }, context);
    await hostHandlers.get("tool_execution_end")!({
      toolCallId: "passing-review-rerun",
      toolName: "subagent",
      isError: false,
      result: { details: { runId: "passing-review-run", results: [{
        agent: "reviewer", task: "Review the corrected implementation", exitCode: 0,
        structuredAcceptanceReport: {
          criteriaSatisfied: [{ id: "review", status: "satisfied", evidence: "No blocking findings" }],
          reviewFindings: ["no blockers"], residualRisks: ["none"],
        },
      }] } },
    }, context);
    await hostHandlers.get("agent_settled")!({}, context);
    const nativeEvidenceModule = await import("../src/native-evidence.js");
    const records = await nativeEvidenceModule.readProducedNativeEvidence(
      join(bridgeDirectory, "native-evidence", "latest.json"),
      { sessionId: "native-session", codeStateDigest: candidate.codeStateDigest },
    );
    assert.deepEqual(records.map((record): string => record.kind).sort(), ["reviews", "tests"]);
    for (const record of records) {
      await new nativeEvidenceModule.FileNativeEvidenceAdapter().verify({ record, candidate });
    }
  } finally {
    if (previousEndpoint === undefined) delete process.env.HERDR_WORKER_BRIDGE_ENDPOINT;
    else process.env.HERDR_WORKER_BRIDGE_ENDPOINT = previousEndpoint;
    if (previousNonce === undefined) delete process.env.HERDR_WORKER_BRIDGE_NONCE;
    else process.env.HERDR_WORKER_BRIDGE_NONCE = previousNonce;
    if (previousVerificationEndpoint === undefined) delete process.env.HERDR_WORKER_NATIVE_VERIFICATION_ENDPOINT;
    else process.env.HERDR_WORKER_NATIVE_VERIFICATION_ENDPOINT = previousVerificationEndpoint;
    if (previousReviewNonce === undefined) delete process.env.HERDR_WORKER_REVIEW_NONCE;
    else process.env.HERDR_WORKER_REVIEW_NONCE = previousReviewNonce;
  }
});

test("dashboard acceptance consumes the worker-owned evidence index without requesting a worker-only tool", async (): Promise<void> => {
  const repo = await repository();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const prompts: string[] = [];
  const receipt = {
    id: "receipt-1",
    state: "captured" as const,
    capturedAt: "2026-10-01T00:00:00.000Z",
    proposalDigest: "a".repeat(64),
    specIdentity: "spec-2",
    specRevision: "rev-1",
    preparationId: "preparation-1",
    ticketIdentity: "ticket-5",
    attemptId: "attempt-1",
    sessionId: "worker-session-1",
    sessionFile: "/saved/worker-session-1.jsonl",
    candidate: {
      sourceBase: repo.head,
      head: repo.head,
      branch: "ticket-5",
      statusDigest: "b".repeat(64),
      indexDiffDigest: "c".repeat(64),
      worktreeDiffDigest: "d".repeat(64),
      untrackedFiles: [],
      codeStateDigest: "e".repeat(64),
      candidateDigest: "f".repeat(64),
    },
    nativeEvidence: [],
    checks: [],
    reviews: [],
    findings: [],
    evidenceReferences: [],
  };
  const fakePi = {
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }): void {
      commands.set(name, command.handler);
    },
    registerTool(): void {},
    async exec(command: string, args: string[], options: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
      try {
        return {
          code: 0,
          stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
          stderr: "",
        };
      } catch {
        return { code: 1, stdout: "", stderr: "unavailable" };
      }
    },
    async sendUserMessage(prompt: string): Promise<void> { prompts.push(prompt); },
  } as unknown as ExtensionAPI;
  registerHerdrExtension(fakePi, {
    workspaceId: (): string => "workspace-1",
    connectController: async () => ({
      captureCandidate: async (): Promise<ControllerResult<typeof receipt>> => ({ ok: true, value: receipt }),
    }) as any,
  });

  await commands.get("herdr-accept")!("attempt-1", {
    cwd: repo.root,
    ui: { notify(): void {} },
  });

  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0]!, /herdr_capture_native_evidence/);
  assert.match(prompts[0]!, /worker-owned evidence index/);
  assert.match(prompts[0]!, /herdr_accept_candidate/);
});

test("worker bridge reports ordinary asynchronous subagent and provider work from the supported status protocol", async (): Promise<void> => {
  const repo = await repository();
  const bridgeDirectory = join(repo.root, ".git", "herdr", "worker-observation");
  await mkdir(bridgeDirectory, { recursive: true });
  const endpoint = join(bridgeDirectory, "readiness.json");
  const previousEndpoint = process.env.HERDR_WORKER_BRIDGE_ENDPOINT;
  const previousNonce = process.env.HERDR_WORKER_BRIDGE_NONCE;
  process.env.HERDR_WORKER_BRIDGE_ENDPOINT = endpoint;
  process.env.HERDR_WORKER_BRIDGE_NONCE = "observation-nonce";
  const hostHandlers = new Map<string, (event: any, ctx: any) => unknown>();
  const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
  let omittedChildren = 0;
  const events = {
    on(name: string, handler: (payload: unknown) => void): () => void {
      const handlers = eventHandlers.get(name) ?? [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
      return (): void => { eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((item): boolean => item !== handler)); };
    },
    emit(name: string, payload: unknown): void {
      if (name === "subagents:rpc:v1:request") {
        const request = payload as { requestId: string };
        this.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          success: true,
          data: {
            asyncSnapshot: {
              kind: "pi-subagents.async-status-snapshot",
              version: 1,
              generatedAt: Date.now(),
              caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32 * 1024 },
              omitted: { runs: 0, children: omittedChildren, byteLimitExceeded: false },
              runs: [{
                id: "review-run-1",
                kind: "subagent",
                label: "reviewer",
                state: "complete",
                children: [{
                  id: "provider-review-1",
                  kind: "host-step",
                  label: "provider review",
                  state: "running",
                  hostStep: { kind: "provider", state: "running" },
                }],
              }],
            },
          },
        });
        return;
      }
      for (const handler of eventHandlers.get(name) ?? []) handler(payload);
    },
  };
  const fakePi = {
    events,
    on(name: string, handler: (event: any, ctx: any) => unknown): void { hostHandlers.set(name, handler); },
    registerCommand(): void {},
    registerTool(): void {},
    getAllTools: (): Array<{ name: string }> => [{ name: "subagent" }],
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: { getSessionId: (): string => "worker-session" },
    hasPendingMessages: (): boolean => false,
  };
  try {
    herdrWorkerBridge(fakePi);
    await hostHandlers.get("agent_settled")!({}, context);
    const lifecycle = JSON.parse(await readFile(join(bridgeDirectory, "lifecycle.json"), "utf8")) as WorkerLifecycleReceipt;
    assert.equal(lifecycle.piPid, process.pid);
    assert.deepEqual(lifecycle.outstandingJobs, ["pi-subagent:provider-review-1"]);

    omittedChildren = 1;
    await hostHandlers.get("agent_settled")!({}, context);
    const incompleteLifecycle = JSON.parse(await readFile(join(bridgeDirectory, "lifecycle.json"), "utf8")) as WorkerLifecycleReceipt;
    assert.deepEqual(incompleteLifecycle.outstandingJobs, [
      "subagent-status-unknown: async status snapshot was incomplete; inspect active subagent/provider work",
    ]);
  } finally {
    if (previousEndpoint === undefined) delete process.env.HERDR_WORKER_BRIDGE_ENDPOINT;
    else process.env.HERDR_WORKER_BRIDGE_ENDPOINT = previousEndpoint;
    if (previousNonce === undefined) delete process.env.HERDR_WORKER_BRIDGE_NONCE;
    else process.env.HERDR_WORKER_BRIDGE_NONCE = previousNonce;
  }
});

test("production Herdr runtime starts only after shell and fresh Pi resource proofs", async (): Promise<void> => {
  const repo = await repository();
  const executor = new ControlledHerdr();
  const bridge = new ControlledBridge();
  const runtime = herdrRuntime(executor, bridge);
  bridge.receiptFactory = (): WorkerReadinessReceipt => receiptFor(executor);
  const ready = await approved(repo, runtime);

  const attempt = value(await ready.controller.startTicket(actor, {
    preparationId: ready.preparationId, ticketIdentity: "ticket-4", workspaceId: "workspace-1",
  }));

  assert.equal(attempt.lifecycle, "running", attempt.diagnostics.join("\n"));
  assert.equal(attempt.worker?.mode, "tui");
  assert.equal(executor.processChecks, 2);
  const tabCreate = executor.calls.find((call): boolean => call.args[0] === "tab")!;
  assert.deepEqual(tabCreate.args.slice(0, 4), ["tab", "create", "--workspace", "workspace-1"]);
  assert.ok(tabCreate.args.includes("--no-focus"));
  assert.ok(tabCreate.args.includes("HERDR_WORKER_BRIDGE_ENDPOINT=/tmp/herdr-worker-ready.json"));
  const agentStart = executor.calls.find((call): boolean => call.args[0] === "agent" && call.args[1] === "start")!;
  assert.ok(agentStart.args.includes("--model"));
  assert.ok(agentStart.args.includes("test/reasoner"));
  assert.ok(agentStart.args.includes("--thinking"));
  assert.ok(agentStart.args.includes("high"));
  assert.ok(agentStart.args.includes("-e"));
  assert.equal(agentStart.args.some((arg): boolean => ["--print", "--mode", "--continue", "--resume", "--fork", "--session", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-tools"].includes(arg)), false);
  const prompts = executor.calls.filter((call): boolean => call.args[0] === "agent" && call.args[1] === "prompt");
  assert.equal(prompts[0]?.args[3], "/herdr-worker-ready");
  assert.equal(prompts[1]?.args[3], "/skill:implement ticket-4");
  assert.equal(prompts[1]?.args.includes("--wait"), false);
});

test("production Herdr runtime rejects a resumed replacement Pi process without the owned live bridge", async (): Promise<void> => {
  const repo = await repository();
  const executor = new ControlledHerdr();
  const bridge = new ControlledBridge();
  const runtime = herdrRuntime(executor, bridge);
  bridge.receiptFactory = (): WorkerReadinessReceipt => receiptFor(executor);
  const allocation = await runtime.allocate({ workspaceId: "workspace-1", agentName: "worker-live-proof", cwd: repo.root });
  const identity = await runtime.start({ allocation, cwd: repo.root, model: proposal(repo).model });
  assert.ok(bridge.lifecycleChallenges > 0);

  bridge.livePiPid = identity.piPid + 1;
  await assert.rejects(runtime.inspect(identity), /live Pi process changed/);
});

test("production Herdr runtime rejects inherited Pi history before implementation dispatch", async (): Promise<void> => {
  const repo = await repository();
  const executor = new ControlledHerdr();
  const bridge = new ControlledBridge();
  const runtime = herdrRuntime(executor, bridge);
  bridge.receiptFactory = (): WorkerReadinessReceipt => ({
    ...receiptFor(executor),
    initialHistoryEntries: 1,
  });
  const ready = await approved(repo, runtime);

  const attempt = value(await ready.controller.startTicket(actor, {
    preparationId: ready.preparationId, ticketIdentity: "ticket-4", workspaceId: "workspace-1",
  }));

  assert.equal(attempt.lifecycle, "needs-attention");
  assert.equal(executor.calls.some((call): boolean => call.args[3]?.startsWith("/skill:implement") === true), false);
});

test("production Herdr runtime rejects stale startup, model, cwd, pane, session, and resource proofs", async (): Promise<void> => {
  const corruptions: Array<(receipt: WorkerReadinessReceipt) => WorkerReadinessReceipt> = [
    (receipt): WorkerReadinessReceipt => ({ ...receipt, sessionStartReason: "resume" }),
    (receipt): WorkerReadinessReceipt => ({ ...receipt, model: { ...receipt.model, id: "other-model" } }),
    (receipt): WorkerReadinessReceipt => ({ ...receipt, cwd: "/foreign-worktree" }),
    (receipt): WorkerReadinessReceipt => ({ ...receipt, paneId: "workspace-1:foreign-pane" }),
    (receipt): WorkerReadinessReceipt => ({ ...receipt, sessionFile: "/saved/foreign.jsonl" }),
    (receipt): WorkerReadinessReceipt => ({ ...receipt, toolNames: ["read"] }),
    (receipt): WorkerReadinessReceipt => ({ ...receipt, contextFiles: [] }),
    (receipt): WorkerReadinessReceipt => ({ ...receipt, commands: receipt.commands.filter((command): boolean => command.name !== "skill:implement") }),
  ];

  for (const corrupt of corruptions) {
    const repo = await repository();
    const executor = new ControlledHerdr();
    const bridge = new ControlledBridge();
    const runtime = herdrRuntime(executor, bridge);
    bridge.receiptFactory = (): WorkerReadinessReceipt => corrupt(receiptFor(executor));
    const ready = await approved(repo, runtime);

    const attempt = value(await ready.controller.startTicket(actor, {
      preparationId: ready.preparationId, ticketIdentity: "ticket-4", workspaceId: "workspace-1",
    }));

    assert.equal(attempt.lifecycle, "needs-attention");
    assert.equal(executor.calls.some((call): boolean => call.args[3]?.startsWith("/skill:implement") === true), false);
  }
});

test("production Herdr staged native verification uses a fresh normal Pi skill session and observed command receipt", async (): Promise<void> => {
  const executor = new ControlledHerdr();
  const bridge = new ControlledBridge();
  const runtime = herdrRuntime(executor, bridge);
  bridge.receiptFactory = (): WorkerReadinessReceipt => receiptFor(executor);
  bridge.nativeVerificationReceiptFactory = (): WorkerNativeVerificationReceipt => ({
    schemaVersion: 1,
    nonce: bridge.channel.nonce,
    sessionId: "session-1",
    status: "passed",
    candidateCommit: "b".repeat(40),
    codeStateDigest: "c".repeat(64),
    observedCommandDigests: ["d".repeat(64)],
    findings: [],
    completedAt: "2026-09-12T15:00:00.000Z",
  });

  const verification = await runtime.verify({
    workspaceId: "workspace-1",
    cwd: "/candidate/staging",
    candidateCommit: "b".repeat(40),
    codeStateDigest: "c".repeat(64),
    model: { provider: "test", id: "reasoner", thinkingLevel: "high", contextWindow: 220_000 },
    evidenceReferences: ["/evidence/native-tests.json"],
  });

  assert.equal(verification.status, "passed");
  assert.deepEqual(verification.observedCommandDigests, ["d".repeat(64)]);
  assert.equal(verification.evidenceReference, bridge.channel.nativeVerificationEndpoint);
  const startCall = executor.calls.find((call): boolean => call.args[0] === "agent" && call.args[1] === "start")!;
  assert.equal(startCall.args.some((arg): boolean => ["--continue", "--resume", "--fork", "--session", "--no-tools", "--no-skills"].includes(arg)), false);
  const prompt = executor.calls.find((call): boolean => call.args[0] === "agent" && call.args[1] === "prompt" && call.args[3]?.startsWith("/skill:implement Verification-only") === true)!;
  assert.ok(prompt.args.includes("--wait"));
  assert.match(prompt.args[3]!, /Do not edit or write files, commit, repair findings/);
  assert.equal(executor.calls.some((call): boolean => call.args[0] === "tab" && call.args[1] === "close"), true);
});

test("production Herdr acceptance review starts a fresh Pi session and retains structured candidate binding", async (): Promise<void> => {
  const executor = new ControlledHerdr();
  const bridge = new ControlledBridge();
  const runtime = herdrRuntime(executor, bridge);
  bridge.receiptFactory = (): WorkerReadinessReceipt => receiptFor(executor);
  bridge.reviewReceiptFactory = (): WorkerReviewReceipt => ({
    schemaVersion: 1,
    nonce: bridge.channel.nonce,
    sessionId: "session-1",
    kind: "standards",
    verdict: "passed",
    candidateCommit: "b".repeat(40),
    reviewBase: "a".repeat(40),
    findings: [],
    completedAt: "2026-09-12T15:00:00.000Z",
  });

  const review = await runtime.review({
    kind: "standards",
    workspaceId: "workspace-1",
    cwd: "/candidate/staging",
    reviewBase: "a".repeat(40),
    candidateCommit: "b".repeat(40),
    model: { provider: "test", id: "reasoner", thinkingLevel: "high", contextWindow: 220_000 },
    evidenceReferences: ["/evidence/standards.md"],
  });

  assert.equal(review.verdict, "passed");
  assert.equal(review.freshSessionId, "session-1");
  assert.equal(review.evidenceReference, bridge.channel.reviewEndpoint);
  const startCall = executor.calls.find((call): boolean => call.args[0] === "agent" && call.args[1] === "start")!;
  assert.equal(startCall.args.some((arg): boolean => ["--continue", "--resume", "--fork", "--session"].includes(arg)), false);
  const reviewPrompt = executor.calls.find((call): boolean => call.args[0] === "agent" && call.args[1] === "prompt" && call.args.includes("--wait"))!;
  assert.match(reviewPrompt.args[3]!, /git diff a{40}\.\.b{40}/);
  assert.equal(executor.calls.some((call): boolean => call.args[0] === "tab" && call.args[1] === "close"), true);
});

test("production Herdr acceptance review preserves a settled blocked reviewer tab", async (): Promise<void> => {
  const executor = new ControlledHerdr();
  const bridge = new ControlledBridge();
  const runtime = herdrRuntime(executor, bridge);
  bridge.receiptFactory = (): WorkerReadinessReceipt => receiptFor(executor);
  bridge.reviewReceiptFactory = (): WorkerReviewReceipt => ({
    schemaVersion: 1,
    nonce: bridge.channel.nonce,
    sessionId: "session-1",
    kind: "standards",
    verdict: "blocked",
    candidateCommit: "b".repeat(40),
    reviewBase: "a".repeat(40),
    findings: ["blocking finding"],
    completedAt: "2026-09-12T15:00:00.000Z",
  });

  const review = await runtime.review({
    kind: "standards",
    workspaceId: "workspace-1",
    cwd: "/candidate/staging",
    reviewBase: "a".repeat(40),
    candidateCommit: "b".repeat(40),
    model: { provider: "test", id: "reasoner", thinkingLevel: "high", contextWindow: 220_000 },
    evidenceReferences: ["/evidence/standards.md"],
  });

  assert.equal(review.verdict, "blocked");
  assert.equal(executor.calls.some((call): boolean => call.args[0] === "tab" && call.args[1] === "close"), false);
});

test("production Herdr acceptance review rejects a receipt before the exact Pi session settles", async (): Promise<void> => {
  const executor = new ControlledHerdr();
  const bridge = new ControlledBridge();
  bridge.lifecycleOutstandingJobs = ["pi-queued-message:1"];
  const runtime = herdrRuntime(executor, bridge);
  bridge.receiptFactory = (): WorkerReadinessReceipt => receiptFor(executor);
  bridge.reviewReceiptFactory = (): WorkerReviewReceipt => ({
    schemaVersion: 1,
    nonce: bridge.channel.nonce,
    sessionId: "session-1",
    kind: "standards",
    verdict: "passed",
    candidateCommit: "b".repeat(40),
    reviewBase: "a".repeat(40),
    findings: [],
    completedAt: "2026-09-12T15:00:00.000Z",
  });

  await assert.rejects(runtime.review({
    kind: "standards",
    workspaceId: "workspace-1",
    cwd: "/candidate/staging",
    reviewBase: "a".repeat(40),
    candidateCommit: "b".repeat(40),
    model: { provider: "test", id: "reasoner", thinkingLevel: "high", contextWindow: 220_000 },
    evidenceReferences: ["/evidence/standards.md"],
  }), /has not settled|outstanding work/);

  assert.equal(executor.calls.some((call): boolean => call.args[0] === "tab" && call.args[1] === "close"), false);
});

test("ambiguous implementation prompt failure is recorded once without duplicate retry", async (): Promise<void> => {
  const repo = await repository();
  const executor = new ControlledHerdr();
  executor.failImplementationPrompt = true;
  const bridge = new ControlledBridge();
  const runtime = herdrRuntime(executor, bridge);
  bridge.receiptFactory = (): WorkerReadinessReceipt => receiptFor(executor);
  const ready = await approved(repo, runtime);

  const attempt = value(await ready.controller.startTicket(actor, {
    preparationId: ready.preparationId, ticketIdentity: "ticket-4", workspaceId: "workspace-1",
  }));

  assert.equal(attempt.lifecycle, "needs-attention");
  assert.equal(executor.calls.filter((call): boolean => call.args[3]?.startsWith("/skill:implement") === true).length, 1);
});
