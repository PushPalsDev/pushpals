import { describe, expect, test } from "bun:test";
import { LifecycleReconciliationTracker } from "../apps/server/src/lifecycle_reconciliation";

describe("server lifecycle reconciliation watchdog", () => {
  test("keeps a failed startup reconciler retryable and records recovery health", () => {
    const tracker = new LifecycleReconciliationTracker();
    let attempts = 0;
    const reconcile = () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient database busy");
      return { recovered: 2 };
    };

    expect(tracker.run("request lease", { recovered: 0 }, reconcile)).toEqual({ recovered: 0 });
    expect(tracker.snapshot()["request lease"]).toMatchObject({
      lastSuccessAt: null,
      lastError: "transient database busy",
      consecutiveFailures: 1,
    });

    expect(tracker.run("request lease", { recovered: 0 }, reconcile)).toEqual({ recovered: 2 });
    expect(tracker.snapshot()["request lease"]).toMatchObject({
      lastSuccessAt: expect.any(String),
      lastError: null,
      consecutiveFailures: 0,
      lastSuccessAgeMs: expect.any(Number),
      lastAttemptAgeMs: expect.any(Number),
    });
    expect(attempts).toBe(2);
  });

  test("tracks repeated failures without losing the last successful run", () => {
    const tracker = new LifecycleReconciliationTracker();
    expect(tracker.run("worker handoff", 0, () => 1)).toBe(1);
    expect(
      tracker.run("worker handoff", 0, () => {
        throw new Error("first watchdog failure");
      }),
    ).toBe(0);
    expect(
      tracker.run("worker handoff", 0, () => {
        throw new Error("second watchdog failure");
      }),
    ).toBe(0);

    expect(tracker.snapshot()["worker handoff"]).toMatchObject({
      lastSuccessAt: expect.any(String),
      lastError: "second watchdog failure",
      consecutiveFailures: 2,
    });
  });
});
