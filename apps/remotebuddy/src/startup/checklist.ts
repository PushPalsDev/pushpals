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

export interface StartupTelemetryPhaseEvent {
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
  error?: {
    message: string;
    stack?: string;
    raw?: unknown;
  };
}

export interface StartupTelemetryUnknownFailureEvent {
  type: "startup_unknown_failure";
  code: StartupFailureCode;
  category: StartupCheckCategory;
  step: number;
  phase: string;
  whenMs: number;
  error: {
    message: string;
    stack?: string;
    raw?: unknown;
  };
}

export type StartupTelemetryEvent =
  | StartupTelemetryPhaseEvent
  | StartupTelemetryUnknownFailureEvent;

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

export interface StartupChecklistContext {
  describeRepo(): Promise<RepoStatus>;
  listFiringAlerts(): Promise<string[]>;
  syntheticTester: SyntheticStartupTester;
  readBunVersion?: () => Promise<string>;
  readDockerVersion?: () => Promise<string>;
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

const MIN_BUN_VERSION_LABEL = "1.1.0";
const MIN_BUN_VERSION_SEGMENTS = [1, 1, 0] as const;
const MIN_DOCKER_VERSION_LABEL = "24.0.0";
const MIN_DOCKER_VERSION_SEGMENTS = [24, 0, 0] as const;

type WrappedProbeError = Error & { raw?: unknown };

function parseSemverSegments(value: string): number[] | null {
  if (!value) return null;
  const match = value.trim().match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number(match[1] ?? 0);
  const minor = Number(match[2] ?? 0);
  const patch = Number(match[3] ?? 0);
  if ([major, minor, patch].some((part) => Number.isNaN(part))) return null;
  return [major, minor, patch];
}

function compareSemverSegments(
  actual: number[],
  floor: readonly number[],
): number {
  const length = Math.max(actual.length, floor.length);
  for (let i = 0; i < length; i += 1) {
    const a = actual[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function wrapProbeError(message: string, error: unknown): WrappedProbeError {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string" && error.trim()
        ? error.trim()
        : "Unknown error";
  const wrapped = new Error(`${message}: ${detail}`) as WrappedProbeError;
  wrapped.raw = error ?? detail;
  return wrapped;
}

const DEFAULT_SYNTHETIC_LATENCY_MS = 850;
const DEFAULT_SYNTHETIC_PROBE = "probe.remote_startup";
const DISPATCH_CHECK_LABEL = "Job dispatch must succeed.";
const DISPATCH_CHECK_ACTION =
  "Inspect RemoteBuddy + WorkerPals logs, repair dependencies, then rerun dispatch.";

const defaultChecks = Object.freeze(
  [
    {
      code: STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
      label: "Bun runtime must meet support floor.",
      action: `Install Bun ${MIN_BUN_VERSION_LABEL}+ (bun upgrade) before running RemoteBuddy dispatch.`,
      category: "runtime",
      run: async (ctx) => {
        if (!ctx.readBunVersion) {
          return {
            ok: false,
            detail: "Bun runtime version probe unavailable (readBunVersion missing).",
          };
        }
        let versionText = "";
        try {
          versionText = (await ctx.readBunVersion())?.trim() ?? "";
        } catch (error) {
          throw wrapProbeError("Bun version probe failed", error);
        }
        if (!versionText) {
          return {
            ok: false,
            detail: "Bun runtime version probe returned an empty result.",
          };
        }
        const parsed = parseSemverSegments(versionText);
        if (!parsed) {
          return {
            ok: false,
            detail: `Bun runtime reported an unparseable version: ${versionText}`,
          };
        }
        if (compareSemverSegments(parsed, MIN_BUN_VERSION_SEGMENTS) < 0) {
          return {
            ok: false,
            detail: `Bun runtime ${versionText} is below the supported floor (${MIN_BUN_VERSION_LABEL}).`,
          };
        }
        return {
          ok: true,
          detail: `Bun runtime ${versionText} meets the support floor.`,
        };
      },
    },
    {
      code: STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
      label: "Docker engine must meet support floor.",
      action:
        `Upgrade Docker Desktop/Engine to ${MIN_DOCKER_VERSION_LABEL}+ and restart the daemon before dispatch.`,
      category: "infrastructure",
      run: async (ctx) => {
        if (!ctx.readDockerVersion) {
          return {
            ok: false,
            detail: "Docker version probe unavailable (readDockerVersion missing).",
          };
        }
        let versionText = "";
        try {
          versionText = (await ctx.readDockerVersion())?.trim() ?? "";
        } catch (error) {
          throw wrapProbeError("Docker version probe failed", error);
        }
        if (!versionText) {
          return {
            ok: false,
            detail: "Docker version probe returned an empty result.",
          };
        }
        const parsed = parseSemverSegments(versionText);
        if (!parsed) {
          return {
            ok: false,
            detail: `Docker engine reported an unparseable version: ${versionText}`,
          };
        }
        if (compareSemverSegments(parsed, MIN_DOCKER_VERSION_SEGMENTS) < 0) {
          return {
            ok: false,
            detail: `Docker engine ${versionText} is below the supported floor (${MIN_DOCKER_VERSION_LABEL}).`,
          };
        }
        return {
          ok: true,
          detail: `Docker engine ${versionText} meets the support floor.`,
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

const emitTelemetryEvent = (
  ctx: StartupChecklistContext,
  event: StartupTelemetryEvent,
): void => {
  ctx.telemetry?.(event);
};

const extractRawError = (error: unknown): unknown => {
  if (
    error &&
    typeof error === "object" &&
    "raw" in (error as Record<string, unknown>)
  ) {
    return (error as Record<string, unknown>).raw;
  }
  return error;
};

const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message || "Unknown error";
  if (typeof error === "string" && error.trim()) return error.trim();
  if (
    error &&
    typeof error === "object" &&
    "message" in (error as Record<string, unknown>) &&
    typeof (error as Record<string, unknown>).message === "string"
  ) {
    const message = ((error as Record<string, unknown>).message as string).trim();
    if (message) return message;
  }
  return "Unknown error";
};

const buildTelemetryErrorPayload = (
  error: unknown,
): NonNullable<StartupTelemetryPhaseEvent["error"]> => {
  if (error instanceof Error) {
    return {
      message: error.message || "Unknown error",
      stack: error.stack,
      raw: extractRawError(error),
    };
  }
  const message = describeError(error);
  return {
    message,
    raw: extractRawError(error),
  };
};

const emitPhaseTelemetry = (
  ctx: StartupChecklistContext,
  payload: Omit<StartupTelemetryPhaseEvent, "type">,
): void => {
  emitTelemetryEvent(ctx, {
    type: "startup_phase",
    ...payload,
  });
};

const emitUnknownFailureTelemetry = (
  ctx: StartupChecklistContext,
  check: StartupCheckDefinition,
  step: number,
  error: unknown,
): void => {
  emitTelemetryEvent(ctx, {
    type: "startup_unknown_failure",
    code: check.code,
    category: check.category,
    step,
    phase: check.label,
    whenMs: nowMs(ctx),
    error: buildTelemetryErrorPayload(error),
  });
};

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
      let thrownError: unknown;
      try {
        const outcome = await check.run(ctx, options);
        status = outcome.ok ? "pass" : "fail";
        detail = outcome.detail ?? check.label;
      } catch (error) {
        thrownError = error;
        status = "fail";
        detail = describeError(error);
        failureErrorMessage = detail;
        emitUnknownFailureTelemetry(ctx, check, step, error);
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
            ? { message: failureErrorMessage }
            : undefined,
      };
      history.push(record);
      ctx.log?.(record);
      emitPhaseTelemetry(ctx, {
        code: check.code,
        label: check.label,
        category: check.category,
        step,
        status,
        detail,
        startedAtMs,
        endedAtMs,
        durationMs,
        ...(thrownError ? { error: buildTelemetryErrorPayload(thrownError) } : {}),
      });
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
    emitPhaseTelemetry(ctx, {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: dispatchLabel,
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
    const errorMessage = describeError(error);
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
      error: { message: errorMessage },
    };
    ctx.log?.(failureRecord);
    emitPhaseTelemetry(ctx, {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: dispatchLabel,
      category: "dispatch",
      step: dispatchStep,
      status: "fail",
      detail,
      startedAtMs,
      endedAtMs,
      durationMs,
      error: buildTelemetryErrorPayload(error),
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
