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

export type StartupFailureCode = (typeof STARTUP_FAILURE_CODES)[keyof typeof STARTUP_FAILURE_CODES];

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
  runSyntheticJob: (options: SyntheticStartupTestOptions) => Promise<SyntheticStartupTestResult>;
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

export interface StartupTelemetryPhaseEvent {
  type: "startup_phase";
  code: StartupFailureCode;
  phase: string;
  category: StartupCheckCategory;
  step: number;
  status: StartupCheckStatus;
  detail: string;
  action?: string;
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
  phase: string;
  category: StartupCheckCategory;
  step: number;
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
  readBunVersion(): Promise<string>;
  readDockerVersion(): Promise<string>;
  describeRepo(): Promise<RepoStatus>;
  listFiringAlerts(): Promise<string[]>;
  syntheticTester: SyntheticStartupTester;
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
const MINIMUM_BUN_VERSION = [1, 1, 0] as const;
const MINIMUM_DOCKER_VERSION = [24, 0, 0] as const;
const DISPATCH_CHECK_LABEL = "Job dispatch must succeed.";
const DISPATCH_CHECK_ACTION =
  "Inspect RemoteBuddy + WorkerPals logs, repair dependencies, then rerun dispatch.";

function parseVersion(value: string): [number, number, number] | undefined {
  const match = String(value)
    .trim()
    .match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < 3; index += 1) {
    const actualPart = actual[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (actualPart !== minimumPart) return actualPart > minimumPart;
  }
  return true;
}

const defaultChecks = Object.freeze([
  {
    code: STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    label: "Bun runtime must meet the supported version floor.",
    action: "Install Bun 1.1 or newer, then rerun the startup preflight.",
    category: "runtime",
    run: async (ctx) => {
      const value = await ctx.readBunVersion();
      const parsed = parseVersion(value);
      if (!parsed || !versionAtLeast(parsed, MINIMUM_BUN_VERSION)) {
        return {
          ok: false,
          detail: `Bun ${value || "(unknown)"} is below the supported 1.1.0 floor.`,
        };
      }
      return { ok: true, detail: `Bun ${value} meets the supported version floor.` };
    },
  },
  {
    code: STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
    label: "Docker runtime must meet the supported version floor.",
    action: "Install Docker 24 or newer, then rerun the startup preflight.",
    category: "infrastructure",
    run: async (ctx) => {
      const value = await ctx.readDockerVersion();
      const parsed = parseVersion(value);
      if (!parsed || !versionAtLeast(parsed, MINIMUM_DOCKER_VERSION)) {
        return {
          ok: false,
          detail: `Docker ${value || "(unknown)"} is below the supported 24.0.0 floor.`,
        };
      }
      return { ok: true, detail: `Docker ${value} meets the supported version floor.` };
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
          status.detail ?? `Merge or rebase detected${branchHint}; startup cannot continue.`;
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
      const maxLatencyMs = options.syntheticMaxLatencyMs ?? DEFAULT_SYNTHETIC_LATENCY_MS;
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
      const failureDetail = result.failureDetail ? `: ${result.failureDetail}` : "";
      const detail = result.ok
        ? `${probeName} breached latency SLO (${latencyDetail} > ${maxLatencyMs} ms).`
        : `${probeName} failed${failureDetail} (observed ${latencyDetail}).`;
      return { ok: false, detail };
    },
  },
] satisfies readonly StartupCheckDefinition[]);

export const STARTUP_CHECK_STRUCTURE = Object.freeze([
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
] satisfies readonly StartupCheckStructure[]);

const nowMs = (ctx: StartupChecklistContext) => (ctx.now ? ctx.now() : Date.now());

function startupErrorMessage(code: StartupFailureCode, error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string" && error.trim()
        ? error.trim()
        : "Unknown error running startup check.";
  if (code === STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED) {
    return `Bun version probe failed: ${message}`;
  }
  if (code === STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED) {
    return `Docker version probe failed: ${message}`;
  }
  return message;
}

function startupErrorPayload(message: string, error: unknown) {
  return {
    message,
    stack: error instanceof Error ? error.stack : undefined,
    raw: error,
  };
}

function emitStartupRecord(
  ctx: StartupChecklistContext,
  record: StartupCheckRecord,
  rawError?: unknown,
): void {
  ctx.log?.(record);
  if (rawError !== undefined && record.error) {
    ctx.telemetry?.({
      type: "startup_unknown_failure",
      code: record.code,
      phase: record.label,
      category: record.category,
      step: record.step,
      whenMs: record.endedAtMs,
      error: startupErrorPayload(record.error.message, rawError),
    });
  }
  ctx.telemetry?.({
    type: "startup_phase",
    code: record.code,
    phase: record.label,
    category: record.category,
    step: record.step,
    status: record.status,
    detail: record.detail,
    action: record.action,
    startedAtMs: record.startedAtMs,
    endedAtMs: record.endedAtMs,
    durationMs: record.durationMs,
    error: record.error,
  });
}

const memoizeContext = (ctx: StartupChecklistContext): StartupChecklistContext => {
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
      let rawFailure: unknown;
      try {
        const outcome = await check.run(ctx, options);
        status = outcome.ok ? "pass" : "fail";
        detail = outcome.detail ?? check.label;
      } catch (error) {
        status = "fail";
        rawFailure = error;
        detail = startupErrorMessage(check.code, error);
        failureErrorMessage = detail;
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
            ? startupErrorPayload(failureErrorMessage, rawFailure)
            : undefined,
      };
      history.push(record);
      emitStartupRecord(ctx, record, rawFailure);
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
    emitStartupRecord(ctx, successRecord);
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
    emitStartupRecord(ctx, failureRecord, error);
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
