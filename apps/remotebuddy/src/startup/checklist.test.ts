import { describe, expect, test } from "bun:test";

import {
  gateDispatchWithStartupPreflight,
  runStartupPreflight,
  STARTUP_CHECK_STRUCTURE,
  STARTUP_FAILURE_CODES,
  type RepoStatus,
  type StartupChecklistContext,
  type StartupFailureCode,
  type StartupTelemetryEvent,
  type StartupTelemetryPhase,
} from "./checklist.js";

const REQUIRED_ENV_DEFAULTS = {
  REMOTE_STABLE_ID: "rb-test",
  WORKERPALS_API_URL: "http://localhost:4000",
  SERVER_BASE_URL: "http://localhost:3001",
  PUSHPALS_AUTH_TOKEN: "preflight-test-token",
} as const;

type EnvState = Record<string, string | undefined>;

const buildEnvState = (overrides: EnvState = {}): EnvState => ({
  ...REQUIRED_ENV_DEFAULTS,
  ...overrides,
});

const cleanRepo = (): RepoStatus => ({
  isDirty: false,
  isMergeInProgress: false,
  branch: "main",
  detail: "clean repo",
});

const buildContext = (
  overrides: Partial<StartupChecklistContext> = {},
  envOverrides: EnvState = {},
): StartupChecklistContext => {
  const env = buildEnvState(envOverrides);
  const base: StartupChecklistContext = {
    describeRepo: async () => cleanRepo(),
    listFiringAlerts: async () => [],
    syntheticTester: {
      runSyntheticJob: async () => ({ ok: true, latencyMs: 150 }),
    },
    readEnvVar: (name) => env[name],
  };
  return {
    ...base,
    ...overrides,
    readEnvVar: overrides.readEnvVar ?? base.readEnvVar,
  };
};

const actionFor = (code: StartupFailureCode): string => {
  const entry = STARTUP_CHECK_STRUCTURE.find((item) => item.code === code);
  if (!entry) {
    throw new Error(`Missing startup check structure for ${code}`);
  }
  return entry.action;
};

const captureTelemetry = () => {
  const events: StartupTelemetryEvent[] = [];
  return {
    events,
    emitter: {
      emit: (event: StartupTelemetryEvent) => {
        events.push(event);
      },
    },
    eventFor: (
      phase: StartupTelemetryPhase,
      code: StartupFailureCode,
    ): StartupTelemetryEvent | undefined =>
      events.find(
        (event) => event.phase === phase && event.code === code,
      ),
  };
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

  test("preflight fails when required env vars missing", async () => {
    const telemetry = captureTelemetry();
    const ctx = buildContext(
      {
        telemetry: telemetry.emitter,
      },
      { SERVER_BASE_URL: undefined },
    );
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.ENV_MISSING);
    expect(result.failure?.category).toBe("env");
    expect(result.failure?.step).toBe(3);
    expect(result.failure?.detail).toMatch(/SERVER_BASE_URL/);
    expect(result.failure?.action).toContain("REMOTE_STABLE_ID");
    const startEvent = telemetry.eventFor(
      "start",
      STARTUP_FAILURE_CODES.ENV_MISSING,
    );
    expect(startEvent?.status).toBe("pending");
    expect(startEvent?.step).toBe(3);
    const finishEvent = telemetry.eventFor(
      "finish",
      STARTUP_FAILURE_CODES.ENV_MISSING,
    );
    expect(finishEvent?.status).toBe("fail");
    expect(finishEvent?.code).toBe(STARTUP_FAILURE_CODES.ENV_MISSING);
    expect(finishEvent?.step).toBe(3);
    expect(finishEvent?.detail).toContain("SERVER_BASE_URL");
    expect(finishEvent?.action).toBe(result.failure?.action);
  });

  test("preflight fails when API token is blank", async () => {
    const telemetry = captureTelemetry();
    const ctx = buildContext(
      {
        telemetry: telemetry.emitter,
      },
      { PUSHPALS_AUTH_TOKEN: "" },
    );
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.API_TOKEN_INVALID,
    );
    expect(result.failure?.category).toBe("env");
    expect(result.failure?.step).toBe(4);
    expect(result.failure?.detail).toContain("PUSHPALS_AUTH_TOKEN");
    expect(result.failure?.action).toContain("PUSHPALS_AUTH_TOKEN");
    const startEvent = telemetry.eventFor(
      "start",
      STARTUP_FAILURE_CODES.API_TOKEN_INVALID,
    );
    expect(startEvent?.status).toBe("pending");
    expect(startEvent?.step).toBe(4);
    const finishEvent = telemetry.eventFor(
      "finish",
      STARTUP_FAILURE_CODES.API_TOKEN_INVALID,
    );
    expect(finishEvent?.status).toBe("fail");
    expect(finishEvent?.detail).toContain("PUSHPALS_AUTH_TOKEN");
    expect(finishEvent?.action).toBe(result.failure?.action);
    expect(finishEvent?.step).toBe(4);
  });

  test("preflight rejects placeholder API token values", async () => {
    const telemetry = captureTelemetry();
    const ctx = buildContext(
      {
        telemetry: telemetry.emitter,
      },
      { PUSHPALS_AUTH_TOKEN: "placeholder-token" },
    );
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.API_TOKEN_INVALID,
    );
    expect(result.failure?.detail).toContain("placeholder-token");
    const startEvent = telemetry.eventFor(
      "start",
      STARTUP_FAILURE_CODES.API_TOKEN_INVALID,
    );
    expect(startEvent?.status).toBe("pending");
    expect(startEvent?.step).toBe(4);
    const finishEvent = telemetry.eventFor(
      "finish",
      STARTUP_FAILURE_CODES.API_TOKEN_INVALID,
    );
    expect(finishEvent?.status).toBe("fail");
    expect(finishEvent?.detail).toContain("placeholder-token");
    expect(finishEvent?.action).toBe(result.failure?.action);
    expect(finishEvent?.step).toBe(4);
  });

  test("preflight success path emits pass telemetry for env, token, and docker checks", async () => {
    const telemetry = captureTelemetry();
    const dockerDetail = "Docker daemon responded (version 25.0.2).";
    const ctx = buildContext(
      {
        telemetry: telemetry.emitter,
        describeDocker: async () => ({
          ready: true,
          detail: dockerDetail,
          version: "25.0.2",
        }),
      },
    );
    const result = await runStartupPreflight(ctx, { requireDocker: true });
    expect(result.ok).toBe(true);

    const expectTelemetryPass = (
      code: StartupFailureCode,
      detailMatcher: RegExp | string,
    ) => {
      const startEvent = telemetry.eventFor("start", code);
      expect(startEvent?.status).toBe("pending");
      const finishEvent = telemetry.eventFor("finish", code);
      expect(finishEvent?.status).toBe("pass");
      if (typeof detailMatcher === "string") {
        expect(finishEvent?.detail).toContain(detailMatcher);
      } else {
        expect(finishEvent?.detail).toMatch(detailMatcher);
      }
      const record = result.history.find((entry) => entry.code === code);
      expect(record?.status).toBe("pass");
    };

    expectTelemetryPass(
      STARTUP_FAILURE_CODES.ENV_MISSING,
      /Required env vars present/,
    );
    expectTelemetryPass(
      STARTUP_FAILURE_CODES.API_TOKEN_INVALID,
      /loaded \(\d+ chars\)/,
    );
    expectTelemetryPass(
      STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
      dockerDetail,
    );
  });

  test("preflight fails when docker readiness probe reports down", async () => {
    const telemetry = captureTelemetry();
    const ctx = buildContext({
      describeDocker: async () => ({
        ready: false,
        detail: "Docker Desktop is not running",
      }),
      telemetry: telemetry.emitter,
    });
    const result = await runStartupPreflight(ctx, { requireDocker: true });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
    );
    expect(result.failure?.category).toBe("infra");
    expect(result.failure?.step).toBe(5);
    expect(result.failure?.detail).toContain("Docker Desktop is not running");
    expect(result.failure?.action).toContain("Docker Desktop");
    const startEvent = telemetry.eventFor(
      "start",
      STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
    );
    expect(startEvent?.status).toBe("pending");
    expect(startEvent?.step).toBe(5);
    const finishEvent = telemetry.eventFor(
      "finish",
      STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
    );
    expect(finishEvent?.status).toBe("fail");
    expect(finishEvent?.detail).toContain("Docker Desktop is not running");
    expect(finishEvent?.action).toBe(result.failure?.action);
    expect(finishEvent?.step).toBe(5);
  });

  test("preflight fails when docker readiness probe returns a timeout detail", async () => {
    const telemetry = captureTelemetry();
    const ctx = buildContext({
      telemetry: telemetry.emitter,
    });
    const timeoutDetail =
      "Docker CLI timed out after 1500 ms. Start Docker Desktop and retry.";
    const result = await runStartupPreflight(ctx, {
      requireDocker: true,
      dockerProbe: async () => ({
        ready: false,
        detail: timeoutDetail,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
    );
    expect(result.failure?.detail).toContain("timed out");
    expect(result.failure?.action).toContain("Docker Desktop");
    const finishEvent = telemetry.eventFor(
      "finish",
      STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
    );
    expect(finishEvent?.status).toBe("fail");
    expect(finishEvent?.detail).toContain("timed out");
    expect(finishEvent?.action).toBe(result.failure?.action);
  });

  test("preflight surfaces docker readiness probe exceptions", async () => {
    const telemetry = captureTelemetry();
    const ctx = buildContext({
      describeDocker: async () => {
        throw new Error("permission denied /var/run/docker.sock");
      },
      telemetry: telemetry.emitter,
    });
    const result = await runStartupPreflight(ctx, { requireDocker: true });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
    );
    expect(result.failure?.detail).toContain("permission denied");
    const finishEvent = telemetry.eventFor(
      "finish",
      STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
    );
    expect(finishEvent?.status).toBe("fail");
    expect(finishEvent?.detail).toContain("permission denied");
    expect(finishEvent?.action).toBe(result.failure?.action);
  });

  test("telemetry emits start + finish events for every step", async () => {
    const emitted: StartupTelemetryEvent[] = [];
    const ctx = buildContext({
      telemetry: {
        emit: (event) => emitted.push(event),
      },
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(true);
    expect(emitted).toHaveLength(result.history.length * 2);
    const startEvents = emitted.filter((event) => event.phase === "start");
    const finishEvents = emitted.filter((event) => event.phase === "finish");
    expect(startEvents).toHaveLength(result.history.length);
    expect(finishEvents).toHaveLength(result.history.length);
    expect(startEvents.every((event) => event.status === "pending")).toBe(true);
    finishEvents.forEach((event, index) => {
      const historyEntry = result.history[index];
      expect(event.code).toBe(historyEntry.code);
      expect(event.step).toBe(historyEntry.step);
      expect(event.status).toBe(historyEntry.status);
      expect(event.elapsedMs).toBe(historyEntry.elapsedMs);
    });
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
    expect(lastEntry?.step).toBe(8);

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
    expect(result.failure?.step).toBe(7);
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
    expect(result.history).toHaveLength(7);
    expect(result.history.map((h) => h.code)).toEqual([
      STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      STARTUP_FAILURE_CODES.REPO_DIRTY,
      STARTUP_FAILURE_CODES.ENV_MISSING,
      STARTUP_FAILURE_CODES.API_TOKEN_INVALID,
      STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
      STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    ]);
    expect(result.history.map((h) => h.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.history.map((h) => h.category)).toEqual([
      "repo",
      "repo",
      "env",
      "env",
      "infra",
      "alerts",
      "synthetic",
    ]);
    const historyEntry = result.history.at(-1);
    expect(historyEntry?.detail).toContain("finished");
  });

  test("exports structured checklist metadata", () => {
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.step)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.category)).toEqual([
      "repo",
      "repo",
      "env",
      "env",
      "infra",
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
    expect(result.failure?.step).toBe(7);
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
    expect(result.failure?.step).toBe(6);
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
    expect(result.failure?.step).toBe(7);
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
    expect(result.failure?.step).toBe(8);
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
