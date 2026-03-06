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

type RuntimeCheckMode = "strict" | "relaxed" | "off";

export interface StartupChecklistOptions {
  syntheticMaxLatencyMs?: number;
  syntheticProbeName?: string;
  allowDirtyWorktree?: boolean;
  runtimeChecks?: {
    bun?: RuntimeCheckMode;
    docker?: RuntimeCheckMode;
  };
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
  runtimeCapabilities?: {
    bun?: boolean;
    docker?: boolean;
  };
  telemetry?: (event: StartupTelemetryEvent) => void;
  now?: () => number;
  log?: (entry: StartupCheckRecord) => void;
}

export type StartupTelemetryEvent = StartupTelemetryPhaseEvent | StartupTelemetryUnknownFailureEvent;

export interface StartupTelemetryPhaseEvent {
  type: "startup_phase";
  code: StartupFailureCode;
  label: string;
  status: StartupCheckStatus;
  detail: string;
  step: number;
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
    stack?: string;
  };
}

const MIN_BUN_VERSION = "1.1.0";
const MIN_DOCKER_VERSION = "24.0.0";

type ParsedRuntimeVersion = {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function parseRuntimeVersion(value: string | null | undefined): ParsedRuntimeVersion | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(SEMVER_PATTERN);
  if (!match) return null;
  return {
    raw: text,
    major: Number.parseInt(match[1] ?? "0", 10),
    minor: Number.parseInt(match[2] ?? "0", 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
    prerelease: match[4] ?? null,
  };
}

function formatRuntimeVersion(version: ParsedRuntimeVersion): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${base}-${version.prerelease}` : base;
}

function compareRuntimeVersion(a: ParsedRuntimeVersion, b: ParsedRuntimeVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) return a.prerelease.localeCompare(b.prerelease);
  return 0;
}

const MIN_BUN_VERSION_PARSED = parseRuntimeVersion(MIN_BUN_VERSION);
const MIN_DOCKER_VERSION_PARSED = parseRuntimeVersion(MIN_DOCKER_VERSION);

if (!MIN_BUN_VERSION_PARSED || !MIN_DOCKER_VERSION_PARSED) {
  throw new Error("Invalid minimum runtime version constants.");
}

function resolveRuntimeCheckMode(
  mode: RuntimeCheckMode | undefined,
  capability: boolean | undefined,
): RuntimeCheckMode {
  if (mode) return mode;
  if (capability === false) return "relaxed";
  return "strict";
}

async function readProcessStdout(command: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit_code=${exitCode}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return stdout.trim();
}

async function defaultReadBunVersion(): Promise<string> {
  return readProcessStdout("bun", ["--version"]);
}

async function defaultReadDockerVersion(): Promise<string> {
  return readProcessStdout("docker", ["version", "--format", "{{.Server.Version}}"]);
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

function buildBunRuntimeCheck(): StartupCheckDefinition {
  return {
    code: STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    label: "Bun runtime must satisfy the supported version.",
    action: "Install Bun >= 1.1.0 via https://bun.sh/ to continue startup.",
    category: "runtime",
    run: async (ctx, options) => {
      const mode = resolveRuntimeCheckMode(options.runtimeChecks?.bun, ctx.runtimeCapabilities?.bun);
      if (mode === "off") {
        return { ok: true, detail: "Bun runtime check disabled via configuration." };
      }
      const reader = ctx.readBunVersion ?? defaultReadBunVersion;
      let output: string;
      try {
        output = await reader();
      } catch (error) {
        if (mode === "relaxed") {
          const reason = error instanceof Error ? error.message : String(error);
          return { ok: true, detail: `Bun version probe failed (${reason}); relaxed gating.` };
        }
        if (error instanceof Error) {
          error.message = `Bun version probe failed: ${error.message}`;
          throw error;
        }
        throw new Error(`Bun version probe failed: ${String(error)}`);
      }
      const parsed = parseRuntimeVersion(output);
      if (!parsed) {
        const detail = `Bun version probe returned unexpected payload: ${output || "(empty)"}`;
        if (mode === "relaxed") {
          return { ok: true, detail: `${detail}; relaxed gating.` };
        }
        return { ok: false, detail };
      }
      if (compareRuntimeVersion(parsed, MIN_BUN_VERSION_PARSED) < 0) {
        const detail = `Bun ${formatRuntimeVersion(parsed)} is below required ${MIN_BUN_VERSION}.`;
        return mode === "relaxed"
          ? { ok: true, detail: `${detail} Relaxed runtime gating applied.` }
          : { ok: false, detail };
      }
      return { ok: true, detail: `Bun version ${formatRuntimeVersion(parsed)} satisfies requirements.` };
    },
  };
}

function buildDockerRuntimeCheck(): StartupCheckDefinition {
  return {
    code: STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
    label: "Docker runtime must satisfy the supported version.",
    action: "Install Docker >= 24.0.0 or run startup with requireDocker=false.",
    category: "infrastructure",
    run: async (ctx, options) => {
      const mode = resolveRuntimeCheckMode(options.runtimeChecks?.docker, ctx.runtimeCapabilities?.docker);
      if (mode === "off") {
        return { ok: true, detail: "Docker runtime check disabled via configuration." };
      }
      const reader = ctx.readDockerVersion ?? defaultReadDockerVersion;
      let output: string;
      try {
        output = await reader();
      } catch (error) {
        if (mode === "relaxed") {
          const reason = error instanceof Error ? error.message : String(error);
          return { ok: true, detail: `Docker version probe failed (${reason}); relaxed gating.` };
        }
        if (error instanceof Error) {
          error.message = `Docker version probe failed: ${error.message}`;
          throw error;
        }
        throw new Error(`Docker version probe failed: ${String(error)}`);
      }
      const parsed = parseRuntimeVersion(output);
      if (!parsed) {
        const detail = `Docker version probe returned unexpected payload: ${output || "(empty)"}`;
        if (mode === "relaxed") {
          return { ok: true, detail: `${detail}; relaxed gating.` };
        }
        return { ok: false, detail };
      }
      if (compareRuntimeVersion(parsed, MIN_DOCKER_VERSION_PARSED) < 0) {
        const detail = `Docker ${formatRuntimeVersion(parsed)} is below required ${MIN_DOCKER_VERSION}.`;
        return mode === "relaxed"
          ? { ok: true, detail: `${detail} Relaxed runtime gating applied.` }
          : { ok: false, detail };
      }
      return {
        ok: true,
        detail: `Docker version ${formatRuntimeVersion(parsed)} satisfies requirements.`,
      };
    },
  };
}

const defaultChecks = Object.freeze(
  [
    buildBunRuntimeCheck(),
    buildDockerRuntimeCheck(),
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

function emitStartupPhaseTelemetry(
  ctx: StartupChecklistContext,
  record: StartupCheckRecord,
  rawError?: unknown,
): void {
  if (!ctx.telemetry) return;
  ctx.telemetry({
    type: "startup_phase",
    code: record.code,
    label: record.label,
    status: record.status,
    detail: record.detail,
    step: record.step,
    startedAtMs: record.startedAtMs,
    endedAtMs: record.endedAtMs,
    durationMs: record.durationMs,
    ...(record.error
      ? {
          error: {
            message: record.error.message,
            raw: rawError ?? null,
            stack: rawError instanceof Error ? rawError.stack : undefined,
          },
        }
      : {}),
  });
}

function emitStartupUnknownFailure(
  ctx: StartupChecklistContext,
  params: { code: StartupFailureCode; label: string; step: number; error: unknown; whenMs: number },
): void {
  if (!ctx.telemetry) return;
  ctx.telemetry({
    type: "startup_unknown_failure",
    code: params.code,
    phase: params.label,
    step: params.step,
    whenMs: params.whenMs,
    error: {
      message: params.error instanceof Error ? params.error.message : String(params.error ?? "Unknown error"),
      raw: params.error ?? null,
      stack: params.error instanceof Error ? params.error.stack : undefined,
    },
  });
}

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
       let failureRawError: unknown;
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
        if (error instanceof Error) {
          failureErrorMessage = error.message;
        } else if (typeof error === "string" && error.trim()) {
          failureErrorMessage = error.trim();
        }
        failureRawError = error;
        emitStartupUnknownFailure(ctx, {
          code: check.code,
          label: check.label,
          step,
          error,
          whenMs: nowMs(ctx),
        });
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
      emitStartupPhaseTelemetry(ctx, record, failureRawError);
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
    emitStartupPhaseTelemetry(ctx, successRecord);
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
    emitStartupPhaseTelemetry(ctx, failureRecord, error);
    emitStartupUnknownFailure(ctx, {
      code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      label: DISPATCH_CHECK_LABEL,
      step: dispatchStep,
      error,
      whenMs: nowMs(ctx),
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
