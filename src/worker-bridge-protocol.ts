import type { CapturedModel } from "./contracts.js";

export const WORKER_BRIDGE_ENDPOINT_ENV = "HERDR_WORKER_BRIDGE_ENDPOINT";
export const WORKER_BRIDGE_NONCE_ENV = "HERDR_WORKER_BRIDGE_NONCE";
export const WORKER_BRIDGE_AGENT_ENV = "HERDR_WORKER_BRIDGE_AGENT_NAME";
export const WORKER_DECISION_REQUEST_DIRECTORY_ENV = "HERDR_WORKER_DECISION_REQUEST_DIRECTORY";
export const WORKER_DECISION_RESPONSE_DIRECTORY_ENV = "HERDR_WORKER_DECISION_RESPONSE_DIRECTORY";
export const WORKER_READINESS_COMMAND = "/herdr-worker-ready";
export const WORKER_REVIEW_ENDPOINT_ENV = "HERDR_WORKER_REVIEW_ENDPOINT";
export const WORKER_REVIEW_NONCE_ENV = "HERDR_WORKER_REVIEW_NONCE";

export interface WorkerBridgeChannel {
  endpoint: string;
  nonce: string;
  requestDirectory?: string;
  responseDirectory?: string;
  lifecycleEndpoint?: string;
  reviewEndpoint?: string;
}

export interface WorkerLifecycleReceipt {
  schemaVersion: 1;
  nonce: string;
  sessionId: string;
  state: "working" | "settled";
  observedAt: string;
  outstandingJobs: string[];
}

export interface WorkerReviewReceipt {
  schemaVersion: 1;
  nonce: string;
  sessionId: string;
  kind: "standards" | "spec";
  verdict: "passed" | "blocked";
  candidateCommit: string;
  reviewBase: string;
  findings: string[];
  completedAt: string;
}

export interface WorkerDecisionRequest {
  schemaVersion: 1;
  nonce: string;
  id: string;
  requestedAt: string;
  question: string;
  context: string;
  options: string[];
  recommendation: string;
}

export interface WorkerDecisionAnswer {
  schemaVersion: 1;
  nonce: string;
  id: string;
  answeredAt: string;
  answer: string;
}

export interface WorkerCommandSource {
  name: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export interface WorkerReadinessReceipt {
  schemaVersion: 1;
  nonce: string;
  observedAt: string;
  sessionStartReason: "startup" | "reload" | "new" | "resume" | "fork";
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentName: string;
  piPid: number;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  mode: "tui" | "rpc" | "json" | "print";
  initialHistoryEntries: number;
  model: CapturedModel;
  commands: WorkerCommandSource[];
  toolNames: string[];
  contextFiles: string[];
}

/** Runtime-owned transport for one fresh worker readiness receipt. */
export interface WorkerBridgeTransport {
  openChannel(agentName: string): Promise<WorkerBridgeChannel>;
  waitForReadiness(channel: WorkerBridgeChannel, timeoutMs: number): Promise<WorkerReadinessReceipt>;
  channelForAgent?(agentName: string): Promise<WorkerBridgeChannel>;
  nextDecisionRequest?(channel: WorkerBridgeChannel): Promise<WorkerDecisionRequest | undefined>;
  acknowledgeDecisionRequest?(channel: WorkerBridgeChannel, decisionId: string): Promise<void>;
  deliverDecision?(channel: WorkerBridgeChannel, answer: WorkerDecisionAnswer): Promise<void>;
  readLifecycle?(channel: WorkerBridgeChannel): Promise<WorkerLifecycleReceipt | undefined>;
  waitForReview?(channel: WorkerBridgeChannel, timeoutMs: number): Promise<WorkerReviewReceipt>;
}
