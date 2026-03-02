import { constants } from "fs";
import { access, mkdir, stat } from "fs/promises";
import { dirname, join } from "path";

export const DEFAULT_REQUIRED_ENV_VARS = ["PUSHPALS_SERVER_URL", "PUSHPALS_SESSION_ID"] as const;

const ALLOWED_SERVER_PROTOCOLS = new Set(["http:", "https:"]);

type GitOperationInProgress = "merge" | "rebase" | "cherry-pick" | "revert";

const GIT_OPERATION_REASONS: Record<GitOperationInProgress, string> = {
  merge: "A merge is currently in progress in the repo.",
  rebase: "A rebase is currently in progress in the repo.",
  "cherry-pick": "A cherry-pick is currently in progress in the repo.",
  revert: "A revert is currently in progress in the repo.",
};

const GIT_OPERATION_REMEDIATION = "Complete or abort the pending git operation before RemoteBuddy dispatches new jobs.";

const GIT_SEQUENCER_INDICATORS: Array<{ relPath: string; operation: GitOperationInProgress }> = [
  { relPath: "rebase-apply", operation: "rebase" },
  { relPath: "rebase-merge", operation: "rebase" },
  { relPath: "CHERRY_PICK_HEAD", operation: "cherry-pick" },
  { relPath: "REVERT_HEAD", operation: "revert" },
];

export interface RemoteBuddyPreflightConfig {
  sessionId: string;
  authToken: string | null;
  server: {
    url: string;
  };
  paths: {
    remotebuddyDbPath: string;
  };
}

export type RemoteBuddyPreflightFailureCategory = "env" | "credential" | "sandbox";

export type RemoteBuddyPreflightFailureCode =
  | "missing_env"
  | "invalid_server_url"
  | "missing_auth_token"
  | "sandbox_git_missing"
  | "sandbox_not_writable"
  | "sandbox_worktree_dirty"
  | "sandbox_merge_in_progress"
  | "git_unavailable";

export interface RemoteBuddyPreflightFailure {
  code: RemoteBuddyPreflightFailureCode;
  category: RemoteBuddyPreflightFailureCategory;
  reason: string;
  remediation: string;
  details?: Record<string, string | boolean>;
}

export interface RemoteBuddyPreflightSuccessSummary {
  serverUrl: string;
  sessionId: string;
  repoRoot: string;
}

export type RemoteBuddyPreflightResult =
  | { ok: true; summary: RemoteBuddyPreflightSuccessSummary }
  | { ok: false; failure: RemoteBuddyPreflightFailure };

export const REMOTEBUDDY_PREFLIGHT_FAILURE_SCHEMA_VERSION = 1;
export const REMOTEBUDDY_PREFLIGHT_REMEDIATION_FALLBACK =
  "Review the RemoteBuddy preflight checklist, verify env vars/auth tokens/git repo access, then rerun remotebuddy:preflight.";

export interface RemoteBuddyPreflightFailureLogPayload {
  schemaVersion: number;
  code: RemoteBuddyPreflightFailureCode;
  category: RemoteBuddyPreflightFailureCategory;
  reason: string;
  remediation: string;
  details: Record<string, string | boolean>;
}

export function buildPreflightFailureLogPayload(
  failure: RemoteBuddyPreflightFailure,
): RemoteBuddyPreflightFailureLogPayload {
  const remediation =
    typeof failure.remediation === "string" && failure.remediation.trim().length > 0
      ? failure.remediation.trim()
      : REMOTEBUDDY_PREFLIGHT_REMEDIATION_FALLBACK;
  return {
    schemaVersion: REMOTEBUDDY_PREFLIGHT_FAILURE_SCHEMA_VERSION,
    code: failure.code,
    category: failure.category,
    reason: failure.reason,
    remediation,
    details: { ...(failure.details ?? {}) },
  };
}

function toPreflightFailureLogPayload(
  failure: RemoteBuddyPreflightFailure | RemoteBuddyPreflightFailureLogPayload,
): RemoteBuddyPreflightFailureLogPayload {
  return "schemaVersion" in failure
    ? (failure as RemoteBuddyPreflightFailureLogPayload)
    : buildPreflightFailureLogPayload(failure);
}

export function formatPreflightFailureContext(
  failure: RemoteBuddyPreflightFailure | RemoteBuddyPreflightFailureLogPayload,
): string {
  const payload = toPreflightFailureLogPayload(failure);
  const detailPairs = Object.entries(payload.details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const detailSuffix = detailPairs ? ` details=${detailPairs}` : "";
  return `[preflight:${payload.code}] category=${payload.category} reason=${payload.reason} remediation=${payload.remediation}${detailSuffix}`;
}

export function buildPreflightFailureSignature(
  failure: RemoteBuddyPreflightFailure | RemoteBuddyPreflightFailureLogPayload,
): string {
  const payload = toPreflightFailureLogPayload(failure);
  const detailSignatureEntries = Object.keys(payload.details)
    .sort()
    .map((key) => `${key}:${String(payload.details[key])}`);
  const detailsSignature =
    detailSignatureEntries.length > 0 ? detailSignatureEntries.join("|") : "details:none";
  return `${payload.code}:${payload.reason}:${payload.remediation}:${detailsSignature}`;
}

export type GitRunnerResult = { exitCode: number; stdout: string; stderr: string };
export type GitRunner = (repoRoot: string, args: string[]) => Promise<GitRunnerResult>;

export interface RemoteBuddyPreflightOptions {
  env?: NodeJS.ProcessEnv;
  config: RemoteBuddyPreflightConfig;
  repoRoot: string;
  requiredEnvVars?: string[];
  gitRunner?: GitRunner;
  pathExists?: (path: string) => Promise<boolean>;
  ensureDirWritable?: (dir: string) => Promise<boolean>;
}

export async function runRemoteBuddyPreflight(
  options: RemoteBuddyPreflightOptions,
): Promise<RemoteBuddyPreflightResult> {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot;
  const config = options.config;
  const requiredEnvVars =
    options.requiredEnvVars ?? [...DEFAULT_REQUIRED_ENV_VARS.map((name) => name)];
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  const pathExists = options.pathExists ?? defaultPathExists;
  const ensureDirWritable = options.ensureDirWritable ?? defaultEnsureDirWritable;

  const missingEnv = requiredEnvVars.filter((name) => {
    const raw = env[name];
    if (typeof raw !== "string") return true;
    return raw.trim() === "";
  });
  if (missingEnv.length > 0) {
    return {
      ok: false,
      failure: {
        code: "missing_env",
        category: "env",
        reason: `Missing required environment variables: ${missingEnv.join(", ")}`,
        remediation: "Export the missing variables or add them to your .env before restarting.",
        details: { missing: missingEnv.join(", ") },
      },
    };
  }

  const serverUrl = String(env.PUSHPALS_SERVER_URL ?? config.server.url ?? "").trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(serverUrl);
  } catch {
    return {
      ok: false,
      failure: {
        code: "invalid_server_url",
        category: "env",
        reason: `PUSHPALS_SERVER_URL is not a valid absolute URL: ${serverUrl || "<empty>"}`,
        remediation: "Set PUSHPALS_SERVER_URL to a reachable http(s) endpoint and retry startup.",
        details: { serverUrl },
      },
    };
  }

  if (!ALLOWED_SERVER_PROTOCOLS.has(parsedUrl.protocol)) {
    return {
      ok: false,
      failure: {
        code: "invalid_server_url",
        category: "env",
        reason: `PUSHPALS_SERVER_URL must use http:// or https://; received ${parsedUrl.protocol || "<empty>"}.`,
        remediation: "Update PUSHPALS_SERVER_URL to an http(s) endpoint before restarting RemoteBuddy.",
        details: { serverUrl, protocol: parsedUrl.protocol },
      },
    };
  }

  const authToken = String(env.PUSHPALS_AUTH_TOKEN ?? config.authToken ?? "").trim();
  if (!authToken) {
    return {
      ok: false,
      failure: {
        code: "missing_auth_token",
        category: "credential",
        reason: "PUSHPALS_AUTH_TOKEN is required so RemoteBuddy can authenticate with the server.",
        remediation:
          "Export PUSHPALS_AUTH_TOKEN (or add it to .env) and restart RemoteBuddy after retrieving a valid token.",
      },
    };
  }

  const repoExists = await pathExists(repoRoot);
  if (!repoExists) {
    return {
      ok: false,
      failure: {
        code: "sandbox_git_missing",
        category: "sandbox",
        reason: `Repo root ${repoRoot} does not exist or is inaccessible.`,
        remediation: "Start RemoteBuddy from the PushPals repository root or update PUSHPALS_REPO_PATH.",
        details: { repoRoot },
      },
    };
  }

  const gitDir = join(repoRoot, ".git");
  if (!(await pathExists(gitDir))) {
    return {
      ok: false,
      failure: {
        code: "sandbox_git_missing",
        category: "sandbox",
        reason: `Directory ${repoRoot} is not a git repository (.git missing).`,
        remediation: "Run RemoteBuddy inside a git checkout that contains the PushPals workspace.",
        details: { repoRoot },
      },
    };
  }

  const dbDir = dirname(config.paths.remotebuddyDbPath);
  const writable = await ensureDirWritable(dbDir);
  if (!writable) {
    return {
      ok: false,
      failure: {
        code: "sandbox_not_writable",
        category: "sandbox",
        reason: `RemoteBuddy cannot write to ${dbDir} (idempotency + memory stores).`,
        remediation:
          "Ensure the data directory exists and is writable, then retry (e.g., chmod + mkdir -p).",
        details: { dbDir },
      },
    };
  }

  const statusResult = await gitRunner(repoRoot, ["status", "--porcelain"]);
  if (statusResult.exitCode !== 0) {
    return gitFailure(statusResult.stderr);
  }
  if (statusResult.stdout.trim().length > 0) {
    return {
      ok: false,
      failure: {
        code: "sandbox_worktree_dirty",
        category: "sandbox",
        reason: "Worktree has uncommitted changes; deterministic preflight requires a clean repo.",
        remediation: "Commit, stash, or reset changes before dispatching RemoteBuddy jobs.",
        details: { dirtySample: statusResult.stdout.split("\n").slice(0, 3).join("\n") },
      },
    };
  }

  const mergeHead = await gitRunner(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (mergeHead.exitCode === 0 && mergeHead.stdout.trim().length > 0) {
    return sandboxOperationInProgressFailure("merge", "MERGE_HEAD");
  }
  if (
    mergeHead.exitCode !== 0 &&
    mergeHead.stderr &&
    !/needed a single revision|not a valid object name/i.test(mergeHead.stderr)
  ) {
    return gitFailure(mergeHead.stderr);
  }

  for (const indicator of GIT_SEQUENCER_INDICATORS) {
    const indicatorPath = join(gitDir, indicator.relPath);
    if (await pathExists(indicatorPath)) {
      return sandboxOperationInProgressFailure(indicator.operation, indicator.relPath);
    }
  }

  return {
    ok: true,
    summary: {
      serverUrl: parsedUrl.toString(),
      sessionId: (env.PUSHPALS_SESSION_ID ?? config.sessionId ?? "").trim(),
      repoRoot,
    },
  };
}

function gitFailure(stderr: string): RemoteBuddyPreflightResult {
  return {
    ok: false,
    failure: {
      code: "git_unavailable",
      category: "sandbox",
      reason: "Git commands failed during preflight; sandbox status is unknown.",
      remediation: "Install git and ensure it can run inside the repo before restarting RemoteBuddy.",
      details: { stderr: stderr.trim() },
    },
  };
}

function sandboxOperationInProgressFailure(
  operation: GitOperationInProgress,
  indicator: string,
): RemoteBuddyPreflightResult {
  return {
    ok: false,
    failure: {
      code: "sandbox_merge_in_progress",
      category: "sandbox",
      reason: GIT_OPERATION_REASONS[operation],
      remediation: GIT_OPERATION_REMEDIATION,
      details: { indicator, operation },
    },
  };
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

async function defaultEnsureDirWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultGitRunner(repoRoot: string, args: string[]): Promise<GitRunnerResult> {
  try {
    const proc = Bun.spawn(["git", "-C", repoRoot, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: String(err) };
  }
}
