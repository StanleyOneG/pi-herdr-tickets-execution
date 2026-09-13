import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { atomicWritePrivateFile } from "./atomic-file.js";
import type { CapturedModel, ThinkingLevel } from "./contracts.js";
import {
  WORKER_BRIDGE_AGENT_ENV,
  WORKER_BRIDGE_ENDPOINT_ENV,
  WORKER_BRIDGE_NONCE_ENV,
  WORKER_DECISION_REQUEST_DIRECTORY_ENV,
  WORKER_DECISION_RESPONSE_DIRECTORY_ENV,
  type WorkerDecisionAnswer,
  type WorkerDecisionRequest,
  type WorkerReadinessReceipt,
} from "./worker-bridge-protocol.js";

const HISTORY_ENTRY_TYPES = new Set(["message", "custom_message", "compaction", "branch_summary"]);
const DECISION_SCHEMA = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 4_000 }),
  context: Type.String({ minLength: 1, maxLength: 4_000 }),
  options: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 20 }),
  recommendation: Type.String({ minLength: 1, maxLength: 4_000 }),
});
type DecisionInput = Static<typeof DECISION_SCHEMA>;
let sessionStartReason: WorkerReadinessReceipt["sessionStartReason"] | undefined;

export default function herdrWorkerBridge(pi: ExtensionAPI): void {
  sessionStartReason = undefined;
  pi.on("session_start", (event, _ctx): void => {
    sessionStartReason = event.reason;
  });

  pi.registerCommand("herdr-worker-ready", {
    description: "Report attempt-bound Pi identity and normal resource readiness to the local Herdr controller",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const receipt = collectWorkerReadiness(pi, ctx);
      await writeReceipt(receipt);
    },
  });

  pi.registerTool({
    name: "herdr_request_local_decision",
    label: "Request Local Decision",
    description: "Pause for one explicit local human decision when implementation cannot safely continue. Supply the exact question, bounded context, meaningful options and consequences, and a recommendation. Do not use this for routine status or a clarification you can resolve from approved sources.",
    parameters: DECISION_SCHEMA,
    async execute(
      _toolCallId: string,
      params: DecisionInput,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const answer = await requestLocalDecision(params, signal);
      return {
        content: [{ type: "text", text: `The local human explicitly answered: ${answer.answer}` }],
        details: { decisionId: answer.id, answeredAt: answer.answeredAt },
      };
    },
  });
}

export function collectWorkerReadiness(pi: ExtensionAPI, ctx: ExtensionCommandContext): WorkerReadinessReceipt {
  const endpoint = process.env[WORKER_BRIDGE_ENDPOINT_ENV];
  const nonce = process.env[WORKER_BRIDGE_NONCE_ENV];
  const agentName = process.env[WORKER_BRIDGE_AGENT_ENV];
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const paneId = process.env.HERDR_PANE_ID;
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (
    !endpoint || !isAbsolute(endpoint) || !nonce || !agentName || !workspaceId || !tabId || !paneId ||
    !sessionFile || !isAbsolute(sessionFile) || !ctx.model || !sessionStartReason
  ) {
    throw new Error("Attempt-bound worker bridge identity is incomplete");
  }
  const options = ctx.getSystemPromptOptions();
  const model: CapturedModel = {
    provider: ctx.model.provider,
    id: ctx.model.id,
    thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
    contextWindow: ctx.model.contextWindow,
  };
  return {
    schemaVersion: 1,
    nonce,
    observedAt: new Date().toISOString(),
    sessionStartReason,
    workspaceId,
    tabId,
    paneId,
    agentName,
    piPid: process.pid,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile,
    cwd: ctx.cwd,
    mode: ctx.mode,
    initialHistoryEntries: ctx.sessionManager.getBranch()
      .filter((entry): boolean => HISTORY_ENTRY_TYPES.has(entry.type)).length,
    model,
    commands: pi.getCommands().map((command) => ({
      name: command.name,
      source: command.source,
      sourceInfo: { ...command.sourceInfo },
    })),
    toolNames: pi.getActiveTools(),
    contextFiles: (options.contextFiles ?? []).map((file): string => file.path),
  };
}

export async function requestLocalDecision(input: DecisionInput, signal?: AbortSignal): Promise<WorkerDecisionAnswer> {
  const requestDirectory = process.env[WORKER_DECISION_REQUEST_DIRECTORY_ENV];
  const responseDirectory = process.env[WORKER_DECISION_RESPONSE_DIRECTORY_ENV];
  const nonce = process.env[WORKER_BRIDGE_NONCE_ENV];
  if (!requestDirectory || !responseDirectory || !isAbsolute(requestDirectory) || !isAbsolute(responseDirectory) || !nonce) {
    throw new Error("Attempt-bound local decision channel is incomplete");
  }
  const id = randomUUID();
  const request: WorkerDecisionRequest = {
    schemaVersion: 1,
    nonce,
    id,
    requestedAt: new Date().toISOString(),
    ...input,
  };
  await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
  await mkdir(responseDirectory, { recursive: true, mode: 0o700 });
  await atomicWritePrivateFile(join(requestDirectory, `${id}.json`), `${JSON.stringify(request)}\n`);
  const responsePath = join(responseDirectory, `${id}.json`);
  for (;;) {
    if (signal?.aborted) throw new Error("Local decision wait was interrupted; the durable question remains pending");
    try {
      const data = await readFile(responsePath);
      if (data.byteLength > 256 * 1024) throw new Error("Local decision answer exceeds its bound");
      const answer = JSON.parse(data.toString("utf8")) as WorkerDecisionAnswer;
      if (answer.schemaVersion !== 1 || answer.nonce !== nonce || answer.id !== id ||
        !Number.isFinite(Date.parse(answer.answeredAt)) || typeof answer.answer !== "string" ||
        !answer.answer.trim() || answer.answer.length > 4_000) throw new Error("Local decision answer is malformed or stale");
      await unlink(responsePath);
      return answer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve): void => { setTimeout(resolve, 100); });
  }
}

async function writeReceipt(receipt: WorkerReadinessReceipt): Promise<void> {
  const endpoint = process.env[WORKER_BRIDGE_ENDPOINT_ENV]!;
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  await atomicWritePrivateFile(endpoint, `${JSON.stringify(receipt)}\n`);
}
