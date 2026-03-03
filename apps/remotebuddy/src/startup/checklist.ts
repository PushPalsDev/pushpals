/**
 * Deterministic startup preflight checklist plus a synthetic dispatch guard.
 * The helper executes each check sequentially, surfaces actionable failure codes,
 * and optionally blocks job dispatch until a synthetic probe completes.
 */
export const STARTUP_FAILURE_CODES = {
  MERGE_IN_PROGRESS: "startup.merge_in_progress",
  REPO_DIRTY: "startup.repo_dirty",
  ALERTS_ACTIVE: "startup.alerts_active",
  SYNTHETIC_FAILED: "startup.synthetic_failed",
  DISPATCH_FAILED: "startup.dispatch_failed",
} as const;

export type StartupFailureCode =
  (typeof STARTUP_FAILURE_CODES)[keyof typeof STARTUP_FAILURE_CODES];

type StartupCheckStatus = "pass" | "fail";

export type StartupCheckCategory = "repo" | "alerts" | "synthetic" | "dispatch";

export interface StartupChecklistOptions {
  syntheticMaxLatencyMs?: number;
  syntheticProbeName?: string;
  allowDirtyWorktree?: boolean;
  includeErrorStack?: boolean;
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
  error?: StartupCheckErrorDetail;
}

export interface StartupCheckErrorDetail {
  message: string;
  stack?: string;
  raw?: string;
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

const ERROR_MESSAGE_MAX_CHARS = 400;
const ERROR_STACK_MAX_CHARS = 2000;
const ERROR_RAW_MAX_CHARS = 480;
const ERROR_TRUNCATE_SUFFIX = " ...[truncated]";
const DEFAULT_ERROR_MESSAGE = "Unknown error running startup check.";
const ERROR_STACK_REDACTED = "[redacted]";
const STACK_FIELD_UNHANDLED = Symbol("startup.stack_field_unhandled");

const truncateField = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  const keep = Math.max(1, maxChars - ERROR_TRUNCATE_SUFFIX.length);
  return `${value.slice(0, keep)}${ERROR_TRUNCATE_SUFFIX}`;
};

const isStackLikeKey = (key: string): boolean =>
  key.length > 0 && key.toLowerCase().includes("stack");

const sanitizeStackFieldCandidate = (
  candidate: unknown,
  includeStack: boolean,
): string | undefined | typeof STACK_FIELD_UNHANDLED => {
  if (!includeStack) {
    return ERROR_STACK_REDACTED;
  }
  if (typeof candidate !== "string") {
    return STACK_FIELD_UNHANDLED;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  return truncateField(trimmed, ERROR_STACK_MAX_CHARS);
};

const formatFunctionPlaceholder = (
  fn: (...args: unknown[]) => unknown,
): string => {
  const name = fn.name?.trim();
  return `[function ${name && name.length > 0 ? name : "anonymous"}]`;
};

const sanitizeErrorMessage = (value: unknown): string => {
  if (value instanceof Error) {
    const fromError = value.message?.trim() || value.name?.trim();
    return truncateField(fromError || DEFAULT_ERROR_MESSAGE, ERROR_MESSAGE_MAX_CHARS);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return truncateField(trimmed || DEFAULT_ERROR_MESSAGE, ERROR_MESSAGE_MAX_CHARS);
  }
  if (typeof value === "function") {
    return formatFunctionPlaceholder(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return truncateField(String(value), ERROR_MESSAGE_MAX_CHARS);
  }
  if (value && typeof value === "object") {
    const maybeMessage = (value as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim()) {
      return truncateField(maybeMessage, ERROR_MESSAGE_MAX_CHARS);
    }
    const ctorName =
      (value as { constructor?: { name?: string } }).constructor?.name ??
      "Object";
    return `[object ${ctorName}]`;
  }
  return DEFAULT_ERROR_MESSAGE;
};

const sanitizeErrorStack = (
  value: unknown,
  includeStack: boolean,
): string | undefined => {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const stackValue = (value as { stack?: unknown }).stack;
  if (typeof stackValue !== "string") {
    return undefined;
  }
  const trimmed = stackValue.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!includeStack) {
    return ERROR_STACK_REDACTED;
  }
  return truncateField(trimmed, ERROR_STACK_MAX_CHARS);
};

const summarizeObject = (value: object, includeStack: boolean): string => {
  const visited = new WeakSet<object>();
  const replacer = (key: string, candidate: unknown) => {
    if (key && isStackLikeKey(key)) {
      const sanitizedStack = sanitizeStackFieldCandidate(candidate, includeStack);
      if (sanitizedStack !== STACK_FIELD_UNHANDLED) {
        return sanitizedStack;
      }
    }
    if (typeof candidate === "bigint") {
      return `[bigint ${candidate.toString()}]`;
    }
    if (typeof candidate === "function") {
      return formatFunctionPlaceholder(candidate);
    }
    if (typeof candidate === "object" && candidate !== null) {
      if (visited.has(candidate)) {
        return "[Circular]";
      }
      visited.add(candidate);
    }
    return candidate;
  };
  try {
    const serialized = JSON.stringify(value, replacer);
    if (serialized) {
      return truncateField(serialized, ERROR_RAW_MAX_CHARS);
    }
  } catch {
    // ignored
  }
  const ctorName =
    (value as { constructor?: { name?: string } }).constructor?.name ??
    "Object";
  const keys = Object.keys(value as Record<string, unknown>);
  const preview = keys.slice(0, 3).join(", ") || "none";
  const suffix = keys.length > 3 ? ", ..." : "";
  return `[object ${ctorName}] keys=${preview}${suffix}`;
};

const safeRawSummary = (
  value: unknown,
  includeStack: boolean,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return "null";
  }
  if (value instanceof Error) {
    const name = value.name || "Error";
    const message = value.message?.trim();
    const summary = message ? `${name}: ${message}` : name;
    return truncateField(summary, ERROR_RAW_MAX_CHARS);
  }
  if (typeof value === "function") {
    return formatFunctionPlaceholder(value);
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return truncateField(String(value), ERROR_RAW_MAX_CHARS);
  }
  if (typeof value === "bigint") {
    return `[bigint ${value.toString()}]`;
  }
  if (typeof value === "symbol") {
    return truncateField(value.toString(), ERROR_RAW_MAX_CHARS);
  }
  if (typeof value === "object") {
    return summarizeObject(value as object, includeStack);
  }
  return undefined;
};

const sanitizeStartupCheckErrorDetail = (
  value: unknown,
  includeStack: boolean,
): StartupCheckErrorDetail => {
  const detail: StartupCheckErrorDetail = {
    message: sanitizeErrorMessage(value),
  };
  const stack = sanitizeErrorStack(value, includeStack);
  if (stack) {
    detail.stack = stack;
  }
  const raw = safeRawSummary(value, includeStack);
  if (raw) {
    detail.raw = raw;
  }
  return detail;
};

const safeLog = (
  ctx: StartupChecklistContext,
  record: StartupCheckRecord,
): void => {
  if (!ctx.log) {
    return;
  }
  try {
    ctx.log(record);
  } catch (error) {
    const summary = sanitizeErrorMessage(error);
    console.warn(
      `[StartupChecklist] safeLog suppressed logging error: ${summary}`,
    );
  }
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
      let errorDetail: StartupCheckErrorDetail | undefined;
      try {
        const outcome = await check.run(ctx, options);
        status = outcome.ok ? "pass" : "fail";
        detail = outcome.detail ?? check.label;
      } catch (error) {
        status = "fail";
        errorDetail = sanitizeStartupCheckErrorDetail(
          error,
          options.includeErrorStack ?? false,
        );
        detail = errorDetail.message;
      }
      const record: StartupCheckRecord = {
        code: check.code,
        label: check.label,
        category: check.category,
        step,
        status,
        detail,
        action: status === "fail" ? check.action : undefined,
        elapsedMs: Math.max(0, nowMs(ctx) - started),
      };
      if (errorDetail) {
        record.error = errorDetail;
      }
      history.push(record);
      safeLog(ctx, record);
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
    safeLog(ctx, successRecord);
    return result;
  } catch (error) {
    const errorDetail = sanitizeStartupCheckErrorDetail(
      error,
      options.includeErrorStack ?? false,
    );
    const detail = `Dispatch job failed: ${errorDetail.message}`;
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
    failureRecord.error = errorDetail;
    safeLog(ctx, failureRecord);
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
