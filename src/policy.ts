import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, normalize, relative } from "node:path";

import type {
  AdmissionSnapshot,
  ApprovalRequest,
  BatchProposal,
  PreparationRecord,
  SourceEvidence,
} from "./contracts.js";

export const REQUIRED_TOOL_NAMES = [
  "bash",
  "herdr_approve_batch",
  "herdr_get_preparation",
  "herdr_submit_batch_proposal",
  "read",
] as const;

export const REQUIRED_SKILL_COMMANDS = [
  "skill:code-review",
  "skill:handoff",
  "skill:implement",
  "skill:tdd",
] as const;

const INSTRUCTION_FILE_NAMES = new Set([
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
]);

export function digest(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]): number => left.localeCompare(right))
          .map(([key, child]): [string, unknown] => [key, canonical(child)]),
      );
    }
    return item;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function normalizeControllerName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function hasApprovedControllerNameCollision(
  preparations: PreparationRecord[],
  controllerName: string,
  excludedPreparationId?: string,
): boolean {
  const normalizedName = normalizeControllerName(controllerName);
  return preparations.some((item): boolean =>
    item.id !== excludedPreparationId &&
    item.stage === "approved" &&
    normalizeControllerName(item.controllerName) === normalizedName
  );
}

export function calculateContextLimit(
  contextWindow: number,
  requested: { requestedHandoffTokens: number; reserveTokens: number },
): { handoffTokens: number; reserveTokens: number } {
  const reserveTokens = Math.max(requested.reserveTokens, 20_000, Math.ceil(contextWindow * 0.1));
  return { handoffTokens: Math.min(requested.requestedHandoffTokens, contextWindow - reserveTokens), reserveTokens };
}

export function validateAdmission(snapshot: AdmissionSnapshot): string[] {
  const failures: string[] = [];
  if (!snapshot.runtime.projectTrusted) failures.push("Project trust is unresolved");
  if (!snapshot.runtime.piVersion) failures.push("Pi capability is unavailable");
  else if (!atLeast(snapshot.runtime.piVersion, "0.85.1")) failures.push(`Pi ${snapshot.runtime.piVersion} is unsupported; require >=0.85.1`);
  if (!snapshot.runtime.herdrVersion) failures.push("Herdr capability is unavailable");
  else if (!atLeast(snapshot.runtime.herdrVersion, "0.8.2")) failures.push(`Herdr ${snapshot.runtime.herdrVersion} is unsupported; require >=0.8.2`);
  if (snapshot.runtime.platform !== "linux" && snapshot.runtime.platform !== "darwin") {
    failures.push(`Unsupported platform: ${snapshot.runtime.platform as string}`);
  }
  const missingSkills = REQUIRED_SKILL_COMMANDS.filter(
    (command): boolean => !snapshot.runtime.skillCommands.includes(command),
  );
  if (missingSkills.length > 0) {
    failures.push(`Missing native skill commands: ${missingSkills.map((name): string => `/${name}`).join(", ")}`);
  }
  const missingTools = REQUIRED_TOOL_NAMES.filter(
    (tool): boolean => !snapshot.runtime.toolNames.includes(tool),
  );
  if (missingTools.length > 0) failures.push(`Missing required Pi tools: ${missingTools.join(", ")}`);
  const hasProjectInstruction = snapshot.project.instructionFiles.some((file): boolean => {
    if (!INSTRUCTION_FILE_NAMES.has(basename(file))) return false;
    const projectRelative = relative(snapshot.project.root, file);
    const projectContainsFile = projectRelative !== "" && !projectRelative.startsWith("..") && !isAbsolute(projectRelative);
    const instructionRelative = relative(dirname(file), snapshot.project.root);
    const fileDirectoryContainsProject = !instructionRelative.startsWith("..") && !isAbsolute(instructionRelative);
    return projectContainsFile || fileDirectoryContainsProject;
  });
  if (!hasProjectInstruction) failures.push("No execution-project instruction file was loaded");
  if (!snapshot.model.authenticated) {
    const detail = snapshot.model.authError ? `: ${redactDiagnostic(snapshot.model.authError)}` : "";
    failures.push(`Selected model ${snapshot.model.provider}/${snapshot.model.id} has unusable authentication${detail}`);
  }
  if (!snapshot.model.available) failures.push(`Selected model ${snapshot.model.provider}/${snapshot.model.id} is unavailable in this Pi session`);
  if (!Number.isSafeInteger(snapshot.model.contextWindow) || snapshot.model.contextWindow < 40_000) {
    failures.push(`Selected model ${snapshot.model.provider}/${snapshot.model.id} has no viable context budget`);
  }
  return failures;
}

export function validateProposal(record: PreparationRecord, proposal: BatchProposal): string[] {
  const failures: string[] = [];
  if (Buffer.byteLength(JSON.stringify(proposal), "utf8") > 45_000) failures.push("Proposal exceeds the 45KB preparation limit");
  if (proposal.schemaVersion !== 1) failures.push("Unsupported proposal schema version");
  if (!proposal.controllerName?.trim()) failures.push("A readable controller name is required");
  if (proposal.project?.identity !== record.project.identity) failures.push("Proposal project identity differs from admission");
  if (!proposal.project?.tracker?.identity?.trim() || proposal.project.tracker.instructionSources.length === 0) {
    failures.push("Configured tracker identity and instruction sources are required");
  }
  if ((proposal.project?.tracker?.instructionEvidenceIdentities.length ?? 0) === 0) {
    failures.push("Project instruction version evidence is required");
  }
  const sourceIds = new Set<string>();
  for (const source of proposal.sourceEvidence ?? []) {
    if (sourceIds.has(source.identity)) failures.push(`Duplicate source evidence identity: ${source.identity}`);
    else sourceIds.add(source.identity);
    failures.push(...evidenceFailures(`Source ${source.identity}`, source));
  }
  if (proposal.spec?.identity !== record.specReference) failures.push("Proposal spec differs from the selected spec");
  if (proposal.tickets.length === 0) failures.push("At least one ticket is required");

  const ticketIds = new Set<string>();
  for (const ticket of proposal.tickets) {
    if (ticketIds.has(ticket.identity)) failures.push(`Duplicate ticket identity: ${ticket.identity}`);
    ticketIds.add(ticket.identity);
    if (!Object.hasOwn(ticket, "claimedBy")) failures.push(`Ticket claim status is missing: ${ticket.identity}`);
    else if (ticket.claimedBy !== null && (typeof ticket.claimedBy !== "string" || !ticket.claimedBy.trim())) {
      failures.push(`Ticket claimant is empty: ${ticket.identity}`);
    }
  }
  for (const edge of proposal.dependencies) {
    if (!ticketIds.has(edge.ticketIdentity)) failures.push(`Dependency owner is missing from ticket set: ${edge.ticketIdentity}`);
    if (edge.kind === "ticket") {
      if (!ticketIds.has(edge.prerequisiteIdentity)) failures.push(`Dependency references missing ticket: ${edge.prerequisiteIdentity}`);
      else if (edge.status !== "in-batch") failures.push(`Ticket dependency is not admitted in-batch: ${edge.ticketIdentity} <- ${edge.prerequisiteIdentity}`);
    } else if (edge.status !== "resolved") {
      failures.push(`External prerequisite is unresolved: ${edge.prerequisiteIdentity}`);
    } else if (!edge.evidenceIdentity?.trim()) {
      failures.push(`External prerequisite has no source evidence identity: ${edge.prerequisiteIdentity}`);
    }
  }
  const cycle = findCycle(ticketIds, proposal.dependencies);
  if (cycle) failures.push(`Ticket dependency graph contains a cycle: ${cycle.join(" -> ")}`);
  for (const ambiguity of proposal.ambiguities) failures.push(`Ambiguous requirement requires clarification: ${ambiguity}`);
  if (proposal.target.baseCommit !== record.project.head || proposal.target.branch !== record.project.branch) {
    failures.push("Target branch or base differs from the admitted Git state");
  }
  if (digest(proposal.model) !== digest(record.model)) failures.push("Proposal model or thinking level differs from the captured selection");
  if (!Number.isInteger(proposal.policy.concurrency) || proposal.policy.concurrency < 1) failures.push("Concurrency must be at least one");
  if (proposal.policy.maxHandoffReplacements !== 2 || proposal.policy.maxRepairCycles !== 2) {
    failures.push("Handoff replacement and repair limits must both be two");
  }
  if (!proposal.policy.requiredReviews.includes("standards") || !proposal.policy.requiredReviews.includes("spec")) {
    failures.push("Standards and spec reviews are required");
  }
  if (new Set(proposal.policy.requiredReviews).size !== proposal.policy.requiredReviews.length) {
    failures.push("Required reviews must be unique");
  }
  if (!proposal.policy.implementationSkillTestingRequired) failures.push("Batch policy cannot weaken implementation-skill testing");
  for (const check of proposal.policy.checks) {
    if (!check.command.trim() || !check.source.trim()) failures.push("Optional checks require a command and coding-standards source");
    if (containsCredential(check.command)) failures.push("Optional check command appears to contain credentials");
  }
  failures.push(...sourceReferenceFailures(proposal, sourceIds));

  const effective = calculateContextLimit(proposal.model.contextWindow, proposal.policy.context);
  if (effective.handoffTokens <= effective.reserveTokens) failures.push("Selected model has no viable context budget and handoff reserve");
  failures.push(...resourceFailures(proposal));
  failures.push(...setupOperationFailures(proposal.policy.setupOperations));
  return failures;
}

export function approvalFailures(
  preparations: PreparationRecord[],
  record: PreparationRecord | undefined,
  request: ApprovalRequest,
): string[] {
  if (!record?.proposal || !record.proposalDigest || record.stage !== "proposed") {
    return ["Preparation does not have an approvable proposal"];
  }
  const failures: string[] = [];
  if (!request.approvedBy.trim()) failures.push("Approval author is required");
  if (request.proposalDigest !== record.proposalDigest) {
    failures.push("Proposal changed after the approval preview; review and confirm the current proposal");
  }
  if (request.projectHead !== record.project.head) failures.push("Git base changed since proposal");
  if (digest(request.model) !== digest(record.model)) failures.push("Selected model or thinking level changed since proposal");
  if (hasApprovedControllerNameCollision(preparations, record.controllerName, record.id)) {
    failures.push(`Controller name collides with an approved batch: ${record.controllerName}`);
  }

  failures.push(...approvalEvidenceFailures(record.proposal.sourceEvidence, request.evidence));
  return failures;
}

export function approvalEvidenceFailures(
  proposalEvidence: SourceEvidence[],
  approvalEvidence: SourceEvidence[],
): string[] {
  const failures: string[] = [];
  const expected = uniqueEvidence(proposalEvidence);
  const current = uniqueEvidence(approvalEvidence, failures);
  for (const [identity, source] of expected) {
    const observed = current.get(identity);
    if (!observed) {
      failures.push(`Approval evidence is missing source: ${identity}`);
      continue;
    }
    if (observed.revision !== source.revision) {
      failures.push(`Source version changed since proposal: ${identity} (${source.revision} -> ${observed.revision})`);
    }
    if (observed.contentDigest !== source.contentDigest) failures.push(`Source content changed since proposal: ${identity}`);
    if (canonicalReferences(observed.references).join("\n") !== canonicalReferences(source.references).join("\n")) {
      failures.push(`Source references changed since proposal: ${identity}`);
    }
    const proposedTime = Date.parse(source.retrievedAt);
    const currentTime = Date.parse(observed.retrievedAt);
    if (Number.isFinite(proposedTime) && Number.isFinite(currentTime) && currentTime <= proposedTime) {
      failures.push(`Source retrieval is stale: ${identity}`);
    }
  }
  for (const identity of current.keys()) {
    if (!expected.has(identity)) failures.push(`Approval evidence includes unapproved scope: ${identity}`);
  }
  for (const source of approvalEvidence) failures.push(...evidenceFailures(`Approval source ${source.identity}`, source));
  return failures;
}

function uniqueEvidence(evidence: SourceEvidence[], failures?: string[]): Map<string, SourceEvidence> {
  const result = new Map<string, SourceEvidence>();
  for (const source of evidence) {
    if (result.has(source.identity)) failures?.push(`Duplicate source evidence identity: ${source.identity}`);
    else result.set(source.identity, source);
  }
  return result;
}

function sourceReferenceFailures(proposal: BatchProposal, sourceIds: Set<string>): string[] {
  const failures: string[] = [];
  const referenced = [
    proposal.spec.evidenceIdentity,
    ...proposal.tickets.map((ticket): string => ticket.evidenceIdentity),
    ...proposal.project.tracker.instructionEvidenceIdentities,
    ...proposal.dependencies.flatMap((dependency): string[] => dependency.evidenceIdentity ? [dependency.evidenceIdentity] : []),
    ...proposal.policy.checks.map((check): string => check.evidenceIdentity),
  ];
  for (const identity of new Set(referenced)) {
    if (!sourceIds.has(identity)) failures.push(`Missing source evidence identity: ${identity}`);
  }
  const referencedIds = new Set(referenced);
  for (const identity of sourceIds) {
    if (!referencedIds.has(identity)) failures.push(`Unreferenced source evidence identity: ${identity}`);
  }
  return failures;
}

function canonicalReferences(references: string[]): string[] {
  return references.map(canonicalReference).sort();
}

function canonicalReference(reference: string): string {
  try {
    const url = new URL(reference);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return normalize(reference.replaceAll("\\", "/"));
  }
}

function evidenceFailures(label: string, evidence: SourceEvidence | undefined): string[] {
  if (
    !evidence ||
    !evidence.identity?.trim() ||
    !evidence.revision?.trim() ||
    !/^[a-f0-9]{64}$/i.test(evidence.contentDigest ?? "") ||
    !Number.isFinite(Date.parse(evidence.retrievedAt ?? "")) ||
    !Array.isArray(evidence.references) ||
    evidence.references.length === 0
  ) {
    return [`${label} has incomplete source/version/content evidence`];
  }
  if (evidence.references.some(containsCredential)) return [`${label} source reference appears to contain credentials`];
  const canonical = canonicalReferences(evidence.references);
  if (new Set(canonical).size !== canonical.length) return [`${label} has duplicate source references`];
  return [];
}

function setupOperationFailures(operations: BatchProposal["policy"]["setupOperations"]): string[] {
  const failures: string[] = [];
  for (const operation of operations) {
    const raw = operation as Partial<{
      packageManager: string;
      mode: string;
      source: string;
      destination: string;
      script: string;
      environment: string;
    }>;
    if (operation.kind === "dependency-install") {
      if (!isPackageManager(raw.packageManager) || !["frozen", "regular"].includes(raw.mode ?? "")) {
        failures.push(`Dependency setup is incomplete: ${operation.purpose}`);
      }
      continue;
    }
    if (operation.kind === "environment-template") {
      if (!isSafeRelativePath(raw.source) || !isSafeRelativePath(raw.destination)) {
        failures.push(`Environment template paths must stay inside the worktree: ${operation.purpose}`);
      }
      if (!/(?:\.example|\.sample|\.template)$/i.test(raw.source ?? "")) {
        failures.push(`Environment source is not an explicit public template: ${raw.source ?? "(missing)"}`);
      }
      continue;
    }
    failures.push(
      `Automated database setup is not approvable in this preparation slice; use an already isolated nonproduction resource or request clarification: ${operation.purpose}`,
    );
  }
  return failures;
}

function resourceFailures(proposal: BatchProposal): string[] {
  const failures: string[] = [];
  const requiredKinds = new Set<BatchProposal["resources"][number]["kind"]>([
    "dependencies",
    "environment",
    "database",
    "port",
    "external",
  ]);
  for (const resource of proposal.resources) {
    requiredKinds.delete(resource.kind);
    if (resource.isolation === "unknown" || resource.isolation === "unsafe") {
      failures.push(`${resource.isolation === "unsafe" ? "Unsafe" : "Unknown isolation for"} ${resource.kind} resource: ${resource.description}`);
    } else if (resource.isolation === "serial-only" && proposal.policy.concurrency > 1) {
      failures.push(`Parallel execution is unsafe for ${resource.kind} resource: ${resource.description}`);
    }
  }
  if (requiredKinds.size > 0) failures.push(`Runtime resource plan is missing: ${[...requiredKinds].join(", ")}`);
  return failures;
}

function findCycle(ticketIds: Set<string>, dependencies: BatchProposal["dependencies"]): string[] | undefined {
  const graph = new Map<string, string[]>();
  for (const id of ticketIds) graph.set(id, []);
  for (const edge of dependencies) {
    if (edge.kind === "ticket" && ticketIds.has(edge.ticketIdentity) && ticketIds.has(edge.prerequisiteIdentity)) {
      graph.get(edge.ticketIdentity)?.push(edge.prerequisiteIdentity);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      return [...path.slice(start), id];
    }
    if (visited.has(id)) return undefined;
    visiting.add(id);
    path.push(id);
    for (const dependency of graph.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const id of ticketIds) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

function isPackageManager(value: string | undefined): boolean {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}

function isSafeRelativePath(path: string | undefined): boolean {
  if (!path) return false;
  const normalized = normalize(path);
  return Boolean(path.trim()) && !isAbsolute(normalized) && normalized !== ".." && !normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function containsCredential(value: string): boolean {
  if (/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+\b/i.test(value)) return true;
  if (/[?&](?:access_?token|api_?key|token|secret|password)=/i.test(value)) return true;
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function atLeast(actual: string, required: string): boolean {
  const values = actual.match(/\d+(?:\.\d+){0,2}/)?.[0]?.split(".").map(Number);
  const minimum = required.split(".").map(Number);
  if (!values) return false;
  for (let index = 0; index < 3; index += 1) {
    const left = values[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+\b/gi, "[redacted]")
    .replace(/(token|secret|password|api[_ -]?key)\s*[=:]\s*\S+/gi, "$1=[redacted]");
}
