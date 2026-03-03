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
  readBunVersion?: () => Promise<string | null>;
  readDockerVersion?: () => Promise<string | null>;
  telemetry?: (event: StartupTelemetryEvent) => void;
}

export interface StartupTelemetryErrorPayload {
  name?: string;
  message: string;
  stack?: string;
  raw?: unknown;
}

export interface StartupTelemetryPhaseEvent {
  type: "startup_phase";
  code: StartupFailureCode;
  category: StartupCheckCategory;
  phase: string;
  step: number;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  status: StartupCheckStatus;
  detail?: string;
  action?: string;
  error?: StartupTelemetryErrorPayload;
}

export interface StartupTelemetryUnknownFailureEvent {
  type: "startup_unknown_failure";
  code: StartupFailureCode;
  category: StartupCheckCategory;
  phase: string;
  step: number;
  whenMs: number;
  error: StartupTelemetryErrorPayload;
}

export type StartupTelemetryEvent =
  | StartupTelemetryPhaseEvent
  | StartupTelemetryUnknownFailureEvent;

const MIN_BUN_VERSION = "1.1.0";
const MIN_DOCKER_VERSION = "24.0.0";

const versionParts = (value: string): number[] =>
  value
    .split(/[^0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => Number.parseInt(segment, 10));

const compareVersions = (current: string, required: string): number => {
  const currentParts = versionParts(current);
  const requiredParts = versionParts(required);
  const maxLength = Math.max(currentParts.length, requiredParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const currentValue = currentParts[index] ?? 0;
    const requiredValue = requiredParts[index] ?? 0;
    if (currentValue > requiredValue) {
      return 1;
    }
    if (currentValue < requiredValue) {
      return -1;
    }
  }
  return 0;
};

const parseVersionFromText = (value: string): string | null => {
  const match = value.match(/\d+(?:\.\d+){0,3}/);
  return match ? match[0] : null;
};

const readBunVersion = async (
  ctx: StartupChecklistContext,
): Promise<string | null> => {
  if (ctx.readBunVersion) {
    return ctx.readBunVersion();
  }
  if (typeof Bun !== "undefined" && typeof Bun.version === "string") {
    return Bun.version;
  }
  return null;
};

type SpawnResult = { stdout: string; stderr: string; exitCode: number };

const runDockerCli = async (args: string[]): Promise<SpawnResult> => {
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
    throw new Error("Bun runtime missing; cannot execute docker CLI.");
  }
  try {
    const proc = Bun.spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = proc.stdout
      ? new Response(proc.stdout).text()
      : Promise.resolve("");
    const stderrPromise = proc.stderr
      ? new Response(proc.stderr).text()
      : Promise.resolve("");
    const [stdout, stderr, exitCode] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      proc.exited,
    ]);
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown spawn failure";
    throw new Error(`docker ${args.join(" ")} failed to start: ${message}`);
  }
};

const defaultReadDockerVersion = async (): Promise<string | null> => {
  const formatArguments = ["version", "--format", "{{.Server.Version}}"];
  const formatted = await runDockerCli(formatArguments);
  if (formatted.exitCode === 0 && formatted.stdout) {
    const parsed = parseVersionFromText(formatted.stdout);
    if (parsed) {
      return parsed;
    }
    throw new Error(
      `docker version returned unexpected payload: ${formatted.stdout}`,
    );
  }
  if (formatted.exitCode !== 0) {
    const detail = formatted.stderr || formatted.stdout || "unknown failure";
    throw new Error(`docker ${formatArguments.join(" ")} failed: ${detail}`);
  }
  const fallback = await runDockerCli(["--version"]);
  if (fallback.exitCode === 0) {
    const parsed = parseVersionFromText(
      fallback.stdout || fallback.stderr || "",
    );
    if (parsed) {
      return parsed;
    }
    throw new Error(
      `docker --version output is unparsable: ${fallback.stdout || "(empty)"}`,
    );
  }
  const fallbackDetail = fallback.stderr || fallback.stdout || "unknown error";
  throw new Error(`docker --version failed: ${fallbackDetail}`);
};

const readDockerVersion = async (
  ctx: StartupChecklistContext,
): Promise<string | null> => {
  if (ctx.readDockerVersion) {
    return ctx.readDockerVersion();
  }
  return defaultReadDockerVersion();
};

const detailFromError = (error: unknown, fallback: string): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return fallback;
};

class StartupChecklistProbeError extends Error {
  constructor(message: string, raw?: unknown) {
    super(message);
    this.name = "StartupChecklistProbeError";
    this.raw = raw;
  }

  readonly raw?: unknown;
}

const toTelemetryError = (
  error: unknown,
): StartupTelemetryErrorPayload | undefined => {
  if (!error) {
    return undefined;
  }
  if (error instanceof Error) {
    const payload: StartupTelemetryErrorPayload = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    if (error instanceof StartupChecklistProbeError && error.raw !== undefined) {
      payload.raw = error.raw;
    }
    return payload;
  }
  if (typeof error === "string") {
    return {
      message: error,
    };
  }
  return {
    message: "Unknown error",
    raw: error,
  };
};

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
const BUN_VERSION_LABEL = `Bun runtime must be v${MIN_BUN_VERSION} or newer.`;
const BUN_VERSION_ACTION =
  "Install or upgrade Bun 1.1+ via https://bun.sh/install (macOS/Linux) or `powershell -c \"irm https://bun.sh/install.ps1 | iex\"` (Windows), then rerun preflight.";
const DOCKER_VERSION_LABEL = `Docker Engine must be v${MIN_DOCKER_VERSION} or newer.`;
const DOCKER_VERSION_ACTION =
  "Upgrade/start Docker Desktop or Docker Engine to v24+, ensure `docker version` succeeds, then re-run RemoteBuddy startup.";

const defaultChecks: readonly StartupCheckDefinition[] = [
  {
    code: STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    label: BUN_VERSION_LABEL,
    action: BUN_VERSION_ACTION,
    category: "runtime",
    run: async (ctx) => {
      let version: string | null;
      try {
        version = await readBunVersion(ctx);
      } catch (error) {
        const detail = `Bun version probe failed: ${detailFromError(error, "unknown error")}`;
        throw new StartupChecklistProbeError(detail, error);
      }
      if (!version) {
        return {
          ok: false,
          detail:
            "Bun runtime was not detected; ensure RemoteBuddy runs inside Bun 1.1+.",
        };
      }
      if (compareVersions(version, MIN_BUN_VERSION) < 0) {
        return {
          ok: false,
          detail: `Detected Bun ${version}; upgrade to >= ${MIN_BUN_VERSION}.`,
        };
      }
      return {
        ok: true,
        detail: `Bun ${version} satisfies >= ${MIN_BUN_VERSION}.`,
      };
    },
  },
  {
    code: STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
    label: DOCKER_VERSION_LABEL,
    action: DOCKER_VERSION_ACTION,
    category: "infrastructure",
    run: async (ctx) => {
      let version: string | null;
      try {
        version = await readDockerVersion(ctx);
      } catch (error) {
        const detail = `Docker version probe failed: ${detailFromError(error, "unknown error")}`;
        throw new StartupChecklistProbeError(detail, error);
      }
      if (!version) {
        return {
          ok: false,
          detail:
            "Docker CLI responded without a version; confirm Docker Desktop/Engine is installed and running.",
        };
      }
      if (compareVersions(version, MIN_DOCKER_VERSION) < 0) {
        return {
          ok: false,
          detail: `Detected Docker ${version}; upgrade to >= ${MIN_DOCKER_VERSION}.`,
        };
      }
      return {
        ok: true,
        detail: `Docker ${version} satisfies >= ${MIN_DOCKER_VERSION}.`,
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
];

export const STARTUP_CHECK_STRUCTURE: readonly StartupCheckStructure[] = [
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
];

const nowMs = (ctx: StartupChecklistContext) =>
  ctx.now ? ctx.now() : Date.now();

const emitTelemetryPhase = (
  ctx: StartupChecklistContext,
  event: Omit<StartupTelemetryPhaseEvent, "type">,
) => {
  ctx.telemetry?.({
    type: "startup_phase",
    ...event,
  });
};

const emitTelemetryUnknownFailure = (
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
      const started = nowMs(ctx);
      let status: StartupCheckStatus = "pass";
      let detail = check.label;
      let thrownError: unknown;
      try {
        const outcome = await check.run(ctx, options);
        status = outcome.ok ? "pass" : "fail";
        detail = outcome.detail ?? check.label;
      } catch (error) {
        status = "fail";
        detail = detailFromError(
          error,
          "Unknown error running startup check.",
        );
        thrownError = error;
        const telemetryError = toTelemetryError(error) ?? { message: detail };
        emitTelemetryUnknownFailure(ctx, {
          code: check.code,
          category: check.category,
          phase: check.label,
          step,
          whenMs: nowMs(ctx),
          error: telemetryError,
        });
      }
      const ended = nowMs(ctx);
      const elapsedMs = Math.max(0, ended - started);
      const action = status === "fail" ? check.action : undefined;
      const record: StartupCheckRecord = {
        code: check.code,
        label: check.label,
        category: check.category,
        step,
        status,
        detail,
        action,
        elapsedMs,
      };
      history.push(record);
      ctx.log?.(record);
      emitTelemetryPhase(ctx, {
        code: check.code,
        category: check.category,
        phase: check.label,
        step,
        startedAtMs: started,
        endedAtMs: ended,
        durationMs: elapsedMs,
        status,
        detail,
        action,
        error: thrownError ? toTelemetryError(thrownError) : undefined,
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
  const started = nowMs(ctx);
  try {
    await dispatchJob();
    const ended = nowMs(ctx);
    const elapsedMs = Math.max(0, ended - started);
    const successRecord: StartupCheckRecord = {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: dispatchLabel,
      category: "dispatch",
      step: dispatchStep,
      status: "pass",
      detail: "Dispatch completed successfully.",
      elapsedMs,
    };
    result.history.push(successRecord);
    ctx.log?.(successRecord);
    emitTelemetryPhase(ctx, {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      category: "dispatch",
      phase: dispatchLabel,
      step: dispatchStep,
      startedAtMs: started,
      endedAtMs: ended,
      durationMs: elapsedMs,
      status: "pass",
      detail: successRecord.detail,
    });
    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown dispatch failure.";
    const detail = `Dispatch job failed: ${errorMessage}`;
    const ended = nowMs(ctx);
    const elapsedMs = Math.max(0, ended - started);
    const telemetryError = toTelemetryError(error);
    const failureRecord: StartupCheckRecord = {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: dispatchLabel,
      category: "dispatch",
      step: dispatchStep,
      status: "fail",
      detail,
      action: dispatchAction,
      elapsedMs,
    };
    ctx.log?.(failureRecord);
    emitTelemetryPhase(ctx, {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      category: "dispatch",
      phase: dispatchLabel,
      step: dispatchStep,
      startedAtMs: started,
      endedAtMs: ended,
      durationMs: elapsedMs,
      status: "fail",
      detail,
      action: dispatchAction,
      error: telemetryError,
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
