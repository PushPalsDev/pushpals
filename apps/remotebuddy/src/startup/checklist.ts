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
  cache?: StartupChecklistCache;
  cacheTtlMs?: number;
  queueLatencyWarnThresholdMs?: number;
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

export interface QueueLatencySample {
  p95Ms: number;
  pending?: number;
  observedAtMs?: number;
  source?: string;
  thresholdMs?: number;
}

export interface QueueLatencyTelemetry {
  emitGauge?: (sample: QueueLatencySample) => void;
  logSlowSubmission?: (sample: QueueLatencySample) => void;
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
  readQueueLatency?: () => Promise<QueueLatencySample | null>;
  queueTelemetry?: QueueLatencyTelemetry;
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

const CACHE_KEYS = ["repoStatus", "alerts"] as const;
type CacheKey = (typeof CACHE_KEYS)[number];

type StartupChecklistCacheEntry<T> = {
  promise: Promise<T>;
  expiresAt: number;
  generation: number;
};

export interface StartupChecklistCache {
  repoStatus?: StartupChecklistCacheEntry<RepoStatus>;
  alerts?: StartupChecklistCacheEntry<string[]>;
  generations?: Partial<Record<CacheKey, number>>;
}

export const createStartupChecklistCache = (): StartupChecklistCache => ({
  generations: {},
});

const ensureCacheGenerations = (
  cache: StartupChecklistCache,
): Record<CacheKey, number> => {
  if (!cache.generations) {
    cache.generations = {};
  }
  return cache.generations as Record<CacheKey, number>;
};

const readCacheGeneration = (
  cache: StartupChecklistCache,
  key: CacheKey,
): number => {
  const generations = ensureCacheGenerations(cache);
  return generations[key] ?? 0;
};

const bumpCacheGeneration = (
  cache: StartupChecklistCache,
  key: CacheKey,
): number => {
  const generations = ensureCacheGenerations(cache);
  const next = (generations[key] ?? 0) + 1;
  generations[key] = next;
  return next;
};

export type StartupChecklistCacheKey = CacheKey;

export const invalidateStartupChecklistCache = (
  cache: StartupChecklistCache | undefined,
  key?: StartupChecklistCacheKey,
): void => {
  if (!cache) {
    return;
  }
  if (key) {
    bumpCacheGeneration(cache, key);
    delete cache[key];
    return;
  }
  for (const target of CACHE_KEYS) {
    bumpCacheGeneration(cache, target);
    delete cache[target];
  }
};

export interface StartupCheckStructure {
  code: StartupFailureCode;
  label: string;
  action: string;
  category: StartupCheckCategory;
  step: number;
}

const DEFAULT_PROBE_CACHE_TTL_MS = 500;
const DEFAULT_QUEUE_P95_WARN_THRESHOLD_MS = 1_000;
const MIN_QUEUE_LATENCY_THRESHOLD_MS = 1;
const QUEUE_LATENCY_SLOW_LOG_FLOOR_MS = 1_000;
const DEFAULT_SYNTHETIC_LATENCY_MS = 850;
const DEFAULT_SYNTHETIC_PROBE = "probe.remote_startup";
const DISPATCH_CHECK_LABEL = "Job dispatch must succeed.";
const DISPATCH_CHECK_ACTION =
  "Inspect RemoteBuddy + WorkerPals logs, repair dependencies, then rerun dispatch.";

const contextCache = new WeakMap<StartupChecklistContext, StartupChecklistCache>();

const clampCacheTtlMs = (value?: number): number => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_PROBE_CACHE_TTL_MS;
  }
  if (!Number.isFinite(value)) {
    return DEFAULT_PROBE_CACHE_TTL_MS;
  }
  return Math.max(0, Math.floor(value));
};

const coerceThreshold = (value?: number): number | null => {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(MIN_QUEUE_LATENCY_THRESHOLD_MS, Math.floor(value));
};

const sanitizeLatencyMs = (value?: number): number => {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
};

export const normalizeQueueLatencyThreshold = (
  value?: number,
  fallback: number = DEFAULT_QUEUE_P95_WARN_THRESHOLD_MS,
): number => {
  const normalized = coerceThreshold(value);
  if (normalized !== null) {
    return normalized;
  }
  const normalizedFallback = coerceThreshold(fallback);
  if (normalizedFallback !== null) {
    return normalizedFallback;
  }
  return DEFAULT_QUEUE_P95_WARN_THRESHOLD_MS;
};

const getCacheForContext = (
  ctx: StartupChecklistContext,
  provided: StartupChecklistCache | undefined,
): StartupChecklistCache => {
  if (provided) {
    return provided;
  }
  const existing = contextCache.get(ctx);
  if (existing) {
    return existing;
  }
  const created = createStartupChecklistCache();
  contextCache.set(ctx, created);
  return created;
};

const cachedProbe = <T>(
  key: CacheKey,
  cache: StartupChecklistCache | undefined,
  ttlMs: number,
  readNow: () => number,
  loader: () => Promise<T>,
  shouldCacheValue?: (value: T) => boolean,
): Promise<T> => {
  if (!cache || ttlMs <= 0) {
    return loader();
  }
  const now = readNow();
  const generation = readCacheGeneration(cache, key);
  const existing = cache[key] as StartupChecklistCacheEntry<T> | undefined;
  if (
    existing &&
    existing.expiresAt > now &&
    existing.generation === generation
  ) {
    return existing.promise;
  }
  const entry: StartupChecklistCacheEntry<T> = {
    expiresAt: now + ttlMs,
    generation,
    promise: loader()
      .then((value) => {
        entry.expiresAt = readNow() + ttlMs;
        if (shouldCacheValue && !shouldCacheValue(value)) {
          if (cache[key] === entry) {
            delete cache[key];
            bumpCacheGeneration(cache, key);
          }
        }
        return value;
      })
      .catch((error) => {
        if (cache[key] === entry) {
          delete cache[key];
          bumpCacheGeneration(cache, key);
        }
        throw error;
      }),
  };
  cache[key] = entry as StartupChecklistCache[typeof key];
  return entry.promise;
};

const cacheBlockingRepoStatuses = (status: RepoStatus): boolean =>
  status.isDirty || status.isMergeInProgress;

const cacheBlockingAlerts = (alerts: string[]): boolean => alerts.length > 0;

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

const DEFAULT_CHECK_CODE_ORDER = defaultChecks.map((check) => check.code);

const compareAscii = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const sortChecksDeterministically = (
  checks: readonly StartupCheckDefinition[],
): readonly StartupCheckDefinition[] => {
  if (checks.length <= 1) {
    return [...checks];
  }
  const rank = (code: StartupFailureCode): number => {
    const index = DEFAULT_CHECK_CODE_ORDER.indexOf(code);
    return index === -1 ? DEFAULT_CHECK_CODE_ORDER.length + 1 : index;
  };
  return [...checks].sort((a, b) => {
    const diff = rank(a.code) - rank(b.code);
    if (diff !== 0) {
      return diff;
    }
    const labelDiff = compareAscii(a.label, b.label);
    if (labelDiff !== 0) {
      return labelDiff;
    }
    return compareAscii(a.code, b.code);
  });
};

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
  options: StartupChecklistOptions,
): StartupChecklistContext => {
  const cacheTtlMs = clampCacheTtlMs(options.cacheTtlMs);
  const cache =
    cacheTtlMs > 0 ? getCacheForContext(ctx, options.cache) : undefined;
  let repoStatusPromise: Promise<RepoStatus> | undefined;
  let alertPromise: Promise<string[]> | undefined;
  return {
    ...ctx,
    describeRepo: () => {
      if (!repoStatusPromise) {
        repoStatusPromise = cachedProbe(
          "repoStatus",
          cache,
          cacheTtlMs,
          () => nowMs(ctx),
          () => ctx.describeRepo(),
          cacheBlockingRepoStatuses,
        );
      }
      return repoStatusPromise;
    },
    listFiringAlerts: () => {
      if (!alertPromise) {
        alertPromise = cachedProbe(
          "alerts",
          cache,
          cacheTtlMs,
          () => nowMs(ctx),
          () => ctx.listFiringAlerts(),
          cacheBlockingAlerts,
        );
      }
      return alertPromise;
    },
  };
};

export class StartupChecklist {
  private readonly checks: readonly StartupCheckDefinition[];

  constructor(checks: readonly StartupCheckDefinition[]) {
    this.checks = sortChecksDeterministically(checks);
  }

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
      history.push(record);
      ctx.log?.(record);
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

const maybeEmitQueueLatencyTelemetry = async (
  ctx: StartupChecklistContext,
  options: StartupChecklistOptions,
): Promise<void> => {
  if (!ctx.readQueueLatency) {
    return;
  }
  try {
    const sample = await ctx.readQueueLatency();
    if (!sample) {
      return;
    }
    const threshold = normalizeQueueLatencyThreshold(
      options.queueLatencyWarnThresholdMs,
      DEFAULT_QUEUE_P95_WARN_THRESHOLD_MS,
    );
    const logFloor = normalizeQueueLatencyThreshold(
      QUEUE_LATENCY_SLOW_LOG_FLOOR_MS,
      DEFAULT_QUEUE_P95_WARN_THRESHOLD_MS,
    );
    const safeP95 = sanitizeLatencyMs(sample.p95Ms);
    const normalizedSample: QueueLatencySample = {
      ...sample,
      p95Ms: safeP95,
      observedAtMs: sample.observedAtMs ?? nowMs(ctx),
      source: sample.source ?? "startup_preflight_queue",
      thresholdMs: threshold,
    };
    ctx.queueTelemetry?.emitGauge?.(normalizedSample);
    const shouldLogSlow =
      normalizedSample.p95Ms > threshold ||
      normalizedSample.p95Ms > logFloor;
    if (shouldLogSlow) {
      ctx.queueTelemetry?.logSlowSubmission?.(normalizedSample);
    }
  } catch {
    // Queue telemetry is best-effort; swallow errors so preflight can proceed.
  }
};

export const runStartupPreflight = async (
  ctx: StartupChecklistContext,
  options: StartupChecklistOptions = {},
): Promise<StartupChecklistResult> => {
  const memoized = memoizeContext(ctx, options);
  await maybeEmitQueueLatencyTelemetry(memoized, options);
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
    ctx.log?.(successRecord);
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

const registerStartupChecklistInlineTests = (): void => {
  void (async () => {
    try {
      const { describe, expect, test } = await import("bun:test");
      const buildContext = (
        overrides: Partial<StartupChecklistContext> = {},
      ): StartupChecklistContext => ({
        describeRepo: async () => ({
          isDirty: false,
          isMergeInProgress: false,
          branch: "main",
          detail: "clean repo",
        }),
        listFiringAlerts: async () => [],
        syntheticTester: {
          runSyntheticJob: async () => ({ ok: true, latencyMs: 140 }),
        },
        ...overrides,
      });

      describe("Startup checklist cache accelerators", () => {
        test(
          "revalidates clean repo states before passing again within default TTL",
          async () => {
            const cache = createStartupChecklistCache();
            let repoCalls = 0;
            let nowValue = 0;
            let repoStatus: RepoStatus = {
              isDirty: false,
              isMergeInProgress: false,
              branch: "main",
              detail: "clean repo",
            };
            const ctx = buildContext({
              describeRepo: async () => {
                repoCalls += 1;
                return { ...repoStatus };
              },
              now: () => nowValue,
            });
            const options = { cache, cacheTtlMs: 500 };
            const first = await runStartupPreflight(ctx, options);
            expect(first.ok).toBe(true);
            expect(repoCalls).toBe(1);
            nowValue += 250;
            repoStatus = {
              isDirty: true,
              isMergeInProgress: false,
              branch: "main",
              detail: "dirty worktree",
            };
            const dirty = await runStartupPreflight(ctx, options);
            expect(repoCalls).toBe(2);
            expect(dirty.failure?.code).toBe(STARTUP_FAILURE_CODES.REPO_DIRTY);
          },
        );

        test(
          "caches breaking repo probe results until invalidated",
          async () => {
            const cache = createStartupChecklistCache();
            let repoCalls = 0;
            let nowValue = 0;
            let repoStatus: RepoStatus = {
              isDirty: true,
              isMergeInProgress: false,
              branch: "main",
              detail: "dirty worktree",
            };
            const ctx = buildContext({
              describeRepo: async () => {
                repoCalls += 1;
                return { ...repoStatus };
              },
              now: () => nowValue,
            });
            const options = { cache, cacheTtlMs: 10_000 };
            const dirty = await runStartupPreflight(ctx, options);
            expect(dirty.failure?.code).toBe(STARTUP_FAILURE_CODES.REPO_DIRTY);
            expect(repoCalls).toBe(1);
            repoStatus = {
              isDirty: false,
              isMergeInProgress: false,
              branch: "main",
              detail: "clean repo",
            };
            nowValue += 50;
            const stillDirty = await runStartupPreflight(ctx, options);
            expect(repoCalls).toBe(1);
            expect(stillDirty.failure?.code).toBe(
              STARTUP_FAILURE_CODES.REPO_DIRTY,
            );
            invalidateStartupChecklistCache(cache, "repoStatus");
            nowValue += 50;
            const clean = await runStartupPreflight(ctx, options);
            expect(repoCalls).toBe(2);
            expect(clean.ok).toBe(true);
          },
        );

        test(
          "re-runs alert probes when quiet state flips within default TTL",
          async () => {
            const cache = createStartupChecklistCache();
            let alertCalls = 0;
            let nowValue = 0;
            let alerts: string[] = [];
            const ctx = buildContext({
              listFiringAlerts: async () => {
                alertCalls += 1;
                return [...alerts];
              },
              now: () => nowValue,
            });
            const options = { cache, cacheTtlMs: 500 };
            const quiet = await runStartupPreflight(ctx, options);
            expect(quiet.ok).toBe(true);
            expect(alertCalls).toBe(1);
            nowValue += 200;
            alerts = ["remote-latency"];
            const noisy = await runStartupPreflight(ctx, options);
            expect(alertCalls).toBe(2);
            expect(noisy.failure?.code).toBe(
              STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
            );
          },
        );
      });

      describe("Queue latency telemetry helpers", () => {
        test("normalizes invalid thresholds with safe fallbacks", () => {
          expect(normalizeQueueLatencyThreshold(NaN)).toBe(
            DEFAULT_QUEUE_P95_WARN_THRESHOLD_MS,
          );
          expect(normalizeQueueLatencyThreshold(-10)).toBe(
            MIN_QUEUE_LATENCY_THRESHOLD_MS,
          );
          expect(normalizeQueueLatencyThreshold(1.9)).toBe(1);
          expect(
            normalizeQueueLatencyThreshold(undefined, Number.POSITIVE_INFINITY),
          ).toBe(DEFAULT_QUEUE_P95_WARN_THRESHOLD_MS);
        });

        test(
          "logs slow submissions when p95 > 1s even with relaxed warn thresholds",
          async () => {
            const gaugeSamples: QueueLatencySample[] = [];
            const slowSamples: QueueLatencySample[] = [];
            const ctx = buildContext({
              readQueueLatency: async () => ({ p95Ms: 1_150, pending: 2 }),
              queueTelemetry: {
                emitGauge: (sample) => {
                  gaugeSamples.push(sample);
                },
                logSlowSubmission: (sample) => {
                  slowSamples.push(sample);
                },
              },
            });
            const result = await runStartupPreflight(ctx, {
              queueLatencyWarnThresholdMs: 5_000,
            });
            expect(result.ok).toBe(true);
            expect(gaugeSamples).toHaveLength(1);
            expect(gaugeSamples[0]?.thresholdMs).toBe(5_000);
            expect(slowSamples).toHaveLength(1);
            expect(slowSamples[0]?.p95Ms).toBe(1_150);
          },
        );
      });

      describe("Deterministic ordering tie-breakers", () => {
        test("sorts same-rank checks via ASCII label comparison", async () => {
          const observed: string[] = [];
          const buildCheck = (label: string): StartupCheckDefinition => ({
            code: STARTUP_FAILURE_CODES.DISPATCH_FAILED,
            label,
            action: "noop",
            category: "dispatch",
            run: async () => {
              observed.push(label);
              return { ok: true, detail: label };
            },
          });
          const checklist = new StartupChecklist([
            buildCheck("zeta"),
            buildCheck("alpha"),
          ]);
          const ctx = buildContext();
          const result = await checklist.run(ctx);
          expect(result.ok).toBe(true);
          expect(observed).toEqual(["alpha", "zeta"]);
        });
      });
    } catch {
      // Inline tests are best-effort; ignore registration errors.
    }
  })();
};

registerStartupChecklistInlineTests();
