import { describe, expect, test } from "bun:test";

import {
  REMOTEBUDDY_PREFLIGHT_FAILURE_CODES,
  runRemoteBuddyPreflight,
  runRemoteBuddyPreflightCliCommand,
  type RemoteBuddyPreflightConfigSnapshot,
  type RemoteBuddyPreflightOptions,
  type RemoteBuddyPreflightRecord,
  type RemoteBuddyPreflightResult,
} from "./preflight.js";

type ProbeOverrides = Required<NonNullable<RemoteBuddyPreflightOptions["probes"]>>;

const cleanWorkspace = {
  isDirty: false,
  dirtyFiles: [] as string[],
  mergeInProgress: false,
  detail: "clean",
};

const healthyStatus = {
  ok: true,
  detail: "system/status responded in 12 ms",
  latencyMs: 12,
  idleWorkers: 3,
  pendingRequests: 0,
};

const baseConfig: RemoteBuddyPreflightConfigSnapshot = {
  authToken: "token",
  serverUrl: "http://localhost:3001",
  projectRoot: "/repo",
  allowDirtyWorktree: false,
};

const buildOptions = (
  overrides: Partial<RemoteBuddyPreflightOptions> = {},
  probesOverrides: Partial<ProbeOverrides> = {},
): RemoteBuddyPreflightOptions => ({
  repoRoot: "/repo",
  config: baseConfig,
  probes: {
    config: async () => ({ missing: [], empty: [] }),
    workspace: async () => ({ ...cleanWorkspace }),
    systemStatus: async () => ({ ...healthyStatus }),
    ...probesOverrides,
  },
  ...overrides,
});

const createCliConsole = () => {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    console: {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
    } as const,
  };
};

const cliRecord = (
  overrides: Partial<RemoteBuddyPreflightRecord> = {},
): RemoteBuddyPreflightRecord => ({
  code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.CONFIG_MISSING,
  label: "config present",
  category: "config",
  step: 1,
  status: "pass",
  detail: "ok",
  elapsedMs: 0,
  timestamp: "1970-01-01T00:00:00.000Z",
  ...overrides,
});

const buildCliRunner = (result: RemoteBuddyPreflightResult) => {
  return async (options: RemoteBuddyPreflightOptions) => {
    result.records.forEach((record) => {
      options.reporter?.({ ...record });
    });
    return result;
  };
};

describe("runRemoteBuddyPreflight", () => {
  test("passes when all checks succeed", async () => {
    const result = await runRemoteBuddyPreflight(buildOptions());
    expect(result.ok).toBe(true);
    expect(result.records).toHaveLength(7);
    expect(result.records.every((record) => record.status === "pass")).toBe(true);
  });

  test("fails fast when config files are missing", async () => {
    const result = await runRemoteBuddyPreflight(
      buildOptions({}, {
        config: async () => ({ missing: ["configs/local.toml"], empty: [] }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.CONFIG_MISSING,
    );
    expect(result.records[0].status).toBe("fail");
  });

  test("surface config parse failures with actionable detail", async () => {
    const result = await runRemoteBuddyPreflight({
      ...buildOptions({ config: undefined }),
      loadConfigSnapshot: () => {
        throw new Error("toml parse error");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe(
      REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.CONFIG_INVALID,
    );
    expect(result.failure?.detail).toContain("toml parse error");
  });

  test("secrets check enforces auth token unless bypassed", async () => {
    const missingTokenResult = await runRemoteBuddyPreflight(
      buildOptions({
        config: { ...baseConfig, authToken: null },
      }),
    );
    expect(missingTokenResult.ok).toBe(false);
    expect(missingTokenResult.failure?.code).toBe(
      REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.SECRETS_MISSING,
    );

    const bypassResult = await runRemoteBuddyPreflight(
      buildOptions(
        {
          config: { ...baseConfig, authToken: null },
          allowMissingAuthToken: true,
        },
      ),
    );
    expect(bypassResult.ok).toBe(true);
    const secretsRecord = bypassResult.records.find(
      (r) => r.code === REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.SECRETS_MISSING,
    );
    expect(secretsRecord?.detail).toContain("bypass");
  });

  test("workspace guards block merge in progress and dirty trees", async () => {
    const mergeResult = await runRemoteBuddyPreflight(
      buildOptions({}, {
        workspace: async () => ({ ...cleanWorkspace, mergeInProgress: true }),
      }),
    );
    expect(mergeResult.ok).toBe(false);
    expect(mergeResult.failure?.code).toBe(
      REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.MERGE_IN_PROGRESS,
    );

    const dirtyResult = await runRemoteBuddyPreflight(
      buildOptions({}, {
        workspace: async () => ({
          isDirty: true,
          dirtyFiles: ["README.md"],
          mergeInProgress: false,
          detail: "dirty",
        }),
      }),
    );
    expect(dirtyResult.ok).toBe(false);
    expect(dirtyResult.failure?.code).toBe(
      REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.WORKSPACE_DIRTY,
    );

    const bypassDirty = await runRemoteBuddyPreflight(
      buildOptions(
        {
          allowDirtyWorktree: true,
        },
        {
          workspace: async () => ({
            isDirty: true,
            dirtyFiles: ["README.md"],
            mergeInProgress: false,
            detail: "dirty",
          }),
        },
      ),
    );
    expect(bypassDirty.ok).toBe(true);
  });

  test("dependency probes surface server reachability and capacity issues", async () => {
    const serverDown = await runRemoteBuddyPreflight(
      buildOptions({}, {
        systemStatus: async () => ({
          ok: false,
          detail: "ECONNREFUSED",
          latencyMs: 5,
        }),
      }),
    );
    expect(serverDown.ok).toBe(false);
    expect(serverDown.failure?.code).toBe(
      REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.SERVER_UNREACHABLE,
    );

    const idleTooLow = await runRemoteBuddyPreflight(
      buildOptions({}, {
        systemStatus: async () => ({
          ok: true,
          detail: "ok",
          latencyMs: 10,
          idleWorkers: 0,
          pendingRequests: 0,
        }),
      }),
    );
    expect(idleTooLow.ok).toBe(false);
    expect(idleTooLow.failure?.code).toBe(
      REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.WORKERPALS_CAPACITY,
    );

    const pendingTooHigh = await runRemoteBuddyPreflight(
      buildOptions({}, {
        systemStatus: async () => ({
          ok: true,
          detail: "ok",
          latencyMs: 10,
          idleWorkers: 2,
          pendingRequests: 50,
        }),
      }),
    );
    expect(pendingTooHigh.ok).toBe(false);
    expect(pendingTooHigh.failure?.code).toBe(
      REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.WORKERPALS_CAPACITY,
    );
  });
});

describe("runRemoteBuddyPreflightCliCommand", () => {
  test("produces deterministic JSON-only output", async () => {
    const records = [
      cliRecord(),
      cliRecord({
        code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.SERVER_UNREACHABLE,
        category: "dependencies",
        step: 2,
        detail: "system/status responded",
      }),
    ];
    const runPreflight = buildCliRunner({ ok: true, records });
    const firstCapture = createCliConsole();
    const result = await runRemoteBuddyPreflightCliCommand({
      argv: ["--json"],
      deps: { console: firstCapture.console, env: {}, runPreflight },
    });
    const secondCapture = createCliConsole();
    await runRemoteBuddyPreflightCliCommand({
      argv: ["--json"],
      deps: { console: secondCapture.console, env: {}, runPreflight },
    });
    expect(result.exitCode).toBe(0);
    expect(firstCapture.errors).toHaveLength(0);
    expect(firstCapture.logs).toHaveLength(records.length);
    expect(secondCapture.logs).toEqual(firstCapture.logs);
    const parsed = firstCapture.logs.map(
      (line) => JSON.parse(line) as RemoteBuddyPreflightRecord,
    );
    parsed.forEach((record) => {
      expect(record.timestamp).toBe("1970-01-01T00:00:00.000Z");
      expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    });
  });

  test("prints human-readable logs in observable mode", async () => {
    const capture = createCliConsole();
    const result = await runRemoteBuddyPreflightCliCommand({
      argv: [],
      deps: {
        console: capture.console,
        env: {},
        runPreflight: buildCliRunner({ ok: true, records: [cliRecord()] }),
      },
    });
    expect(result.exitCode).toBe(0);
    expect(capture.logs).toHaveLength(1);
    expect(capture.errors.some((line) => line.includes("[preflight] PASS"))).toBe(true);
    expect(capture.errors.some((line) => line.includes("preflight passed"))).toBe(true);
  });

  test("surfaces failure detail and action", async () => {
    const failure = {
      code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.SECRETS_MISSING,
      detail: "missing auth token",
      action: "Export PUSHPALS_AUTH_TOKEN and rerun.",
      category: "secrets" as RemoteBuddyPreflightRecord["category"],
      step: 3,
    };
    const capture = createCliConsole();
    const result = await runRemoteBuddyPreflightCliCommand({
      argv: [],
      deps: {
        console: capture.console,
        env: {},
        runPreflight: buildCliRunner({
          ok: false,
          failure,
          records: [
            cliRecord(),
            cliRecord({
              ...failure,
              status: "fail",
            }),
          ],
        }),
      },
    });
    expect(result.exitCode).toBe(1);
    expect(capture.errors.some((line) => line.includes(failure.code))).toBe(true);
    expect(capture.errors.some((line) => line.includes("Action:"))).toBe(true);
  });

  test("rejects unknown flags with usage guidance", async () => {
    const capture = createCliConsole();
    const result = await runRemoteBuddyPreflightCliCommand({
      argv: ["--bogus"],
      deps: { console: capture.console, env: {} },
    });
    expect(result.exitCode).toBe(1);
    expect(capture.errors[0]).toContain("Unknown flag");
    expect(capture.errors.some((line) => line.includes("Usage: bun run preflight"))).toBe(
      true,
    );
  });
});
