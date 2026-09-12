import type {
  AdmissionSnapshot,
  ApprovalRequest,
  BatchProposal,
  ControllerDependencies,
  ControllerErrorCode,
  ControllerResult,
  ControllerState,
  ControllerStateStore,
  ControllerStatus,
  LocalActorCapability,
  PaginationRequest,
  PreparationRecord,
  PrepareRequest,
} from "./contracts.js";
import { MAX_PREPARATIONS, MAX_STATUS_PAGE_SIZE } from "./contracts.js";
import {
  approvalFailures,
  calculateContextLimit,
  digest,
  hasApprovedControllerNameCollision,
  validateAdmission,
  validateProposal,
} from "./policy.js";
export type {
  AdmissionSnapshot,
  ApprovalRequest,
  BatchProposal,
  CapturedModel,
  ControllerError,
  ControllerResult,
  ControllerState,
  ControllerStateStore,
  ControllerStatus,
  LocalActorCapability,
  PaginationRequest,
  PreparationRecord,
  SetupOperation,
  SourceEvidence,
  ThinkingLevel,
} from "./contracts.js";

const AUTHORIZATION_DIAGNOSTIC = "The caller does not hold the local controller capability";

export class PreparationController {
  constructor(
    private readonly store: ControllerStateStore,
    private readonly dependencies: ControllerDependencies,
  ) {}

  async prepare(
    actor: LocalActorCapability,
    request: PrepareRequest,
    snapshot: AdmissionSnapshot,
  ): Promise<ControllerResult<PreparationRecord>> {
    const denied = this.authorizationFailure<PreparationRecord>(actor);
    if (denied) return denied;

    const failures = validateAdmission(snapshot);
    if (!request.specReference.trim()) failures.push("A selected spec reference is required");
    if (!request.controllerName.trim()) failures.push("A readable controller name is required");
    if (failures.length > 0) return failure("admission", failures);

    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    if (loaded.value.preparations.length >= MAX_PREPARATIONS) {
      return failure("admission", [
        `Controller preparation capacity of ${MAX_PREPARATIONS} reached; archive this state file before preparing another batch`,
      ]);
    }
    if (hasApprovedControllerNameCollision(loaded.value.preparations, request.controllerName)) {
      return failure("admission", [`Controller name already belongs to an approved batch: ${request.controllerName}`]);
    }

    const record: PreparationRecord = {
      id: this.dependencies.generateId(),
      stage: "reasoning",
      specReference: request.specReference,
      controllerName: request.controllerName,
      project: structuredClone(snapshot.project),
      model: {
        provider: snapshot.model.provider,
        id: snapshot.model.id,
        thinkingLevel: snapshot.model.thinkingLevel,
        contextWindow: snapshot.model.contextWindow,
      },
      createdAt: this.dependencies.now().toISOString(),
    };
    loaded.value.preparations.push(record);
    const saved = await this.saveState(loaded.value);
    return saved.ok ? success(structuredClone(record)) : saved;
  }

  async submitProposal(
    actor: LocalActorCapability,
    preparationId: string,
    proposal: BatchProposal,
  ): Promise<ControllerResult<PreparationRecord>> {
    const denied = this.authorizationFailure<PreparationRecord>(actor);
    if (denied) return denied;

    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    const record = loaded.value.preparations.find((item): boolean => item.id === preparationId);
    if (!record) return failure("proposal-validation", [`Unknown preparation: ${preparationId}`]);
    if (record.stage === "approved") {
      return failure("proposal-validation", ["Approved batches cannot be replaced; prepare a new proposal"]);
    }

    const failures = validateProposal(record, proposal);
    if (hasApprovedControllerNameCollision(loaded.value.preparations, proposal.controllerName, preparationId)) {
      failures.push(`Controller name already belongs to an approved batch: ${proposal.controllerName}`);
    }
    if (failures.length > 0) return failure("proposal-validation", failures);

    record.stage = "proposed";
    record.controllerName = proposal.controllerName;
    record.proposal = structuredClone(proposal);
    record.proposalDigest = digest(proposal);
    record.effectiveContextLimit = calculateContextLimit(proposal.model.contextWindow, proposal.policy.context);
    const saved = await this.saveState(loaded.value);
    return saved.ok ? success(structuredClone(record)) : saved;
  }

  async preview(
    actor: LocalActorCapability,
    preparationId: string,
  ): Promise<ControllerResult<string>> {
    const denied = this.authorizationFailure<string>(actor);
    if (denied) return denied;

    const record = await this.getPreparation(actor, preparationId);
    if (!record.ok) return record;
    if (!record.value.proposal) return failure("proposal-validation", ["Preparation has no proposal to preview"]);
    return success(this.dependencies.formatPreview(record.value));
  }

  async getPreparation(
    actor: LocalActorCapability,
    preparationId: string,
  ): Promise<ControllerResult<PreparationRecord>> {
    const denied = this.authorizationFailure<PreparationRecord>(actor);
    if (denied) return denied;

    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    const record = loaded.value.preparations.find((item): boolean => item.id === preparationId);
    return record
      ? success(structuredClone(record))
      : failure("proposal-validation", [`Unknown preparation: ${preparationId}`]);
  }

  async validateApproval(
    actor: LocalActorCapability,
    preparationId: string,
    request: ApprovalRequest,
  ): Promise<ControllerResult<PreparationRecord>> {
    const denied = this.authorizationFailure<PreparationRecord>(actor);
    if (denied) return denied;

    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    return this.checkApproval(loaded.value, preparationId, request);
  }

  async approve(
    actor: LocalActorCapability,
    preparationId: string,
    request: ApprovalRequest,
  ): Promise<ControllerResult<PreparationRecord>> {
    const denied = this.authorizationFailure<PreparationRecord>(actor);
    if (denied) return denied;

    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    const checked = this.checkApproval(loaded.value, preparationId, request);
    if (!checked.ok) return checked;

    const record = loaded.value.preparations.find((item): boolean => item.id === preparationId)!;
    record.stage = "approved";
    record.approved = {
      approvedAt: this.dependencies.now().toISOString(),
      approvedBy: request.approvedBy,
      proposalDigest: record.proposalDigest!,
      evidence: structuredClone(request.evidence),
    };
    const saved = await this.saveState(loaded.value);
    return saved.ok ? success(structuredClone(record)) : saved;
  }

  async status(
    actor: LocalActorCapability,
    pagination: PaginationRequest,
  ): Promise<ControllerResult<ControllerStatus>> {
    const denied = this.authorizationFailure<ControllerStatus>(actor);
    if (denied) return denied;
    if (!Number.isInteger(pagination.limit) || pagination.limit < 1 || pagination.limit > MAX_STATUS_PAGE_SIZE) {
      return failure("query-validation", [`Status page limit must be between 1 and ${MAX_STATUS_PAGE_SIZE}`]);
    }
    const offset = decodeCursor(pagination.cursor);
    if (offset === undefined) return failure("query-validation", ["Status cursor is invalid"]);

    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    if (offset > loaded.value.preparations.length) return failure("query-validation", ["Status cursor is out of range"]);
    const end = Math.min(offset + pagination.limit, loaded.value.preparations.length);
    const hasMore = end < loaded.value.preparations.length;
    return success({
      preparations: structuredClone(loaded.value.preparations.slice(offset, end)),
      nextCursor: hasMore ? encodeCursor(end) : null,
      hasMore,
      executionAttempts: [],
    });
  }

  private authorizationFailure<T>(actor: LocalActorCapability): ControllerResult<T> | undefined {
    return actor === this.dependencies.actorCapability
      ? undefined
      : failure("authorization", [AUTHORIZATION_DIAGNOSTIC]);
  }

  private checkApproval(
    state: ControllerState,
    preparationId: string,
    request: ApprovalRequest,
  ): ControllerResult<PreparationRecord> {
    const record = state.preparations.find((item): boolean => item.id === preparationId);
    const failures = approvalFailures(state.preparations, record, request);
    return failures.length > 0 ? failure("stale-approval", failures) : success(structuredClone(record!));
  }

  private async loadState(): Promise<ControllerResult<ControllerState>> {
    try {
      return success(await this.store.load());
    } catch {
      return failure("storage", ["Controller state could not be read"]);
    }
  }

  private async saveState(state: ControllerState): Promise<ControllerResult<ControllerState>> {
    try {
      await this.store.save(state);
      return success(state);
    } catch {
      return failure("storage", ["Controller state could not be written durably"]);
    }
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^(?:0|[1-9]\d*)$/.test(decoded)) return undefined;
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) return undefined;
    const offset = Number(decoded);
    return Number.isSafeInteger(offset) ? offset : undefined;
  } catch {
    return undefined;
  }
}

function success<T>(value: T): ControllerResult<T> {
  return { ok: true, value };
}

function failure<T>(code: ControllerErrorCode, diagnostics: string[]): ControllerResult<T> {
  return { ok: false, error: { code, diagnostics } };
}
