import {
  gateDispatchWithStartupPreflight,
  runStartupPreflight,
  STARTUP_FAILURE_CODES,
  type RepoStatus,
  type StartupCheckRecord,
  type StartupChecklistContext,
  type StartupChecklistFailure,
  type StartupChecklistOptions,
  type StartupChecklistResult,
  type StartupFailureCode,
} from "./checklist.js";
import { detectRepoRoot } from "shared";

export type SystemPreflightContext = StartupChecklistContext;
export type SystemPreflightResult = StartupChecklistResult;
export type SystemPreflightFailureCode = StartupFailureCode;

export interface SystemPreflightOptions extends StartupChecklistOptions {
  guardDispatch?: boolean;
  dispatchJob?: () => Promise<void>;
}

export const SYSTEM_PREFLIGHT_FAILURE_CODES = STARTUP_FAILURE_CODES;

export class SystemPreflightError extends Error {
  readonly code: SystemPreflightFailureCode;
  readonly detail: string;
  readonly action: string;
  readonly category: StartupChecklistFailure["category"];
  readonly step: number;
  readonly history: StartupCheckRecord[];

  constructor(failure: StartupChecklistFailure, history: StartupCheckRecord[]) {
    const message = `[${failure.code}] ${failure.detail}`;
    super(message);
    this.name = "SystemPreflightError";
    this.code = failure.code;
    this.detail = failure.detail;
    this.action = failure.action;
    this.category = failure.category;
    this.step = failure.step;
    this.history = history;
  }
}

export async function runSystemPreflight(
  ctx: SystemPreflightContext,
  options: SystemPreflightOptions = {},
): Promise<SystemPreflightResult> {
  if (options.guardDispatch && options.dispatchJob) {
    return gateDispatchWithStartupPreflight(ctx, options.dispatchJob, options);
  }
  return runStartupPreflight(ctx, options);
}

export async function ensureSystemPreflight(
  ctx: SystemPreflightContext,
  options: SystemPreflightOptions = {},
): Promise<SystemPreflightResult> {
  const result = await runSystemPreflight(ctx, options);
  if (!result.ok && result.failure) {
    throw new SystemPreflightError(result.failure, result.history);
  }
  return result;
}

type GitExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function runGitCommand(repoRoot: string, args: string[]): Promise<GitExecResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

const summarizePorcelain = (porcelain: string): string => {
  const firstLine = porcelain
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? `Dirty worktree: ${firstLine}` : "Dirty worktree detected.";
};

export async function describeRepoStatus(repoRoot?: string): Promise<RepoStatus> {
  const resolvedRoot = (repoRoot ?? detectRepoRoot(process.cwd())).trim();
  if (!resolvedRoot) {
    throw new Error("Unable to resolve repository root for startup preflight.");
  }

  const [statusResult, branchResult, mergeResult] = await Promise.all([
    runGitCommand(resolvedRoot, ["status", "--porcelain=v1"]),
    runGitCommand(resolvedRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGitCommand(resolvedRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
  ]);

  if (statusResult.exitCode !== 0) {
    const detail = statusResult.stderr || statusResult.stdout || `exit ${statusResult.exitCode}`;
    throw new Error(`git status failed: ${detail}`);
  }

  if (branchResult.exitCode !== 0) {
    const detail = branchResult.stderr || branchResult.stdout || `exit ${branchResult.exitCode}`;
    throw new Error(`git rev-parse --abbrev-ref HEAD failed: ${detail}`);
  }

  const isDirty = Boolean(statusResult.stdout.trim());
  const branch = branchResult.stdout.trim() || undefined;
  const isMergeInProgress = mergeResult.exitCode === 0;
  const detail = isDirty
    ? summarizePorcelain(statusResult.stdout)
    : branch
      ? `Worktree is clean on ${branch}.`
      : "Worktree is clean.";

  return {
    isDirty,
    isMergeInProgress,
    branch,
    detail,
  };
}

const parseAlertList = (raw: string | undefined | null): string[] => {
  if (!raw) return [];
  return raw
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

export function listFiringAlertsFromEnv(env: NodeJS.ProcessEnv = process.env): () => Promise<string[]> {
  return async () => {
    const sources = [env.PUSHPALS_PREFLIGHT_ALERTS, env.REMOTEBUDDY_PREFLIGHT_ALERTS];
    for (const source of sources) {
      const parsed = parseAlertList(source);
      if (parsed.length > 0) {
        return parsed;
      }
    }
    return [];
  };
}

export interface ServerSyntheticTesterOptions {
  server: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  path?: string;
}

const formatFetchFailure = (input: unknown): string => {
  if (input instanceof Error) return input.message;
  if (typeof input === "string" && input.trim()) return input.trim();
  return "Unknown synthetic probe failure.";
};

export function createServerSyntheticTester(
  options: ServerSyntheticTesterOptions,
): StartupChecklistContext["syntheticTester"] {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutFallback = Math.max(1_000, options.timeoutMs ?? 5_000);
  const requestPath = options.path ?? "/healthz";

  return {
    async runSyntheticJob({ maxLatencyMs, probeName }) {
      let targetUrl: URL;
      try {
        targetUrl = new URL(requestPath, options.server);
      } catch (error) {
        return {
          ok: false,
          latencyMs: 0,
          failureDetail: `Invalid server URL: ${formatFetchFailure(error)}`,
        };
      }

      const controller = new AbortController();
      const timeoutMs = Math.max(maxLatencyMs * 2, timeoutFallback);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();

      try {
        const res = await fetchImpl(targetUrl.toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const latencyMs = Math.max(0, Date.now() - started);
        if (!res.ok) {
          return {
            ok: false,
            latencyMs,
            failureDetail: `${probeName} HTTP ${res.status}`,
          };
        }
        return { ok: true, latencyMs };
      } catch (error) {
        const latencyMs = Math.max(0, Date.now() - started);
        return {
          ok: false,
          latencyMs,
          failureDetail: `${probeName} ${formatFetchFailure(error)}`,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function buildSystemPreflightContext(options: {
  repoRoot?: string;
  describeRepo?: () => Promise<RepoStatus>;
  listFiringAlerts?: () => Promise<string[]>;
  syntheticTester?: StartupChecklistContext["syntheticTester"];
  now?: () => number;
  log?: (entry: StartupCheckRecord) => void;
} = {}): SystemPreflightContext {
  return {
    describeRepo: options.describeRepo ?? (() => describeRepoStatus(options.repoRoot)),
    listFiringAlerts: options.listFiringAlerts ?? listFiringAlertsFromEnv(),
    syntheticTester:
      options.syntheticTester ??
      createServerSyntheticTester({ server: "http://localhost:3001" }),
    now: options.now,
    log: options.log,
  };
}
