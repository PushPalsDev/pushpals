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
  type StartupTelemetryEvent,
  type StartupTelemetryPhaseEvent,
  type StartupTelemetryUnknownFailureEvent,
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
  readBunVersion: async () => "1.3.14",
  readDockerVersion: async () => "25.0.0",
  ...overrides,
});

const actionFor = (code: StartupFailureCode): string => {
  const entry = STARTUP_CHECK_STRUCTURE.find((item) => item.code === code);
  if (!entry) {
    throw new Error(`Missing startup check structure for ${code}`);
  }
  return entry.action;
};

describe("StartupChecklist", () => {
  test("surfaces actionable failure codes for merge or dirty states", async () => {
    const ctx = buildContext({
      describeRepo: async () => ({
        isDirty: false,
        isMergeInProgress: true,
        detail: "rebase in progress",
      }),
    });
    const mergeBlocked = await runStartupPreflight(ctx);
    expect(mergeBlocked.ok).toBe(false);
    expect(mergeBlocked.failure?.code).toBe(STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS);
    expect(mergeBlocked.failure?.action).toContain("Resolve");
    expect(mergeBlocked.failure?.category).toBe("repo");
    expect(mergeBlocked.failure?.step).toBe(3);

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
    expect(dirtyBlocked.failure?.code).toBe(STARTUP_FAILURE_CODES.REPO_DIRTY);
    expect(dirtyBlocked.failure?.detail.includes("feature/foo")).toBeTruthy();
    expect(dirtyBlocked.failure?.category).toBe("repo");
    expect(dirtyBlocked.failure?.step).toBe(4);
  });

  test("fails when Bun runtime is below the required version", async () => {
    const telemetry: StartupTelemetryEvent[] = [];
    const ctx = buildContext({
      readBunVersion: async () => "1.3.9",
      telemetry: (event) => telemetry.push(event),
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED);
    expect(result.failure?.step).toBe(1);
    expect(result.failure?.category).toBe("runtime");
    expect(result.failure?.detail).toContain("1.3.9");
    expect(result.failure?.action).toContain("Bun 1.3.14");
    expect(result.history).toHaveLength(1);
    const bunPhase = telemetry.find(
      (event): event is StartupTelemetryPhaseEvent =>
        event.type === "startup_phase" &&
        event.code === STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    );
    expect(bunPhase).toBeDefined();
    if (bunPhase) {
      expect(bunPhase.status).toBe("fail");
      expect(bunPhase.startedAtMs).toBeLessThanOrEqual(bunPhase.endedAtMs);
      expect(bunPhase.detail).toContain("1.3.9");
    }
  });

  test("fails when Docker runtime is below the support floor", async () => {
    const ctx = buildContext({
      readDockerVersion: async () => "23.0.5",
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED);
    expect(result.failure?.step).toBe(2);
    expect(result.failure?.category).toBe("infrastructure");
    expect(result.failure?.detail).toContain("23.0.5");
    expect(result.failure?.action).toContain("Docker");
    expect(result.history[0]?.status).toBe("pass");
    const dockerRecord = result.history.find(
      (entry) => entry.code === STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
    );
    expect(dockerRecord?.status).toBe("fail");
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
    const success = await gateDispatchWithStartupPreflight(successCtx, successDispatch, {
      syntheticProbeName: "startup.synthetic",
    });
    expect(success.ok).toBe(true);
    expect(successOrder).toEqual(["synthetic:startup.synthetic", "dispatch"]);
    const lastEntry = success.history.at(-1);
    expect(lastEntry?.category).toBe("dispatch");
    expect(lastEntry?.status).toBe("pass");
    expect(lastEntry?.step).toBe(7);

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
    const failed = await gateDispatchWithStartupPreflight(failureCtx, blockedDispatch);
    expect(failed.ok).toBe(false);
    expect(failed.failure?.code).toBe(STARTUP_FAILURE_CODES.SYNTHETIC_FAILED);
    expect(failureOrder).toEqual(["synthetic:probe.remote_startup"]);
    expect(failureDispatchCalls).toHaveLength(0);
  });

  test("gate aborts dispatch when deterministic checks fail before alerts", async () => {
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
    const result = await gateDispatchWithStartupPreflight(ctx, async () => {
      dispatchCalls.push("dispatch");
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.REPO_DIRTY);
    expect(result.failure?.category).toBe("repo");
    expect(result.failure?.step).toBe(4);
    expect(dispatchCalls).toHaveLength(0);
    expect(alertChecks).toBe(0);
    expect(syntheticChecks).toBe(0);
  });

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
    expect(result.failure?.step).toBe(6);
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
    expect(result.history).toHaveLength(6);
    expect(result.history.map((h) => h.code)).toEqual([
      STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
      STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
      STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      STARTUP_FAILURE_CODES.REPO_DIRTY,
      STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    ]);
    expect(result.history.map((h) => h.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.history.map((h) => h.category)).toEqual([
      "runtime",
      "infrastructure",
      "repo",
      "repo",
      "alerts",
      "synthetic",
    ]);
    const historyEntry = result.history.at(-1);
    expect(historyEntry?.detail).toContain("finished");
  });

  test("exports structured checklist metadata", () => {
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.category)).toEqual([
      "runtime",
      "infrastructure",
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

  test("telemetry captures each phase including dispatch boundaries", async () => {
    const telemetry: StartupTelemetryEvent[] = [];
    const ctx = buildContext({
      telemetry: (event) => telemetry.push(event),
    });
    const result = await gateDispatchWithStartupPreflight(ctx, async () => undefined);
    expect(result.ok).toBe(true);
    const phaseEvents = telemetry.filter(
      (event): event is StartupTelemetryPhaseEvent => event.type === "startup_phase",
    );
    expect(phaseEvents).toHaveLength(7);
    expect(phaseEvents.map((event) => event.code)).toEqual([
      STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
      STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
      STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      STARTUP_FAILURE_CODES.REPO_DIRTY,
      STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
      STARTUP_FAILURE_CODES.DISPATCH_FAILED,
    ]);
    phaseEvents.forEach((event) => {
      expect(event.startedAtMs).toBeLessThanOrEqual(event.endedAtMs);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(["pass", "fail"]).toContain(event.status);
    });
    const dispatchEvent = phaseEvents.at(-1);
    expect(dispatchEvent?.code).toBe(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
    expect(dispatchEvent?.status).toBe("pass");
    expect(dispatchEvent?.detail).toContain("Dispatch completed");
    const unknownEvents = telemetry.filter((event) => event.type === "startup_unknown_failure");
    expect(unknownEvents).toHaveLength(0);
  });

  test("telemetry emits unknown failure events when checks throw", async () => {
    const telemetry: StartupTelemetryEvent[] = [];
    const ctx = buildContext({
      describeRepo: async () => {
        throw new Error("git status panic");
      },
      telemetry: (event) => telemetry.push(event),
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    const unknownEvent = telemetry.find((event) => event.type === "startup_unknown_failure");
    expect(unknownEvent?.code).toBe(STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS);
    expect(unknownEvent?.error.message).toContain("git status panic");
    const phaseEvent = telemetry.find(
      (event): event is StartupTelemetryPhaseEvent =>
        event.type === "startup_phase" && event.code === STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
    );
    expect(phaseEvent?.status).toBe("fail");
    expect(phaseEvent?.error?.message ?? phaseEvent?.detail).toContain("git status panic");
  });

  test("bun version probe exceptions surface telemetry payloads", async () => {
    const telemetry: StartupTelemetryEvent[] = [];
    const bunProbeError = new Error("bun shim missing from PATH");
    const ctx = buildContext({
      readBunVersion: async () => {
        throw bunProbeError;
      },
      telemetry: (event) => telemetry.push(event),
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED);
    expect(result.failure?.detail).toContain("Bun version probe failed");
    const bunHistory = result.history.find(
      (entry) => entry.code === STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    );
    expect(bunHistory?.detail).toContain("Bun version probe failed");
    const bunPhase = telemetry.find(
      (event): event is StartupTelemetryPhaseEvent =>
        event.type === "startup_phase" &&
        event.code === STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    );
    expect(bunPhase).toBeDefined();
    if (bunPhase) {
      expect(bunPhase.status).toBe("fail");
      expect(bunPhase.error?.message).toContain("Bun version probe failed");
      expect(bunPhase.error?.raw).toBe(bunProbeError);
      expect(bunPhase.startedAtMs).toBeLessThanOrEqual(bunPhase.endedAtMs);
      expect(bunPhase.durationMs).toBeGreaterThanOrEqual(0);
    }
    const unknownEvent = telemetry.find(
      (event): event is StartupTelemetryUnknownFailureEvent =>
        event.type === "startup_unknown_failure" &&
        event.code === STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    );
    expect(unknownEvent).toBeDefined();
    if (unknownEvent) {
      expect(unknownEvent.phase).toContain("Bun runtime");
      expect(unknownEvent.error.message).toContain("Bun version probe failed");
      expect(unknownEvent.error.raw).toBe(bunProbeError);
      expect(unknownEvent.whenMs).toBeGreaterThan(0);
    }
  });

  test("docker version probe exceptions emit telemetry detail", async () => {
    const telemetry: StartupTelemetryEvent[] = [];
    const dockerProbeError = new Error("docker version returned unexpected payload: (empty)");
    const ctx = buildContext({
      readDockerVersion: async () => {
        throw dockerProbeError;
      },
      telemetry: (event) => telemetry.push(event),
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED);
    expect(result.failure?.detail).toContain("Docker version probe failed");
    expect(result.failure?.step).toBe(2);
    const dockerPhase = telemetry.find(
      (event): event is StartupTelemetryPhaseEvent =>
        event.type === "startup_phase" &&
        event.code === STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
    );
    expect(dockerPhase).toBeDefined();
    if (dockerPhase) {
      expect(dockerPhase.status).toBe("fail");
      expect(dockerPhase.error?.message).toContain("Docker version probe failed");
      expect(dockerPhase.error?.raw).toBe(dockerProbeError);
      expect(dockerPhase.startedAtMs).toBeLessThanOrEqual(dockerPhase.endedAtMs);
      expect(dockerPhase.error?.stack).toBeDefined();
    }
    const unknownEvent = telemetry.find(
      (event): event is StartupTelemetryUnknownFailureEvent =>
        event.type === "startup_unknown_failure" &&
        event.code === STARTUP_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
    );
    expect(unknownEvent).toBeDefined();
    if (unknownEvent) {
      expect(unknownEvent.error.message).toContain("Docker version probe failed");
      expect(unknownEvent.error.raw).toBe(dockerProbeError);
      expect(unknownEvent.step).toBe(2);
    }
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
    expect(result.failure?.step).toBe(6);
    const lastHistoryEntry = result.history.at(-1);
    expect(lastHistoryEntry?.code).toBe(STARTUP_FAILURE_CODES.SYNTHETIC_FAILED);
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
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS);
    const mergeRecord = result.history.find(
      (entry) => entry.code === STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
    );
    expect(mergeRecord?.status).toBe("fail");
    expect(mergeRecord?.detail).toContain("git status failed");
    expect(mergeRecord?.action).toContain("Resolve or abort");
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
    expect(result.failure?.step).toBe(5);
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
    expect(result.failure?.step).toBe(6);
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
    expect(result.failure?.step).toBe(7);
    const expectedAction = actionFor(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
    expect(result.failure?.action).toBe(expectedAction);
    const lastHistoryEntry = result.history.at(-1);
    expect(lastHistoryEntry?.category).toBe("dispatch");
    expect(lastHistoryEntry?.status).toBe("fail");
    expect(lastHistoryEntry?.detail).toBe(result.failure?.detail);
    expect(lastHistoryEntry?.action).toBe(expectedAction);
    expect(lastHistoryEntry?.step).toBe(result.failure?.step);
  });

  test("log callback mirrors each history record including dispatch stage", async () => {
    const logEntries: StartupCheckRecord[] = [];
    const ctx = buildContext({
      log: (entry) => {
        logEntries.push(entry);
      },
    });
    const result = await gateDispatchWithStartupPreflight(ctx, async () => {
      // dispatch succeeds
    });
    expect(result.ok).toBe(true);
    expect(logEntries).toHaveLength(result.history.length);
    expect(logEntries.map((entry) => entry.code)).toEqual(
      result.history.map((entry) => entry.code),
    );
    const dispatchLog = logEntries.at(-1);
    expect(dispatchLog?.category).toBe("dispatch");
    expect(dispatchLog?.status).toBe("pass");
  });

  test("memoizes describeRepo across repo checks", async () => {
    let describeRepoCalls = 0;
    const ctx = buildContext({
      describeRepo: async () => {
        describeRepoCalls += 1;
        return {
          isDirty: false,
          isMergeInProgress: false,
          branch: "main",
          detail: "snapshot",
        };
      },
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(true);
    expect(describeRepoCalls).toBe(1);
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
      expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS);
      const expectedAction = actionFor(STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS);
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

  test("dispatch telemetry log captures failure metadata", async () => {
    const logs: StartupCheckRecord[] = [];
    const ctx = buildContext({
      log: (entry) => {
        logs.push(entry);
      },
    });
    await gateDispatchWithStartupPreflight(ctx, async () => {
      throw new Error("dispatch pipeline offline");
    });
    const dispatchLog = logs.at(-1);
    expect(dispatchLog?.code).toBe(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
    expect(dispatchLog?.status).toBe("fail");
    expect(dispatchLog?.action).toContain("RemoteBuddy + WorkerPals");
    expect(dispatchLog?.error?.message).toContain("dispatch pipeline offline");
    expect(dispatchLog?.startedAtMs).toBeLessThanOrEqual(dispatchLog!.endedAtMs);
    expect(dispatchLog?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
