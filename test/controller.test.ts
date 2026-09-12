import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PreparationController,
  type AdmissionSnapshot,
  type ApprovalRequest,
  type BatchProposal,
  type ControllerResult,
  type ControllerStateStore,
  type ControllerStatus,
  type PreparationRecord,
  type SourceEvidence,
} from "../src/controller.js";
import { JsonControllerStateStore } from "../src/state-store.js";

interface TestRepository {
  root: string;
  statePath: string;
  head: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repository(): Promise<TestRepository> {
  const root = await mkdtemp(join(tmpdir(), "herdr-controller-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test User");
  execFileSync("sh", ["-c", "printf project > README.md"], { cwd: root });
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "initial");
  return { root, statePath: join(root, ".state", "controller.json"), head: git(root, "rev-parse", "HEAD") };
}

function testController(
  statePath: string,
  options: { now?: string; ids?: string[] } = {},
): PreparationController {
  const ids = [...(options.ids ?? ["preparation-1", "preparation-2", "preparation-3"])];
  return new PreparationController(new JsonControllerStateStore(statePath), {
    now: () => new Date(options.now ?? "2026-09-12T14:00:00.000Z"),
    generateId: () => ids.shift() ?? "preparation-fallback",
  });
}

function expectValue<T>(result: ControllerResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.diagnostics.join("\n"));
  return result.value;
}

function expectDiagnostics<T>(result: ControllerResult<T>, diagnostics: string[]): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.diagnostics, diagnostics);
}

function admitted(root: string, head: string): AdmissionSnapshot {
  return {
    project: { root, identity: "example/project", head, branch: "main", instructionFiles: [join(root, "AGENTS.md")] },
    runtime: {
      platform: process.platform === "darwin" ? "darwin" : "linux",
      piVersion: "0.85.1",
      herdrVersion: "0.8.2",
      projectTrusted: true,
      skillCommands: ["skill:implement", "skill:tdd", "skill:code-review", "skill:handoff"],
      toolNames: ["read", "bash", "herdr_submit_batch_proposal", "herdr_get_preparation", "herdr_approve_batch"],
    },
    model: {
      provider: "test",
      id: "reasoner",
      thinkingLevel: "high",
      contextWindow: 220_000,
      authenticated: true,
      available: true,
    },
  };
}

function evidence(
  identity: string,
  revision: string,
  options: { retrievedAt?: string; references?: string[]; content?: string } = {},
): SourceEvidence {
  return {
    identity,
    revision,
    contentDigest: createHash("sha256").update(options.content ?? `${identity}:${revision}`).digest("hex"),
    retrievedAt: options.retrievedAt ?? "2026-09-12T12:00:00.000Z",
    references: options.references ?? [`https://tracker.invalid/${identity}`],
  };
}

function validProposal(head: string, controllerName = "example / spec 2"): BatchProposal {
  return {
    schemaVersion: 1,
    controllerName,
    project: {
      identity: "example/project",
      tracker: {
        identity: "custom-tracker:example",
        instructionSources: ["AGENTS.md", "docs/agents/issue-tracker.md"],
        instructionEvidenceIdentities: ["instructions", "coding-standards"],
      },
    },
    sourceEvidence: [
      evidence("spec-2", "spec-v1"),
      evidence("ticket-a", "a-v1"),
      evidence("ticket-b", "b-v1"),
      evidence("external-service", "ready-v1"),
      evidence("instructions", "instructions-v1"),
      evidence("coding-standards", "checks-v1"),
    ],
    spec: { identity: "tracker:spec-2", title: "Feature spec", evidenceIdentity: "spec-2" },
    tickets: [
      { identity: "ticket-a", title: "First", evidenceIdentity: "ticket-a", claimedBy: null },
      { identity: "ticket-b", title: "Second", evidenceIdentity: "ticket-b", claimedBy: "other-user" },
    ],
    dependencies: [
      { ticketIdentity: "ticket-b", prerequisiteIdentity: "ticket-a", kind: "ticket", status: "in-batch" },
      {
        ticketIdentity: "ticket-a",
        prerequisiteIdentity: "external:service",
        kind: "external",
        status: "resolved",
        evidenceIdentity: "external-service",
      },
    ],
    target: { branch: "main", baseCommit: head },
    model: { provider: "test", id: "reasoner", thinkingLevel: "high", contextWindow: 220_000 },
    policy: {
      concurrency: 2,
      context: { requestedHandoffTokens: 190_000, reserveTokens: 22_000 },
      maxHandoffReplacements: 2,
      maxRepairCycles: 2,
      requiredReviews: ["standards", "spec"],
      implementationSkillTestingRequired: true,
      checks: [
        { command: "npm test", source: "CODING_STANDARDS.md", evidenceIdentity: "coding-standards" },
      ],
      setupOperations: [
        { kind: "dependency-install", packageManager: "npm", mode: "frozen", purpose: "Install dependencies" },
      ],
    },
    resources: [
      { kind: "dependencies", description: "node_modules", isolation: "isolated" },
      { kind: "environment", description: "test configuration", isolation: "shared-safe" },
      { kind: "database", description: "per-worktree SQLite", isolation: "isolated" },
      { kind: "port", description: "allocated test port", isolation: "isolated" },
      { kind: "external", description: "tracker is read-only during preparation", isolation: "shared-safe" },
    ],
    ambiguities: [],
  };
}

function approvalRequest(
  head: string,
  options: { retrievedAt?: string; evidence?: SourceEvidence[] } = {},
): ApprovalRequest {
  const retrieval = { retrievedAt: options.retrievedAt ?? "2026-09-12T13:00:00.000Z" };
  return {
    approvedBy: "developer@example.invalid",
    projectHead: head,
    model: validProposal(head).model,
    evidence: options.evidence ?? [
      evidence("spec-2", "spec-v1", retrieval),
      evidence("ticket-a", "a-v1", retrieval),
      evidence("ticket-b", "b-v1", retrieval),
      evidence("external-service", "ready-v1", retrieval),
      evidence("instructions", "instructions-v1", retrieval),
      evidence("coding-standards", "checks-v1", retrieval),
    ],
  };
}

async function preparedProposal(
  controller: PreparationController,
  repo: TestRepository,
  controllerName = "example / spec 2",
): Promise<PreparationRecord> {
  const prepared = expectValue(
    await controller.prepare({ specReference: "tracker:spec-2", controllerName }, admitted(repo.root, repo.head)),
  );
  return expectValue(await controller.submitProposal(prepared.id, validProposal(repo.head, controllerName)));
}

test("preparation returns admission blockers without writing batch state", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const snapshot = admitted(repo.root, repo.head);
  snapshot.runtime.projectTrusted = false;
  snapshot.runtime.skillCommands = ["skill:implement"];
  snapshot.runtime.toolNames = ["read"];
  snapshot.model.authenticated = false;
  snapshot.model.available = false;
  snapshot.model.authError = "credential command failed";

  const result = await controller.prepare(
    { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
    snapshot,
  );
  expectDiagnostics(result, [
    "Project trust is unresolved",
    "Missing native skill commands: /skill:code-review, /skill:handoff, /skill:tdd",
    "Missing required Pi tools: bash, herdr_approve_batch, herdr_get_preparation, herdr_submit_batch_proposal",
    "Selected model test/reasoner has unusable authentication: credential command failed",
    "Selected model test/reasoner is unavailable in this Pi session",
  ]);
  await assert.rejects(readFile(repo.statePath, "utf8"), { code: "ENOENT" });
});

test("preparation captures the selected model and creates no execution attempt", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const status = expectValue(await controller.status());

  assert.equal(prepared.id, "preparation-1");
  assert.deepEqual(prepared.model, {
    provider: "test",
    id: "reasoner",
    thinkingLevel: "high",
    contextWindow: 220_000,
  });
  assert.equal(status.executionAttempts.length, 0);
});

test("proposal rejects missing ticket references and dependency cycles", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  proposal.dependencies = [
    { ticketIdentity: "ticket-a", prerequisiteIdentity: "ticket-b", kind: "ticket", status: "in-batch" },
    { ticketIdentity: "ticket-b", prerequisiteIdentity: "ticket-a", kind: "ticket", status: "in-batch" },
    { ticketIdentity: "ticket-a", prerequisiteIdentity: "ticket-missing", kind: "ticket", status: "in-batch" },
  ];
  proposal.sourceEvidence = proposal.sourceEvidence.filter((source) => source.identity !== "external-service");

  expectDiagnostics(await controller.submitProposal(prepared.id, proposal), [
    "Dependency references missing ticket: ticket-missing",
    "Ticket dependency graph contains a cycle: ticket-a -> ticket-b -> ticket-a",
  ]);
});

test("external prerequisites cannot use in-batch status to bypass resolution evidence", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  proposal.dependencies[1] = {
    ticketIdentity: "ticket-a",
    prerequisiteIdentity: "external:service",
    kind: "external",
    status: "in-batch",
    evidenceIdentity: "external-service",
  };

  expectDiagnostics(await controller.submitProposal(prepared.id, proposal), [
    "External prerequisite is unresolved: external:service",
  ]);
});

test("source registry allows deliberate evidence reuse across proposal fields", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  assert.equal(proposal.project.tracker.instructionEvidenceIdentities.includes("coding-standards"), true);
  assert.equal(proposal.policy.checks[0]!.evidenceIdentity, "coding-standards");

  expectValue(await controller.submitProposal(prepared.id, proposal));
});

test("proposal rejects duplicate source evidence identities even when evidence is identical", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  proposal.sourceEvidence.push(evidence("instructions", "instructions-v1"));

  expectDiagnostics(await controller.submitProposal(prepared.id, proposal), [
    "Duplicate source evidence identity: instructions",
  ]);
});

test("proposal rejects duplicate canonical source references", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  proposal.sourceEvidence[0]!.references = ["HTTPS://TRACKER.INVALID/spec-2/", "https://tracker.invalid/spec-2"];

  expectDiagnostics(await controller.submitProposal(prepared.id, proposal), ["Source spec-2 has duplicate source references"]);
});

test("ticket claims fail closed when missing and preview explicit null or present claims", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  delete (proposal.tickets[0] as Partial<BatchProposal["tickets"][number]>).claimedBy;

  expectDiagnostics(await controller.submitProposal(prepared.id, proposal), [
    "Ticket claim status is missing: ticket-a",
  ]);

  proposal.tickets[0]!.claimedBy = null;
  expectValue(await controller.submitProposal(prepared.id, proposal));
  const preview = expectValue(await controller.preview(prepared.id));
  assert.match(preview, /ticket-a First \[unclaimed\]/);
  assert.match(preview, /ticket-b Second \[claimed: other-user\]/);
});

test("human preview shows the handoff replacement limit", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  expectValue(await controller.submitProposal(prepared.id, validProposal(repo.head)));

  const preview = expectValue(await controller.preview(prepared.id));
  assert.match(preview, /handoff replacements 2/);
});

test("approval binds canonical references and content while permitting a newer retrieval", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const proposed = await preparedProposal(controller, repo);

  const newer = approvalRequest(repo.head, { retrievedAt: "2026-09-12T13:00:00.000Z" });
  newer.evidence[0]!.references = ["HTTPS://TRACKER.INVALID:443/spec-2/"];
  const approved = expectValue(await controller.approve(proposed.id, newer));
  assert.equal(approved.stage, "approved");
});

test("approval rejects changed references, duplicate evidence identities, and stale retrieval", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const proposed = await preparedProposal(controller, repo);
  const request = approvalRequest(repo.head);
  request.evidence[0] = evidence("spec-2", "spec-v1", {
    retrievedAt: "2026-09-12T11:59:59.000Z",
    references: ["https://other-tracker.invalid/spec-2"],
  });
  request.evidence.push(evidence("ticket-a", "a-v1"));

  expectDiagnostics(await controller.approve(proposed.id, request), [
    "Duplicate source evidence identity: ticket-a",
    "Source references changed since proposal: spec-2",
    "Source retrieval is stale: spec-2",
  ]);
});

test("approval rejects unchanged tracker version when source content changed", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const proposed = await preparedProposal(controller, repo);
  const request = approvalRequest(repo.head);
  request.evidence[0] = evidence("spec-2", "spec-v1", {
    content: "materially changed requirements",
    retrievedAt: "2026-09-12T13:00:00.000Z",
  });

  expectDiagnostics(await controller.approve(proposed.id, request), ["Source content changed since proposal: spec-2"]);
});

test("sequential approvals reject normalized readable controller-name collisions", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath, { ids: ["first", "second"] });
  const first = await preparedProposal(controller, repo, "Example   / Spec 2");
  const second = await preparedProposal(controller, repo, "  example / spec 2  ");

  expectValue(await controller.approve(first.id, approvalRequest(repo.head)));
  expectDiagnostics(await controller.approve(second.id, approvalRequest(repo.head)), [
    "Controller name collides with an approved batch:   example / spec 2  ",
  ]);
});

test("database scripts cannot become safe through a test environment label", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  proposal.policy.setupOperations[1] = {
    kind: "database-setup",
    packageManager: "npm",
    script: "db:production-migrate",
    environment: "test",
    purpose: "Claim production migration is a test operation",
  };

  expectDiagnostics(await controller.submitProposal(prepared.id, proposal), [
    "Automated database setup is not approvable in this preparation slice; use an already isolated nonproduction resource or request clarification: Claim production migration is a test operation",
  ]);
});

test("setup plans reject .env.local copying while preserving constrained safe setup", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  proposal.policy.setupOperations.push({
    kind: "environment-template",
    source: ".env.local",
    destination: ".env.local",
    purpose: "Copy local credentials",
  });

  expectDiagnostics(await controller.submitProposal(prepared.id, proposal), [
    "Environment source is not an explicit public template: .env.local",
  ]);

  proposal.policy.setupOperations[1] = {
    kind: "environment-template",
    source: ".env.example",
    destination: ".env.test",
    purpose: "Create test environment from public template",
  };
  expectValue(await controller.submitProposal(prepared.id, proposal));

  const production = validProposal(repo.head);
  production.policy.setupOperations.push({
    kind: "database-setup",
    packageManager: "npm",
    script: "db:migrate",
    environment: "production",
    purpose: "Migrate production",
  } as unknown as BatchProposal["policy"]["setupOperations"][number]);
  expectDiagnostics(await controller.submitProposal(prepared.id, production), [
    "Automated database setup is not approvable in this preparation slice; use an already isolated nonproduction resource or request clarification: Migrate production",
  ]);
});

test("proposal blocks unresolved prerequisites, ambiguity, and unsafe runtime resources", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  proposal.dependencies[1] = {
    ticketIdentity: "ticket-a",
    prerequisiteIdentity: "external:service",
    kind: "external",
    status: "unresolved",
    evidenceIdentity: "external-service",
  };
  proposal.ambiguities = ["Ticket A may or may not include migrations"];
  proposal.resources[2] = { kind: "database", description: "production database", isolation: "unsafe" };

  expectDiagnostics(await controller.submitProposal(prepared.id, proposal), [
    "External prerequisite is unresolved: external:service",
    "Ambiguous requirement requires clarification: Ticket A may or may not include migrations",
    "Unsafe database resource: production database",
  ]);
});

test("controller reports persistence failures as Result errors", async (): Promise<void> => {
  const repo = await repository();
  const failingStore: ControllerStateStore = {
    async load(): Promise<ControllerStatus> {
      return { schemaVersion: 1, preparations: [], executionAttempts: [] };
    },
    async save(): Promise<void> {
      throw new Error("secret storage details");
    },
  };
  const controller = new PreparationController(failingStore, {
    now: () => new Date("2026-09-12T14:00:00.000Z"),
    generateId: () => "preparation-1",
  });

  expectDiagnostics(
    await controller.prepare(
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
    ["Controller state could not be written durably"],
  );
});

test("failed durable writes remove temporary state fragments", async (): Promise<void> => {
  const repo = await repository();
  await mkdir(repo.statePath, { recursive: true });
  const store = new JsonControllerStateStore(repo.statePath);

  await assert.rejects(
    store.save({ schemaVersion: 1, preparations: [], executionAttempts: [] }),
  );
  assert.deepEqual(
    (await readdir(join(repo.root, ".state"))).filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});

test("valid proposal and explicit approval survive controller restart", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath, { now: "2026-09-12T14:00:00.000Z" });
  const proposed = await preparedProposal(controller, repo);
  assert.deepEqual(proposed.effectiveContextLimit, { handoffTokens: 190_000, reserveTokens: 22_000 });
  assert.match(proposed.proposalDigest ?? "", /^[a-f0-9]{64}$/);

  const approved = expectValue(await controller.approve(proposed.id, approvalRequest(repo.head)));
  const restarted = testController(repo.statePath);
  const status = expectValue(await restarted.status());
  assert.equal(status.preparations[0]?.approved?.approvedAt, "2026-09-12T14:00:00.000Z");
  assert.equal(status.preparations[0]?.approved?.proposalDigest, approved.proposalDigest);
  assert.equal(status.executionAttempts.length, 0);
});
