import { describe, expect, test } from "bun:test";

import {
  gateDispatchWithStartupPreflight,
  runStartupPreflight,
  STARTUP_CHECK_STRUCTURE,
  STARTUP_FAILURE_CODES,
  DEFAULT_AUTH_TOKEN_ENV_KEY,
  type RepoStatus,
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
  readEnvVar: (key) =>
    key === DEFAULT_AUTH_TOKEN_ENV_KEY ? "rb_valid_token_123" : undefined,
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
      STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID,
      STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      STARTUP_FAILURE_CODES.REPO_DIRTY,
      STARTUP_FAILURE_CODES.ALERTS_ACTIVE,
      STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    ]);
    expect(result.history.map((h) => h.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.history.map((h) => h.category)).toEqual([
      "config",
      "repo",
      "repo",
      "alerts",
      "infra",
      "synthetic",
    ]);
    const historyEntry = result.history.at(-1);
    expect(historyEntry?.detail).toContain("finished");
  });

  test("exports structured checklist metadata", () => {
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.step)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(STARTUP_CHECK_STRUCTURE.map((item) => item.category)).toEqual([
      "config",
      "repo",
      "repo",
      "alerts",
      "infra",
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
    const lastHistoryEntry = result.history.at(-1);
    expect(lastHistoryEntry?.code).toBe(
      STARTUP_FAILURE_CODES.SYNTHETIC_FAILED,
    );
    expect(lastHistoryEntry?.category).toBe("synthetic");
    expect(lastHistoryEntry?.status).toBe("fail");
    expect(dispatchCalls).toHaveLength(0);
  });

  test(
    "env override determines auth token presence even when host env is set",
    async () => {
      const ctx = buildContext({
        readEnvVar: () => undefined,
        environment: {
          [DEFAULT_AUTH_TOKEN_ENV_KEY]: "host-env-token",
        },
      });
      const result = await runStartupPreflight(ctx);
      expect(result.ok).toBe(false);
      expect(result.failure?.code).toBe(
        STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID,
      );
      expect(result.failure?.detail).toContain("not set");
    },
  );

  test(
    "env override treats blank values as unset even if host env is configured",
    async () => {
      const ctx = buildContext({
        readEnvVar: () => "   ",
        environment: {
          [DEFAULT_AUTH_TOKEN_ENV_KEY]: "host-env-token",
        },
      });
      const result = await runStartupPreflight(ctx);
      expect(result.ok).toBe(false);
      expect(result.failure?.code).toBe(
        STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID,
      );
      expect(result.failure?.detail).toContain("not set");
    },
  );

  test(
    "env override returning undefined ignores host process environment values",
    async () => {
      const original = process.env[DEFAULT_AUTH_TOKEN_ENV_KEY];
      process.env[DEFAULT_AUTH_TOKEN_ENV_KEY] = "host-env-token";
      try {
        const ctx = buildContext({
          readEnvVar: () => undefined,
        });
        const result = await runStartupPreflight(ctx);
        expect(result.ok).toBe(false);
        expect(result.failure?.code).toBe(
          STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID,
        );
        expect(result.failure?.detail).toContain("not set");
      } finally {
        if (original === undefined) {
          delete process.env[DEFAULT_AUTH_TOKEN_ENV_KEY];
        } else {
          process.env[DEFAULT_AUTH_TOKEN_ENV_KEY] = original;
        }
      }
    },
  );

  test("auth token action references the configured env key", async () => {
    const ctx = buildContext({
      readEnvVar: (key) => {
        if (key === DEFAULT_AUTH_TOKEN_ENV_KEY) {
          return "rb_valid_token_123";
        }
        return undefined;
      },
    });
    const result = await runStartupPreflight(ctx, {
      authTokenEnvKey: "RB_CUSTOM_AUTH",
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID);
    expect(result.failure?.action).toContain("RB_CUSTOM_AUTH");
  });

  test("placeholder auth tokens are rejected", async () => {
    const ctx = buildContext({
      readEnvVar: () => "changeme",
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID);
    expect(result.failure?.detail).toContain("changeme");
    expect(result.failure?.detail).toContain("placeholder pattern");
  });

  test("expanded placeholder auth tokens are rejected", async () => {
    const ctx = buildContext({
      readEnvVar: () => "abc123",
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID);
    expect(result.failure?.detail).toContain("abc123");
  });

  test("environment bag supplies auth token when readEnvVar is absent", async () => {
    const ctx = buildContext({
      readEnvVar: undefined,
      environment: {
        [DEFAULT_AUTH_TOKEN_ENV_KEY]: "rb_valid_token_123",
      },
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(true);
  });

  test("new default placeholder patterns such as insert-token-here are rejected", async () => {
    const ctx = buildContext({
      readEnvVar: () => "Insert-Token-Here",
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID);
    expect(result.failure?.detail.toLowerCase()).toContain("insert-token-here");
  });

  test("expanded placeholder tokens such as put-your-token-here are rejected", async () => {
    const ctx = buildContext({
      readEnvVar: () => "PutYourTokenHere",
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID);
    expect(result.failure?.detail.toLowerCase()).toContain(
      "put-your-token-here",
    );
  });

  test("custom invalid token patterns extend the defaults", async () => {
    const ctx = buildContext({
      readEnvVar: () => "custom-placeholder-token",
    });
    const result = await runStartupPreflight(ctx, {
      invalidTokenPatterns: [/^custom-placeholder-token$/i],
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID);
    expect(result.failure?.detail).toContain("custom-placeholder-token");
  });

  test("telemetry emitter failures are ignored", async () => {
    let emitCalls = 0;
    const ctx = buildContext({
      emitTelemetry: () => {
        emitCalls += 1;
        throw new Error("telemetry down");
      },
    });
    const result = await runStartupPreflight(ctx);
    expect(result.ok).toBe(true);
    expect(emitCalls).toBeGreaterThanOrEqual(2);
  });

  test(
    "telemetry emitter failures do not hide auth token failures",
    async () => {
      const events: string[] = [];
      const ctx = buildContext({
        readEnvVar: () => undefined,
        emitTelemetry: (event) => {
          events.push(event.type);
          throw new Error("telemetry offline");
        },
      });
      const result = await runStartupPreflight(ctx);
      expect(result.ok).toBe(false);
      expect(result.failure?.code).toBe(
        STARTUP_FAILURE_CODES.AUTH_TOKEN_INVALID,
      );
      expect(events).toEqual([
        "startup_check_started",
        "startup_check_finished",
      ]);
    },
  );

  test(
    "dispatch telemetry emitter failures do not block preflight or dispatch",
    async () => {
      const events: { type: string; [key: string]: any }[] = [];
      const ctx = buildContext({
        emitTelemetry: (event) => {
          events.push(event);
          throw new Error("telemetry unreachable");
        },
      });
      const result = await gateDispatchWithStartupPreflight(ctx, async () => {});
      expect(result.ok).toBe(true);
      const dispatchEvents = events.filter((event) => {
        if (event.type === "startup_check_started") {
          return event.code === STARTUP_FAILURE_CODES.DISPATCH_FAILED;
        }
        if (event.type === "startup_check_finished") {
          return event.record.code === STARTUP_FAILURE_CODES.DISPATCH_FAILED;
        }
        return false;
      });
      expect(dispatchEvents).toHaveLength(2);
    },
  );

  test("options.dockerProbe overrides ctx describeDocker", async () => {
    let describeDockerCalls = 0;
    const ctx = buildContext({
      describeDocker: async () => {
        describeDockerCalls += 1;
        return { ok: false, detail: "ctx docker unhealthy" };
      },
    });
    const result = await runStartupPreflight(ctx, {
      dockerProbe: { ok: true, detail: "override healthy" },
    });
    expect(result.ok).toBe(true);
    const dockerRecord = result.history.find(
      (entry) => entry.code === STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
    );
    expect(dockerRecord?.status).toBe("pass");
    expect(dockerRecord?.detail).toContain("override healthy");
    expect(describeDockerCalls).toBe(0);
  });

  test("docker probe override failures take precedence over describeDocker", async () => {
    let describeDockerCalls = 0;
    const ctx = buildContext({
      describeDocker: async () => {
        describeDockerCalls += 1;
        return { ok: true, detail: "ctx docker healthy" };
      },
    });
    const result = await runStartupPreflight(ctx, {
      dockerProbe: async () => ({
        ok: false,
        detail: "override docker failure",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      STARTUP_FAILURE_CODES.DOCKER_UNAVAILABLE,
    );
    expect(result.failure?.detail).toContain("override docker failure");
    expect(describeDockerCalls).toBe(0);
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
    const failRecord = result.history.find(
      (entry) => entry.code === STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
    );
    expect(failRecord?.status).toBe("fail");
    expect(failRecord?.detail).toContain("git status failed");
    expect(failRecord?.action).toContain("Resolve or abort");
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
