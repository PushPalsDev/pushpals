/**
 * Deterministic startup preflight checklist plus a synthetic dispatch guard.
 * The helper executes each check sequentially, surfaces actionable failure codes,
 * and optionally blocks job dispatch until a synthetic probe completes.
 */
export const STARTUP_FAILURE_CODES = {
  BUN_VERSION_UNSUPPORTED: "startup.bun_version_unsupported",
  DOCKER_VERSION_UNSUPPORTED: "startup.docker_version_unsupported",
  MERGE_IN_PROGRESS: "startup.merge_in_progress",
  REPO_DIRTY: "startup.repo_dirty",
  ALERTS_ACTIVE: "startup.alerts_active",
  SYNTHETIC_FAILED: "startup.synthetic_failed",
  DISPATCH_FAILED: "startup.dispatch_failed",
} as const;

export type StartupFailureCode =
  (typeof STARTUP_FAILURE_CODES)[keyof typeof STARTUP_FAILURE_CODES];

type StartupCheckStatus = "pass" | "fail";

export type StartupCheckCategory =
  | "runtime"
  | "infrastructure"
  | "repo"
  | "alerts"
  | "synthetic"
  | "dispatch";

export interface StartupChecklistOptions {
  syntheticMaxLatencyMs?: number;
  syntheticProbeName?: string;
  allowDirtyWorktree?: boolean;
}

export interface RepoStatus {
  isDirty: boolean;
  isMergeInProgress: boolean;
  branch?: string;
  detail?: string;
}

export interface SyntheticStartupTestOptions {
  maxLatencyMs: number;
  probeName: string;
}

export interface SyntheticStartupTestResult {
  ok: boolean;
  latencyMs: number;
  failureDetail?: string;
}

export interface SyntheticStartupTester {
  runSyntheticJob: (
    options: SyntheticStartupTestOptions,
  ) => Promise<SyntheticStartupTestResult>;
}

export interface StartupCheckRecord {
  code: StartupFailureCode;
  label: string;
  category: StartupCheckCategory;
  step: number;
  status: StartupCheckStatus;
  detail: string;
  action?: string;
  elapsedMs: number;
  durationMs: number;
  startedAtMs: number;
  endedAtMs: number;
  error?: {
    message: string;
    raw?: unknown;
    stack?: string;
  };
}

export type StartupTelemetryPhaseEvent = {
  type: "startup_phase";
  code: StartupFailureCode;
  label: string;
  category: StartupCheckCategory;
  step: number;
  status: StartupCheckStatus;
  detail: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  action?: string;
  error?: {
    message: string;
    raw?: unknown;
    stack?: string;
  };
};

export type StartupTelemetryUnknownFailureEvent = {
  type: "startup_unknown_failure";
  code: StartupFailureCode;
  phase: string;
  step: number;
  whenMs: number;
  error: {
    message: string;
    raw?: unknown;
    stack?: string;
  };
};

export type StartupTelemetryEvent =
  | StartupTelemetryPhaseEvent
  | StartupTelemetryUnknownFailureEvent;

type StartupCheckErrorInfo = {
  message: string;
  raw?: unknown;
  stack?: string;
};

export interface StartupChecklistFailure {
  code: StartupFailureCode;
  detail: string;
  action: string;
  category: StartupCheckCategory;
  step: number;
}

export interface StartupChecklistResult {
  ok: boolean;
  failure?: StartupChecklistFailure;
  history: StartupCheckRecord[];
}

export interface StartupChecklistContext {
  describeRepo(): Promise<RepoStatus>;
  listFiringAlerts(): Promise<string[]>;
  syntheticTester: SyntheticStartupTester;
  readBunVersion(): Promise<string>;
  readDockerVersion(): Promise<string>;
  now?: () => number;
  log?: (entry: StartupCheckRecord) => void;
  telemetry?: (event: StartupTelemetryEvent) => void;
}

type StartupCheckDefinition = {
  code: StartupFailureCode;
  label: string;
  action: string;
  category: StartupCheckCategory;
  run: (
    ctx: StartupChecklistContext,
    options: StartupChecklistOptions,
  ) => Promise<{ ok: boolean; detail?: string }>;
};

export interface StartupCheckStructure {
  code: StartupFailureCode;
  label: string;
  action: string;
  category: StartupCheckCategory;
  step: number;
}

const DEFAULT_SYNTHETIC_LATENCY_MS = 850;
const DEFAULT_SYNTHETIC_PROBE = "probe.remote_startup";
const DISPATCH_CHECK_LABEL = "Job dispatch must succeed.";
const DISPATCH_CHECK_ACTION =
  "Inspect RemoteBuddy + WorkerPals logs, repair dependencies, then rerun dispatch.";

const MIN_BUN_VERSION = "1.1.0";
const MIN_DOCKER_VERSION = "25.0.0";

const defaultChecks = Object.freeze(
  [
    {
      code: STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
      label: "Bun runtime must meet the minimum supported version.",
      action:
        "Upgrade Bun 1.1+ (`bun upgrade` or reinstall from bun.sh) before running RemoteBuddy.",
      category: "runtime",
      run: async (ctx) => {
        let rawVersion: string;
        try {
          rawVersion = await ctx.readBunVersion();
        } catch (error) {
          throw wrapStartupCheckError("Bun version probe failed", error);
        }
        const normalizedVersion = normalizeVersionString(rawVersion);
        if (compareSemverStrings(normalizedVersion, MIN_BUN_VERSION) < 0) {
          return {
            ok: false,
            detail: `Bun runtime ${normalizedVersion} is below required ${MIN_BUN_VERSION}.`,
          };
        }
        return {
          ok: true,
          detail: `Bun runtime ${normalizedVersion} meets minimum ${MIN_BUN_VERSION}.`,
        };
      },
    },
    {
      code: STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
      label: "Docker runtime must meet the support floor.",
      action:
        "Upgrade Docker Desktop/Engine to 25.0.0+ so synthetic dispatch uses a compatible runtime.",
      category: "infrastructure",
      run: async (ctx) => {
        let rawVersion: string;
        try {
          rawVersion = await ctx.readDockerVersion();
        } catch (error) {
          throw wrapStartupCheckError("Docker version probe failed", error);
        }
        const normalizedVersion = normalizeVersionString(rawVersion);
        if (compareSemverStrings(normalizedVersion, MIN_DOCKER_VERSION) < 0) {
          return {
            ok: false,
            detail: `Docker runtime ${normalizedVersion} is below required ${MIN_DOCKER_VERSION}.`,
          };
        }
        return {
          ok: true,
          detail: `Docker runtime ${normalizedVersion} meets minimum ${MIN_DOCKER_VERSION}.`,
        };
      },
    },
    {
      code: STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      label: "Git merge or rebase must be resolved.",
      action: "Resolve or abort the merge/rebase before starting RemoteBuddy dispatch.",
      category: "repo",
      run: async (ctx) => {
        const status = await ctx.describeRepo();
        if (status.isMergeInProgress) {
          const branchHint = status.branch ? ` on ${status.branch}` : "";
          const detail =
            status.detail ??
            `Merge or rebase detected${branchHint}; startup cannot continue.`;
          return { ok: false, detail };
        }
        return {
          ok: true,
          detail: status.detail ?? "No merge or rebase in progress.",
        };
      },
    },
    {
      code: STARTUP_FAILURE_CODES.REPO_DIRTY,
      label: "Worktree must be clean.",
      action:
        "Commit, stash, or drop untracked files; rerun when git status is clean or pass allowDirtyWorktree=true during startup preflight.",
      category: "repo",
      run: async (ctx, options) => {
        const status = await ctx.describeRepo();
        if (status.isDirty) {
          if (options.allowDirtyWorktree) {
            const branchHint = status.branch ? ` (${status.branch})` : "";
            const detail = status.detail
              ? `Dirty worktree bypassed via allowDirtyWorktree=true: ${status.detail}${branchHint}`
              : `Dirty worktree${branchHint}; bypass approved via allowDirtyWorktree=true.`;
            return { ok: true, detail };
          }
          const branchHint = status.branch ? ` (${status.branch})` : "";
          const detail = status.detail
            ? `${status.detail}${branchHint}`
            : `Dirty worktree${branchHint}; clean it before dispatch.`;
          return { ok: false, detail };
        }
        return {
          ok: true,
          detail: status.detail ?? "Worktree is clean.",
        };
      },
    },
    {
      code: STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
      label: "Alertmanager must be quiet for remote-* alerts.",
      action:
        "Visit Alertmanager › remote-* group and resolve or silence outstanding alerts before dispatch resumes.",
      category: "alerts",
      run: async (ctx) => {
        const alerts = await ctx.listFiringAlerts();
        if (alerts.length === 0) {
          return { ok: true, detail: "No remote-* alerts are firing." };
        }
        return {
          ok: false,
          detail: `Blocking alerts: ${alerts.join(", ")}`,
        };
      },
    },
    {
      code: STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
      label: "Synthetic startup probe must complete under latency SLO.",
      action:
        "Re-run the synthetic probe (`bun run test --filter startup`) and repair LM Studio / remote dependencies if it keeps failing.",
      category: "synthetic",
      run: async (ctx, options) => {
        const maxLatencyMs =
          options.syntheticMaxLatencyMs ?? DEFAULT_SYNTHETIC_LATENCY_MS;
        const probeName = options.syntheticProbeName ?? DEFAULT_SYNTHETIC_PROBE;
        const result = await ctx.syntheticTester.runSyntheticJob({
          maxLatencyMs,
          probeName,
        });
        if (result.ok && result.latencyMs <= maxLatencyMs) {
          return {
            ok: true,
            detail: `${probeName} finished in ${result.latencyMs} ms.`,
          };
        }
        const latencyDetail = `${result.latencyMs} ms`;
        const failureDetail = result.failureDetail
          ? `: ${result.failureDetail}`
          : "";
        const detail = result.ok
          ? `${probeName} breached latency SLO (${latencyDetail} > ${maxLatencyMs} ms).`
          : `${probeName} failed${failureDetail} (observed ${latencyDetail}).`;
        return { ok: false, detail };
      },
    },
  ] satisfies readonly StartupCheckDefinition[],
);

export const STARTUP_CHECK_STRUCTURE = Object.freeze(
  [
    ...defaultChecks.map((check, index) => ({
      code: check.code,
      label: check.label,
      action: check.action,
      category: check.category,
      step: index + 1,
    })),
    {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: DISPATCH_CHECK_LABEL,
      action: DISPATCH_CHECK_ACTION,
      category: "dispatch",
      step: defaultChecks.length + 1,
    },
  ] satisfies readonly StartupCheckStructure[],
);

const nowMs = (ctx: StartupChecklistContext) =>
  ctx.now ? ctx.now() : Date.now();

const memoizeContext = (
  ctx: StartupChecklistContext,
): StartupChecklistContext => {
  let repoStatusPromise: Promise<RepoStatus> | undefined;
  return {
    ...ctx,
    describeRepo: () => {
      if (!repoStatusPromise) {
        repoStatusPromise = ctx.describeRepo();
      }
      return repoStatusPromise;
    },
  };
};

export class StartupChecklist {
  constructor(private readonly checks: readonly StartupCheckDefinition[]) {}

  async run(
    ctx: StartupChecklistContext,
    options: StartupChecklistOptions = {},
  ): Promise<StartupChecklistResult> {
    const history: StartupCheckRecord[] = [];
    for (const [index, check] of this.checks.entries()) {
      const step = index + 1;
      const startedAtMs = nowMs(ctx);
      let status: StartupCheckStatus = "pass";
      let detail = check.label;
      let failureErrorMessage: string | undefined;
      let failureErrorRaw: unknown;
      let failureErrorStack: string | undefined;
      let unknownErrorInfo: StartupCheckErrorInfo | null = null;
      try {
        const outcome = await check.run(ctx, options);
        status = outcome.ok ? "pass" : "fail";
        detail = outcome.detail ?? check.label;
      } catch (error) {
        status = "fail";
        const normalized = normalizeStartupCheckError(error, check.label);
        detail = normalized.message;
        failureErrorMessage = normalized.message;
        failureErrorRaw = normalized.raw;
        failureErrorStack = normalized.stack;
        unknownErrorInfo = normalized;
      }
      const endedAtMs = nowMs(ctx);
      const durationMs = Math.max(0, endedAtMs - startedAtMs);
      const record: StartupCheckRecord = {
        code: check.code,
        label: check.label,
        category: check.category,
        step,
        status,
        detail,
        action: status === "fail" ? check.action : undefined,
        elapsedMs: durationMs,
        durationMs,
        startedAtMs,
        endedAtMs,
        error:
          status === "fail" && failureErrorMessage
            ? { message: failureErrorMessage, raw: failureErrorRaw, stack: failureErrorStack }
            : undefined,
      };
      history.push(record);
      ctx.log?.(record);
      emitStartupPhaseTelemetry(ctx, record);
      if (unknownErrorInfo) {
        emitStartupUnknownFailureTelemetry(ctx, {
          code: check.code,
          label: check.label,
          step,
          detail,
          error: unknownErrorInfo,
          whenMs: endedAtMs,
        });
      }
      if (status === "fail") {
        return {
          ok: false,
          failure: {
            code: check.code,
            detail,
            action: check.action,
            category: check.category,
            step,
          },
          history,
        };
      }
    }
    return { ok: true, history };
  }
}

const buildDefaultChecklist = () => new StartupChecklist(defaultChecks);

export const runStartupPreflight = async (
  ctx: StartupChecklistContext,
  options: StartupChecklistOptions = {},
): Promise<StartupChecklistResult> => {
  const memoized = memoizeContext(ctx);
  return buildDefaultChecklist().run(memoized, options);
};

export const gateDispatchWithStartupPreflight = async (
  ctx: StartupChecklistContext,
  dispatchJob: () => Promise<void>,
  options: StartupChecklistOptions = {},
): Promise<StartupChecklistResult> => {
  const result = await runStartupPreflight(ctx, options);
  if (!result.ok) {
    return result;
  }
  const dispatchStep = result.history.length + 1;
  const dispatchLabel = DISPATCH_CHECK_LABEL;
  const dispatchAction = DISPATCH_CHECK_ACTION;
  const startedAtMs = nowMs(ctx);
  try {
    await dispatchJob();
    const endedAtMs = nowMs(ctx);
    const durationMs = Math.max(0, endedAtMs - startedAtMs);
    const successRecord: StartupCheckRecord = {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: dispatchLabel,
      category: "dispatch",
      step: dispatchStep,
      status: "pass",
      detail: "Dispatch completed successfully.",
      elapsedMs: durationMs,
      durationMs,
      startedAtMs,
      endedAtMs,
    };
    result.history.push(successRecord);
    ctx.log?.(successRecord);
    emitStartupPhaseTelemetry(ctx, successRecord);
    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown dispatch failure.";
    const detail = `Dispatch job failed: ${errorMessage}`;
    const endedAtMs = nowMs(ctx);
    const durationMs = Math.max(0, endedAtMs - startedAtMs);
    const failureRecord: StartupCheckRecord = {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: dispatchLabel,
      category: "dispatch",
      step: dispatchStep,
      status: "fail",
      detail,
      action: dispatchAction,
      elapsedMs: durationMs,
      durationMs,
      startedAtMs,
      endedAtMs,
      error: {
        message: detail,
        raw: error instanceof Error ? error : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      },
    };
    ctx.log?.(failureRecord);
    emitStartupPhaseTelemetry(ctx, failureRecord);
    emitStartupUnknownFailureTelemetry(ctx, {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: dispatchLabel,
      step: dispatchStep,
      detail,
      error: {
        message: detail,
        raw: error instanceof Error ? error : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      },
      whenMs: endedAtMs,
    });
    const history = [...result.history, failureRecord];
    return {
      ok: false,
      failure: {
        code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
        detail,
        action: dispatchAction,
        category: "dispatch",
        step: dispatchStep,
      },
      history,
    };
  }
};

type StartupCheckException = Error & { raw?: unknown };
type VersionParts = [number, number, number];

function wrapStartupCheckError(message: string, raw: unknown): StartupCheckException {
  const rawMessage =
    raw instanceof Error
      ? raw.message
      : typeof raw === "string" && raw.trim()
        ? raw.trim()
        : "";
  const detail = rawMessage ? `${message}: ${rawMessage}` : message;
  const error = new Error(detail) as StartupCheckException;
  error.raw = raw instanceof Error ? raw : rawMessage ? rawMessage : raw;
  if (raw instanceof Error && raw.stack) {
    error.stack = raw.stack;
  }
  return error;
}

function normalizeStartupCheckError(error: unknown, fallback: string): StartupCheckErrorInfo {
  if (error instanceof Error) {
    const withRaw = error as StartupCheckException;
    return {
      message: error.message || fallback,
      raw: withRaw.raw ?? error,
      stack: error.stack,
    };
  }
  if (typeof error === "string" && error.trim()) {
    return { message: error.trim(), raw: error };
  }
  return { message: fallback, raw: error };
}

function emitStartupPhaseTelemetry(ctx: StartupChecklistContext, record: StartupCheckRecord): void {
  if (!ctx.telemetry) return;
  const event: StartupTelemetryPhaseEvent = {
    type: "startup_phase",
    code: record.code,
    label: record.label,
    category: record.category,
    step: record.step,
    status: record.status,
    detail: record.detail,
    startedAtMs: record.startedAtMs,
    endedAtMs: record.endedAtMs,
    durationMs: record.durationMs,
    action: record.action,
    error: record.error,
  };
  ctx.telemetry(event);
}

function emitStartupUnknownFailureTelemetry(
  ctx: StartupChecklistContext,
  params: {
    code: StartupFailureCode;
    label: string;
    step: number;
    detail: string;
    error: StartupCheckErrorInfo;
    whenMs: number;
  },
): void {
  if (!ctx.telemetry) return;
  ctx.telemetry({
    type: "startup_unknown_failure",
    code: params.code,
    phase: params.label,
    step: params.step,
    whenMs: params.whenMs,
    error: {
      message: params.error.message || params.detail,
      raw: params.error.raw,
      stack: params.error.stack,
    },
  });
}

function normalizeVersionString(value: string): string {
  const [major, minor, patch] = parseVersionParts(value);
  return `${major}.${minor}.${patch}`;
}

function parseVersionParts(value: string): VersionParts {
  const normalized = String(value ?? "").trim();
  const match = normalized.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [0, 0, 0];
  const major = Number.parseInt(match[1] ?? "0", 10) || 0;
  const minor = Number.parseInt(match[2] ?? "0", 10) || 0;
  const patch = Number.parseInt(match[3] ?? "0", 10) || 0;
  return [major, minor, patch];
}

function compareSemverStrings(left: string, right: string): number {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}
