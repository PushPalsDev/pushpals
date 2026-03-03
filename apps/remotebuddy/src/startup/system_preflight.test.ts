import { describe, expect, test } from "bun:test";

import {
  SYSTEM_PREFLIGHT_FAILURE_CODES,
  SystemPreflightError,
  createServerSyntheticTester,
  ensureSystemPreflight,
  runSystemPreflight,
  type SystemPreflightContext,
} from "./system_preflight.js";

const buildPassingContext = (): SystemPreflightContext => ({
  describeRepo: async () => ({
    isDirty: false,
    isMergeInProgress: false,
    detail: "clean worktree",
  }),
  listFiringAlerts: async () => [],
  syntheticTester: {
    runSyntheticJob: async () => ({ ok: true, latencyMs: 42 }),
  },
});

describe("system_preflight", () => {
  test("ensureSystemPreflight throws SystemPreflightError with structured metadata", async () => {
    const ctx: SystemPreflightContext = {
      describeRepo: async () => ({
        isDirty: false,
        isMergeInProgress: true,
        detail: "merge in progress",
      }),
      listFiringAlerts: async () => [],
      syntheticTester: {
        runSyntheticJob: async () => ({ ok: true, latencyMs: 25 }),
      },
    };

    await expect(ensureSystemPreflight(ctx)).rejects.toBeInstanceOf(SystemPreflightError);
    try {
      await ensureSystemPreflight(ctx);
    } catch (error) {
      expect(error).toBeInstanceOf(SystemPreflightError);
      const failure = error as SystemPreflightError;
      expect(failure.code).toBe(SYSTEM_PREFLIGHT_FAILURE_CODES.MERGE_IN_PROGRESS);
      expect(failure.detail).toContain("merge in progress");
      expect(failure.history).toHaveLength(1);
      expect(failure.history[0].code).toBe(SYSTEM_PREFLIGHT_FAILURE_CODES.MERGE_IN_PROGRESS);
    }
  });

  test("runSystemPreflight executes dispatch guard when configured", async () => {
    const ctx = buildPassingContext();
    let dispatched = false;
    const result = await runSystemPreflight(ctx, {
      guardDispatch: true,
      dispatchJob: async () => {
        dispatched = true;
      },
    });
    expect(dispatched).toBe(true);
    expect(result.ok).toBe(true);
    const lastEntry = result.history.at(-1);
    expect(lastEntry?.category).toBe("dispatch");
    expect(lastEntry?.status).toBe("pass");
  });

  test("createServerSyntheticTester surfaces HTTP errors", async () => {
    let requested: string | null = null;
    const tester = createServerSyntheticTester({
      server: "http://localhost:43210",
      fetchImpl: async (url: string) => {
        requested = url;
        return new Response("service unavailable", { status: 503 });
      },
    });
    const result = await tester.runSyntheticJob({ maxLatencyMs: 50, probeName: "startup.probe" });
    expect(requested).toContain("/healthz");
    expect(result.ok).toBe(false);
    expect(result.failureDetail).toContain("503");
  });
});
