import { describe, expect, test } from "bun:test";

import {
  STARTUP_FAILURE_CODES,
  type RepoStatus,
  type StartupCheckRecord,
  type StartupChecklistResult,
} from "./checklist.js";
import {
  ensureStartupPreflightReadiness,
  runStartupPreflightCli,
  type StartupPreflightCliOptions,
  type StartupPreflightRunOptions,
} from "./preflight.js";

const baseConfig = {
  server: {
    url: "http://localhost:3000",
    host: "localhost",
    port: 3000,
    debugHttp: false,
    staleClaimTtlMs: 60_000,
    staleClaimSweepIntervalMs: 60_000,
  },
} as unknown as import("shared").PushPalsConfig;

const cleanRepo: RepoStatus = {
  isDirty: false,
  isMergeInProgress: false,
  branch: "main",
  detail: "clean",
};

const syntheticTester = {
  async runSyntheticJob() {
    return { ok: true, latencyMs: 120 };
  },
};

const buildSuccessfulOptions = (): StartupPreflightRunOptions => ({
  config: baseConfig,
  repoStatusProvider: async () => ({ ...cleanRepo }),
  alertsProvider: async () => [],
  syntheticTester,
  dockerProbe: async () => ({ ok: true, detail: "docker ok" }),
  requiredEnvVars: ["PUSHPALS_AUTH_TOKEN"],
  envVarResolver: async (key: string) =>
    key === "PUSHPALS_AUTH_TOKEN" ? "secret" : "ignored",
  bunVersionProvider: async () => "1.4.0",
  telemetry: { emit: () => {} },
  checkLogger: () => {},
});

const runCliWith = async (
  overrides: Partial<StartupPreflightCliOptions>,
): Promise<{ logs: string[]; exitCodes: number[] }> => {
  const logs: string[] = [];
  const exitCodes: number[] = [];
  const userLogger = overrides.logger;
  const userExit = overrides.exit;
  await runStartupPreflightCli({
    ...overrides,
    logger: (line) => {
      logs.push(line);
      userLogger?.(line);
    },
    exit: (code: number) => {
      exitCodes.push(code);
      userExit?.(code);
    },
  });
  return { logs, exitCodes };
};

describe("startup preflight wiring", () => {
  test("ensureStartupPreflightReadiness resolves with deterministic overrides", async () => {
    const logs: string[] = [];
    const result = await ensureStartupPreflightReadiness({
      ...buildSuccessfulOptions(),
      logger: (line) => logs.push(line),
    });
    expect(result.ok).toBe(true);
    expect(result.history.length).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes("[startup.failure]"))).toBe(false);
  });

  test("ensureStartupPreflightReadiness logs and throws when docker auth fails", async () => {
    const logs: string[] = [];
    await expect(
      ensureStartupPreflightReadiness({
        ...buildSuccessfulOptions(),
        dockerProbe: async () => ({ ok: false, detail: "registry login missing" }),
        logger: (line) => logs.push(line),
      }),
    ).rejects.toThrow(/startup\.docker_auth_failed/);
    expect(logs.some((line) => line.includes("[startup.failure]"))).toBe(true);
    expect(logs.some((line) => line.includes("registry login missing"))).toBe(true);
  });

  test("runStartupPreflightCli exits successfully when ensure passes", async () => {
    const fakeHistory: StartupCheckRecord[] = [
      {
        code: STARTUP_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
        label: "Bun check",
        category: "runtime",
        step: 1,
        status: "pass",
        detail: "ok",
        elapsedMs: 5,
      },
    ];
    const ensureFn = async (): Promise<StartupChecklistResult> => ({
      ok: true,
      history: fakeHistory,
    });
    const { logs, exitCodes } = await runCliWith({ ensureFn });
    expect(exitCodes).toEqual([0]);
    expect(logs.at(0)).toContain("Running RemoteBuddy startup preflight");
    expect(logs.at(-1)).toContain("RemoteBuddy is ready to dispatch.");
  });

  test("runStartupPreflightCli exits non-zero and surfaces ensure failure", async () => {
    const ensureFn = async () => {
      throw new Error("preflight blocked");
    };
    const { logs, exitCodes } = await runCliWith({ ensureFn });
    expect(exitCodes).toEqual([1]);
    expect(logs.some((line) => line.includes("preflight blocked"))).toBe(true);
  });
});
