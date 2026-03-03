import { describe, expect, test } from "bun:test";

import {
  guardStartupWithSystemPreflight,
  runSystemPreflight,
  SystemPreflightError,
  SYSTEM_PREFLIGHT_FAILURE_CODES,
  type StartupPreflightLogPayload,
} from "./system_preflight.js";

const healthyEnv = {
  PUSHPALS_AUTH_TOKEN: "token",
  REMOTE_STABLE_ID: "stable",
  SERVER_BASE_URL: "http://server",
  WORKERPALS_API_URL: "http://worker",
};

const okDockerProbe = async () => ({ ok: true, version: "25.0.2" });

describe("runSystemPreflight", () => {
  test("passes when env vars, Bun version, and Docker all look healthy", async () => {
    const result = await runSystemPreflight(
      {
        env: { ...healthyEnv },
        bunVersion: "1.2.0",
        dockerProbe: okDockerProbe,
        now: () => 0,
      },
      {
        minBunVersion: "1.1.0",
      },
    );
    expect(result.ok).toBe(true);
    expect(result.history).toHaveLength(3);
    expect(result.history.every((record) => record.status === "pass")).toBe(true);
  });

  test("fails fast when required env vars are missing", async () => {
    const result = await runSystemPreflight({
      env: {
        ...healthyEnv,
        WORKERPALS_API_URL: "",
      },
      bunVersion: "1.2.0",
      dockerProbe: okDockerProbe,
      now: () => 0,
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      SYSTEM_PREFLIGHT_FAILURE_CODES.ENVIRONMENT_MISSING,
    );
    expect(result.failure?.step).toBe(1);
    expect(result.failure?.detail).toContain("WORKERPALS_API_URL");
    expect(result.failure?.action).toContain("PUSHPALS_AUTH_TOKEN");
  });

  test("blocks startup when Bun is older than the minimum", async () => {
    const result = await runSystemPreflight(
      {
        env: { ...healthyEnv },
        bunVersion: "1.0.2",
        dockerProbe: okDockerProbe,
        now: () => 0,
      },
      {
        minBunVersion: "1.1.0",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      SYSTEM_PREFLIGHT_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    );
    expect(result.failure?.detail).toContain("1.1.0");
    expect(result.failure?.action).toContain("Install Bun");
  });

  test("surfaces actionable detail when docker probe fails", async () => {
    const result = await runSystemPreflight({
      env: { ...healthyEnv },
      bunVersion: "1.2.0",
      dockerProbe: async () => ({
        ok: false,
        detail: "daemon unreachable",
      }),
      now: () => 0,
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      SYSTEM_PREFLIGHT_FAILURE_CODES.DOCKER_UNREACHABLE,
    );
    expect(result.failure?.category).toBe("docker");
    expect(result.failure?.detail).toContain("daemon unreachable");
    expect(result.failure?.action).toContain("Docker");
  });
});

describe("guardStartupWithSystemPreflight", () => {
  test("runs startup callback when checks pass", async () => {
    const invoked: string[] = [];
    await expect(
      guardStartupWithSystemPreflight(
        async () => {
          invoked.push("start");
        },
        {
          contextOverrides: {
            env: { ...healthyEnv },
            bunVersion: "1.2.0",
            dockerProbe: okDockerProbe,
            now: () => 0,
          },
          preflightOptions: { minBunVersion: "1.1.0" },
          log: (payload) => {
            void payload;
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(invoked).toEqual(["start"]);
  });

  test("short-circuits startup when preflight fails", async () => {
    const invoked: string[] = [];
    const logs: StartupPreflightLogPayload[] = [];
    await expect(
      guardStartupWithSystemPreflight(
        async () => {
          invoked.push("start");
        },
        {
          contextOverrides: {
            env: { ...healthyEnv, SERVER_BASE_URL: "" },
            bunVersion: "1.2.0",
            dockerProbe: okDockerProbe,
            now: () => 0,
          },
          log: (payload) => logs.push(payload),
        },
      ),
    ).rejects.toBeInstanceOf(SystemPreflightError);
    expect(invoked).toHaveLength(0);
    const failureEntry = logs.find(
      (payload) => payload.phase === "startup_preflight_failure",
    );
    expect(failureEntry?.code).toBe(
      SYSTEM_PREFLIGHT_FAILURE_CODES.ENVIRONMENT_MISSING,
    );
    expect(failureEntry?.detail).toContain("SERVER_BASE_URL");
  });

  test("emits structured payloads for unexpected errors", async () => {
    let invoked = false;
    const logs: StartupPreflightLogPayload[] = [];
    await expect(
      guardStartupWithSystemPreflight(
        async () => {
          invoked = true;
        },
        {
          log: (payload) => logs.push(payload),
          runner: async () => {
            throw new Error("disk I/O failure");
          },
        },
      ),
    ).rejects.toBeInstanceOf(SystemPreflightError);
    expect(invoked).toBe(false);
    const failureEntry = logs.find(
      (payload) => payload.phase === "startup_preflight_failure",
    );
    expect(failureEntry?.code).toBe(
      SYSTEM_PREFLIGHT_FAILURE_CODES.UNEXPECTED_RUNTIME_ERROR,
    );
    expect(failureEntry?.action).toContain("RemoteBuddy");
    expect(failureEntry?.detail).toContain("disk I/O failure");
  });
});
