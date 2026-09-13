import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import type {
  WorkerBridgeChannel,
  WorkerBridgeTransport,
  WorkerDecisionAnswer,
  WorkerDecisionRequest,
  WorkerReadinessReceipt,
} from "./worker-bridge-protocol.js";

const MAX_RECEIPT_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

export interface FileWorkerBridgeOptions {
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  generateNonce?: () => string;
}

/** Restrictive, bounded file transport for readiness and durable local decisions. */
export class FileWorkerBridgeTransport implements WorkerBridgeTransport {
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly generateNonce: () => string;

  constructor(
    private readonly directory: string,
    options: FileWorkerBridgeOptions = {},
  ) {
    if (!isAbsolute(directory)) throw new Error("Worker bridge directory must be absolute");
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds): Promise<void> =>
      new Promise((resolve): void => { setTimeout(resolve, milliseconds); }));
    this.generateNonce = options.generateNonce ?? randomUUID;
  }

  async openChannel(agentName: string): Promise<WorkerBridgeChannel> {
    assertAgentName(agentName);
    await this.prepareRoot();
    const nonce = this.generateNonce();
    if (!SAFE_ID.test(nonce)) throw new Error("Worker bridge nonce is unsafe");
    const channelDirectory = join(this.directory, `${agentName}-${nonce}`);
    const requestDirectory = join(channelDirectory, "requests");
    const responseDirectory = join(channelDirectory, "responses");
    await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
    await mkdir(responseDirectory, { recursive: true, mode: 0o700 });
    await chmod(channelDirectory, 0o700);
    await chmod(requestDirectory, 0o700);
    await chmod(responseDirectory, 0o700);
    const channel: WorkerBridgeChannel = {
      endpoint: join(channelDirectory, "readiness.json"),
      nonce,
      requestDirectory,
      responseDirectory,
    };
    await atomicWrite(join(this.directory, `${agentName}.channel.json`), `${JSON.stringify(channel)}\n`);
    return channel;
  }

  async channelForAgent(agentName: string): Promise<WorkerBridgeChannel> {
    assertAgentName(agentName);
    await this.prepareRoot();
    const parsed: unknown = JSON.parse(await readBounded(join(this.directory, `${agentName}.channel.json`)));
    if (!isChannel(parsed) || !this.ownsChannel(parsed, agentName)) throw new Error("Worker decision channel is malformed or foreign");
    return parsed;
  }

  async waitForReadiness(channel: WorkerBridgeChannel, timeoutMs: number): Promise<WorkerReadinessReceipt> {
    this.assertOwnedChannel(channel);
    const deadline = this.now() + timeoutMs;
    for (;;) {
      try {
        const parsed: unknown = JSON.parse(await readBounded(channel.endpoint));
        await removeIfPresent(channel.endpoint);
        return parsed as WorkerReadinessReceipt;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (this.now() >= deadline) throw new Error("Worker readiness receipt timed out");
      await this.sleep(this.pollIntervalMs);
    }
  }

  async nextDecisionRequest(channel: WorkerBridgeChannel): Promise<WorkerDecisionRequest | undefined> {
    this.assertOwnedChannel(channel);
    const names = (await readdir(channel.requestDirectory!)).filter((name): boolean => SAFE_ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json")).sort();
    const name = names[0];
    if (!name) return undefined;
    const parsed: unknown = JSON.parse(await readBounded(join(channel.requestDirectory!, name)));
    if (!isDecisionRequest(parsed) || parsed.nonce !== channel.nonce || `${parsed.id}.json` !== name) {
      throw new Error("Worker decision request is malformed or stale");
    }
    return parsed;
  }

  async acknowledgeDecisionRequest(channel: WorkerBridgeChannel, decisionId: string): Promise<void> {
    this.assertOwnedChannel(channel);
    assertSafeId(decisionId);
    await removeIfPresent(join(channel.requestDirectory!, `${decisionId}.json`));
  }

  async deliverDecision(channel: WorkerBridgeChannel, answer: WorkerDecisionAnswer): Promise<void> {
    this.assertOwnedChannel(channel);
    if (!isDecisionAnswer(answer) || answer.nonce !== channel.nonce) throw new Error("Worker decision answer is malformed or stale");
    await atomicWrite(join(channel.responseDirectory!, `${answer.id}.json`), `${JSON.stringify(answer)}\n`);
  }

  private async prepareRoot(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }

  private assertOwnedChannel(channel: WorkerBridgeChannel): void {
    if (!isChannel(channel) || !this.ownsChannel(channel)) throw new Error("Worker bridge channel is incomplete or foreign");
  }

  private ownsChannel(channel: WorkerBridgeChannel, agentName?: string): boolean {
    const channelDirectory = dirname(channel.endpoint);
    const expectedName = agentName ? `${agentName}-${channel.nonce}` : basename(channelDirectory);
    return dirname(channelDirectory) === this.directory && basename(channelDirectory) === expectedName &&
      basename(channelDirectory).endsWith(`-${channel.nonce}`) &&
      channel.endpoint === join(channelDirectory, "readiness.json") &&
      channel.requestDirectory === join(channelDirectory, "requests") &&
      channel.responseDirectory === join(channelDirectory, "responses");
  }
}

async function readBounded(path: string): Promise<string> {
  const data = await readFile(path);
  if (data.byteLength > MAX_RECEIPT_BYTES) throw new Error("Worker bridge record exceeds its bound");
  return data.toString("utf8");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await removeIfPresent(temporary);
  }
}

function isChannel(value: unknown): value is Required<WorkerBridgeChannel> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const channel = value as WorkerBridgeChannel;
  return [channel.endpoint, channel.requestDirectory, channel.responseDirectory].every((path): boolean => typeof path === "string" && isAbsolute(path)) &&
    typeof channel.nonce === "string" && SAFE_ID.test(channel.nonce);
}

function isDecisionRequest(value: unknown): value is WorkerDecisionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as WorkerDecisionRequest;
  return request.schemaVersion === 1 && SAFE_ID.test(request.nonce) && SAFE_ID.test(request.id) &&
    Number.isFinite(Date.parse(request.requestedAt)) && safeText(request.question, 4_000) && safeText(request.context, 4_000) &&
    Array.isArray(request.options) && request.options.length >= 1 && request.options.length <= 20 &&
    request.options.every((option): boolean => safeText(option, 1_000)) && safeText(request.recommendation, 4_000);
}

function isDecisionAnswer(value: unknown): value is WorkerDecisionAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const answer = value as WorkerDecisionAnswer;
  return answer.schemaVersion === 1 && SAFE_ID.test(answer.nonce) && SAFE_ID.test(answer.id) &&
    Number.isFinite(Date.parse(answer.answeredAt)) && safeText(answer.answer, 4_000);
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum &&
    !/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+\b/i.test(value) &&
    !/(?:token|secret|password|api[_ -]?key)\s*[=:]\s*\S+/i.test(value);
}

function assertAgentName(agentName: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agentName)) throw new Error("Worker bridge agent name is unsafe");
}

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error("Worker decision identity is unsafe");
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
