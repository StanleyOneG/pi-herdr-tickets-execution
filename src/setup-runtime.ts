import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { SetupOperation, SetupRuntimePort } from "./contracts.js";

const execFileAsync = promisify(execFile);

/** Executes only the constrained setup operation that was frozen in an approved proposal. */
export class LocalSetupRuntime implements SetupRuntimePort {
  async execute(input: { cwd: string; operation: SetupOperation }): Promise<{ outcomeDigest: string }> {
    if (!isAbsolute(input.cwd)) throw new Error("Setup worktree must be absolute");
    if (input.operation.kind === "database-setup") throw new Error("Database setup is not executable in this slice");
    if (input.operation.kind === "environment-template") {
      const source = inside(input.cwd, input.operation.source);
      const destination = inside(input.cwd, input.operation.destination);
      if (!/(?:\.example|\.sample|\.template)$/i.test(input.operation.source)) throw new Error("Environment source is not a public template");
      const sourceMetadata = await lstat(source);
      if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) throw new Error("Environment template source must be a regular file");
      const actualRoot = await realpath(input.cwd);
      if (await realpath(source) !== source || !isInside(actualRoot, source) || !isInside(actualRoot, await realpath(dirname(destination)))) {
        throw new Error("Environment template paths traverse a redirected directory");
      }
      await copyFile(source, destination, 1);
      const destinationMetadata = await lstat(destination);
      return { outcomeDigest: digest(`${input.operation.kind}\0${input.operation.source}\0${input.operation.destination}\0${destinationMetadata.size}`) };
    }
    const [command, args] = dependencyCommand(input.operation);
    const result = await execFileAsync(command, args, {
      cwd: input.cwd,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 15 * 60_000,
    });
    return { outcomeDigest: digest(`${command}\0${args.join("\0")}\0${result.stdout}\0${result.stderr}`) };
  }
}

function dependencyCommand(operation: Extract<SetupOperation, { kind: "dependency-install" }>): [string, string[]] {
  switch (operation.packageManager) {
    case "npm": return ["npm", operation.mode === "frozen" ? ["ci"] : ["install"]];
    case "pnpm": return ["pnpm", operation.mode === "frozen" ? ["install", "--frozen-lockfile"] : ["install"]];
    case "yarn": return ["yarn", operation.mode === "frozen" ? ["install", "--immutable"] : ["install"]];
    case "bun": return ["bun", operation.mode === "frozen" ? ["install", "--frozen-lockfile"] : ["install"]];
  }
}

function inside(root: string, path: string): string {
  if (isAbsolute(path) || path.includes("\0")) throw new Error("Setup path must be relative");
  const target = resolve(root, path);
  const offset = relative(root, target);
  if (!offset || offset.startsWith("..") || isAbsolute(offset)) throw new Error("Setup path must stay inside its worktree");
  return join(root, offset);
}

function isInside(root: string, target: string): boolean {
  const offset = relative(root, target);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
