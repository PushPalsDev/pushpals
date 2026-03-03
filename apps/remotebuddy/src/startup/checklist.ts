/**
 * Deterministic startup preflight checklist plus a synthetic dispatch guard.
 * The helper executes each check sequentially, surfaces actionable failure codes,
 * and optionally blocks job dispatch until a synthetic probe completes.
 */
export const STARTUP_FAILURE_CODES = {
  MERGE_IN_PROGRESS: "startup.merge_in_progress",
  REPO_DIRTY: "startup.repo_dirty",
  ENV_MISSING: "startup.env_missing",
  API_TOKEN_INVALID: "startup.api_token_invalid",
  DOCKER_UNAVAILABLE: "startup.docker_unavailable",
  ALERTS_ACTIVE: "startup.alerts_active",
  SYNTHETIC_FAILED: "startup.synthetic_failed",
  DISPATCH_FAILED: "startup.dispatch_failed",
} as const;

export type StartupFailureCode =
  (typeof STARTUP_FAILURE_CODES)[keyof typeof STARTUP_FAILURE_CODES];

type StartupCheckStatus = "pass" | "fail";

export type StartupCheckCategory =
  | "repo"
  | "env"
  | "infra"
  | "alerts"
  | "synthetic"
  | "dispatch";

type EnvReader = (name: string) => string | undefined;

export interface DockerProbeResult {
  ready: boolean;
  detail: string;
  version?: string;
}

export type DockerProbe = () => Promise<DockerProbeResult>;

export interface StartupChecklistOptions {
  syntheticMaxLatencyMs?: number;
  syntheticProbeName?: string;
  allowDirtyWorktree?: boolean;
  requiredEnvVars?: readonly string[];
  apiTokenEnvVar?: string;
  requireDocker?: boolean;
  dockerProbe?: DockerProbe;
  dockerProbeTimeoutMs?: number;
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

export type StartupTelemetryPhase = "start" | "finish";

export type StartupTelemetryStatus = StartupCheckStatus | "pending";

export interface StartupTelemetryEvent {
  code: StartupFailureCode;
  label: string;
  category: StartupCheckCategory;
  step: number;
  status: StartupTelemetryStatus;
  detail: string;
  action?: string;
  elapsedMs: number;
  phase: StartupTelemetryPhase;
  timestamp: number;
}

export interface StartupTelemetryEmitter {
  emit: (event: StartupTelemetryEvent) => void;
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
  readEnvVar?: EnvReader;
  describeDocker?: DockerProbe;
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

const DEFAULT_REQUIRED_ENV_VARS = [
  "REMOTE_STABLE_ID",
  "WORKERPALS_API_URL",
  "SERVER_BASE_URL",
] as const;
const DEFAULT_API_TOKEN_ENV = "PUSHPALS_AUTH_TOKEN";
const DEFAULT_DOCKER_TIMEOUT_MS = 2500;
const STARTUP_DOCS_HINT =
  "See apps/remotebuddy/docs/startup.md for wiring guidance, env var setup tips, and Docker troubleshooting steps.";
const ENV_CHECK_LABEL = "Required environment variables must be configured.";
const ENV_CHECK_ACTION = `Ensure ${DEFAULT_REQUIRED_ENV_VARS.join(", ")} are exported via .env or shell before dispatch. ${STARTUP_DOCS_HINT}`;
const API_TOKEN_CHECK_LABEL = "PushPals API token must be present.";
const API_TOKEN_CHECK_ACTION =
  "Fetch the PUSHPALS_AUTH_TOKEN value from WorkerPals Server, export it (or pass --token), then rerun startup.";
const DOCKER_CHECK_LABEL = "Docker daemon must be reachable.";
const DOCKER_CHECK_ACTION =
  "Start Docker Desktop (or ensure the daemon socket is reachable) until the docker info command succeeds, then rerun startup.";
const ALERTS_CHECK_LABEL = "Alertmanager remote-* group must be green.";
const ALERTS_CHECK_ACTION =
  "Visit Alertmanager › remote-* group, resolve or silence blocking alerts before dispatch resumes.";

const isBunTestRuntime = () => {
  const bunTest = process?.env?.BUN_TEST;
  if (bunTest && bunTest !== "0") {
    return true;
  }
  return process?.env?.NODE_ENV === "test";
};

const readEnvValue = (
  ctx: StartupChecklistContext,
  name: string,
): string | undefined => {
  try {
    const override = ctx.readEnvVar?.(name);
    if (override !== undefined) {
      return override;
    }
  } catch {
    // Ignore env override failures and fall back to process.env.
  }
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
};

const ensureRequiredEnvVars = (
  ctx: StartupChecklistContext,
  options: StartupChecklistOptions,
): { ok: boolean; detail: string } => {
  const required =
    options.requiredEnvVars && options.requiredEnvVars.length > 0
      ? options.requiredEnvVars
      : DEFAULT_REQUIRED_ENV_VARS;
  if (required.length === 0) {
    return { ok: true, detail: "No required env vars configured." };
  }
  const missing = required.filter((name) => {
    const value = readEnvValue(ctx, name);
    return !value || value.trim().length === 0;
  });
  if (missing.length > 0) {
    const missingList = missing.join(", ");
    const hint =
      missing.length === 1
        ? `Missing required env var ${missingList}.`
        : `Missing required env vars ${missingList}.`;
    return {
      ok: false,
      detail: `${hint} Export them via .env or the shell session before dispatch. ${STARTUP_DOCS_HINT}`,
    };
  }
  return {
    ok: true,
    detail: `Required env vars present (${required.join(", ")}).`,
  };
};

const ensureApiToken = (
  ctx: StartupChecklistContext,
  options: StartupChecklistOptions,
): { ok: boolean; detail: string } => {
  const tokenEnv = options.apiTokenEnvVar ?? DEFAULT_API_TOKEN_ENV;
  const tokenValue = readEnvValue(ctx, tokenEnv);
  if (!tokenValue || tokenValue.trim().length === 0) {
    return {
      ok: false,
      detail: `${tokenEnv} is not set; RemoteBuddy cannot call Server APIs without it. Export the bearer token (see docs/startup.md) or pass --token when launching.`,
    };
  }
  const trimmed = tokenValue.trim();
  const appearsRedacted =
    trimmed === "changeme" ||
    trimmed === "token" ||
    trimmed.toLowerCase().includes("placeholder");
  if (appearsRedacted) {
    return {
      ok: false,
      detail: `${tokenEnv} is set to a placeholder value (${trimmed}); fetch the real Server token and export it before rerunning startup.`,
    };
  }
  return {
    ok: true,
    detail: `${tokenEnv} loaded (${trimmed.length} chars).`,
  };
};

const shouldSkipDefaultDockerProbe = (options: StartupChecklistOptions) => {
  if (isBunTestRuntime()) {
    return true;
  }
  return process?.env?.STARTUP_PREFLIGHT_SKIP_DOCKER === "1" ||
    options.requireDocker === false
    ? true
    : false;
};

const defaultDockerProbe = async (
  timeoutMs: number,
): Promise<DockerProbeResult> => {
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
    return {
      ready: false,
      detail:
        "Docker probe requires Bun runtime; supply describeDocker in context when running under Node.",
    };
  }
  const subprocess = Bun.spawn({
    cmd: ["docker", "info", "--format", "{{json .ServerVersion}}"],
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      subprocess.kill();
    } catch {
      // Ignore kill failures; process may have already exited.
    }
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  clearTimeout(timeout);
  if (timedOut) {
    return {
      ready: false,
      detail: `Docker CLI timed out after ${timeoutMs} ms. Start Docker Desktop and retry.`,
    };
  }
  if (exitCode !== 0) {
    const message = stderr.trim() || `docker info exited with ${exitCode}.`;
    return {
      ready: false,
      detail: `Docker CLI failed: ${message} (is the daemon running and reachable?).`,
    };
  }
  const version = stdout.trim().replace(/^\"|\"$/g, "");
  return {
    ready: true,
    detail: version
      ? `Docker daemon responded (version ${version}).`
      : "Docker daemon responded.",
    version,
  };
};

const resolveDockerProbe = (
  ctx: StartupChecklistContext,
  options: StartupChecklistOptions,
): DockerProbe | undefined => {
  if (options.requireDocker === false) {
    return undefined;
  }
  if (ctx.describeDocker) {
    return ctx.describeDocker;
  }
  if (options.dockerProbe) {
    return options.dockerProbe;
  }
  if (shouldSkipDefaultDockerProbe(options)) {
    return undefined;
  }
  return () => defaultDockerProbe(options.dockerProbeTimeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS);
};

const ensureDockerReadiness = async (
  ctx: StartupChecklistContext,
  options: StartupChecklistOptions,
): Promise<{ ok: boolean; detail: string }> => {
  const probe = resolveDockerProbe(ctx, options);
  if (!probe) {
    return {
      ok: true,
      detail: "Docker readiness probe skipped (not configured for this runtime).",
    };
  }
  try {
    const result = await probe();
    if (result.ready) {
      return { ok: true, detail: result.detail };
    }
    return {
      ok: false,
      detail:
        result.detail ??
        "Docker daemon is unreachable. Start Docker Desktop or ensure the daemon socket is accessible, then retry.",
    };
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof Error
          ? `Docker readiness probe failed: ${error.message}`
          : "Docker readiness probe failed for an unknown reason.",
    };
  }
};

const defaultChecks: readonly StartupCheckDefinition[] = [
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
    code: STARTUP_FAILURE_CODES.ENV_MISSING,
    label: ENV_CHECK_LABEL,
    action: ENV_CHECK_ACTION,
    category: "env",
    run: async (ctx, options) => ensureRequiredEnvVars(ctx, options),
  },
  {
    code: STARTUP_FAILURE_CODES.API_TOKEN_INVALID,
    label: API_TOKEN_CHECK_LABEL,
    action: API_TOKEN_CHECK_ACTION,
    category: "env",
    run: async (ctx, options) => ensureApiToken(ctx, options),
  },
  {
    code: STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
    label: DOCKER_CHECK_LABEL,
    action: DOCKER_CHECK_ACTION,
    category: "infra",
    run: async (ctx, options) => ensureDockerReadiness(ctx, options),
  },
  {
    code: STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
    label: ALERTS_CHECK_LABEL,
    action: ALERTS_CHECK_ACTION,
    category: "alerts",
    run: async (ctx) => {
      const alerts = await ctx.listFiringAlerts();
      if (alerts.length === 0) {
        return {
          ok: true,
          detail: "No remote-* alerts are firing.",
        };
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

const emitTelemetry = (
  ctx: StartupChecklistContext,
  event: Omit<StartupTelemetryEvent, "timestamp">,
  timestamp: number,
) => {
  ctx.telemetry?.emit({
    ...event,
    timestamp,
  });
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
      emitTelemetry(
        ctx,
        {
          code: check.code,
          label: check.label,
          category: check.category,
          step,
          status: "pending",
          detail: `Starting ${check.label}`,
          action: check.action,
          elapsedMs: 0,
          phase: "start",
        },
        started,
      );
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
      const finishedAt = nowMs(ctx);
      const record: StartupCheckRecord = {
        code: check.code,
        label: check.label,
        category: check.category,
        step,
        status,
        detail,
        action: status === "fail" ? check.action : undefined,
        elapsedMs: Math.max(0, finishedAt - started),
      };
      history.push(record);
      ctx.log?.(record);
      emitTelemetry(
        ctx,
        {
          code: record.code,
          label: record.label,
          category: record.category,
          step,
          status: record.status,
          detail: record.detail,
          action: record.action,
          elapsedMs: record.elapsedMs,
          phase: "finish",
        },
        finishedAt,
      );
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
  emitTelemetry(
    ctx,
    {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: dispatchLabel,
      category: "dispatch",
      step: dispatchStep,
      status: "pending",
      detail: `Starting ${dispatchLabel}`,
      action: dispatchAction,
      elapsedMs: 0,
      phase: "start",
    },
    started,
  );
  try {
    await dispatchJob();
    const finishedAt = nowMs(ctx);
    const elapsedMs = Math.max(0, finishedAt - started);
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
    emitTelemetry(
      ctx,
      {
        code: successRecord.code,
        label: successRecord.label,
        category: successRecord.category,
        step: successRecord.step,
        status: successRecord.status,
        detail: successRecord.detail,
        action: successRecord.action,
        elapsedMs,
        phase: "finish",
      },
      finishedAt,
    );
    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown dispatch failure.";
    const detail = `Dispatch job failed: ${errorMessage}`;
    const finishedAt = nowMs(ctx);
    const elapsedMs = Math.max(0, finishedAt - started);
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
    emitTelemetry(
      ctx,
      {
        code: failureRecord.code,
        label: failureRecord.label,
        category: failureRecord.category,
        step: failureRecord.step,
        status: failureRecord.status,
        detail: failureRecord.detail,
        action: failureRecord.action,
        elapsedMs,
        phase: "finish",
      },
      finishedAt,
    );
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
