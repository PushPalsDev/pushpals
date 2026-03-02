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
} as const;

export type StartupFailureCode =
  (typeof STARTUP_FAILURE_CODES)[keyof typeof STARTUP_FAILURE_CODES];

type StartupCheckStatus = "pass" | "fail";

export type StartupCheckCategory = "repo" | "alerts" | "synthetic";

export interface StartupChecklistOptions {
  syntheticMaxLatencyMs?: number;
  syntheticProbeName?: string;
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
      "Commit, stash, or drop untracked files; rerun when git status is clean or explicitly allow dirty worktrees.",
    category: "repo",
    run: async (ctx) => {
      const status = await ctx.describeRepo();
      if (status.isDirty) {
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

export const STARTUP_CHECK_STRUCTURE: readonly StartupCheckStructure[] =
  defaultChecks.map((check, index) => ({
    code: check.code,
    label: check.label,
    action: check.action,
    category: check.category,
    step: index + 1,
  }));

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
  await dispatchJob();
  return result;
};

const isTestRuntime =
  typeof globalThis !== "undefined" &&
  (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun
    ?.env?.NODE_ENV === "test";

if (isTestRuntime) {
  const { describe, expect, test } = await import("bun:test");

  const cleanRepo = (): RepoStatus => ({
    isDirty: false,
    isMergeInProgress: false,
    branch: "main",
    detail: "clean repo",
  });

  describe("StartupChecklist", () => {
    test(
      "startup preflight surfaces actionable failure codes for merge or dirty states",
      async () => {
        const ctx: StartupChecklistContext = {
          describeRepo: async () => cleanRepo(),
          listFiringAlerts: async () => [],
          syntheticTester: {
            runSyntheticJob: async () => ({ ok: true, latencyMs: 150 }),
          },
        };

        ctx.describeRepo = async () => ({
          isDirty: false,
          isMergeInProgress: true,
          detail: "rebase in progress",
        });
        const mergeBlocked = await runStartupPreflight(ctx);
        expect(mergeBlocked.ok).toBe(false);
        expect(mergeBlocked.failure?.code).toBe(
          STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
        );
        expect(mergeBlocked.failure?.action).toContain("Resolve");
        expect(mergeBlocked.failure?.category).toBe("repo");
        expect(mergeBlocked.failure?.step).toBe(1);

        ctx.describeRepo = async () => ({
          isDirty: true,
          isMergeInProgress: false,
          branch: "feature/foo",
          detail: "src/startup.ts",
        });
        const dirtyBlocked = await runStartupPreflight(ctx);
        expect(dirtyBlocked.ok).toBe(false);
        expect(dirtyBlocked.failure?.code).toBe(STARTUP_FAILURE_CODES.REPO_DIRTY);
        expect(dirtyBlocked.failure?.detail.includes("feature/foo")).toBeTruthy();
        expect(dirtyBlocked.failure?.category).toBe("repo");
        expect(dirtyBlocked.failure?.step).toBe(2);
      },
    );

    test(
      "startup synthetic guard runs before dispatch and blocks failures",
      async () => {
        const successOrder: string[] = [];
        const successCtx: StartupChecklistContext = {
          describeRepo: async () => cleanRepo(),
          listFiringAlerts: async () => [],
          syntheticTester: {
            runSyntheticJob: async (options) => {
              successOrder.push(`synthetic:${options.probeName}`);
              return { ok: true, latencyMs: 200 };
            },
          },
        };
        const successDispatch = async () => {
          successOrder.push("dispatch");
        };
        const success = await gateDispatchWithStartupPreflight(
          successCtx,
          successDispatch,
          {
            syntheticProbeName: "startup.synthetic",
          },
        );
        expect(success.ok).toBe(true);
        expect(successOrder).toEqual(["synthetic:startup.synthetic", "dispatch"]);
        expect(success.history.at(-1)?.category).toBe("synthetic");
        expect(success.history.at(-1)?.step).toBe(4);

        const failureOrder: string[] = [];
        const failureDispatchCalls: string[] = [];
        const failureCtx: StartupChecklistContext = {
          describeRepo: async () => cleanRepo(),
          listFiringAlerts: async () => [],
          syntheticTester: {
            runSyntheticJob: async (options) => {
              failureOrder.push(`synthetic:${options.probeName}`);
              return {
                ok: false,
                latencyMs: 1200,
                failureDetail: "timeout",
              };
            },
          },
        };
        const blockedDispatch = async () => {
          failureDispatchCalls.push("dispatch");
        };
        const failed = await gateDispatchWithStartupPreflight(
          failureCtx,
          blockedDispatch,
        );
        expect(failed.ok).toBe(false);
        expect(failed.failure?.code).toBe(
          STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
        );
        expect(failureOrder).toEqual(["synthetic:probe.remote_startup"]);
        expect(failureDispatchCalls).toHaveLength(0);
      },
    );

    test(
      "startup gate aborts dispatch when deterministic checks fail early",
      async () => {
        const dispatchCalls: string[] = [];
        let alertChecks = 0;
        let syntheticChecks = 0;
        const ctx: StartupChecklistContext = {
          describeRepo: async () => ({
            isDirty: true,
            isMergeInProgress: false,
            branch: "feature/dirty",
            detail: "README.md",
          }),
          listFiringAlerts: async () => {
            alertChecks += 1;
            return [];
          },
          syntheticTester: {
            runSyntheticJob: async () => {
              syntheticChecks += 1;
              return { ok: true, latencyMs: 210 };
            },
          },
        };
        const result = await gateDispatchWithStartupPreflight(
          ctx,
          async () => {
            dispatchCalls.push("dispatch");
          },
        );
        expect(result.ok).toBe(false);
        expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.REPO_DIRTY);
        expect(result.failure?.category).toBe("repo");
        expect(result.failure?.step).toBe(2);
        expect(dispatchCalls).toHaveLength(0);
        expect(alertChecks).toBe(0);
        expect(syntheticChecks).toBe(0);
      },
    );

    test("startup synthetic probe failure surfaces actionable guidance", async () => {
      const ctx: StartupChecklistContext = {
        describeRepo: async () => cleanRepo(),
        listFiringAlerts: async () => [],
        syntheticTester: {
          runSyntheticJob: async () => ({
            ok: false,
            latencyMs: 1337,
            failureDetail: "connection reset",
          }),
        },
      };
      const result = await runStartupPreflight(ctx, {
        syntheticMaxLatencyMs: 600,
        syntheticProbeName: "startup.synthetic",
      });
      expect(result.ok).toBe(false);
      expect(result.failure?.code).toBe(
        STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
      );
      expect(result.failure?.category).toBe("synthetic");
      expect(result.failure?.step).toBe(4);
      expect(result.failure?.detail).toContain("startup.synthetic");
      expect(result.failure?.detail).toContain("connection reset");
      expect(result.failure?.action).toContain("synthetic probe");
    });

    test(
      "startup pass history captures every check for observability",
      async () => {
        const ctx: StartupChecklistContext = {
          describeRepo: async () => cleanRepo(),
          listFiringAlerts: async () => [],
          syntheticTester: {
            runSyntheticJob: async () => ({ ok: true, latencyMs: 320 }),
          },
        };
        const result = await runStartupPreflight(ctx, {
          syntheticMaxLatencyMs: 500,
        });
        expect(result.ok).toBe(true);
        expect(result.history).toHaveLength(4);
        expect(result.history.map((h) => h.code)).toEqual([
          STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
          STARTUP_FAILURE_CODES.REPO_DIRTY,
          STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
          STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
        ]);
        expect(result.history.map((h) => h.step)).toEqual([1, 2, 3, 4]);
        expect(result.history.map((h) => h.category)).toEqual([
          "repo",
          "repo",
          "alerts",
          "synthetic",
        ]);
        const historyEntry = result.history.at(-1);
        expect(historyEntry?.detail).toContain("finished");
      },
    );

    test("startup structured checklist metadata is exported", () => {
      expect(STARTUP_CHECK_STRUCTURE.map((item) => item.step)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(STARTUP_CHECK_STRUCTURE.map((item) => item.category)).toEqual([
        "repo",
        "repo",
        "alerts",
        "synthetic",
      ]);
    });

    test(
      "startup synthetic record captures gating failure before dispatch",
      async () => {
        const dispatchCalls: string[] = [];
        const ctx: StartupChecklistContext = {
          describeRepo: async () => cleanRepo(),
          listFiringAlerts: async () => [],
          syntheticTester: {
            runSyntheticJob: async () => ({
              ok: false,
              latencyMs: 999,
              failureDetail: "probe timeout",
            }),
          },
        };
        const result = await gateDispatchWithStartupPreflight(
          ctx,
          async () => {
            dispatchCalls.push("dispatch");
          },
          {
            syntheticProbeName: "startup.synthetic",
            syntheticMaxLatencyMs: 500,
          },
        );
        expect(result.ok).toBe(false);
        expect(result.failure?.code).toBe(
          STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
        );
        expect(result.failure?.category).toBe("synthetic");
        expect(result.failure?.step).toBe(4);
        const lastHistoryEntry = result.history.at(-1);
        expect(lastHistoryEntry?.code).toBe(
          STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
        );
        expect(lastHistoryEntry?.category).toBe("synthetic");
        expect(lastHistoryEntry?.status).toBe("fail");
        expect(dispatchCalls).toHaveLength(0);
      },
    );
  });
}
