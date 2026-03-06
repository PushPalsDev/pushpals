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

export interface StartupChecklistContext {
  describeRepo(): Promise<RepoStatus>;
  listFiringAlerts(): Promise<string[]>;
  syntheticTester: SyntheticStartupTester;
  now?: () => number;
  log?: (entry: StartupCheckRecord) => void;
  telemetry?: (event: StartupTelemetryEvent) => void;
  readBunVersion?: () => Promise<string>;
  readDockerVersion?: () => Promise<string>;
}

export interface StartupTelemetryError {
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
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  error?: StartupTelemetryError;
}

export interface StartupTelemetryUnknownFailureEvent {
  type: "startup_unknown_failure";
  code: StartupFailureCode;
  phase: string;
  step: number;
  whenMs: number;
  error: StartupTelemetryError;
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

const MIN_BUN_VERSION = "1.1.0";
const MIN_DOCKER_VERSION = "24.0.0";

type ParsedVersion = {
  value: string;
  parts: [number, number, number];
};

const VERSION_PATTERN = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

const parseVersion = (raw: string): ParsedVersion | null => {
  const match = raw.match(VERSION_PATTERN);
  if (!match) return null;
  const parts = [
    Number(match[1] ?? "0"),
    Number(match[2] ?? "0"),
    Number(match[3] ?? "0"),
  ] as [number, number, number];
  if (parts.some((value) => Number.isNaN(value))) return null;
  return {
    value: `${parts[0]}.${parts[1]}.${parts[2]}`,
    parts,
  };
};

const compareVersions = (
  a: [number, number, number],
  b: [number, number, number],
): number => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
};

const MIN_BUN_VERSION_PARSED = parseVersion(MIN_BUN_VERSION)!;
const MIN_DOCKER_VERSION_PARSED = parseVersion(MIN_DOCKER_VERSION)!;

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error.";
};

class StartupCheckProbeError extends Error {
  constructor(
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "StartupCheckProbeError";
  }
}

const readVersionOrThrow = async (
  reader: () => Promise<string>,
  productName: string,
): Promise<string> => {
  try {
    const value = await reader();
    return String(value ?? "").trim();
  } catch (error) {
    if (error instanceof StartupCheckProbeError) throw error;
    throw new StartupCheckProbeError(
      `${productName} version probe failed: ${extractErrorMessage(error)}`,
      error,
    );
  }
};

const normalizeTelemetryError = (error: unknown): StartupTelemetryError => {
  if (error instanceof StartupCheckProbeError) {
    return {
      message: error.message || extractErrorMessage(error.raw),
      stack: error.stack,
      raw: error.raw ?? error,
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message || "Unknown error.",
      stack: error.stack,
      raw: error,
    };
  }
  if (typeof error === "string" && error.trim()) {
    return {
      message: error.trim(),
      raw: error,
    };
  }
  return {
    message: "Unknown error.",
    raw: error,
  };
};

const emitPhaseTelemetry = (
  ctx: StartupChecklistContext,
  record: StartupCheckRecord,
  thrownError?: unknown,
) => {
  if (!ctx.telemetry) return;
  const telemetryError =
    thrownError !== undefined ? normalizeTelemetryError(thrownError) : undefined;
  ctx.telemetry({
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
    ...(telemetryError ? { error: telemetryError } : {}),
  });
  if (telemetryError) {
    ctx.telemetry({
      type: "startup_unknown_failure",
      code: record.code,
      phase: record.label,
      step: record.step,
      whenMs: record.endedAtMs,
      error: telemetryError,
    });
  }
};

const defaultReadBunVersion = async (): Promise<string> => {
  if (typeof Bun !== "undefined" && typeof Bun.version === "string" && Bun.version.trim()) {
    return Bun.version.trim();
  }
  throw new StartupCheckProbeError("Bun version probe failed: Bun runtime is unavailable.");
};

const defaultReadDockerVersion = async (): Promise<string> => {
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
    throw new StartupCheckProbeError(
      "Docker version probe failed: Bun runtime is unavailable.",
    );
  }
  const proc = Bun.spawn(["docker", "version", "--format", "{{.Server.Version}}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new StartupCheckProbeError(
      `Docker version probe failed: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`,
    );
  }
  const version = stdout.trim();
  if (!version) {
    throw new StartupCheckProbeError("Docker version probe failed: empty output from docker CLI.");
  }
  return version;
};

const runVersionCheck = async (params: {
  reader: () => Promise<string>;
  productName: string;
  minimum: ParsedVersion;
}): Promise<{ ok: boolean; detail: string }> => {
  const raw = await readVersionOrThrow(params.reader, params.productName);
  if (!raw) {
    return {
      ok: false,
      detail: `${params.productName} version output was empty; minimum supported version is ${params.minimum.value}.`,
    };
  }
  const parsed = parseVersion(raw);
  if (!parsed) {
    return {
      ok: false,
      detail: `${params.productName} version "${raw}" is not recognized; minimum supported version is ${params.minimum.value}.`,
    };
  }
  if (compareVersions(parsed.parts, params.minimum.parts) < 0) {
    return {
      ok: false,
      detail: `${params.productName} version ${parsed.value} is below the supported minimum ${params.minimum.value}.`,
    };
  }
  return {
    ok: true,
    detail: `${params.productName} ${parsed.value} meets the minimum ${params.minimum.value}.`,
  };
};

const DEFAULT_SYNTHETIC_LATENCY_MS = 850;
const DEFAULT_SYNTHETIC_PROBE = "probe.remote_startup";
const DISPATCH_CHECK_LABEL = "Job dispatch must succeed.";
const DISPATCH_CHECK_ACTION =
  "Inspect RemoteBuddy + WorkerPals logs, repair dependencies, then rerun dispatch.";

const defaultChecks = Object.freeze(
  [
  {
    code: STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    label: "Bun runtime version must be supported.",
    action:
      `Upgrade Bun 1.1+ runtime (bun upgrade, brew upgrade bun, or reinstall via bun.sh).`,
    category: "runtime",
    run: async (ctx) => {
      const reader = ctx.readBunVersion ?? defaultReadBunVersion;
      return runVersionCheck({
        reader,
        productName: "Bun",
        minimum: MIN_BUN_VERSION_PARSED,
      });
    },
  },
  {
    code: STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
    label: "Docker Engine version must satisfy the compatibility floor.",
    action: `Upgrade Docker Engine to >= ${MIN_DOCKER_VERSION} and restart the daemon.`,
    category: "infrastructure",
    run: async (ctx) => {
      const reader = ctx.readDockerVersion ?? defaultReadDockerVersion;
      return runVersionCheck({
        reader,
        productName: "Docker",
        minimum: MIN_DOCKER_VERSION_PARSED,
      });
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
  const readBunVersion = ctx.readBunVersion ?? defaultReadBunVersion;
  const readDockerVersion = ctx.readDockerVersion ?? defaultReadDockerVersion;
  return {
    ...ctx,
    describeRepo: () => {
      if (!repoStatusPromise) {
        repoStatusPromise = ctx.describeRepo();
      }
      return repoStatusPromise;
    },
    readBunVersion,
    readDockerVersion,
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
        const extracted = extractErrorMessage(error);
        detail =
          extracted && extracted !== "Unknown error."
            ? extracted
            : "Unknown error running startup check.";
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
        error: status === "fail" && failureErrorMessage ? { message: failureErrorMessage } : undefined,
      };
      history.push(record);
      ctx.log?.(record);
      emitPhaseTelemetry(ctx, record, thrownError);
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
    emitPhaseTelemetry(ctx, failureRecord, error);
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
