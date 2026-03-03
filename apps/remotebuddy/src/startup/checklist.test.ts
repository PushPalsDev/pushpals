import { describe, expect, test } from "bun:test";

import {
  gateDispatchWithStartupPreflight,
  runStartupPreflight,
  STARTUP_CHECK_STRUCTURE,
  STARTUP_FAILURE_CODES,
  type RepoStatus,
  type StartupCheckRecord,
  type StartupChecklistContext,
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
  ...overrides,
});

const actionFor = (code: StartupFailureCode): string => {
  const entry = STARTUP_CHECK_STRUCTURE.find((item) => item.code === code);
  if (!entry) {
    throw new Error(`Missing startup check structure for ${code}`);
  }
  return entry.action;
};

const externalRecordCompatibility = {
  code: STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
  label: "compat",
  category: "repo",
  step: 1,
  status: "pass",
  detail: "example",
  elapsedMs: 0,
} satisfies StartupCheckRecord;
void externalRecordCompatibility;

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
      expect(mergeBlocked.failure?.step).toBe(1);

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
      expect(dirtyBlocked.failure?.step).toBe(2);
    },
  );

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
    expect(lastEntry?.step).toBe(5);

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
      expect(result.failure?.step).toBe(2);
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
    expect(result.failure?.step).toBe(4);
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
  });

  test("exports structured checklist metadata", () => {
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.step)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.category)).toEqual([
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
    expect(result.failure?.step).toBe(4);
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
    const firstRecord = result.history[0];
    expect(firstRecord.status).toBe("fail");
    expect(firstRecord.detail).toContain("git status failed");
    expect(firstRecord.action).toContain("Resolve or abort");
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
    expect(result.failure?.step).toBe(3);
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
    expect(result.failure?.step).toBe(4);
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
    expect(result.failure?.step).toBe(5);
    const expectedAction = actionFor(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
    expect(result.failure?.action).toBe(expectedAction);
    const lastHistoryEntry = result.history.at(-1);
    expect(lastHistoryEntry?.category).toBe("dispatch");
    expect(lastHistoryEntry?.status).toBe("fail");
    expect(lastHistoryEntry?.detail).toBe(result.failure?.detail);
    expect(lastHistoryEntry?.action).toBe(expectedAction);
    expect(lastHistoryEntry?.step).toBe(result.failure?.step);
  });

  describe("record compatibility", () => {
    test("externally constructed records without timing fields integrate with telemetry", async () => {
      const minimalRecord: StartupCheckRecord = {
        code: STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
        label: "external history",
        category: "alerts",
        step: 3,
        status: "pass",
        detail: "preexisting pass record",
        elapsedMs: 5,
      };
      const revived = JSON.parse(JSON.stringify(minimalRecord)) as StartupCheckRecord;
      expect(revived.startedAtMs).toBeUndefined();
      expect(revived.completedAtMs).toBeUndefined();
      const telemetry: StartupCheckRecord[] = [revived];
      const ctx = buildContext({
        log: (entry) => {
          const serialized = JSON.stringify(entry);
          const externalized = JSON.parse(serialized) as StartupCheckRecord;
          telemetry.push(externalized);
        },
      });
      const result = await gateDispatchWithStartupPreflight(ctx, async () => {});
      expect(result.ok).toBe(true);
      expect(telemetry[0]).toEqual(revived);
      const dispatchRecord = telemetry.at(-1);
      expect(dispatchRecord?.code).toBe(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
      expect(typeof dispatchRecord?.startedAtMs).toBe("number");
      expect(typeof dispatchRecord?.completedAtMs).toBe("number");
      expect(
        telemetry.filter((record) => record.startedAtMs === undefined).length,
      ).toBeGreaterThan(0);
    });
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

  describe("telemetry parity", () => {
    test("preflight failure telemetry matches failure envelope", async () => {
      const telemetry: StartupCheckRecord[] = [];
      const failureCause = { step: "describeRepo" };
      const err = new Error("git status offline", { cause: failureCause });
      const ctx = buildContext({
        describeRepo: async () => {
          throw err;
        },
        log: (entry) => {
          telemetry.push(entry);
        },
      });
      const result = await runStartupPreflight(ctx);
      expect(result.ok).toBe(false);
      const failureRecord = telemetry.find(
        (entry) => entry.code === STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      );
      expect(failureRecord?.status).toBe("fail");
      expect(result.failure?.error).toBe(failureRecord?.error);
      expect(failureRecord?.error?.message).toBe(err.message);
      expect(failureRecord?.error?.raw).toBe(err);
      expect(failureRecord?.error?.cause).toBe(failureCause);
      expect(failureRecord?.error?.stack).toBeTruthy();
      expect(result.failure?.error?.stack).toBe(failureRecord?.error?.stack);
    });

    test("dispatch failure telemetry matches failure envelope", async () => {
      const telemetry: StartupCheckRecord[] = [];
      const failureCause = new Error("queue saturated");
      const dispatchError = new Error("dispatch offline", { cause: failureCause });
      const ctx = buildContext({
        log: (entry) => {
          telemetry.push(entry);
        },
      });
      const result = await gateDispatchWithStartupPreflight(ctx, async () => {
        throw dispatchError;
      });
      expect(result.ok).toBe(false);
      const failureRecord = telemetry.at(-1);
      expect(failureRecord?.code).toBe(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
      expect(failureRecord?.status).toBe("fail");
      expect(result.failure?.error).toBe(failureRecord?.error);
      expect(failureRecord?.error?.message).toBe(dispatchError.message);
      expect(failureRecord?.error?.raw).toBe(dispatchError);
      expect(failureRecord?.error?.cause).toBe(failureCause);
      expect(failureRecord?.error?.stack).toBeTruthy();
    });
  });

  describe("error normalization", () => {
    test("string throws populate detail and telemetry payloads", async () => {
      const telemetry: StartupCheckRecord[] = [];
      const ctx = buildContext({
        describeRepo: async () => {
          throw "git status offline";
        },
        log: (entry) => {
          telemetry.push(entry);
        },
      });
      const result = await runStartupPreflight(ctx);
      expect(result.ok).toBe(false);
      expect(result.failure?.detail).toBe("git status offline");
      expect(result.failure?.error?.message).toBe("git status offline");
      expect(result.failure?.error?.stack).toBeUndefined();
      const historyRecord = telemetry[0];
      expect(historyRecord?.error?.message).toBe("git status offline");
      expect(typeof historyRecord?.startedAtMs).toBe("number");
      expect(typeof historyRecord?.completedAtMs).toBe("number");
    });

    test("object throws serialize into error detail for operators", async () => {
      const thrown = { reason: "git offline", cause: { step: "describeRepo" } };
      const ctx = buildContext({
        describeRepo: async () => {
          throw thrown;
        },
      });
      const result = await runStartupPreflight(ctx);
      const expectedDetail = JSON.stringify(thrown);
      expect(result.ok).toBe(false);
      expect(result.failure?.detail).toBe(expectedDetail);
      expect(result.failure?.error?.message).toBe(expectedDetail);
      const firstRecord = result.history[0];
      expect(firstRecord.error?.raw).toBe(thrown);
      expect(firstRecord.error?.cause).toBe(thrown.cause);
    });

    test("dispatch telemetry captures non-Error throw fidelity", async () => {
      const telemetry: StartupCheckRecord[] = [];
      const thrown = { reason: "queue blocked" };
      const ctx = buildContext({
        log: (entry) => {
          telemetry.push(entry);
        },
      });
      const result = await gateDispatchWithStartupPreflight(ctx, async () => {
        throw thrown;
      });
      const expectedDetail = JSON.stringify(thrown);
      expect(result.ok).toBe(false);
      expect(result.failure?.detail).toBe(
        `Dispatch job failed: ${expectedDetail}`,
      );
      expect(result.failure?.error?.message).toBe(expectedDetail);
      const failureRecord = telemetry.at(-1);
      expect(failureRecord?.error?.message).toBe(expectedDetail);
      expect(failureRecord?.error?.raw).toBe(thrown);
    });

    test("object throws with explicit message retain JSON structure in detail", async () => {
      const thrown = {
        message: "probe blocked",
        probe: "startup.synthetic",
        detail: "latency sla breach",
      };
      const ctx = buildContext({
        syntheticTester: {
          runSyntheticJob: async () => {
            throw thrown;
          },
        },
      });
      const result = await runStartupPreflight(ctx);
      const expectedJson = JSON.stringify(thrown);
      const expectedDetail = `probe blocked | ${expectedJson}`;
      expect(result.ok).toBe(false);
      expect(result.failure?.detail).toBe(expectedDetail);
      expect(result.failure?.error?.message).toBe(expectedDetail);
      expect(result.failure?.error?.raw).toBe(thrown);
    });

    test("non-Error primitives produce descriptive failure detail", async () => {
      const panicSymbol = Symbol("panic");
      function meltdown() {
        return "fail";
      }
      const cases: Array<{ thrown: unknown; expected: string }> = [
        {
          thrown: null,
          expected: "Unknown error running startup check. (received null)",
        },
        {
          thrown: undefined,
          expected: "Unknown error running startup check. (received undefined)",
        },
        { thrown: 404, expected: "404" },
        { thrown: false, expected: "false" },
        { thrown: panicSymbol, expected: "Symbol(panic)" },
        { thrown: meltdown, expected: "[function meltdown]" },
      ];
      for (const { thrown, expected } of cases) {
        const ctx = buildContext({
          describeRepo: async () => {
            throw thrown;
          },
        });
        const result = await runStartupPreflight(ctx);
        expect(result.ok).toBe(false);
        expect(result.failure?.detail).toBe(expected);
        expect(result.failure?.error?.message).toBe(expected);
        expect(result.failure?.error?.raw).toBe(thrown);
      }
    });

    test("dispatch guard normalizes primitive throws consistently", async () => {
      const panicSymbol = Symbol("dispatch-panic");
      function dispatchFn() {
        return undefined;
      }
      const cases: Array<{ thrown: unknown; expected: string }> = [
        { thrown: panicSymbol, expected: "Symbol(dispatch-panic)" },
        { thrown: dispatchFn, expected: "[function dispatchFn]" },
      ];
      for (const { thrown, expected } of cases) {
        const telemetry: StartupCheckRecord[] = [];
        const ctx = buildContext({
          log: (entry) => {
            telemetry.push(entry);
          },
        });
        const result = await gateDispatchWithStartupPreflight(ctx, async () => {
          throw thrown;
        });
        expect(result.ok).toBe(false);
        expect(result.failure?.detail).toBe(
          `Dispatch job failed: ${expected}`,
        );
        expect(result.failure?.error?.message).toBe(expected);
        expect(result.failure?.error?.raw).toBe(thrown);
        const failureRecord = telemetry.at(-1);
        expect(failureRecord?.error?.message).toBe(expected);
        expect(failureRecord?.error?.raw).toBe(thrown);
      }
    });
  });
});
