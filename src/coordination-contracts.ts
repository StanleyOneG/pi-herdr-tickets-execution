import type { DecisionRecord, WorkerAllocation, WorkerIdentity } from "./contracts.js";

export const MAX_CONTEXT_REPLACEMENTS = 2;
export const ORCHESTRATOR_TOOL_NAMES = ["read", "grep", "find", "ls", "herdr_orchestrator_operation"] as const;

/** Current occupancy, never accumulated billing usage. Null means unknown. */
export interface ContextSample {
  tokens: number | null;
  contextWindow: number;
  compactions: number;
  observedAt: string;
}

export interface OrchestratorRecord {
  generation: number;
  workspaceId: string;
  phase: "starting" | "running" | "rotation-pending" | "restart-required" | "needs-attention";
  reason: "initial" | "ticket-boundary" | "context" | "restart";
  allocation?: WorkerAllocation;
  session?: WorkerIdentity;
  context?: ContextSample;
  decisions: DecisionRecord[];
  checkpoint: string;
  lastOutcome?: string;
  diagnostic?: string;
}

export interface StartOrchestratorRequest { preparationId: string; workspaceId: string }
export interface OrchestratorLease { preparationId: string; generation: number; sessionId: string }
export type OrchestratorOperation =
  | { kind: "start"; ticketIdentity: string; assessment: string }
  | { kind: "assess"; attemptId: string; assessment: string }
  | { kind: "escalate"; question: string; context: string; options: string[]; recommendation: string }
  | { kind: "wait"; assessment: string };
export interface OrchestratorCommand extends OrchestratorLease { operation: OrchestratorOperation }

export type CoordinationConfig =
  | { role: "unmanaged" }
  | { role: "implementation"; contextLimit: number }
  | { role: "orchestrator"; contextLimit: number; lease: OrchestratorLease }
  | { role: "handoff"; binding: HandoffBinding };

export interface HandoffBinding {
  preparationId: string;
  attemptId: string;
  ticketIdentity: string;
  specIdentity: string;
  worktreePath: string;
  branch: string;
  codeStateDigest: string;
}
export interface DurableHandoff extends HandoffBinding {
  sessionId: string;
  sourcePath: string;
  reference: string;
  contentDigest: string;
}
export interface WorkerHandoff {
  replacements: number;
  phase: "requested" | "retiring" | "starting" | "complete" | "blocked";
  binding: HandoffBinding;
  artifact?: DurableHandoff;
  previousWorker: WorkerIdentity;
  replacementAllocation?: WorkerAllocation;
}
