import { describe, expect, test } from "bun:test";

import {
  gateDispatchWithStartupPreflight,
  runStartupPreflight,
  STARTUP_CHECK_STRUCTURE,
  STARTUP_FAILURE_CODES,
  type RepoStatus,
  type StartupChecklistContext,
  type StartupChecklistOptions,
  type StartupFailureCode,
  type StartupTelemetryEmitter,
  type StartupTelemetryEvent,
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

const defaultOptions = (
  overrides: Partial<StartupChecklistOptions> = {},
): StartupChecklistOptions => ({
  minBunVersion: "1.3.0",
  bunVersionProvider: async () => "1.3.10",
  dockerProbe: async () => ({ ok: true, detail: "Docker daemon responsive." }),
  requiredEnvVars: ["PUSHPALS_AUTH_TOKEN"],
  envVarResolver: async (key: string) =>
    key === "PUSHPALS_AUTH_TOKEN" ? "secret" : undefined,
  ...overrides,
});

const actionFor = (code: StartupFailureCode): string => {
  const entry = STARTUP_CHECK_STRUCTURE.find((item) => item.code === code);
  if (!entry) {
    throw new Error(`Missing startup check structure for ${code}`);
  }
  return entry.action;
};

const captureTelemetry = () => {
  const events: StartupTelemetryEvent[] = [];
  const emitter: StartupTelemetryEmitter = {
    emit: (event) => {
      events.push(event);
    },
  };
  return { events, emitter };
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
    const mergeBlocked = await runStartupPreflight(ctx, defaultOptions());
    expect(mergeBlocked.ok).toBe(false);
    expect(mergeBlocked.failure?.code).toBe(
      STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
    );
    expect(mergeBlocked.failure?.action).toContain("Resolve");
    expect(mergeBlocked.failure?.category).toBe("repo");
    expect(mergeBlocked.failure?.step).toBe(4);

    const dirtyCtx = buildContext({
      describeRepo: async () => ({
        isDirty: true,
        isMergeInProgress: false,
        branch: "feature/foo",
        detail: "src/startup.ts",
      }),
    });
    const dirtyBlocked = await runStartupPreflight(dirtyCtx, defaultOptions());
    expect(dirtyBlocked.ok).toBe(false);
    expect(dirtyBlocked.failure?.code).toBe(
      STARTUP_FAILURE_CODES.REPO_DIRTY,
    );
    expect(dirtyBlocked.failure?.detail.includes("feature/foo")).toBeTruthy();
    expect(dirtyBlocked.failure?.category).toBe("repo");
    expect(dirtyBlocked.failure?.step).toBe(5);
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
    const result = await runStartupPreflight(
      ctx,
      defaultOptions({ allowDirtyWorktree: true }),
    );
    expect(result.ok).toBe(true);
    const dirtyRecord = result.history.find(
      (entry) => entry.code === STARTUP_FAILURE_CODES.REPO_DIRTY,
    );
    expect(dirtyRecord?.status).toBe("pass");
    expect(dirtyRecord?.detail).toContain("allowDirtyWorktree=true");
  });

  test("enforces Bun runtime minimum version", async () => {
    const ctx = buildContext();
    const result = await runStartupPreflight(
      ctx,
      defaultOptions({
        bunVersionProvider: async () => "1.2.0",
        minBunVersion: "1.3.0",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    );
    expect(result.failure?.step).toBe(1);
    expect(result.failure?.detail).toContain("1.3.0");
  });

  test("surfaces Docker credential probe failures", async () => {
    const ctx = buildContext();
    const result = await runStartupPreflight(
      ctx,
      defaultOptions({
        dockerProbe: async () => ({
          ok: false,
          detail: "not logged into registry",
        }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.DOCKER_AUTH_FAILED,
    );
    expect(result.failure?.step).toBe(2);
    expect(result.failure?.detail).toContain("registry");
  });

  test("enforces required environment variables", async () => {
    const ctx = buildContext();
    const result = await runStartupPreflight(
      ctx,
      defaultOptions({
        requiredEnvVars: ["PUSHPALS_AUTH_TOKEN", "REMOTE_STABLE_ID"],
        envVarResolver: async (key) =>
          key === "PUSHPALS_AUTH_TOKEN" ? "secret" : "",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.ENV_VARS_MISSING,
    );
    expect(result.failure?.step).toBe(3);
    expect(result.failure?.detail).toContain("REMOTE_STABLE_ID");
  });

  test("synthetic guard runs before dispatch and blocks failures", async () => {
    const successOrder: string[] = [];
    const ctx = buildContext({
      syntheticTester: {
        runSyntheticJob: async (options) => {
          successOrder.push(`synthetic:${options.probeName}`);
          return { ok: true, latencyMs: 200 };
        },
      },
    });
    const success = await gateDispatchWithStartupPreflight(
      ctx,
      async () => {
        successOrder.push("dispatch");
      },
      defaultOptions({ syntheticProbeName: "startup.synthetic" }),
    );
    expect(success.ok).toBe(true);
    expect(successOrder).toEqual([
      "synthetic:startup.synthetic",
      "dispatch",
    ]);
    const lastEntry = success.history.at(-1);
    expect(lastEntry?.category).toBe("dispatch");
    expect(lastEntry?.status).toBe("pass");
    expect(lastEntry?.step).toBe(8);

    const failureOrder: string[] = [];
    const failureCtx = buildContext({
      syntheticTester: {
        runSyntheticJob: async (options) => {
          failureOrder.push(`synthetic:${options.probeName}`);
          return { ok: false, latencyMs: 1200, failureDetail: "timeout" };
        },
      },
    });
    const blocked = await gateDispatchWithStartupPreflight(
      failureCtx,
      async () => {
        throw new Error("should not run");
      },
      defaultOptions(),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.failure?.code).toBe(
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    );
    expect(blocked.failure?.step).toBe(7);
    expect(failureOrder).toEqual(["synthetic:probe.remote_startup"]);
  });

  test("gate aborts dispatch when deterministic checks fail before alerts", async () => {
    const dispatchCalls: string[] = [];
    const ctx = buildContext({
      describeRepo: async () => ({
        isDirty: true,
        isMergeInProgress: false,
        branch: "feature/dirty",
        detail: "README.md",
      }),
    });
    const result = await gateDispatchWithStartupPreflight(
      ctx,
      async () => {
        dispatchCalls.push("dispatch");
      },
      defaultOptions(),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.REPO_DIRTY);
    expect(result.failure?.category).toBe("repo");
    expect(result.failure?.step).toBe(5);
    expect(dispatchCalls).toHaveLength(0);
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
    const result = await runStartupPreflight(
      ctx,
      defaultOptions({
        syntheticMaxLatencyMs: 600,
        syntheticProbeName: "startup.synthetic",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    );
    expect(result.failure?.category).toBe("synthetic");
    expect(result.failure?.step).toBe(7);
    expect(result.failure?.detail).toContain("connection reset");
  });

  test("pass history captures every check for observability", async () => {
    const ctx = buildContext();
    const result = await runStartupPreflight(ctx, defaultOptions());
    expect(result.ok).toBe(true);
    expect(result.history).toHaveLength(7);
    expect(result.history.map((h) => h.code)).toEqual([
      STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
      STARTUP_FAILURE_CODES.DOCKER_AUTH_FAILED,
      STARTUP_FAILURE_CODES.ENV_VARS_MISSING,
      STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      STARTUP_FAILURE_CODES.REPO_DIRTY,
      STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    ]);
    expect(result.history.map((h) => h.category)).toEqual([
      "runtime",
      "docker",
      "env",
      "repo",
      "repo",
      "alerts",
      "synthetic",
    ]);
    const historyEntry = result.history.at(-1);
    expect(historyEntry?.detail).toContain("probe.remote_startup");
  });

  test("exports structured checklist metadata", () => {
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.step)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.category)).toEqual([
      "runtime",
      "docker",
      "env",
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
      async () => {},
      defaultOptions({
        syntheticProbeName: "startup.synthetic",
        syntheticMaxLatencyMs: 500,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    );
    expect(result.failure?.step).toBe(7);
    const lastHistoryEntry = result.history.at(-1);
    expect(lastHistoryEntry?.code).toBe(
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    );
    expect(lastHistoryEntry?.status).toBe("fail");
  });

  test("captures describeRepo exceptions with structured history", async () => {
    const ctx = buildContext({
      describeRepo: async () => {
        throw new Error("git status failed");
      },
    });
    const result = await runStartupPreflight(ctx, defaultOptions());
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
    );
    const firstRecord = result.history[3];
    expect(firstRecord.status).toBe("fail");
    expect(firstRecord.detail).toContain("git status failed");
    expect(firstRecord.action).toContain("Resolve or abort");
    expect(firstRecord.step).toBe(4);
  });

  test("captures listFiringAlerts exceptions with actionable detail", async () => {
    const ctx = buildContext({
      listFiringAlerts: async () => {
        throw new Error("alertmanager unreachable");
      },
    });
    const result = await runStartupPreflight(ctx, defaultOptions());
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.ALERTS_ACTIVE);
    expect(result.failure?.step).toBe(6);
    const record = result.history.find(
      (entry) => entry.code === STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
    );
    expect(record?.status).toBe("fail");
    expect(record?.detail).toContain("alertmanager unreachable");
  });

  test("captures synthetic tester exceptions with actionable detail", async () => {
    const ctx = buildContext({
      syntheticTester: {
        runSyntheticJob: async () => {
          throw new Error("probe crashed");
        },
      },
    });
    const result = await runStartupPreflight(ctx, defaultOptions());
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    );
    expect(result.failure?.step).toBe(7);
    const record = result.history.at(-1);
    expect(record?.status).toBe("fail");
    expect(record?.detail).toContain("probe crashed");
  });

  test("returns structured failure when dispatchJob throws", async () => {
    const ctx = buildContext();
    const result = await gateDispatchWithStartupPreflight(
      ctx,
      async () => {
        throw new Error("enqueue failed");
      },
      defaultOptions(),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
    expect(result.failure?.category).toBe("dispatch");
    expect(result.failure?.detail).toContain("enqueue failed");
    expect(result.failure?.step).toBe(8);
    const expectedAction = actionFor(STARTUP_FAILURE_CODES.DISPATCH_FAILED);
    expect(result.failure?.action).toBe(expectedAction);
    const lastHistoryEntry = result.history.at(-1);
    expect(lastHistoryEntry?.status).toBe("fail");
    expect(lastHistoryEntry?.detail).toBe(result.failure?.detail);
  });

  test("emits structured telemetry start/end events", async () => {
    const { events, emitter } = captureTelemetry();
    const ctx = buildContext({ telemetry: emitter });
    const result = await runStartupPreflight(ctx, defaultOptions());
    expect(result.ok).toBe(true);
    const startEvents = events.filter((e) => e.event === "start");
    const endEvents = events.filter((e) => e.event === "end");
    expect(startEvents).toHaveLength(7);
    expect(endEvents).toHaveLength(7);
    expect(startEvents[0].code).toBe(
      STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    );
    expect(endEvents.at(-1)?.code).toBe(
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    );
    expect(endEvents.at(-1)?.status).toBe("pass");
  });

  test("Stops dispatch immediately when runtime preflight fails", async () => {
    const ctx = buildContext();
    const dispatchCalls: string[] = [];
    const result = await gateDispatchWithStartupPreflight(
      ctx,
      async () => {
        dispatchCalls.push("run");
      },
      defaultOptions({
        bunVersionProvider: async () => "1.0.0",
        minBunVersion: "2.0.0",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    );
    expect(result.failure?.step).toBe(1);
    expect(dispatchCalls).toHaveLength(0);
  });
});
