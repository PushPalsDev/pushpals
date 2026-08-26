import { createHash } from "crypto";
import { realpathSync, statSync } from "fs";
import { resolve } from "path";
import { runBoundedProcess } from "./bounded_process.js";
import {
  resolveRepositoryIdentity,
  type RepositoryIdentity,
  type RepositoryIdentityGitResult,
} from "./repository_identity.js";
import type { RepositoryAgentRepositoryRef } from "./repository_agent.js";

const DEFAULT_GIT_TIMEOUT_MS = 5_000;
const DEFAULT_DIFF_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const SMALL_GIT_OUTPUT_LIMIT_BYTES = 256 * 1024;
const MAX_HASH_PATHS_PER_INVOCATION = 128;
const MAX_HASH_PATH_ARGUMENT_BYTES = 16 * 1024;
const OUTPUT_TRUNCATION_MARKER = "[pushpals: process output truncated]";

export type RepositorySnapshot = RepositoryAgentRepositoryRef;

export interface RepositorySnapshotGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  drainTimedOut: boolean;
}

export type RepositorySnapshotGitRunner = (
  repoRoot: string,
  args: string[],
  options: { timeoutMs: number; outputLimitBytes: number },
) => Promise<RepositorySnapshotGitResult>;

export interface ResolveRepositorySnapshotOptions {
  /** Hard deadline for each direct Git invocation. */
  timeoutMs?: number;
  /** Per-stream bound for dirty-state diffs and untracked path enumeration. */
  diffOutputLimitBytes?: number;
  /** Test/host adapter. It must execute Git directly without a shell. */
  runGit?: RepositorySnapshotGitRunner;
  /** Test/host adapter for stable repository identity resolution. */
  resolveIdentity?: (
    repoRoot: string,
    options: {
      timeoutMs: number;
      runGit: (
        repoRoot: string,
        args: string[],
        timeoutMs: number,
      ) => Promise<RepositoryIdentityGitResult>;
    },
  ) => Promise<RepositoryIdentity>;
}

export type RepositorySnapshotErrorCode =
  | "invalid_root"
  | "git_failed"
  | "git_timeout"
  | "git_output_truncated"
  | "invalid_git_output"
  | "repository_changed";

export class RepositorySnapshotError extends Error {
  readonly code: RepositorySnapshotErrorCode;
  readonly gitArgs: readonly string[];
  readonly exitCode: number | null;

  constructor(
    code: RepositorySnapshotErrorCode,
    message: string,
    options: { gitArgs?: string[]; exitCode?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RepositorySnapshotError";
    this.code = code;
    this.gitArgs = Object.freeze([...(options.gitArgs ?? [])]);
    this.exitCode = options.exitCode ?? null;
  }
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function canonicalDirectory(pathValue: string, label: string): string {
  const absolute = resolve(pathValue);
  try {
    if (!statSync(absolute).isDirectory()) {
      throw new RepositorySnapshotError("invalid_root", `${label} is not a directory: ${absolute}`);
    }
    return realpathSync.native(absolute);
  } catch (error) {
    if (error instanceof RepositorySnapshotError) throw error;
    throw new RepositorySnapshotError("invalid_root", `${label} is unavailable: ${absolute}`, {
      cause: error,
    });
  }
}

async function defaultRunGit(
  repoRoot: string,
  args: string[],
  options: { timeoutMs: number; outputLimitBytes: number },
): Promise<RepositorySnapshotGitResult> {
  const result = await runBoundedProcess(["git", "-C", repoRoot, ...args], {
    timeoutMs: options.timeoutMs,
    outputLimitBytes: options.outputLimitBytes,
    streamDrainTimeoutMs: 1_000,
    retainOutputTail: true,
    preserveOutputWhitespace: true,
  });
  return result;
}

function compactErrorOutput(value: string): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "no diagnostic output";
  return text.length <= 1_000 ? text : `${text.slice(0, 986)}...[truncated]`;
}

function hasTruncationMarker(result: RepositorySnapshotGitResult): boolean {
  return (
    result.stdout.includes(OUTPUT_TRUNCATION_MARKER) ||
    result.stderr.includes(OUTPUT_TRUNCATION_MARKER)
  );
}

function assertGitResult(
  args: string[],
  result: RepositorySnapshotGitResult,
): RepositorySnapshotGitResult {
  if (result.timedOut) {
    throw new RepositorySnapshotError(
      "git_timeout",
      `Git command timed out while resolving repository snapshot: git ${args.join(" ")}`,
      { gitArgs: args, exitCode: result.exitCode },
    );
  }
  if (result.drainTimedOut) {
    throw new RepositorySnapshotError(
      "git_failed",
      `Git command streams did not drain while resolving repository snapshot: git ${args.join(" ")}`,
      { gitArgs: args, exitCode: result.exitCode },
    );
  }
  if (hasTruncationMarker(result)) {
    throw new RepositorySnapshotError(
      "git_output_truncated",
      `Git output exceeded the configured snapshot bound: git ${args.join(" ")}`,
      { gitArgs: args, exitCode: result.exitCode },
    );
  }
  if (result.exitCode !== 0) {
    throw new RepositorySnapshotError(
      "git_failed",
      `Git command failed while resolving repository snapshot: git ${args.join(" ")} (${compactErrorOutput(result.stderr)})`,
      { gitArgs: args, exitCode: result.exitCode },
    );
  }
  return result;
}

function parseObjectId(value: string, label: string): string {
  const oid = value.trim().split(/\r?\n/, 1)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{40,64}$/.test(oid)) {
    throw new RepositorySnapshotError(
      "invalid_git_output",
      `Git returned an invalid ${label} object ID`,
    );
  }
  return oid;
}

function updateHashPart(hash: ReturnType<typeof createHash>, label: string, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hash.update(`${label}\0${bytes.byteLength}\0`, "utf8");
  hash.update(bytes);
  hash.update("\0", "utf8");
}

function dirtyTreeFingerprint(input: {
  revision: string;
  status: string;
  stagedDiff: string;
  unstagedDiff: string;
  untrackedFiles: string;
}): string {
  const hash = createHash("sha256");
  hash.update("pushpals-repository-snapshot-v2\0", "utf8");
  updateHashPart(hash, "HEAD", input.revision);
  updateHashPart(hash, "status", input.status);
  updateHashPart(hash, "staged", input.stagedDiff);
  updateHashPart(hash, "unstaged", input.unstagedDiff);
  updateHashPart(hash, "untracked", input.untrackedFiles);
  return `dirty:sha256:${hash.digest("hex")}`;
}

const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"] as const;
const DIFF_ARGS = [
  "diff",
  "--binary",
  "--full-index",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
] as const;
const UNTRACKED_FILES_ARGS = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "--full-name",
  "-z",
] as const;

type SnapshotGitRun = (
  root: string,
  args: readonly string[],
  outputLimitBytes: number,
) => Promise<RepositorySnapshotGitResult>;

function parseNullTerminatedPaths(value: string, args: readonly string[]): string[] {
  if (!value) return [];
  if (!value.endsWith("\0")) {
    throw new RepositorySnapshotError(
      "invalid_git_output",
      `Git returned an unterminated path list while resolving repository snapshot: git ${args.join(" ")}`,
      { gitArgs: [...args] },
    );
  }
  const paths = value.slice(0, -1).split("\0");
  if (paths.some((path) => path.length === 0)) {
    throw new RepositorySnapshotError(
      "invalid_git_output",
      `Git returned an invalid empty path while resolving repository snapshot: git ${args.join(" ")}`,
      { gitArgs: [...args] },
    );
  }
  return paths;
}

function pathArgumentChunks(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path, "utf8") + 1;
    if (
      chunk.length > 0 &&
      (chunk.length >= MAX_HASH_PATHS_PER_INVOCATION ||
        chunkBytes + pathBytes > MAX_HASH_PATH_ARGUMENT_BYTES)
    ) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(path);
    chunkBytes += pathBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function parseObjectIdList(
  value: string,
  expectedCount: number,
  args: readonly string[],
): string[] {
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const objectIds = lines.map((line) => line.toLowerCase());
  if (
    objectIds.length !== expectedCount ||
    objectIds.some((objectId) => !/^[0-9a-f]{40,64}$/.test(objectId))
  ) {
    throw new RepositorySnapshotError(
      "invalid_git_output",
      `Git returned an invalid untracked-file object ID list: git ${args.join(" ")}`,
      { gitArgs: [...args] },
    );
  }
  return objectIds;
}

async function captureUntrackedFiles(
  root: string,
  run: SnapshotGitRun,
  outputLimitBytes: number,
): Promise<string> {
  const listResult = await run(root, UNTRACKED_FILES_ARGS, outputLimitBytes);
  const paths = parseNullTerminatedPaths(listResult.stdout, UNTRACKED_FILES_ARGS);
  const hash = createHash("sha256");
  hash.update("pushpals-repository-untracked-files-v1\0", "utf8");
  const objectIdsByPath = new Map<string, string>();

  // Git reports a nested repository/worktree boundary as a directory entry
  // ending in `/`. It is not a file in this repository and `hash-object`
  // cannot open it. Record the boundary itself; ordinary untracked directories
  // are expanded to their files by `ls-files --others`.
  const filePaths = paths.filter((path) => !path.endsWith("/"));
  for (const pathChunk of pathArgumentChunks(filePaths)) {
    const args = ["hash-object", "--no-filters", "--", ...pathChunk];
    const result = await run(root, args, SMALL_GIT_OUTPUT_LIMIT_BYTES);
    const objectIds = parseObjectIdList(result.stdout, pathChunk.length, args);
    for (let index = 0; index < pathChunk.length; index += 1) {
      objectIdsByPath.set(pathChunk[index]!, objectIds[index]!);
    }
  }

  for (const path of paths) {
    updateHashPart(hash, "path", path);
    updateHashPart(hash, "blob", objectIdsByPath.get(path) ?? "nested-repository-directory");
  }

  return `sha256:${hash.digest("hex")}`;
}

async function captureDirtyState(
  root: string,
  run: SnapshotGitRun,
  outputLimitBytes: number,
): Promise<{ stagedDiff: string; unstagedDiff: string; untrackedFiles: string }> {
  const [stagedResult, unstagedResult, untrackedFiles] = await Promise.all([
    run(root, [...DIFF_ARGS.slice(0, 1), "--cached", ...DIFF_ARGS.slice(1)], outputLimitBytes),
    run(root, DIFF_ARGS, outputLimitBytes),
    captureUntrackedFiles(root, run, outputLimitBytes),
  ]);
  return {
    stagedDiff: stagedResult.stdout,
    unstagedDiff: unstagedResult.stdout,
    untrackedFiles,
  };
}

function dirtyStatesEqual(
  left: { stagedDiff: string; unstagedDiff: string; untrackedFiles: string },
  right: { stagedDiff: string; unstagedDiff: string; untrackedFiles: string },
): boolean {
  return (
    left.stagedDiff === right.stagedDiff &&
    left.unstagedDiff === right.unstagedDiff &&
    left.untrackedFiles === right.untrackedFiles
  );
}

/**
 * Resolve a stable, exact repository snapshot suitable for RepositoryAgent calls.
 *
 * Clean repositories use Git's authoritative `HEAD^{tree}` object ID. Dirty
 * repositories use a domain-separated SHA-256 digest of HEAD, porcelain status,
 * staged binary diff, unstaged binary diff, and the raw-content blob IDs of
 * untracked files. No shell is involved, and an error, timeout,
 * inherited-stream stall, output truncation, or concurrent content change
 * fails closed.
 */
export async function resolveRepositorySnapshot(
  repoRoot: string,
  options: ResolveRepositorySnapshotOptions = {},
): Promise<RepositorySnapshot> {
  const requestedRoot = canonicalDirectory(repoRoot, "Repository root");
  const timeoutMs = normalizePositiveInt(options.timeoutMs, DEFAULT_GIT_TIMEOUT_MS, 100, 30_000);
  const diffOutputLimitBytes = normalizePositiveInt(
    options.diffOutputLimitBytes,
    DEFAULT_DIFF_OUTPUT_LIMIT_BYTES,
    64 * 1024,
    MAX_DIFF_OUTPUT_LIMIT_BYTES,
  );
  const runGit = options.runGit ?? defaultRunGit;
  const run = async (root: string, args: readonly string[], outputLimitBytes: number) => {
    try {
      return assertGitResult(
        [...args],
        await runGit(root, [...args], { timeoutMs, outputLimitBytes }),
      );
    } catch (error) {
      if (error instanceof RepositorySnapshotError) throw error;
      throw new RepositorySnapshotError(
        "git_failed",
        `Git command could not start while resolving repository snapshot: git ${args.join(" ")}`,
        { gitArgs: [...args], cause: error },
      );
    }
  };

  const topLevelResult = await run(
    requestedRoot,
    ["rev-parse", "--show-toplevel"],
    SMALL_GIT_OUTPUT_LIMIT_BYTES,
  );
  const topLevelOutput = topLevelResult.stdout.trim().split(/\r?\n/, 1)[0] ?? "";
  if (!topLevelOutput) {
    throw new RepositorySnapshotError(
      "invalid_git_output",
      "Git returned an empty repository top-level path",
    );
  }
  const root = canonicalDirectory(topLevelOutput, "Git repository root");

  const identityResolver = options.resolveIdentity ?? resolveRepositoryIdentity;
  let identity: RepositoryIdentity;
  try {
    identity = await identityResolver(root, {
      timeoutMs,
      runGit: async (identityRoot, args, identityTimeoutMs) => {
        try {
          const result = assertGitResult(
            args,
            await runGit(identityRoot, args, {
              timeoutMs: identityTimeoutMs,
              outputLimitBytes: SMALL_GIT_OUTPUT_LIMIT_BYTES,
            }),
          );
          return { ok: true, stdout: result.stdout };
        } catch {
          return { ok: false, stdout: "" };
        }
      },
    });
  } catch (error) {
    throw new RepositorySnapshotError(
      "git_failed",
      "Cannot resolve stable repository identity for snapshot",
      { cause: error },
    );
  }
  if (!/^repo_[0-9a-f]{64}$/.test(identity.repositoryId)) {
    throw new RepositorySnapshotError(
      "invalid_git_output",
      "Repository identity resolver returned an invalid identity",
    );
  }

  const [revisionResult, cleanTreeResult, statusResult] = await Promise.all([
    run(root, ["rev-parse", "--verify", "HEAD^{commit}"], SMALL_GIT_OUTPUT_LIMIT_BYTES),
    run(root, ["rev-parse", "--verify", "HEAD^{tree}"], SMALL_GIT_OUTPUT_LIMIT_BYTES),
    run(root, STATUS_ARGS, SMALL_GIT_OUTPUT_LIMIT_BYTES),
  ]);
  const revision = parseObjectId(revisionResult.stdout, "HEAD commit");
  const cleanTree = parseObjectId(cleanTreeResult.stdout, "HEAD tree");
  const status = statusResult.stdout;
  if (!status) {
    return {
      identity: identity.repositoryId,
      root,
      revision,
      tree: cleanTree,
      dirty: false,
    };
  }

  const dirtyState = await captureDirtyState(root, run, diffOutputLimitBytes);
  const dirtyStateAfter = await captureDirtyState(root, run, diffOutputLimitBytes);
  const [revisionAfterResult, statusAfter] = await Promise.all([
    run(root, ["rev-parse", "--verify", "HEAD^{commit}"], SMALL_GIT_OUTPUT_LIMIT_BYTES),
    run(root, STATUS_ARGS, SMALL_GIT_OUTPUT_LIMIT_BYTES),
  ]);
  const revisionAfter = parseObjectId(revisionAfterResult.stdout, "HEAD commit");
  if (
    revisionAfter !== revision ||
    statusAfter.stdout !== status ||
    !dirtyStatesEqual(dirtyStateAfter, dirtyState)
  ) {
    throw new RepositorySnapshotError(
      "repository_changed",
      "Repository content changed while its dirty snapshot was being captured; retry from a stable worktree",
      { gitArgs: [...STATUS_ARGS] },
    );
  }

  return {
    identity: identity.repositoryId,
    root,
    revision,
    tree: dirtyTreeFingerprint({
      revision,
      status,
      stagedDiff: dirtyState.stagedDiff,
      unstagedDiff: dirtyState.unstagedDiff,
      untrackedFiles: dirtyState.untrackedFiles,
    }),
    dirty: true,
  };
}
