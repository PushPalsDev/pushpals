/**
 * Deterministic startup preflight checklist plus a synthetic dispatch guard.
 * The helper executes each check sequentially, surfaces actionable failure codes,
 * and optionally blocks job dispatch until a synthetic probe completes.
 */
export const STARTUP_FAILURE_CODES = {
  AUTH_TOKEN_INVALID: "startup.auth_token_invalid",
  MERGE_IN_PROGRESS: "startup.merge_in_progress",
  REPO_DIRTY: "startup.repo_dirty",
  ALERTS_ACTIVE: "startup.alerts_active",
  DOCKER_UNAVAILABLE: "startup.docker_unavailable",
  SYNTHETIC_FAILED: "startup.synthetic_failed",
  DISPATCH_FAILED: "startup.dispatch_failed",
} as const;

export type StartupFailureCode =
  (typeof STARTUP_FAILURE_CODES)[keyof typeof STARTUP_FAILURE_CODES];

type StartupCheckStatus = "pass" | "fail";

export type StartupCheckCategory =
  | "config"
  | "repo"
  | "infra"
  | "alerts"
  | "synthetic"
  | "dispatch";

export interface StartupChecklistOptions {
  syntheticMaxLatencyMs?: number;
  syntheticProbeName?: string;
  allowDirtyWorktree?: boolean;
  authTokenEnvKey?: string;
  invalidTokenPatterns?: readonly InvalidTokenPatternInput[];
  dockerProbe?: DockerProbeSource;
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

export interface DockerProbeResult {
  ok: boolean;
  detail?: string;
  version?: string;
}

export type DockerProbeSource =
  | DockerProbeResult
  | Promise<DockerProbeResult>
  | (() => Promise<DockerProbeResult>);

export interface InvalidTokenPattern {
  regex: RegExp;
  label: string;
}

export type InvalidTokenPatternInput =
  | InvalidTokenPattern
  | RegExp
  | string;

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
  describeDocker?: () => Promise<DockerProbeResult>;
  readEnvVar?: (key: string) => string | undefined;
  /**
   * Optional deterministic environment bag used when readEnvVar is not supplied.
   * Useful for tests where manipulating process.env would leak between workers.
   */
  environment?: Record<string, string | undefined>;
  now?: () => number;
  log?: (entry: StartupCheckRecord) => void;
  emitTelemetry?: (event: StartupTelemetryEvent) => Promise<void> | void;
}

type StartupCheckDefinition = {
  code: StartupFailureCode;
  label: string;
  action: string;
  formatAction?: (options: StartupChecklistOptions) => string;
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

export type StartupTelemetryEvent =
  | {
      type: "startup_check_started";
      code: StartupFailureCode;
      label: string;
      category: StartupCheckCategory;
      step: number;
      timestampMs: number;
    }
  | {
      type: "startup_check_finished";
      record: StartupCheckRecord;
      timestampMs: number;
    };

const DEFAULT_SYNTHETIC_LATENCY_MS = 850;
const DEFAULT_SYNTHETIC_PROBE = "probe.remote_startup";
const DISPATCH_CHECK_LABEL = "Job dispatch must succeed.";
const DISPATCH_CHECK_ACTION =
  "Inspect RemoteBuddy + WorkerPals logs, repair dependencies, then rerun dispatch.";
export const DEFAULT_AUTH_TOKEN_ENV_KEY = "PUSHPALS_AUTH_TOKEN";
export const DEFAULT_INVALID_TOKEN_PATTERNS: readonly InvalidTokenPattern[] = [
  { regex: /^changeme!?$/i, label: "changeme" },
  { regex: /^dummy$/i, label: "dummy" },
  { regex: /^placeholder$/i, label: "placeholder" },
  { regex: /^sample[-_ ]?token$/i, label: "sample-token" },
  { regex: /^test(?:token)?$/i, label: "test-token" },
  { regex: /^your[-_ ]?token[-_ ]?here$/i, label: "your-token-here" },
  { regex: /^insert[-_ ]?token[-_ ]?here$/i, label: "insert-token-here" },
  { regex: /^replace[-_ ]?me$/i, label: "replace-me" },
  { regex: /^set[-_ ]?me$/i, label: "set-me" },
  { regex: /^api[-_ ]?token$/i, label: "api-token" },
  { regex: /^api[-_ ]?key$/i, label: "api-key" },
  { regex: /^your[-_ ]?api[-_ ]?key$/i, label: "your-api-key" },
  { regex: /^put[-_ ]?your[-_ ]?token[-_ ]?here$/i, label: "put-your-token-here" },
  { regex: /^token$/i, label: "token-literal" },
  { regex: /^0000+$/i, label: "all-zeroes" },
  { regex: /^[xX]{6,}$/, label: "all-x" },
  { regex: /^<[^>]+>$/, label: "angle-brackets" },
  { regex: /^\[[^\]]+\]$/, label: "square-brackets" },
  { regex: /^\${[^}]+}$/, label: "template-placeholder" },
  { regex: /^abc123$/i, label: "abc123" },
  { regex: /^foobar$/i, label: "foobar" },
  { regex: /^bearer\\s+token$/i, label: "bearer-token" },
  { regex: /^lorem[-_ ]?ipsum$/i, label: "lorem-ipsum" },
  { regex: /^remote[-_ ]?buddy[-_ ]?token$/i, label: "remote-buddy-token" },
  { regex: /^sk-(?:test|fake|demo)/i, label: "openai-test-prefix" },
];
const DOCKER_PROBE_SKIPPED_DETAIL =
  "Docker probe skipped; no probe function was provided.";

const buildAuthTokenAction = (envKey: string): string =>
  `Export ${envKey} (or pass --token) with a real Server API token before starting RemoteBuddy.`;

const readEnvVar = (
  ctx: StartupChecklistContext,
  key: string,
): string | undefined => {
  if (ctx.readEnvVar) {
    return ctx.readEnvVar(key);
  }
  if (ctx.environment) {
    return ctx.environment[key];
  }
  return process.env[key];
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeInvalidTokenPattern = (
  entry: InvalidTokenPatternInput,
): InvalidTokenPattern => {
  if (typeof entry === "string") {
    return { regex: new RegExp(`^${escapeRegExp(entry)}$`, "i"), label: entry };
  }
  if (entry instanceof RegExp) {
    return { regex: entry, label: entry.source };
  }
  return entry;
};

const listInvalidTokenPatterns = (
  overrides?: readonly InvalidTokenPatternInput[],
): readonly InvalidTokenPattern[] => {
  if (!overrides || overrides.length === 0) {
    return DEFAULT_INVALID_TOKEN_PATTERNS;
  }
  return [
    ...DEFAULT_INVALID_TOKEN_PATTERNS,
    ...overrides.map((entry) => normalizeInvalidTokenPattern(entry)),
  ];
};

const findInvalidTokenPattern = (
  token: string,
  overrides?: readonly InvalidTokenPatternInput[],
): InvalidTokenPattern | undefined => {
  const patterns = listInvalidTokenPatterns(overrides);
  return patterns.find((entry) => entry.regex.test(token));
};

const resolveDockerProbeSource = async (
  source: DockerProbeSource,
): Promise<DockerProbeResult> => {
  if (typeof source === "function") {
    return source();
  }
  return await source;
};

const resolveDockerProbe = async (
  ctx: StartupChecklistContext,
  options: StartupChecklistOptions,
): Promise<DockerProbeResult | null> => {
  if (options.dockerProbe !== undefined) {
    // Explicit override path takes precedence over ctx.describeDocker
    return resolveDockerProbeSource(options.dockerProbe);
  }
  if (ctx.describeDocker) {
    return ctx.describeDocker();
  }
  return null;
};

const safeEmitTelemetry = async (
  ctx: StartupChecklistContext,
  event: StartupTelemetryEvent,
): Promise<void> => {
  if (!ctx.emitTelemetry) return;
  try {
    await ctx.emitTelemetry(event);
  } catch {
    // ignore telemetry emitter failures to keep startup deterministic
  }
};

const defaultChecks: readonly StartupCheckDefinition[] = [
  {
    code: STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID,
    label: "RemoteBuddy API token must be configured.",
    action: buildAuthTokenAction(DEFAULT_AUTH_TOKEN_ENV_KEY),
    formatAction: (options) =>
      buildAuthTokenAction(
        options.authTokenEnvKey ?? DEFAULT_AUTH_TOKEN_ENV_KEY,
      ),
    category: "config",
    run: async (ctx, options) => {
      const envKey = options.authTokenEnvKey ?? DEFAULT_AUTH_TOKEN_ENV_KEY;
      const rawValue = readEnvVar(ctx, envKey);
      const token = rawValue?.trim();
      if (!token) {
        return {
          ok: false,
          detail: `${envKey} is not set; RemoteBuddy cannot authenticate with Server APIs.`,
        };
      }
      const invalidPattern = findInvalidTokenPattern(
        token,
        options.invalidTokenPatterns,
      );
      if (invalidPattern) {
        return {
          ok: false,
          detail: `${envKey} value matches placeholder pattern "${invalidPattern.label}". Configure a real API token before dispatch.`,
        };
      }
      return {
        ok: true,
        detail: `${envKey} is configured.`,
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
    code: STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
    label: "Docker daemon must be reachable for WorkerPals containers.",
    action:
      "Start Docker Desktop or ensure `docker ps` works for the RemoteBuddy host, then rerun startup preflight.",
    category: "infra",
    run: async (ctx, options) => {
      try {
        const probe = await resolveDockerProbe(ctx, options);
        if (!probe) {
          return { ok: true, detail: DOCKER_PROBE_SKIPPED_DETAIL };
        }
        if (probe.ok) {
          const versionSuffix = probe.version ? ` (version ${probe.version})` : "";
          const detail =
            probe.detail ??
            `Docker is available${versionSuffix ? versionSuffix : "."}`;
          return { ok: true, detail };
        }
        return {
          ok: false,
          detail: probe.detail ?? "Docker is unavailable or unhealthy.",
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Unknown docker probe failure.";
        return {
          ok: false,
          detail: `Docker probe failed: ${message}`,
        };
      }
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

const resolveCheckAction = (
  check: StartupCheckDefinition,
  options: StartupChecklistOptions,
): string => {
  if (check.formatAction) {
    return check.formatAction(options);
  }
  return check.action;
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
      await safeEmitTelemetry(ctx, {
        type: "startup_check_started",
        code: check.code,
        label: check.label,
        category: check.category,
        step,
        timestampMs: started,
      });
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
      const resolvedAction = resolveCheckAction(check, options);
      const record: StartupCheckRecord = {
        code: check.code,
        label: check.label,
        category: check.category,
        step,
        status,
        detail,
        action: status === "fail" ? resolvedAction : undefined,
        elapsedMs: Math.max(0, finishedAt - started),
      };
      history.push(record);
      ctx.log?.(record);
      await safeEmitTelemetry(ctx, {
        type: "startup_check_finished",
        record,
        timestampMs: finishedAt,
      });
      if (status === "fail") {
        return {
          ok: false,
          failure: {
            code: check.code,
            detail,
            action: resolvedAction,
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
  await safeEmitTelemetry(ctx, {
    type: "startup_check_started",
    code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
    label: dispatchLabel,
    category: "dispatch",
    step: dispatchStep,
    timestampMs: started,
  });
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
    await safeEmitTelemetry(ctx, {
      type: "startup_check_finished",
      record: successRecord,
      timestampMs: finishedAt,
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
    await safeEmitTelemetry(ctx, {
      type: "startup_check_finished",
      record: failureRecord,
      timestampMs: finishedAt,
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
