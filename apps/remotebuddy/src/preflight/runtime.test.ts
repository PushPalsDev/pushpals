import { describe, expect, test } from "bun:test";

import {
  PREFLIGHT_FAILURE_CODES,
  logStartupPreflightFailure,
  runRuntimePreflight,
  type PreflightCheckRecord,
  type PreflightTelemetryEvent,
} from "./runtime.js";

const baseEnv: NodeJS.ProcessEnv = {
  REMOTE_STABLE_ID: "rb-dev",
  WORKERPALS_API_URL: "http://localhost:3300",
  SERVER_BASE_URL: "http://localhost:3001",
  PUSHPALS_AUTH_TOKEN: "server-token",
  PUSHPALS_GIT_TOKEN: "ghp_123",
};

const makeTicker = () => {
  let now = 0;
  return () => {
    now += 5;
    return now;
  };
};

const captureEvents = () => {
  const events: PreflightTelemetryEvent[] = [];
  return {
    events,
    emit: (event: PreflightTelemetryEvent) => {
      events.push(event);
    },
  };
};

describe("runtime preflight", () => {
  test("passes when runtime, env, and credentials are satisfied", async () => {
    const { events, emit } = captureEvents();
    const result = await runRuntimePreflight({
      env: { ...baseEnv },
      bunVersion: "1.1.9",
      detectGitVersion: async () => "2.45.1",
      emit,
      now: makeTicker(),
    });
    expect(result.ok).toBe(true);
    expect(result.history).toHaveLength(4);
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(result.history.at(-1)?.code).toBe(
      PREFLIGHT_FAILURE_CODES.CREDENTIALS_MISSING,
    );
    expect(result.history.at(-1)?.status).toBe("pass");
  });

  test("fails fast when Bun runtime is outdated", async () => {
    const { events, emit } = captureEvents();
    const result = await runRuntimePreflight({
      env: { ...baseEnv },
      bunVersion: "1.0.5",
      detectGitVersion: async () => "2.45.1",
      emit,
      now: makeTicker(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("preflight unexpectedly passed");
    }
    expect(result.failure.code).toBe(
      PREFLIGHT_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    );
    expect(result.failure.exitCode).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("fail");
    expect(events[0]?.detail).toContain("1.0.5");
  });

  test("succeeds Bun/Git checks but blocks when env vars are missing", async () => {
    const env = { ...baseEnv };
    delete env.SERVER_BASE_URL;
    const { events, emit } = captureEvents();
    const result = await runRuntimePreflight({
      env,
      bunVersion: "1.1.8",
      detectGitVersion: async () => "2.42.0",
      emit,
      now: makeTicker(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("preflight unexpectedly passed");
    }
    expect(result.failure.code).toBe(PREFLIGHT_FAILURE_CODES.ENV_VARS_MISSING);
    expect(result.failure.detail).toContain("SERVER_BASE_URL");
    expect(events).toHaveLength(3);
    expect(events.at(-1)?.category).toBe("env");
    expect(events.at(-1)?.status).toBe("fail");
  });

  test("emits actionable metadata when credentials are absent", async () => {
    const env: NodeJS.ProcessEnv = {
      REMOTE_STABLE_ID: "rb-dev",
      WORKERPALS_API_URL: "http://localhost:3300",
      SERVER_BASE_URL: "http://localhost:3001",
      // intentionally omitting credential env vars
    };
    const { events, emit } = captureEvents();
    const result = await runRuntimePreflight({
      env,
      bunVersion: "1.1.8",
      detectGitVersion: async () => "2.42.0",
      emit,
      now: makeTicker(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("preflight unexpectedly passed");
    }
    expect(result.failure.code).toBe(
      PREFLIGHT_FAILURE_CODES.CREDENTIALS_MISSING,
    );
    expect(result.failure.exitCode).toBe(1);
    expect(events).toHaveLength(4);
    expect(events.at(-1)?.category).toBe("credentials");
    expect(events.at(-1)?.metadata?.missing).toContain("server_auth_token");
    expect(events.at(-1)?.metadata?.missing).toContain("git_token");
  });

  test("logs structured payload for startup preflight failures", () => {
    const lines: string[] = [];
    const failure = {
      code: PREFLIGHT_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
      category: "runtime" as const,
      detail: "Bun 1.0.5 is below minimum 1.1.0",
      action: "Upgrade Bun to >=1.1.0.",
      exitCode: 64,
    };
    const history: PreflightCheckRecord[] = [
      {
        code: PREFLIGHT_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
        label: "Bun runtime must be >= 1.1.0.",
        category: "runtime",
        status: "fail",
        detail: failure.detail,
        action: failure.action,
        elapsedMs: 12,
      },
    ];
    logStartupPreflightFailure(failure, history, {
      prefix: "[RemoteBuddyTest]",
      now: () => new Date("2024-01-02T03:04:05.678Z"),
      error: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    const printed = lines[0];
    if (!printed) {
      throw new Error("structured payload missing");
    }
    expect(printed.startsWith("[RemoteBuddyTest] ")).toBe(true);
    const payload = JSON.parse(printed.slice("[RemoteBuddyTest] ".length));
    expect(payload.origin).toBe("remotebuddy.preflight");
    expect(payload.event).toBe("startup_preflight_failed");
    expect(payload.code).toBe(PREFLIGHT_FAILURE_CODES.BUN_VERSION_UNSUPPORTED);
    expect(payload.exitCode).toBe(64);
    expect(payload.lastCheck).toMatchObject({
      code: PREFLIGHT_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
      status: "fail",
    });
  });
});
