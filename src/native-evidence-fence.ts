import { randomUUID } from "node:crypto";
import { mkdir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { atomicWritePrivateFile } from "./atomic-file.js";
import { readBoundedRegularFile } from "./bounded-regular-file.js";

const OWNER_FILE = "owner.json";
const MAX_OWNER_BYTES = 16 * 1024;
const DEFAULT_DEADLINE_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 10;

export interface NativeEvidenceFenceOptions {
  deadlineMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  generateToken?: () => string;
  pid?: number;
  onAcquired?: (statePath: string) => Promise<void>;
}

export class NativeEvidenceFenceContentionError extends Error {
  constructor() {
    super("Native evidence lifecycle fence contention deadline exceeded");
    this.name = "NativeEvidenceFenceContentionError";
  }
}

interface NativeEvidenceFenceOwner {
  schemaVersion: 1;
  token: string;
  pid: number;
}

/** A bounded, ownership-checked filesystem lease for one native-evidence lifecycle. */
export class NativeEvidenceFence {
  private readonly deadlineMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly generateToken: () => string;
  private readonly pid: number;
  private readonly onAcquired: ((statePath: string) => Promise<void>) | undefined;

  constructor(options: NativeEvidenceFenceOptions = {}) {
    this.deadlineMs = positiveInteger(options.deadlineMs, DEFAULT_DEADLINE_MS, "deadline");
    this.retryDelayMs = positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, "retry delay");
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((milliseconds): Promise<void> =>
      new Promise((resolve): void => { setTimeout(resolve, milliseconds); }));
    this.generateToken = options.generateToken ?? randomUUID;
    this.pid = options.pid ?? process.pid;
    this.onAcquired = options.onAcquired;
  }

  async run<T>(statePath: string, operation: () => Promise<T>): Promise<T> {
    if (!isAbsolute(statePath)) throw new Error("Native evidence lifecycle fence path must be absolute");
    const token = this.generateToken();
    if (!token || token.length > 200 || /[\u0000-\u001f\u007f]/.test(token)) {
      throw new Error("Native evidence lifecycle fence owner token is invalid");
    }
    const fenceDirectory = nativeEvidenceFenceDirectory(statePath);
    const deadline = this.now() + this.deadlineMs;
    for (;;) {
      try {
        await mkdir(fenceDirectory, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (this.now() >= deadline) {
          throw new NativeEvidenceFenceContentionError();
        }
        await this.wait(this.retryDelayMs);
      }
    }

    const owner: NativeEvidenceFenceOwner = { schemaVersion: 1, token, pid: this.pid };
    await atomicWritePrivateFile(join(fenceDirectory, OWNER_FILE), `${JSON.stringify(owner)}\n`);
    let operationResult: T | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      await this.onAcquired?.(statePath);
      operationResult = await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    try {
      await releaseFence(fenceDirectory, owner);
    } catch (releaseError) {
      if (operationFailed) {
        throw new AggregateError([operationError, releaseError], "Native evidence lifecycle operation and fence release both failed");
      }
      throw releaseError;
    }
    if (operationFailed) throw operationError;
    return operationResult as T;
  }
}

export function nativeEvidenceFenceDirectory(statePath: string): string {
  if (!isAbsolute(statePath)) throw new Error("Native evidence lifecycle fence path must be absolute");
  return join(dirname(statePath), `${basename(statePath)}.fence`);
}

async function releaseFence(directory: string, expected: NativeEvidenceFenceOwner): Promise<void> {
  const ownerPath = join(directory, OWNER_FILE);
  const bytes = await readBoundedRegularFile(ownerPath, MAX_OWNER_BYTES, "Native evidence lifecycle fence owner");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Native evidence lifecycle fence owner is malformed");
  }
  if (!isOwner(parsed) || parsed.token !== expected.token || parsed.pid !== expected.pid) {
    throw new Error("Native evidence lifecycle fence ownership changed before release");
  }
  await unlink(ownerPath);
  await rmdir(directory);
}

function isOwner(value: unknown): value is NativeEvidenceFenceOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return Object.keys(owner).length === 3 && owner.schemaVersion === 1 &&
    typeof owner.token === "string" && owner.token.length > 0 && owner.token.length <= 200 &&
    Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`Native evidence lifecycle fence ${name} must be a positive integer`);
  }
  return selected;
}
