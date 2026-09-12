import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import {
  PreparationController,
  type AdmissionSnapshot,
  type ApprovalRequest,
  type BatchProposal,
  type ControllerResult,
  type ControllerState,
  type ControllerStateStore,
  type PreparationRecord,
  type SourceEvidence,
} from "../src/controller.js";
import { MAX_PREPARATIONS } from "../src/contracts.js";
import { digest } from "../src/policy.js";
import { formatPreparationPreview } from "../src/presentation.js";
import { JsonControllerStateStore } from "../src/state-store.js";

interface TestRepository {
  root: string;
  statePath: string;
  head: string;
}

const DISPOSABLE_REPOSITORIES = new Set<string>();
const TEST_ACTOR_CAPABILITY = Symbol("test local actor");

afterEach(async (): Promise<void> => {
  await Promise.all([...DISPOSABLE_REPOSITORIES].map(async (root): Promise<void> => {
    await rm(root, { recursive: true, force: true });
    DISPOSABLE_REPOSITORIES.delete(root);
  }));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repository(): Promise<TestRepository> {
  const root = await mkdtemp(join(tmpdir(), "herdr-controller-"));
  DISPOSABLE_REPOSITORIES.add(root);
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
    actorCapability: TEST_ACTOR_CAPABILITY,
    now: (): Date => new Date(options.now ?? "2026-09-12T14:00:00.000Z"),
    generateId: (): string => ids.shift() ?? "preparation-fallback",
    formatPreview: (record: PreparationRecord): string => formatPreparationPreview(record),
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
    proposalDigest: digest(validProposal(head)),
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
    await controller.prepare(TEST_ACTOR_CAPABILITY, { specReference: "tracker:spec-2", controllerName }, admitted(repo.root, repo.head)),
  );
  const proposed = expectValue(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, validProposal(repo.head, controllerName)));
  return proposed;
}

test("approval remains bound to the proposal confirmed before UI wait", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const proposed = await preparedProposal(controller, repo);
  const request = approvalRequest(repo.head);
  request.proposalDigest = proposed.proposalDigest!;
  expectValue(await controller.validateApproval(TEST_ACTOR_CAPABILITY, proposed.id, request));

  const changed = validProposal(repo.head);
  changed.policy.concurrency = 1;
  changed.policy.checks[0]!.command = "npm run different-check";
  expectValue(await controller.submitProposal(TEST_ACTOR_CAPABILITY, proposed.id, changed));

  expectDiagnostics(await controller.approve(TEST_ACTOR_CAPABILITY, proposed.id, request), [
    "Proposal changed after the approval preview; review and confirm the current proposal",
  ]);
});

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

  const result = await controller.prepare(TEST_ACTOR_CAPABILITY,
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

test("preparation accepts only loaded instructions applicable to the project chain", async (): Promise<void> => {
  const parent = await mkdtemp(join(tmpdir(), "herdr-controller-parent-"));
  DISPOSABLE_REPOSITORIES.add(parent);
  const projectRoot = join(parent, "project");
  await mkdir(projectRoot);
  git(projectRoot, "init", "-q", "-b", "main");
  git(projectRoot, "config", "user.email", "test@example.invalid");
  git(projectRoot, "config", "user.name", "Test User");
  execFileSync("sh", ["-c", "printf project > README.md"], { cwd: projectRoot });
  git(projectRoot, "add", "README.md");
  git(projectRoot, "commit", "-qm", "initial");
  const head = git(projectRoot, "rev-parse", "HEAD");
  const snapshot = admitted(projectRoot, head);
  snapshot.project.instructionFiles = [join(parent, "AGENTS.md")];
  const controller = testController(join(projectRoot, ".state", "controller.json"));

  expectValue(await controller.prepare(TEST_ACTOR_CAPABILITY,
    { specReference: "tracker:spec-2", controllerName: "ancestor instructions" },
    snapshot,
  ));

  const unrelated = admitted(projectRoot, head);
  unrelated.project.instructionFiles = [join(tmpdir(), "unrelated", "AGENTS.md")];
  expectDiagnostics(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
      { specReference: "tracker:spec-3", controllerName: "unrelated instructions" },
      unrelated,
    ),
    ["No execution-project instruction file was loaded"],
  );
});

test("controller denies callers without the injected local capability", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const foreignActor = Symbol("model-asserted actor");
  const denied = ["The caller does not hold the local controller capability"];

  expectDiagnostics(
    await controller.prepare(
      foreignActor,
      { specReference: "tracker:spec-2", controllerName: "unauthorized" },
      admitted(repo.root, repo.head),
    ),
    denied,
  );
  expectDiagnostics(await controller.status(foreignActor, { limit: 10 }), denied);

  const proposed = await preparedProposal(controller, repo);
  const request = approvalRequest(repo.head);
  request.proposalDigest = proposed.proposalDigest!;
  expectDiagnostics(await controller.submitProposal(foreignActor, proposed.id, validProposal(repo.head)), denied);
  expectDiagnostics(await controller.getPreparation(foreignActor, proposed.id), denied);
  expectDiagnostics(await controller.preview(foreignActor, proposed.id), denied);
  expectDiagnostics(await controller.validateApproval(foreignActor, proposed.id, request), denied);
  expectDiagnostics(await controller.approve(foreignActor, proposed.id, request), denied);
  const persisted = expectValue(await controller.getPreparation(TEST_ACTOR_CAPABILITY, proposed.id));
  assert.equal(persisted.stage, "proposed");
});

test("preparation captures the selected model and creates no execution attempt", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const status = expectValue(await controller.status(TEST_ACTOR_CAPABILITY, { limit: 50 }));

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
    await controller.prepare(TEST_ACTOR_CAPABILITY,
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
  proposal.sourceEvidence = proposal.sourceEvidence.filter((source): boolean => source.identity !== "external-service");

  expectDiagnostics(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, proposal), [
    "Dependency references missing ticket: ticket-missing",
    "Ticket dependency graph contains a cycle: ticket-a -> ticket-b -> ticket-a",
  ]);
});

test("external prerequisites cannot use in-batch status to bypass resolution evidence", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
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

  expectDiagnostics(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, proposal), [
    "External prerequisite is unresolved: external:service",
  ]);
});

test("source registry allows deliberate evidence reuse across proposal fields", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  assert.equal(proposal.project.tracker.instructionEvidenceIdentities.includes("coding-standards"), true);
  assert.equal(proposal.policy.checks[0]!.evidenceIdentity, "coding-standards");

  expectValue(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, proposal));
});

test("proposal rejects duplicate source evidence identities even when evidence is identical", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  proposal.sourceEvidence.push(evidence("instructions", "instructions-v1"));

  expectDiagnostics(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, proposal), [
    "Duplicate source evidence identity: instructions",
  ]);
});

test("proposal rejects duplicate canonical source references", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  proposal.sourceEvidence[0]!.references = ["HTTPS://TRACKER.INVALID/spec-2/", "https://tracker.invalid/spec-2"];

  expectDiagnostics(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, proposal), ["Source spec-2 has duplicate source references"]);
});

test("ticket claims fail closed when missing and preview explicit null or present claims", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  const proposal = validProposal(repo.head);
  delete (proposal.tickets[0] as Partial<BatchProposal["tickets"][number]>).claimedBy;

  expectDiagnostics(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, proposal), [
    "Ticket claim status is missing: ticket-a",
  ]);

  proposal.tickets[0]!.claimedBy = null;
  expectValue(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, proposal));
  const preview = expectValue(await controller.preview(TEST_ACTOR_CAPABILITY, prepared.id));
  assert.match(preview, /ticket-a First \[unclaimed\]/);
  assert.match(preview, /ticket-b Second \[claimed: other-user\]/);
});

test("human preview shows the handoff replacement limit", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
      { specReference: "tracker:spec-2", controllerName: "example / spec 2" },
      admitted(repo.root, repo.head),
    ),
  );
  expectValue(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, validProposal(repo.head)));

  const preview = expectValue(await controller.preview(TEST_ACTOR_CAPABILITY, prepared.id));
  assert.match(preview, /handoff replacements 2/);
});

test("approval binds canonical references and content while permitting a newer retrieval", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const proposed = await preparedProposal(controller, repo);

  const newer = approvalRequest(repo.head, { retrievedAt: "2026-09-12T13:00:00.000Z" });
  newer.evidence[0]!.references = ["HTTPS://TRACKER.INVALID:443/spec-2/"];
  const approved = expectValue(await controller.approve(TEST_ACTOR_CAPABILITY, proposed.id, newer));
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

  expectDiagnostics(await controller.approve(TEST_ACTOR_CAPABILITY, proposed.id, request), [
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

  expectDiagnostics(await controller.approve(TEST_ACTOR_CAPABILITY, proposed.id, request), ["Source content changed since proposal: spec-2"]);
});

test("sequential approvals reject normalized readable controller-name collisions", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath, { ids: ["first", "second"] });
  const first = await preparedProposal(controller, repo, "Example   / Spec 2");
  const second = await preparedProposal(controller, repo, "  example / spec 2  ");

  const firstApproval = approvalRequest(repo.head);
  firstApproval.proposalDigest = first.proposalDigest!;
  expectValue(await controller.approve(TEST_ACTOR_CAPABILITY, first.id, firstApproval));
  const secondApproval = approvalRequest(repo.head);
  secondApproval.proposalDigest = second.proposalDigest!;
  expectDiagnostics(await controller.approve(TEST_ACTOR_CAPABILITY, second.id, secondApproval), [
    "Controller name collides with an approved batch:   example / spec 2  ",
  ]);
});

test("database scripts cannot become safe through a test environment label", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
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

  expectDiagnostics(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, proposal), [
    "Automated database setup is not approvable in this preparation slice; use an already isolated nonproduction resource or request clarification: Claim production migration is a test operation",
  ]);
});

test("setup plans reject .env.local copying while preserving constrained safe setup", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
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

  expectDiagnostics(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, proposal), [
    "Environment source is not an explicit public template: .env.local",
  ]);

  proposal.policy.setupOperations[1] = {
    kind: "environment-template",
    source: ".env.example",
    destination: ".env.test",
    purpose: "Create test environment from public template",
  };
  expectValue(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, proposal));

  const production = validProposal(repo.head);
  production.policy.setupOperations.push({
    kind: "database-setup",
    packageManager: "npm",
    script: "db:migrate",
    environment: "production",
    purpose: "Migrate production",
  } as unknown as BatchProposal["policy"]["setupOperations"][number]);
  expectDiagnostics(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, production), [
    "Automated database setup is not approvable in this preparation slice; use an already isolated nonproduction resource or request clarification: Migrate production",
  ]);
});

test("proposal blocks unresolved prerequisites, ambiguity, and unsafe runtime resources", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const prepared = expectValue(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
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

  expectDiagnostics(await controller.submitProposal(TEST_ACTOR_CAPABILITY, prepared.id, proposal), [
    "External prerequisite is unresolved: external:service",
    "Ambiguous requirement requires clarification: Ticket A may or may not include migrations",
    "Unsafe database resource: production database",
  ]);
});

test("status returns bounded pages without exposing the full preparation history", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath, { ids: ["first", "second", "third"] });
  for (const controllerName of ["first", "second", "third"]) {
    expectValue(await controller.prepare(
      TEST_ACTOR_CAPABILITY,
      { specReference: `tracker:${controllerName}`, controllerName },
      admitted(repo.root, repo.head),
    ));
  }

  const firstPage = expectValue(await controller.status(TEST_ACTOR_CAPABILITY, { limit: 2 }));
  assert.deepEqual(firstPage.preparations.map((record): string => record.id), ["first", "second"]);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  const secondPage = expectValue(
    await controller.status(TEST_ACTOR_CAPABILITY, { limit: 2, cursor: firstPage.nextCursor }),
  );
  assert.deepEqual(secondPage.preparations.map((record): string => record.id), ["third"]);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.nextCursor, null);
  expectDiagnostics(await controller.status(TEST_ACTOR_CAPABILITY, { limit: 51 }), [
    "Status page limit must be between 1 and 50",
  ]);
});

test("preparation storage rejects growth beyond its documented hard bound", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const first = expectValue(await controller.prepare(
    TEST_ACTOR_CAPABILITY,
    { specReference: "tracker:first", controllerName: "first" },
    admitted(repo.root, repo.head),
  ));
  const state: ControllerState = {
    schemaVersion: 1,
    preparations: Array.from({ length: MAX_PREPARATIONS }, (_value, index): PreparationRecord => ({
      ...structuredClone(first),
      id: `preparation-${index}`,
      controllerName: `controller ${index}`,
    })),
    executionAttempts: [],
  };
  await new JsonControllerStateStore(repo.statePath).save(state);

  expectDiagnostics(
    await controller.prepare(
      TEST_ACTOR_CAPABILITY,
      { specReference: "tracker:overflow", controllerName: "overflow" },
      admitted(repo.root, repo.head),
    ),
    ["Controller preparation capacity of 100 reached; archive this state file before preparing another batch"],
  );
});

test("malformed nested persisted records are sanitized as storage failures", async (): Promise<void> => {
  const repo = await repository();
  await mkdir(join(repo.root, ".state"), { recursive: true });
  await writeFile(repo.statePath, JSON.stringify({
    schemaVersion: 1,
    preparations: [null],
    executionAttempts: [],
  }));
  const controller = testController(repo.statePath);

  expectDiagnostics(await controller.status(TEST_ACTOR_CAPABILITY, { limit: 10 }), [
    "Controller state could not be read",
  ]);
});

test("corrupt nested proposal state is not exposed by point queries", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const proposed = await preparedProposal(controller, repo);
  const persisted = JSON.parse(await readFile(repo.statePath, "utf8")) as ControllerState;
  persisted.preparations[0]!.proposal!.policy.requiredReviews = ["standards", "invalid" as "spec"];
  await writeFile(repo.statePath, JSON.stringify(persisted));

  expectDiagnostics(await controller.getPreparation(TEST_ACTOR_CAPABILITY, proposed.id), [
    "Controller state could not be read",
  ]);
});

test("persisted effective context limits must match the frozen proposal", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const proposed = await preparedProposal(controller, repo);
  const persisted = JSON.parse(await readFile(repo.statePath, "utf8")) as ControllerState;
  persisted.preparations[0]!.effectiveContextLimit = { handoffTokens: 1, reserveTokens: 1 };
  await writeFile(repo.statePath, JSON.stringify(persisted));

  expectDiagnostics(await controller.preview(TEST_ACTOR_CAPABILITY, proposed.id), [
    "Controller state could not be read",
  ]);
});

test("persisted approval evidence must remain bound to the frozen proposal", async (): Promise<void> => {
  const corruptions: Array<(source: SourceEvidence) => void> = [
    (source): void => { source.identity = "unrelated"; },
    (source): void => { source.revision = "unrelated-revision"; },
    (source): void => { source.contentDigest = "a".repeat(64); },
    (source): void => { source.references = ["https://other-tracker.invalid/spec-2"]; },
    (source): void => { source.retrievedAt = "2026-09-12T12:00:00.000Z"; },
  ];

  for (const corrupt of corruptions) {
    const repo = await repository();
    const controller = testController(repo.statePath);
    const proposed = await preparedProposal(controller, repo);
    expectValue(await controller.approve(TEST_ACTOR_CAPABILITY, proposed.id, approvalRequest(repo.head)));
    const persisted = JSON.parse(await readFile(repo.statePath, "utf8")) as ControllerState;
    corrupt(persisted.preparations[0]!.approved!.evidence[0]!);
    await writeFile(repo.statePath, JSON.stringify(persisted));

    expectDiagnostics(await controller.status(TEST_ACTOR_CAPABILITY, { limit: 10 }), [
      "Controller state could not be read",
    ]);
  }
});

test("persisted approved controller names remain unique after normalization", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath);
  const proposed = await preparedProposal(controller, repo, "Example   / Spec 2");
  const request = approvalRequest(repo.head);
  request.proposalDigest = proposed.proposalDigest!;
  expectValue(await controller.approve(TEST_ACTOR_CAPABILITY, proposed.id, request));
  const persisted = JSON.parse(await readFile(repo.statePath, "utf8")) as ControllerState;
  const duplicate = structuredClone(persisted.preparations[0]!);
  duplicate.id = "duplicate-approved-preparation";
  duplicate.controllerName = "  example / spec 2  ";
  duplicate.proposal!.controllerName = duplicate.controllerName;
  duplicate.proposalDigest = digest(duplicate.proposal);
  duplicate.approved!.proposalDigest = duplicate.proposalDigest;
  persisted.preparations.push(duplicate);
  await writeFile(repo.statePath, JSON.stringify(persisted));

  expectDiagnostics(await controller.status(TEST_ACTOR_CAPABILITY, { limit: 10 }), [
    "Controller state could not be read",
  ]);
});

test("controller reports persistence failures as Result errors", async (): Promise<void> => {
  const repo = await repository();
  const failingStore: ControllerStateStore = {
    async load(): Promise<ControllerState> {
      return { schemaVersion: 1, preparations: [], executionAttempts: [] };
    },
    async save(): Promise<void> {
      throw new Error("secret storage details");
    },
  };
  const controller = new PreparationController(failingStore, {
    actorCapability: TEST_ACTOR_CAPABILITY,
    now: (): Date => new Date("2026-09-12T14:00:00.000Z"),
    generateId: (): string => "preparation-1",
    formatPreview: (record: PreparationRecord): string => formatPreparationPreview(record),
  });

  expectDiagnostics(
    await controller.prepare(TEST_ACTOR_CAPABILITY,
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
    (await readdir(join(repo.root, ".state"))).filter((entry): boolean => entry.endsWith(".tmp")),
    [],
  );
});

test("valid proposal and explicit approval survive controller restart", async (): Promise<void> => {
  const repo = await repository();
  const controller = testController(repo.statePath, { now: "2026-09-12T14:00:00.000Z" });
  const proposed = await preparedProposal(controller, repo);
  assert.deepEqual(proposed.effectiveContextLimit, { handoffTokens: 190_000, reserveTokens: 22_000 });
  assert.match(proposed.proposalDigest ?? "", /^[a-f0-9]{64}$/);

  const approved = expectValue(await controller.approve(TEST_ACTOR_CAPABILITY, proposed.id, approvalRequest(repo.head)));
  const restarted = testController(repo.statePath);
  const status = expectValue(await restarted.status(TEST_ACTOR_CAPABILITY, { limit: 50 }));
  assert.equal(status.preparations[0]?.approved?.approvedAt, "2026-09-12T14:00:00.000Z");
  assert.equal(status.preparations[0]?.approved?.proposalDigest, approved.proposalDigest);
  assert.equal(status.executionAttempts.length, 0);
});
