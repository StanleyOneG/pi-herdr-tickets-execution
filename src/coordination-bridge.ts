import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import { atomicWritePrivateFile } from "./atomic-file.js";
import { readBoundedRegularFile } from "./bounded-regular-file.js";
import { ORCHESTRATOR_TOOL_NAMES, type CoordinationConfig } from "./coordination-contracts.js";
import { isCoordinationConfig, isOrchestratorCommand } from "./coordination-validation.js";
import { readHandoffArtifact } from "./handoff-artifact.js";
import { WORKER_BRIDGE_ENDPOINT_ENV, WORKER_BRIDGE_NONCE_ENV } from "./worker-bridge-protocol.js";

const ORCHESTRATOR_TOOLS = new Set<string>(ORCHESTRATOR_TOOL_NAMES);
const CONTEXT_BOUNDARY_REASON = "Current context is unknown or at the approved checkpoint threshold. Stop at this tool boundary; the controller will preserve work and coordinate a fresh session.";
const ORCHESTRATOR_POLICY_REASON = "The reasoning orchestrator may use only bounded read-only investigation and controller operations. Mutating, shell, subagent, ambient, gate, tracker, and delivery tools are denied.";

/** Additive tools and occupancy guard for normal managed Pi TUI sessions. */
export default function coordinationBridge(pi: ExtensionAPI, options?: { directory: string; nonce: string }): void {
  let nativeHandoffSession: string | undefined;
  const channel = (): { directory: string; nonce: string } | undefined => {
    if (options) return options;
    const endpoint = process.env[WORKER_BRIDGE_ENDPOINT_ENV];
    const nonce = process.env[WORKER_BRIDGE_NONCE_ENV];
    return endpoint && isAbsolute(endpoint) && nonce ? { directory: dirname(endpoint), nonce } : undefined;
  };
  const config = async (): Promise<CoordinationConfig | undefined> => {
    const current = channel();
    if (!current) return undefined;
    const value: unknown = JSON.parse((await readBoundedRegularFile(join(current.directory, "coordination.json"), 32_000, "Coordination config")).toString("utf8"));
    if (!isCoordinationConfig(value)) throw new Error("Invalid coordination config");
    return value;
  };
  pi.on("input", (event, ctx): void => {
    if (/^\/skill:handoff(?:\s|$)/.test(event.text)) nativeHandoffSession = ctx.sessionManager.getSessionId();
  });
  pi.on("tool_call", async (event, ctx) => {
    let current: CoordinationConfig | undefined;
    try {
      current = await config();
    } catch {
      return { block: true, terminate: true, reason: "The managed coordination policy is missing or invalid. Stop without using tools while the controller reconciles the session." };
    }
    if (!current || current.role === "unmanaged" || current.role === "handoff") return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || usage.tokens >= current.contextLimit) {
      return { block: true, terminate: true, reason: CONTEXT_BOUNDARY_REASON };
    }
    if (current.role === "orchestrator" && !ORCHESTRATOR_TOOLS.has(event.toolName)) {
      return { block: true, terminate: true, reason: ORCHESTRATOR_POLICY_REASON };
    }
  });
  pi.registerTool({
    name: "herdr_submit_handoff", label: "Retain native handoff", description: "Record the actual bounded Markdown artifact produced by native /skill:handoff. Requires current ticket/worktree/state bindings and useful implementation notes.",
    parameters: Type.Object({ artifactPath: Type.String({ minLength: 1, maxLength: 4_096 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      const current = await config();
      const target = channel();
      if (!target || current?.role !== "handoff" || !current.binding || nativeHandoffSession !== ctx.sessionManager.getSessionId()) throw new Error("No native implementation handoff invocation is active");
      if (current.binding.worktreePath !== ctx.cwd) throw new Error("Handoff worktree mismatch");
      const artifact = await readHandoffArtifact(params.artifactPath, current.binding);
      const [artifactMetadata, requestMetadata] = await Promise.all([
        stat(params.artifactPath),
        stat(join(target.directory, "coordination.json")),
      ]);
      if (artifactMetadata.mtimeMs < requestMetadata.mtimeMs) throw new Error("Handoff artifact predates the current native handoff request");
      await atomicWritePrivateFile(join(target.directory, "handoff-receipt.json"), JSON.stringify({
        nonce: target.nonce, sessionId: ctx.sessionManager.getSessionId(), nativeCommand: "/skill:handoff",
        binding: current.binding, sourcePath: params.artifactPath, sourceDigest: artifact.sourceDigest,
      }));
      return { content: [{ type: "text", text: "Handoff path recorded. The controller must validate and durably retain it before retirement." }], details: {}, terminate: true };
    },
  });
  pi.registerTool({
    name: "herdr_orchestrator_operation", label: "Request batch operation", description: "Reason about the approved batch and submit one controller-validated operation. No scope, policy, gate waiver or final merge operations exist. This ends the turn; controller results arrive in the next bounded packet.",
    parameters: Type.Object({
      kind: StringEnum(["start", "assess", "escalate", "wait"] as const),
      ticketIdentity: Type.Optional(Type.String({ maxLength: 4_000 })),
      attemptId: Type.Optional(Type.String({ maxLength: 4_000 })),
      assessment: Type.Optional(Type.String({ maxLength: 4_000 })),
      question: Type.Optional(Type.String({ maxLength: 4_000 })),
      context: Type.Optional(Type.String({ maxLength: 4_000 })),
      options: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 20 })),
      recommendation: Type.Optional(Type.String({ maxLength: 4_000 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const current = await config();
      const target = channel();
      if (!target || current?.role !== "orchestrator" || current.lease.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Invalid operation or inactive reasoning session");
      const command = { ...current.lease, operation: params };
      if (!isOrchestratorCommand(command)) throw new Error("Invalid operation or inactive reasoning session");
      await atomicWritePrivateFile(join(target.directory, "orchestrator-operation.json"), JSON.stringify({ nonce: target.nonce, command }));
      return { content: [{ type: "text", text: "Operation submitted, not yet executed. Wait for the controller's next packet." }], details: {}, terminate: true };
    },
  });
}
