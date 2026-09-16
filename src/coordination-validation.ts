import { isAbsolute } from "node:path";

import { MAX_CONTEXT_REPLACEMENTS, type ContextSample, type CoordinationConfig, type HandoffBinding, type OrchestratorCommand, type OrchestratorLease, type OrchestratorRecord, type WorkerHandoff } from "./coordination-contracts.js";
import { digest } from "./policy.js";
import { isOrchestratorIdentity, isWorkerIdentity } from "./state-validation.js";

export function isBoundedCoordinationText(value: unknown, max = 4_000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0") &&
    !/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+\b/i.test(value) &&
    !/(?:token|secret|password|api[_ -]?key)\s*[=:]\s*\S+/i.test(value);
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key): boolean => allowed.includes(key));
}
export function isNaturalNumber(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isPositiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function isDigestText(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isAbsoluteCoordinationPath(value: unknown): value is string { return isBoundedCoordinationText(value, 4_096) && isAbsolute(value); }
function isAllocation(value: unknown): boolean {
  return isObject(value) && hasOnlyKeys(value, ["workspaceId", "tabId", "paneId", "agentName"]) &&
    [value.workspaceId, value.tabId, value.paneId, value.agentName].every((item): boolean => isBoundedCoordinationText(item));
}
function isOrchestratorLease(value: unknown): value is OrchestratorLease {
  return isObject(value) && hasOnlyKeys(value, ["preparationId", "generation", "sessionId"]) &&
    isBoundedCoordinationText(value.preparationId) && isPositiveInteger(value.generation) && isBoundedCoordinationText(value.sessionId);
}
export function isCoordinationConfig(value: unknown): value is CoordinationConfig {
  if (!isObject(value)) return false;
  if (value.role === "unmanaged") return hasOnlyKeys(value, ["role"]);
  if (value.role === "implementation") {
    return hasOnlyKeys(value, ["role", "contextLimit"]) && isPositiveInteger(value.contextLimit);
  }
  if (value.role === "orchestrator") {
    return hasOnlyKeys(value, ["role", "contextLimit", "lease"]) &&
      isPositiveInteger(value.contextLimit) && isOrchestratorLease(value.lease);
  }
  return value.role === "handoff" && hasOnlyKeys(value, ["role", "binding"]) && isHandoffBinding(value.binding);
}
export function isContextSample(value: unknown): value is ContextSample {
  return isObject(value) && hasOnlyKeys(value, ["tokens", "contextWindow", "compactions", "observedAt"]) &&
    (value.tokens === null || isNaturalNumber(value.tokens)) && isNaturalNumber(value.contextWindow) &&
    value.contextWindow > 0 && isNaturalNumber(value.compactions) && typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt));
}
export function isOrchestratorCommand(value: unknown): value is OrchestratorCommand {
  if (!isObject(value) || !hasOnlyKeys(value, ["preparationId", "generation", "sessionId", "operation"]) ||
    !isBoundedCoordinationText(value.preparationId) || !isNaturalNumber(value.generation) || value.generation === 0 ||
    !isBoundedCoordinationText(value.sessionId) || !isObject(value.operation)) return false;
  const op = value.operation;
  if (op.kind === "start") return hasOnlyKeys(op, ["kind", "ticketIdentity", "assessment"]) && isBoundedCoordinationText(op.ticketIdentity) && isBoundedCoordinationText(op.assessment);
  if (op.kind === "assess") return hasOnlyKeys(op, ["kind", "attemptId", "assessment"]) && isBoundedCoordinationText(op.attemptId) && isBoundedCoordinationText(op.assessment);
  if (op.kind === "wait") return hasOnlyKeys(op, ["kind", "assessment"]) && isBoundedCoordinationText(op.assessment);
  return op.kind === "escalate" && hasOnlyKeys(op, ["kind", "question", "context", "options", "recommendation"]) &&
    isBoundedCoordinationText(op.question) && isBoundedCoordinationText(op.context) && isBoundedCoordinationText(op.recommendation) &&
    Array.isArray(op.options) && op.options.length > 0 && op.options.length <= 20 && op.options.every((item): boolean => isBoundedCoordinationText(item, 1_000));
}
export function isOrchestratorRecord(value: unknown): value is OrchestratorRecord {
  if (!isObject(value) || !hasOnlyKeys(value, ["generation", "workspaceId", "phase", "reason", "allocation", "session", "context", "decisions", "checkpoint", "lastOutcome", "diagnostic"]) ||
    !isNaturalNumber(value.generation) || value.generation === 0 || !isBoundedCoordinationText(value.workspaceId) ||
    !["starting", "running", "rotation-pending", "restart-required", "needs-attention"].includes(value.phase as string) ||
    !["initial", "ticket-boundary", "context", "restart"].includes(value.reason as string) ||
    !isBoundedCoordinationText(value.checkpoint) || !Array.isArray(value.decisions) || value.decisions.length > 50 ||
    (value.lastOutcome !== undefined && !isBoundedCoordinationText(value.lastOutcome)) ||
    (value.diagnostic !== undefined && !isBoundedCoordinationText(value.diagnostic)) ||
    (value.context !== undefined && !isContextSample(value.context)) ||
    (value.allocation !== undefined && !isAllocation(value.allocation)) ||
    (value.session !== undefined && !isOrchestratorIdentity(value.session))) return false;
  if (value.session) {
    if (!isObject(value.allocation)) return false;
    if (["workspaceId", "tabId", "paneId", "agentName"].some((key): boolean =>
      (value.session as unknown as Record<string, unknown>)[key] !== (value.allocation as Record<string, unknown>)[key])) return false;
    if (value.session.workspaceId !== value.workspaceId) return false;
  }
  return (value.phase !== "running" && value.phase !== "rotation-pending") || value.session !== undefined;
}
export function isHandoffBinding(value: unknown): value is HandoffBinding {
  return isObject(value) && hasOnlyKeys(value, ["preparationId", "attemptId", "ticketIdentity", "specIdentity", "worktreePath", "branch", "codeStateDigest"]) &&
    [value.preparationId, value.attemptId, value.ticketIdentity, value.specIdentity, value.branch].every((item): boolean => isBoundedCoordinationText(item)) &&
    isAbsoluteCoordinationPath(value.worktreePath) && isDigestText(value.codeStateDigest);
}
export function isWorkerHandoff(value: unknown): value is WorkerHandoff {
  if (!isObject(value) || !hasOnlyKeys(value, ["replacements", "phase", "binding", "artifact", "previousWorker", "replacementAllocation"]) ||
    !isNaturalNumber(value.replacements) || value.replacements > MAX_CONTEXT_REPLACEMENTS ||
    !["requested", "retiring", "starting", "complete", "blocked"].includes(value.phase as string) ||
    !isWorkerIdentity(value.previousWorker) || !isHandoffBinding(value.binding) ||
    value.previousWorker.cwd !== value.binding.worktreePath ||
    (value.replacementAllocation !== undefined && !isAllocation(value.replacementAllocation))) return false;
  if (value.artifact !== undefined) {
    if (!isObject(value.artifact)) return false;
    const { sessionId, sourcePath, reference, contentDigest, ...binding } = value.artifact;
    if (sessionId !== value.previousWorker.sessionId || !isAbsoluteCoordinationPath(sourcePath) || !isAbsoluteCoordinationPath(reference) || !isDigestText(contentDigest) ||
      digest(binding) !== digest(value.binding)) return false;
  }
  return !["retiring", "starting", "complete"].includes(value.phase as string) || value.artifact !== undefined;
}
