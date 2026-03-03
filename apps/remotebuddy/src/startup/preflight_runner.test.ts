import { describe, expect, test } from "bun:test";

import {
  PREFLIGHT_FAILURE_CODES,
  runRemotebuddyPreflight,
  type PreflightCommandResult,
  type PreflightCommandRunner,
  type RemotebuddyPreflightConfig,
} from "./preflight_runner.js";

const baseConfig = (overrides: Partial<RemotebuddyPreflightConfig> = {}): RemotebuddyPreflightConfig => ({
  sessionId: "dev",
  authToken: "token",
  serverUrl: "http://localhost:3001",
  llmBackend: "openai",
  llmApiKey: "sk-example",
  ...overrides,
});

const dockerRunner = (responses: Record<string, PreflightCommandResult>): PreflightCommandRunner => {
  return async (_cmd, args) => {
    if (args.includes("--format")) {
      return responses["format"];
    }
    return responses["plain"];
  };
};

const okDockerResult: PreflightCommandResult = {
  exitCode: 0,
  stdout: "26.1.1\n",
  stderr: "",
  failed: false,
};

const fallbackDockerResult: PreflightCommandResult = {
  exitCode: 0,
  stdout: "Docker version 26.1.1, build deadbeef\n",
  stderr: "",
  failed: false,
};

const nextNow = () => {
  let current = 0;
  return () => {
    current += 5;
    return current;
  };
};

const baseEnv: NodeJS.ProcessEnv = {
  PUSHPALS_SERVER_URL: "http://localhost:3001",
  PUSHPALS_AUTH_TOKEN: "token",
  REMOTEBUDDY_LLM_API_KEY: "sk-example",
};

describe("runRemotebuddyPreflight", () => {
  test("succeeds when Bun/Docker versions and env/secrets are satisfied", async () => {
    const telemetry: string[] = [];
    const result = await runRemotebuddyPreflight({
      config: baseConfig(),
      env: { ...baseEnv },
      bunVersion: "1.1.12",
      now: nextNow(),
      runCommand: dockerRunner({
        format: okDockerResult,
        plain: fallbackDockerResult,
      }),
      log: (entry) => telemetry.push(`${entry.check}:${entry.status}`),
    });

    expect(result.ok).toBe(true);
    expect(telemetry).toEqual([
      "bun_version:pass",
      "docker_version:pass",
      "required_env:pass",
      "required_secrets:pass",
    ]);
    expect(result.history.map((entry) => entry.code)).toEqual([
      "preflight.check.bun_version.pass",
      "preflight.check.docker_version.pass",
      "preflight.check.required_env.pass",
      "preflight.check.required_secrets.pass",
    ]);
    expect(result.history.every((entry) => entry.failureCode === undefined)).toBe(true);
  });

  test("fails fast when Bun version is below the minimum", async () => {
    const result = await runRemotebuddyPreflight({
      config: baseConfig(),
      env: { ...baseEnv },
      bunVersion: "1.0.9",
      now: nextNow(),
      runCommand: dockerRunner({
        format: okDockerResult,
        plain: fallbackDockerResult,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(PREFLIGHT_FAILURE_CODES.BUN_VERSION_UNSUPPORTED);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.code).toBe("preflight.check.bun_version.fail");
    expect(result.history[0]?.failureCode).toBe(
      PREFLIGHT_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    );
  });

  test("fails with actionable guidance when Docker CLI is unavailable", async () => {
    const missingDocker: PreflightCommandResult = {
      exitCode: -1,
      stdout: "",
      stderr: "spawn ENOENT",
      failed: true,
      error: "ENOENT",
    };
    const result = await runRemotebuddyPreflight({
      config: baseConfig(),
      env: { ...baseEnv },
      bunVersion: "1.1.10",
      now: nextNow(),
      runCommand: dockerRunner({
        format: missingDocker,
        plain: missingDocker,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(PREFLIGHT_FAILURE_CODES.DOCKER_UNAVAILABLE);
    expect(result.failure?.detail).toMatch(/Docker CLI is not installed/i);
  });

  test("fails when required environment wiring is missing", async () => {
    const result = await runRemotebuddyPreflight({
      config: baseConfig({ serverUrl: null }),
      env: {
        PUSHPALS_AUTH_TOKEN: "token",
        REMOTEBUDDY_LLM_API_KEY: "sk-example",
      },
      bunVersion: "1.1.10",
      now: nextNow(),
      runCommand: dockerRunner({
        format: okDockerResult,
        plain: fallbackDockerResult,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(PREFLIGHT_FAILURE_CODES.ENV_VARS_MISSING);
    expect(result.failure?.detail).toMatch(/Missing required environment variables/i);
  });

  test("treats CLI --server overrides as a valid source when env vars are unset", async () => {
    const telemetry: string[] = [];
    const result = await runRemotebuddyPreflight({
      config: baseConfig({ serverUrl: "https://cli-override.pushpals.dev" }),
      env: {
        PUSHPALS_AUTH_TOKEN: "token",
        REMOTEBUDDY_LLM_API_KEY: "sk-example",
      },
      bunVersion: "1.1.10",
      now: nextNow(),
      runCommand: dockerRunner({
        format: okDockerResult,
        plain: fallbackDockerResult,
      }),
      log: (entry) => {
        if (entry.check === "required_env") {
          telemetry.push(`${entry.check}:${entry.metadata["req.PUSHPALS_SERVER_URL"] ?? "unknown"}`);
        }
      },
    });
    expect(result.ok).toBe(true);
    expect(telemetry).toEqual(["required_env:config"]);
  });

  test("requires explicit LLM API key when backend is remote", async () => {
    const result = await runRemotebuddyPreflight({
      config: baseConfig({ llmApiKey: null }),
      env: {
        ...baseEnv,
        REMOTEBUDDY_LLM_API_KEY: "",
        OPENAI_API_KEY: "",
      },
      bunVersion: "1.1.10",
      now: nextNow(),
      runCommand: dockerRunner({
        format: okDockerResult,
        plain: fallbackDockerResult,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(PREFLIGHT_FAILURE_CODES.SECRETS_MISSING);
    expect(result.failure?.detail).toMatch(/LLM API key/);
  });
});
