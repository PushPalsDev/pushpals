import { describe, expect, test } from "bun:test";

import {
  PREFLIGHT_FAILURE_CODES,
  type PreflightTelemetryEntry,
  type RemotebuddyPreflightConfig,
} from "./startup/preflight_runner.js";
import { ensurePreflightPasses, RemoteBuddyPreflightError } from "./startup/preflight_barrier.js";
import { enforceStartupPreflightGate } from "./startup/startup_preflight_gate.js";

const baseConfig: RemotebuddyPreflightConfig = {
  sessionId: "test",
  authToken: "token",
  serverUrl: "http://localhost:3001",
  llmBackend: "openai",
  llmApiKey: "sk-test",
};

const noopLogger = {
  log: () => {},
  error: () => {},
};

describe("enforceStartupPreflightGate", () => {
  test("halts workload initialization when preflight fails", async () => {
    let workloadStarted = false;
    const exitCodes: number[] = [];
    const logs: string[] = [];
    const allowed = await enforceStartupPreflightGate({
      config: baseConfig,
      env: {},
      runPreflight: async () => ({
        ok: false,
        history: [],
        failure: {
          code: PREFLIGHT_FAILURE_CODES.DOCKER_UNAVAILABLE,
          check: "docker_version",
          detail: "Docker CLI missing",
          action: "Install Docker",
        },
      }),
      exit: (code) => {
        exitCodes.push(code);
      },
      logger: {
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
      },
    });
    if (allowed) {
      workloadStarted = true;
    }
    expect(workloadStarted).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(logs.some((line) => line.includes("preflight.docker_unavailable"))).toBe(true);
  });

  test("allows workload initialization when preflight passes", async () => {
    let workloadStarted = false;
    const allowed = await enforceStartupPreflightGate({
      config: baseConfig,
      env: {},
      runPreflight: async () => ({
        ok: true,
        history: [],
      }),
      exit: () => {
        throw new Error("exit should not be invoked when preflight passes");
      },
      logger: noopLogger,
    });
    if (allowed) {
      workloadStarted = true;
    }
    expect(workloadStarted).toBe(true);
  });

  test("fails closed when runner reports ok=false without failure detail", async () => {
    const exitCodes: number[] = [];
    const logs: string[] = [];
    const historySample: PreflightTelemetryEntry[] = [
      {
        code: "preflight.check.required_env.fail",
        check: "required_env",
        status: "fail",
        detail: "Missing server URL wiring",
        metadata: {
          "req.PUSHPALS_SERVER_URL": "missing",
        },
        elapsedMs: 15,
        timestamp: new Date().toISOString(),
        action: undefined,
        failureCode: PREFLIGHT_FAILURE_CODES.ENV_VARS_MISSING,
      },
    ];
    const allowed = await enforceStartupPreflightGate({
      config: baseConfig,
      env: {},
      runPreflight: async () => ({
        ok: false,
        history: historySample,
      }),
      exit: (code) => exitCodes.push(code),
      logger: {
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
      },
    });
    expect(allowed).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(logs.some((line) => line.includes("failure without details"))).toBe(true);
    expect(
      logs.some((line) => line.includes("Last telemetry sample") && line.includes("required_env")),
    ).toBe(true);
  });
});

describe("runRemoteBuddyMain preflight enforcement", () => {
  test("throws RemoteBuddyPreflightError when the preflight gate reports failure", async () => {
    const gateCalls: Array<unknown> = [];
    await expect(
      ensurePreflightPasses(baseConfig, {
        runPreflightGate: async (options) => {
          gateCalls.push(options.config);
          return false;
        },
        env: {},
        logger: noopLogger,
      }),
    ).rejects.toBeInstanceOf(RemoteBuddyPreflightError);
    expect(gateCalls).toHaveLength(1);
  });
});
