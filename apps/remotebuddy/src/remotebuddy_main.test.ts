import { describe, expect, test } from "bun:test";
import { loadPushPalsConfig } from "shared";

import { STARTUP_FAILURE_CODES } from "./startup/checklist.js";
import {
  RemoteBuddyPreflightError,
  type RemoteBuddyPreflightRuntimeConfig,
} from "./startup/preflight.js";
import {
  runRemoteBuddyMain,
  type RunRemoteBuddyMainDependencies,
  type RunRemoteBuddyMainOptions,
} from "./remotebuddy_main.js";
import type { StartupChecklistResult } from "./startup/checklist.js";

type DependencyOverrides = Partial<RunRemoteBuddyMainDependencies>;

const stubDependencies = (
  overrides: DependencyOverrides = {},
): RunRemoteBuddyMainDependencies => ({
  ensurePreflight:
    overrides.ensurePreflight ??
    (async () =>
      ({
        ok: true,
        history: [],
      }) as StartupChecklistResult),
  connectWithRetry:
    overrides.connectWithRetry ??
    (async () => "session-from-server"),
  createLLMClient:
    overrides.createLLMClient ??
    (() => ({} as any)),
  createBrain:
    overrides.createBrain ??
    (() => ({} as any)),
  createOrchestrator:
    overrides.createOrchestrator ??
    (() =>
      ({
        emitStartupStatus: async () => {},
        startStatusHeartbeat: () => {},
        startSessionEventMonitor: () => {},
        startAutonomy: () => {},
        startPolling: () => {},
      }) as any),
});

const CONFIG = loadPushPalsConfig();

const defaultRuntime = (): RemoteBuddyPreflightRuntimeConfig => ({
  repoRoot: process.cwd(),
  server: "http://localhost:3001",
  sessionId: null,
  authToken: null,
  llm: {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "local-model",
    apiKey: null,
  },
  startup: {
    allowDirtyWorktree: false,
    alertsCheckMode: "skip",
    syntheticCheckMode: "skip",
    syntheticProbeName: "probe.remote_startup",
    syntheticMaxLatencyMs: 850,
    alertsEndpoint: null,
  },
});

describe("runRemoteBuddyMain preflight wiring", () => {
  test("forwards CLI override values to preflight runtime config", async () => {
    const captured: RemoteBuddyPreflightRuntimeConfig[] = [];
    const dependencies = stubDependencies({
      ensurePreflight: async (runtime) => {
        captured.push(runtime);
        return { ok: true, history: [] } as StartupChecklistResult;
      },
    });
    await runRemoteBuddyMain({
      cliOverrides: {
        server: "http://override",
        sessionId: "cli-session",
        authToken: "cli-token",
      },
      dependencies,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].server).toBe("http://override");
    expect(captured[0].sessionId).toBe("cli-session");
    expect(captured[0].authToken).toBe("cli-token");
    expect(captured[0].llm).toEqual({
      backend: CONFIG.remotebuddy.llm.backend,
      endpoint: CONFIG.remotebuddy.llm.endpoint ?? null,
      model: CONFIG.remotebuddy.llm.model ?? null,
      apiKey: CONFIG.remotebuddy.llm.apiKey ?? null,
    });
    expect(captured[0].startup).toEqual({
      allowDirtyWorktree: CONFIG.remotebuddy.startup.allowDirtyWorktree,
      alertsCheckMode: CONFIG.remotebuddy.startup.alertsCheckMode,
      syntheticCheckMode: CONFIG.remotebuddy.startup.syntheticCheckMode,
      syntheticProbeName: CONFIG.remotebuddy.startup.syntheticProbeName,
      syntheticMaxLatencyMs: CONFIG.remotebuddy.startup.syntheticMaxLatencyMs,
      alertsEndpoint: CONFIG.remotebuddy.startup.alertsEndpoint ?? null,
    });
  });

  test("ensures preflight finishes before connecting and wires success path dependencies", async () => {
    const callOrder: string[] = [];
    let preflightDone = false;
    const pollValues: number[] = [];
    const orchestrator = {
      emitStartupStatus: async () => {
        callOrder.push("emitStartupStatus");
      },
      startStatusHeartbeat: () => {
        callOrder.push("startStatusHeartbeat");
      },
      startSessionEventMonitor: () => {
        callOrder.push("startSessionEventMonitor");
      },
      startAutonomy: () => {
        callOrder.push("startAutonomy");
      },
      startPolling: (ms: number) => {
        callOrder.push("startPolling");
        pollValues.push(ms);
      },
    };
    const llmRef = {} as any;
    const brainRef = {} as any;
    const dependencies = stubDependencies({
      ensurePreflight: async () => {
        callOrder.push("ensurePreflight");
        preflightDone = true;
        return { ok: true, history: [] } as StartupChecklistResult;
      },
      connectWithRetry: async (server, sessionId) => {
        expect(preflightDone).toBe(true);
        callOrder.push("connectWithRetry");
        expect(server).toBe("http://success-override");
        expect(sessionId).toBe("success-session");
        return "session-from-preflight";
      },
      createLLMClient: (config) => {
        callOrder.push("createLLMClient");
        expect(config.sessionId).toBe("session-from-preflight");
        return llmRef;
      },
      createBrain: (llm) => {
        callOrder.push("createBrain");
        expect(llm).toBe(llmRef);
        return brainRef;
      },
      createOrchestrator: (options) => {
        callOrder.push("createOrchestrator");
        expect(options.server).toBe("http://success-override");
        expect(options.sessionId).toBe("session-from-preflight");
        expect(options.authToken).toBe("success-token");
        expect(options.llm).toBe(llmRef);
        expect(options.brain).toBe(brainRef);
        return orchestrator as any;
      },
    });
    await runRemoteBuddyMain({
      cliOverrides: {
        server: "http://success-override",
        sessionId: "success-session",
        authToken: "success-token",
      },
      dependencies,
    });
    expect(callOrder).toEqual([
      "ensurePreflight",
      "connectWithRetry",
      "createLLMClient",
      "createBrain",
      "createOrchestrator",
      "emitStartupStatus",
      "startStatusHeartbeat",
      "startSessionEventMonitor",
      "startAutonomy",
      "startPolling",
    ]);
    expect(pollValues).toEqual([CONFIG.remotebuddy.pollMs]);
  });

  test("surface RemoteBuddyPreflightError without altering metadata", async () => {
    const failure = {
      code: STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      detail: "blocked",
      action: "resolve merge",
      category: "repo" as const,
      step: 1,
    };
    const runtime = defaultRuntime();
    const error = new RemoteBuddyPreflightError(failure, [], runtime);
    await expect(
      runRemoteBuddyMain({
        dependencies: stubDependencies({
          ensurePreflight: async () => {
            throw error;
          },
        }),
      }),
    ).rejects.toBe(error);
    expect(error.failure).toBe(failure);
    expect(error.failure).toEqual({
      code: STARTUP_FAILURE_CODES.MERGE_IN_PROGRESS,
      detail: "blocked",
      action: "resolve merge",
      category: "repo",
      step: 1,
    });
    expect(error.runtime).toBe(runtime);
  });
});
