import { isAbsolute } from "node:path";

import type {
  AcceptCandidateRequest,
  AdmissionSnapshot,
  AnswerDecisionRequest,
  ApprovalRequest,
  AttemptRequest,
  BatchProposal,
  CandidateReceipt,
  CaptureCandidateRequest,
  CapturedModel,
  ControllerDependencies,
  ControllerErrorCode,
  ControllerResult,
  ControllerState,
  ControllerStateStore,
  ControllerStatus,
  ExecutionAttempt,
  LocalActorCapability,
  PaginationRequest,
  PreparationRecord,
  PrepareRequest,
  RecordWorkerObservationRequest,
  SetupOperation,
  SetupOperationRecord,
  StartTicketRequest,
  TicketWorktreePlan,
  WorkerAllocation,
  WorkerDispatchAcknowledgement,
  WorkerIdentity,
  WorkerObservation,
} from "./contracts.js";
import {
  MAX_ATTEMPT_DECISIONS,
  MAX_ATTEMPT_REFERENCES,
  MAX_CANDIDATE_RECEIPTS,
  MAX_EXECUTION_ATTEMPTS,
  MAX_PREPARATIONS,
  MAX_STATUS_PAGE_SIZE,
} from "./contracts.js";
import {
  approvalFailures,
  calculateContextLimit,
  digest,
  hasApprovedControllerNameCollision,
  validateAdmission,
  validateProposal,
} from "./policy.js";
export type {
  AcceptCandidateRequest,
  AcceptanceReviewPort,
  AcceptanceReviewRecord,
  AdmissionSnapshot,
  AnswerDecisionRequest,
  ApprovalRequest,
  AttemptRequest,
  BatchProposal,
  CandidateGitState,
  CandidateReceipt,
  CaptureCandidateRequest,
  CapturedModel,
  ControllerError,
  ControllerResult,
  ControllerState,
  ControllerStateStore,
  ControllerStatus,
  DecisionRecord,
  ExecutionAttempt,
  ExecutionControllerDependencies,
  ExecutionLifecycle,
  GateCheckPort,
  GateCheckRecord,
  GitWorktreePort,
  LocalActorCapability,
  NativeEvidenceRecord,
  OriginalCheckoutSnapshot,
  PaginationRequest,
  PreparationRecord,
  RecordWorkerObservationRequest,
  SetupOperation,
  SetupOperationRecord,
  SetupRuntimePort,
  SourceEvidence,
  StagedIntegrationCandidate,
  StartTicketRequest,
  ThinkingLevel,
  TicketWorktreePlan,
  WorkerAllocation,
  WorkerDispatchAcknowledgement,
  WorkerIdentity,
  WorkerObservation,
  WorkerRuntimePort,
  WorkerStatus,
  WorktreeIdentity,
} from "./contracts.js";

const AUTHORIZATION_DIAGNOSTIC = "The caller does not hold the local controller capability";
const REQUIRED_WORKER_SKILLS = ["skill:implement", "skill:tdd", "skill:code-review", "skill:handoff"];

export class PreparationController {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ControllerStateStore,
    private readonly dependencies: ControllerDependencies,
  ) {}

  async prepare(
    actor: LocalActorCapability,
    request: PrepareRequest,
    snapshot: AdmissionSnapshot,
  ): Promise<ControllerResult<PreparationRecord>> {
    return this.serializeMutation((): Promise<ControllerResult<PreparationRecord>> =>
      this.prepareOperation(actor, request, snapshot)
    );
  }

  async submitProposal(
    actor: LocalActorCapability,
    preparationId: string,
    proposal: BatchProposal,
  ): Promise<ControllerResult<PreparationRecord>> {
    return this.serializeMutation((): Promise<ControllerResult<PreparationRecord>> =>
      this.submitProposalOperation(actor, preparationId, proposal)
    );
  }

  async approve(
    actor: LocalActorCapability,
    preparationId: string,
    request: ApprovalRequest,
  ): Promise<ControllerResult<PreparationRecord>> {
    return this.serializeMutation((): Promise<ControllerResult<PreparationRecord>> =>
      this.approveOperation(actor, preparationId, request)
    );
  }

  private async prepareOperation(
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

  private async submitProposalOperation(
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

  private async approveOperation(
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

  async startTicket(actor: LocalActorCapability, request: StartTicketRequest): Promise<ControllerResult<ExecutionAttempt>> {
    return this.serializeMutation((): Promise<ControllerResult<ExecutionAttempt>> =>
      this.startTicketOperation(actor, request)
    );
  }

  async captureCandidate(actor: LocalActorCapability, request: CaptureCandidateRequest): Promise<ControllerResult<CandidateReceipt>> {
    return this.serializeMutation((): Promise<ControllerResult<CandidateReceipt>> =>
      this.captureCandidateOperation(actor, request)
    );
  }

  async acceptCandidate(actor: LocalActorCapability, request: AcceptCandidateRequest): Promise<ControllerResult<ExecutionAttempt>> {
    return this.serializeMutation((): Promise<ControllerResult<ExecutionAttempt>> =>
      this.acceptCandidateOperation(actor, request)
    );
  }

  async attachAttempt(actor: LocalActorCapability, request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>> {
    return this.serializeMutation((): Promise<ControllerResult<ExecutionAttempt>> =>
      this.attachAttemptOperation(actor, request)
    );
  }

  async pauseAttempt(actor: LocalActorCapability, request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>> {
    return this.serializeMutation((): Promise<ControllerResult<ExecutionAttempt>> =>
      this.pauseAttemptOperation(actor, request)
    );
  }

  async resumeAttempt(actor: LocalActorCapability, request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>> {
    return this.serializeMutation((): Promise<ControllerResult<ExecutionAttempt>> =>
      this.resumeAttemptOperation(actor, request)
    );
  }

  async takeOverAttempt(actor: LocalActorCapability, request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>> {
    return this.serializeMutation((): Promise<ControllerResult<ExecutionAttempt>> =>
      this.takeOverAttemptOperation(actor, request)
    );
  }

  async returnAttempt(actor: LocalActorCapability, request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>> {
    return this.serializeMutation((): Promise<ControllerResult<ExecutionAttempt>> =>
      this.returnAttemptOperation(actor, request)
    );
  }

  async answerDecision(actor: LocalActorCapability, request: AnswerDecisionRequest): Promise<ControllerResult<ExecutionAttempt>> {
    return this.serializeMutation((): Promise<ControllerResult<ExecutionAttempt>> =>
      this.answerDecisionOperation(actor, request)
    );
  }

  async recordWorkerObservation(
    actor: LocalActorCapability,
    request: RecordWorkerObservationRequest,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    return this.serializeMutation((): Promise<ControllerResult<ExecutionAttempt>> =>
      this.recordWorkerObservationOperation(actor, request)
    );
  }

  async controllerRestarted(actor: LocalActorCapability): Promise<ControllerResult<ExecutionAttempt[]>> {
    return this.serializeMutation((): Promise<ControllerResult<ExecutionAttempt[]>> =>
      this.controllerRestartedOperation(actor)
    );
  }

  private async startTicketOperation(
    actor: LocalActorCapability,
    request: StartTicketRequest,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const denied = this.authorizationFailure<ExecutionAttempt>(actor);
    if (denied) return denied;
    const execution = this.dependencies.execution;
    if (!execution) return failure("infrastructure", ["Execution adapters are not configured"]);
    if (
      !validBoundedText(request.preparationId, 4_096) || !validBoundedText(request.ticketIdentity, 4_096) ||
      !validBoundedText(request.workspaceId, 4_096)
    ) {
      return failure("execution-validation", ["Bounded preparation, ticket, and Herdr workspace identities are required"]);
    }

    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    const duplicate = loaded.value.executionAttempts.find((attempt): boolean =>
      attempt.preparationId === request.preparationId && attempt.ticketIdentity === request.ticketIdentity
    );
    if (duplicate) return success(structuredClone(duplicate));
    const preparation = loaded.value.preparations.find((record): boolean => record.id === request.preparationId);
    if (!preparation || preparation.stage !== "approved" || !preparation.proposal || !preparation.proposalDigest) {
      return failure("execution-validation", ["Ticket execution requires an approved preparation"]);
    }
    const ticket = preparation.proposal.tickets.find((item): boolean => item.identity === request.ticketIdentity);
    if (!ticket) return failure("execution-validation", ["Ticket is outside the approved preparation"]);
    if (ticket.claimedBy !== null) {
      return failure("execution-conflict", [`Ticket has a foreign tracker claim: ${request.ticketIdentity}`]);
    }
    const prerequisiteEvidence: string[] = [];
    const blockedBy: string[] = [];
    let executionBaseCommit = preparation.proposal.target.baseCommit;
    for (const dependency of preparation.proposal.dependencies.filter((item): boolean =>
      item.ticketIdentity === ticket.identity && item.kind === "ticket" && item.status === "in-batch"
    )) {
      const prerequisite = loaded.value.executionAttempts.find((attempt): boolean =>
        attempt.preparationId === request.preparationId && attempt.ticketIdentity === dependency.prerequisiteIdentity &&
        attempt.lifecycle === "accepted" && attempt.acceptedCommit !== undefined
      );
      const acceptedReceipt = prerequisite?.candidateReceipts?.find((receipt): boolean =>
        receipt.state === "accepted" && receipt.integration?.integratedCommit === prerequisite.acceptedCommit
      );
      let present = false;
      if (prerequisite && acceptedReceipt?.integration && prerequisite.acceptedCommit) {
        try {
          const integration = await execution.git.inspectWorktree(acceptedReceipt.integration.worktree.path);
          present = integration.branch === acceptedReceipt.integration.worktree.branch &&
            await execution.git.isCommitAncestor(integration.path, prerequisite.acceptedCommit, integration.head);
          if (present) executionBaseCommit = integration.head;
        } catch {
          present = false;
        }
      }
      if (present) {
        prerequisiteEvidence.push(
          `${dependency.prerequisiteIdentity} accepted as ${prerequisite!.acceptedCommit} on ${acceptedReceipt!.integration!.worktree.branch}`,
        );
      } else {
        blockedBy.push(dependency.prerequisiteIdentity);
      }
    }
    if (blockedBy.length > 0) {
      return failure("execution-conflict", [`Ticket is blocked by in-batch prerequisites: ${blockedBy.sort().join(", ")}`]);
    }
    if (loaded.value.executionAttempts.some((attempt): boolean =>
      attempt.preparationId === request.preparationId && isExecuting(attempt.lifecycle)
    )) {
      return failure("execution-conflict", ["This preparation already owns an active ticket worker"]);
    }
    if (loaded.value.executionAttempts.length >= MAX_EXECUTION_ATTEMPTS) {
      return failure("execution-validation", [`Execution attempt capacity of ${MAX_EXECUTION_ATTEMPTS} was reached`]);
    }

    const now = this.dependencies.now().toISOString();
    let plan: TicketWorktreePlan;
    try {
      plan = execution.git.planTicketWorktree({
        originalRoot: preparation.project.root,
        preparationId: preparation.id,
        ticketIdentity: ticket.identity,
      });
    } catch {
      return failure("infrastructure", ["Ticket worktree planning failed"]);
    }
    if (!validBoundedText(plan.path, 4_096) || !isAbsolute(plan.path) || !validBoundedText(plan.branch, 500)) {
      return failure("infrastructure", ["Ticket worktree plan is incomplete or unsafe"]);
    }
    const attempt: ExecutionAttempt = {
      id: this.dependencies.generateId(),
      preparationId: preparation.id,
      proposalDigest: preparation.proposalDigest,
      ticketIdentity: ticket.identity,
      workspaceId: request.workspaceId,
      lifecycle: "claimed",
      owner: structuredClone(execution.owner),
      createdAt: now,
      updatedAt: now,
      worktreePlan: structuredClone(plan),
      controlGeneration: 0,
      setupOperations: [],
      decisions: [],
      artifactReferences: [],
      diagnostics: [],
    };
    loaded.value.executionAttempts.push(attempt);
    const claimed = await this.saveState(loaded.value);
    if (!claimed.ok) return claimed;

    try {
      const original = await execution.git.inspectOriginal(preparation.project.root);
      if (
        original.root !== preparation.project.root ||
        original.head !== preparation.proposal.target.baseCommit ||
        original.branch !== preparation.proposal.target.branch
      ) {
        return this.attention(loaded.value, attempt, "Original checkout no longer matches the approved Git base");
      }
      attempt.originalCheckout = structuredClone(original);
      attempt.lifecycle = "preparing-worktree";
      const baselineSaved = await this.persistAttempt(loaded.value, attempt);
      if (!baselineSaved.ok) return baselineSaved;

      const worktree = await execution.git.createTicketWorktree({
        originalRoot: original.root,
        baseCommit: executionBaseCommit,
        plan,
      });
      if (
        worktree.path !== plan.path || worktree.branch !== plan.branch ||
        worktree.head !== executionBaseCommit || worktree.commonDir !== original.commonDir
      ) {
        return this.attention(loaded.value, attempt, "Created ticket worktree identity does not match its durable plan");
      }
      attempt.worktree = structuredClone(worktree);
      attempt.candidateHead = worktree.head;
      attempt.lifecycle = "starting";
      const worktreeSaved = await this.persistAttempt(loaded.value, attempt);
      if (!worktreeSaved.ok) return worktreeSaved;

      const setup = await this.executeApprovedSetup(loaded.value, attempt, preparation.proposal.policy.setupOperations);
      if (!setup.ok || setup.value.lifecycle === "needs-attention") return setup;
      const guarded = await this.verifyGitGuard(loaded.value, attempt);
      if (!guarded.ok || guarded.value.lifecycle === "needs-attention") return guarded;
      const allocation = await execution.worker.allocate({
        workspaceId: request.workspaceId,
        agentName: workerAgentName(attempt.id),
        cwd: worktree.path,
      });
      if (
        !validWorkerAllocation(allocation) || allocation.workspaceId !== request.workspaceId ||
        allocation.agentName !== workerAgentName(attempt.id)
      ) {
        return this.attention(loaded.value, attempt, "Worker allocation identity is incomplete or mismatched");
      }
      attempt.workerAllocation = structuredClone(allocation);
      const allocationSaved = await this.persistAttempt(loaded.value, attempt);
      if (!allocationSaved.ok) return allocationSaved;

      const guardedBeforeStart = await this.verifyGitGuard(loaded.value, attempt);
      if (!guardedBeforeStart.ok || guardedBeforeStart.value.lifecycle === "needs-attention") return guardedBeforeStart;
      const worker = await execution.worker.start({ allocation, cwd: worktree.path, model: preparation.proposal.model });
      const readinessFailure = workerReadinessFailure(worker, allocation, worktree.path, preparation.proposal.model);
      if (readinessFailure) return this.attention(loaded.value, attempt, readinessFailure);
      attempt.worker = structuredClone(worker);
      const workerSaved = await this.persistAttempt(loaded.value, attempt);
      if (!workerSaved.ok) return workerSaved;

      const guardedBeforeDispatch = await this.verifyGitGuard(loaded.value, attempt);
      if (!guardedBeforeDispatch.ok || guardedBeforeDispatch.value.lifecycle === "needs-attention") return guardedBeforeDispatch;
      const ownership = await this.verifyWorkerOwnership(loaded.value, attempt);
      if (!ownership.ok || ownership.value.lifecycle === "needs-attention") return ownership;
      const acknowledgement = await execution.worker.dispatchImplementation(worker, ticket.identity, prerequisiteEvidence);
      return this.applyDispatchAcknowledgement(loaded.value, attempt, acknowledgement);
    } catch {
      return this.attention(loaded.value, attempt, "Execution infrastructure returned an error or ambiguous timeout");
    }
  }

  private async executeApprovedSetup(
    state: ControllerState,
    attempt: ExecutionAttempt,
    operations: SetupOperation[],
  ): Promise<ControllerResult<ExecutionAttempt>> {
    if (operations.length === 0) return success(structuredClone(attempt));
    const runtime = this.dependencies.execution!.setup;
    if (!runtime) return this.attention(state, attempt, "Approved setup operations require a configured setup adapter");
    attempt.setupOperations ??= [];
    for (let index = attempt.setupOperations.length; index < operations.length; index += 1) {
      const operation = operations[index]!;
      const record: SetupOperationRecord = {
        index,
        operationDigest: digest(operation),
        state: "started",
        startedAt: this.dependencies.now().toISOString(),
      };
      attempt.setupOperations.push(record);
      const claimed = await this.persistAttempt(state, attempt);
      if (!claimed.ok) return claimed;
      try {
        const result = await runtime.execute({ cwd: attempt.worktree!.path, operation: structuredClone(operation) });
        if (!/^[a-f0-9]{64}$/i.test(result.outcomeDigest)) {
          return this.attention(state, attempt, "Approved setup returned malformed bounded evidence");
        }
        record.state = "completed";
        record.completedAt = this.dependencies.now().toISOString();
        record.outcomeDigest = result.outcomeDigest;
        const completed = await this.persistAttempt(state, attempt);
        if (!completed.ok) return completed;
      } catch {
        return this.attention(state, attempt, "Approved setup failed or had an ambiguous result");
      }
    }
    return success(structuredClone(attempt));
  }

  private async captureCandidateOperation(
    actor: LocalActorCapability,
    request: CaptureCandidateRequest,
  ): Promise<ControllerResult<CandidateReceipt>> {
    const context = await this.mutableAttempt(actor, request.attemptId);
    if (!context.ok) return context;
    const { state, attempt, execution } = context.value;
    if (attempt.lifecycle !== "completed-unaccepted" && attempt.lifecycle !== "integration-blocked") {
      return failure("execution-conflict", [`Candidate cannot be captured from ${attempt.lifecycle}`]);
    }
    if (!attempt.worker || !attempt.worktree) return failure("execution-validation", ["Candidate identity is incomplete"]);
    const receipts = attempt.candidateReceipts ??= [];
    if (receipts.length >= MAX_CANDIDATE_RECEIPTS) {
      return failure("execution-validation", [`Candidate receipt capacity of ${MAX_CANDIDATE_RECEIPTS} was reached`]);
    }
    const preparation = state.preparations.find((record): boolean => record.id === attempt.preparationId)!;
    try {
      const guarded = await this.verifyOwnedWorkerAndGit(state, attempt);
      if (!guarded.ok || guarded.value.lifecycle === "needs-attention") {
        return failure("execution-conflict", guarded.ok ? guarded.value.diagnostics : guarded.error.diagnostics);
      }
      const observation = await execution.worker.inspect(attempt.worker);
      if (!sameWorker(observation.identity, attempt.worker) || !observation.settled ||
        (observation.status !== "idle" && observation.status !== "done") ||
        !Array.isArray(observation.outstandingJobs) || observation.outstandingJobs.length > 0
      ) return failure("execution-conflict", ["Candidate requires a settled Pi lifecycle with no outstanding jobs"]);
      const candidate = await execution.git.captureCandidate({ path: attempt.worktree.path, sourceBase: attempt.worktree.head });
      const specEvidence = preparation.proposal!.sourceEvidence.find(
        (evidence): boolean => evidence.identity === preparation.proposal!.spec.evidenceIdentity,
      )!;
      const receipt: CandidateReceipt = {
        id: this.dependencies.generateId(),
        state: "captured",
        capturedAt: this.dependencies.now().toISOString(),
        proposalDigest: attempt.proposalDigest,
        specIdentity: preparation.proposal!.spec.identity,
        specRevision: specEvidence.revision,
        preparationId: attempt.preparationId,
        ticketIdentity: attempt.ticketIdentity,
        attemptId: attempt.id,
        sessionId: attempt.worker.sessionId,
        sessionFile: attempt.worker.sessionFile,
        candidate,
        nativeEvidence: [],
        checks: [],
        reviews: [],
        findings: [],
        evidenceReferences: uniqueReferences([...attempt.artifactReferences, ...specEvidence.references]),
      };
      receipts.push(receipt);
      const saved = await this.persistAttempt(state, attempt);
      return saved.ok ? success(structuredClone(receipt)) : saved;
    } catch {
      return failure("infrastructure", ["Candidate Git capture or lifecycle verification failed"]);
    }
  }

  private async acceptCandidateOperation(
    actor: LocalActorCapability,
    request: AcceptCandidateRequest,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const context = await this.mutableAttempt(actor, request.attemptId);
    if (!context.ok) return context;
    const { state, attempt, execution } = context.value;
    const acceptance = execution.acceptance;
    if (!acceptance) return failure("infrastructure", ["Acceptance adapters are not configured"]);
    if (attempt.lifecycle !== "completed-unaccepted" && attempt.lifecycle !== "integration-blocked") {
      return failure("execution-conflict", [`Candidate cannot be accepted from ${attempt.lifecycle}`]);
    }
    const receipt = attempt.candidateReceipts?.find(
      (item): boolean => item.candidate.candidateDigest === request.candidateDigest && item.state === "captured",
    );
    if (!receipt) return failure("execution-validation", ["A current captured candidate receipt is required"]);
    const evidenceFailure = validateNativeEvidence(request.nativeEvidence, receipt);
    if (evidenceFailure) return failure("execution-validation", [evidenceFailure]);
    const preparation = state.preparations.find((record): boolean => record.id === attempt.preparationId)!;
    const proposal = preparation.proposal!;
    receipt.nativeEvidence = structuredClone(request.nativeEvidence);
    receipt.evidenceReferences = uniqueReferences([
      ...receipt.evidenceReferences,
      ...request.nativeEvidence.map((item): string => item.evidenceReference),
    ]);
    attempt.lifecycle = "accepting";
    const accepting = await this.persistAttempt(state, attempt);
    if (!accepting.ok) return accepting;

    try {
      const current = await execution.git.captureCandidate({ path: attempt.worktree!.path, sourceBase: receipt.candidate.sourceBase });
      if (current.candidateDigest !== receipt.candidate.candidateDigest) {
        return this.blockAcceptance(state, attempt, receipt, "Candidate changed after evidence capture");
      }
      const integration = await execution.git.prepareIntegrationWorktree({
        originalRoot: preparation.project.root,
        preparationId: preparation.id,
        targetBase: proposal.target.baseCommit,
      });
      const latestAcceptedBase = state.executionAttempts
        .filter((item): boolean => item.preparationId === preparation.id)
        .flatMap((item): CandidateReceipt[] => item.candidateReceipts ?? [])
        .filter((item): boolean => item.state === "accepted" && item.integration?.integratedCommit !== undefined)
        .at(-1)?.integration?.integratedCommit ?? proposal.target.baseCommit;
      if (integration.head !== latestAcceptedBase) {
        return this.blockAcceptance(state, attempt, receipt, "Batch integration worktree moved outside recorded acceptance");
      }
      const staging = await execution.git.stageCandidate({
        originalRoot: preparation.project.root,
        preparationId: preparation.id,
        attemptId: attempt.id,
        receiptId: receipt.id,
        integration,
        sourcePath: attempt.worktree!.path,
        candidate: receipt.candidate,
      });
      receipt.integration = { worktree: structuredClone(integration), staging: structuredClone(staging) };
      const staged = await this.persistAttempt(state, attempt);
      if (!staged.ok) return staged;

      for (const check of proposal.policy.checks) {
        const result = await acceptance.checks.execute({ cwd: staging.path, command: check.command, candidateCommit: staging.candidateCommit });
        if (!validCheckResult(result, check.command, staging.candidateCommit)) {
          return this.blockAcceptance(state, attempt, receipt, "Approved check returned malformed or stale evidence");
        }
        receipt.checks.push(structuredClone(result));
        receipt.evidenceReferences = uniqueReferences([...receipt.evidenceReferences, result.logReference]);
        const checked = await this.persistAttempt(state, attempt);
        if (!checked.ok) return checked;
        if (result.exitCode !== 0) return this.blockAcceptance(state, attempt, receipt, `Approved check failed: ${check.command}`);
      }

      for (const kind of proposal.policy.requiredReviews) {
        const review = await acceptance.reviewer.review({
          kind,
          workspaceId: attempt.workspaceId,
          cwd: staging.path,
          reviewBase: staging.baseCommit,
          candidateCommit: staging.candidateCommit,
          model: proposal.model,
          evidenceReferences: proposal.sourceEvidence.flatMap((source): string[] => source.references),
        });
        if (!validReview(review, kind, staging.baseCommit, staging.candidateCommit) ||
          review.freshSessionId === attempt.worker?.sessionId ||
          receipt.reviews.some((existing): boolean => existing.freshSessionId === review.freshSessionId)
        ) {
          return this.blockAcceptance(state, attempt, receipt, `${kind} review returned malformed, stale, or non-fresh evidence`);
        }
        receipt.reviews.push(structuredClone(review));
        receipt.evidenceReferences = uniqueReferences([...receipt.evidenceReferences, review.evidenceReference]);
        receipt.findings.push(...review.findings);
        const reviewed = await this.persistAttempt(state, attempt);
        if (!reviewed.ok) return reviewed;
        if (review.verdict !== "passed" || review.findings.length > 0) {
          return this.blockAcceptance(state, attempt, receipt, `${kind} review has unresolved blocking findings`);
        }
      }
      if (!proposal.policy.requiredReviews.every((kind): boolean => receipt.reviews.some((review): boolean => review.kind === kind && review.verdict === "passed"))) {
        return this.blockAcceptance(state, attempt, receipt, "Required reviews are incomplete");
      }
      const afterReview = await execution.git.captureCandidate({ path: attempt.worktree!.path, sourceBase: receipt.candidate.sourceBase });
      if (afterReview.candidateDigest !== receipt.candidate.candidateDigest) {
        return this.blockAcceptance(state, attempt, receipt, "Candidate changed while acceptance evidence was collected");
      }
      const integratedCommit = await execution.git.advanceIntegration({ integration, staging });
      if (integratedCommit !== staging.candidateCommit) {
        return this.blockAcceptance(state, attempt, receipt, "Integration returned a mismatched accepted commit");
      }
      receipt.integration.integratedCommit = integratedCommit;
      receipt.state = "accepted";
      receipt.acceptedAt = this.dependencies.now().toISOString();
      attempt.acceptedCommit = integratedCommit;
      attempt.lifecycle = "accepted";
      const integrated = await this.persistAttempt(state, attempt);
      if (!integrated.ok) return integrated;
      if (!execution.worker.close || !attempt.worker || hasPendingDecision(attempt)) return integrated;
      try {
        await execution.worker.close(attempt.worker);
        receipt.cleanup = "closed";
      } catch {
        receipt.cleanup = "failed";
      }
      return this.persistAttempt(state, attempt);
    } catch {
      return this.blockAcceptance(state, attempt, receipt, "Integration, independent check, or review infrastructure failed");
    }
  }

  private async blockAcceptance(
    state: ControllerState,
    attempt: ExecutionAttempt,
    receipt: CandidateReceipt,
    finding: string,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    receipt.state = "blocked";
    receipt.findings = uniqueReferences([...receipt.findings, finding]);
    attempt.lifecycle = "integration-blocked";
    return this.persistAttempt(state, attempt);
  }

  private async attachAttemptOperation(
    actor: LocalActorCapability,
    request: AttemptRequest,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const context = await this.mutableAttempt(actor, request.attemptId);
    if (!context.ok) return context;
    const { state, attempt, execution } = context.value;
    const guarded = await this.verifyOwnedWorkerAndGit(state, attempt);
    if (!guarded.ok || guarded.value.lifecycle === "needs-attention") return guarded;
    try {
      await execution.worker.focus(attempt.worker!);
      return success(structuredClone(attempt));
    } catch {
      return this.attention(state, attempt, "Worker focus failed or had an ambiguous result");
    }
  }

  private async pauseAttemptOperation(
    actor: LocalActorCapability,
    request: AttemptRequest,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const context = await this.mutableAttempt(actor, request.attemptId);
    if (!context.ok) return context;
    const { state, attempt } = context.value;
    if (attempt.lifecycle !== "running" && attempt.lifecycle !== "pending-decision") {
      return failure("execution-conflict", [`Attempt cannot be paused from ${attempt.lifecycle}`]);
    }
    attempt.suspendedFrom = attempt.lifecycle;
    attempt.lifecycle = "paused";
    advanceControlGeneration(attempt);
    return this.persistAttempt(state, attempt);
  }

  private async resumeAttemptOperation(
    actor: LocalActorCapability,
    request: AttemptRequest,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const context = await this.mutableAttempt(actor, request.attemptId);
    if (!context.ok) return context;
    const { state, attempt } = context.value;
    if (attempt.lifecycle !== "paused" && attempt.lifecycle !== "restart-required") {
      return failure("execution-conflict", [`Attempt cannot be resumed from ${attempt.lifecycle}`]);
    }
    if (!attempt.worker) return this.attention(state, attempt, "Restarted attempt requires later recovery because no worker identity was durably established");
    if (attempt.lifecycle === "restart-required" && attempt.suspendedFrom === undefined) {
      return this.attention(state, attempt, "Implementation dispatch state is ambiguous after controller restart; later recovery is required");
    }
    const guarded = await this.verifyOwnedWorkerAndGit(state, attempt);
    if (!guarded.ok || guarded.value.lifecycle === "needs-attention") return guarded;
    attempt.lifecycle = hasPendingDecision(attempt) ? "pending-decision" : "running";
    delete attempt.suspendedFrom;
    advanceControlGeneration(attempt);
    const resumed = await this.persistAttempt(state, attempt);
    if (!resumed.ok) return resumed;
    return this.deliverAnsweredDecisions(state, attempt);
  }

  private async takeOverAttemptOperation(
    actor: LocalActorCapability,
    request: AttemptRequest,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const context = await this.mutableAttempt(actor, request.attemptId);
    if (!context.ok) return context;
    const { state, attempt, execution } = context.value;
    if (attempt.lifecycle !== "running" && attempt.lifecycle !== "pending-decision" && attempt.lifecycle !== "paused") {
      return failure("execution-conflict", [`Attempt cannot enter takeover from ${attempt.lifecycle}`]);
    }
    if (!attempt.suspendedFrom) {
      attempt.suspendedFrom = attempt.lifecycle === "pending-decision" ? "pending-decision" : "running";
    }
    attempt.lifecycle = "takeover";
    advanceControlGeneration(attempt);
    const stopped = await this.persistAttempt(state, attempt);
    if (!stopped.ok) return stopped;
    const guarded = await this.verifyOwnedWorkerAndGit(state, attempt);
    if (!guarded.ok || guarded.value.lifecycle === "needs-attention") return guarded;
    try {
      await execution.worker.focus(attempt.worker!);
      return success(structuredClone(attempt));
    } catch {
      return this.attention(state, attempt, "Worker focus failed or had an ambiguous result");
    }
  }

  private async returnAttemptOperation(
    actor: LocalActorCapability,
    request: AttemptRequest,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const context = await this.mutableAttempt(actor, request.attemptId);
    if (!context.ok) return context;
    const { state, attempt, execution } = context.value;
    if (attempt.lifecycle !== "takeover") {
      return failure("execution-conflict", [`Attempt cannot return to automation from ${attempt.lifecycle}`]);
    }
    const guarded = await this.verifyOwnedWorkerAndGit(state, attempt);
    if (!guarded.ok || guarded.value.lifecycle === "needs-attention") return guarded;
    attempt.lifecycle = hasPendingDecision(attempt) ? "pending-decision" : "running";
    delete attempt.suspendedFrom;
    advanceControlGeneration(attempt);
    const returned = await this.persistAttempt(state, attempt);
    if (!returned.ok) return returned;
    return this.deliverAnsweredDecisions(state, attempt, execution.worker);
  }

  private async answerDecisionOperation(
    actor: LocalActorCapability,
    request: AnswerDecisionRequest,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const context = await this.mutableAttempt(actor, request.attemptId);
    if (!context.ok) return context;
    const { state, attempt, execution } = context.value;
    if (
      !validBoundedText(request.answer, 4_000) || !validBoundedText(request.answeredBy, 500) ||
      containsCredential(request.answer)
    ) {
      return failure("execution-validation", ["A bounded credential-free decision answer and author are required"]);
    }
    const decision = attempt.decisions.find((item): boolean => item.id === request.decisionId);
    if (!decision) return failure("execution-validation", [`Unknown pending decision: ${request.decisionId}`]);
    if (decision.state !== "pending") {
      if (decision.answer === request.answer && decision.answeredBy === request.answeredBy) return success(structuredClone(attempt));
      return failure("execution-conflict", ["A durable explicit answer already owns this decision"]);
    }
    decision.state = "answered";
    decision.answer = request.answer;
    decision.answeredBy = request.answeredBy;
    decision.answeredAt = this.dependencies.now().toISOString();
    advanceControlGeneration(attempt);
    const answered = await this.persistAttempt(state, attempt);
    if (!answered.ok) return answered;
    if (attempt.lifecycle === "takeover" || attempt.lifecycle === "paused" || attempt.lifecycle === "restart-required") {
      return success(structuredClone(attempt));
    }
    const guarded = await this.verifyOwnedWorkerAndGit(state, attempt);
    if (!guarded.ok || guarded.value.lifecycle === "needs-attention") return guarded;
    try {
      const observation = await execution.worker.deliverDecision(attempt.worker!, decision.id, request.answer);
      if (!sameWorker(observation.identity, attempt.worker!)) {
        return this.attention(state, attempt, "Worker occupant or saved Pi session changed before decision delivery");
      }
      decision.state = "delivered";
      decision.deliveredAt = this.dependencies.now().toISOString();
      const observed = await this.applyWorkerObservation(state, attempt, observation, false);
      if (!observed.ok) return observed;
      return this.persistAttempt(state, attempt);
    } catch {
      return this.attention(state, attempt, "Decision delivery failed or had an ambiguous result");
    }
  }

  private async recordWorkerObservationOperation(
    actor: LocalActorCapability,
    request: RecordWorkerObservationRequest,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const context = await this.mutableAttempt(actor, request.attemptId);
    if (!context.ok) return context;
    const { state, attempt } = context.value;
    if (!Number.isSafeInteger(request.controlGeneration) || request.controlGeneration < 0) {
      return failure("execution-validation", ["A nonnegative worker observation control generation is required"]);
    }
    if (request.controlGeneration !== currentControlGeneration(attempt)) {
      return success(structuredClone(attempt));
    }
    if (attempt.lifecycle !== "running" && attempt.lifecycle !== "pending-decision") {
      return success(structuredClone(attempt));
    }
    const guarded = await this.verifyGitGuard(state, attempt);
    if (!guarded.ok || guarded.value.lifecycle === "needs-attention") return guarded;
    return this.applyWorkerObservation(state, attempt, request.observation);
  }

  private async controllerRestartedOperation(
    actor: LocalActorCapability,
  ): Promise<ControllerResult<ExecutionAttempt[]>> {
    const denied = this.authorizationFailure<ExecutionAttempt[]>(actor);
    if (denied) return denied;
    const execution = this.dependencies.execution;
    if (!execution) return failure("infrastructure", ["Execution adapters are not configured"]);
    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    const changed: ExecutionAttempt[] = [];
    for (const attempt of loaded.value.executionAttempts) {
      if (!isExecuting(attempt.lifecycle)) continue;
      attempt.owner = structuredClone(execution.owner);
      advanceControlGeneration(attempt);
      if (attempt.lifecycle !== "paused" && attempt.lifecycle !== "takeover") {
        if (attempt.lifecycle === "running" || attempt.lifecycle === "pending-decision") {
          attempt.suspendedFrom = attempt.lifecycle;
        }
        attempt.lifecycle = "restart-required";
      }
      attempt.updatedAt = this.dependencies.now().toISOString();
      changed.push(structuredClone(attempt));
    }
    if (changed.length === 0) return success([]);
    const saved = await this.saveState(loaded.value);
    return saved.ok ? success(changed) : saved;
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
    const collectionLength = Math.max(loaded.value.preparations.length, loaded.value.executionAttempts.length);
    if (offset > collectionLength) return failure("query-validation", ["Status cursor is out of range"]);
    const nextOffset = Math.min(offset + pagination.limit, collectionLength);
    const hasMore = nextOffset < collectionLength;
    return success({
      preparations: structuredClone(loaded.value.preparations.slice(offset, offset + pagination.limit)),
      nextCursor: hasMore ? encodeCursor(nextOffset) : null,
      hasMore,
      executionAttempts: structuredClone(loaded.value.executionAttempts.slice(offset, offset + pagination.limit)),
    });
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then((): void => {}, (): void => {});
    return result;
  }

  private async mutableAttempt(
    actor: LocalActorCapability,
    attemptId: string,
  ): Promise<ControllerResult<{
    state: ControllerState;
    attempt: ExecutionAttempt;
    execution: NonNullable<ControllerDependencies["execution"]>;
  }>> {
    const denied = this.authorizationFailure<{
      state: ControllerState;
      attempt: ExecutionAttempt;
      execution: NonNullable<ControllerDependencies["execution"]>;
    }>(actor);
    if (denied) return denied;
    const execution = this.dependencies.execution;
    if (!execution) return failure("infrastructure", ["Execution adapters are not configured"]);
    if (!attemptId.trim()) return failure("execution-validation", ["Attempt identity is required"]);
    const loaded = await this.loadState();
    if (!loaded.ok) return loaded;
    const attempt = loaded.value.executionAttempts.find((item): boolean => item.id === attemptId);
    if (!attempt) return failure("execution-validation", [`Unknown execution attempt: ${attemptId}`]);
    if (attempt.owner.instanceId !== execution.owner.instanceId || attempt.owner.pid !== execution.owner.pid) {
      return failure("execution-conflict", ["Attempt belongs to another controller process; reconcile restart before control"]);
    }
    return success({ state: loaded.value, attempt, execution });
  }

  private async persistAttempt(
    state: ControllerState,
    attempt: ExecutionAttempt,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    attempt.updatedAt = this.dependencies.now().toISOString();
    const saved = await this.saveState(state);
    return saved.ok ? success(structuredClone(attempt)) : saved;
  }

  private async attention(
    state: ControllerState,
    attempt: ExecutionAttempt,
    diagnostic: string,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    attempt.lifecycle = "needs-attention";
    delete attempt.suspendedFrom;
    attempt.diagnostics = [diagnostic];
    advanceControlGeneration(attempt);
    return this.persistAttempt(state, attempt);
  }

  private async verifyGitGuard(
    state: ControllerState,
    attempt: ExecutionAttempt,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const execution = this.dependencies.execution!;
    if (!attempt.originalCheckout || !attempt.worktree) {
      return this.attention(state, attempt, "Execution Git identity is incomplete");
    }
    try {
      const currentOriginal = await execution.git.inspectOriginal(attempt.originalCheckout.root);
      if (digest(currentOriginal) !== digest(attempt.originalCheckout)) {
        return this.attention(state, attempt, "Original checkout changed after its execution baseline");
      }
      const currentWorktree = await execution.git.inspectWorktree(attempt.worktree.path);
      if (
        currentWorktree.path !== attempt.worktree.path || currentWorktree.branch !== attempt.worktree.branch ||
        currentWorktree.commonDir !== attempt.worktree.commonDir
      ) {
        return this.attention(state, attempt, "Ticket worktree path, branch, or common directory changed");
      }
      if (!await execution.git.isCommitAncestor(attempt.worktree.path, attempt.worktree.head, currentWorktree.head)) {
        return this.attention(state, attempt, "Ticket candidate no longer descends from the approved base");
      }
      if (attempt.candidateHead !== currentWorktree.head) {
        attempt.candidateHead = currentWorktree.head;
        return this.persistAttempt(state, attempt);
      }
      return success(structuredClone(attempt));
    } catch {
      return this.attention(state, attempt, "Git ownership inspection failed or returned an ambiguous result");
    }
  }

  private async verifyWorkerOwnership(
    state: ControllerState,
    attempt: ExecutionAttempt,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const execution = this.dependencies.execution!;
    if (!attempt.worker) return this.attention(state, attempt, "Worker identity is incomplete");
    try {
      const observation = await execution.worker.inspect(attempt.worker);
      if (!sameWorker(observation.identity, attempt.worker)) {
        return this.attention(state, attempt, "Worker occupant or saved Pi session changed");
      }
      if (!isWorkerStatus(observation.status)) {
        return this.attention(state, attempt, "Worker ownership inspection returned an invalid lifecycle state");
      }
      if (observation.status === "missing" || observation.status === "unknown") {
        return this.attention(state, attempt, "Owned worker is missing or in an unknown state");
      }
      return success(structuredClone(attempt));
    } catch {
      return this.attention(state, attempt, "Worker ownership inspection failed or returned an ambiguous result");
    }
  }

  private async verifyOwnedWorkerAndGit(
    state: ControllerState,
    attempt: ExecutionAttempt,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    const git = await this.verifyGitGuard(state, attempt);
    if (!git.ok || git.value.lifecycle === "needs-attention") return git;
    return this.verifyWorkerOwnership(state, attempt);
  }

  private async deliverAnsweredDecisions(
    state: ControllerState,
    attempt: ExecutionAttempt,
    workerRuntime = this.dependencies.execution!.worker,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    try {
      for (const decision of attempt.decisions.filter((item): boolean => item.state === "answered")) {
        const ownership = await this.verifyWorkerOwnership(state, attempt);
        if (!ownership.ok || ownership.value.lifecycle === "needs-attention") return ownership;
        const observation = await workerRuntime.deliverDecision(attempt.worker!, decision.id, decision.answer!);
        if (!sameWorker(observation.identity, attempt.worker!)) {
          return this.attention(state, attempt, "Worker occupant or saved Pi session changed before decision delivery");
        }
        decision.state = "delivered";
        decision.deliveredAt = this.dependencies.now().toISOString();
        const observed = await this.applyWorkerObservation(state, attempt, observation, false);
        if (!observed.ok) return observed;
      }
      return this.persistAttempt(state, attempt);
    } catch {
      return this.attention(state, attempt, "Decision delivery failed or had an ambiguous result");
    }
  }

  private async applyDispatchAcknowledgement(
    state: ControllerState,
    attempt: ExecutionAttempt,
    acknowledgement: WorkerDispatchAcknowledgement,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    if (!attempt.worker || !sameWorker(acknowledgement.identity, attempt.worker)) {
      return this.attention(state, attempt, "Worker occupant or saved Pi session changed during implementation dispatch");
    }
    if (!isWorkerStatus(acknowledgement.status) || acknowledgement.status === "missing" || acknowledgement.status === "unknown") {
      return this.attention(state, attempt, "Implementation dispatch returned an invalid worker state");
    }
    if (!validReferences(acknowledgement.artifactReferences)) {
      return this.attention(state, attempt, "Implementation dispatch returned invalid or excessive artifact references");
    }
    attempt.artifactReferences = uniqueReferences([...attempt.artifactReferences, ...acknowledgement.artifactReferences]);
    if (attempt.artifactReferences.length > MAX_ATTEMPT_REFERENCES) {
      return this.attention(state, attempt, "Attempt artifact reference capacity was reached");
    }
    if (acknowledgement.status === "working" || acknowledgement.status === "blocked") {
      attempt.workerActiveAt = this.dependencies.now().toISOString();
    }
    attempt.lifecycle = "running";
    return this.persistAttempt(state, attempt);
  }

  private async applyWorkerObservation(
    state: ControllerState,
    attempt: ExecutionAttempt,
    observation: WorkerObservation,
    persist = true,
  ): Promise<ControllerResult<ExecutionAttempt>> {
    if (!attempt.worker || !sameWorker(observation.identity, attempt.worker)) {
      return this.attention(state, attempt, "Worker occupant or saved Pi session changed");
    }
    if (!isWorkerStatus(observation.status)) {
      return this.attention(state, attempt, "Worker returned an invalid lifecycle state");
    }
    if (!validReferences(observation.artifactReferences)) {
      return this.attention(state, attempt, "Worker returned invalid or excessive artifact references");
    }
    const references = uniqueReferences([...attempt.artifactReferences, ...observation.artifactReferences]);
    if (references.length > MAX_ATTEMPT_REFERENCES) {
      return this.attention(state, attempt, "Attempt artifact reference capacity was reached");
    }
    attempt.artifactReferences = references;
    if (observation.status === "missing" || observation.status === "unknown") {
      return this.attention(state, attempt, "Worker monitoring failed or worker ownership changed");
    }
    if (observation.decision?.transportId !== undefined && typeof observation.decision.transportId !== "string") {
      return this.attention(state, attempt, "Worker returned a malformed local decision identity");
    }
    if (observation.status === "blocked" && (!observation.decision || !validDecisionInput(observation.decision))) {
      return this.attention(state, attempt, "Worker is blocked without a bounded structured local decision");
    }
    if (observation.status === "blocked") {
      const decisionInput = observation.decision!;
      const existing = attempt.decisions.find((decision): boolean =>
        (decisionInput.transportId !== undefined && decision.id === decisionInput.transportId) ||
        (decision.state === "pending" && decision.question === decisionInput.question)
      );
      if (existing && (
        existing.question !== decisionInput.question || existing.context !== decisionInput.context ||
        digest(existing.options) !== digest(decisionInput.options) || existing.recommendation !== decisionInput.recommendation
      )) return this.attention(state, attempt, "Worker reused a local decision identity with different content");
      if (!existing && attempt.decisions.length >= MAX_ATTEMPT_DECISIONS) {
        return this.attention(state, attempt, "Attempt decision capacity was reached");
      }
      advanceControlGeneration(attempt);
      attempt.workerActiveAt ??= this.dependencies.now().toISOString();
      if (!existing) {
        attempt.decisions.push({
          id: decisionInput.transportId ?? this.dependencies.generateId(),
          state: "pending",
          requestedAt: this.dependencies.now().toISOString(),
          ...structuredClone(decisionInput),
        });
      }
      if (attempt.lifecycle !== "paused" && attempt.lifecycle !== "takeover" && attempt.lifecycle !== "restart-required") {
        attempt.lifecycle = "pending-decision";
      }
    } else {
      advanceControlGeneration(attempt);
      if (observation.status === "working" && attempt.workerActiveAt === undefined) {
        attempt.workerActiveAt = this.dependencies.now().toISOString();
      }
    }
    const settledCompletion = observation.settled === true && Array.isArray(observation.outstandingJobs) &&
      observation.outstandingJobs.length === 0 && (observation.status === "idle" || observation.status === "done");
    if (settledCompletion && attempt.workerActiveAt === undefined) {
      attempt.workerActiveAt = this.dependencies.now().toISOString();
    }
    if (
      observation.status !== "blocked" && settledCompletion &&
      attempt.lifecycle !== "paused" && attempt.lifecycle !== "takeover" && attempt.lifecycle !== "restart-required"
    ) {
      attempt.lifecycle = hasPendingDecision(attempt) ? "pending-decision" : "completed-unaccepted";
      if (attempt.lifecycle === "completed-unaccepted") delete attempt.suspendedFrom;
    } else if (attempt.lifecycle !== "paused" && attempt.lifecycle !== "takeover" && attempt.lifecycle !== "restart-required") {
      attempt.lifecycle = hasPendingDecision(attempt) ? "pending-decision" : "running";
    }
    return persist ? this.persistAttempt(state, attempt) : success(structuredClone(attempt));
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

function currentControlGeneration(attempt: ExecutionAttempt): number {
  return attempt.controlGeneration ?? 0;
}

function advanceControlGeneration(attempt: ExecutionAttempt): void {
  attempt.controlGeneration = currentControlGeneration(attempt) + 1;
}

function isExecuting(lifecycle: ExecutionAttempt["lifecycle"]): boolean {
  return !["completed-unaccepted", "integration-blocked", "accepted", "needs-attention"].includes(lifecycle);
}

function hasPendingDecision(attempt: ExecutionAttempt): boolean {
  return attempt.decisions.some((decision): boolean => decision.state !== "delivered");
}

function workerAgentName(attemptId: string): string {
  return `herdr-${digest({ attemptId }).slice(0, 16)}`;
}

function validWorkerAllocation(allocation: WorkerAllocation): boolean {
  return hasOnlyKeys(allocation, ["workspaceId", "tabId", "paneId", "agentName"]) &&
    [allocation.workspaceId, allocation.tabId, allocation.paneId, allocation.agentName]
      .every((value): boolean => validBoundedText(value, 4_096));
}

function workerReadinessFailure(
  worker: WorkerIdentity,
  allocation: WorkerAllocation,
  cwd: string,
  model: CapturedModel,
): string | undefined {
  const raw = worker as unknown as Record<string, unknown>;
  if (!hasOnlyKeys(raw, [
    "workspaceId", "tabId", "paneId", "agentName", "piPid", "sessionId", "sessionFile", "cwd", "model",
    "mode", "initialHistoryEntries", "skillCommands", "toolNames", "contextFiles",
  ])) return "Started worker identity contains unsupported runtime data";
  if (!sameAllocation(worker, allocation)) return "Started worker does not occupy its durable Herdr allocation";
  if (
    !Number.isSafeInteger(worker.piPid) || worker.piPid <= 0 || !validBoundedText(worker.sessionId, 4_096) ||
    !validBoundedText(worker.sessionFile, 4_096) || !isAbsolute(worker.sessionFile) ||
    !validBoundedText(worker.cwd, 4_096) || !isAbsolute(worker.cwd) || worker.cwd !== cwd
  ) return "Started worker has incomplete or mismatched Pi process, session, or cwd identity";
  if (raw.mode !== "tui" || raw.initialHistoryEntries !== 0) {
    return "Started worker is not a fresh normal interactive Pi TUI session";
  }
  if (digest(worker.model) !== digest(model)) return "Started worker model or thinking selection differs from approval";
  if (
    !validStringCollection(worker.skillCommands, 100) ||
    new Set(worker.skillCommands).size !== worker.skillCommands.length ||
    !REQUIRED_WORKER_SKILLS.every((skill): boolean => worker.skillCommands.includes(skill))
  ) return "Started worker is missing required native skills";
  if (
    !validStringCollection(worker.toolNames, 100) || new Set(worker.toolNames).size !== worker.toolNames.length ||
    !["read", "bash", "edit", "write"].every((tool): boolean => worker.toolNames.includes(tool)) ||
    !validStringCollection(worker.contextFiles, 100) || worker.contextFiles.length === 0 ||
    new Set(worker.contextFiles).size !== worker.contextFiles.length || !worker.contextFiles.every(isAbsolute)
  ) return "Started worker is missing normal tools or project instruction resources";
  return undefined;
}

function sameAllocation(
  worker: WorkerIdentity,
  allocation: WorkerAllocation,
): boolean {
  return worker.workspaceId === allocation.workspaceId && worker.tabId === allocation.tabId &&
    worker.paneId === allocation.paneId && worker.agentName === allocation.agentName;
}

function sameWorker(left: WorkerIdentity, right: WorkerIdentity): boolean {
  return digest(left) === digest(right);
}

function isWorkerStatus(value: unknown): value is WorkerObservation["status"] {
  return value === "ready" || value === "working" || value === "idle" || value === "done" ||
    value === "blocked" || value === "missing" || value === "unknown";
}

function hasOnlyKeys(value: unknown, allowed: string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = new Set(allowed);
  return Object.keys(value).every((key): boolean => keys.has(key));
}

function validateNativeEvidence(evidence: import("./contracts.js").NativeEvidenceRecord[], receipt: CandidateReceipt): string | undefined {
  if (!Array.isArray(evidence) || evidence.length < 2 || evidence.length > 20) return "Native implementation evidence is incomplete";
  if (!evidence.some((item): boolean => item.kind === "tests") || !evidence.some((item): boolean => item.kind === "reviews")) {
    return "Native implementation tests and reviews must both be preserved";
  }
  for (const item of evidence) {
    if (item.status !== "passed" || item.candidateDigest !== receipt.candidate.candidateDigest ||
      !validBoundedText(item.evidenceReference, 4_096) || containsCredential(item.evidenceReference) ||
      !Number.isFinite(Date.parse(item.completedAt))
    ) return "Native implementation evidence is malformed, failed, or stale";
  }
  return undefined;
}

function validCheckResult(
  result: import("./contracts.js").GateCheckRecord,
  command: string,
  candidateCommit: string,
): boolean {
  return result.command === command && result.candidateCommit === candidateCommit && Number.isSafeInteger(result.exitCode) &&
    /^[a-f0-9]{64}$/i.test(result.outputDigest) && validBoundedText(result.logReference, 4_096) &&
    !containsCredential(result.logReference) && Number.isFinite(Date.parse(result.completedAt));
}

function validReview(
  review: import("./contracts.js").AcceptanceReviewRecord,
  kind: "standards" | "spec",
  reviewBase: string,
  candidateCommit: string,
): boolean {
  return review.kind === kind && review.reviewBase === reviewBase && review.candidateCommit === candidateCommit &&
    (review.verdict === "passed" || review.verdict === "blocked") && validBoundedText(review.freshSessionId, 4_096) &&
    validBoundedText(review.evidenceReference, 4_096) && !containsCredential(review.evidenceReference) &&
    validStringCollection(review.findings, 50) && review.findings.every((finding): boolean => !containsCredential(finding)) &&
    Number.isFinite(Date.parse(review.completedAt));
}

function validReferences(references: string[]): boolean {
  return validStringCollection(references, MAX_ATTEMPT_REFERENCES) &&
    references.every((reference): boolean => reference.length <= 4_096 && !containsCredential(reference));
}

function uniqueReferences(references: string[]): string[] {
  return [...new Set(references)];
}

function validDecisionInput(input: NonNullable<WorkerObservation["decision"]>): boolean {
  const text = [input.question, input.context, input.recommendation, ...input.options];
  return (input.transportId === undefined || (
    typeof input.transportId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(input.transportId)
  )) &&
    validBoundedText(input.question, 4_000) && validBoundedText(input.context, 4_000) &&
    validBoundedText(input.recommendation, 4_000) && input.options.length >= 1 && input.options.length <= 20 &&
    input.options.every((option): boolean => validBoundedText(option, 1_000)) &&
    text.every((item): boolean => !containsCredential(item));
}

function containsCredential(value: string): boolean {
  return /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+\b/i.test(value) ||
    /(?:token|secret|password|api[_ -]?key)\s*[=:]\s*\S+/i.test(value) ||
    /[?&](?:access_?token|api_?key|token|secret|password)=/i.test(value);
}

function validStringCollection(values: unknown, maximum: number): values is string[] {
  return Array.isArray(values) && values.length <= maximum &&
    values.every((value): boolean => typeof value === "string" && value.trim().length > 0 && value.length <= 4_096);
}

function validBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
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
