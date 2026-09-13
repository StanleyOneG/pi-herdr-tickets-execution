import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { atomicWritePrivateFile } from "./atomic-file.js";
import type {
  WorkerBridgeChannel,
  WorkerBridgeTransport,
  WorkerDecisionAnswer,
  WorkerDecisionRequest,
  WorkerLifecycleReceipt,
  WorkerNativeVerificationReceipt,
  WorkerReadinessReceipt,
  WorkerReviewReceipt,
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
      lifecycleEndpoint: join(channelDirectory, "lifecycle.json"),
      reviewEndpoint: join(channelDirectory, "review.json"),
      nativeVerificationEndpoint: join(channelDirectory, "native-verification.json"),
      lifecycleChallengeEndpoint: join(channelDirectory, "lifecycle-challenge.json"),
      lifecycleChallengeResponseEndpoint: join(channelDirectory, "lifecycle-challenge-response.json"),
    };
    await atomicWritePrivateFile(join(this.directory, `${agentName}.channel.json`), `${JSON.stringify(channel)}\n`);
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
    await atomicWritePrivateFile(join(channel.responseDirectory!, `${answer.id}.json`), `${JSON.stringify(answer)}\n`);
  }

  async readLifecycle(channel: WorkerBridgeChannel): Promise<WorkerLifecycleReceipt | undefined> {
    this.assertOwnedChannel(channel);
    try {
      const parsed: unknown = JSON.parse(await readBounded(channel.lifecycleEndpoint!));
      if (!isLifecycleReceipt(parsed) || parsed.nonce !== channel.nonce) throw new Error("Worker lifecycle receipt is malformed or stale");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async challengeLifecycle(channel: WorkerBridgeChannel, expectedPiPid: number, timeoutMs: number): Promise<void> {
    this.assertOwnedChannel(channel);
    if (!Number.isSafeInteger(expectedPiPid) || expectedPiPid <= 0) throw new Error("Worker lifecycle challenge PID is invalid");
    const challenge = this.generateNonce();
    if (!SAFE_ID.test(challenge)) throw new Error("Worker lifecycle challenge is unsafe");
    await removeIfPresent(channel.lifecycleChallengeResponseEndpoint!);
    await atomicWritePrivateFile(channel.lifecycleChallengeEndpoint!, `${JSON.stringify({
      schemaVersion: 1,
      nonce: channel.nonce,
      challenge,
      expectedPiPid,
      requestedAt: new Date(this.now()).toISOString(),
    })}\n`);
    const deadline = this.now() + timeoutMs;
    for (;;) {
      try {
        const parsed: unknown = JSON.parse(await readBounded(channel.lifecycleChallengeResponseEndpoint!));
        if (!isLifecycleChallengeResponse(parsed) || parsed.nonce !== channel.nonce ||
          parsed.challenge !== challenge || parsed.piPid !== expectedPiPid
        ) throw new Error("Worker lifecycle challenge response is stale or belongs to another Pi process");
        await removeIfPresent(channel.lifecycleChallengeEndpoint!);
        await removeIfPresent(channel.lifecycleChallengeResponseEndpoint!);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (this.now() >= deadline) throw new Error("Worker lifecycle challenge timed out without a live bridge response");
      await this.sleep(this.pollIntervalMs);
    }
  }

  async waitForNativeVerification(
    channel: WorkerBridgeChannel,
    timeoutMs: number,
  ): Promise<WorkerNativeVerificationReceipt> {
    this.assertOwnedChannel(channel);
    const deadline = this.now() + timeoutMs;
    for (;;) {
      try {
        const parsed: unknown = JSON.parse(await readBounded(channel.nativeVerificationEndpoint!));
        if (!isNativeVerificationReceipt(parsed) || parsed.nonce !== channel.nonce) {
          throw new Error("Worker native verification receipt is malformed or stale");
        }
        return parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (this.now() >= deadline) throw new Error("Worker native verification receipt timed out");
      await this.sleep(this.pollIntervalMs);
    }
  }

  async waitForReview(channel: WorkerBridgeChannel, timeoutMs: number): Promise<WorkerReviewReceipt> {
    this.assertOwnedChannel(channel);
    const deadline = this.now() + timeoutMs;
    for (;;) {
      try {
        const parsed: unknown = JSON.parse(await readBounded(channel.reviewEndpoint!));
        if (!isReviewReceipt(parsed) || parsed.nonce !== channel.nonce) throw new Error("Worker review receipt is malformed or stale");
        return parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (this.now() >= deadline) throw new Error("Worker review receipt timed out");
      await this.sleep(this.pollIntervalMs);
    }
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
      channel.responseDirectory === join(channelDirectory, "responses") &&
      channel.lifecycleEndpoint === join(channelDirectory, "lifecycle.json") &&
      channel.reviewEndpoint === join(channelDirectory, "review.json") &&
      channel.nativeVerificationEndpoint === join(channelDirectory, "native-verification.json") &&
      channel.lifecycleChallengeEndpoint === join(channelDirectory, "lifecycle-challenge.json") &&
      channel.lifecycleChallengeResponseEndpoint === join(channelDirectory, "lifecycle-challenge-response.json");
  }
}

async function readBounded(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_RECEIPT_BYTES) {
      throw new Error("Worker bridge record is not a bounded regular file");
    }
    const data = Buffer.alloc(metadata.size + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== metadata.size) throw new Error("Worker bridge record changed while it was read");
    return data.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

function isChannel(value: unknown): value is Required<WorkerBridgeChannel> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const channel = value as WorkerBridgeChannel;
  return [
    channel.endpoint, channel.requestDirectory, channel.responseDirectory, channel.lifecycleEndpoint,
    channel.reviewEndpoint, channel.nativeVerificationEndpoint, channel.lifecycleChallengeEndpoint,
    channel.lifecycleChallengeResponseEndpoint,
  ]
    .every((path): boolean => typeof path === "string" && isAbsolute(path)) &&
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

function isLifecycleReceipt(value: unknown): value is WorkerLifecycleReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as WorkerLifecycleReceipt;
  return receipt.schemaVersion === 1 && SAFE_ID.test(receipt.nonce) && safeText(receipt.sessionId, 4_096) &&
    Number.isSafeInteger(receipt.piPid) && receipt.piPid > 0 &&
    (receipt.state === "working" || receipt.state === "settled") && Number.isFinite(Date.parse(receipt.observedAt)) &&
    Array.isArray(receipt.outstandingJobs) && receipt.outstandingJobs.length <= 50 &&
    receipt.outstandingJobs.every((job): boolean => safeText(job, 4_096));
}

function isLifecycleChallengeResponse(value: unknown): value is {
  schemaVersion: 1;
  nonce: string;
  challenge: string;
  piPid: number;
  respondedAt: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return response.schemaVersion === 1 && typeof response.nonce === "string" && SAFE_ID.test(response.nonce) &&
    typeof response.challenge === "string" && SAFE_ID.test(response.challenge) &&
    Number.isSafeInteger(response.piPid) && (response.piPid as number) > 0 &&
    typeof response.respondedAt === "string" && Number.isFinite(Date.parse(response.respondedAt));
}

function isNativeVerificationReceipt(value: unknown): value is WorkerNativeVerificationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as WorkerNativeVerificationReceipt;
  return receipt.schemaVersion === 1 && SAFE_ID.test(receipt.nonce) && safeText(receipt.sessionId, 4_096) &&
    (receipt.status === "passed" || receipt.status === "blocked") && safeText(receipt.candidateCommit, 4_096) &&
    /^[a-f0-9]{64}$/i.test(receipt.codeStateDigest) && Array.isArray(receipt.observedCommandDigests) &&
    receipt.observedCommandDigests.length > 0 && receipt.observedCommandDigests.length <= 100 &&
    receipt.observedCommandDigests.every((item): boolean => /^[a-f0-9]{64}$/i.test(item)) &&
    Array.isArray(receipt.findings) && receipt.findings.length <= 50 &&
    receipt.findings.every((finding): boolean => safeText(finding, 4_000)) &&
    Number.isFinite(Date.parse(receipt.completedAt));
}

function isReviewReceipt(value: unknown): value is WorkerReviewReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as WorkerReviewReceipt;
  return receipt.schemaVersion === 1 && SAFE_ID.test(receipt.nonce) && safeText(receipt.sessionId, 4_096) &&
    (receipt.kind === "standards" || receipt.kind === "spec") && (receipt.verdict === "passed" || receipt.verdict === "blocked") &&
    safeText(receipt.candidateCommit, 4_096) && safeText(receipt.reviewBase, 4_096) &&
    Array.isArray(receipt.findings) && receipt.findings.length <= 50 && receipt.findings.every((finding): boolean => safeText(finding, 4_000)) &&
    Number.isFinite(Date.parse(receipt.completedAt));
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
