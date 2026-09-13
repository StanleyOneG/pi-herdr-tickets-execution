import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readlink, realpath, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  CandidateGitState,
  GitFileFingerprint,
  GitWorktreePort,
  IntegrationWorktreeIdentity,
  OriginalCheckoutSnapshot,
  StagedIntegrationCandidate,
  TicketWorktreePlan,
  WorktreeIdentity,
} from "./contracts.js";

const executeFile = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 1_000;
const MAX_CODE_STATE_FILES = 100_000;

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
    await ensureOrdinaryDirectoryPath(worktreeRoot);
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

  async isCommitAncestor(path: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await executeFile("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
        cwd: path,
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return false;
      throw error;
    }
  }

  async captureCandidate(input: { path: string; sourceBase: string }): Promise<CandidateGitState> {
    const root = await this.repositoryRoot(input.path);
    const capture = async (): Promise<Omit<CandidateGitState, "candidateDigest">> => {
      const [head, branch, status, indexDiff, worktreeDiff, untrackedOutput, codePathsOutput] = await Promise.all([
        this.gitText(root, ["rev-parse", "HEAD"]),
        this.gitText(root, ["branch", "--show-current"]),
        this.gitBuffer(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        this.gitBuffer(root, ["diff", "--binary", "--no-ext-diff", "--cached"]),
        this.gitBuffer(root, ["diff", "--binary", "--no-ext-diff"]),
        this.gitBuffer(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
        this.gitBuffer(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
      ]);
      if (!branch || !await this.isCommitAncestor(root, input.sourceBase, head)) {
        throw new Error("Candidate does not descend from its source base");
      }
      const untrackedPaths = splitNul(untrackedOutput).sort();
      const codePaths = [...new Set(splitNul(codePathsOutput))].sort();
      if (untrackedPaths.length > MAX_UNTRACKED_FILES || codePaths.length > MAX_CODE_STATE_FILES) {
        throw new Error("Candidate has too many paths to fingerprint safely");
      }
      const [untrackedFiles, codeFiles] = await Promise.all([
        fingerprintPaths(root, untrackedPaths),
        fingerprintExistingPaths(root, codePaths),
      ]);
      return {
        sourceBase: input.sourceBase,
        head,
        branch,
        statusDigest: hash(status),
        indexDiffDigest: hash(indexDiff),
        worktreeDiffDigest: hash(worktreeDiff),
        untrackedFiles,
        codeStateDigest: digestFingerprints(codeFiles),
      };
    };
    const first = await capture();
    const second = await capture();
    if (hash(JSON.stringify(first)) !== hash(JSON.stringify(second))) {
      throw new Error("Candidate changed while its Git state was captured");
    }
    return { ...first, candidateDigest: hash(JSON.stringify(first)) };
  }

  async prepareIntegrationWorktree(input: {
    originalRoot: string;
    preparationId: string;
    targetBase: string;
  }): Promise<IntegrationWorktreeIdentity> {
    const originalRoot = await this.repositoryRoot(input.originalRoot);
    const repositoryName = basename(originalRoot).replace(/[^A-Za-z0-9._-]+/g, "-") || "repository";
    const identity = hash(`${originalRoot}\0${input.preparationId}`).slice(0, 20);
    const path = join(dirname(originalRoot), `.${repositoryName}-herdr-worktrees`, `batch-${identity}`);
    const branch = `herdr/batch-${identity}`;
    try {
      const existing = await this.inspectWorktree(path);
      if (existing.branch !== branch || !await this.isCommitAncestor(path, input.targetBase, existing.head)) {
        throw new Error("Existing batch integration worktree is mismatched");
      }
      return { ...existing, preparationId: input.preparationId };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try { await stat(path); } catch (pathError) {
          if ((pathError as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    await ensureOrdinaryDirectoryPath(dirname(path));
    await assertMissing(path);
    await this.gitText(originalRoot, ["worktree", "add", "-b", branch, "--", path, input.targetBase]);
    const created = await this.inspectWorktree(path);
    if (created.head !== input.targetBase || created.branch !== branch) throw new Error("Batch integration worktree is mismatched");
    return { ...created, preparationId: input.preparationId };
  }

  async stageCandidate(input: {
    originalRoot: string;
    preparationId: string;
    attemptId: string;
    receiptId: string;
    integration: IntegrationWorktreeIdentity;
    sourcePath: string;
    candidate: CandidateGitState;
  }): Promise<StagedIntegrationCandidate> {
    const currentCandidate = await this.captureCandidate({ path: input.sourcePath, sourceBase: input.candidate.sourceBase });
    if (currentCandidate.candidateDigest !== input.candidate.candidateDigest) throw new Error("Candidate changed after evidence capture");
    const currentIntegration = await this.inspectWorktree(input.integration.path);
    if (currentIntegration.head !== input.integration.head || currentIntegration.branch !== input.integration.branch) {
      throw new Error("Accepted batch base moved before staging");
    }
    const stageIdentity = hash(`${input.preparationId}\0${input.attemptId}\0${input.receiptId}\0${input.candidate.candidateDigest}`).slice(0, 20);
    const path = join(dirname(input.integration.path), `stage-${stageIdentity}`);
    const branch = `herdr/stage-${stageIdentity}`;
    await assertMissing(path);
    await this.gitText(input.originalRoot, ["worktree", "add", "-b", branch, "--", path, input.integration.head]);
    const commits = (await this.gitText(input.sourcePath, ["rev-list", "--reverse", `${input.candidate.sourceBase}..${input.candidate.head}`]))
      .split("\n").filter(Boolean);
    for (const commit of commits) {
      await this.gitText(path, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "cherry-pick", commit]);
    }
    await this.applyCandidatePatch(input.sourcePath, path, ["diff", "--binary", "--no-ext-diff", "--cached"]);
    await this.applyCandidatePatch(input.sourcePath, path, ["diff", "--binary", "--no-ext-diff"]);
    for (const file of input.candidate.untrackedFiles) await copyCandidatePath(input.sourcePath, path, file.path);
    await this.gitText(path, ["add", "-A"]);
    const hasStaged = (await this.gitBuffer(path, ["diff", "--cached", "--quiet"]).catch((error): Buffer => {
      if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return Buffer.from("changed");
      throw error;
    })).length > 0;
    if (hasStaged) {
      await this.gitText(path, [
        "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
        "-c", "user.name=Pi Herdr Controller", "-c", "user.email=pi-herdr@localhost",
        "commit", "-m", `Integrate candidate ${input.attemptId}`,
      ]);
    }
    const candidateCommit = await this.gitText(path, ["rev-parse", "HEAD"]);
    if (candidateCommit === input.integration.head) throw new Error("Candidate contains no changes to integrate");
    return { path, branch, baseCommit: input.integration.head, candidateCommit };
  }

  async advanceIntegration(input: {
    integration: IntegrationWorktreeIdentity;
    staging: StagedIntegrationCandidate;
  }): Promise<string> {
    const current = await this.inspectWorktree(input.integration.path);
    if (current.head !== input.staging.baseCommit || current.branch !== input.integration.branch) {
      throw new Error("Accepted batch base moved before integration advance");
    }
    await this.gitText(input.integration.path, [
      "-c", "core.hooksPath=/dev/null", "merge", "--ff-only", input.staging.candidateCommit,
    ]);
    return this.gitText(input.integration.path, ["rev-parse", "HEAD"]);
  }

  private async applyCandidatePatch(sourcePath: string, destinationPath: string, args: string[]): Promise<void> {
    const patch = await this.gitBuffer(sourcePath, args);
    if (patch.length === 0) return;
    const patchPath = join(destinationPath, `.herdr-${hash(patch).slice(0, 12)}.patch`);
    await writeFile(patchPath, patch, { mode: 0o600 });
    try {
      await this.gitText(destinationPath, ["apply", "--binary", "--", patchPath]);
    } finally {
      await unlink(patchPath).catch((): void => {});
    }
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

async function copyCandidatePath(sourceRoot: string, destinationRoot: string, relativePath: string): Promise<void> {
  const source = join(sourceRoot, relativePath);
  const destination = join(destinationRoot, relativePath);
  const metadata = await lstat(source);
  await ensureDestinationDirectory(destinationRoot, dirname(destination));
  try {
    await lstat(destination);
    throw new Error(`Candidate untracked path collides with accepted content: ${relativePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (metadata.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return;
  }
  if (!metadata.isFile()) throw new Error("Candidate untracked path is not a regular file or symbolic link");
  await copyFile(source, destination);
}

async function ensureDestinationDirectory(destinationRoot: string, directory: string): Promise<void> {
  const root = resolve(destinationRoot);
  const target = resolve(directory);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Candidate destination escapes its staging worktree");
  await assertOrdinaryDirectory(root);
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error(`Candidate destination has a symbolic link ancestor: ${current}`);
      if (!metadata.isDirectory()) throw new Error(`Candidate destination ancestor is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error(`Candidate destination has an unsafe ancestor: ${current}`);
      }
    }
  }
}

async function ensureOrdinaryDirectoryPath(directory: string): Promise<void> {
  const target = resolve(directory);
  const root = parse(target).root;
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error(`Worktree path has a symbolic link ancestor: ${current}`);
      if (!metadata.isDirectory()) throw new Error(`Worktree path ancestor is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function fingerprintPaths(root: string, paths: string[]): Promise<GitFileFingerprint[]> {
  return Promise.all(paths.map(async (path): Promise<GitFileFingerprint> => ({
    path,
    contentDigest: await hashPath(join(root, path)),
  })));
}

async function fingerprintExistingPaths(root: string, paths: string[]): Promise<GitFileFingerprint[]> {
  const files = await Promise.all(paths.map(async (path): Promise<GitFileFingerprint | undefined> => {
    try {
      await lstat(join(root, path));
      return { path, contentDigest: await hashPath(join(root, path)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }));
  return files.filter((file): file is GitFileFingerprint => file !== undefined);
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
  digest.update(`file\0${metadata.mode & 0o111}\0`);
  await new Promise<void>((resolvePromise, reject): void => {
    const stream = createReadStream(path);
    stream.on("data", (chunk): void => { digest.update(chunk); });
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return digest.digest("hex");
}
