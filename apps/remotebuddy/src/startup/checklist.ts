/**
 * Deterministic startup preflight checklist plus a synthetic dispatch guard.
 * The helper executes each check sequentially, surfaces actionable failure codes,
 * and optionally blocks job dispatch until a synthetic probe completes.
 */
export const STARTUP_FAILURE_CODES = {
  BUN_VERSION_UNSUPPORTED: "startup.bun_version_unsupported",
  DOCKER_AUTH_FAILED: "startup.docker_auth_failed",
  ENV_VARS_MISSING: "startup.env_vars_missing",
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
  | "docker"
  | "env"
  | "repo"
  | "alerts"
  | "synthetic"
  | "dispatch";

export interface StartupChecklistOptions {
  syntheticMaxLatencyMs?: number;
  syntheticProbeName?: string;
  allowDirtyWorktree?: boolean;
  minBunVersion?: string;
  bunVersionProvider?: () => string | Promise<string>;
  dockerProbe?: DockerAuthProbe;
  requiredEnvVars?: string[];
  envVarResolver?: (key: string) => string | undefined | Promise<string | undefined>;
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
  telemetry?: StartupTelemetryEmitter;
}

export interface DockerAuthProbeResult {
  ok: boolean;
  detail?: string;
}

export type DockerAuthProbe = () => Promise<DockerAuthProbeResult>;

export type StartupTelemetryEventType = "start" | "end";

export interface StartupTelemetryEvent {
  event: StartupTelemetryEventType;
  code: StartupFailureCode;
  label: string;
  category: StartupCheckCategory;
  step: number;
  status?: StartupCheckStatus;
  detail?: string;
  elapsedMs?: number;
}

export interface StartupTelemetryEmitter {
  emit: (event: StartupTelemetryEvent) => void;
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
const BUN_CHECK_LABEL = "Bun runtime must satisfy the minimum supported version.";
const BUN_CHECK_ACTION =
  "Install the required Bun version (`bun upgrade` or align with the pinned workspace version) before launching RemoteBuddy.";
const DOCKER_CHECK_LABEL = "Docker daemon + registry credentials must be available.";
const DOCKER_CHECK_ACTION =
  "Start Docker Desktop/daemon and run `docker login` for the required registry, then rerun the preflight.";
const ENV_CHECK_LABEL = "RemoteBuddy startup requires specific environment variables.";
const ENV_CHECK_ACTION =
  "Export the documented env vars (see docs/startup.md) via `.env` or the shell session before running RemoteBuddy.";
const DEFAULT_MIN_BUN_VERSION = "1.3.0";

const builtinBunVersionProvider = async (): Promise<string> => {
  try {
    if (typeof Bun !== "undefined" && typeof Bun.version === "string") {
      return Bun.version.trim();
    }
  } catch {
    // ignore Bun global access errors
  }
  const runtimeVersion = typeof process !== "undefined" ? process.version : "";
  return runtimeVersion.replace(/^v/, "").trim();
};

const parseSemverParts = (value: string): [number, number, number] => {
  const sanitized = value.split("+", 1)[0]?.split("-", 1)[0] ?? "";
  const pieces = sanitized.split(".");
  const major = Number.parseInt(pieces[0] ?? "0", 10) || 0;
  const minor = Number.parseInt(pieces[1] ?? "0", 10) || 0;
  const patch = Number.parseInt(pieces[2] ?? "0", 10) || 0;
  return [major, minor, patch];
};

const compareSemver = (a: string, b: string): number => {
  const [aMajor, aMinor, aPatch] = parseSemverParts(a);
  const [bMajor, bMinor, bPatch] = parseSemverParts(b);
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
};

const defaultEnvVarResolver = (key: string): string | undefined =>
  (typeof process !== "undefined" ? process.env?.[key] : undefined);

const emitTelemetryEvent = (
  ctx: StartupChecklistContext,
  event: StartupTelemetryEvent,
): void => {
  try {
    ctx.telemetry?.emit(event);
  } catch {
    // avoid propagating telemetry failures into startup gating logic
  }
};

const defaultChecks: readonly StartupCheckDefinition[] = [
  {
    code: STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    label: BUN_CHECK_LABEL,
    action: BUN_CHECK_ACTION,
    category: "runtime",
    run: async (_ctx, options) => {
      const currentVersionProvider =
        options.bunVersionProvider ?? builtinBunVersionProvider;
      const minVersion = (options.minBunVersion ?? DEFAULT_MIN_BUN_VERSION).trim();
      const currentRaw = await currentVersionProvider();
      const currentVersion = (currentRaw ?? "").trim();
      if (!currentVersion) {
        return {
          ok: false,
          detail: "Unable to detect Bun runtime version from the current process.",
        };
      }
      if (minVersion && compareSemver(currentVersion, minVersion) < 0) {
        return {
          ok: false,
          detail: `Installed Bun ${currentVersion} but startup requires ${minVersion} or later.`,
        };
      }
      return {
        ok: true,
        detail: `Bun ${currentVersion} satisfies >= ${minVersion || "configured requirement"}.`,
      };
    },
  },
  {
    code: STARTUP_FAILURE_CODES.DOCKER_AUTH_FAILED,
    label: DOCKER_CHECK_LABEL,
    action: DOCKER_CHECK_ACTION,
    category: "docker",
    run: async (_ctx, options) => {
      const probe = options.dockerProbe;
      if (!probe) {
        return {
          ok: true,
          detail: "Docker auth probe not configured; skipping runtime enforcement.",
        };
      }
      try {
        const result = await probe();
        if (!result.ok) {
          return {
            ok: false,
            detail:
              result.detail ??
              "Docker daemon unreachable or credentials missing. Run `docker login` and retry.",
          };
        }
        return { ok: true, detail: result.detail ?? "Docker daemon + creds verified." };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : "Docker auth probe threw an error.",
        };
      }
    },
  },
  {
    code: STARTUP_FAILURE_CODES.ENV_VARS_MISSING,
    label: ENV_CHECK_LABEL,
    action: ENV_CHECK_ACTION,
    category: "env",
    run: async (_ctx, options) => {
      const required = options.requiredEnvVars ?? [];
      if (required.length === 0) {
        return { ok: true, detail: "No required env vars configured for startup enforcement." };
      }
      const resolver = options.envVarResolver ?? defaultEnvVarResolver;
      const missing: string[] = [];
      for (const key of required) {
        try {
          const raw = await resolver(key);
          if (typeof raw !== "string" || raw.trim().length === 0) {
            missing.push(key);
          }
        } catch (err) {
          return {
            ok: false,
            detail: `Could not resolve env var ${key}: ${err instanceof Error ? err.message : "unknown error"}`,
          };
        }
      }
      if (missing.length > 0) {
        return {
          ok: false,
          detail: `Missing env vars: ${missing.join(", ")}.`,
        };
      }
      return {
        ok: true,
        detail: `All required env vars present (${required.join(", ")}).`,
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
      emitTelemetryEvent(ctx, {
        event: "start",
        code: check.code,
        label: check.label,
        category: check.category,
        step,
      });
      const started = nowMs(ctx);
      let status: StartupCheckStatus = "pass";
      let detail = check.label;
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
      }
      const elapsedMs = Math.max(0, nowMs(ctx) - started);
      const record: StartupCheckRecord = {
        code: check.code,
        label: check.label,
        category: check.category,
        step,
        status,
        detail,
        action: status === "fail" ? check.action : undefined,
        elapsedMs,
      };
      history.push(record);
      ctx.log?.(record);
      emitTelemetryEvent(ctx, {
        event: "end",
        code: check.code,
        label: check.label,
        category: check.category,
        step,
        status,
        detail,
        elapsedMs,
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
  emitTelemetryEvent(ctx, {
    event: "start",
    code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
    label: dispatchLabel,
    category: "dispatch",
    step: dispatchStep,
  });
  try {
    await dispatchJob();
    const elapsedMs = Math.max(0, nowMs(ctx) - started);
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
    emitTelemetryEvent(ctx, {
      event: "end",
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: dispatchLabel,
      category: "dispatch",
      step: dispatchStep,
      status: "pass",
      detail: successRecord.detail,
      elapsedMs,
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
    const elapsedMs = Math.max(0, nowMs(ctx) - started);
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
    emitTelemetryEvent(ctx, {
      event: "end",
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: dispatchLabel,
      category: "dispatch",
      step: dispatchStep,
      status: "fail",
      detail,
      elapsedMs,
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
