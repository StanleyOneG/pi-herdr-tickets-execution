import type { PreparationRecord, SetupOperation } from "./contracts.js";

export function formatPreparationPreview(record: PreparationRecord): string {
  const proposal = record.proposal!;
  const edges = proposal.dependencies
    .map((edge): string => `${edge.ticketIdentity} <- ${edge.prerequisiteIdentity}`)
    .join(", ") || "none";
  return [
    `${record.controllerName} (${record.stage})`,
    `Project/spec: ${proposal.project.identity} / ${proposal.spec.identity} — ${proposal.spec.title}`,
    `Tickets: ${proposal.tickets.map((ticket): string => `${ticket.identity} ${ticket.title}${ticket.claimedBy === null ? " [unclaimed]" : ` [claimed: ${ticket.claimedBy}]`}`).join("; ")}`,
    `Dependencies: ${edges}`,
    `Target: ${proposal.target.branch} @ ${proposal.target.baseCommit}`,
    `Model: ${proposal.model.provider}/${proposal.model.id}:${proposal.model.thinkingLevel}`,
    `Policy: concurrency ${proposal.policy.concurrency}; handoff ${record.effectiveContextLimit?.handoffTokens}; reserve ${record.effectiveContextLimit?.reserveTokens}; handoff replacements ${proposal.policy.maxHandoffReplacements}; repairs ${proposal.policy.maxRepairCycles}`,
    `Reviews/checks: ${proposal.policy.requiredReviews.join(", ")}; ${proposal.policy.checks.map((check): string => check.command).join(", ") || "no optional checks"}`,
    `Setup: ${proposal.policy.setupOperations.map(formatSetupOperation).join("; ") || "none"}`,
    `Resources: ${proposal.resources.map((resource): string => `${resource.kind}=${resource.isolation}`).join(", ")}`,
    `Proposal digest: ${record.proposalDigest}`,
  ].join("\n");
}

function formatSetupOperation(operation: SetupOperation): string {
  if (operation.kind === "dependency-install") return `${operation.packageManager} install (${operation.mode})`;
  if (operation.kind === "environment-template") return `copy template ${operation.source} -> ${operation.destination}`;
  return `${operation.packageManager} run ${operation.script} (${operation.environment})`;
}
