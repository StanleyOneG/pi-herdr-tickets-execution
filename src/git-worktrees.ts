import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  GitFileFingerprint,
  GitWorktreePort,
  OriginalCheckoutSnapshot,
  TicketWorktreePlan,
  WorktreeIdentity,
} from "./contracts.js";

const executeFile = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 1_000;

export class RealGitWorktreeAdapter implements GitWorktreePort {
  planTicketWorktree(input: {
    originalRoot: string;
    preparationId: string;
    ticketIdentity: string;
  }): TicketWorktreePlan {
    const repositoryName = basename(resolve(input.originalRoot)).replace(/[^A-Za-z0-9._-]+/g, "-") || "repository";
    const identity = createHash("sha256")
      .update(`${resolve(input.originalRoot)}\0${input.preparationId}\0${input.ticketIdentity}`)
      .digest("hex")
      .slice(0, 20);
    const worktreeRoot = join(dirname(resolve(input.originalRoot)), `.${repositoryName}-herdr-worktrees`);
    return {
      path: join(worktreeRoot, identity),
      branch: `herdr/ticket-${identity}`,
    };
  }

  async inspectOriginal(root: string): Promise<OriginalCheckoutSnapshot> {
    const actualRoot = await this.repositoryRoot(root);
    if (actualRoot !== await realpath(resolve(root))) throw new Error("Original checkout root does not match its Git top-level");
    const first = await this.captureOriginalGitState(actualRoot);
    const [changedFiles, untrackedFiles] = await Promise.all([
      fingerprintPaths(actualRoot, first.changedPaths),
      fingerprintPaths(actualRoot, first.untrackedPaths),
    ]);
    const second = await this.captureOriginalGitState(actualRoot);
    const [confirmedChangedFiles, confirmedUntrackedFiles] = await Promise.all([
      fingerprintPaths(actualRoot, second.changedPaths),
      fingerprintPaths(actualRoot, second.untrackedPaths),
    ]);
    if (
      first.head !== second.head || first.branch !== second.branch || !first.status.equals(second.status) ||
      !first.indexDiff.equals(second.indexDiff) || !first.worktreeDiff.equals(second.worktreeDiff) ||
      digestFingerprints(changedFiles) !== digestFingerprints(confirmedChangedFiles) ||
      digestFingerprints(untrackedFiles) !== digestFingerprints(confirmedUntrackedFiles)
    ) throw new Error("Original checkout changed while its baseline was captured");
    return {
      root: actualRoot,
      commonDir: first.commonDir,
      head: first.head,
      branch: first.branch,
      statusDigest: hash(first.status),
      indexDiffDigest: hash(first.indexDiff),
      worktreeDiffDigest: hash(first.worktreeDiff),
      changedFiles,
      untrackedFiles,
    };
  }

  private async captureOriginalGitState(cwd: string): Promise<{
    commonDir: string;
    head: string;
    branch: string;
    status: Buffer;
    indexDiff: Buffer;
    worktreeDiff: Buffer;
    changedPaths: string[];
    untrackedPaths: string[];
  }> {
    const [commonDir, head, branch, status, indexDiff, worktreeDiff, indexPaths, worktreePaths, untrackedOutput] = await Promise.all([
      this.commonDirectory(cwd),
      this.gitText(cwd, ["rev-parse", "HEAD"]),
      this.gitText(cwd, ["branch", "--show-current"]),
      this.gitBuffer(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.gitBuffer(cwd, ["diff", "--binary", "--no-ext-diff", "--cached"]),
      this.gitBuffer(cwd, ["diff", "--binary", "--no-ext-diff"]),
      this.gitBuffer(cwd, ["diff", "--name-only", "-z", "--cached"]),
      this.gitBuffer(cwd, ["diff", "--name-only", "-z"]),
      this.gitBuffer(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    if (!branch) throw new Error("Original checkout must have an attached branch");
    const changedPaths = [...new Set([...splitNul(indexPaths), ...splitNul(worktreePaths)])].sort();
    const untrackedPaths = splitNul(untrackedOutput).sort();
    if (changedPaths.length > MAX_UNTRACKED_FILES || untrackedPaths.length > MAX_UNTRACKED_FILES) {
      throw new Error("Original checkout has too many changed paths to baseline safely");
    }
    return { commonDir, head, branch, status, indexDiff, worktreeDiff, changedPaths, untrackedPaths };
  }

  async createTicketWorktree(input: {
    originalRoot: string;
    baseCommit: string;
    plan: TicketWorktreePlan;
  }): Promise<WorktreeIdentity> {
    const originalRoot = await this.repositoryRoot(input.originalRoot);
    if (!isAbsolute(input.plan.path)) throw new Error("Ticket worktree path must be absolute");
    const worktreeRoot = dirname(input.plan.path);
    await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
    await assertOrdinaryDirectory(worktreeRoot);
    await assertMissing(input.plan.path);
    await this.gitText(originalRoot, [
      "worktree", "add", "-b", input.plan.branch, "--", input.plan.path, input.baseCommit,
    ]);
    const identity = await this.inspectWorktree(input.plan.path);
    if (identity.path !== resolve(input.plan.path) || identity.branch !== input.plan.branch || identity.head !== input.baseCommit) {
      throw new Error("Created ticket worktree identity does not match its plan");
    }
    const records = parseWorktreeList(await this.gitBuffer(originalRoot, ["worktree", "list", "--porcelain", "-z"]));
    const expectedRef = `refs/heads/${input.plan.branch}`;
    const listed = records.find((record): boolean => record.worktree === identity.path);
    if (!listed || listed.HEAD !== input.baseCommit || listed.branch !== expectedRef) {
      throw new Error("Created ticket worktree is missing or mismatched in Git worktree ownership");
    }
    return identity;
  }

  async inspectWorktree(path: string): Promise<WorktreeIdentity> {
    const root = await this.repositoryRoot(path);
    const expected = await realpath(resolve(path));
    if (root !== expected) throw new Error("Ticket worktree path does not match its Git top-level");
    const [commonDir, head, branch] = await Promise.all([
      this.commonDirectory(root),
      this.gitText(root, ["rev-parse", "HEAD"]),
      this.gitText(root, ["branch", "--show-current"]),
    ]);
    if (!branch) throw new Error("Ticket worktree must have an attached branch");
    return { path: root, commonDir, head, branch };
  }

  private async repositoryRoot(cwd: string): Promise<string> {
    return realpath(await this.gitText(cwd, ["rev-parse", "--show-toplevel"]));
  }

  private async commonDirectory(cwd: string): Promise<string> {
    const raw = await this.gitText(cwd, ["rev-parse", "--git-common-dir"]);
    return realpath(isAbsolute(raw) ? raw : resolve(cwd, raw));
  }

  private async gitText(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await executeFile("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return stripFinalLineEnding(stdout);
  }

  private async gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
    const { stdout } = await executeFile("git", args, {
      cwd,
      encoding: "buffer",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return stdout;
  }
}

async function assertOrdinaryDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error("Ticket worktree root is redirected or is not a directory");
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error("Ticket worktree path already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function stripFinalLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function splitNul(value: Buffer): string[] {
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) {
    throw new Error("Git returned a path that cannot be represented safely as UTF-8");
  }
  return text.endsWith("\0")
    ? text.slice(0, -1).split("\0").filter(Boolean)
    : text.split("\0").filter(Boolean);
}

function parseWorktreeList(value: Buffer): Array<Record<string, string>> {
  const fields = splitNul(value);
  const records: Array<Record<string, string>> = [];
  let record: Record<string, string> = {};
  for (const field of fields) {
    if (field === "") continue;
    const separator = field.indexOf(" ");
    const key = separator === -1 ? field : field.slice(0, separator);
    const child = separator === -1 ? "true" : field.slice(separator + 1);
    if (key === "worktree" && Object.keys(record).length > 0) {
      records.push(record);
      record = {};
    }
    record[key] = child;
  }
  if (Object.keys(record).length > 0) records.push(record);
  return records;
}

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fingerprintPaths(root: string, paths: string[]): Promise<GitFileFingerprint[]> {
  return Promise.all(paths.map(async (path): Promise<GitFileFingerprint> => ({
    path,
    contentDigest: await hashPath(join(root, path)),
  })));
}

function digestFingerprints(files: GitFileFingerprint[]): string {
  return hash(JSON.stringify(files));
}

async function hashPath(path: string): Promise<string> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return hash("missing");
    throw error;
  }
  if (metadata.isSymbolicLink()) return hash(`symlink\0${await readlink(path)}`);
  if (!metadata.isFile()) return hash(`non-file\0${metadata.mode}`);
  const digest = createHash("sha256");
  await new Promise<void>((resolvePromise, reject): void => {
    const stream = createReadStream(path);
    stream.on("data", (chunk): void => { digest.update(chunk); });
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return digest.digest("hex");
}
