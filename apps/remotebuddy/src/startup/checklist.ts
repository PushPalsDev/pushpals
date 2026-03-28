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

export interface StartupTelemetryPhaseEvent {
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
}

export interface StartupTelemetryUnknownFailureEvent {
  type: "startup_unknown_failure";
  code: StartupFailureCode;
  phase: string;
  step: number;
  whenMs: number;
  error: {
    message: string;
    raw?: unknown;
  };
}

export type StartupTelemetryEvent =
  | StartupTelemetryPhaseEvent
  | StartupTelemetryUnknownFailureEvent;

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

const normalizeVersion = (value: string | null | undefined): string =>
  typeof value === "string" ? value.trim() : "";

const parseVersionParts = (value: string): number[] =>
  normalizeVersion(value)
    .split(/[^\d]+/g)
    .filter(Boolean)
    .map((part) => {
      const asNumber = Number(part);
      return Number.isFinite(asNumber) ? asNumber : 0;
    });

const compareVersions = (actual: string, minimum: string): number => {
  const actualParts = parseVersionParts(actual);
  const minimumParts = parseVersionParts(minimum);
  if (actualParts.length === 0 || minimumParts.length === 0) return 0;
  const maxLength = Math.max(actualParts.length, minimumParts.length);
  for (let i = 0; i < maxLength; i += 1) {
    const a = actualParts[i] ?? 0;
    const b = minimumParts[i] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
};

const defaultChecks = Object.freeze(
  [
  {
    code: STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    label: `Bun runtime must be >= ${MIN_BUN_VERSION}.`,
    action: "Upgrade to Bun 1.1+ (`bun upgrade` or reinstall the runtime).",
    category: "runtime",
    run: async (ctx) => {
      let versionValue: string;
      try {
        versionValue = await ctx.readBunVersion();
      } catch (error) {
        if (error instanceof Error) {
          error.message = `Bun version probe failed: ${error.message}`;
          throw error;
        }
        throw new Error(
          `Bun version probe failed: ${typeof error === "string" ? error : "unknown error"}`,
        );
      }
      const version = normalizeVersion(versionValue);
      if (!version) {
        return {
          ok: false,
          detail: `Bun runtime version not detected; minimum supported version is ${MIN_BUN_VERSION}.`,
        };
      }
      if (parseVersionParts(version).length === 0) {
        return {
          ok: false,
          detail: `Unable to parse Bun runtime version "${version}".`,
        };
      }
      if (compareVersions(version, MIN_BUN_VERSION) < 0) {
        return {
          ok: false,
          detail: `Bun runtime ${version} detected; minimum supported version is ${MIN_BUN_VERSION}.`,
        };
      }
      return {
        ok: true,
        detail: `Bun runtime ${version} satisfies minimum ${MIN_BUN_VERSION}.`,
      };
    },
  },
  {
    code: STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
    label: `Docker Engine must be >= ${MIN_DOCKER_VERSION}.`,
    action: "Upgrade Docker Engine/Desktop to a supported version (25.x or newer) before dispatch.",
    category: "infrastructure",
    run: async (ctx) => {
      let versionValue: string;
      try {
        versionValue = await ctx.readDockerVersion();
      } catch (error) {
        if (error instanceof Error) {
          error.message = `Docker version probe failed: ${error.message}`;
          throw error;
        }
        throw new Error(
          `Docker version probe failed: ${typeof error === "string" ? error : "unknown error"}`,
        );
      }
      const version = normalizeVersion(versionValue);
      if (!version) {
        return {
          ok: false,
          detail: `Docker version not detected; minimum supported version is ${MIN_DOCKER_VERSION}.`,
        };
      }
      if (parseVersionParts(version).length === 0) {
        return {
          ok: false,
          detail: `Unable to parse Docker version "${version}".`,
        };
      }
      if (compareVersions(version, MIN_DOCKER_VERSION) < 0) {
        return {
          ok: false,
          detail: `Docker version ${version} detected; minimum supported version is ${MIN_DOCKER_VERSION}.`,
        };
      }
      return {
        ok: true,
        detail: `Docker version ${version} satisfies minimum ${MIN_DOCKER_VERSION}.`,
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

const emitPhaseTelemetry = (
  ctx: StartupChecklistContext,
  event: Omit<StartupTelemetryPhaseEvent, "type">,
) => {
  ctx.telemetry?.({
    type: "startup_phase",
    ...event,
  });
};

const emitUnknownFailureTelemetry = (
  ctx: StartupChecklistContext,
  event: Omit<StartupTelemetryUnknownFailureEvent, "type">,
) => {
  ctx.telemetry?.({
    type: "startup_unknown_failure",
    ...event,
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
        detail =
          error instanceof Error
            ? error.message
            : "Unknown error running startup check.";
        if (error instanceof Error) {
          failureErrorMessage = error.message;
        } else if (typeof error === "string" && error.trim()) {
          failureErrorMessage = error.trim();
        }
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
        error: status === "fail" && failureErrorMessage ? { message: failureErrorMessage } : undefined,
      };
      history.push(record);
      ctx.log?.(record);
      emitPhaseTelemetry(ctx, {
        code: check.code,
        category: check.category,
        step,
        status,
        detail,
        startedAtMs,
        endedAtMs,
        durationMs,
        error: thrownError
          ? {
              message: detail,
              raw: thrownError,
              stack: thrownError instanceof Error ? thrownError.stack : undefined,
            }
          : undefined,
      });
      if (thrownError) {
        emitUnknownFailureTelemetry(ctx, {
          code: check.code,
          phase: check.label,
          step,
          whenMs: endedAtMs,
          error: {
            message: detail,
            raw: thrownError,
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
    const rawError = error;
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
      error: { message: errorMessage },
    };
    ctx.log?.(failureRecord);
    const history = [...result.history, failureRecord];
    emitPhaseTelemetry(ctx, {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      category: "dispatch",
      step: dispatchStep,
      status: "fail",
      detail,
      startedAtMs,
      endedAtMs,
      durationMs,
      error: {
        message: detail,
        raw: rawError,
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
    emitUnknownFailureTelemetry(ctx, {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      phase: DISPATCH_CHECK_LABEL,
      step: dispatchStep,
      whenMs: endedAtMs,
      error: {
        message: detail,
        raw: rawError,
      },
    });
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
