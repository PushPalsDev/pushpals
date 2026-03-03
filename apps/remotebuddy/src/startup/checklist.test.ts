import { describe, expect, test } from "bun:test";

import {
  gateDispatchWithStartupPreflight,
  runStartupPreflight,
  STARTUP_CHECK_STRUCTURE,
  STARTUP_FAILURE_CODES,
  type RepoStatus,
  type StartupCheckRecord,
  type StartupChecklistContext,
  type StartupChecklistResult,
  type StartupFailureCode,
} from "./checklist.js";

const cleanRepo = (): RepoStatus => ({
  isDirty: false,
  isMergeInProgress: false,
  branch: "main",
  detail: "clean repo",
});

const buildContext = (
  overrides: Partial<StartupChecklistContext> = {},
): StartupChecklistContext => ({
  describeRepo: async () => cleanRepo(),
  listFiringAlerts: async () => [],
  syntheticTester: {
    runSyntheticJob: async () => ({ ok: true, latencyMs: 150 }),
  },
  detectGitVersion: async () => "git version 2.45.1",
  ...overrides,
});

type GitRuntimeHarness = {
  ctx: StartupChecklistContext;
  logs: StartupCheckRecord[];
  counters: {
    repoDescribe: number;
    alerts: number;
    synthetic: number;
    dispatch: number;
  };
  dispatch: () => Promise<void>;
};

const createGitRuntimeFailFastHarness = (
  detectOverride: () => Promise<string | null>,
): GitRuntimeHarness => {
  const logs: StartupCheckRecord[] = [];
  const counters = {
    repoDescribe: 0,
    alerts: 0,
    synthetic: 0,
    dispatch: 0,
  };
  const ctx = buildContext({
    detectGitVersion: detectOverride,
    describeRepo: async () => {
      counters.repoDescribe += 1;
      return cleanRepo();
    },
    listFiringAlerts: async () => {
      counters.alerts += 1;
      return [];
    },
    syntheticTester: {
      runSyntheticJob: async () => {
        counters.synthetic += 1;
        return { ok: true, latencyMs: 200 };
      },
    },
    log: (entry) => logs.push(entry),
  });
  const dispatch = async () => {
    counters.dispatch += 1;
  };
  return { ctx, logs, counters, dispatch };
};

const expectGitRuntimeFailFast = (
  harness: GitRuntimeHarness,
  result: StartupChecklistResult,
) => {
  expect(result.history).toHaveLength(1);
  const [record] = result.history;
  expect(record.code).toBe(STARTUP_FAILURE_CODES.GIT_RUNTIME_UNSUPPORTED);
  expect(record.category).toBe("repo");
  expect(record.step).toBe(1);
  expect(record.status).toBe("fail");
  expect(result.failure?.code).toBe(record.code);
  expect(result.failure?.category).toBe(record.category);
  expect(result.failure?.step).toBe(record.step);
  expect(result.failure?.detail).toBe(record.detail);
  expect(harness.logs).toHaveLength(1);
  expect(harness.logs[0]).toEqual(record);
  expect(harness.counters.repoDescribe).toBe(0);
  expect(harness.counters.alerts).toBe(0);
  expect(harness.counters.synthetic).toBe(0);
  expect(harness.counters.dispatch).toBe(0);
};

const actionFor = (code: StartupFailureCode): string => {
  const entry = STARTUP_CHECK_STRUCTURE.find((item) => item.code === code);
  if (!entry) {
    throw new Error(`Missing startup check structure for ${code}`);
  }
  return entry.action;
};

describe("StartupChecklist", () => {
  test(
    "surfaces actionable failure codes for merge or dirty states",
    async () => {
      const ctx = buildContext({
        describeRepo: async () => ({
          isDirty: false,
          isMergeInProgress: true,
          detail: "rebase in progress",
        }),
      });
      const mergeBlocked = await runStartupPreflight(ctx);
      expect(mergeBlocked.ok).toBe(false);
      expect(mergeBlocked.failure?.code).toBe(
        STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      );
      expect(mergeBlocked.failure?.action).toContain("Resolve");
      expect(mergeBlocked.failure?.category).toBe("repo");
      expect(mergeBlocked.failure?.step).toBe(2);

      const dirtyCtx = buildContext({
        describeRepo: async () => ({
          isDirty: true,
          isMergeInProgress: false,
          branch: "feature/foo",
          detail: "src/startup.ts",
        }),
      });
      const dirtyBlocked = await runStartupPreflight(dirtyCtx);
      expect(dirtyBlocked.ok).toBe(false);
      expect(dirtyBlocked.failure?.code).toBe(
        STARTUP_FAILURE_CODES.REPO_DIRTY,
      );
      expect(dirtyBlocked.failure?.detail.includes("feature/foo")).toBeTruthy();
      expect(dirtyBlocked.failure?.category).toBe("repo");
      expect(dirtyBlocked.failure?.step).toBe(3);
    },
  );

  test("fails fast when git runtime is missing", async () => {
    const harness = createGitRuntimeFailFastHarness(async () => null);
    const result = await gateDispatchWithStartupPreflight(
      harness.ctx,
      harness.dispatch,
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.detail).toContain("not detected");
    expectGitRuntimeFailFast(harness, result);
  });

  test("fails fast when git version is below minimum requirement", async () => {
    const harness = createGitRuntimeFailFastHarness(
      async () => "git version 2.30.0",
    );
    const result = await gateDispatchWithStartupPreflight(
      harness.ctx,
      harness.dispatch,
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.detail).toContain("below required");
    expectGitRuntimeFailFast(harness, result);
  });

  test("fails fast when git version output is malformed", async () => {
    const harness = createGitRuntimeFailFastHarness(
      async () => "git version version_2.45.1",
    );
    const result = await gateDispatchWithStartupPreflight(
      harness.ctx,
      harness.dispatch,
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.detail).toContain("not a supported semver");
    expect(result.failure?.detail).toContain("version_2.45.1");
    expectGitRuntimeFailFast(harness, result);
  });

  test("captures detectGitVersion exceptions with telemetry detail", async () => {
    const harness = createGitRuntimeFailFastHarness(async () => {
      throw new Error("binary unreachable");
    });
    const result = await gateDispatchWithStartupPreflight(
      harness.ctx,
      harness.dispatch,
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.detail).toContain("binary unreachable");
    expectGitRuntimeFailFast(harness, result);
    expect(harness.logs[0].detail).toContain("binary unreachable");
  });

  test("supports explicit dirty-worktree bypass option", async () => {
    const ctx = buildContext({
      describeRepo: async () => ({
        isDirty: true,
        isMergeInProgress: false,
        branch: "feature/bypass",
        detail: "README.md",
      }),
    });
    const result = await runStartupPreflight(ctx, {
      allowDirtyWorktree: true,
    });
    expect(result.ok).toBe(true);
    const dirtyRecord = result.history.find(
      (entry) => entry.code === STARTUP_FAILURE_CODES.REPO_DIRTY,
    );
    expect(dirtyRecord?.status).toBe("pass");
    expect(dirtyRecord?.detail).toContain("allowDirtyWorktree=true");
  });

  test("synthetic guard runs before dispatch and blocks failures", async () => {
    const successOrder: string[] = [];
    const successCtx = buildContext({
      syntheticTester: {
        runSyntheticJob: async (options) => {
          successOrder.push(`synthetic:${options.probeName}`);
          return { ok: true, latencyMs: 200 };
        },
      },
    });
    const successDispatch = async () => {
      successOrder.push("dispatch");
    };
    const success = await gateDispatchWithStartupPreflight(
      successCtx,
      successDispatch,
      { syntheticProbeName: "startup.synthetic" },
    );
    expect(success.ok).toBe(true);
    expect(successOrder).toEqual([
      "synthetic:startup.synthetic",
      "dispatch",
    ]);
    const lastEntry = success.history.at(-1);
    expect(lastEntry?.category).toBe("dispatch");
    expect(lastEntry?.status).toBe("pass");
    expect(lastEntry?.step).toBe(6);

    const failureOrder: string[] = [];
    const failureDispatchCalls: string[] = [];
    const failureCtx = buildContext({
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
    });
    const blockedDispatch = async () => {
      failureDispatchCalls.push("dispatch");
    };
    const failed = await gateDispatchWithStartupPreflight(
      failureCtx,
      blockedDispatch,
    );
    expect(failed.ok).toBe(false);
    expect(failed.failure?.code).toBe(STARTUP_FAILURE_CODES.SYNTHETIC_FAILED);
    expect(failureOrder).toEqual(["synthetic:probe.remote_startup"]);
    expect(failureDispatchCalls).toHaveLength(0);
  });

  test(
    "gate aborts dispatch when deterministic checks fail before alerts",
    async () => {
      const dispatchCalls: string[] = [];
      let alertChecks = 0;
      let syntheticChecks = 0;
      const ctx = buildContext({
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
      });
      const result = await gateDispatchWithStartupPreflight(
        ctx,
        async () => {
          dispatchCalls.push("dispatch");
        },
      );
      expect(result.ok).toBe(false);
      expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.REPO_DIRTY);
      expect(result.failure?.category).toBe("repo");
      expect(result.failure?.step).toBe(3);
      expect(dispatchCalls).toHaveLength(0);
      expect(alertChecks).toBe(0);
      expect(syntheticChecks).toBe(0);
    },
  );

  test("synthetic probe failure surfaces actionable guidance", async () => {
    const ctx = buildContext({
      syntheticTester: {
        runSyntheticJob: async () => ({
          ok: false,
          latencyMs: 1337,
          failureDetail: "connection reset",
        }),
      },
    });
    const result = await runStartupPreflight(ctx, {
      syntheticMaxLatencyMs: 600,
      syntheticProbeName: "startup.synthetic",
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.SYNTHETIC_FAILED);
    expect(result.failure?.category).toBe("synthetic");
    expect(result.failure?.step).toBe(5);
    expect(result.failure?.detail).toContain("startup.synthetic");
    expect(result.failure?.detail).toContain("connection reset");
    expect(result.failure?.action).toContain("synthetic probe");
  });

  test("pass history captures every check for observability", async () => {
    const ctx = buildContext();
    const result = await runStartupPreflight(ctx, {
      syntheticMaxLatencyMs: 500,
    });
    expect(result.ok).toBe(true);
    expect(result.history).toHaveLength(5);
    expect(result.history.map((h) => h.code)).toEqual([
      STARTUP_FAILURE_CODES.GIT_RUNTIME_UNSUPPORTED,
      STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      STARTUP_FAILURE_CODES.REPO_DIRTY,
      STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    ]);
    expect(result.history.map((h) => h.step)).toEqual([1, 2, 3, 4, 5]);
    expect(result.history.map((h) => h.category)).toEqual([
      "repo",
      "repo",
      "repo",
      "alerts",
      "synthetic",
    ]);
    const historyEntry = result.history.at(-1);
    expect(historyEntry?.detail).toContain("finished");
  });

  test("exports structured checklist metadata", () => {
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.step)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.category)).toEqual([
      "repo",
      "repo",
      "repo",
      "alerts",
      "synthetic",
      "dispatch",
    ]);
    const dispatchEntry = STARTUP_CHECK_STRUCTURE.find(
      (entry) => entry.code === STARTUP_FAILURE_CODES.DISPATCH_FAILED,
    );
    expect(dispatchEntry?.action).toContain("RemoteBuddy + WorkerPals");
    expect(dispatchEntry?.label).toContain("dispatch");
  });

  test("synthetic record captures gating failure before dispatch", async () => {
    const dispatchCalls: string[] = [];
    const ctx = buildContext({
      syntheticTester: {
        runSyntheticJob: async () => ({
          ok: false,
          latencyMs: 999,
          failureDetail: "probe timeout",
        }),
      },
    });
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
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.SYNTHETIC_FAILED);
    expect(result.failure?.category).toBe("synthetic");
    expect(result.failure?.step).toBe(5);
    const lastHistoryEntry = result.history.at(-1);
    expect(lastHistoryEntry?.code).toBe(
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    );
    expect(lastHistoryEntry?.category).toBe("synthetic");
    expect(lastHistoryEntry?.status).toBe("fail");
    expect(dispatchCalls).toHaveLength(0);
  });

  test("captures describeRepo exceptions with structured history", async () => {
    const ctx = buildContext({
      describeRepo: async () => {
        throw new Error("git status failed");
      },
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
    );
    const record = result.history.find(
      (entry) => entry.code === STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
    );
    expect(record?.status).toBe("fail");
    expect(record?.detail).toContain("git status failed");
    expect(record?.action).toContain("Resolve or abort");
  });

  test("captures listFiringAlerts exceptions with actionable detail", async () => {
    const ctx = buildContext({
      listFiringAlerts: async () => {
        throw new Error("alertmanager unreachable");
      },
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.ALERTS_ACTIVE);
    expect(result.failure?.step).toBe(4);
    const record = result.history.find(
      (entry) => entry.code === STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
    );
    expect(record?.status).toBe("fail");
    expect(record?.detail).toContain("alertmanager unreachable");
    expect(record?.action).toContain("Alertmanager");
  });

  test("captures synthetic tester exceptions with actionable detail", async () => {
    const ctx = buildContext({
      syntheticTester: {
        runSyntheticJob: async () => {
          throw new Error("probe crashed");
        },
      },
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.SYNTHETIC_FAILED);
    expect(result.failure?.step).toBe(5);
    const record = result.history.at(-1);
    expect(record?.status).toBe("fail");
    expect(record?.detail).toContain("probe crashed");
    expect(record?.action).toContain("synthetic probe");
  });

  test("returns structured failure when dispatchJob throws", async () => {
    const ctx = buildContext();
    const result = await gateDispatchWithStartupPreflight(ctx, async () => {
      throw new Error("enqueue failed");
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
    expect(result.failure?.category).toBe("dispatch");
    expect(result.failure?.detail).toContain("Dispatch job failed");
    expect(result.failure?.detail).toContain("enqueue failed");
    expect(result.failure?.step).toBe(6);
    const expectedAction = actionFor(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
    expect(result.failure?.action).toBe(expectedAction);
    const lastHistoryEntry = result.history.at(-1);
    expect(lastHistoryEntry?.category).toBe("dispatch");
    expect(lastHistoryEntry?.status).toBe("fail");
    expect(lastHistoryEntry?.detail).toBe(result.failure?.detail);
    expect(lastHistoryEntry?.action).toBe(expectedAction);
    expect(lastHistoryEntry?.step).toBe(result.failure?.step);
  });

  describe("structured dependency failures", () => {
    test("describeRepo exceptions populate history/action/detail consistently", async () => {
      const err = new Error("git status failed hard");
      const ctx = buildContext({
        describeRepo: async () => {
          throw err;
        },
      });
      const result = await runStartupPreflight(ctx);
      expect(result.ok).toBe(false);
      expect(result.failure?.code).toBe(
        STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      );
      const expectedAction = actionFor(
        STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      );
      const record = result.history.find(
        (entry) => entry.code === STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      );
      expect(record?.status).toBe("fail");
      expect(record?.detail).toContain(err.message);
      expect(result.failure?.detail).toContain(err.message);
      expect(record?.action).toBe(expectedAction);
      expect(result.failure?.action).toBe(expectedAction);
      expect(record?.detail).toBe(result.failure?.detail);
      expect(record?.step).toBe(result.failure?.step);
    });

    test("listFiringAlerts exceptions carry actionable history and failure detail", async () => {
      const err = new Error("alertmanager unreachable");
      const ctx = buildContext({
        listFiringAlerts: async () => {
          throw err;
        },
      });
      const result = await runStartupPreflight(ctx);
      expect(result.ok).toBe(false);
      expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.ALERTS_ACTIVE);
      const expectedAction = actionFor(STARTUP_FAILURE_CODES.ALERTS_ACTIVE);
      const record = result.history.find(
        (entry) => entry.code === STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
      );
      expect(record?.status).toBe("fail");
      expect(record?.detail).toContain(err.message);
      expect(result.failure?.detail).toContain(err.message);
      expect(record?.action).toBe(expectedAction);
      expect(result.failure?.action).toBe(expectedAction);
      expect(record?.detail).toBe(result.failure?.detail);
      expect(record?.step).toBe(result.failure?.step);
    });

    test("synthetic tester exceptions surface category, action, and detail", async () => {
      const err = new Error("probe crashed");
      const ctx = buildContext({
        syntheticTester: {
          runSyntheticJob: async () => {
            throw err;
          },
        },
      });
      const result = await runStartupPreflight(ctx);
      expect(result.ok).toBe(false);
      expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.SYNTHETIC_FAILED);
      const expectedAction = actionFor(STARTUP_FAILURE_CODES.SYNTHETIC_FAILED);
      const record = result.history.find(
        (entry) => entry.code === STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
      );
      expect(record?.status).toBe("fail");
      expect(record?.detail).toContain(err.message);
      expect(result.failure?.detail).toContain(err.message);
      expect(record?.action).toBe(expectedAction);
      expect(result.failure?.action).toBe(expectedAction);
      expect(record?.detail).toBe(result.failure?.detail);
      expect(record?.step).toBe(result.failure?.step);
    });

    test("dispatchJob exceptions track history/action/detail for operators", async () => {
      const ctx = buildContext();
      const result = await gateDispatchWithStartupPreflight(ctx, async () => {
        throw new Error("dispatch pipeline offline");
      });
      expect(result.ok).toBe(false);
      expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
      expect(result.failure?.category).toBe("dispatch");
      expect(result.failure?.detail).toContain("Dispatch job failed");
      expect(result.failure?.detail).toContain("dispatch pipeline offline");
      const expectedAction = actionFor(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
      expect(result.failure?.action).toBe(expectedAction);
      const record = result.history.find(
        (entry) => entry.code === STARTUP_FAILURE_CODES.DISPATCH_FAILED,
      );
      expect(record?.status).toBe("fail");
      expect(record?.category).toBe("dispatch");
      expect(record?.detail).toBe(result.failure?.detail);
      expect(record?.action).toBe(expectedAction);
      expect(record?.step).toBe(result.failure?.step);
    });
  });
});
