import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { GateCheckPort, GateCheckRecord } from "./contracts.js";
import { atomicWritePrivateFile } from "./atomic-file.js";
import { safeGateEvidence, type GateTermination } from "./safe-logging.js";

const MAX_CHECK_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface LocalGateCheckOptions {
  now?: () => Date;
  generateId?: () => string;
  timeoutMs?: number;
  waitForProcessGroupExit?: (pid: number | undefined) => Promise<void>;
}

/** Executes only commands frozen in the approved proposal and retains safe metadata, never arbitrary output. */
export class LocalGateCheckAdapter implements GateCheckPort {
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly timeoutMs: number;
  private readonly verifyProcessGroupExit: (pid: number | undefined) => Promise<void>;

  constructor(private readonly evidenceDirectory: string, options: LocalGateCheckOptions = {}) {
    if (!isAbsolute(evidenceDirectory)) throw new Error("Gate evidence directory must be absolute");
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.verifyProcessGroupExit = options.waitForProcessGroupExit ?? waitForProcessGroupExit;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Gate timeout must be positive");
  }

  async execute(input: { cwd: string; command: string; candidateCommit: string }): Promise<GateCheckRecord> {
    if (!isAbsolute(input.cwd) || !input.command.trim() || input.command.length > 4_096 || /\0/.test(input.command)) {
      throw new Error("Approved gate command is incomplete or unsafe");
    }
    await mkdir(this.evidenceDirectory, { recursive: true, mode: 0o700 });
    const result = await executeBoundedShell(input.command, input.cwd, this.timeoutMs, this.verifyProcessGroupExit);
    const evidence = safeGateEvidence({
      command: input.command,
      candidateCommit: input.candidateCommit,
      exitCode: result.exitCode,
      output: result.output,
      termination: result.termination,
    });
    const reference = join(this.evidenceDirectory, `check-${this.generateId()}.log`);
    await atomicWritePrivateFile(reference, evidence.serialized);
    return {
      command: input.command,
      exitCode: result.exitCode,
      outputDigest: evidence.outputDigest,
      logReference: reference,
      candidateCommit: input.candidateCommit,
      completedAt: this.now().toISOString(),
    };
  }
}

async function executeBoundedShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  verifyProcessGroupExit: (pid: number | undefined) => Promise<void>,
): Promise<{
  exitCode: number;
  output: string;
  termination: GateTermination;
}> {
  return new Promise((resolve, reject): void => {
    const child = spawn(command, { cwd, shell: true, detached: true, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    let timedOut = false;
    let termination: Promise<void> | undefined;
    const terminate = (): void => {
      if (termination) return;
      terminateProcessGroup(child.pid, "SIGTERM");
      termination = new Promise((terminationResolved): void => {
        setTimeout(terminationResolved, 2_000);
      }).then(async (): Promise<void> => {
        terminateProcessGroup(child.pid, "SIGKILL");
        await verifyProcessGroupExit(child.pid);
      });
    };
    const capture = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes <= MAX_CHECK_OUTPUT_BYTES) chunks.push(chunk);
      else {
        exceeded = true;
        terminate();
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout((): void => { timedOut = true; terminate(); }, timeoutMs);
    timeout.unref();
    child.once("error", (error): void => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal): void => {
      clearTimeout(timeout);
      void (async (): Promise<void> => {
        if (termination) await termination;
        const suffix = exceeded
          ? "\n[controller stopped the check because output exceeded 2 MiB]\n"
          : timedOut
            ? "\n[controller stopped the check because it exceeded its time limit]\n"
            : signal ? `\n[controller check ended by signal ${signal}]\n` : "";
        const terminationKind: GateTermination = exceeded ? "output-limit" : timedOut ? "timeout" : signal ? "signal" : "completed";
        resolve({
          exitCode: exceeded || timedOut || signal ? 1 : code ?? 1,
          output: `${Buffer.concat(chunks).toString("utf8")}${suffix}`,
          termination: terminationKind,
        });
      })().catch(reject);
    });
  });
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { /* Process may already have exited. */ }
}

async function waitForProcessGroupExit(pid: number | undefined): Promise<void> {
  if (!pid) return;
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error("Gate process group remained alive after forced termination");
    await new Promise((resolvePromise): void => { setTimeout(resolvePromise, 10); });
  }
}
