import { existsSync, readFileSync, statSync } from "fs";
import { resolve, isAbsolute } from "path";
import { detectRepoRoot, loadPushPalsConfig, type PushPalsConfig } from "shared";

const SERVER_ENV = "PUSHPALS_SERVER_URL";
const SESSION_ENV = "PUSHPALS_SESSION_ID";
const SEQUENCER_INDICATORS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "BISECT_LOG",
  "sequencer",
];

export type RemoteBuddyPreflightFailureCode = "missing_env" | "sandbox_merge_in_progress";

export type RemoteBuddyPreflightResult =
  | {
      ok: true;
      serverUrl: string;
      sessionId: string;
      repoRoot: string;
      gitDir: string;
    }
  | {
      ok: false;
      code: RemoteBuddyPreflightFailureCode;
      detail: string;
      missing?: string[];
      indicator?: string;
      gitDir?: string;
    };

export interface RemoteBuddyPreflightOptions {
  env?: NodeJS.ProcessEnv;
  config?: PushPalsConfig;
  repoRoot?: string;
  resolveGitDir?: (repoRoot: string) => Promise<string | null>;
}

export async function runRemoteBuddyPreflight(
  options: RemoteBuddyPreflightOptions = {},
): Promise<RemoteBuddyPreflightResult> {
  const env = options.env ?? process.env;
  let config = options.config;
  const getConfig = (): PushPalsConfig => {
    if (!config) {
      config = loadPushPalsConfig();
    }
    return config;
  };

  const { serverUrl, sessionId, missing } = resolveConnectionDetails(env, getConfig);
  if (missing.length > 0) {
    return {
      ok: false,
      code: "missing_env",
      detail: `Missing required value(s): ${missing.join(", ")}`,
      missing,
    };
  }

  const repoRoot = options.repoRoot ?? detectRepoRoot(process.cwd());
  const resolvedGitDir = await resolveGitDir(repoRoot, options.resolveGitDir);
  const gitDir = resolvedGitDir ?? resolve(repoRoot, ".git");
  const indicator = detectSequencerIndicator(resolvedGitDir ?? gitDir);
  if (indicator) {
    return {
      ok: false,
      code: "sandbox_merge_in_progress",
      detail: `Git sequencer indicator detected (${indicator}) in ${gitDir}. Resolve merge/rebase state before running RemoteBuddy.`,
      indicator,
      gitDir,
    };
  }

  return { ok: true, serverUrl, sessionId, repoRoot, gitDir };
}

function resolveConnectionDetails(
  env: NodeJS.ProcessEnv,
  getConfig: () => PushPalsConfig,
): { serverUrl: string; sessionId: string; missing: string[] } {
  const serverUrl = resolvePreflightValue(env[SERVER_ENV], () => getConfig().server.url);
  const sessionId = resolvePreflightValue(env[SESSION_ENV], () => getConfig().sessionId);

  const missing: string[] = [];
  if (!serverUrl) missing.push(SERVER_ENV);
  if (!sessionId) missing.push(SESSION_ENV);

  return { serverUrl, sessionId, missing };
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

function resolvePreflightValue(
  envValue: string | undefined,
  configValue: () => string | undefined,
): string {
  const envResolved = firstNonEmpty(envValue);
  if (envResolved) return envResolved;
  return firstNonEmpty(configValue());
}

async function resolveGitDir(
  repoRoot: string,
  resolver?: (repoRoot: string) => Promise<string | null>,
): Promise<string | null> {
  if (resolver) {
    const fromResolver = finalizeGitDirCandidate(repoRoot, await resolver(repoRoot));
    if (fromResolver) return fromResolver;
  }
  const fromGit = await gitRevParseGitDir(repoRoot);
  if (fromGit) return fromGit;
  return fallbackGitDir(repoRoot);
}

async function gitRevParseGitDir(repoRoot: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--git-dir"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const stdout = await stdoutPromise;
    await stderrPromise;
    if (exitCode !== 0) return null;
    const resolved = finalizeGitDirCandidate(repoRoot, stdout);
    if (resolved) return resolved;
    return null;
  } catch {
    return null;
  }
}

function fallbackGitDir(repoRoot: string): string | null {
  const dotGitPath = resolve(repoRoot, ".git");
  if (!existsSync(dotGitPath)) return null;
  try {
    const stats = statSync(dotGitPath);
    if (stats.isDirectory()) return dotGitPath;
    if (stats.isFile()) {
      return resolveGitDirPointer(dotGitPath);
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeGitDir(repoRoot: string, gitDir: string | null | undefined): string | null {
  if (!gitDir) return null;
  const trimmed = gitDir.trim();
  if (!trimmed) return null;
  return isAbsolute(trimmed) ? trimmed : resolve(repoRoot, trimmed);
}

function resolveGitDirPointer(pointerFilePath: string): string | null {
  try {
    const contents = readFileSync(pointerFilePath, "utf8");
    const match = contents.match(/gitdir:\s*(.+)/i);
    if (!match?.[1]) return null;
    const pointerBase = resolve(pointerFilePath, "..");
    return normalizeGitDir(pointerBase, match[1]);
  } catch {
    return null;
  }
}

function finalizeGitDirCandidate(
  basePath: string,
  candidate: string | null | undefined,
): string | null {
  const normalized = normalizeGitDir(basePath, candidate);
  if (!normalized) return null;
  try {
    const stats = statSync(normalized);
    if (stats.isDirectory()) return normalized;
    if (stats.isFile()) {
      return resolveGitDirPointer(normalized);
    }
  } catch {
    return normalized;
  }
  return normalized;
}

function detectSequencerIndicator(gitDir: string): string | null {
  for (const indicator of SEQUENCER_INDICATORS) {
    const candidate = resolve(gitDir, indicator);
    if (existsSync(candidate)) return indicator;
  }
  return null;
}
