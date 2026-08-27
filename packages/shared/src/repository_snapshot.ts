import { createHash } from "crypto";
import { constants as fsConstants, type BigIntStats, type Dirent } from "fs";
import {
  lstat as lstatPath,
  open as openPath,
  readdir as readdirPath,
  readlink as readlinkPath,
  realpath as realpathPath,
  type FileHandle,
} from "fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { runBoundedProcess } from "./bounded_process.js";
import {
  resolveRepositoryIdentity,
  type RepositoryIdentity,
  type RepositoryIdentityGitResult,
} from "./repository_identity.js";
import type { RepositoryAgentRepositoryRef } from "./repository_agent.js";

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 30_000;
const DEFAULT_DIFF_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const SMALL_GIT_OUTPUT_LIMIT_BYTES = 256 * 1024;
const MAX_BOUNDARY_PATHSPEC_BYTES = 16 * 1024;
const MAX_UNTRACKED_DIRECTORY_SCAN_ENTRIES = 20_000;
const MAX_NESTED_GIT_MARKER_ENTRIES = 2_048;
const FILE_READ_BUFFER_BYTES = 64 * 1024;
const GIT_ABORT_DRAIN_TIMEOUT_MS = 12_500;

export type RepositorySnapshot = RepositoryAgentRepositoryRef;

export interface RepositorySnapshotGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutDecodeError: boolean;
  stderrDecodeError: boolean;
  timedOut: boolean;
  drainTimedOut: boolean;
}

export type RepositorySnapshotGitRunner = (
  repoRoot: string,
  args: string[],
  options: {
    timeoutMs: number;
    outputLimitBytes: number;
    signal?: AbortSignal;
    stdin?: Buffer;
  },
) => Promise<RepositorySnapshotGitResult>;

export interface RepositorySnapshotFileHandle {
  stat(options: { bigint: true }): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
  close(): Promise<void>;
}

export interface RepositorySnapshotFileSystem {
  lstat(path: string): Promise<BigIntStats>;
  readdir(path: string): Promise<Dirent[]>;
  readlink(path: string): Promise<Buffer>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: number): Promise<RepositorySnapshotFileHandle>;
}

export interface ResolveRepositorySnapshotOptions {
  /** Overall deadline shared by Git and filesystem snapshot inspection. */
  timeoutMs?: number;
  /** Per-stream bound for dirty-state diffs and untracked path enumeration. */
  diffOutputLimitBytes?: number;
  /** Test/host adapter. It must execute Git directly without a shell. */
  runGit?: RepositorySnapshotGitRunner;
  /** Cancels Git and filesystem inspection at the next bounded operation. */
  signal?: AbortSignal;
  /** Test/host adapter for no-shell filesystem inspection. */
  fileSystem?: RepositorySnapshotFileSystem;
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
  | "snapshot_timeout"
  | "snapshot_aborted"
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

type SnapshotDeadline = { deadlineAtMs: number; signal?: AbortSignal };

const defaultFileSystem: RepositorySnapshotFileSystem = {
  async lstat(path) {
    return await lstatPath(path, { bigint: true });
  },
  async readdir(path) {
    return await readdirPath(path, { withFileTypes: true });
  },
  async readlink(path) {
    return (await readlinkPath(path, { encoding: "buffer" })) as Buffer;
  },
  async realpath(path) {
    return await realpathPath(path);
  },
  async open(path, flags) {
    return (await openPath(path, flags)) as FileHandle;
  },
};

function snapshotDeadlineError(
  deadline: SnapshotDeadline,
  operation: string,
): RepositorySnapshotError {
  if (deadline.signal?.aborted) {
    return new RepositorySnapshotError(
      "snapshot_aborted",
      `Repository snapshot was aborted during ${operation}`,
      { cause: deadline.signal.reason },
    );
  }
  return new RepositorySnapshotError(
    "snapshot_timeout",
    `Repository snapshot exceeded its overall deadline during ${operation}`,
  );
}

function remainingSnapshotMs(deadline: SnapshotDeadline, operation: string): number {
  if (deadline.signal?.aborted || Date.now() >= deadline.deadlineAtMs) {
    throw snapshotDeadlineError(deadline, operation);
  }
  return Math.max(1, deadline.deadlineAtMs - Date.now());
}

async function withinSnapshotDeadline<T>(
  deadline: SnapshotDeadline,
  operation: string,
  start: () => Promise<T>,
  options: { drainOnStopMs?: number } = {},
): Promise<T> {
  const remainingMs = remainingSnapshotMs(deadline, operation);
  const promise = start();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let removeAbortListener: () => void = () => undefined;
  let stoppedTriggered = false;
  const stopped = new Promise<never>((_resolve, reject) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      stoppedTriggered = true;
      reject(snapshotDeadlineError(deadline, operation));
    };
    timer = setTimeout(stop, remainingMs);
    const onAbort = () => stop();
    deadline.signal?.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => deadline.signal?.removeEventListener("abort", onAbort);
    // Abort may have happened synchronously inside `start()` before the
    // listener above was registered.
    if (deadline.signal?.aborted) onAbort();
  });
  try {
    return await Promise.race([promise, stopped]);
  } catch (error) {
    if (stoppedTriggered && options.drainOnStopMs && options.drainOnStopMs > 0) {
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        promise.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolveDrain) => {
          drainTimer = setTimeout(resolveDrain, options.drainOnStopMs);
        }),
      ]);
      if (drainTimer) clearTimeout(drainTimer);
    } else if (stoppedTriggered) {
      // Explicitly observe a late rejection from operations that cannot be
      // safely awaited (for example, an injected filesystem promise).
      void promise.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener();
  }
}

type RepositoryDirectoryAnchor = {
  label: string;
  sourcePath: string;
  canonicalPath: string;
  sourceStats: BigIntStats;
  sourceLinkTarget: Buffer | null;
  targetStats: BigIntStats;
};

type RepositoryDirectoryObservation = Omit<RepositoryDirectoryAnchor, "label">;

function directorySourceStatsEqual(left: BigIntStats, right: BigIntStats): boolean {
  const sameKind =
    (left.isDirectory() && right.isDirectory()) ||
    (left.isSymbolicLink() && right.isSymbolicLink());
  return sameKind && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function directoryTargetStatsEqual(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

function directoryObservationsEqual(
  left: RepositoryDirectoryObservation,
  right: RepositoryDirectoryObservation,
): boolean {
  return (
    comparableFileSystemPath(left.canonicalPath) ===
      comparableFileSystemPath(right.canonicalPath) &&
    directorySourceStatsEqual(left.sourceStats, right.sourceStats) &&
    directoryTargetStatsEqual(left.targetStats, right.targetStats) &&
    ((left.sourceLinkTarget === null && right.sourceLinkTarget === null) ||
      (left.sourceLinkTarget !== null &&
        right.sourceLinkTarget !== null &&
        left.sourceLinkTarget.equals(right.sourceLinkTarget)))
  );
}

async function observeDirectoryAnchor(
  sourcePath: string,
  label: string,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<RepositoryDirectoryObservation> {
  const sourceStats = await withinSnapshotDeadline(deadline, `${label} source lstat`, () =>
    fileSystem.lstat(sourcePath),
  );
  if (!sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
    throw new Error(`${label} source is not a directory or directory indirection`);
  }
  const sourceLinkTarget = sourceStats.isSymbolicLink()
    ? await withinSnapshotDeadline(deadline, `${label} source readlink`, () =>
        fileSystem.readlink(sourcePath),
      )
    : null;
  const canonicalPath = await withinSnapshotDeadline(deadline, `${label} realpath`, () =>
    fileSystem.realpath(sourcePath),
  );
  const targetStats = await withinSnapshotDeadline(deadline, `${label} target lstat`, () =>
    fileSystem.lstat(canonicalPath),
  );
  if (!targetStats.isDirectory()) throw new Error(`${label} target is not a directory`);
  return { sourcePath, canonicalPath, sourceStats, sourceLinkTarget, targetStats };
}

async function canonicalDirectoryAnchor(
  pathValue: string,
  label: string,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<RepositoryDirectoryAnchor> {
  const sourcePath = resolve(pathValue);
  try {
    const first = await observeDirectoryAnchor(sourcePath, label, fileSystem, deadline);
    const second = await observeDirectoryAnchor(sourcePath, label, fileSystem, deadline);
    if (!directoryObservationsEqual(first, second)) {
      throw new Error(`${label} changed while its directory identity was being captured`);
    }
    return { label, ...first };
  } catch (error) {
    if (error instanceof RepositorySnapshotError) throw error;
    throw new RepositorySnapshotError("invalid_root", `${label} is unavailable: ${sourcePath}`, {
      cause: error,
    });
  }
}

async function validateDirectoryAnchor(
  anchor: RepositoryDirectoryAnchor,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<void> {
  try {
    const first = await observeDirectoryAnchor(
      anchor.sourcePath,
      `${anchor.label} anchor`,
      fileSystem,
      deadline,
    );
    const second = await observeDirectoryAnchor(
      anchor.sourcePath,
      `${anchor.label} anchor`,
      fileSystem,
      deadline,
    );
    if (!directoryObservationsEqual(first, second) || !directoryObservationsEqual(anchor, first)) {
      throw new Error(`${anchor.label} anchor identity changed`);
    }
  } catch (error) {
    if (
      error instanceof RepositorySnapshotError &&
      (error.code === "snapshot_timeout" || error.code === "snapshot_aborted")
    ) {
      throw error;
    }
    throw new RepositorySnapshotError(
      "repository_changed",
      `${anchor.label} changed while its repository snapshot was being captured`,
      { cause: error },
    );
  }
}

function assertRequestedRootWithinGitRoot(
  requested: RepositoryDirectoryAnchor,
  gitRoot: RepositoryDirectoryAnchor,
): void {
  const relativePath = relative(gitRoot.canonicalPath, requested.canonicalPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new RepositorySnapshotError(
      "invalid_root",
      "Requested repository path is outside the Git repository root",
    );
  }
}

async function validateRepositoryAnchors(
  requested: RepositoryDirectoryAnchor,
  gitRoot: RepositoryDirectoryAnchor,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<void> {
  await validateDirectoryAnchor(requested, fileSystem, deadline);
  await validateDirectoryAnchor(gitRoot, fileSystem, deadline);
  assertRequestedRootWithinGitRoot(requested, gitRoot);
}

async function defaultRunGit(
  repoRoot: string,
  args: string[],
  options: {
    timeoutMs: number;
    outputLimitBytes: number;
    signal?: AbortSignal;
    stdin?: Buffer;
  },
): Promise<RepositorySnapshotGitResult> {
  const result = await runBoundedProcess(["git", "-C", repoRoot, ...args], {
    timeoutMs: options.timeoutMs,
    outputLimitBytes: options.outputLimitBytes,
    streamDrainTimeoutMs: 1_000,
    retainOutputTail: true,
    preserveOutputWhitespace: true,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.stdin ? { stdin: new Blob([new Uint8Array(options.stdin)]) } : {}),
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

function assertGitResult(
  args: string[],
  result: RepositorySnapshotGitResult,
  acceptedExitCodes: readonly number[] = [0],
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
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new RepositorySnapshotError(
      "git_output_truncated",
      `Git output exceeded the configured snapshot bound: git ${args.join(" ")}`,
      { gitArgs: args, exitCode: result.exitCode },
    );
  }
  if (!acceptedExitCodes.includes(result.exitCode)) {
    throw new RepositorySnapshotError(
      "git_failed",
      `Git command failed while resolving repository snapshot: git ${args.join(" ")} (${compactErrorOutput(result.stderr)})`,
      { gitArgs: args, exitCode: result.exitCode },
    );
  }
  if (result.stdoutDecodeError || result.stderrDecodeError) {
    throw new RepositorySnapshotError(
      "invalid_git_output",
      `Git returned invalid UTF-8 while resolving repository snapshot: git ${args.join(" ")}`,
      { gitArgs: args, exitCode: result.exitCode },
    );
  }
  return result;
}

function parseObjectId(value: string, label: string, expectedWidth?: 40 | 64): string {
  const oid = value.trim().split(/\r?\n/, 1)[0]?.toLowerCase() ?? "";
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) ||
    (expectedWidth && oid.length !== expectedWidth)
  ) {
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

function updateHashBytes(hash: ReturnType<typeof createHash>, label: string, value: Buffer): void {
  hash.update(`${label}\0${value.byteLength}\0`, "utf8");
  hash.update(value);
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
  hash.update("pushpals-repository-snapshot-v3\0", "utf8");
  updateHashPart(hash, "HEAD", input.revision);
  updateHashPart(hash, "status", input.status);
  updateHashPart(hash, "staged", input.stagedDiff);
  updateHashPart(hash, "unstaged", input.unstagedDiff);
  updateHashPart(hash, "untracked", input.untrackedFiles);
  return `dirty:sha256:${hash.digest("hex")}`;
}

const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=no"] as const;
const DIFF_ARGS = [
  "diff",
  "--binary",
  "--full-index",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
] as const;
const TRACKED_FILES_ARGS = ["ls-files", "--cached", "--stage", "--full-name", "-z"] as const;
const UNTRACKED_DIRECTORIES_ARGS = [
  "ls-files",
  "--others",
  "--directory",
  "--exclude-standard",
  "--full-name",
  "-z",
] as const;
const UNTRACKED_FILES_ARGS = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "--full-name",
  "-z",
] as const;
const CHECK_IGNORE_ARGS = ["check-ignore", "--no-index", "--stdin", "-z"] as const;

type SnapshotGitRun = (
  root: string,
  args: readonly string[],
  outputLimitBytes: number,
  options?: { acceptedExitCodes?: readonly number[]; stdin?: Buffer },
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

type TrackedIndexEntry = { path: string; identity: string };

function parseTrackedIndexEntries(value: string, expectedWidth: 40 | 64): TrackedIndexEntry[] {
  const records = parseNullTerminatedPaths(value, TRACKED_FILES_ARGS);
  return records.map((record) => {
    const match = record.match(
      /^([0-7]{6}) ((?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})) ([0-3])\t([\s\S]+)$/,
    );
    if (!match || match[2]!.length !== expectedWidth) {
      throw new RepositorySnapshotError(
        "invalid_git_output",
        "Git returned an invalid tracked index entry",
        { gitArgs: [...TRACKED_FILES_ARGS] },
      );
    }
    return {
      path: match[4]!,
      identity: `${match[1]} ${match[2]!.toLowerCase()} ${match[3]}`,
    };
  });
}

type LexicalRepositoryPath = {
  path: string;
  absolutePath: string;
  segments: string[];
};

function lexicalRepositoryPath(
  root: string,
  repositoryPath: string,
  args: readonly string[],
): LexicalRepositoryPath {
  const absolute = resolve(root, repositoryPath);
  const relativePath = relative(root, absolute);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new RepositorySnapshotError(
      "invalid_git_output",
      `Git returned a path outside the repository: ${repositoryPath}`,
      { gitArgs: [...args] },
    );
  }
  const segments = relativePath.split(sep);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RepositorySnapshotError(
      "invalid_git_output",
      `Git returned an invalid repository path: ${repositoryPath}`,
      { gitArgs: [...args] },
    );
  }
  return {
    path: segments.join("/"),
    absolutePath: absolute,
    segments,
  };
}

function stableStatsEqual(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

function untrackedGitMode(stats: BigIntStats): "100644" | "100755" {
  if (process.platform === "win32") return "100644";
  return (stats.mode & 0o111n) !== 0n ? "100755" : "100644";
}

function repositoryChanged(path: string, cause?: unknown): RepositorySnapshotError {
  return new RepositorySnapshotError(
    "repository_changed",
    `Repository path changed while resolving its dirty snapshot: ${path}`,
    { gitArgs: [...UNTRACKED_FILES_ARGS], cause },
  );
}

function isUnavailablePathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

type DirectoryPrefix = {
  kind: "directory";
  path: string;
  absolutePath: string;
  stats: BigIntStats;
};

type IndirectionBoundary = {
  kind: "indirection";
  path: string;
  absolutePath: string;
  stats: BigIntStats;
  target: Buffer;
  identity: string;
};

type UnavailablePrefix = {
  kind: "unavailable";
  path: string;
  absolutePath: string;
  stats: BigIntStats | null;
};

type PrefixInspection = DirectoryPrefix | IndirectionBoundary | UnavailablePrefix;

function indirectionIdentity(path: string, target: Buffer): string {
  const hash = createHash("sha256");
  hash.update("pushpals-repository-indirection-v2\0", "utf8");
  updateHashPart(hash, "path", path);
  updateHashBytes(hash, "target", target);
  return `indirection:sha256:${hash.digest("hex")}`;
}

class RepositoryPathInspector {
  private readonly prefixes = new Map<string, Promise<PrefixInspection>>();

  constructor(
    private readonly root: string,
    private readonly fileSystem: RepositorySnapshotFileSystem,
    private readonly deadline: SnapshotDeadline,
  ) {}

  private async inspectPrefix(
    path: string,
    absolutePath: string,
    allowUnavailable: boolean,
    knownStats?: BigIntStats,
  ): Promise<PrefixInspection> {
    const existing = this.prefixes.get(path);
    if (existing) return await existing;
    const pending = (async () => {
      let stats: BigIntStats;
      try {
        stats =
          knownStats ??
          (await withinSnapshotDeadline(this.deadline, `lstat ${path}`, () =>
            this.fileSystem.lstat(absolutePath),
          ));
      } catch (error) {
        if (error instanceof RepositorySnapshotError) throw error;
        if (allowUnavailable && isUnavailablePathError(error)) {
          return { kind: "unavailable" as const, path, absolutePath, stats: null };
        }
        throw repositoryChanged(path, error);
      }
      if (stats.isSymbolicLink()) {
        let target: Buffer;
        let verified: BigIntStats;
        try {
          target = await withinSnapshotDeadline(this.deadline, `readlink ${path}`, () =>
            this.fileSystem.readlink(absolutePath),
          );
          verified = await withinSnapshotDeadline(
            this.deadline,
            `revalidate indirection ${path}`,
            () => this.fileSystem.lstat(absolutePath),
          );
        } catch (error) {
          if (error instanceof RepositorySnapshotError) throw error;
          throw repositoryChanged(path, error);
        }
        if (!verified.isSymbolicLink() || !stableStatsEqual(stats, verified)) {
          throw repositoryChanged(path);
        }
        return {
          kind: "indirection" as const,
          path,
          absolutePath,
          stats,
          target,
          identity: indirectionIdentity(path, target),
        };
      }
      if (!stats.isDirectory()) {
        if (allowUnavailable) {
          return { kind: "unavailable" as const, path, absolutePath, stats };
        }
        throw repositoryChanged(path);
      }
      return { kind: "directory" as const, path, absolutePath, stats };
    })();
    this.prefixes.set(path, pending);
    return await pending;
  }

  async inspectAncestors(
    lexical: LexicalRepositoryPath,
    options: { allowUnavailable?: boolean } = {},
  ): Promise<IndirectionBoundary | null> {
    let absolutePath = this.root;
    const traversed: string[] = [];
    for (const segment of lexical.segments.slice(0, -1)) {
      remainingSnapshotMs(this.deadline, `inspect path ${lexical.path}`);
      traversed.push(segment);
      absolutePath = join(absolutePath, segment);
      const prefix = await this.inspectPrefix(
        traversed.join("/"),
        absolutePath,
        options.allowUnavailable === true,
      );
      if (prefix.kind === "indirection") return prefix;
      if (prefix.kind === "unavailable") {
        if (options.allowUnavailable) return null;
        throw repositoryChanged(prefix.path);
      }
    }
    return null;
  }

  async inspectUntracked(
    lexical: LexicalRepositoryPath,
  ): Promise<
    | { kind: "file"; lexical: LexicalRepositoryPath; stats: BigIntStats }
    | { kind: "directory"; lexical: LexicalRepositoryPath }
    | { kind: "special"; lexical: LexicalRepositoryPath; stats: BigIntStats }
    | IndirectionBoundary
  > {
    const ancestor = await this.inspectAncestors(lexical);
    if (ancestor) return ancestor;
    let stats: BigIntStats;
    try {
      stats = await withinSnapshotDeadline(this.deadline, `lstat ${lexical.path}`, () =>
        this.fileSystem.lstat(lexical.absolutePath),
      );
    } catch (error) {
      if (error instanceof RepositorySnapshotError) throw error;
      throw repositoryChanged(lexical.path, error);
    }
    if (stats.isSymbolicLink()) {
      const boundary = await this.inspectPrefix(lexical.path, lexical.absolutePath, false, stats);
      if (boundary.kind !== "indirection") throw repositoryChanged(lexical.path);
      return boundary;
    }
    if (stats.isDirectory()) {
      await this.inspectPrefix(lexical.path, lexical.absolutePath, false, stats);
      return { kind: "directory", lexical };
    }
    if (stats.isFile()) return { kind: "file", lexical, stats };
    return { kind: "special", lexical, stats };
  }

  async inspectDirectoryCandidate(
    lexical: LexicalRepositoryPath,
  ): Promise<IndirectionBoundary | { kind: "directory"; lexical: LexicalRepositoryPath } | null> {
    const inspected = await this.inspectUntracked(lexical);
    if (inspected.kind === "indirection") return inspected;
    if (inspected.kind === "directory") return inspected;
    return null;
  }

  async validatePrefixes(): Promise<void> {
    for (const pending of this.prefixes.values()) {
      remainingSnapshotMs(this.deadline, "validate repository path prefixes");
      const prefix = await pending;
      if (prefix.kind === "unavailable") {
        try {
          const stats = await withinSnapshotDeadline(
            this.deadline,
            `revalidate unavailable path ${prefix.path}`,
            () => this.fileSystem.lstat(prefix.absolutePath),
          );
          if (prefix.stats === null || !stableStatsEqual(prefix.stats, stats)) {
            throw repositoryChanged(prefix.path);
          }
        } catch (error) {
          if (error instanceof RepositorySnapshotError) throw error;
          if (prefix.stats === null && isUnavailablePathError(error)) continue;
          throw repositoryChanged(prefix.path, error);
        }
        continue;
      }
      let stats: BigIntStats;
      try {
        stats = await withinSnapshotDeadline(this.deadline, `revalidate ${prefix.path}`, () =>
          this.fileSystem.lstat(prefix.absolutePath),
        );
      } catch (error) {
        if (error instanceof RepositorySnapshotError) throw error;
        throw repositoryChanged(prefix.path, error);
      }
      if (!stableStatsEqual(prefix.stats, stats)) throw repositoryChanged(prefix.path);
      if (prefix.kind === "directory") {
        if (!stats.isDirectory()) throw repositoryChanged(prefix.path);
        continue;
      }
      if (!stats.isSymbolicLink()) throw repositoryChanged(prefix.path);
      let target: Buffer;
      try {
        target = await withinSnapshotDeadline(
          this.deadline,
          `revalidate readlink ${prefix.path}`,
          () => this.fileSystem.readlink(prefix.absolutePath),
        );
      } catch (error) {
        if (error instanceof RepositorySnapshotError) throw error;
        throw repositoryChanged(prefix.path, error);
      }
      if (!target.equals(prefix.target)) throw repositoryChanged(prefix.path);
    }
  }
}

function pathInputChunks(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const path of paths) {
    const bytes = Buffer.byteLength(path, "utf8") + 1;
    if (bytes > MAX_BOUNDARY_PATHSPEC_BYTES) {
      throw new RepositorySnapshotError(
        "git_output_truncated",
        `Repository path exceeds the bounded Git input size: ${path}`,
      );
    }
    if (current.length > 0 && currentBytes + bytes > MAX_BOUNDARY_PATHSPEC_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(path);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function checkIgnoredPaths(
  root: string,
  paths: readonly string[],
  run: SnapshotGitRun,
  outputLimitBytes: number,
  deadline: SnapshotDeadline,
): Promise<Set<string>> {
  const ignored = new Set<string>();
  for (const chunk of pathInputChunks(paths)) {
    remainingSnapshotMs(deadline, "check ignored untracked paths");
    const stdin = Buffer.from(`${chunk.join("\0")}\0`, "utf8");
    const result = await run(root, CHECK_IGNORE_ARGS, outputLimitBytes, {
      acceptedExitCodes: [0, 1],
      stdin,
    });
    if (result.exitCode === 1) {
      if (result.stdout) {
        throw new RepositorySnapshotError(
          "invalid_git_output",
          "Git returned ignored paths with a no-match exit code",
          { gitArgs: [...CHECK_IGNORE_ARGS] },
        );
      }
      continue;
    }
    const expected = new Set(chunk);
    for (const repositoryPath of parseNullTerminatedPaths(result.stdout, CHECK_IGNORE_ARGS)) {
      const normalized = lexicalRepositoryPath(root, repositoryPath, CHECK_IGNORE_ARGS).path;
      if (!expected.has(normalized)) {
        throw new RepositorySnapshotError(
          "invalid_git_output",
          `Git returned an unexpected ignored path: ${repositoryPath}`,
          { gitArgs: [...CHECK_IGNORE_ARGS] },
        );
      }
      ignored.add(normalized);
    }
  }
  return ignored;
}

type NestedRepositoryMarkerAnchor = {
  path: string;
  absolutePath: string;
  identity: string;
  directory: LexicalRepositoryPath;
  markerName: string;
};

type ValidatedNestedRepositoryAnchor = NestedRepositoryMarkerAnchor & {
  head: string;
};

function stableStatsToken(stats: BigIntStats): string {
  const kind = stats.isDirectory()
    ? "directory"
    : stats.isFile()
      ? "file"
      : stats.isSymbolicLink()
        ? "symlink"
        : "special";
  return [kind, stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].join(
    ":",
  );
}

async function captureNestedRepositoryMarker(
  root: string,
  directory: LexicalRepositoryPath,
  markerName: string,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<NestedRepositoryMarkerAnchor | null> {
  const marker = lexicalRepositoryPath(root, `${directory.path}/${markerName}`, [
    "nested-repository-marker",
  ]);
  let stats: BigIntStats;
  try {
    stats = await withinSnapshotDeadline(deadline, `lstat ${marker.path}`, () =>
      fileSystem.lstat(marker.absolutePath),
    );
  } catch (error) {
    if (error instanceof RepositorySnapshotError) throw error;
    throw repositoryChanged(marker.path, error);
  }
  if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) return null;

  const hash = createHash("sha256");
  hash.update("pushpals-nested-repository-marker-v1\0", "utf8");
  updateHashPart(hash, "path", marker.path);
  updateHashPart(hash, "marker", stableStatsToken(stats));
  if (stats.isFile()) {
    const content = await hashUntrackedFile(root, marker, stats, "sha256", fileSystem, deadline);
    updateHashPart(hash, "gitfile", content);
    return {
      path: marker.path,
      absolutePath: marker.absolutePath,
      identity: `git-marker:sha256:${hash.digest("hex")}`,
      directory,
      markerName,
    };
  }

  let children: Dirent[];
  try {
    children = await withinSnapshotDeadline(deadline, `readdir ${marker.path}`, () =>
      fileSystem.readdir(marker.absolutePath),
    );
  } catch (error) {
    if (error instanceof RepositorySnapshotError) throw error;
    throw repositoryChanged(marker.path, error);
  }
  if (children.length > MAX_NESTED_GIT_MARKER_ENTRIES) {
    throw new RepositorySnapshotError(
      "git_output_truncated",
      `Nested repository marker inspection exceeded ${MAX_NESTED_GIT_MARKER_ENTRIES} entries`,
    );
  }
  const sortedChildren = children
    .map((child) => ({ child, sortKey: Buffer.from(child.name, "utf8") }))
    .sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));
  const childStats: Array<{ path: string; absolutePath: string; stats: BigIntStats }> = [];
  for (const { child } of sortedChildren) {
    remainingSnapshotMs(deadline, `inspect ${marker.path}`);
    if (
      !child.name ||
      child.name === "." ||
      child.name === ".." ||
      child.name.includes("/") ||
      (process.platform === "win32" && child.name.includes("\\"))
    ) {
      throw repositoryChanged(marker.path);
    }
    const childPath = `${marker.path}/${child.name}`;
    const absolutePath = join(marker.absolutePath, child.name);
    let observed: BigIntStats;
    try {
      observed = await withinSnapshotDeadline(deadline, `lstat ${childPath}`, () =>
        fileSystem.lstat(absolutePath),
      );
    } catch (error) {
      if (error instanceof RepositorySnapshotError) throw error;
      throw repositoryChanged(childPath, error);
    }
    updateHashPart(hash, "child-name", child.name);
    updateHashPart(hash, "child-state", stableStatsToken(observed));
    childStats.push({ path: childPath, absolutePath, stats: observed });
  }
  let verifiedMarker: BigIntStats;
  try {
    verifiedMarker = await withinSnapshotDeadline(deadline, `revalidate ${marker.path}`, () =>
      fileSystem.lstat(marker.absolutePath),
    );
  } catch (error) {
    if (error instanceof RepositorySnapshotError) throw error;
    throw repositoryChanged(marker.path, error);
  }
  if (!verifiedMarker.isDirectory() || !stableStatsEqual(stats, verifiedMarker)) {
    throw repositoryChanged(marker.path);
  }
  for (const child of childStats) {
    let verified: BigIntStats;
    try {
      verified = await withinSnapshotDeadline(deadline, `revalidate ${child.path}`, () =>
        fileSystem.lstat(child.absolutePath),
      );
    } catch (error) {
      if (error instanceof RepositorySnapshotError) throw error;
      throw repositoryChanged(child.path, error);
    }
    if (!stableStatsEqual(child.stats, verified)) throw repositoryChanged(child.path);
  }
  return {
    path: marker.path,
    absolutePath: marker.absolutePath,
    identity: `git-marker:sha256:${hash.digest("hex")}`,
    directory,
    markerName,
  };
}

async function validateNestedRepositoryMarker(
  root: string,
  expected: NestedRepositoryMarkerAnchor,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<void> {
  const current = await captureNestedRepositoryMarker(
    root,
    expected.directory,
    expected.markerName,
    fileSystem,
    deadline,
  );
  if (!current || current.identity !== expected.identity) {
    throw repositoryChanged(expected.path);
  }
}

async function isValidatedNestedRepository(
  root: string,
  directory: LexicalRepositoryPath,
  children: readonly Dirent[],
  run: SnapshotGitRun,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<ValidatedNestedRepositoryAnchor | null> {
  const marker = children.find((child) =>
    process.platform === "win32" ? child.name.toLowerCase() === ".git" : child.name === ".git",
  );
  if (!marker || marker.isSymbolicLink()) return null;
  let ordinaryMarker = marker.isDirectory() || marker.isFile();
  if (!ordinaryMarker) {
    try {
      const stats = await withinSnapshotDeadline(deadline, `lstat ${directory.path}/.git`, () =>
        fileSystem.lstat(join(directory.absolutePath, marker.name)),
      );
      ordinaryMarker = !stats.isSymbolicLink() && (stats.isDirectory() || stats.isFile());
    } catch (error) {
      if (error instanceof RepositorySnapshotError) throw error;
      throw repositoryChanged(`${directory.path}/.git`, error);
    }
  }
  if (!ordinaryMarker) return null;
  const markerBefore = await captureNestedRepositoryMarker(
    root,
    directory,
    marker.name,
    fileSystem,
    deadline,
  );
  if (!markerBefore) return null;
  const args = ["-C", directory.absolutePath, "rev-parse", "--show-toplevel"];
  const result = await run(root, args, SMALL_GIT_OUTPUT_LIMIT_BYTES, {
    acceptedExitCodes: [0, 128],
  });
  await validateNestedRepositoryMarker(root, markerBefore, fileSystem, deadline);
  if (result.exitCode !== 0) return null;
  const reported = result.stdout.trim().split(/\r?\n/, 1)[0] ?? "";
  if (!reported) {
    throw new RepositorySnapshotError(
      "invalid_git_output",
      "Git returned an empty nested repository top-level path",
      { gitArgs: args },
    );
  }
  let canonicalReported: string;
  let canonicalDirectoryPath: string;
  try {
    [canonicalReported, canonicalDirectoryPath] = await Promise.all([
      withinSnapshotDeadline(deadline, `realpath nested root ${directory.path}`, () =>
        fileSystem.realpath(reported),
      ),
      withinSnapshotDeadline(deadline, `realpath nested directory ${directory.path}`, () =>
        fileSystem.realpath(directory.absolutePath),
      ),
    ]);
  } catch (error) {
    if (error instanceof RepositorySnapshotError) throw error;
    throw repositoryChanged(directory.path, error);
  }
  if (
    comparableFileSystemPath(canonicalReported) !== comparableFileSystemPath(canonicalDirectoryPath)
  ) {
    return null;
  }
  const headArgs = ["-C", directory.absolutePath, "rev-parse", "--verify", "HEAD^{commit}"];
  const headResult = await run(root, headArgs, SMALL_GIT_OUTPUT_LIMIT_BYTES, {
    acceptedExitCodes: [0, 128],
  });
  await validateNestedRepositoryMarker(root, markerBefore, fileSystem, deadline);
  if (headResult.exitCode !== 0) return null;
  return {
    ...markerBefore,
    head: parseObjectId(headResult.stdout, "nested HEAD commit"),
  };
}

async function validateNestedRepositoryAnchor(
  root: string,
  expected: ValidatedNestedRepositoryAnchor,
  run: SnapshotGitRun,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<void> {
  await validateNestedRepositoryMarker(root, expected, fileSystem, deadline);
  const headArgs = [
    "-C",
    expected.directory.absolutePath,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ];
  const headResult = await run(root, headArgs, SMALL_GIT_OUTPUT_LIMIT_BYTES);
  await validateNestedRepositoryMarker(root, expected, fileSystem, deadline);
  const head = parseObjectId(
    headResult.stdout,
    "nested HEAD commit",
    expected.head.length as 40 | 64,
  );
  if (head !== expected.head) throw repositoryChanged(expected.directory.path);
}

async function discoverNestedIndirectionCandidates(
  root: string,
  directoryRoots: readonly LexicalRepositoryPath[],
  run: SnapshotGitRun,
  outputLimitBytes: number,
  inspector: RepositoryPathInspector,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<{
  boundaries: Map<string, IndirectionBoundary>;
  nestedRepositoryMarkers: ValidatedNestedRepositoryAnchor[];
}> {
  const candidates = new Map<string, IndirectionBoundary>();
  const nestedRepositoryMarkers: ValidatedNestedRepositoryAnchor[] = [];
  let currentLevel = [...directoryRoots];
  const visited = new Set<string>();
  let inspectedEntries = 0;
  while (currentLevel.length > 0) {
    const levelCandidates: LexicalRepositoryPath[] = [];
    for (const directory of currentLevel) {
      remainingSnapshotMs(deadline, "scan untracked directory boundaries");
      if (visited.has(directory.path)) continue;
      visited.add(directory.path);
      let children: Dirent[];
      try {
        children = await withinSnapshotDeadline(deadline, `readdir ${directory.path}`, () =>
          fileSystem.readdir(directory.absolutePath),
        );
      } catch (error) {
        if (error instanceof RepositorySnapshotError) throw error;
        throw repositoryChanged(directory.path, error);
      }
      inspectedEntries += children.length;
      if (inspectedEntries > MAX_UNTRACKED_DIRECTORY_SCAN_ENTRIES) {
        throw new RepositorySnapshotError(
          "git_output_truncated",
          `Untracked directory inspection exceeded ${MAX_UNTRACKED_DIRECTORY_SCAN_ENTRIES} entries`,
        );
      }
      const nestedRepositoryMarker = await isValidatedNestedRepository(
        root,
        directory,
        children,
        run,
        fileSystem,
        deadline,
      );
      if (nestedRepositoryMarker) {
        nestedRepositoryMarkers.push(nestedRepositoryMarker);
        continue;
      }
      const sortedChildren = children
        .map((child) => ({ child, sortKey: Buffer.from(child.name, "utf8") }))
        .sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));
      remainingSnapshotMs(deadline, `sort entries below ${directory.path}`);
      for (const { child } of sortedChildren) {
        remainingSnapshotMs(deadline, "inspect nested untracked boundary");
        if (
          !child.name ||
          child.name === "." ||
          child.name === ".." ||
          child.name.includes("/") ||
          (process.platform === "win32" && child.name.includes("\\"))
        ) {
          throw repositoryChanged(directory.path);
        }
        const knownNonDirectory =
          child.isFile() ||
          child.isBlockDevice() ||
          child.isCharacterDevice() ||
          child.isFIFO() ||
          child.isSocket();
        if (knownNonDirectory) continue;
        levelCandidates.push(
          lexicalRepositoryPath(
            root,
            `${directory.path}/${child.name}`,
            UNTRACKED_DIRECTORIES_ARGS,
          ),
        );
      }
    }
    const ignored = await checkIgnoredPaths(
      root,
      levelCandidates.map((candidate) => candidate.path),
      run,
      outputLimitBytes,
      deadline,
    );
    const nextLevel: LexicalRepositoryPath[] = [];
    for (const lexical of levelCandidates) {
      remainingSnapshotMs(deadline, "classify nested untracked boundary");
      if (ignored.has(lexical.path)) continue;
      const inspected = await inspector.inspectDirectoryCandidate(lexical);
      if (!inspected) continue;
      if (inspected.kind === "indirection") candidates.set(inspected.path, inspected);
      else nextLevel.push(inspected.lexical);
    }
    currentLevel = nextLevel;
  }
  return { boundaries: candidates, nestedRepositoryMarkers };
}

function comparableFileSystemPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function assertOpenedFileIsLexical(
  root: string,
  lexical: LexicalRepositoryPath,
  expected: BigIntStats,
  handleStats: BigIntStats,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<BigIntStats> {
  let canonical: string;
  let current: BigIntStats;
  try {
    [canonical, current] = await Promise.all([
      withinSnapshotDeadline(deadline, `realpath ${lexical.path}`, () =>
        fileSystem.realpath(lexical.absolutePath),
      ),
      withinSnapshotDeadline(deadline, `revalidate file ${lexical.path}`, () =>
        fileSystem.lstat(lexical.absolutePath),
      ),
    ]);
  } catch (error) {
    if (error instanceof RepositorySnapshotError) throw error;
    throw repositoryChanged(lexical.path, error);
  }
  const canonicalRelative = relative(root, canonical);
  if (
    !canonicalRelative ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelative) ||
    comparableFileSystemPath(canonical) !== comparableFileSystemPath(lexical.absolutePath) ||
    !stableStatsEqual(expected, current) ||
    !sameFileIdentity(expected, current) ||
    !sameFileIdentity(current, handleStats)
  ) {
    throw repositoryChanged(lexical.path);
  }
  return current;
}

async function openSnapshotFile(
  lexical: LexicalRepositoryPath,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<RepositorySnapshotFileHandle> {
  const noFollow = Number((fsConstants as unknown as Record<string, unknown>).O_NOFOLLOW ?? 0);
  remainingSnapshotMs(deadline, `open ${lexical.path}`);
  const pending = fileSystem.open(lexical.absolutePath, fsConstants.O_RDONLY | noFollow);
  try {
    return await withinSnapshotDeadline(deadline, `open ${lexical.path}`, () => pending);
  } catch (error) {
    void pending.then(
      async (handle) => await handle.close(),
      () => undefined,
    );
    if (error instanceof RepositorySnapshotError) throw error;
    throw repositoryChanged(lexical.path, error);
  }
}

async function hashUntrackedFile(
  root: string,
  lexical: LexicalRepositoryPath,
  expected: BigIntStats,
  objectHashAlgorithm: "sha1" | "sha256",
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<string> {
  const handle = await openSnapshotFile(lexical, fileSystem, deadline);
  try {
    let before: BigIntStats;
    try {
      before = await withinSnapshotDeadline(deadline, `fstat ${lexical.path}`, () =>
        handle.stat({ bigint: true }),
      );
    } catch (error) {
      if (error instanceof RepositorySnapshotError) throw error;
      throw repositoryChanged(lexical.path, error);
    }
    await assertOpenedFileIsLexical(root, lexical, expected, before, fileSystem, deadline);

    const hash = createHash(objectHashAlgorithm);
    hash.update(`blob ${before.size.toString()}\0`, "utf8");
    const buffer = Buffer.allocUnsafe(FILE_READ_BUFFER_BYTES);
    let bytesReadTotal = 0n;
    while (true) {
      let bytesRead: number;
      try {
        ({ bytesRead } = await withinSnapshotDeadline(deadline, `read ${lexical.path}`, () =>
          handle.read(buffer, 0, buffer.length, null),
        ));
      } catch (error) {
        if (error instanceof RepositorySnapshotError) throw error;
        throw repositoryChanged(lexical.path, error);
      }
      if (bytesRead === 0) break;
      bytesReadTotal += BigInt(bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
    }
    let after: BigIntStats;
    try {
      after = await withinSnapshotDeadline(deadline, `post-read fstat ${lexical.path}`, () =>
        handle.stat({ bigint: true }),
      );
    } catch (error) {
      if (error instanceof RepositorySnapshotError) throw error;
      throw repositoryChanged(lexical.path, error);
    }
    if (bytesReadTotal !== before.size || !stableStatsEqual(before, after)) {
      throw repositoryChanged(lexical.path);
    }
    await assertOpenedFileIsLexical(root, lexical, expected, after, fileSystem, deadline);
    return hash.digest("hex");
  } finally {
    const closing = handle.close();
    try {
      await withinSnapshotDeadline(deadline, `close ${lexical.path}`, () => closing);
    } catch {
      void closing.catch(() => undefined);
    }
  }
}

function boundaryPathspecArgs(boundaryPaths: readonly string[]): string[] {
  if (boundaryPaths.length === 0) return [];
  const sorted = [...boundaryPaths].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  const bytes = sorted.reduce((total, path) => total + Buffer.byteLength(path, "utf8") + 32, 0);
  if (bytes > MAX_BOUNDARY_PATHSPEC_BYTES) {
    throw new RepositorySnapshotError(
      "git_output_truncated",
      "Repository indirection exclusions exceed the bounded Git pathspec size",
    );
  }
  return ["--", ".", ...sorted.map((path) => `:(top,exclude,literal)${path}`)];
}

function worktreeEntriesFingerprint(entries: Map<string, string>): string {
  if (entries.size === 0) return "";
  const hash = createHash("sha256");
  hash.update("pushpals-repository-worktree-entries-v3\0", "utf8");
  const sorted = [...entries].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  for (const [path, identity] of sorted) {
    updateHashPart(hash, "path", path);
    updateHashPart(hash, "identity", identity);
  }
  return `sha256:${hash.digest("hex")}`;
}

function boundaryIndexIdentity(entries: readonly TrackedIndexEntry[]): string {
  const hash = createHash("sha256");
  hash.update("pushpals-repository-boundary-index-v1\0", "utf8");
  const sorted = [...entries].sort((left, right) => {
    const pathOrder = Buffer.compare(
      Buffer.from(left.path, "utf8"),
      Buffer.from(right.path, "utf8"),
    );
    return pathOrder || left.identity.localeCompare(right.identity);
  });
  for (const entry of sorted) {
    updateHashPart(hash, "path", entry.path);
    updateHashPart(hash, "index", entry.identity);
  }
  return `index:sha256:${hash.digest("hex")}`;
}

function nestedRepositoryMarkerFingerprint(
  markers: readonly ValidatedNestedRepositoryAnchor[],
): string {
  if (markers.length === 0) return "";
  const hash = createHash("sha256");
  hash.update("pushpals-nested-repository-markers-v2\0", "utf8");
  const sorted = [...markers].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
  for (const marker of sorted) {
    updateHashPart(hash, "path", marker.path);
    updateHashPart(hash, "identity", marker.identity);
    updateHashPart(hash, "head", marker.head);
  }
  return `sha256:${hash.digest("hex")}`;
}

type CapturedDirtyState = {
  status: string;
  stagedDiff: string;
  unstagedDiff: string;
  untrackedFiles: string;
  classificationState: string;
};

async function captureDirtyState(
  root: string,
  run: SnapshotGitRun,
  outputLimitBytes: number,
  objectHashAlgorithm: "sha1" | "sha256",
  objectIdWidth: 40 | 64,
  fileSystem: RepositorySnapshotFileSystem,
  deadline: SnapshotDeadline,
): Promise<CapturedDirtyState> {
  const inspector = new RepositoryPathInspector(root, fileSystem, deadline);
  const boundaries = new Map<string, IndirectionBoundary>();
  const trackedBoundaries = new Map<string, IndirectionBoundary>();
  const trackedEntriesByBoundary = new Map<string, TrackedIndexEntry[]>();
  const entries = new Map<string, string>();
  const untrackedDirectoryRoots: LexicalRepositoryPath[] = [];
  const trackedResult = await run(root, TRACKED_FILES_ARGS, outputLimitBytes);
  const trackedEntries = parseTrackedIndexEntries(trackedResult.stdout, objectIdWidth);

  // Only parent indirections are excluded here. A tracked symlink at the leaf
  // is ordinary Git state; Git diffs its link text without following its target.
  for (const trackedEntry of trackedEntries) {
    remainingSnapshotMs(deadline, "inspect tracked path boundaries");
    const lexical = lexicalRepositoryPath(root, trackedEntry.path, TRACKED_FILES_ARGS);
    const boundary = await inspector.inspectAncestors(lexical, { allowUnavailable: true });
    if (!boundary) continue;
    boundaries.set(boundary.path, boundary);
    trackedBoundaries.set(boundary.path, boundary);
    const entriesForBoundary = trackedEntriesByBoundary.get(boundary.path) ?? [];
    entriesForBoundary.push({ path: lexical.path, identity: trackedEntry.identity });
    trackedEntriesByBoundary.set(boundary.path, entriesForBoundary);
  }

  // Tracked boundaries must be excluded before any worktree-namespace Git
  // probe runs; otherwise Git can enumerate a junction target while merely
  // trying to discover untracked or ignored paths.
  const trackedExclusions = boundaryPathspecArgs([...trackedBoundaries.keys()]);
  const untrackedDirectoriesArgs = [...UNTRACKED_DIRECTORIES_ARGS, ...trackedExclusions];
  const untrackedDirectoriesResult = await run(root, untrackedDirectoriesArgs, outputLimitBytes);
  const untrackedDirectories = parseNullTerminatedPaths(
    untrackedDirectoriesResult.stdout,
    untrackedDirectoriesArgs,
  );

  // `--directory` exposes a Windows junction even when its target is empty and
  // gives us the lexical boundary before the full untracked listing exposes
  // any target descendants. Ordinary directories are scanned without following
  // indirections so nested empty junctions are also represented.
  for (const repositoryPath of untrackedDirectories) {
    remainingSnapshotMs(deadline, "inspect untracked directory boundaries");
    const lexical = lexicalRepositoryPath(root, repositoryPath, untrackedDirectoriesArgs);
    const inspected = await inspector.inspectDirectoryCandidate(lexical);
    if (inspected?.kind === "indirection") boundaries.set(inspected.path, inspected);
    else if (inspected?.kind === "directory") untrackedDirectoryRoots.push(inspected.lexical);
  }

  const nestedCandidates = await discoverNestedIndirectionCandidates(
    root,
    untrackedDirectoryRoots,
    run,
    outputLimitBytes,
    inspector,
    fileSystem,
    deadline,
  );
  for (const boundary of nestedCandidates.boundaries.values()) {
    boundaries.set(boundary.path, boundary);
  }

  // Do not ask Git to enumerate descendants behind an indirection or a
  // validated nested repository. The nested root remains excluded even if its
  // marker is concurrently removed; marker/HEAD revalidation below then fails
  // closed without exposing that transient namespace.
  const opaqueNestedRepositoryPaths = nestedCandidates.nestedRepositoryMarkers.map(
    (marker) => marker.directory.path,
  );
  const untrackedArgs = [
    ...UNTRACKED_FILES_ARGS,
    ...boundaryPathspecArgs([...boundaries.keys(), ...opaqueNestedRepositoryPaths]),
  ];
  const untrackedResult = await run(root, untrackedArgs, outputLimitBytes);
  const untrackedPaths = parseNullTerminatedPaths(untrackedResult.stdout, untrackedArgs);

  for (const repositoryPath of untrackedPaths) {
    remainingSnapshotMs(deadline, "inspect untracked files");
    const lexical = lexicalRepositoryPath(root, repositoryPath, untrackedArgs);
    const inspected = await inspector.inspectUntracked(lexical);
    if (inspected.kind === "indirection") {
      boundaries.set(inspected.path, inspected);
      continue;
    }
    if (inspected.kind === "directory") {
      entries.set(inspected.lexical.path, "nested-repository-directory");
      continue;
    }
    if (inspected.kind === "special") {
      entries.set(inspected.lexical.path, `special-file-mode:${inspected.stats.mode.toString(8)}`);
      continue;
    }
    const blob = await hashUntrackedFile(
      root,
      inspected.lexical,
      inspected.stats,
      objectHashAlgorithm,
      fileSystem,
      deadline,
    );
    entries.set(inspected.lexical.path, `${untrackedGitMode(inspected.stats)}:${blob}`);
  }
  for (const boundary of boundaries.values()) {
    const trackedUnderBoundary = trackedEntriesByBoundary.get(boundary.path) ?? [];
    entries.set(
      boundary.path,
      trackedUnderBoundary.length > 0
        ? `${boundary.identity}:${boundaryIndexIdentity(trackedUnderBoundary)}`
        : boundary.identity,
    );
  }
  for (const marker of nestedCandidates.nestedRepositoryMarkers) {
    entries.set(marker.directory.path, `nested-repository:${marker.identity}:head:${marker.head}`);
  }

  const exclusions = trackedExclusions;
  const stagedArgs = [...DIFF_ARGS.slice(0, 1), "--cached", ...DIFF_ARGS.slice(1), ...exclusions];
  const statusArgs = [...STATUS_ARGS, ...exclusions];
  const unstagedArgs = [...DIFF_ARGS, ...exclusions];
  // On Windows, `git status` can briefly refresh the shared index while a
  // concurrent cached diff opens it. Keep that index-owning probe serialized.
  const statusResult = await run(root, statusArgs, outputLimitBytes);
  const stagedResult = await run(root, stagedArgs, outputLimitBytes);
  const unstagedResult = await run(root, unstagedArgs, outputLimitBytes);
  await inspector.validatePrefixes();
  for (const marker of nestedCandidates.nestedRepositoryMarkers) {
    await validateNestedRepositoryAnchor(root, marker, run, fileSystem, deadline);
  }
  return {
    status: statusResult.stdout,
    stagedDiff: stagedResult.stdout,
    unstagedDiff: unstagedResult.stdout,
    untrackedFiles: worktreeEntriesFingerprint(entries),
    classificationState: nestedRepositoryMarkerFingerprint(
      nestedCandidates.nestedRepositoryMarkers,
    ),
  };
}

function dirtyStatesEqual(left: CapturedDirtyState, right: CapturedDirtyState): boolean {
  return (
    left.status === right.status &&
    left.stagedDiff === right.stagedDiff &&
    left.unstagedDiff === right.unstagedDiff &&
    left.untrackedFiles === right.untrackedFiles &&
    left.classificationState === right.classificationState
  );
}

/**
 * Resolve a stable, exact repository snapshot suitable for RepositoryAgent calls.
 *
 * Clean repositories use Git's authoritative `HEAD^{tree}` object ID. Dirty
 * repositories use a domain-separated SHA-256 digest of HEAD, porcelain status,
 * staged binary diff, unstaged binary diff, the raw-content blob IDs of
 * ordinary untracked files, and opaque symlink/junction identities. No shell
 * is involved, and an error, timeout,
 * inherited-stream stall, output truncation, or concurrent content change
 * fails closed.
 */
export async function resolveRepositorySnapshot(
  repoRoot: string,
  options: ResolveRepositorySnapshotOptions = {},
): Promise<RepositorySnapshot> {
  const timeoutMs = normalizePositiveInt(
    options.timeoutMs,
    DEFAULT_SNAPSHOT_TIMEOUT_MS,
    100,
    30_000,
  );
  const deadline: SnapshotDeadline = {
    deadlineAtMs: Date.now() + timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const requestedRootAnchor = await canonicalDirectoryAnchor(
    repoRoot,
    "Repository root",
    fileSystem,
    deadline,
  );
  const requestedRoot = requestedRootAnchor.canonicalPath;
  const diffOutputLimitBytes = normalizePositiveInt(
    options.diffOutputLimitBytes,
    DEFAULT_DIFF_OUTPUT_LIMIT_BYTES,
    64 * 1024,
    MAX_DIFF_OUTPUT_LIMIT_BYTES,
  );
  const runGit = options.runGit ?? defaultRunGit;
  const run: SnapshotGitRun = async (root, args, outputLimitBytes, invocationOptions = {}) => {
    try {
      const invocationTimeoutMs = remainingSnapshotMs(deadline, `git ${args.join(" ")}`);
      return assertGitResult(
        [...args],
        await withinSnapshotDeadline(
          deadline,
          `git ${args.join(" ")}`,
          () =>
            runGit(root, [...args], {
              timeoutMs: invocationTimeoutMs,
              outputLimitBytes,
              ...(deadline.signal ? { signal: deadline.signal } : {}),
              ...(invocationOptions.stdin ? { stdin: invocationOptions.stdin } : {}),
            }),
          { drainOnStopMs: GIT_ABORT_DRAIN_TIMEOUT_MS },
        ),
        invocationOptions.acceptedExitCodes,
      );
    } catch (error) {
      if (error instanceof RepositorySnapshotError) throw error;
      if (deadline.signal?.aborted) {
        throw snapshotDeadlineError(deadline, `git ${args.join(" ")}`);
      }
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
  const gitRootAnchor = await canonicalDirectoryAnchor(
    topLevelOutput,
    "Git repository root",
    fileSystem,
    deadline,
  );
  const root = gitRootAnchor.canonicalPath;
  assertRequestedRootWithinGitRoot(requestedRootAnchor, gitRootAnchor);
  await validateRepositoryAnchors(requestedRootAnchor, gitRootAnchor, fileSystem, deadline);

  const identityResolver = options.resolveIdentity ?? resolveRepositoryIdentity;
  let identity: RepositoryIdentity;
  try {
    identity = await withinSnapshotDeadline(
      deadline,
      "repository identity",
      () =>
        identityResolver(root, {
          timeoutMs: remainingSnapshotMs(deadline, "repository identity"),
          runGit: async (identityRoot, args, identityTimeoutMs) => {
            try {
              const result = assertGitResult(
                args,
                await withinSnapshotDeadline(
                  deadline,
                  `identity git ${args.join(" ")}`,
                  () =>
                    runGit(identityRoot, args, {
                      timeoutMs: Math.min(
                        identityTimeoutMs,
                        remainingSnapshotMs(deadline, `identity git ${args.join(" ")}`),
                      ),
                      outputLimitBytes: SMALL_GIT_OUTPUT_LIMIT_BYTES,
                      ...(deadline.signal ? { signal: deadline.signal } : {}),
                    }),
                  { drainOnStopMs: GIT_ABORT_DRAIN_TIMEOUT_MS },
                ),
              );
              return { ok: true, stdout: result.stdout };
            } catch (error) {
              if (
                error instanceof RepositorySnapshotError &&
                (error.code === "snapshot_timeout" || error.code === "snapshot_aborted")
              ) {
                throw error;
              }
              if (deadline.signal?.aborted) {
                throw snapshotDeadlineError(deadline, `identity git ${args.join(" ")}`);
              }
              return { ok: false, stdout: "" };
            }
          },
        }),
      { drainOnStopMs: GIT_ABORT_DRAIN_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof RepositorySnapshotError) throw error;
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

  const revisionResult = await run(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    SMALL_GIT_OUTPUT_LIMIT_BYTES,
  );
  const revision = parseObjectId(revisionResult.stdout, "HEAD commit");
  const objectIdWidth = revision.length as 40 | 64;
  // Anchor the tree lookup to the commit we just read. Concurrent HEAD movement
  // is detected below instead of producing a mixed commit/tree snapshot.
  const cleanTreeResult = await run(
    root,
    ["rev-parse", "--verify", `${revision}^{tree}`],
    SMALL_GIT_OUTPUT_LIMIT_BYTES,
  );
  const cleanTree = parseObjectId(cleanTreeResult.stdout, "HEAD tree", objectIdWidth);
  const objectHashAlgorithm = revision.length === 64 ? "sha256" : "sha1";
  const dirtyState = await captureDirtyState(
    root,
    run,
    diffOutputLimitBytes,
    objectHashAlgorithm,
    objectIdWidth,
    fileSystem,
    deadline,
  );
  const revisionAfterResult = await run(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    SMALL_GIT_OUTPUT_LIMIT_BYTES,
  );
  const revisionAfter = parseObjectId(revisionAfterResult.stdout, "HEAD commit", objectIdWidth);
  if (revisionAfter !== revision) {
    throw new RepositorySnapshotError(
      "repository_changed",
      "Repository revision changed while its snapshot was being captured; retry from a stable worktree",
      { gitArgs: ["rev-parse", "--verify", "HEAD^{commit}"] },
    );
  }
  const dirtyStateAfter = await captureDirtyState(
    root,
    run,
    diffOutputLimitBytes,
    objectHashAlgorithm,
    objectIdWidth,
    fileSystem,
    deadline,
  );
  const finalRevisionResult = await run(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    SMALL_GIT_OUTPUT_LIMIT_BYTES,
  );
  const finalRevision = parseObjectId(finalRevisionResult.stdout, "HEAD commit", objectIdWidth);
  if (finalRevision !== revision || !dirtyStatesEqual(dirtyStateAfter, dirtyState)) {
    throw new RepositorySnapshotError(
      "repository_changed",
      "Repository content changed while its dirty snapshot was being captured; retry from a stable worktree",
      { gitArgs: [...STATUS_ARGS] },
    );
  }
  remainingSnapshotMs(deadline, "finalize repository snapshot");
  const dirty = Boolean(
    dirtyState.status ||
    dirtyState.stagedDiff ||
    dirtyState.unstagedDiff ||
    dirtyState.untrackedFiles,
  );
  if (!dirty) {
    await validateRepositoryAnchors(requestedRootAnchor, gitRootAnchor, fileSystem, deadline);
    return {
      identity: identity.repositoryId,
      root,
      revision,
      tree: cleanTree,
      dirty: false,
    };
  }

  const dirtyTree = dirtyTreeFingerprint({
    revision,
    status: dirtyState.status,
    stagedDiff: dirtyState.stagedDiff,
    unstagedDiff: dirtyState.unstagedDiff,
    untrackedFiles: dirtyState.untrackedFiles,
  });
  remainingSnapshotMs(deadline, "finalize dirty repository snapshot");
  await validateRepositoryAnchors(requestedRootAnchor, gitRootAnchor, fileSystem, deadline);
  return {
    identity: identity.repositoryId,
    root,
    revision,
    tree: dirtyTree,
    dirty: true,
  };
}
