import type { ControllerDependencies, ControllerState, PreparationRecord, WorkerIdentity } from "./contracts.js";
import type { OrchestratorRecord } from "./coordination-contracts.js";
import { digest } from "./policy.js";
import { isOrchestratorIdentity, isWorkerIdentity } from "./state-validation.js";

/** References and durable facts only. Deliberately excludes saved conversation contents. */
export function decisionPacket(state: ControllerState, preparation: PreparationRecord): string {
  const record = preparation.orchestrator!;
  const proposal = preparation.proposal!;
  const packet = JSON.stringify({
    role: "reasoning orchestrator",
    preparationId: preparation.id,
    generation: record.generation,
    project: proposal.project,
    spec: proposal.spec,
    tickets: proposal.tickets,
    dependencies: proposal.dependencies,
    sources: proposal.sourceEvidence,
    policy: proposal.policy,
    contextLimit: preparation.effectiveContextLimit,
    batchIntegration: preparation.batchIntegration,
    checkpoint: record.checkpoint,
    lastOutcome: record.lastOutcome,
    decisions: record.decisions,
    attempts: state.executionAttempts.filter((attempt): boolean => attempt.preparationId === preparation.id).map((attempt) => ({
      id: attempt.id, ticketIdentity: attempt.ticketIdentity, lifecycle: attempt.lifecycle,
      worktree: attempt.worktree, sessionId: attempt.worker?.sessionId,
      decisions: attempt.decisions, acceptedCommit: attempt.acceptedCommit,
      evidence: attempt.artifactReferences,
      handoff: attempt.handoff?.artifact?.reference,
      diagnostics: attempt.diagnostics,
      candidates: attempt.candidateReceipts?.map((receipt) => ({
        candidateDigest: receipt.candidate.candidateDigest, state: receipt.state,
        findings: receipt.findings, evidence: receipt.evidenceReferences,
      })),
    })),
  });
  // Never silently cut a decision or binding. Oversized packets require human scoping.
  if (Buffer.byteLength(packet) > 28_000) throw new Error("Decision packet exceeds its bounded context budget");
  return [
    "You are the reasoning orchestrator for this approved batch, not an implementation worker.",
    "Read relevant spec/ticket references and evidence on demand. Select eligible work, investigate failures and assess exact candidate evidence.",
    "Use herdr_orchestrator_operation to request start, assess, escalate, or wait. The controller validates every request. Submit one operation per turn.",
    "Do not implement, alter scope/model/policy, waive tests or reviews, close tracker issues, or merge a final PR/MR. All execution goes through the controller.",
    "Keep assessments short and durable. Do not import old transcripts. Missing evidence or uncertainty requires a decision, not an inferred pass.",
    packet,
  ].join("\n\n");
}

export function requireFreshIdentity(identity: WorkerIdentity, allocation: NonNullable<OrchestratorRecord["allocation"]>, cwd: string, preparation: PreparationRecord): void {
  if (!isWorkerIdentity(identity) || identity.cwd !== cwd || digest(identity.model) !== digest(preparation.model) ||
    identity.workspaceId !== allocation.workspaceId || identity.tabId !== allocation.tabId ||
    identity.paneId !== allocation.paneId || identity.agentName !== allocation.agentName
  ) throw new Error("Fresh session readiness differs from its approved allocation");
}

function requireFreshOrchestratorIdentity(identity: WorkerIdentity, allocation: NonNullable<OrchestratorRecord["allocation"]>, cwd: string, preparation: PreparationRecord): void {
  if (!isOrchestratorIdentity(identity) || identity.cwd !== cwd || digest(identity.model) !== digest(preparation.model) ||
    identity.workspaceId !== allocation.workspaceId || identity.tabId !== allocation.tabId ||
    identity.paneId !== allocation.paneId || identity.agentName !== allocation.agentName
  ) throw new Error("Fresh orchestrator readiness differs from its approved capability policy");
}

export function blockOrchestrator(record: OrchestratorRecord, diagnostic: string, dependencies: ControllerDependencies): void {
  record.phase = "needs-attention";
  record.diagnostic = diagnostic;
  record.generation += 1;
  if (record.decisions.length < 50 && !record.decisions.some((decision): boolean => decision.state === "pending" && decision.question === diagnostic)) {
    record.decisions.push({ id: dependencies.generateId(), state: "pending", requestedAt: dependencies.now().toISOString(),
      question: diagnostic, context: "Batch supervision cannot safely continue. Ticket workers, worktrees and saved sessions remain owned and preserved.",
      options: ["Inspect the retained state", "Take over affected workers"], recommendation: "Inspect before resuming supervision" });
  }
}

export async function launchOrchestrator(
  state: ControllerState, preparation: PreparationRecord, workspaceId: string,
  dependencies: ControllerDependencies, save: () => Promise<void>,
): Promise<OrchestratorRecord> {
  const worker = dependencies.execution!.worker;
  if (!worker.dispatchSupervision) throw new Error("Reasoning runtime is unavailable");
  const previous = preparation.orchestrator;
  const record: OrchestratorRecord = {
    generation: (previous?.generation ?? 0) + 1,
    workspaceId, phase: "starting", reason: previous?.reason ?? "initial",
    decisions: previous?.decisions ?? [], checkpoint: previous?.checkpoint ?? "Approved batch has not started.",
    ...(previous?.lastOutcome ? { lastOutcome: previous.lastOutcome } : {}),
  };
  preparation.orchestrator = record;
  await save();
  try {
    const packet = decisionPacket(state, preparation);
    const allocation = await worker.allocate({ workspaceId, cwd: preparation.project.root,
      agentName: `orch-${digest([preparation.id, record.generation]).slice(0, 24)}` });
    record.allocation = allocation;
    await save();
    const session = await worker.start({
      allocation,
      cwd: preparation.project.root,
      model: preparation.model,
      contextLimit: preparation.effectiveContextLimit!.handoffTokens,
      orchestration: { preparationId: preparation.id, generation: record.generation },
    });
    requireFreshOrchestratorIdentity(session, allocation, preparation.project.root, preparation);
    if (session.sessionId === previous?.session?.sessionId) throw new Error("Orchestrator reused its predecessor");
    record.session = session;
    await save();
    await worker.dispatchSupervision(session, packet);
    record.phase = "running";
    await save();
  } catch {
    blockOrchestrator(record, "Orchestrator startup failed or was ambiguous; preserve the owned session and reconcile before retrying", dependencies);
    await save();
  }
  return structuredClone(record);
}
