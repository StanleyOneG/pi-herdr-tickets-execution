export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CapturedModel {
  provider: string;
  id: string;
  thinkingLevel: ThinkingLevel;
  contextWindow: number;
}

export interface AdmissionSnapshot {
  project: {
    root: string;
    identity: string;
    head: string;
    branch: string;
    instructionFiles: string[];
  };
  runtime: {
    platform: "linux" | "darwin";
    piVersion?: string;
    herdrVersion?: string;
    projectTrusted: boolean;
    skillCommands: string[];
    toolNames: string[];
  };
  model: CapturedModel & {
    authenticated: boolean;
    available: boolean;
    authError?: string;
  };
}

export interface PrepareRequest {
  specReference: string;
  controllerName: string;
}

export interface SourceEvidence {
  identity: string;
  revision: string;
  contentDigest: string;
  retrievedAt: string;
  references: string[];
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type SetupOperation =
  | {
      kind: "dependency-install";
      packageManager: PackageManager;
      mode: "frozen" | "regular";
      purpose: string;
    }
  | {
      kind: "environment-template";
      source: string;
      destination: string;
      purpose: string;
    }
  | {
      kind: "database-setup";
      packageManager: PackageManager;
      script: string;
      environment: "development" | "test";
      purpose: string;
    };

export interface BatchProposal {
  schemaVersion: 1;
  controllerName: string;
  project: {
    identity: string;
    tracker: {
      identity: string;
      instructionSources: string[];
      instructionEvidenceIdentities: string[];
    };
  };
  sourceEvidence: SourceEvidence[];
  spec: { identity: string; title: string; evidenceIdentity: string };
  tickets: Array<{ identity: string; title: string; evidenceIdentity: string; claimedBy: string | null }>;
  dependencies: Array<{
    ticketIdentity: string;
    prerequisiteIdentity: string;
    kind: "ticket" | "external";
    status: "in-batch" | "resolved" | "unresolved";
    evidenceIdentity?: string;
  }>;
  target: { branch: string; baseCommit: string };
  model: CapturedModel;
  policy: {
    concurrency: number;
    context: { requestedHandoffTokens: number; reserveTokens: number };
    maxHandoffReplacements: number;
    maxRepairCycles: number;
    requiredReviews: Array<"standards" | "spec">;
    implementationSkillTestingRequired: boolean;
    checks: Array<{ command: string; source: string; evidenceIdentity: string }>;
    setupOperations: SetupOperation[];
  };
  resources: Array<{
    kind: "dependencies" | "environment" | "database" | "port" | "external";
    description: string;
    isolation: "isolated" | "shared-safe" | "serial-only" | "unknown" | "unsafe";
  }>;
  ambiguities: string[];
}

export interface ApprovalRecord {
  approvedAt: string;
  approvedBy: string;
  proposalDigest: string;
  evidence: SourceEvidence[];
}

export interface PreparationRecord {
  id: string;
  stage: "reasoning" | "proposed" | "approved";
  specReference: string;
  controllerName: string;
  project: AdmissionSnapshot["project"];
  model: CapturedModel;
  createdAt: string;
  proposal?: BatchProposal;
  proposalDigest?: string;
  effectiveContextLimit?: { handoffTokens: number; reserveTokens: number };
  approved?: ApprovalRecord;
}

export const MAX_PREPARATIONS = 100;
export const MAX_EXECUTION_ATTEMPTS = 100;
export const MAX_STATUS_PAGE_SIZE = 50;
export const MAX_ATTEMPT_DECISIONS = 50;
export const MAX_ATTEMPT_REFERENCES = 50;
export const MAX_ATTEMPT_DIAGNOSTICS = 20;

export type ExecutionLifecycle =
  | "claimed"
  | "preparing-worktree"
  | "starting"
  | "running"
  | "paused"
  | "pending-decision"
  | "takeover"
  | "completed-unaccepted"
  | "needs-attention"
  | "restart-required";

export interface ControllerOwner {
  instanceId: string;
  pid: number;
}

export interface GitFileFingerprint {
  path: string;
  contentDigest: string;
}

export interface OriginalCheckoutSnapshot {
  root: string;
  commonDir: string;
  head: string;
  branch: string;
  statusDigest: string;
  indexDiffDigest: string;
  worktreeDiffDigest: string;
  changedFiles: GitFileFingerprint[];
  untrackedFiles: GitFileFingerprint[];
}

export interface TicketWorktreePlan {
  path: string;
  branch: string;
}

export interface WorktreeIdentity extends TicketWorktreePlan {
  commonDir: string;
  head: string;
}

export interface WorkerAllocation {
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentName: string;
}

export interface WorkerIdentity extends WorkerAllocation {
  piPid: number;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  model: CapturedModel;
  mode: "tui";
  initialHistoryEntries: 0;
  skillCommands: string[];
  toolNames: string[];
  contextFiles: string[];
}

export type WorkerStatus = "ready" | "working" | "idle" | "done" | "blocked" | "missing" | "unknown";

export interface PendingDecisionInput {
  transportId?: string;
  question: string;
  context: string;
  options: string[];
  recommendation: string;
}

export interface WorkerObservation {
  identity: WorkerIdentity;
  status: WorkerStatus;
  artifactReferences: string[];
  decision?: PendingDecisionInput;
  diagnostic?: string;
  completionText?: string;
}

export interface DecisionRecord extends PendingDecisionInput {
  id: string;
  state: "pending" | "answered" | "delivered";
  requestedAt: string;
  answeredAt?: string;
  answeredBy?: string;
  answer?: string;
  deliveredAt?: string;
}

export interface SetupOperationRecord {
  index: number;
  operationDigest: string;
  state: "started" | "completed";
  startedAt: string;
  completedAt?: string;
  outcomeDigest?: string;
}

export interface ExecutionAttempt {
  id: string;
  preparationId: string;
  proposalDigest: string;
  ticketIdentity: string;
  workspaceId: string;
  lifecycle: ExecutionLifecycle;
  owner: ControllerOwner;
  createdAt: string;
  updatedAt: string;
  originalCheckout?: OriginalCheckoutSnapshot;
  worktreePlan?: TicketWorktreePlan;
  worktree?: WorktreeIdentity;
  workerAllocation?: WorkerAllocation;
  worker?: WorkerIdentity;
  setupOperations?: SetupOperationRecord[];
  suspendedFrom?: "running" | "pending-decision";
  decisions: DecisionRecord[];
  artifactReferences: string[];
  diagnostics: string[];
}

export interface StartTicketRequest {
  preparationId: string;
  ticketIdentity: string;
  workspaceId: string;
}

export interface AttemptRequest {
  attemptId: string;
}

export interface AnswerDecisionRequest extends AttemptRequest {
  decisionId: string;
  answer: string;
  answeredBy: string;
}

export interface RecordWorkerObservationRequest extends AttemptRequest {
  observation: WorkerObservation;
}

export interface GitWorktreePort {
  planTicketWorktree(input: {
    originalRoot: string;
    preparationId: string;
    ticketIdentity: string;
  }): TicketWorktreePlan;
  inspectOriginal(root: string): Promise<OriginalCheckoutSnapshot>;
  createTicketWorktree(input: {
    originalRoot: string;
    baseCommit: string;
    plan: TicketWorktreePlan;
  }): Promise<WorktreeIdentity>;
  inspectWorktree(path: string): Promise<WorktreeIdentity>;
}

export interface WorkerRuntimePort {
  allocate(input: {
    workspaceId: string;
    agentName: string;
    cwd: string;
  }): Promise<WorkerAllocation>;
  start(input: {
    allocation: WorkerAllocation;
    cwd: string;
    model: CapturedModel;
  }): Promise<WorkerIdentity>;
  inspect(identity: WorkerIdentity): Promise<WorkerObservation>;
  dispatchImplementation(identity: WorkerIdentity, ticketReference: string): Promise<WorkerObservation>;
  deliverDecision(identity: WorkerIdentity, decisionId: string, answer: string): Promise<WorkerObservation>;
  focus(identity: WorkerIdentity): Promise<void>;
}

export interface SetupRuntimePort {
  execute(input: { cwd: string; operation: SetupOperation }): Promise<{ outcomeDigest: string }>;
}

export interface ExecutionControllerDependencies {
  owner: ControllerOwner;
  git: GitWorktreePort;
  worker: WorkerRuntimePort;
  setup?: SetupRuntimePort;
}

export interface ControllerState {
  schemaVersion: 1;
  preparations: PreparationRecord[];
  executionAttempts: ExecutionAttempt[];
}

export interface PaginationRequest {
  limit: number;
  cursor?: string;
}

export interface ControllerStatus {
  preparations: PreparationRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  executionAttempts: ExecutionAttempt[];
}

export interface ControllerStateStore {
  load(): Promise<ControllerState>;
  save(state: ControllerState): Promise<void>;
}

export interface ApprovalRequest {
  approvedBy: string;
  proposalDigest: string;
  projectHead: string;
  model: CapturedModel;
  evidence: SourceEvidence[];
}

export type ControllerErrorCode =
  | "admission"
  | "authorization"
  | "proposal-validation"
  | "query-validation"
  | "stale-approval"
  | "execution-validation"
  | "execution-conflict"
  | "infrastructure"
  | "storage";

export interface ControllerError {
  code: ControllerErrorCode;
  diagnostics: string[];
}

export type ControllerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ControllerError };

export type LocalActorCapability = symbol;

export interface ControllerDependencies {
  actorCapability: LocalActorCapability;
  now: () => Date;
  generateId: () => string;
  formatPreview: (record: PreparationRecord) => string;
  execution?: ExecutionControllerDependencies;
}
