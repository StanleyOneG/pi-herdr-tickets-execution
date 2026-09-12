import type {
  BatchProposal,
  CapturedModel,
  ControllerState,
  PreparationRecord,
  SetupOperation,
  SourceEvidence,
} from "./contracts.js";
import { MAX_PREPARATIONS } from "./contracts.js";
import {
  approvalEvidenceFailures,
  calculateContextLimit,
  digest,
  hasApprovedControllerNameCollision,
  validateProposal,
} from "./policy.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PREPARATION_STAGES = new Set(["reasoning", "proposed", "approved"]);
const REVIEW_NAMES = new Set(["standards", "spec"]);
const RESOURCE_KINDS = new Set(["dependencies", "environment", "database", "port", "external"]);
const ISOLATION_LEVELS = new Set(["isolated", "shared-safe", "serial-only", "unknown", "unsafe"]);

export function isControllerState(value: unknown): value is ControllerState {
  if (!isObject(value) || value.schemaVersion !== 1) return false;
  if (!Array.isArray(value.preparations) || value.preparations.length > MAX_PREPARATIONS) return false;
  if (!Array.isArray(value.executionAttempts) || value.executionAttempts.length !== 0) return false;
  if (!value.preparations.every(isPreparationRecord)) return false;
  const preparations = value.preparations;
  const ids = preparations.map((record): string => record.id);
  if (new Set(ids).size !== ids.length) return false;
  return !preparations.some((record): boolean =>
    record.stage === "approved" &&
    hasApprovedControllerNameCollision(preparations, record.controllerName, record.id)
  );
}

function isPreparationRecord(value: unknown): value is PreparationRecord {
  if (!isObject(value)) return false;
  if (!isNonemptyString(value.id) || !PREPARATION_STAGES.has(value.stage as string)) return false;
  if (!isNonemptyString(value.specReference) || !isNonemptyString(value.controllerName)) return false;
  if (!isProject(value.project) || !isCapturedModel(value.model) || !isTimestamp(value.createdAt)) return false;

  if (value.stage === "reasoning") {
    return value.proposal === undefined && value.proposalDigest === undefined &&
      value.effectiveContextLimit === undefined && value.approved === undefined;
  }
  if (!isBatchProposal(value.proposal) || !isDigest(value.proposalDigest)) return false;
  if (value.proposalDigest !== digest(value.proposal)) return false;
  if (!isContextLimit(value.effectiveContextLimit)) return false;
  const expectedContextLimit = calculateContextLimit(value.proposal.model.contextWindow, value.proposal.policy.context);
  if (
    value.effectiveContextLimit.handoffTokens !== expectedContextLimit.handoffTokens ||
    value.effectiveContextLimit.reserveTokens !== expectedContextLimit.reserveTokens
  ) return false;
  if (value.controllerName !== value.proposal.controllerName) return false;
  if (value.project.identity !== value.proposal.project.identity) return false;
  if (digest(value.model) !== digest(value.proposal.model)) return false;
  if (value.project.head !== value.proposal.target.baseCommit || value.project.branch !== value.proposal.target.branch) return false;
  if (validateProposal(value as unknown as PreparationRecord, value.proposal).length > 0) return false;
  if (value.stage === "proposed") return value.approved === undefined;
  return isApprovalRecord(value.approved, value.proposalDigest, value.proposal.sourceEvidence);
}

function isProject(value: unknown): value is PreparationRecord["project"] {
  return isObject(value) &&
    isNonemptyString(value.root) &&
    isNonemptyString(value.identity) &&
    isNonemptyString(value.head) &&
    isNonemptyString(value.branch) &&
    isStringArray(value.instructionFiles, true);
}

function isCapturedModel(value: unknown): value is CapturedModel {
  return isObject(value) &&
    isNonemptyString(value.provider) &&
    isNonemptyString(value.id) &&
    THINKING_LEVELS.has(value.thinkingLevel as string) &&
    isPositiveInteger(value.contextWindow);
}

function isBatchProposal(value: unknown): value is BatchProposal {
  if (!isObject(value) || value.schemaVersion !== 1 || !isNonemptyString(value.controllerName)) return false;
  if (!isProposalProject(value.project) || !Array.isArray(value.sourceEvidence) || !value.sourceEvidence.every(isSourceEvidence)) return false;
  if (!isSpec(value.spec) || !Array.isArray(value.tickets) || value.tickets.length === 0 || !value.tickets.every(isTicket)) return false;
  if (!Array.isArray(value.dependencies) || !value.dependencies.every(isDependency)) return false;
  if (!isTarget(value.target) || !isCapturedModel(value.model) || !isPolicy(value.policy)) return false;
  if (!Array.isArray(value.resources) || !value.resources.every(isResource)) return false;
  return isStringArray(value.ambiguities, false);
}

function isProposalProject(value: unknown): boolean {
  return isObject(value) && isNonemptyString(value.identity) && isObject(value.tracker) &&
    isNonemptyString(value.tracker.identity) &&
    isStringArray(value.tracker.instructionSources, true) &&
    isStringArray(value.tracker.instructionEvidenceIdentities, true);
}

function isSourceEvidence(value: unknown): value is SourceEvidence {
  return isObject(value) &&
    isNonemptyString(value.identity) &&
    isNonemptyString(value.revision) &&
    isDigest(value.contentDigest) &&
    isTimestamp(value.retrievedAt) &&
    isStringArray(value.references, true);
}

function isSpec(value: unknown): boolean {
  return isObject(value) &&
    isNonemptyString(value.identity) &&
    isNonemptyString(value.title) &&
    isNonemptyString(value.evidenceIdentity);
}

function isTicket(value: unknown): boolean {
  return isObject(value) &&
    isNonemptyString(value.identity) &&
    isNonemptyString(value.title) &&
    isNonemptyString(value.evidenceIdentity) &&
    (value.claimedBy === null || isNonemptyString(value.claimedBy));
}

function isDependency(value: unknown): boolean {
  if (!isObject(value) || !isNonemptyString(value.ticketIdentity) || !isNonemptyString(value.prerequisiteIdentity)) return false;
  if (value.kind !== "ticket" && value.kind !== "external") return false;
  if (value.status !== "in-batch" && value.status !== "resolved" && value.status !== "unresolved") return false;
  return value.evidenceIdentity === undefined || isNonemptyString(value.evidenceIdentity);
}

function isTarget(value: unknown): boolean {
  return isObject(value) && isNonemptyString(value.branch) && isNonemptyString(value.baseCommit);
}

function isPolicy(value: unknown): boolean {
  return isObject(value) &&
    isPositiveInteger(value.concurrency) &&
    isObject(value.context) &&
    isPositiveInteger(value.context.requestedHandoffTokens) &&
    isPositiveInteger(value.context.reserveTokens) &&
    isNonnegativeInteger(value.maxHandoffReplacements) &&
    isNonnegativeInteger(value.maxRepairCycles) &&
    Array.isArray(value.requiredReviews) &&
    value.requiredReviews.every((review): boolean => REVIEW_NAMES.has(review as string)) &&
    typeof value.implementationSkillTestingRequired === "boolean" &&
    Array.isArray(value.checks) && value.checks.every(isCheck) &&
    Array.isArray(value.setupOperations) && value.setupOperations.every(isSetupOperation);
}

function isCheck(value: unknown): boolean {
  return isObject(value) &&
    typeof value.command === "string" &&
    typeof value.source === "string" &&
    isNonemptyString(value.evidenceIdentity);
}

function isSetupOperation(value: unknown): value is SetupOperation {
  if (!isObject(value) || !isNonemptyString(value.purpose)) return false;
  if (value.kind === "dependency-install") {
    return isPackageManager(value.packageManager) && (value.mode === "frozen" || value.mode === "regular");
  }
  if (value.kind === "environment-template") {
    return isNonemptyString(value.source) && isNonemptyString(value.destination);
  }
  if (value.kind === "database-setup") {
    return isPackageManager(value.packageManager) && isNonemptyString(value.script) &&
      (value.environment === "development" || value.environment === "test");
  }
  return false;
}

function isPackageManager(value: unknown): boolean {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}

function isResource(value: unknown): boolean {
  return isObject(value) &&
    RESOURCE_KINDS.has(value.kind as string) &&
    isNonemptyString(value.description) &&
    ISOLATION_LEVELS.has(value.isolation as string);
}

function isContextLimit(value: unknown): value is NonNullable<PreparationRecord["effectiveContextLimit"]> {
  return isObject(value) && isPositiveInteger(value.handoffTokens) && isPositiveInteger(value.reserveTokens);
}

function isApprovalRecord(
  value: unknown,
  proposalDigest: string,
  proposalEvidence: SourceEvidence[],
): boolean {
  return isObject(value) &&
    isTimestamp(value.approvedAt) &&
    isNonemptyString(value.approvedBy) &&
    value.proposalDigest === proposalDigest &&
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.every(isSourceEvidence) &&
    approvalEvidenceFailures(proposalEvidence, value.evidence).length === 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown, requireItem: boolean): value is string[] {
  return Array.isArray(value) && (!requireItem || value.length > 0) && value.every(isNonemptyString);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
