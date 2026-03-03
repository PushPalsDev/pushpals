import { describe, expect, test } from "bun:test";

import {
  enforceSupervisorPreflight,
  RemoteBuddySupervisorPreflightError,
} from "./remotebuddy_supervisor.js";
import {
  REMOTEBUDDY_PREFLIGHT_FAILURE_CODES,
  type RemoteBuddyPreflightFailure,
  type RemoteBuddyPreflightRecord,
  type RemoteBuddyPreflightResult,
  type RemoteBuddyPreflightOptions,
} from "./startup/preflight.js";

const baseRecord: RemoteBuddyPreflightRecord = {
  code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.CONFIG_MISSING,
  label: "config present",
  category: "config",
  step: 1,
  status: "pass",
  detail: "ok",
  elapsedMs: 4,
  timestamp: new Date(0).toISOString(),
};

const buildLogger = () => {
  const entries: string[] = [];
  return {
    entries,
    logger: {
      log: (message: string) => entries.push(`LOG ${message}`),
      error: (message: string) => entries.push(`ERR ${message}`),
    } as const,
  };
};

const parseStructuredPayload = (entry?: string) => {
  if (!entry) {
    throw new Error("Structured log entry not found");
  }
  const normalized = entry.replace(/^(LOG|ERR)\s+/, "");
  return JSON.parse(normalized);
};

const mockNow = (...values: number[]): (() => number) => {
  let index = 0;
  return () => {
    const current = values[index] ?? values[values.length - 1];
    index += 1;
    return current;
  };
};

const buildRunPreflight = (result: RemoteBuddyPreflightResult) => {
  return async (options: RemoteBuddyPreflightOptions) => {
    result.records.forEach((record) => options.reporter?.({ ...record }));
    return result;
  };
};

describe("RemoteBuddy supervisor preflight gate", () => {
  test("allows startup when the deterministic preflight passes", async () => {
    const { entries, logger } = buildLogger();
    const result = await enforceSupervisorPreflight({
      logger,
      now: mockNow(100, 175),
      runPreflight: buildRunPreflight({
        ok: true,
        records: [
          baseRecord,
          {
            ...baseRecord,
            code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.SERVER_UNREACHABLE,
            category: "dependencies",
            step: 2,
            detail: "system/status responded",
          },
        ],
      }),
    });

    expect(result.recordCount).toBe(2);
    expect(result.elapsedMs).toBe(75);
    expect(entries.some((line) => line.includes("preflight_passed"))).toBe(true);
    expect(entries.filter((line) => line.includes("[preflight] PASS")).length).toBe(2);
    const structuredLine = entries.find((line) =>
      line.includes("\"event\":\"preflight_result\""),
    );
    const payload = parseStructuredPayload(structuredLine);
    expect(payload.status).toBe("passed");
    expect(payload.record_count).toBe(2);
    expect(payload.elapsed_ms).toBe(75);
    expect(payload.failure).toBeUndefined();
  });

  test("blocks startup with structured telemetry when the preflight fails", async () => {
    const { entries, logger } = buildLogger();
    const failure: RemoteBuddyPreflightFailure = {
      code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.SECRETS_MISSING,
      detail: "missing auth token",
      action: "Export PUSHPALS_AUTH_TOKEN and rerun.",
      category: "secrets",
      step: 3,
    };

    let caught: RemoteBuddySupervisorPreflightError | null = null;
    await enforceSupervisorPreflight({
      logger,
      now: mockNow(10, 40),
      runPreflight: buildRunPreflight({
        ok: false,
        failure,
        records: [
          baseRecord,
          {
            ...baseRecord,
            code: failure.code,
            category: failure.category,
            step: failure.step,
            status: "fail",
            detail: failure.detail,
            action: failure.action,
          },
        ],
      }),
    }).catch((error) => {
      caught = error as RemoteBuddySupervisorPreflightError;
    });

    expect(caught).toBeInstanceOf(RemoteBuddySupervisorPreflightError);
    expect(caught?.failure).toEqual(failure);
    expect(caught?.elapsedMs).toBe(30);

    const failureLog = entries.find((line) => line.includes("preflight_failed"));
    expect(failureLog).toBeTruthy();
    expect(failureLog).toContain(`code=${failure.code}`);
    expect(failureLog).toContain(`action=${JSON.stringify(failure.action)}`);
    expect(failureLog).toContain(`step=${failure.step}`);

    const structuredLine = entries.find((line) =>
      line.includes("\"event\":\"preflight_result\""),
    );
    const payload = parseStructuredPayload(structuredLine);
    expect(payload.status).toBe("failed");
    expect(payload.elapsed_ms).toBe(30);
    expect(payload.failure).toBeTruthy();
    expect(payload.failure.code).toBe(failure.code);
    expect(payload.failure.category).toBe(failure.category);
    expect(payload.failure.step).toBe(failure.step);
    expect(payload.failure.detail).toBe(failure.detail);
    expect(payload.failure.action).toBe(failure.action);
  });

  test("derives failure metadata from records when runPreflight omits failure payload", async () => {
    const { entries, logger } = buildLogger();
    const dirtyDetail = "Worktree dirty";
    let caught: RemoteBuddySupervisorPreflightError | null = null;
    await enforceSupervisorPreflight({
      logger,
      now: mockNow(0, 25),
      runPreflight: buildRunPreflight({
        ok: false,
        records: [
          baseRecord,
          {
            ...baseRecord,
            code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.WORKSPACE_DIRTY,
            category: "workspace",
            step: 2,
            status: "fail",
            detail: dirtyDetail,
            action: undefined,
          },
        ],
      }),
    }).catch((error) => {
      caught = error as RemoteBuddySupervisorPreflightError;
    });

    expect(caught).toBeInstanceOf(RemoteBuddySupervisorPreflightError);
    expect(caught?.failure.code).toBe(
      REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.WORKSPACE_DIRTY,
    );
    expect(caught?.failure.category).toBe("workspace");
    expect(caught?.failure.step).toBe(2);
    expect(caught?.failure.detail).toBe(dirtyDetail);
    expect(caught?.failure.action).toContain(
      REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.WORKSPACE_DIRTY,
    );

    const payload = parseStructuredPayload(
      entries.find((line) => line.includes("\"event\":\"preflight_result\"")),
    );
    expect(payload.failure.code).toBe(
      REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.WORKSPACE_DIRTY,
    );
    expect(payload.failure.detail).toBe(dirtyDetail);
    expect(payload.status).toBe("failed");
  });

  test("emits unknown_preflight_failure when neither failure payload nor records are available", async () => {
    const { entries, logger } = buildLogger();
    let caught: RemoteBuddySupervisorPreflightError | null = null;
    await enforceSupervisorPreflight({
      logger,
      now: mockNow(5, 35),
      runPreflight: buildRunPreflight({
        ok: false,
        records: [],
      }),
    }).catch((error) => {
      caught = error as RemoteBuddySupervisorPreflightError;
    });

    expect(caught).toBeInstanceOf(RemoteBuddySupervisorPreflightError);
    expect(caught?.failure.code).toBe("remotebuddy.unknown_preflight_failure");
    expect(caught?.failure.category).toBe("unknown");
    expect(caught?.failure.step).toBe(-1);

    const payload = parseStructuredPayload(
      entries.find((line) => line.includes("\"event\":\"preflight_result\"")),
    );
    expect(payload.status).toBe("failed");
    expect(payload.failure.code).toBe("remotebuddy.unknown_preflight_failure");
    expect(payload.failure.category).toBe("unknown");
    expect(payload.failure.action).toContain("preflight");
  });
});

describe("RemoteBuddy supervisor startup integration", () => {
  test("invokes spawn callback after a passing preflight", async () => {
    let spawnCount = 0;
    const { logger } = buildLogger();
    await enforceSupervisorPreflight({
      logger,
      now: mockNow(0, 5),
      runPreflight: buildRunPreflight({
        ok: true,
        records: [baseRecord],
      }),
    }).then(() => {
      spawnCount += 1;
    });
    expect(spawnCount).toBe(1);
  });

  test("blocks spawn callback when the preflight fails", async () => {
    let spawnCount = 0;
    const { logger } = buildLogger();
    const failure: RemoteBuddyPreflightFailure = {
      code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.CONFIG_INVALID,
      detail: "invalid toml",
      action: "Fix configs and rerun.",
      category: "config",
      step: 2,
    };
    await enforceSupervisorPreflight({
      logger,
      now: mockNow(0, 5),
      runPreflight: buildRunPreflight({
        ok: false,
        failure,
        records: [
          baseRecord,
          {
            ...baseRecord,
            code: failure.code,
            category: failure.category,
            step: failure.step,
            status: "fail",
            detail: failure.detail,
            action: failure.action,
          },
        ],
      }),
    })
      .then(() => {
        spawnCount += 1;
      })
      .catch(() => {});

    expect(spawnCount).toBe(0);
  });
});
