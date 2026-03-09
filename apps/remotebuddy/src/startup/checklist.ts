/**
 * Deterministic startup preflight checklist plus a synthetic dispatch guard.
 * The helper executes each check sequentially, surfaces actionable failure codes,
 * and optionally blocks job dispatch until a synthetic probe completes.
 */
export const STARTUP_FAILURE_CODES = Object.freeze({
  BUN_VERSION_UNSUPPORTED: "startup.bun_version_unsupported",
  DOCKER_VERSION_UNSUPPORTED: "startup.docker_version_unsupported",
  MERGE_IN_PROGRESS: "startup.merge_in_progress",
  REPO_DIRTY: "startup.repo_dirty",
  ALERTS_ACTIVE: "startup.alerts_active",
  SYNTHETIC_FAILED: "startup.synthetic_failed",
  DISPATCH_FAILED: "startup.dispatch_failed",
} as const);

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

export type StartupTelemetryPhaseEvent = {
  type: "startup_phase";
  code: StartupFailureCode;
  category: StartupCheckCategory;
  step: number;
  status: StartupCheckStatus;
  detail: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
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

export interface StartupChecklistContext {
  describeRepo(): Promise<RepoStatus>;
  listFiringAlerts(): Promise<string[]>;
  syntheticTester: SyntheticStartupTester;
  readBunVersion?: () => Promise<string>;
  readDockerVersion?: () => Promise<string>;
  telemetry?: (event: StartupTelemetryEvent) => void;
  now?: () => number;
  log?: (entry: StartupCheckRecord) => void;
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
const MIN_DOCKER_VERSION = "24.0.0";
const asVersionString = (value: unknown): string => String(value ?? "").trim();

class StartupCheckError extends Error {
  constructor(message: string, public readonly raw?: unknown) {
    super(message);
    this.name = "StartupCheckError";
  }
}

const defaultChecks = Object.freeze(
  [
  {
    code: STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    label: "Bun runtime must meet the supported version.",
    action: "Install Bun 1.1.x or newer before starting RemoteBuddy dispatch.",
    category: "runtime",
    run: async (ctx) => {
      const reader =
        ctx.readBunVersion ??
        (async () => {
          const detected = typeof process !== "undefined" ? process.versions?.bun : undefined;
          return asVersionString(detected);
        });
      let version: string;
      try {
        version = asVersionString(await reader());
      } catch (error) {
        throw new StartupCheckError("Bun version probe failed", error);
      }
      if (!version) {
        throw new StartupCheckError("Bun version probe failed: version not detected.");
      }
      if (compareVersions(version, MIN_BUN_VERSION) < 0) {
        return {
          ok: false,
          detail: `Bun ${version} is below the required ${MIN_BUN_VERSION}.`,
        };
      }
      return {
        ok: true,
        detail: `Bun runtime OK (${version}).`,
      };
    },
  },
  {
    code: STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
    label: "Docker runtime must meet the supported version.",
    action: "Upgrade Docker to 24.x or newer before enabling RemoteBuddy dispatch.",
    category: "infrastructure",
    run: async (ctx) => {
      const reader =
        ctx.readDockerVersion ??
        (async () => {
          const detected = typeof process !== "undefined" ? process.env?.DOCKER_VERSION : undefined;
          return asVersionString(detected);
        });
      let version: string;
      try {
        version = asVersionString(await reader());
      } catch (error) {
        throw new StartupCheckError("Docker version probe failed", error);
      }
      if (!version) {
        throw new StartupCheckError("Docker version probe failed: version not detected.");
      }
      if (compareVersions(version, MIN_DOCKER_VERSION) < 0) {
        return {
          ok: false,
          detail: `Docker ${version} is below the required ${MIN_DOCKER_VERSION}.`,
        };
      }
      return {
        ok: true,
        detail: `Docker runtime OK (${version}).`,
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
    const emitTelemetry = (event: StartupTelemetryEvent): void => {
      ctx.telemetry?.(event);
    };
    for (const [index, check] of this.checks.entries()) {
      const step = index + 1;
      const startedAtMs = nowMs(ctx);
      let status: StartupCheckStatus = "pass";
      let detail = check.label;
      let failureErrorMessage: string | undefined;
      let failureRawError: unknown;
      let failureErrorStack: string | undefined;
      let threwError = false;
      try {
        const outcome = await check.run(ctx, options);
        status = outcome.ok ? "pass" : "fail";
        detail = outcome.detail ?? check.label;
      } catch (error) {
        status = "fail";
        threwError = true;
        const normalized = normalizeStartupError(error);
        detail = normalized.message;
        failureErrorMessage = normalized.message;
        failureRawError = normalized.raw;
        failureErrorStack = normalized.stack;
      }
      const endedAtMs = nowMs(ctx);
      const durationMs = Math.max(0, endedAtMs - startedAtMs);
      const recordError =
        status === "fail" && (failureErrorMessage || failureRawError)
          ? {
              message: failureErrorMessage ?? detail,
              raw: failureRawError,
              stack: failureErrorStack,
            }
          : undefined;
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
        error: recordError,
      };
      history.push(record);
      ctx.log?.(record);
      emitTelemetry({
        type: "startup_phase",
        code: check.code,
        category: check.category,
        step,
        status,
        detail,
        startedAtMs,
        endedAtMs,
        durationMs,
        error: recordError,
      });
      if (status === "fail" && threwError) {
        emitTelemetry({
          type: "startup_unknown_failure",
          code: check.code,
          phase: check.label,
          step,
          whenMs: endedAtMs,
          error: {
            message: detail,
            raw: failureRawError ?? failureErrorMessage ?? detail,
            stack: failureErrorStack,
          },
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
  const emitTelemetry = (event: StartupTelemetryEvent): void => {
    ctx.telemetry?.(event);
  };
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
    emitTelemetry({
      type: "startup_phase",
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      category: "dispatch",
      step: dispatchStep,
      status: "pass",
      detail: successRecord.detail,
      startedAtMs,
      endedAtMs,
      durationMs,
    });
    return result;
  } catch (error) {
    const normalized = normalizeStartupError(error);
    const errorMessage = normalized.message;
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
        message: errorMessage,
        raw: normalized.raw,
        stack: normalized.stack,
      },
    };
    ctx.log?.(failureRecord);
    emitTelemetry({
      type: "startup_phase",
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      category: "dispatch",
      step: dispatchStep,
      status: "fail",
      detail,
      startedAtMs,
      endedAtMs,
      durationMs,
      error: {
        message: errorMessage,
        raw: normalized.raw,
        stack: normalized.stack,
      },
    });
    emitTelemetry({
      type: "startup_unknown_failure",
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      phase: dispatchLabel,
      step: dispatchStep,
      whenMs: endedAtMs,
      error: {
        message: detail,
        raw: normalized.raw ?? errorMessage,
        stack: normalized.stack,
      },
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

type NormalizedStartupError = {
  message: string;
  raw?: unknown;
  stack?: string;
};

function parseVersionSegments(version: string): number[] {
  return version
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((segment) => Number.parseInt(segment, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const aSegments = parseVersionSegments(a);
  const bSegments = parseVersionSegments(b);
  const maxLen = Math.max(aSegments.length, bSegments.length, 3);
  for (let i = 0; i < maxLen; i += 1) {
    const diff = (aSegments[i] ?? 0) - (bSegments[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function normalizeStartupError(error: unknown): NormalizedStartupError {
  if (error instanceof StartupCheckError) {
    const raw = error.raw ?? error;
    const stack =
      error.raw instanceof Error
        ? error.raw.stack ?? error.stack
        : error instanceof Error
          ? error.stack
          : undefined;
    return {
      message: error.message || "Unknown error running startup check.",
      raw,
      stack,
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message || "Unknown error running startup check.",
      raw: error,
      stack: error.stack,
    };
  }
  if (typeof error === "string" && error.trim()) {
    return {
      message: error.trim(),
      raw: error.trim(),
    };
  }
  return {
    message: "Unknown error running startup check.",
    raw: error,
  };
}
