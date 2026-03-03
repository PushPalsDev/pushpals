import { describe, expect, mock, test } from "bun:test";

import { PREFLIGHT_FAILURE_CODES } from "./runtime.js";

const stubConfig = {
  server: { url: "http://127.0.0.1:3999" },
  sessionId: null,
  authToken: null,
  startup: { logConfigOnStart: false },
  remotebuddy: {
    pollMs: 1500,
    memory: { enabled: false },
    llm: {
      backend: "stub",
      endpoint: "http://127.0.0.1:4000",
      model: "mock",
      apiKey: "mock",
    },
    autonomy: {
      enabled: false,
      tickIntervalMs: 1000,
      maxConcurrentObjectives: 1,
      maxDispatchPerHour: 1,
      allowDirtyWorktree: false,
    },
  },
  paths: {
    dataDir: "/tmp/remotebuddy-data",
    sharedDbPath: "/tmp/remotebuddy-shared.sqlite",
    remotebuddyDbPath: "/tmp/remotebuddy.db",
  },
} as const;
const MAIN_MODULE_URL = new URL("../remotebuddy_main.ts", import.meta.url);

const registerRemotebuddyModuleMocks = () => {
  const registerRelative = (
    relative: string,
    factory: () => Record<string, unknown>,
  ) => {
    mock.module(new URL(relative, MAIN_MODULE_URL).href, factory);
  };

  registerRelative("./llm.ts", () => ({
    createLLMClient: () => ({
      send: async () => undefined,
      close: () => undefined,
    }),
  }));
  registerRelative("./brain.ts", () => ({
    AgentBrain: class AgentBrain {},
  }));
  registerRelative("./idempotency.ts", () => ({
    IdempotencyStore: class IdempotencyStore {},
  }));
  registerRelative("./memory.ts", () => ({
    createSessionMemoryBackend: () => ({}),
  }));
  registerRelative("./persistent_memory.ts", () => ({
    PersistentSessionMemory: class PersistentSessionMemory {},
  }));
  registerRelative("./autonomous_engine.ts", () => ({
    RemoteBuddyAutonomousEngine: class RemoteBuddyAutonomousEngine {
      emitStartupStatus() {}
      startStatusHeartbeat() {}
      startSessionEventMonitor() {}
      startAutonomy() {}
      startPolling() {}
    },
  }));
  registerRelative("./path_targeting.ts", () => ({
    extractExplicitTargetPath: () => null,
    normalizePathHints: (value: unknown) => value,
    plannerTargetPaths: () => [],
  }));
  registerRelative("./command_policy.ts", () => ({
    canonicalizeInstructionTextForBun: (value: string) => value,
    canonicalizeValidationCommandForBun: (value: string) => value,
  }));
  registerRelative("./worker_spawn.ts", () => ({
    buildWorkerSpawnCommand: () => ["bun", "run", "worker"],
  }));
  mock.module("shared", () => ({
    CommunicationManager: class CommunicationManager {},
    detectRepoRoot: () => "/repo",
    loadPushPalsConfig: () => stubConfig,
    sanitizePushPalsConfigForLogging: () => stubConfig,
    matchesGlob: () => false,
    normalizeTargetPath: (value: string) => value,
    normalizeWriteGlob: (value: string) => value,
  }));
};

const mutateEnv = (
  updates: Record<string, string>,
): (() => void) => {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(updates)) {
    prev[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (typeof value === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
};

describe("startup preflight (integration)", () => {
  test("main surfaces env failure telemetry + exit code", async () => {
    const restoreEnv = mutateEnv({
      REMOTE_STABLE_ID: "",
      WORKERPALS_API_URL: "http://127.0.0.1:4111",
      SERVER_BASE_URL: "http://127.0.0.1:4112",
      PUSHPALS_AUTH_TOKEN: "preflight-server-token",
      PUSHPALS_GIT_TOKEN: "preflight-git-token",
    });
    const originalExitCode = process.exitCode;
    const originalLog = console.log;
    const originalError = console.error;
    const logLines: string[] = [];
    const errorLines: string[] = [];
    console.log = (...args: unknown[]) => {
      logLines.push(args.map((value) => String(value)).join(" "));
    };
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map((value) => String(value)).join(" "));
    };

    try {
      registerRemotebuddyModuleMocks();
      process.exitCode = 0;
      const module = (await import(
        `../remotebuddy_main.ts?preflight=${Date.now()}`
      )) as typeof import("../remotebuddy_main.ts");
      await module.main();

      const combined = [...logLines, ...errorLines].join("\n");
      expect(process.exitCode).toBe(1);
      expect(combined).toContain(PREFLIGHT_FAILURE_CODES.ENV_VARS_MISSING);
      expect(combined).toContain("startup_preflight_failed");
      expect(
        errorLines.some((line) => line.includes("Startup preflight blocked")),
      ).toBe(true);
    } finally {
      restoreEnv();
      console.log = originalLog;
      console.error = originalError;
      process.exitCode = originalExitCode ?? 0;
      mock.restore();
    }
  });
});
