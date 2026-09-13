import { isAbsolute } from "node:path";

import type {
  AcceptanceReviewRecord,
  BatchProposal,
  CandidateGitState,
  CandidateReceipt,
  CapturedModel,
  ControllerState,
  DecisionRecord,
  ExecutionAttempt,
  OriginalCheckoutSnapshot,
  PreparationRecord,
  TicketWorktreePlan,
  WorkerAllocation,
  WorkerIdentity,
  WorktreeIdentity,
  SetupOperation,
  SourceEvidence,
  StagedIntegrationCandidate,
} from "./contracts.js";
import {
  MAX_ATTEMPT_DECISIONS,
  MAX_ATTEMPT_DIAGNOSTICS,
  MAX_ATTEMPT_REFERENCES,
  MAX_CANDIDATE_RECEIPTS,
  MAX_EXECUTION_ATTEMPTS,
  MAX_PREPARATIONS,
  occupiesImplementationSlot,
} from "./contracts.js";
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
const EXECUTION_LIFECYCLES = new Set([
  "claimed", "preparing-worktree", "starting", "running", "paused", "pending-decision",
  "takeover", "completed-unaccepted", "accepting", "integration-blocked", "accepted", "needs-attention", "restart-required",
]);
const DECISION_STATES = new Set(["pending", "answered", "delivered"]);
const REQUIRED_WORKER_SKILLS = ["skill:implement", "skill:tdd", "skill:code-review", "skill:handoff"];
const REQUIRED_WORKER_TOOLS = ["read", "bash", "edit", "write", "subagent"];

export function isControllerState(value: unknown): value is ControllerState {
  if (!isObject(value) || value.schemaVersion !== 1) return false;
  if (!Array.isArray(value.preparations) || value.preparations.length > MAX_PREPARATIONS) return false;
  if (!Array.isArray(value.executionAttempts) || value.executionAttempts.length > MAX_EXECUTION_ATTEMPTS) return false;
  if (!value.preparations.every(isPreparationRecord) || !value.executionAttempts.every(isExecutionAttempt)) return false;
  const preparations = value.preparations;
  const ids = preparations.map((record): string => record.id);
  if (new Set(ids).size !== ids.length) return false;
  const attempts = value.executionAttempts;
  const attemptIds = attempts.map((attempt): string => attempt.id);
  if (new Set(attemptIds).size !== attemptIds.length) return false;
  const ownershipKeys = attempts.map((attempt): string => `${attempt.preparationId}\0${attempt.ticketIdentity}`);
  if (new Set(ownershipKeys).size !== ownershipKeys.length) return false;
  for (const attempt of attempts) {
    const preparation = preparations.find((record): boolean => record.id === attempt.preparationId);
    if (!preparation || preparation.stage !== "approved" || !preparation.proposal || !preparation.proposalDigest) return false;
    if (attempt.proposalDigest !== preparation.proposalDigest) return false;
    const ticket = preparation.proposal.tickets.find((item): boolean => item.identity === attempt.ticketIdentity);
    if (!ticket || ticket.claimedBy !== null) return false;
    const setupRecords = attempt.setupOperations ?? [];
    if (setupRecords.length > preparation.proposal.policy.setupOperations.length) return false;
    if (setupRecords.some((record, index): boolean => record.index !== index || record.operationDigest !== digest(preparation.proposal!.policy.setupOperations[index]))) return false;
    const startedIndex = setupRecords.findIndex((record): boolean => record.state === "started");
    if (startedIndex >= 0 && startedIndex !== setupRecords.length - 1) return false;
    if (attempt.workerAllocation && (
      setupRecords.length !== preparation.proposal.policy.setupOperations.length ||
      setupRecords.some((record): boolean => record.state !== "completed")
    )) return false;
    if (attempt.originalCheckout && (
      attempt.originalCheckout.root !== preparation.project.root ||
      attempt.originalCheckout.head !== preparation.proposal.target.baseCommit ||
      attempt.originalCheckout.branch !== preparation.proposal.target.branch
    )) return false;
    if (attempt.worker && digest(attempt.worker.model) !== digest(preparation.proposal.model)) return false;
    const receipts = attempt.candidateReceipts ?? [];
    const receiptIds = receipts.map((receipt): string => receipt.id);
    if (new Set(receiptIds).size !== receiptIds.length) return false;
    const specEvidence = preparation.proposal.sourceEvidence.find(
      (evidence): boolean => evidence.identity === preparation.proposal!.spec.evidenceIdentity,
    );
    if (!specEvidence || receipts.some((receipt): boolean =>
      receipt.preparationId !== attempt.preparationId || receipt.ticketIdentity !== attempt.ticketIdentity ||
      receipt.attemptId !== attempt.id || receipt.sessionId !== attempt.worker?.sessionId ||
      receipt.sessionFile !== attempt.worker?.sessionFile ||
      receipt.proposalDigest !== attempt.proposalDigest || receipt.specIdentity !== preparation.proposal!.spec.identity ||
      receipt.specRevision !== specEvidence.revision || receipt.candidate.sourceBase !== attempt.worktree?.head ||
      receipt.candidate.branch !== attempt.worktree?.branch ||
      (receipt.integration !== undefined && (
        receipt.integration.worktree.preparationId !== preparation.id ||
        receipt.integration.worktree.commonDir !== attempt.worktree?.commonDir
      ))
    )) return false;
    const acceptedReceipt = receipts.find((receipt): boolean => receipt.state === "accepted");
    if (acceptedReceipt && (
      !acceptedReceipt.nativeEvidence.some((item): boolean => item.kind === "tests") ||
      !acceptedReceipt.nativeEvidence.some((item): boolean => item.kind === "reviews") ||
      acceptedReceipt.nativeEvidence.some((item): boolean => item.codeStateDigest !== acceptedReceipt.candidate.codeStateDigest) ||
      preparation.proposal.policy.checks.some((check): boolean => !acceptedReceipt.checks.some((record): boolean =>
        record.command === check.command && record.exitCode === 0 && record.candidateCommit === acceptedReceipt.integration?.staging.candidateCommit
      )) ||
      preparation.proposal.policy.requiredReviews.some((kind): boolean => !acceptedReceipt.reviews.some((review): boolean =>
        review.kind === kind && review.verdict === "passed" && review.findings.length === 0 &&
        review.candidateCommit === acceptedReceipt.integration?.staging.candidateCommit &&
        review.reviewBase === acceptedReceipt.integration?.staging.baseCommit
      )) ||
      (acceptedReceipt.integration?.stagedCodeStateDigest !== acceptedReceipt.candidate.codeStateDigest &&
        (!isNativeVerification(
          acceptedReceipt.integration?.nativeVerification,
          acceptedReceipt.integration?.staging.candidateCommit,
          acceptedReceipt.integration?.stagedCodeStateDigest,
        ) || acceptedReceipt.integration?.nativeVerification?.status !== "passed" ||
          acceptedReceipt.integration.nativeVerification.findings.length > 0))
    )) return false;
  }
  for (const preparation of preparations.filter((record): boolean => record.stage === "approved")) {
    const accepted = attempts
      .filter((attempt): boolean => attempt.preparationId === preparation.id)
      .flatMap((attempt): CandidateReceipt[] => attempt.candidateReceipts ?? [])
      .filter((receipt): boolean => receipt.state === "accepted")
      .sort((left, right): number => left.integration!.sequence! - right.integration!.sequence!);
    if (!preparation.batchIntegration || preparation.batchIntegration.sequence !== accepted.length) return false;
    if (accepted.some((receipt, index): boolean => receipt.integration?.sequence !== index + 1)) return false;
    const expectedHead = accepted.at(-1)?.integration?.integratedCommit ?? preparation.proposal!.target.baseCommit;
    if (preparation.batchIntegration.head !== expectedHead) return false;
    const pending = preparation.pendingIntegration;
    if (pending) {
      const attempt = attempts.find((item): boolean => item.id === pending.attemptId && item.preparationId === preparation.id);
      const receipt = attempt?.candidateReceipts?.find((item): boolean => item.id === pending.receiptId);
      if (!attempt || !receipt?.integration || pending.sequence !== preparation.batchIntegration.sequence + 1 ||
        pending.fromCommit !== preparation.batchIntegration.head || pending.toCommit !== receipt.integration.staging.candidateCommit ||
        pending.fromCommit !== receipt.integration.staging.baseCommit || pending.worktreePath !== receipt.integration.worktree.path ||
        pending.branch !== receipt.integration.worktree.branch || receipt.state !== "captured" ||
        (attempt.lifecycle !== "accepting" && attempt.lifecycle !== "needs-attention" &&
          !(attempt.lifecycle === "restart-required" && attempt.suspendedFrom === "accepting"))
      ) return false;
    }
  }
  for (const preparation of preparations.filter((record): boolean => record.stage === "approved")) {
    const occupancy = attempts.filter((attempt): boolean =>
      attempt.preparationId === preparation.id && occupiesImplementationSlot(attempt)
    ).length;
    if (occupancy > preparation.proposal!.policy.concurrency) return false;
  }
  const retainedWorkers = attempts.filter((attempt): boolean => attempt.lifecycle !== "accepted" && attempt.worker !== undefined);
  const workerLocations = retainedWorkers.map((attempt): string =>
    `${attempt.worker!.workspaceId}\0${attempt.worker!.tabId}\0${attempt.worker!.paneId}\0${attempt.worker!.sessionId}`
  );
  if (new Set(workerLocations).size !== workerLocations.length) return false;
  return !preparations.some((record): boolean =>
    record.stage === "approved" &&
    hasApprovedControllerNameCollision(preparations, record.controllerName, record.id)
  );
}

function isExecutionAttempt(value: unknown): value is ExecutionAttempt {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "id", "preparationId", "proposalDigest", "ticketIdentity", "workspaceId", "lifecycle", "owner",
    "createdAt", "updatedAt", "originalCheckout", "worktreePlan", "worktree", "candidateHead", "workerAllocation",
    "worker", "workerActiveAt", "controlGeneration", "setupOperations", "suspendedFrom", "decisions", "artifactReferences", "diagnostics",
    "candidateReceipts", "acceptedCommit",
  ])) return false;
  if (
    !isBoundedString(value.id) || !isBoundedString(value.preparationId) || !isDigest(value.proposalDigest) ||
    !isBoundedString(value.ticketIdentity) || !isBoundedString(value.workspaceId) ||
    !EXECUTION_LIFECYCLES.has(value.lifecycle as string) || !isControllerOwner(value.owner) ||
    !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) return false;
  if (value.originalCheckout !== undefined && !isOriginalCheckout(value.originalCheckout)) return false;
  if (!isWorktreePlan(value.worktreePlan)) return false;
  if (value.worktree !== undefined && !isWorktreeIdentity(value.worktree)) return false;
  if (value.candidateHead !== undefined && !isBoundedString(value.candidateHead)) return false;
  if (value.workerAllocation !== undefined && !isWorkerAllocation(value.workerAllocation)) return false;
  if (value.worker !== undefined && !isWorkerIdentity(value.worker)) return false;
  if (value.workerActiveAt !== undefined && !isTimestamp(value.workerActiveAt)) return false;
  if (value.controlGeneration !== undefined && (
    typeof value.controlGeneration !== "number" || !Number.isSafeInteger(value.controlGeneration) || value.controlGeneration < 0
  )) return false;
  if (value.setupOperations !== undefined && (!Array.isArray(value.setupOperations) || !value.setupOperations.every(isSetupOperationRecord))) return false;
  if (value.suspendedFrom !== undefined && ![
    "starting", "running", "pending-decision", "completed-unaccepted", "accepting", "integration-blocked",
  ].includes(value.suspendedFrom as string)) return false;
  if (!Array.isArray(value.decisions) || value.decisions.length > MAX_ATTEMPT_DECISIONS || !value.decisions.every(isDecision)) return false;
  const decisionIds = value.decisions.map((decision): string => decision.id);
  if (new Set(decisionIds).size !== decisionIds.length) return false;
  if (!isSafeTextArray(value.artifactReferences, MAX_ATTEMPT_REFERENCES, false)) return false;
  if (new Set(value.artifactReferences).size !== value.artifactReferences.length) return false;
  if (!isSafeTextArray(value.diagnostics, MAX_ATTEMPT_DIAGNOSTICS, false)) return false;
  if (value.lifecycle === "needs-attention" ? value.diagnostics.length === 0 : value.diagnostics.length !== 0) return false;
  if (value.candidateReceipts !== undefined && (
    !Array.isArray(value.candidateReceipts) || value.candidateReceipts.length > MAX_CANDIDATE_RECEIPTS ||
    !value.candidateReceipts.every(isCandidateReceipt)
  )) return false;
  if (value.acceptedCommit !== undefined && !isBoundedString(value.acceptedCommit)) return false;
  if (value.acceptedCommit !== undefined && !value.candidateReceipts?.some((receipt): boolean =>
    receipt.state === "accepted" && receipt.integration?.integratedCommit === value.acceptedCommit
  )) return false;
  if (value.lifecycle === "accepted" ? value.acceptedCommit === undefined : value.acceptedCommit !== undefined) return false;
  if (
    value.suspendedFrom !== undefined && value.lifecycle !== "paused" &&
    value.lifecycle !== "takeover" && value.lifecycle !== "restart-required"
  ) return false;
  if ((value.lifecycle === "paused" || value.lifecycle === "takeover") && value.suspendedFrom === undefined) return false;
  if (value.worktree && (value.worktree.path !== value.worktreePlan.path || value.worktree.branch !== value.worktreePlan.branch)) return false;
  if (value.candidateHead !== undefined && !value.worktree) return false;
  if (value.workerAllocation && (!value.worktree || value.workerAllocation.workspaceId !== value.workspaceId)) return false;
  if (value.worker && (
    !value.workerAllocation || !sameAllocation(value.worker, value.workerAllocation) ||
    !value.worktree || value.worker.cwd !== value.worktree.path
  )) return false;
  if (value.workerActiveAt !== undefined && !value.worker) return false;
  if (value.originalCheckout && value.worktree && value.originalCheckout.commonDir !== value.worktree.commonDir) return false;
  if (value.decisions.length > 0 && !value.worker) return false;
  const unresolvedDecision = value.decisions.some((decision): boolean => decision.state !== "delivered");
  if (value.lifecycle === "pending-decision" ? !unresolvedDecision :
    (value.lifecycle === "running" || value.lifecycle === "completed-unaccepted") && unresolvedDecision) return false;
  if (value.suspendedFrom === "pending-decision" && !unresolvedDecision) return false;

  if (value.lifecycle === "claimed") {
    return value.originalCheckout === undefined && value.worktree === undefined &&
      value.workerAllocation === undefined && value.worker === undefined && value.decisions.length === 0;
  }
  if (value.lifecycle === "preparing-worktree") {
    return value.originalCheckout !== undefined && value.worktree === undefined &&
      value.workerAllocation === undefined && value.worker === undefined && value.decisions.length === 0;
  }
  if (value.lifecycle === "starting") {
    return value.originalCheckout !== undefined && value.worktree !== undefined && value.decisions.length === 0;
  }
  if (["running", "paused", "pending-decision", "takeover", "completed-unaccepted", "accepting", "integration-blocked", "accepted"].includes(value.lifecycle as string)) {
    return value.originalCheckout !== undefined && value.worktree !== undefined &&
      value.workerAllocation !== undefined && value.worker !== undefined;
  }
  return true;
}

function isCandidateReceipt(value: unknown): value is CandidateReceipt {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "id", "state", "capturedAt", "acceptedAt", "proposalDigest", "specIdentity", "specRevision", "preparationId",
    "ticketIdentity", "attemptId", "sessionId", "sessionFile", "candidate", "nativeEvidence", "checks", "reviews", "findings",
    "evidenceReferences", "integration", "cleanup",
  ])) return false;
  if (!isBoundedString(value.id) || !["captured", "blocked", "accepted"].includes(value.state as string) ||
    !isTimestamp(value.capturedAt) || (value.acceptedAt !== undefined && !isTimestamp(value.acceptedAt)) ||
    !isDigest(value.proposalDigest) || !isBoundedString(value.specIdentity) ||
    !isBoundedString(value.specRevision) || !isBoundedString(value.preparationId) || !isBoundedString(value.ticketIdentity) ||
    !isBoundedString(value.attemptId) || !isBoundedString(value.sessionId) || !isBoundedString(value.sessionFile) ||
    !isAbsolute(value.sessionFile) || !isCandidateGitState(value.candidate) ||
    !Array.isArray(value.nativeEvidence) || value.nativeEvidence.length > 20 || !value.nativeEvidence.every(isNativeEvidence) ||
    !Array.isArray(value.checks) || value.checks.length > 50 || !value.checks.every(isGateCheck) ||
    !Array.isArray(value.reviews) || value.reviews.length > 10 || !value.reviews.every(isAcceptanceReview) ||
    !isSafeTextArray(value.findings, 100, false) || !isSafeTextArray(value.evidenceReferences, 200, false)
  ) return false;
  if (value.integration !== undefined && (!isObject(value.integration) || !hasOnlyKeys(value.integration, [
    "worktree", "staging", "stagedCodeStateDigest", "nativeVerification", "integratedCommit", "sequence",
  ]) || !isIntegrationWorktree(value.integration.worktree) || !isStagedCandidate(value.integration.staging) ||
    !isDigest(value.integration.stagedCodeStateDigest) ||
    (value.integration.nativeVerification !== undefined && !isNativeVerification(
      value.integration.nativeVerification,
      value.integration.staging.candidateCommit as string,
      value.integration.stagedCodeStateDigest as string,
    )) ||
    (value.integration.integratedCommit !== undefined && !isBoundedString(value.integration.integratedCommit)) ||
    (value.integration.sequence !== undefined && !isPositiveInteger(value.integration.sequence)))) return false;
  if (value.cleanup !== undefined && value.cleanup !== "closed" && value.cleanup !== "failed") return false;
  const integration = value.integration as CandidateReceipt["integration"];
  return value.state === "accepted"
    ? value.acceptedAt !== undefined && Date.parse(value.acceptedAt as string) >= Date.parse(value.capturedAt as string) &&
      integration?.integratedCommit === integration?.staging.candidateCommit && integration?.sequence !== undefined
    : value.acceptedAt === undefined && integration?.integratedCommit === undefined && integration?.sequence === undefined;
}

function isCandidateGitState(value: unknown): value is CandidateGitState {
  return isObject(value) && hasOnlyKeys(value, [
    "sourceBase", "head", "branch", "statusDigest", "indexDiffDigest", "worktreeDiffDigest", "untrackedFiles", "codeStateDigest", "candidateDigest",
  ]) && isBoundedString(value.sourceBase) && isBoundedString(value.head) && isBoundedString(value.branch) &&
    isDigest(value.statusDigest) && isDigest(value.indexDiffDigest) && isDigest(value.worktreeDiffDigest) &&
    isFileFingerprints(value.untrackedFiles) && isDigest(value.codeStateDigest) && isDigest(value.candidateDigest);
}

function isNativeEvidence(value: unknown): boolean {
  return isObject(value) && hasOnlyKeys(value, ["kind", "status", "codeStateDigest", "evidenceReference", "evidenceDigest", "completedAt"]) &&
    (value.kind === "tests" || value.kind === "reviews") && value.status === "passed" && isDigest(value.codeStateDigest) &&
    isSafeText(value.evidenceReference, 4_096) && isDigest(value.evidenceDigest) && isTimestamp(value.completedAt);
}

function isNativeVerification(value: unknown, candidateCommit: unknown, codeStateDigest: unknown): boolean {
  return isObject(value) && hasOnlyKeys(value, [
    "status", "candidateCommit", "codeStateDigest", "freshSessionId", "observedCommandDigests", "findings",
    "evidenceReference", "completedAt",
  ]) && (value.status === "passed" || value.status === "blocked") &&
    value.candidateCommit === candidateCommit && value.codeStateDigest === codeStateDigest &&
    isBoundedString(value.freshSessionId) && isSafeTextArray(value.observedCommandDigests, 100, false) &&
    value.observedCommandDigests.length > 0 && value.observedCommandDigests.every(isDigest) &&
    isSafeTextArray(value.findings, 50, false) &&
    (value.status === "passed" ? value.findings.length === 0 : value.findings.length > 0) &&
    isSafeText(value.evidenceReference, 4_096) && isTimestamp(value.completedAt);
}

function isGateCheck(value: unknown): boolean {
  return isObject(value) && hasOnlyKeys(value, ["command", "exitCode", "outputDigest", "logReference", "candidateCommit", "completedAt"]) &&
    typeof value.command === "string" && value.command.length <= 4_096 && isNonnegativeInteger(value.exitCode) &&
    isDigest(value.outputDigest) && isSafeText(value.logReference, 4_096) && isBoundedString(value.candidateCommit) && isTimestamp(value.completedAt);
}

function isAcceptanceReview(value: unknown): value is AcceptanceReviewRecord {
  return isObject(value) && hasOnlyKeys(value, [
    "kind", "verdict", "candidateCommit", "reviewBase", "freshSessionId", "findings", "evidenceReference", "completedAt",
  ]) && (value.kind === "standards" || value.kind === "spec") && (value.verdict === "passed" || value.verdict === "blocked") &&
    isBoundedString(value.candidateCommit) && isBoundedString(value.reviewBase) && isBoundedString(value.freshSessionId) &&
    isSafeTextArray(value.findings, 50, false) && isSafeText(value.evidenceReference, 4_096) && isTimestamp(value.completedAt);
}

function isIntegrationWorktree(value: unknown): boolean {
  return isObject(value) && hasOnlyKeys(value, ["path", "branch", "commonDir", "head", "preparationId"]) &&
    isBoundedString(value.path) && isAbsolute(value.path) && isBoundedString(value.branch) &&
    isBoundedString(value.commonDir) && isAbsolute(value.commonDir) && isBoundedString(value.head) && isBoundedString(value.preparationId);
}

function isStagedCandidate(value: unknown): value is StagedIntegrationCandidate {
  return isObject(value) && hasOnlyKeys(value, ["path", "branch", "baseCommit", "candidateCommit"]) &&
    isBoundedString(value.path) && isAbsolute(value.path) && isBoundedString(value.branch) &&
    isBoundedString(value.baseCommit) && isBoundedString(value.candidateCommit);
}

function isSetupOperationRecord(value: unknown): boolean {
  if (!isObject(value) || !hasOnlyKeys(value, ["index", "operationDigest", "state", "startedAt", "completedAt", "outcomeDigest"])) return false;
  if (!isNonnegativeInteger(value.index) || !isDigest(value.operationDigest) || !isTimestamp(value.startedAt)) return false;
  if (value.state === "started") return value.completedAt === undefined && value.outcomeDigest === undefined;
  return value.state === "completed" && isTimestamp(value.completedAt) && Date.parse(value.completedAt as string) >= Date.parse(value.startedAt as string) && isDigest(value.outcomeDigest);
}

function isControllerOwner(value: unknown): boolean {
  return isObject(value) && hasOnlyKeys(value, ["instanceId", "pid"]) &&
    isBoundedString(value.instanceId) && isPositiveInteger(value.pid);
}

function isOriginalCheckout(value: unknown): value is OriginalCheckoutSnapshot {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "root", "commonDir", "head", "branch", "statusDigest", "indexDiffDigest", "worktreeDiffDigest",
    "changedFiles", "untrackedFiles",
  ])) return false;
  if (
    !isBoundedString(value.root) || !isAbsolute(value.root) || !isBoundedString(value.commonDir) || !isAbsolute(value.commonDir) || !isBoundedString(value.head) ||
    !isBoundedString(value.branch) || !isDigest(value.statusDigest) || !isDigest(value.indexDiffDigest) ||
    !isDigest(value.worktreeDiffDigest) || !isFileFingerprints(value.changedFiles) ||
    !isFileFingerprints(value.untrackedFiles)
  ) return false;
  return true;
}

function isFileFingerprints(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 1_000) return false;
  const paths = new Set<string>();
  for (const file of value) {
    if (!isObject(file) || !hasOnlyKeys(file, ["path", "contentDigest"]) ||
      !isSafeRelativeGitPath(file.path) || !isDigest(file.contentDigest) || paths.has(file.path)
    ) return false;
    paths.add(file.path);
  }
  return true;
}

function isWorktreePlan(value: unknown): value is TicketWorktreePlan {
  return isObject(value) && hasOnlyKeys(value, ["path", "branch"]) &&
    isBoundedString(value.path) && isAbsolute(value.path) && isBoundedString(value.branch);
}

function isWorktreeIdentity(value: unknown): value is WorktreeIdentity {
  return isObject(value) && hasOnlyKeys(value, ["path", "branch", "commonDir", "head"]) &&
    isBoundedString(value.path) && isAbsolute(value.path) && isBoundedString(value.branch) &&
    isBoundedString(value.commonDir) && isAbsolute(value.commonDir) && isBoundedString(value.head);
}

function isWorkerAllocation(value: unknown): value is WorkerAllocation {
  return isObject(value) && hasOnlyKeys(value, ["workspaceId", "tabId", "paneId", "agentName"]) &&
    isBoundedString(value.workspaceId) && isBoundedString(value.tabId) &&
    isBoundedString(value.paneId) && isBoundedString(value.agentName);
}

export function isWorkerIdentity(value: unknown): value is WorkerIdentity {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "workspaceId", "tabId", "paneId", "agentName", "piPid", "sessionId", "sessionFile", "cwd",
    "model", "mode", "initialHistoryEntries", "skillCommands", "toolNames", "contextFiles",
  ]) || !isBoundedString(value.workspaceId) || !isBoundedString(value.tabId) ||
    !isBoundedString(value.paneId) || !isBoundedString(value.agentName) || !isPositiveInteger(value.piPid) ||
    !isBoundedString(value.sessionId) || !isBoundedString(value.sessionFile) || !isAbsolute(value.sessionFile) ||
    !isBoundedString(value.cwd) || !isAbsolute(value.cwd) || !isCapturedModel(value.model) ||
    value.mode !== "tui" || value.initialHistoryEntries !== 0 ||
    !isBoundedStringArray(value.skillCommands, 100) ||
    !REQUIRED_WORKER_SKILLS.every((skill): boolean => (value.skillCommands as string[]).includes(skill)) ||
    !isBoundedStringArray(value.toolNames, 100) || !isBoundedStringArray(value.contextFiles, 100) ||
    value.contextFiles.length === 0 || !value.contextFiles.every(isAbsolute)
  ) return false;
  if (
    new Set(value.skillCommands).size !== value.skillCommands.length ||
    new Set(value.toolNames).size !== value.toolNames.length ||
    new Set(value.contextFiles).size !== value.contextFiles.length
  ) return false;
  const toolNames = value.toolNames;
  return REQUIRED_WORKER_TOOLS.every((tool): boolean => toolNames.includes(tool));
}

function sameAllocation(worker: WorkerIdentity, allocation: WorkerAllocation): boolean {
  return worker.workspaceId === allocation.workspaceId && worker.tabId === allocation.tabId &&
    worker.paneId === allocation.paneId && worker.agentName === allocation.agentName;
}

function isDecision(value: unknown): value is DecisionRecord {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "id", "transportId", "state", "requestedAt", "question", "context", "options", "recommendation",
    "answeredAt", "answeredBy", "answer", "deliveredAt",
  ]) || !isBoundedString(value.id) || !DECISION_STATES.has(value.state as string)) return false;
  if (value.transportId !== undefined && (
    typeof value.transportId !== "string" || value.transportId !== value.id ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(value.transportId)
  )) return false;
  if (!isTimestamp(value.requestedAt) || !isSafeText(value.question, 4_000) || !isSafeText(value.context, 4_000)) return false;
  if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 20 || !value.options.every((option): boolean => isSafeText(option, 1_000))) return false;
  if (!isSafeText(value.recommendation, 4_000)) return false;
  if (value.state === "pending") {
    return value.answeredAt === undefined && value.answeredBy === undefined && value.answer === undefined && value.deliveredAt === undefined;
  }
  if (
    !isTimestamp(value.answeredAt) || Date.parse(value.answeredAt) < Date.parse(value.requestedAt) ||
    !isBoundedText(value.answeredBy, 500) || !isSafeText(value.answer, 4_000)
  ) return false;
  return value.state === "answered" ? value.deliveredAt === undefined :
    isTimestamp(value.deliveredAt) && Date.parse(value.deliveredAt) >= Date.parse(value.answeredAt);
}

function isPreparationRecord(value: unknown): value is PreparationRecord {
  if (!isObject(value)) return false;
  if (!isNonemptyString(value.id) || !PREPARATION_STAGES.has(value.stage as string)) return false;
  if (!isNonemptyString(value.specReference) || !isNonemptyString(value.controllerName)) return false;
  if (!isProject(value.project) || !isCapturedModel(value.model) || !isTimestamp(value.createdAt)) return false;

  if (value.stage === "reasoning") {
    return value.proposal === undefined && value.proposalDigest === undefined &&
      value.effectiveContextLimit === undefined && value.approved === undefined && value.batchIntegration === undefined &&
      value.pendingIntegration === undefined;
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
  if (value.stage === "proposed") {
    return value.approved === undefined && value.batchIntegration === undefined && value.pendingIntegration === undefined;
  }
  return isApprovalRecord(value.approved, value.proposalDigest, value.proposal.sourceEvidence) &&
    isObject(value.batchIntegration) && isBoundedString(value.batchIntegration.head) &&
    isNonnegativeInteger(value.batchIntegration.sequence) &&
    (value.pendingIntegration === undefined || isPendingIntegration(value.pendingIntegration));
}

function isPendingIntegration(value: unknown): boolean {
  return isObject(value) && hasOnlyKeys(value, [
    "attemptId", "receiptId", "worktreePath", "branch", "fromCommit", "toCommit", "sequence",
  ]) && isBoundedString(value.attemptId) && isBoundedString(value.receiptId) &&
    isBoundedString(value.worktreePath) && isAbsolute(value.worktreePath) && isBoundedString(value.branch) &&
    isBoundedString(value.fromCommit) && isBoundedString(value.toCommit) && isPositiveInteger(value.sequence);
}

function isProject(value: unknown): value is PreparationRecord["project"] {
  return isObject(value) &&
    isNonemptyString(value.root) &&
    isNonemptyString(value.identity) &&
    isNonemptyString(value.head) &&
    isNonemptyString(value.branch) &&
    isStringArray(value.instructionFiles, true);
}

export function isCapturedModel(value: unknown): value is CapturedModel {
  return isObject(value) &&
    isNonemptyString(value.provider) &&
    isNonemptyString(value.id) &&
    THINKING_LEVELS.has(value.thinkingLevel as string) &&
    isPositiveInteger(value.contextWindow);
}

export function isBatchProposal(value: unknown): value is BatchProposal {
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

export function isSourceEvidence(value: unknown): value is SourceEvidence {
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key): boolean => keys.has(key));
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoundedString(value: unknown): value is string {
  return isBoundedText(value, 4_096);
}

function isSafeRelativeGitPath(value: unknown): value is string {
  return isBoundedString(value) && !isAbsolute(value) && !value.includes("\0") &&
    value.split("/").every((segment): boolean => segment !== "" && segment !== "." && segment !== "..");
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isBoundedStringArray(value: unknown, maximumItems: number, requireItem = true): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && (!requireItem || value.length > 0) &&
    value.every(isBoundedString);
}

function isSafeTextArray(value: unknown, maximumItems: number, requireItem: boolean): value is string[] {
  return isBoundedStringArray(value, maximumItems, requireItem) && value.every((item): boolean => !containsCredential(item));
}

function isSafeText(value: unknown, maximum: number): value is string {
  return isBoundedText(value, maximum) && !containsCredential(value);
}

function containsCredential(value: string): boolean {
  return /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+\b/i.test(value) ||
    /(?:token|secret|password|api[_ -]?key)\s*[=:]\s*\S+/i.test(value) ||
    /[?&](?:access_?token|api_?key|token|secret|password)=/i.test(value);
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
