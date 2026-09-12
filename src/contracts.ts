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

export interface ControllerState {
  schemaVersion: 1;
  preparations: PreparationRecord[];
  executionAttempts: never[];
}

export type ControllerStatus = ControllerState;

export interface ControllerStateStore {
  load(): Promise<ControllerState>;
  save(state: ControllerState): Promise<void>;
}

export interface ApprovalRequest {
  approvedBy: string;
  projectHead: string;
  model: CapturedModel;
  evidence: SourceEvidence[];
}

export type ControllerErrorCode = "admission" | "proposal-validation" | "stale-approval" | "storage";

export interface ControllerError {
  code: ControllerErrorCode;
  diagnostics: string[];
}

export type ControllerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ControllerError };

export interface ControllerDependencies {
  now: () => Date;
  generateId: () => string;
}
