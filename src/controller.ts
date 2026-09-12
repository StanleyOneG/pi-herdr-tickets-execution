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
  PreparationRecord,
  PrepareRequest,
} from "./contracts.js";
import {
  approvalFailures,
  calculateContextLimit,
  digest,
  formatSetupOperation,
  normalizeControllerName,
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
  ControllerStateStore,
  ControllerStatus,
  PreparationRecord,
  SetupOperation,
  SourceEvidence,
  ThinkingLevel,
} from "./contracts.js";

export class PreparationController {
  constructor(
    private readonly store: ControllerStateStore,
    private readonly dependencies: ControllerDependencies,
  ) {}

  async prepare(request: PrepareRequest, snapshot: AdmissionSnapshot): Promise<ControllerResult<PreparationRecord>> {
    const failures = validateAdmission(snapshot);
    if (!request.specReference.trim()) failures.push("A selected spec reference is required");
    if (!request.controllerName.trim()) failures.push("A readable controller name is required");
    if (failures.length > 0) return failure("admission", failures);

    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    const normalizedName = normalizeControllerName(request.controllerName);
    if (
      loaded.value.preparations.some(
        (item) => item.stage === "approved" && normalizeControllerName(item.controllerName) === normalizedName,
      )
    ) {
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
    preparationId: string,
    proposal: BatchProposal,
  ): Promise<ControllerResult<PreparationRecord>> {
    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    const record = loaded.value.preparations.find((item) => item.id === preparationId);
    if (!record) return failure("proposal-validation", [`Unknown preparation: ${preparationId}`]);
    if (record.stage === "approved") {
      return failure("proposal-validation", ["Approved batches cannot be replaced; prepare a new proposal"]);
    }

    const failures = validateProposal(record, proposal);
    const normalizedName = normalizeControllerName(proposal.controllerName);
    if (
      loaded.value.preparations.some(
        (item) =>
          item.id !== preparationId &&
          item.stage === "approved" &&
          normalizeControllerName(item.controllerName) === normalizedName,
      )
    ) {
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

  async preview(preparationId: string): Promise<ControllerResult<string>> {
    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    const record = loaded.value.preparations.find((item) => item.id === preparationId);
    if (!record) return failure("proposal-validation", [`Unknown preparation: ${preparationId}`]);
    if (!record.proposal) return failure("proposal-validation", ["Preparation has no proposal to preview"]);
    return success(formatPreview(record));
  }

  async validateApproval(
    preparationId: string,
    request: ApprovalRequest,
  ): Promise<ControllerResult<PreparationRecord>> {
    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    return this.checkApproval(loaded.value, preparationId, request);
  }

  async approve(
    preparationId: string,
    request: ApprovalRequest,
  ): Promise<ControllerResult<PreparationRecord>> {
    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    const checked = this.checkApproval(loaded.value, preparationId, request);
    if (!checked.ok) return checked;

    const record = loaded.value.preparations.find((item) => item.id === preparationId)!;
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

  async status(): Promise<ControllerResult<ControllerStatus>> {
    const loaded = await this.loadState();
    return loaded.ok ? success(structuredClone(loaded.value)) : loaded;
  }

  private checkApproval(
    state: ControllerState,
    preparationId: string,
    request: ApprovalRequest,
  ): ControllerResult<PreparationRecord> {
    const record = state.preparations.find((item) => item.id === preparationId);
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

function formatPreview(record: PreparationRecord): string {
  const proposal = record.proposal!;
  const edges = proposal.dependencies.map((edge) => `${edge.ticketIdentity} <- ${edge.prerequisiteIdentity}`).join(", ") || "none";
  return [
    `${record.controllerName} (${record.stage})`,
    `Project/spec: ${proposal.project.identity} / ${proposal.spec.identity} — ${proposal.spec.title}`,
    `Tickets: ${proposal.tickets.map((ticket) => `${ticket.identity} ${ticket.title}${ticket.claimedBy === null ? " [unclaimed]" : ` [claimed: ${ticket.claimedBy}]`}`).join("; ")}`,
    `Dependencies: ${edges}`,
    `Target: ${proposal.target.branch} @ ${proposal.target.baseCommit}`,
    `Model: ${proposal.model.provider}/${proposal.model.id}:${proposal.model.thinkingLevel}`,
    `Policy: concurrency ${proposal.policy.concurrency}; handoff ${record.effectiveContextLimit?.handoffTokens}; reserve ${record.effectiveContextLimit?.reserveTokens}; handoff replacements ${proposal.policy.maxHandoffReplacements}; repairs ${proposal.policy.maxRepairCycles}`,
    `Reviews/checks: ${proposal.policy.requiredReviews.join(", ")}; ${proposal.policy.checks.map((check) => check.command).join(", ") || "no optional checks"}`,
    `Setup: ${proposal.policy.setupOperations.map(formatSetupOperation).join("; ") || "none"}`,
    `Resources: ${proposal.resources.map((resource) => `${resource.kind}=${resource.isolation}`).join(", ")}`,
    `Proposal digest: ${record.proposalDigest}`,
  ].join("\n");
}

function success<T>(value: T): ControllerResult<T> {
  return { ok: true, value };
}

function failure<T>(code: ControllerErrorCode, diagnostics: string[]): ControllerResult<T> {
  return { ok: false, error: { code, diagnostics } };
}
