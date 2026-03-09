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
    stack?: string;
    raw?: unknown;
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

export interface StartupTelemetryErrorPayload {
  message: string;
  stack?: string;
  raw?: unknown;
}

export interface StartupTelemetryPhaseEvent {
  type: "startup_phase";
  code: StartupFailureCode;
  label: string;
  category: StartupCheckCategory;
  step: number;
  status: StartupCheckStatus;
  detail: string;
  action?: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  error?: StartupTelemetryErrorPayload;
}

export interface StartupTelemetryUnknownFailureEvent {
  type: "startup_unknown_failure";
  code: StartupFailureCode;
  phase: string;
  step: number;
  whenMs: number;
  error: StartupTelemetryErrorPayload;
}

export type StartupTelemetryEvent =
  | StartupTelemetryPhaseEvent
  | StartupTelemetryUnknownFailureEvent;

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
const BUN_CHECK_LABEL = "Bun runtime must meet the required version.";
const BUN_CHECK_ACTION =
  "Install Bun 1.1+ (`bun upgrade` or reinstall from bun.sh) before running RemoteBuddy dispatch.";
const DOCKER_CHECK_LABEL = "Docker runtime must meet the required version.";
const DOCKER_CHECK_ACTION =
  "Upgrade Docker Desktop/Engine to v24+ (or set startup.skip_docker_preflight=true) before dispatch.";
const VERSION_MATCH_RE = /\d+(?:\.\d+){0,3}/;

const sanitizeVersionText = (raw: string): string => String(raw ?? "").trim();

const extractVersionNumber = (raw: string): string | null => {
  const match = sanitizeVersionText(raw).match(VERSION_MATCH_RE);
  return match ? match[0] : null;
};

const compareVersionStrings = (aRaw: string, bRaw: string): number => {
  const aParts = extractVersionNumber(aRaw)?.split(".") ?? [];
  const bParts = extractVersionNumber(bRaw)?.split(".") ?? [];
  const maxParts = Math.max(aParts.length, bParts.length, 3);
  for (let i = 0; i < maxParts; i += 1) {
    const aVal = Number.parseInt(aParts[i] ?? "0", 10) || 0;
    const bVal = Number.parseInt(bParts[i] ?? "0", 10) || 0;
    if (aVal !== bVal) return aVal - bVal;
  }
  return 0;
};

const skipDetail = (runtimeName: string): string =>
  `${runtimeName} version check skipped: probe unavailable.`;

const formatInvalidVersionDetail = (runtimeName: string, value: string): string => {
  const detail = sanitizeVersionText(value) || "(empty)";
  return `${runtimeName} version probe returned invalid value: ${detail}.`;
};

const formatVersionTooLowDetail = (
  runtimeName: string,
  observed: string,
  required: string,
): string => `${runtimeName} version ${observed} is below required ${required}.`;

const formatVersionDetectedDetail = (runtimeName: string, version: string): string =>
  `${runtimeName} version ${version} detected.`;

const wrapProbeError = (runtimeName: string, error: unknown): Error => {
  if (error instanceof Error) {
    const suffix = error.message ? `: ${error.message}` : "";
    error.message = `${runtimeName} version probe failed${suffix}`;
    return error;
  }
  const detail = String(error ?? "unknown error");
  return new Error(`${runtimeName} version probe failed: ${detail}`);
};

const buildTelemetryErrorPayload = (
  error: unknown,
): StartupTelemetryErrorPayload | undefined => {
  if (!error) return undefined;
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, raw: error };
  }
  const message = typeof error === "string" && error.trim() ? error.trim() : "Unknown error";
  return { message, raw: error };
};

const emitTelemetrySafe = (
  ctx: StartupChecklistContext,
  eventFactory: () => StartupTelemetryEvent,
): void => {
  if (!ctx.telemetry) return;
  try {
    ctx.telemetry(eventFactory());
  } catch (err) {
    console.warn(`[StartupChecklist] telemetry handler failed: ${String(err)}`);
  }
};

const emitPhaseTelemetry = (
  ctx: StartupChecklistContext,
  record: StartupCheckRecord,
): void => {
  emitTelemetrySafe(ctx, () => ({
    type: "startup_phase",
    code: record.code,
    label: record.label,
    category: record.category,
    step: record.step,
    status: record.status,
    detail: record.detail,
    action: record.action,
    startedAtMs: record.startedAtMs,
    endedAtMs: record.endedAtMs,
    durationMs: record.durationMs,
    ...(record.error ? { error: record.error } : {}),
  }));
};

const emitUnknownFailureTelemetry = (
  ctx: StartupChecklistContext,
  params: {
    code: StartupFailureCode;
    phase: string;
    step: number;
    whenMs: number;
    error: StartupTelemetryErrorPayload;
  },
): void => {
  emitTelemetrySafe(ctx, () => ({
    type: "startup_unknown_failure",
    code: params.code,
    phase: params.phase,
    step: params.step,
    whenMs: params.whenMs,
    error: params.error,
  }));
};

const defaultChecks = Object.freeze(
  [
    {
      code: STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
      label: BUN_CHECK_LABEL,
      action: BUN_CHECK_ACTION,
      category: "runtime",
      run: async (ctx) => {
        if (typeof ctx.readBunVersion !== "function") {
          return { ok: true, detail: skipDetail("Bun") };
        }
        let versionText: string;
        try {
          versionText = sanitizeVersionText(await ctx.readBunVersion());
        } catch (error) {
          throw wrapProbeError("Bun", error);
        }
        const parsed = extractVersionNumber(versionText);
        if (!parsed) {
          return { ok: false, detail: formatInvalidVersionDetail("Bun", versionText) };
        }
        if (compareVersionStrings(parsed, MIN_BUN_VERSION) < 0) {
          return { ok: false, detail: formatVersionTooLowDetail("Bun", parsed, MIN_BUN_VERSION) };
        }
        return { ok: true, detail: formatVersionDetectedDetail("Bun", parsed) };
      },
    },
    {
      code: STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
      label: DOCKER_CHECK_LABEL,
      action: DOCKER_CHECK_ACTION,
      category: "infrastructure",
      run: async (ctx) => {
        if (typeof ctx.readDockerVersion !== "function") {
          return { ok: true, detail: skipDetail("Docker") };
        }
        let versionText: string;
        try {
          versionText = sanitizeVersionText(await ctx.readDockerVersion());
        } catch (error) {
          throw wrapProbeError("Docker", error);
        }
        const parsed = extractVersionNumber(versionText);
        if (!parsed) {
          return { ok: false, detail: formatInvalidVersionDetail("Docker", versionText) };
        }
        if (compareVersionStrings(parsed, MIN_DOCKER_VERSION) < 0) {
          return {
            ok: false,
            detail: formatVersionTooLowDetail("Docker", parsed, MIN_DOCKER_VERSION),
          };
        }
        return { ok: true, detail: formatVersionDetectedDetail("Docker", parsed) };
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
      try {
        const outcome = await check.run(ctx, options);
        status = outcome.ok ? "pass" : "fail";
        detail = outcome.detail ?? check.label;
      } catch (error) {
        status = "fail";
        detail =
          error instanceof Error
            ? error.message
            : "Unknown error running startup check.";
        failureErrorRaw = error;
        if (error instanceof Error) {
          failureErrorMessage = error.message;
        } else if (typeof error === "string" && error.trim()) {
          failureErrorMessage = error.trim();
        }
      }
      const endedAtMs = nowMs(ctx);
      const durationMs = Math.max(0, endedAtMs - startedAtMs);
      const telemetryError =
        failureErrorRaw !== undefined ? buildTelemetryErrorPayload(failureErrorRaw) : undefined;
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
          telemetryError ??
          (status === "fail" && failureErrorMessage ? { message: failureErrorMessage } : undefined),
      };
      history.push(record);
      ctx.log?.(record);
      if (telemetryError) {
        emitUnknownFailureTelemetry(ctx, {
          code: check.code,
          phase: check.label,
          step,
          whenMs: endedAtMs,
          error: telemetryError,
        });
      }
      emitPhaseTelemetry(ctx, record);
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
    emitPhaseTelemetry(ctx, successRecord);
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
      error: { message: errorMessage },
    };
    ctx.log?.(failureRecord);
    emitPhaseTelemetry(ctx, failureRecord);
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
