import { randomUUID } from "crypto";
import { redactWindowsHomePaths } from "shared";

type GitCommandResult = {
  cwd: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitCommandRunner = (cwd: string, args: string[]) => Promise<GitCommandResult>;

const DEFAULT_PREFLIGHT_CACHE_TTL_MS = Number.POSITIVE_INFINITY;
const DIRTY_SAMPLE_LIMIT = 12;

const defaultGitRunner: GitCommandRunner = async (
  cwd: string,
  args: string[],
): Promise<GitCommandResult> => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    cwd,
    args,
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
};

function parseDirtyEntries(raw: string): string[] {
  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  const entries: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    // git status porcelain is "XY <path>" or "?? <path>"
    const match = line.match(/^[?MADRCU!~ ]{1,2}\s+(.*)$/i);
    const payload = match ? match[1] ?? "" : line;
    const normalized = payload.includes(" -> ")
      ? payload.split(" -> ").pop()?.trim()
      : payload.trim();
    if (!normalized) continue;
    entries.push(normalized);
  }
  return entries;
}

export type RepoPreflightStatus = {
  id: string;
  repo: string;
  branch: string;
  isWorktreeDirty: boolean;
  dirtyCount: number;
  dirtySamples: string[];
  isMergeInProgress: boolean;
  checkedAtMs: number;
};

export type RepoPreflightFailureCode = "git_status_failed" | "git_branch_failed";

export type RepoPreflightReadResult =
  | { ok: true; status: RepoPreflightStatus }
  | { ok: false; error: RepoPreflightError };

export type RepoPreflightFailureDetail = {
  code: RepoPreflightFailureCode | "unknown_error";
  command?: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

export class RepoPreflightError extends Error {
  readonly code: RepoPreflightFailureCode;
  readonly command: string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly repo: string;

  constructor(params: {
    code: RepoPreflightFailureCode;
    message: string;
    command: string[];
    exitCode: number;
    stdout: string;
    stderr: string;
    repo: string;
  }) {
    super(params.message);
    this.name = "RepoPreflightError";
    this.code = params.code;
    this.command = params.command;
    this.exitCode = params.exitCode;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.repo = params.repo;
  }
}

type RepoPreflightReaderDeps = {
  git: GitCommandRunner;
};

export type RepoPreflightReader = (
  repoRoot: string,
  deps: RepoPreflightReaderDeps,
) => Promise<RepoPreflightReadResult>;

const defaultRepoPreflightReader: RepoPreflightReader = async (
  repo,
  deps: RepoPreflightReaderDeps,
): Promise<RepoPreflightReadResult> => {
  const statusResult = await deps.git(repo, ["status", "--porcelain"]);
  if (statusResult.exitCode !== 0) {
    return {
      ok: false,
      error: new RepoPreflightError({
        code: "git_status_failed",
        message: `git status --porcelain failed (exit ${statusResult.exitCode})`,
        command: ["status", "--porcelain"],
        exitCode: statusResult.exitCode,
        stdout: statusResult.stdout,
        stderr: statusResult.stderr,
        repo,
      }),
    };
  }

  const branchResult = await deps.git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchResult.exitCode !== 0) {
    return {
      ok: false,
      error: new RepoPreflightError({
        code: "git_branch_failed",
        message: `git rev-parse --abbrev-ref HEAD failed (exit ${branchResult.exitCode})`,
        command: ["rev-parse", "--abbrev-ref", "HEAD"],
        exitCode: branchResult.exitCode,
        stdout: branchResult.stdout,
        stderr: branchResult.stderr,
        repo,
      }),
    };
  }

  const mergeHeadResult = await deps.git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  const isMergeInProgress = mergeHeadResult.exitCode === 0 && Boolean(mergeHeadResult.stdout);

  const dirtyEntries = parseDirtyEntries(statusResult.stdout);
  const dirtySamples = dirtyEntries.slice(0, DIRTY_SAMPLE_LIMIT);

  return {
    ok: true,
    status: {
      id: randomUUID(),
      repo,
      branch: branchResult.stdout || "unknown",
      isWorktreeDirty: dirtyEntries.length > 0,
      dirtyCount: dirtyEntries.length,
      dirtySamples,
      isMergeInProgress,
      checkedAtMs: Date.now(),
    },
  };
};

export async function readRepoPreflightStatus(
  repo: string,
  options: { git?: GitCommandRunner } = {},
): Promise<RepoPreflightReadResult> {
  const git = options.git ?? defaultGitRunner;
  return defaultRepoPreflightReader(repo, { git });
}

export interface RepoPreflightProvider {
  read(force?: boolean): Promise<RepoPreflightReadResult>;
  invalidate(reason?: string): void;
}

export class RemoteBuddyPreflightCache implements RepoPreflightProvider {
  private cache:
    | {
        status: RepoPreflightStatus;
        expiresAtMs: number;
      }
    | null = null;
  private readonly ttlMs: number;
  private readonly reader: RepoPreflightReader;
  private readonly git: GitCommandRunner;
  private readonly now: () => number;
  private lastInvalidatedReason: string | null = null;
  private lastInvalidatedAtMs = 0;

  constructor(
    private readonly repoRoot: string,
    options: {
      ttlMs?: number;
      reader?: RepoPreflightReader;
      git?: GitCommandRunner;
      now?: () => number;
    } = {},
  ) {
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_PREFLIGHT_CACHE_TTL_MS);
    this.reader = options.reader ?? defaultRepoPreflightReader;
    this.git = options.git ?? defaultGitRunner;
    this.now = options.now ?? (() => Date.now());
  }

  async read(force = false): Promise<RepoPreflightReadResult> {
    const now = this.now();
    if (!force && this.cache && now < this.cache.expiresAtMs) {
      return { ok: true, status: this.cache.status };
    }
    const result = await this.reader(this.repoRoot, { git: this.git });
    if (result.ok) {
      this.cache = {
        status: result.status,
        expiresAtMs: now + this.ttlMs,
      };
    } else {
      this.cache = null;
    }
    return result;
  }

  invalidate(reason?: string): void {
    this.cache = null;
    this.lastInvalidatedReason = reason ?? null;
    this.lastInvalidatedAtMs = this.now();
  }

  snapshot(): {
    cached?: RepoPreflightStatus;
    expiresAtMs?: number;
    lastInvalidatedReason: string | null;
    lastInvalidatedAtMs: number;
  } {
    return {
      cached: this.cache?.status,
      expiresAtMs: this.cache?.expiresAtMs,
      lastInvalidatedReason: this.lastInvalidatedReason,
      lastInvalidatedAtMs: this.lastInvalidatedAtMs,
    };
  }
}

const PREFLIGHT_OUTPUT_MAX = 4000;

export function sanitizeRepoPreflightOutput(
  value: string,
  options: { max?: number; env?: NodeJS.ProcessEnv } = {},
): string {
  const { max = PREFLIGHT_OUTPUT_MAX, env = process.env } = options;
  const text = String(value ?? "");
  if (!text) return "";
  let redacted = redactWindowsHomePaths(text, env);
  redacted = redactPosixHomePaths(redacted, env);
  return redacted.length > max ? `${redacted.slice(0, Math.max(0, max - 3))}...` : redacted;
}

export function formatRepoPreflightFailure(
  error: unknown,
  options: { env?: NodeJS.ProcessEnv } = {},
): RepoPreflightFailureDetail {
  const env = options.env ?? process.env;
  if (error instanceof RepoPreflightError) {
    return {
      code: error.code,
      command: ["git", ...error.command],
      exitCode: error.exitCode,
      stdout: sanitizeRepoPreflightOutput(error.stdout, { env }),
      stderr: sanitizeRepoPreflightOutput(error.stderr, { env }),
    };
  }
  const detail = error instanceof Error ? error.message : String(error ?? "");
  return {
    code: "unknown_error",
    stderr: sanitizeRepoPreflightOutput(detail, { env }),
  };
}

function redactPosixHomePaths(text: string, env: NodeJS.ProcessEnv): string {
  const home = String(env.HOME ?? "").trim();
  if (!home || home.length < 2) return text;
  const normalized = home.replace(/\/+$/, "");
  if (!normalized) return text;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\\\//g, "[\\/]");
  return text.replace(new RegExp(pattern, "g"), "<home>");
}
