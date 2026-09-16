import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import coordinationBridge from "../src/coordination-bridge.js";

test("Pi bridge rejects malformed role configs and limits orchestrators to bounded investigation and controller operations", async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "herdr-context-policy-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const pi = { on: (name: string, handler: (...args: any[]) => any): void => { handlers.set(name, handler); },
    registerTool: (tool: any): void => { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
  const ctx = { cwd: root, getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
    sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionContext;
  try {
    coordinationBridge(pi, { directory: root, nonce: "nonce-1" });
    const toolCall = handlers.get("tool_call")!;
    const missing = await toolCall({ toolName: "bash" }, ctx);
    assert.equal(missing.block, true);
    assert.equal(missing.terminate, true);
    for (const malformed of [
      { role: "unmanaged", contextLimit: 180_000 },
      { role: "implementation" },
      { role: "implementation", contextLimit: 180_000, lease: {} },
      { role: "orchestrator", contextLimit: 180_000 },
      { role: "orchestrator", contextLimit: -1, lease: { preparationId: "batch-1", generation: 1, sessionId: "session-1" } },
      { role: "handoff", binding: {}, contextLimit: 180_000 },
    ]) {
      await writeFile(join(root, "coordination.json"), JSON.stringify(malformed));
      const rejected = await toolCall({ toolName: "read" }, ctx);
      assert.equal(rejected.block, true);
      assert.equal(rejected.terminate, true);
    }

    await writeFile(join(root, "coordination.json"), JSON.stringify({
      role: "orchestrator",
      contextLimit: 180_000,
      lease: { preparationId: "batch-1", generation: 1, sessionId: "session-1" },
    }));
    for (const allowed of ["read", "grep", "find", "ls", "herdr_orchestrator_operation"]) {
      assert.equal(await toolCall({ toolName: allowed }, ctx), undefined);
    }
    for (const denied of ["bash", "edit", "write", "subagent", "ambient_tracker_tool", "herdr_capture_native_evidence"]) {
      const result = await toolCall({ toolName: denied }, ctx);
      assert.equal(result.block, true);
      assert.equal(result.terminate, true);
    }
    await writeFile(join(root, "coordination.json"), JSON.stringify({ role: "unmanaged" }));
    assert.equal(await toolCall({ toolName: "bash" }, ctx), undefined);

    await writeFile(join(root, "coordination.json"), JSON.stringify({
      role: "orchestrator",
      contextLimit: 180_000,
      lease: { preparationId: "batch-1", generation: 1, sessionId: "session-1" },
    }));
    const operation = tools.get("herdr_orchestrator_operation");
    await operation.execute("tool-1", { kind: "wait", assessment: "No eligible work" }, undefined, undefined, ctx);
    const receipt = JSON.parse(await readFile(join(root, "orchestrator-operation.json"), "utf8"));
    assert.equal(receipt.command.operation.kind, "wait");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ordinary Pi sessions without a coordination channel keep their normal tools", async (): Promise<void> => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = { on: (name: string, handler: (...args: any[]) => any): void => { handlers.set(name, handler); },
    registerTool: (): void => {} } as unknown as ExtensionAPI;
  const endpoint = process.env.HERDR_WORKER_BRIDGE_ENDPOINT;
  const nonce = process.env.HERDR_WORKER_BRIDGE_NONCE;
  delete process.env.HERDR_WORKER_BRIDGE_ENDPOINT;
  delete process.env.HERDR_WORKER_BRIDGE_NONCE;
  try {
    coordinationBridge(pi);
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash" }, {} as ExtensionContext), undefined);
  } finally {
    if (endpoint === undefined) delete process.env.HERDR_WORKER_BRIDGE_ENDPOINT;
    else process.env.HERDR_WORKER_BRIDGE_ENDPOINT = endpoint;
    if (nonce === undefined) delete process.env.HERDR_WORKER_BRIDGE_NONCE;
    else process.env.HERDR_WORKER_BRIDGE_NONCE = nonce;
  }
});

test("Pi bridge stops at current occupancy and accepts the actual artifact only after native handoff invocation", async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "herdr-context-bridge-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const pi = { on: (name: string, handler: (...args: any[]) => any): void => { handlers.set(name, handler); },
    registerTool: (tool: any): void => { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
  let tokens: number | null = 170_000;
  const ctx = { cwd: root, getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: 85 }),
    sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionContext;
  try {
    coordinationBridge(pi, { directory: root, nonce: "nonce-1" });
    await writeFile(join(root, "coordination.json"), JSON.stringify({ role: "implementation", contextLimit: 180_000 }));
    assert.equal(await handlers.get("tool_call")!({ toolName: "read" }, ctx), undefined);
    tokens = 180_000;
    assert.equal((await handlers.get("tool_call")!({ toolName: "read" }, ctx)).terminate, true);
    tokens = null;
    assert.equal((await handlers.get("tool_call")!({ toolName: "read" }, ctx)).block, true);
    const binding = { preparationId: "batch-1", attemptId: "attempt-1", ticketIdentity: "ticket-6", specIdentity: "spec-2", worktreePath: root, branch: "ticket-branch", codeStateDigest: "a".repeat(64) };
    const artifactPath = join(root, "native-skill-picked-this.md");
    const artifactContent = `${Object.values(binding).join("\n")}\nChanges: keep dirty code\nChecks: tests pending\nFindings: review pending\nDecisions: none\nNext: finish tests`;
    await writeFile(artifactPath, artifactContent);
    await utimes(artifactPath, new Date(0), new Date(0));
    await writeFile(join(root, "coordination.json"), JSON.stringify({ role: "handoff", binding }));
    const submit = tools.get("herdr_submit_handoff");
    await assert.rejects(submit.execute("tool-1", { artifactPath }, undefined, undefined, ctx));
    await handlers.get("input")!({ text: "/skill:handoff Continue implementation" }, ctx);
    await assert.rejects(submit.execute("tool-2", { artifactPath }, undefined, undefined, ctx), /predates/);
    await writeFile(artifactPath, artifactContent);
    await submit.execute("tool-3", { artifactPath }, undefined, undefined, ctx);
    const receipt = JSON.parse(await readFile(join(root, "handoff-receipt.json"), "utf8"));
    assert.equal(receipt.nativeCommand, "/skill:handoff");
    assert.equal(receipt.sourcePath, artifactPath);
    assert.equal(receipt.sessionId, "session-1");
  } finally { await rm(root, { recursive: true, force: true }); }
});
