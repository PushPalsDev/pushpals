import { createHash } from "crypto";
import { realpathSync } from "fs";
import { isAbsolute, resolve } from "path";
import { runBoundedProcess } from "./bounded_process.js";
import { sanitizeGitRemoteUrl } from "./git_backend.js";

export type RepositoryIdentitySource = "origin" | "git-common-dir";

export interface RepositoryIdentity {
  repositoryId: string;
  source: RepositoryIdentitySource;
  /** Credential-free host/path form; schemes and Git usernames are intentionally omitted. */
  normalizedOrigin: string | null;
  /** First/root commit OIDs sorted for the rare repository with multiple roots. */
  rootCommit: string | null;
  /** Canonical Git common directory shared by all linked worktrees. */
  gitCommonDir: string;
}

export interface RepositoryIdentityGitResult {
  ok: boolean;
  stdout: string;
}

export interface ResolveRepositoryIdentityOptions {
  timeoutMs?: number;
  runGit?: (
    repoRoot: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<RepositoryIdentityGitResult>;
}

function normalizeRemotePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/")
    .replace(/\.git$/i, "");
}

/**
 * Produce a credential-free repository remote identity.
 *
 * Transport schemes and SSH usernames are deliberately discarded so HTTPS and
 * SSH spellings of the same remote converge. Query strings, fragments, and URL
 * userinfo are never retained.
 */
export function normalizeRepositoryOriginRemote(remoteUrl: string): string {
  const sanitized = sanitizeGitRemoteUrl(String(remoteUrl ?? "").trim());
  if (!sanitized) return "";

  const urlLike = /^[a-z][a-z0-9+.-]*:\/\//i.test(sanitized);
  if (urlLike) {
    try {
      const parsed = new URL(sanitized);
      const host = parsed.hostname.toLowerCase();
      const port = parsed.port ? `:${parsed.port}` : "";
      const path = normalizeRemotePath(parsed.pathname);
      if (host && path) return `${host}${port}/${path}`;
      if (host) return `${host}${port}`;
      // file:// remotes have no host. Keep their canonical path but discard URL
      // query/userinfo so credentials can never become part of the identity.
      if (parsed.protocol === "file:" && path) return `local/${path}`;
    } catch {
      // Continue with SCP/local-path parsing below.
    }
  }

  const scp = sanitized.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp?.[1] && scp[2]) {
    const path = normalizeRemotePath(scp[2]);
    return path ? `${scp[1].toLowerCase()}/${path}` : scp[1].toLowerCase();
  }

  // Local-path remotes do not contain URL credentials. Normalizing separators
  // keeps their identity stable when Git changes path rendering.
  return normalizeRemotePath(sanitized.split(/[?#]/, 1)[0] ?? "");
}

function canonicalPath(value: string): string {
  let canonical = resolve(value);
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    // Git may report a valid common path while it is being initialized. The
    // resolved absolute path remains a deterministic fallback.
  }
  canonical = canonical.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function defaultRunGit(
  repoRoot: string,
  args: string[],
  timeoutMs: number,
): Promise<RepositoryIdentityGitResult> {
  try {
    const result = await runBoundedProcess(["git", "-C", repoRoot, ...args], {
      cwd: repoRoot,
      timeoutMs,
      outputLimitBytes: 256 * 1024,
      streamDrainTimeoutMs: 1_000,
    });
    return { ok: result.exitCode === 0, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function normalizeRootCommits(stdout: string): string | null {
  const commits = stdout
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[0-9a-f]{7,128}$/.test(line))
    .sort();
  return commits.length > 0 ? commits.join(",") : null;
}

/**
 * Resolve an identity shared by linked worktrees without persisting absolute
 * worktree paths or credentials in the ID.
 */
export async function resolveRepositoryIdentity(
  repoRoot: string,
  options: ResolveRepositoryIdentityOptions = {},
): Promise<RepositoryIdentity> {
  const absoluteRepoRoot = resolve(repoRoot);
  const timeoutMs = Math.max(100, Math.min(30_000, Math.floor(options.timeoutMs ?? 5_000)));
  const runGit = options.runGit ?? defaultRunGit;

  const commonResult = await runGit(absoluteRepoRoot, ["rev-parse", "--git-common-dir"], timeoutMs);
  const commonOutput = commonResult.stdout.trim().split(/\r?\n/, 1)[0] ?? "";
  if (!commonResult.ok || !commonOutput) {
    throw new Error("Cannot resolve repository identity: Git common directory is unavailable");
  }
  const commonPath = isAbsolute(commonOutput)
    ? commonOutput
    : resolve(absoluteRepoRoot, commonOutput);
  const gitCommonDir = canonicalPath(commonPath);

  const [originResult, rootsResult] = await Promise.all([
    runGit(absoluteRepoRoot, ["remote", "get-url", "origin"], timeoutMs),
    runGit(absoluteRepoRoot, ["rev-list", "--max-parents=0", "HEAD"], timeoutMs),
  ]);
  const normalizedOrigin = originResult.ok
    ? normalizeRepositoryOriginRemote(originResult.stdout.trim().split(/\r?\n/, 1)[0] ?? "") || null
    : null;
  const rootCommit = rootsResult.ok ? normalizeRootCommits(rootsResult.stdout) : null;
  const source: RepositoryIdentitySource = normalizedOrigin ? "origin" : "git-common-dir";
  const seed = normalizedOrigin
    ? `origin\0${normalizedOrigin}\0root\0${rootCommit ?? "unborn"}`
    : `git-common-dir\0${gitCommonDir}`;
  const repositoryId = `repo_${createHash("sha256").update(seed, "utf8").digest("hex")}`;

  return {
    repositoryId,
    source,
    normalizedOrigin,
    rootCommit,
    gitCommonDir,
  };
}
