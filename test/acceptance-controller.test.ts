import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { afterEach } from "node:test";

import {
  PreparationController,
  type AcceptanceReviewPort,
  type AdmissionSnapshot,
  type BatchProposal,
  type CandidateReceipt,
  type ControllerResult,
  type GateCheckPort,
  type PreparationRecord,
  type SourceEvidence,
  type WorkerAllocation,
  type WorkerIdentity,
  type WorkerObservation,
  type WorkerRuntimePort,
} from "../src/controller.js";
import { LocalGateCheckAdapter } from "../src/gate-checks.js";
import { RealGitWorktreeAdapter } from "../src/git-worktrees.js";
import { LocalControllerDaemon, UnixControllerClient } from "../src/local-daemon.js";
import { digest } from "../src/policy.js";
import { formatPreparationPreview } from "../src/presentation.js";
import { JsonControllerStateStore } from "../src/state-store.js";

interface Repository { root: string; statePath: string; head: string }
const roots = new Set<string>();
const actor = Symbol("acceptance actor");

afterEach(async (): Promise<void> => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
    await rm(join(dirname(root), `.${basename(root)}-herdr-worktrees`), { recursive: true, force: true });
    roots.delete(root);
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repository(): Promise<Repository> {
  const root = await mkdtemp(join(tmpdir(), "herdr-acceptance-"));
  roots.add(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test User");
  await writeFile(join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "initial");
  return { root, statePath: join(root, ".git", "herdr", "controller-state.json"), head: git(root, "rev-parse", "HEAD") };
}

function evidence(identity: string, retrievedAt = "2026-10-01T12:00:00.000Z"): SourceEvidence {
  return { identity, revision: "v1", contentDigest: createHash("sha256").update(identity).digest("hex"), retrievedAt, references: [`https://tracker.invalid/${identity}`] };
}

function admission(repo: Repository): AdmissionSnapshot {
  return {
    project: { root: repo.root, identity: "example/project", head: repo.head, branch: "main", instructionFiles: [join(repo.root, "AGENTS.md")] },
    runtime: { platform: process.platform === "darwin" ? "darwin" : "linux", piVersion: "0.85.1", herdrVersion: "0.8.2", projectTrusted: true, skillCommands: ["skill:implement", "skill:tdd", "skill:code-review", "skill:handoff"], toolNames: ["read", "bash", "herdr_submit_batch_proposal", "herdr_get_preparation", "herdr_approve_batch"] },
    model: { provider: "test", id: "reasoner", thinkingLevel: "high", contextWindow: 220_000, authenticated: true, available: true },
  };
}

function proposal(repo: Repository): BatchProposal {
  return {
    schemaVersion: 1,
    controllerName: "example / issue 5",
    project: { identity: "example/project", tracker: { identity: "tracker", instructionSources: ["AGENTS.md"], instructionEvidenceIdentities: ["instructions"] } },
    sourceEvidence: [evidence("instructions"), evidence("spec"), evidence("ticket-a")],
    spec: { identity: "spec-2", title: "Acceptance", evidenceIdentity: "spec" },
    tickets: [{ identity: "ticket-a", title: "Candidate", evidenceIdentity: "ticket-a", claimedBy: null }],
    dependencies: [],
    target: { branch: "main", baseCommit: repo.head },
    model: { provider: "test", id: "reasoner", thinkingLevel: "high", contextWindow: 220_000 },
    policy: { concurrency: 1, context: { requestedHandoffTokens: 190_000, reserveTokens: 22_000 }, maxHandoffReplacements: 2, maxRepairCycles: 2, requiredReviews: ["standards", "spec"], implementationSkillTestingRequired: true, checks: [{ command: "node --check candidate.js", source: "standards", evidenceIdentity: "instructions" }], setupOperations: [] },
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

class SettledWorker implements WorkerRuntimePort {
  closed = 0;
  settled = true;
  outstandingJobs: string[] = [];
  async allocate(input: { workspaceId: string; agentName: string }): Promise<WorkerAllocation> { return { workspaceId: input.workspaceId, agentName: input.agentName, tabId: "tab", paneId: "pane" }; }
  async start(input: Parameters<WorkerRuntimePort["start"]>[0]): Promise<WorkerIdentity> {
    return { ...input.allocation, piPid: 42, sessionId: "worker-session", sessionFile: "/sessions/worker.jsonl", cwd: input.cwd, model: input.model, mode: "tui", initialHistoryEntries: 0, skillCommands: ["skill:implement", "skill:tdd", "skill:code-review", "skill:handoff"], toolNames: ["read", "bash", "edit", "write"], contextFiles: [join(input.cwd, "AGENTS.md")] };
  }
  async inspect(identity: WorkerIdentity): Promise<WorkerObservation> { return { identity, status: "done", settled: this.settled, outstandingJobs: this.outstandingJobs, artifactReferences: [] }; }
  async dispatchImplementation(identity: WorkerIdentity): Promise<WorkerObservation> { return { identity, status: "working", artifactReferences: [] }; }
  async deliverDecision(identity: WorkerIdentity): Promise<WorkerObservation> { return { identity, status: "working", artifactReferences: [] }; }
  async focus(): Promise<void> {}
  async close(): Promise<void> { this.closed += 1; }
}

class PassingAcceptance implements AcceptanceReviewPort, GateCheckPort {
  reviewSessions: string[] = [];
  failCheck = false;
  blockReview: "standards" | "spec" | undefined;
  reviewHook: ((input: Parameters<AcceptanceReviewPort["review"]>[0]) => Promise<void>) | undefined;
  reuseReviewSession = false;
  async review(input: Parameters<AcceptanceReviewPort["review"]>[0]) {
    await this.reviewHook?.(input);
    const freshSessionId = this.reuseReviewSession ? "reused-review-session" : `${input.kind}-fresh-${this.reviewSessions.length}`;
    this.reviewSessions.push(freshSessionId);
    const blocked = this.blockReview === input.kind;
    return { kind: input.kind, verdict: blocked ? "blocked" as const : "passed" as const, candidateCommit: input.candidateCommit, reviewBase: input.reviewBase, freshSessionId, findings: blocked ? ["blocking requirement mismatch"] : [], evidenceReference: `/evidence/${input.kind}.json`, completedAt: "2026-10-01T15:00:00.000Z" };
  }
  async execute(input: Parameters<GateCheckPort["execute"]>[0]) {
    return { command: input.command, exitCode: this.failCheck ? 1 : 0, outputDigest: "a".repeat(64), logReference: "/evidence/check.log", candidateCommit: input.candidateCommit, completedAt: "2026-10-01T15:00:00.000Z" };
  }
}

function value<T>(result: ControllerResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.diagnostics.join("\n"));
  return result.value;
}

async function running(
  repo: Repository,
  worker: SettledWorker,
  acceptance: PassingAcceptance,
  batch = proposal(repo),
  checks: GateCheckPort = acceptance,
) {
  const ids = ["preparation", "attempt", "receipt", "attempt-b", "receipt-b"];
  const controller = new PreparationController(new JsonControllerStateStore(repo.statePath), {
    actorCapability: actor,
    now: (): Date => new Date("2026-10-01T14:00:00.000Z"),
    generateId: (): string => ids.shift() ?? "fallback",
    formatPreview: formatPreparationPreview,
    execution: { owner: { instanceId: "controller", pid: 101 }, git: new RealGitWorktreeAdapter(), worker, acceptance: { reviewer: acceptance, checks } },
  });
  const prepared = value(await controller.prepare(actor, { specReference: "spec-2", controllerName: "example / issue 5" }, admission(repo)));
  const proposed = value(await controller.submitProposal(actor, prepared.id, batch));
  value(await controller.approve(actor, prepared.id, { approvedBy: "developer", proposalDigest: proposed.proposalDigest!, projectHead: repo.head, model: batch.model, evidence: batch.sourceEvidence.map((item) => ({ ...item, retrievedAt: "2026-10-01T13:00:00.000Z" })) }));
  const attempt = value(await controller.startTicket(actor, { preparationId: prepared.id, ticketIdentity: "ticket-a", workspaceId: "workspace" }));
  return { controller, attempt };
}

function nativeEvidence(receipt: CandidateReceipt) {
  return [
    { kind: "tests" as const, status: "passed" as const, candidateDigest: receipt.candidate.candidateDigest, evidenceReference: "/evidence/native-tests.json", completedAt: "2026-10-01T14:30:00.000Z" },
    { kind: "reviews" as const, status: "passed" as const, candidateDigest: receipt.candidate.candidateDigest, evidenceReference: "/evidence/native-reviews.json", completedAt: "2026-10-01T14:31:00.000Z" },
  ];
}

test("idle-looking workers with follow-ups or external jobs cannot produce a candidate receipt", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  worker.outstandingJobs = ["follow-up-review"];
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance);
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", artifactReferences: [] },
  }));

  const result = await active.controller.captureCandidate(actor, { attemptId: active.attempt.id });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.diagnostics.join("\n"), /cannot be captured|settled Pi lifecycle/);
});

test("missing and stale native implementation evidence cannot start integration", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const candidate = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));

  const missing = await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: [],
  });
  assert.equal(missing.ok, false);
  const stale = nativeEvidence(captured);
  stale[0]!.candidateDigest = "f".repeat(64);
  const rejected = await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: stale,
  });
  assert.equal(rejected.ok, false);
  assert.equal(acceptance.reviewSessions.length, 0);
  assert.equal(value(await active.controller.status(actor, { limit: 10 })).executionAttempts[0]?.lifecycle, "completed-unaccepted");
});

test("candidate changes after capture invalidate native evidence before staging", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const version = 1;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const version = 2;\n");

  const blocked = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  }));

  assert.equal(blocked.lifecycle, "integration-blocked");
  assert.match(blocked.candidateReceipts![0]!.findings.join("\n"), /Candidate changed/);
  assert.equal(blocked.candidateReceipts![0]!.integration, undefined);
  assert.equal(acceptance.reviewSessions.length, 0);
});

test("a failed approved check leaves the accepted batch branch unchanged and preserves candidate evidence", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  acceptance.failCheck = true;
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "syntax failure represented by adapter\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: ["/evidence/worker.json"] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));

  const blocked = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  }));

  assert.equal(blocked.lifecycle, "integration-blocked");
  const receipt = blocked.candidateReceipts![0]!;
  assert.equal(receipt.checks[0]?.exitCode, 1);
  assert.match(receipt.findings.join("\n"), /Approved check failed/);
  assert.equal(git(receipt.integration!.worktree.path, "rev-parse", "HEAD"), repo.head);
  assert.equal(await readFile(join(active.attempt.worktree!.path, "candidate.js"), "utf8"), "syntax failure represented by adapter\n");
  assert.equal(worker.closed, 0);
});

test("standards and spec reviews cannot reuse one reviewer session", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  acceptance.reuseReviewSession = true;
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const candidate = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));

  const blocked = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  }));

  assert.equal(blocked.lifecycle, "integration-blocked");
  assert.equal(blocked.candidateReceipts![0]!.reviews.length, 1);
  assert.match(blocked.candidateReceipts![0]!.findings.join("\n"), /non-fresh evidence/);
});

test("an unresolved standards review leaves the accepted batch branch unchanged", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  acceptance.blockReview = "standards";
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const candidate = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));

  const blocked = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  }));

  assert.equal(blocked.lifecycle, "integration-blocked");
  const receipt = blocked.candidateReceipts![0]!;
  assert.equal(receipt.reviews[0]?.verdict, "blocked");
  assert.match(receipt.findings.join("\n"), /blocking requirement mismatch/);
  assert.equal(git(receipt.integration!.worktree.path, "rev-parse", "HEAD"), repo.head);
});

test("an in-batch successor starts after its prerequisite commit is accepted on the batch branch", async (): Promise<void> => {
  const repo = await repository();
  const batch = proposal(repo);
  batch.sourceEvidence.push(evidence("ticket-b"));
  batch.tickets.push({ identity: "ticket-b", title: "Successor", evidenceIdentity: "ticket-b", claimedBy: null });
  batch.dependencies.push({ ticketIdentity: "ticket-b", prerequisiteIdentity: "ticket-a", kind: "ticket", status: "in-batch" });
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance, batch);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const prerequisite = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  const accepted = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  }));

  const successor = value(await active.controller.startTicket(actor, {
    preparationId: active.attempt.preparationId,
    ticketIdentity: "ticket-b",
    workspaceId: "workspace",
  }));

  assert.equal(successor.lifecycle, "running");
  assert.equal(successor.worktree?.head, accepted.acceptedCommit);
  assert.ok(accepted.acceptedCommit);
});

test("a real integration conflict preserves the last accepted branch and both ticket worktrees", async (): Promise<void> => {
  const repo = await repository();
  const batch = proposal(repo);
  batch.sourceEvidence.push(evidence("ticket-b"));
  batch.tickets.push({ identity: "ticket-b", title: "Conflicting candidate", evidenceIdentity: "ticket-b", claimedBy: null });
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance, batch);
  await writeFile(join(active.attempt.worktree!.path, "README.md"), "first accepted change\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const firstCapture = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  const first = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: firstCapture.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(firstCapture),
  }));
  const second = value(await active.controller.startTicket(actor, {
    preparationId: active.attempt.preparationId,
    ticketIdentity: "ticket-b",
    workspaceId: "workspace",
  }));
  await writeFile(join(second.worktree!.path, "README.md"), "second conflicting change\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: second.id,
    controlGeneration: second.controlGeneration ?? 0,
    observation: { identity: second.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const secondCapture = value(await active.controller.captureCandidate(actor, { attemptId: second.id }));

  const blocked = value(await active.controller.acceptCandidate(actor, {
    attemptId: second.id,
    candidateDigest: secondCapture.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(secondCapture),
  }));

  assert.equal(blocked.lifecycle, "integration-blocked");
  const integrationPath = first.candidateReceipts![0]!.integration!.worktree.path;
  assert.equal(git(integrationPath, "rev-parse", "HEAD"), first.acceptedCommit);
  assert.equal(await readFile(join(integrationPath, "README.md"), "utf8"), "first accepted change\n");
  assert.equal(await readFile(join(active.attempt.worktree!.path, "README.md"), "utf8"), "first accepted change\n");
  assert.equal(await readFile(join(second.worktree!.path, "README.md"), "utf8"), "second conflicting change\n");
});

test("a moving accepted base invalidates collected reviews instead of reusing them", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  let movingCommit = "";
  acceptance.reviewHook = async (input): Promise<void> => {
    if (input.kind !== "spec") return;
    const parent = dirname(input.cwd);
    const batchDirectory = (await readdir(parent)).find((entry): boolean => entry.startsWith("batch-"));
    assert.ok(batchDirectory);
    const integrationPath = join(parent, batchDirectory);
    await writeFile(join(integrationPath, "external-base.js"), "export const external = true;\n");
    git(integrationPath, "add", "external-base.js");
    git(integrationPath, "commit", "-qm", "advance accepted base externally");
    movingCommit = git(integrationPath, "rev-parse", "HEAD");
  };
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const candidate = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));

  const blocked = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  }));

  assert.equal(blocked.lifecycle, "integration-blocked");
  const integrationPath = blocked.candidateReceipts![0]!.integration!.worktree.path;
  assert.equal(git(integrationPath, "rev-parse", "HEAD"), movingCommit);
  await assert.rejects(readFile(join(integrationPath, "candidate.js"), "utf8"), { code: "ENOENT" });
});

test("the authenticated daemon client exposes candidate capture and acceptance", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const remote = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const socketPath = join(repo.root, ".git", "herdr", "acceptance.sock");
  const daemon = new LocalControllerDaemon(active.controller, actor, socketPath, "test-token");
  await daemon.start({ markRestarted: false });
  try {
    const client = new UnixControllerClient(socketPath, "test-token");
    const captured = value(await client.captureCandidate({ attemptId: active.attempt.id }));
    const accepted = value(await client.acceptCandidate({
      attemptId: active.attempt.id,
      candidateDigest: captured.candidate.candidateDigest,
      nativeEvidence: nativeEvidence(captured),
    }));
    assert.equal(accepted.lifecycle, "accepted");
  } finally {
    await daemon.close();
  }
});

test("approved gate commands execute independently in staging and retain their real exit log", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const realChecks = new LocalGateCheckAdapter(join(repo.root, ".git", "herdr", "test-check-evidence"), {
    now: (): Date => new Date("2026-10-01T15:00:00.000Z"),
    generateId: (): string => "real-check",
  });
  const batch = proposal(repo);
  batch.policy.checks[0]!.command = "node candidate.js";
  const active = await running(repo, worker, acceptance, batch, realChecks);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "console.log('token=temporary-test-value');\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));

  const accepted = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  }));

  const check = accepted.candidateReceipts![0]!.checks[0]!;
  assert.equal(check.exitCode, 0);
  const log = await readFile(check.logReference, "utf8");
  assert.match(log, /node candidate\.js/);
  assert.match(log, /token=\[REDACTED\]/);
  assert.equal(log.includes("temporary-test-value"), false);
  assert.equal(check.candidateCommit, accepted.acceptedCommit);
});

test("settled uncommitted candidate is reviewed, checked, integrated, persisted, and its owned worker closes", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const accepted = true;\n");
  const completed = value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: ["/evidence/implementation.json"] },
  }));
  assert.equal(completed.lifecycle, "completed-unaccepted", completed.diagnostics.join("\n"));

  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  const accepted = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  }));

  assert.equal(accepted.lifecycle, "accepted");
  assert.match(accepted.acceptedCommit ?? "", /^[a-f0-9]{40}$/);
  assert.equal(accepted.candidateReceipts?.[0]?.state, "accepted");
  assert.deepEqual(acceptance.reviewSessions, ["standards-fresh-0", "spec-fresh-1"]);
  assert.equal(worker.closed, 1);
  const integration = accepted.candidateReceipts![0]!.integration!.worktree;
  assert.equal(await readFile(join(integration.path, "candidate.js"), "utf8"), "export const accepted = true;\n");
  const restarted = new JsonControllerStateStore(repo.statePath);
  assert.equal((await restarted.load()).executionAttempts[0]?.acceptedCommit, accepted.acceptedCommit);
});
