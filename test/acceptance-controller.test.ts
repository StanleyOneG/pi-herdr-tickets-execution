import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  type ControllerState,
  type ControllerStateStore,
  type ExecutionAttempt,
  type GateCheckPort,
  type GateCheckRecord,
  type NativeEvidenceRecord,
  type NativeVerificationPort,
  type NativeVerificationRecord,
  type PreparationRecord,
  type SourceEvidence,
  type WorkerAllocation,
  type WorkerIdentity,
  type WorkerObservation,
  type WorkerRuntimePort,
} from "../src/controller.js";
import { LocalGateCheckAdapter } from "../src/gate-checks.js";
import { RealGitWorktreeAdapter } from "../src/git-worktrees.js";
import { FileNativeEvidenceAdapter } from "../src/native-evidence.js";
import { LocalControllerDaemon, UnixControllerClient } from "../src/local-daemon.js";
import { digest } from "../src/policy.js";
import { formatPreparationPreview } from "../src/presentation.js";
import { JsonControllerStateStore } from "../src/state-store.js";

interface Repository { root: string; statePath: string; head: string }
const roots = new Set<string>();
const evidenceRoots = new Set<string>();
const actor = Symbol("acceptance actor");

afterEach(async (): Promise<void> => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
    await rm(join(dirname(root), `.${basename(root)}-herdr-worktrees`), { recursive: true, force: true });
    roots.delete(root);
  }
  for (const root of evidenceRoots) {
    await rm(root, { recursive: true, force: true });
    evidenceRoots.delete(root);
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
  inspections = 0;
  settled = true;
  outstandingJobs: string[] = [];
  async allocate(input: { workspaceId: string; agentName: string }): Promise<WorkerAllocation> {
    return { workspaceId: input.workspaceId, agentName: input.agentName, tabId: `tab-${input.agentName}`, paneId: `pane-${input.agentName}` };
  }
  async start(input: Parameters<WorkerRuntimePort["start"]>[0]): Promise<WorkerIdentity> {
    return { ...input.allocation, piPid: 42, sessionId: `session-${input.allocation.agentName}`, sessionFile: `/sessions/${input.allocation.agentName}.jsonl`, cwd: input.cwd, model: input.model, mode: "tui", initialHistoryEntries: 0, skillCommands: ["skill:implement", "skill:tdd", "skill:code-review", "skill:handoff"], toolNames: ["read", "bash", "edit", "write", "subagent"], contextFiles: [join(input.cwd, "AGENTS.md")] };
  }
  async inspect(identity: WorkerIdentity): Promise<WorkerObservation> {
    this.inspections += 1;
    return { identity, status: "done", settled: this.settled, outstandingJobs: this.outstandingJobs, artifactReferences: [] };
  }
  async dispatchImplementation(identity: WorkerIdentity): Promise<WorkerObservation> { return { identity, status: "working", artifactReferences: [] }; }
  async deliverDecision(identity: WorkerIdentity): Promise<WorkerObservation> { return { identity, status: "working", artifactReferences: [] }; }
  async focus(): Promise<void> {}
  async close(): Promise<void> { this.closed += 1; }
}

class PassingAcceptance implements AcceptanceReviewPort, GateCheckPort, NativeVerificationPort {
  reviewSessions: string[] = [];
  nativeVerificationCalls: Array<Parameters<NativeVerificationPort["verify"]>[0]> = [];
  failCheck = false;
  blockReview: "standards" | "spec" | undefined;
  reviewHook: ((input: Parameters<AcceptanceReviewPort["review"]>[0]) => Promise<void>) | undefined;
  checkHook: ((input: Parameters<GateCheckPort["execute"]>[0]) => Promise<void>) | undefined;
  verificationHook: ((input: Parameters<NativeVerificationPort["verify"]>[0]) => Promise<void>) | undefined;
  reuseReviewSession = false;
  async review(input: Parameters<AcceptanceReviewPort["review"]>[0]): Promise<Awaited<ReturnType<AcceptanceReviewPort["review"]>>> {
    await this.reviewHook?.(input);
    const freshSessionId = this.reuseReviewSession ? "reused-review-session" : `${input.kind}-fresh-${this.reviewSessions.length}`;
    this.reviewSessions.push(freshSessionId);
    const blocked = this.blockReview === input.kind;
    return { kind: input.kind, verdict: blocked ? "blocked" as const : "passed" as const, candidateCommit: input.candidateCommit, reviewBase: input.reviewBase, freshSessionId, findings: blocked ? ["blocking requirement mismatch"] : [], evidenceReference: `/evidence/${input.kind}.json`, completedAt: "2026-10-01T15:00:00.000Z" };
  }
  async execute(input: Parameters<GateCheckPort["execute"]>[0]): Promise<GateCheckRecord> {
    await this.checkHook?.(input);
    return { command: input.command, exitCode: this.failCheck ? 1 : 0, outputDigest: "a".repeat(64), logReference: "/evidence/check.log", candidateCommit: input.candidateCommit, completedAt: "2026-10-01T15:00:00.000Z" };
  }
  async verify(input: Parameters<NativeVerificationPort["verify"]>[0]): Promise<NativeVerificationRecord> {
    this.nativeVerificationCalls.push(structuredClone(input));
    await this.verificationHook?.(input);
    return {
      status: "passed",
      candidateCommit: input.candidateCommit,
      codeStateDigest: input.codeStateDigest,
      freshSessionId: `native-verification-${this.nativeVerificationCalls.length}`,
      observedCommandDigests: ["b".repeat(64)],
      findings: [],
      evidenceReference: "/evidence/native-staging-verification.json",
      completedAt: "2026-10-01T15:00:00.000Z",
    };
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
  store: ControllerStateStore = new JsonControllerStateStore(repo.statePath),
): Promise<{ controller: PreparationController; attempt: ExecutionAttempt }> {
  const ids = ["preparation", "attempt", "receipt", "attempt-b", "receipt-b"];
  const controller = new PreparationController(store, {
    actorCapability: actor,
    now: (): Date => new Date("2026-10-01T14:00:00.000Z"),
    generateId: (): string => ids.shift() ?? "fallback",
    formatPreview: formatPreparationPreview,
    execution: {
      owner: { instanceId: "controller", pid: 101 },
      git: new RealGitWorktreeAdapter(),
      worker,
      acceptance: { reviewer: acceptance, checks, nativeEvidence: new FileNativeEvidenceAdapter(), nativeVerifier: acceptance },
    },
  });
  const prepared = value(await controller.prepare(actor, { specReference: "spec-2", controllerName: "example / issue 5" }, admission(repo)));
  const proposed = value(await controller.submitProposal(actor, prepared.id, batch));
  value(await controller.approve(actor, prepared.id, { approvedBy: "developer", proposalDigest: proposed.proposalDigest!, projectHead: repo.head, model: batch.model, evidence: batch.sourceEvidence.map((item) => ({ ...item, retrievedAt: "2026-10-01T13:00:00.000Z" })) }));
  const attempt = value(await controller.startTicket(actor, { preparationId: prepared.id, ticketIdentity: "ticket-a", workspaceId: "workspace" }));
  return { controller, attempt };
}

function nativeEvidence(receipt: CandidateReceipt): NativeEvidenceRecord[] {
  const directory = mkdtempSync(join(tmpdir(), "herdr-native-evidence-"));
  evidenceRoots.add(directory);
  return (["tests", "reviews"] as const).map((kind, index): NativeEvidenceRecord => {
    const completedAt = `2026-10-01T14:3${index}:00.000Z`;
    const retainedReference = join(directory, `${kind}.json`);
    const retainedArtifact = `${JSON.stringify({
      schemaVersion: 1,
      producer: "pi-native-skill",
      kind,
      status: "passed",
      codeStateDigest: receipt.candidate.codeStateDigest,
      completedAt,
      executionReferences: [receipt.sessionFile],
    })}\n`;
    writeFileSync(retainedReference, retainedArtifact, { mode: 0o600 });
    const artifact = `${JSON.stringify({
      schemaVersion: 1,
      kind,
      status: "passed",
      codeStateDigest: receipt.candidate.codeStateDigest,
      completedAt,
      artifacts: [{
        reference: retainedReference,
        digest: createHash("sha256").update(retainedArtifact).digest("hex"),
      }],
    })}\n`;
    const evidenceReference = join(directory, `${kind}-manifest.json`);
    writeFileSync(evidenceReference, artifact, { mode: 0o600 });
    return {
      kind,
      status: "passed",
      codeStateDigest: receipt.candidate.codeStateDigest,
      evidenceReference,
      evidenceDigest: createHash("sha256").update(artifact).digest("hex"),
      completedAt,
    };
  });
}

test("candidate capture denies a caller without capability before receipt, Git, or lifecycle mutation", async (): Promise<void> => {
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
  const beforeState = await readFile(repo.statePath, "utf8");
  const beforeStatus = git(active.attempt.worktree!.path, "status", "--porcelain=v1");
  const beforeInspections = worker.inspections;

  const denied = await active.controller.captureCandidate(Symbol("wrong actor"), { attemptId: active.attempt.id });

  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "authorization");
  assert.equal(await readFile(repo.statePath, "utf8"), beforeState);
  assert.equal(git(active.attempt.worktree!.path, "status", "--porcelain=v1"), beforeStatus);
  assert.equal(worker.inspections, beforeInspections);
  assert.equal(acceptance.reviewSessions.length, 0);
});

test("candidate acceptance denies a caller without capability before Git or lifecycle mutation", async (): Promise<void> => {
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
  const beforeState = await readFile(repo.statePath, "utf8");
  const beforeStatus = git(active.attempt.worktree!.path, "status", "--porcelain=v1");
  const beforeInspections = worker.inspections;

  const denied = await active.controller.acceptCandidate(Symbol("wrong actor"), {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  });

  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "authorization");
  assert.equal(await readFile(repo.statePath, "utf8"), beforeState);
  assert.equal(git(active.attempt.worktree!.path, "status", "--porcelain=v1"), beforeStatus);
  assert.equal(worker.inspections, beforeInspections);
  assert.equal(acceptance.reviewSessions.length, 0);
  assert.equal(worker.closed, 0);
});

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
  const unresolved = nativeEvidence(captured);
  unresolved[0]!.evidenceReference = join(repo.root, "missing-native-evidence.json");
  const unresolvedResult = await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: unresolved,
  });
  assert.equal(unresolvedResult.ok, false);
  const stale = nativeEvidence(captured);
  stale[0]!.codeStateDigest = "f".repeat(64);
  const rejected = await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: stale,
  });
  assert.equal(rejected.ok, false);
  assert.equal(acceptance.reviewSessions.length, 0);
  assert.equal(value(await active.controller.status(actor, { limit: 10 })).executionAttempts[0]?.lifecycle, "completed-unaccepted");
});

test("rewrapping stale native artifacts with the current code identity cannot authorize acceptance", async (): Promise<void> => {
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
  const obsolete = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  const relabelled = nativeEvidence(obsolete);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const version = 2;\n");
  const current = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  for (const record of relabelled) {
    const manifest = JSON.parse(await readFile(record.evidenceReference, "utf8")) as Record<string, unknown>;
    manifest.codeStateDigest = current.candidate.codeStateDigest;
    const serialized = `${JSON.stringify(manifest)}\n`;
    await writeFile(record.evidenceReference, serialized);
    record.codeStateDigest = current.candidate.codeStateDigest;
    record.evidenceDigest = createHash("sha256").update(serialized).digest("hex");
  }

  const rejected = await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: current.candidate.candidateDigest,
    nativeEvidence: relabelled,
  });

  assert.equal(rejected.ok, false);
  assert.equal(acceptance.reviewSessions.length, 0);
});

test("oversized native evidence artifacts are rejected at the acceptance boundary", async (): Promise<void> => {
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
  const evidence = nativeEvidence(captured);
  const oversized = Buffer.alloc(1024 * 1024 + 1, "x");
  await writeFile(evidence[0]!.evidenceReference, oversized);
  evidence[0]!.evidenceDigest = createHash("sha256").update(oversized).digest("hex");

  const rejected = await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: evidence,
  });

  assert.equal(rejected.ok, false);
  assert.equal(acceptance.reviewSessions.length, 0);
});

test("nonregular native evidence artifacts are rejected at the acceptance boundary", async (): Promise<void> => {
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
  const evidence = nativeEvidence(captured);
  const fifo = join(dirname(evidence[0]!.evidenceReference), "native-evidence.fifo");
  execFileSync("mkfifo", [fifo]);
  evidence[0]!.evidenceReference = fifo;

  const rejected = await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: evidence,
  });

  assert.equal(rejected.ok, false);
  assert.equal(acceptance.reviewSessions.length, 0);
});

test("candidate staging rejects destination symlink ancestors before copying untracked files", async (): Promise<void> => {
  const repo = await repository();
  const gitAdapter = new RealGitWorktreeAdapter();
  const outside = await mkdtemp(join(tmpdir(), "herdr-stage-outside-"));
  evidenceRoots.add(outside);
  const integration = await gitAdapter.prepareIntegrationWorktree({
    originalRoot: repo.root,
    preparationId: "symlink-ancestor",
    targetBase: repo.head,
  });
  await symlink(outside, join(integration.path, "escape"));
  git(integration.path, "add", "escape");
  git(integration.path, "commit", "-qm", "tracked destination symlink");
  const currentIntegration = { ...await gitAdapter.inspectWorktree(integration.path), preparationId: integration.preparationId };
  await mkdir(join(repo.root, "escape"));
  await writeFile(join(repo.root, "escape", "payload.txt"), "must not escape staging\n");
  const candidate = await gitAdapter.captureCandidate({ path: repo.root, sourceBase: repo.head });

  await assert.rejects(gitAdapter.stageCandidate({
    originalRoot: repo.root,
    preparationId: "symlink-ancestor",
    attemptId: "attempt-symlink",
    receiptId: "receipt-symlink",
    integration: currentIntegration,
    sourcePath: repo.root,
    candidate,
  }), /symbolic link ancestor/);
  await assert.rejects(readFile(join(outside, "payload.txt")), { code: "ENOENT" });
});

test("content-equivalent staging and later commits retain native evidence through Git code-state identity", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const version = 1;\n");
  await rm(join(active.attempt.worktree!.path, "README.md"));
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const beforeCommit = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  const retainedEvidence = nativeEvidence(beforeCommit);
  git(active.attempt.worktree!.path, "add", "-A");
  const afterStaging = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  git(active.attempt.worktree!.path, "commit", "-qm", "candidate commit");
  const afterCommit = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));

  assert.notEqual(afterStaging.candidate.candidateDigest, beforeCommit.candidate.candidateDigest);
  assert.notEqual(afterCommit.candidate.candidateDigest, beforeCommit.candidate.candidateDigest);
  assert.equal(afterStaging.candidate.codeStateDigest, beforeCommit.candidate.codeStateDigest);
  assert.equal(afterCommit.candidate.codeStateDigest, beforeCommit.candidate.codeStateDigest);
  const accepted = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: afterCommit.candidate.candidateDigest,
    nativeEvidence: retainedEvidence,
  }));
  assert.equal(accepted.lifecycle, "accepted");
});

test("changed code state cannot reuse otherwise valid native evidence", async (): Promise<void> => {
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
  const first = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  const staleEvidence = nativeEvidence(first);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const version = 2;\n");
  const changed = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));

  const rejected = await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: changed.candidate.candidateDigest,
    nativeEvidence: staleEvidence,
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

test("acceptance serializes against the persisted integration head rather than attempt order", async (): Promise<void> => {
  const repo = await repository();
  const batch = proposal(repo);
  batch.sourceEvidence.push(evidence("ticket-b"), evidence("ticket-c"));
  batch.tickets.push(
    { identity: "ticket-b", title: "Second", evidenceIdentity: "ticket-b", claimedBy: null },
    { identity: "ticket-c", title: "Third", evidenceIdentity: "ticket-c", claimedBy: null },
  );
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance, batch);
  await writeFile(join(active.attempt.worktree!.path, "a.js"), "export const a = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const second = value(await active.controller.startTicket(actor, {
    preparationId: active.attempt.preparationId,
    ticketIdentity: "ticket-b",
    workspaceId: "workspace",
  }));
  await writeFile(join(second.worktree!.path, "b.js"), "export const b = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: second.id,
    controlGeneration: second.controlGeneration ?? 0,
    observation: { identity: second.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const firstCapture = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  const secondCapture = value(await active.controller.captureCandidate(actor, { attemptId: second.id }));
  value(await active.controller.acceptCandidate(actor, {
    attemptId: second.id,
    candidateDigest: secondCapture.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(secondCapture),
  }));
  const acceptedFirst = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: firstCapture.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(firstCapture),
  }));
  assert.equal(acceptance.nativeVerificationCalls.length, 1);
  assert.equal(
    acceptance.nativeVerificationCalls[0]?.codeStateDigest,
    acceptedFirst.candidateReceipts![0]!.integration!.stagedCodeStateDigest,
  );
  assert.equal(
    acceptedFirst.candidateReceipts![0]!.integration!.nativeVerification?.candidateCommit,
    acceptedFirst.acceptedCommit,
  );
  const third = value(await active.controller.startTicket(actor, {
    preparationId: active.attempt.preparationId,
    ticketIdentity: "ticket-c",
    workspaceId: "workspace",
  }));
  await writeFile(join(third.worktree!.path, "c.js"), "export const c = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: third.id,
    controlGeneration: third.controlGeneration ?? 0,
    observation: { identity: third.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const thirdCapture = value(await active.controller.captureCandidate(actor, { attemptId: third.id }));

  const acceptedThird = value(await active.controller.acceptCandidate(actor, {
    attemptId: third.id,
    candidateDigest: thirdCapture.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(thirdCapture),
  }));

  assert.equal(acceptedThird.lifecycle, "accepted");
  assert.equal(acceptedThird.candidateReceipts![0]!.integration!.sequence, 3);
  const integrationPath = acceptedFirst.candidateReceipts![0]!.integration!.worktree.path;
  assert.equal(git(integrationPath, "rev-parse", "HEAD"), acceptedThird.acceptedCommit);
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

test("staged changes during required native re-verification block batch advancement", async (): Promise<void> => {
  const repo = await repository();
  const batch = proposal(repo);
  batch.sourceEvidence.push(evidence("ticket-b"));
  batch.tickets.push({ identity: "ticket-b", title: "Second", evidenceIdentity: "ticket-b", claimedBy: null });
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance, batch);
  await writeFile(join(active.attempt.worktree!.path, "a.js"), "export const a = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const second = value(await active.controller.startTicket(actor, {
    preparationId: active.attempt.preparationId,
    ticketIdentity: "ticket-b",
    workspaceId: "workspace",
  }));
  await writeFile(join(second.worktree!.path, "b.js"), "export const b = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: second.id,
    controlGeneration: second.controlGeneration ?? 0,
    observation: { identity: second.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const firstCapture = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  const first = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: firstCapture.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(firstCapture),
  }));
  const secondCapture = value(await active.controller.captureCandidate(actor, { attemptId: second.id }));
  acceptance.verificationHook = async (input): Promise<void> => {
    await writeFile(join(input.cwd, "verification-mutation.js"), "unexpected\n");
  };

  const blocked = value(await active.controller.acceptCandidate(actor, {
    attemptId: second.id,
    candidateDigest: secondCapture.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(secondCapture),
  }));

  assert.equal(blocked.lifecycle, "integration-blocked");
  assert.match(blocked.candidateReceipts![0]!.findings.join("\n"), /changed during native verification/);
  const integrationPath = first.candidateReceipts![0]!.integration!.worktree.path;
  assert.equal(git(integrationPath, "rev-parse", "HEAD"), first.acceptedCommit);
});

test("untracked add/add collisions block integration without overwriting accepted work", async (): Promise<void> => {
  const repo = await repository();
  const batch = proposal(repo);
  batch.sourceEvidence.push(evidence("ticket-b"));
  batch.tickets.push({ identity: "ticket-b", title: "Colliding candidate", evidenceIdentity: "ticket-b", claimedBy: null });
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance, batch);
  await writeFile(join(active.attempt.worktree!.path, "shared.js"), "export const owner = 'a';\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const second = value(await active.controller.startTicket(actor, {
    preparationId: active.attempt.preparationId,
    ticketIdentity: "ticket-b",
    workspaceId: "workspace",
  }));
  await writeFile(join(second.worktree!.path, "shared.js"), "export const owner = 'b';\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: second.id,
    controlGeneration: second.controlGeneration ?? 0,
    observation: { identity: second.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const firstCapture = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  const first = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: firstCapture.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(firstCapture),
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
  assert.equal(await readFile(join(integrationPath, "shared.js"), "utf8"), "export const owner = 'a';\n");
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
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), [
    "console.log('Authorization: Bearer temporary-test-value');",
    "console.log('postgres://user:password@database.invalid/app');",
    "console.log('Error: private stack detail\\n    at secret (/private/source.js:1:1)');",
    "console.log('src/file.ts(1,1): error TS2345: private compiler detail');",
    "console.log(\"# tests 3\\n# pass 2\\n# fail 1\\nfailureType: 'testCodeFailure'\\nfailureType: 'passwordSecret'\");",
    "",
  ].join("\n"));
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
  const metadata = JSON.parse(log) as Record<string, unknown>;
  assert.equal(metadata.outputOmitted, true);
  assert.equal(metadata.exitCode, 0);
  assert.equal(metadata.candidateCommit, accepted.acceptedCommit);
  assert.equal(typeof metadata.commandDigest, "string");
  assert.equal(typeof metadata.outputDigest, "string");
  assert.deepEqual(metadata.diagnostics, {
    compilerErrorCodes: ["TS2345"],
    testFailureTypes: ["testCodeFailure"],
    testSummary: { tests: 3, pass: 2, fail: 1 },
  });
  assert.equal(log.includes("temporary-test-value"), false);
  assert.equal(log.includes("postgres://"), false);
  assert.equal(log.includes("private stack detail"), false);
  assert.equal(log.includes("passwordSecret"), false);
  assert.equal(log.includes("node candidate.js"), false);
  assert.equal(check.candidateCommit, accepted.acceptedCommit);
});

test("original checkout changes during acceptance prevent batch advancement", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  acceptance.reviewHook = async (input): Promise<void> => {
    if (input.kind === "spec") await writeFile(join(repo.root, "README.md"), "unexpected original mutation\n");
  };
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const candidate = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));

  const stopped = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  }));

  assert.equal(stopped.lifecycle, "needs-attention");
  assert.match(stopped.diagnostics.join("\n"), /Original checkout changed/);
  const integrationPath = stopped.candidateReceipts![0]!.integration!.worktree.path;
  assert.equal(git(integrationPath, "rev-parse", "HEAD"), repo.head);
  assert.equal(worker.closed, 0);
});

test("implementation worker follow-up work appearing during reviews prevents integration and cleanup", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  acceptance.reviewHook = async (input): Promise<void> => {
    if (input.kind === "spec") worker.outstandingJobs = ["late-follow-up"];
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
  assert.match(blocked.candidateReceipts![0]!.findings.join("\n"), /outstanding jobs/);
  const integrationPath = blocked.candidateReceipts![0]!.integration!.worktree.path;
  assert.equal(git(integrationPath, "rev-parse", "HEAD"), repo.head);
  assert.equal(worker.closed, 0);
});

test("takeover remains prompt during a delayed acceptance gate and prevents advancement or cleanup", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  let releaseCheck!: () => void;
  let reportCheckStarted!: () => void;
  const checkStarted = new Promise<void>((resolve): void => { reportCheckStarted = resolve; });
  const checkRelease = new Promise<void>((resolve): void => { releaseCheck = resolve; });
  acceptance.checkHook = async (): Promise<void> => {
    reportCheckStarted();
    await checkRelease;
  };
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const candidate = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  const accepting = active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  });
  await checkStarted;

  const takeover = await Promise.race([
    active.controller.takeOverAttempt(actor, { attemptId: active.attempt.id }),
    new Promise<never>((_resolve, reject): void => {
      setTimeout((): void => reject(new Error("takeover queued behind delayed gate")), 500);
    }),
  ]);
  assert.equal(value(takeover).lifecycle, "takeover");
  releaseCheck();
  const interrupted = await accepting;

  assert.equal(interrupted.ok, false);
  const status = value(await active.controller.status(actor, { limit: 10 })).executionAttempts[0]!;
  assert.equal(status.lifecycle, "takeover");
  assert.equal(status.acceptedCommit, undefined);
  assert.equal(worker.closed, 0);
  const integrationPath = status.candidateReceipts![0]!.integration!.worktree.path;
  assert.equal(git(integrationPath, "rev-parse", "HEAD"), repo.head);
});

test("explicit restart resume reconciles a durably journaled batch advancement", async (): Promise<void> => {
  const repo = await repository();
  const durable = new JsonControllerStateStore(repo.statePath);
  let failedAcceptedSave = false;
  const failAfterAdvance: ControllerStateStore = {
    load: (): Promise<ControllerState> => durable.load(),
    save: async (state: ControllerState): Promise<void> => {
      if (!failedAcceptedSave && state.executionAttempts.some((attempt): boolean => attempt.lifecycle === "accepted")) {
        failedAcceptedSave = true;
        throw new Error("simulated storage interruption after Git advancement");
      }
      await durable.save(state);
    },
  };
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance, proposal(repo), acceptance, failAfterAdvance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const journalled = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));

  const interrupted = await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  });
  assert.equal(interrupted.ok, false);
  const pending = await durable.load();
  assert.equal(pending.executionAttempts[0]?.lifecycle, "accepting");
  assert.equal(pending.preparations[0]?.pendingIntegration?.attemptId, active.attempt.id);

  const replacement = new PreparationController(durable, {
    actorCapability: actor,
    now: (): Date => new Date("2026-10-01T16:00:00.000Z"),
    generateId: (): string => "replacement-receipt",
    formatPreview: formatPreparationPreview,
    execution: {
      owner: { instanceId: "replacement-controller", pid: 202 },
      git: new RealGitWorktreeAdapter(),
      worker,
      acceptance: { reviewer: acceptance, checks: acceptance, nativeEvidence: new FileNativeEvidenceAdapter(), nativeVerifier: acceptance },
    },
  });
  value(await replacement.controllerRestarted(actor));

  const reconciled = value(await replacement.resumeAttempt(actor, { attemptId: active.attempt.id }));

  assert.equal(reconciled.lifecycle, "accepted");
  assert.equal(reconciled.acceptedCommit, pending.preparations[0]!.pendingIntegration!.toCommit);
  assert.equal(value(await replacement.status(actor, { limit: 10 })).preparations[0]?.pendingIntegration, undefined);
});

test("final batch advancement disables project Git hooks", async (): Promise<void> => {
  const repo = await repository();
  const hook = join(repo.root, ".git", "hooks", "post-merge");
  writeFileSync(hook, [
    "#!/bin/sh",
    "echo hook-ran > hook-ran.txt",
    "git add hook-ran.txt",
    "git -c user.name=Hook -c user.email=hook@example.invalid commit -qm 'hook commit'",
    "",
  ].join("\n"));
  chmodSync(hook, 0o755);
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const hooksAreDisabled = true;\n");
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

  assert.equal(accepted.lifecycle, "accepted");
  const integrationPath = accepted.candidateReceipts![0]!.integration!.worktree.path;
  await assert.rejects(readFile(join(integrationPath, "hook-ran.txt")), { code: "ENOENT" });
  assert.equal(git(integrationPath, "rev-parse", "HEAD"), accepted.acceptedCommit);
});

test("gate timeouts kill the complete process group before reporting the result", async (): Promise<void> => {
  const repo = await repository();
  const evidenceDirectory = join(repo.root, ".gate-timeout-evidence");
  const descendantPidPath = join(repo.root, "gate-descendant.pid");
  const checks = new LocalGateCheckAdapter(evidenceDirectory, { timeoutMs: 25, generateId: () => "timeout" });
  const startedAt = Date.now();
  const result = await checks.execute({
    cwd: repo.root,
    command: `sh -c 'trap "" TERM; echo $$ > "${descendantPidPath}"; exec >/dev/null 2>&1; while :; do sleep 1; done' & wait`,
    candidateCommit: repo.head,
  });
  assert.equal(result.exitCode, 1);
  assert.ok(Date.now() - startedAt < 4_000);
  const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
  assert.throws((): void => { process.kill(descendantPid, 0); }, (error: unknown): boolean =>
    (error as NodeJS.ErrnoException).code === "ESRCH");
  const metadata = JSON.parse(await readFile(result.logReference, "utf8")) as Record<string, unknown>;
  assert.equal(metadata.termination, "timeout");
  assert.equal(metadata.outputOmitted, true);
});

test("gate termination verification failures reject instead of detaching cleanup", async (): Promise<void> => {
  const repo = await repository();
  const checks = new LocalGateCheckAdapter(join(repo.root, ".gate-verification-evidence"), {
    timeoutMs: 25,
    waitForProcessGroupExit: async (): Promise<void> => {
      throw new Error("controlled process group verification failure");
    },
  });

  await assert.rejects(checks.execute({
    cwd: repo.root,
    command: "exec >/dev/null 2>&1; while :; do sleep 1; done",
    candidateCommit: repo.head,
  }), /controlled process group verification failure/);
});

test("acceptance integration does not consume implementation concurrency while another ticket runs", async (): Promise<void> => {
  const repo = await repository();
  const batch = proposal(repo);
  batch.policy.concurrency = 2;
  batch.sourceEvidence.push(evidence("ticket-b"));
  batch.tickets.push({ identity: "ticket-b", title: "Concurrent implementation", evidenceIdentity: "ticket-b", claimedBy: null });
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance, batch);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const acceptedWhileRunning = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const captured = value(await active.controller.captureCandidate(actor, { attemptId: active.attempt.id }));
  const second = value(await active.controller.startTicket(actor, {
    preparationId: active.attempt.preparationId,
    ticketIdentity: "ticket-b",
    workspaceId: "workspace",
  }));
  assert.equal(second.lifecycle, "running");

  const accepted = value(await active.controller.acceptCandidate(actor, {
    attemptId: active.attempt.id,
    candidateDigest: captured.candidate.candidateDigest,
    nativeEvidence: nativeEvidence(captured),
  }));

  assert.equal(accepted.lifecycle, "accepted");
  const attempts = value(await active.controller.status(actor, { limit: 10 })).executionAttempts;
  assert.equal(attempts.find((attempt): boolean => attempt.id === second.id)?.lifecycle, "running");
});

test("legacy approved state without integration metadata migrates to its approved base", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance);
  const legacy = JSON.parse(await readFile(repo.statePath, "utf8")) as {
    preparations: Array<{ batchIntegration?: unknown }>;
  };
  delete legacy.preparations[0]!.batchIntegration;
  await writeFile(repo.statePath, `${JSON.stringify(legacy, null, 2)}\n`);

  const status = value(await active.controller.status(actor, { limit: 10 }));

  assert.deepEqual(status.preparations[0]?.batchIntegration, { head: repo.head, sequence: 0 });
});

test("completed candidates require explicit resume after controller restart", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const restart = true;\n");
  value(await active.controller.recordWorkerObservation(actor, {
    attemptId: active.attempt.id,
    controlGeneration: active.attempt.controlGeneration ?? 0,
    observation: { identity: active.attempt.worker!, status: "done", settled: true, outstandingJobs: [], artifactReferences: [] },
  }));
  const replacement = new PreparationController(new JsonControllerStateStore(repo.statePath), {
    actorCapability: actor,
    now: (): Date => new Date("2026-10-01T16:00:00.000Z"),
    generateId: (): string => "replacement-receipt",
    formatPreview: formatPreparationPreview,
    execution: {
      owner: { instanceId: "replacement-controller", pid: 202 },
      git: new RealGitWorktreeAdapter(),
      worker,
      acceptance: { reviewer: acceptance, checks: acceptance, nativeEvidence: new FileNativeEvidenceAdapter(), nativeVerifier: acceptance },
    },
  });

  const reconciled = value(await replacement.controllerRestarted(actor));
  assert.equal(reconciled[0]?.lifecycle, "restart-required");
  const beforeResume = await replacement.captureCandidate(actor, { attemptId: active.attempt.id });
  assert.equal(beforeResume.ok, false);
  const resumed = value(await replacement.resumeAttempt(actor, { attemptId: active.attempt.id }));
  assert.equal(resumed.lifecycle, "completed-unaccepted");
  assert.equal(value(await replacement.captureCandidate(actor, { attemptId: active.attempt.id })).state, "captured");
});

test("integration-blocked attempts regain ownership only through restart reconciliation and explicit resume", async (): Promise<void> => {
  const repo = await repository();
  const batch = proposal(repo);
  batch.policy.concurrency = 2;
  batch.sourceEvidence.push(evidence("ticket-b"));
  batch.tickets.push({ identity: "ticket-b", title: "Still running", evidenceIdentity: "ticket-b", claimedBy: null });
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  acceptance.failCheck = true;
  const active = await running(repo, worker, acceptance, batch);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const retry = true;\n");
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
  const concurrent = value(await active.controller.startTicket(actor, {
    preparationId: active.attempt.preparationId,
    ticketIdentity: "ticket-b",
    workspaceId: "workspace",
  }));
  assert.equal(concurrent.lifecycle, "running");
  const replacement = new PreparationController(new JsonControllerStateStore(repo.statePath), {
    actorCapability: actor,
    now: (): Date => new Date("2026-10-01T16:00:00.000Z"),
    generateId: (): string => "replacement-receipt",
    formatPreview: formatPreparationPreview,
    execution: {
      owner: { instanceId: "replacement-controller", pid: 202 },
      git: new RealGitWorktreeAdapter(),
      worker,
      acceptance: {
        reviewer: acceptance,
        checks: acceptance,
        nativeEvidence: new FileNativeEvidenceAdapter(),
        nativeVerifier: acceptance,
      },
    },
  });

  const reconciled = value(await replacement.controllerRestarted(actor));
  assert.equal(reconciled.length, 2);
  assert.equal(reconciled.find((attempt): boolean => attempt.id === active.attempt.id)?.lifecycle, "restart-required");
  const beforeResume = await replacement.captureCandidate(actor, { attemptId: active.attempt.id });
  assert.equal(beforeResume.ok, false);
  const resumed = value(await replacement.resumeAttempt(actor, { attemptId: active.attempt.id }));
  assert.equal(resumed.lifecycle, "completed-unaccepted");
  const recaptured = value(await replacement.captureCandidate(actor, { attemptId: active.attempt.id }));
  assert.equal(recaptured.state, "captured");
});

test("cleanup closes only an unchanged clean candidate with exact settled ownership", async (): Promise<void> => {
  const repo = await repository();
  const worker = new SettledWorker();
  const acceptance = new PassingAcceptance();
  const active = await running(repo, worker, acceptance);
  await writeFile(join(active.attempt.worktree!.path, "candidate.js"), "export const clean = true;\n");
  git(active.attempt.worktree!.path, "add", "candidate.js");
  git(active.attempt.worktree!.path, "commit", "-qm", "clean candidate");
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

  assert.equal(accepted.lifecycle, "accepted");
  assert.equal(accepted.candidateReceipts![0]!.cleanup, "closed");
  assert.equal(worker.closed, 1);
});

test("settled uncommitted candidate is reviewed, checked, integrated, persisted, and its dirty worker remains open", async (): Promise<void> => {
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
  assert.equal(worker.closed, 0);
  const integration = accepted.candidateReceipts![0]!.integration!.worktree;
  assert.equal(await readFile(join(integration.path, "candidate.js"), "utf8"), "export const accepted = true;\n");
  const restarted = new JsonControllerStateStore(repo.statePath);
  assert.equal((await restarted.load()).executionAttempts[0]?.acceptedCommit, accepted.acceptedCommit);
});
