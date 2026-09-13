import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { GateCheckPort, GateCheckRecord } from "./contracts.js";
import { atomicWritePrivateFile } from "./atomic-file.js";

const MAX_CHECK_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface LocalGateCheckOptions {
  now?: () => Date;
  generateId?: () => string;
  timeoutMs?: number;
}

/** Executes only commands frozen in the approved proposal and retains bounded combined output. */
export class LocalGateCheckAdapter implements GateCheckPort {
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly timeoutMs: number;

  constructor(private readonly evidenceDirectory: string, options: LocalGateCheckOptions = {}) {
    if (!isAbsolute(evidenceDirectory)) throw new Error("Gate evidence directory must be absolute");
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Gate timeout must be positive");
  }

  async execute(input: { cwd: string; command: string; candidateCommit: string }): Promise<GateCheckRecord> {
    if (!isAbsolute(input.cwd) || !input.command.trim() || input.command.length > 4_096 || /\0/.test(input.command)) {
      throw new Error("Approved gate command is incomplete or unsafe");
    }
    await mkdir(this.evidenceDirectory, { recursive: true, mode: 0o700 });
    const result = await executeBoundedShell(input.command, input.cwd, this.timeoutMs);
    const output = redactCredentials(`command: ${input.command}\nexit: ${result.exitCode}\n\n${result.output}`);
    const reference = join(this.evidenceDirectory, `check-${this.generateId()}.log`);
    await atomicWritePrivateFile(reference, output);
    return {
      command: input.command,
      exitCode: result.exitCode,
      outputDigest: createHash("sha256").update(output).digest("hex"),
      logReference: reference,
      candidateCommit: input.candidateCommit,
      completedAt: this.now().toISOString(),
    };
  }
}

async function executeBoundedShell(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject): void => {
    const child = spawn(command, { cwd, shell: true, detached: true, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    const capture = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes <= MAX_CHECK_OUTPUT_BYTES) chunks.push(chunk);
      else {
        exceeded = true;
        terminateProcessGroup(child.pid);
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout((): void => { terminateProcessGroup(child.pid); }, timeoutMs);
    timeout.unref();
    child.once("error", (error): void => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal): void => {
      clearTimeout(timeout);
      const suffix = exceeded
        ? "\n[controller stopped the check because output exceeded 2 MiB]\n"
        : signal ? `\n[controller check ended by signal ${signal}]\n` : "";
      resolve({ exitCode: exceeded || signal ? 1 : code ?? 1, output: `${Buffer.concat(chunks).toString("utf8")}${suffix}` });
    });
  });
}

function terminateProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* Process may already have exited. */ }
}

function redactCredentials(value: string): string {
  return value
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/((?:token|secret|password|api[_ -]?key)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/([?&](?:access_?token|api_?key|token|secret|password)=)[^\s&]+/gi, "$1[REDACTED]");
}
