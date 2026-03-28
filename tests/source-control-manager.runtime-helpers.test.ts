import { describe, expect, test } from "bun:test";
import { loadConfig } from "../apps/source_control_manager/src/config";
import {
  cloneSourceControlManagerConfigSnapshot,
  createStartupStatusTracker,
  createSingleFlightExecutor,
} from "../apps/source_control_manager/src/runtime_helpers";

describe("source_control_manager runtime helpers", () => {
  test("cloneSourceControlManagerConfigSnapshot isolates mutable review and check config", () => {
    const config = loadConfig();
    const snapshot = cloneSourceControlManagerConfigSnapshot(config);

    config.reviewAgent.enabled = !config.reviewAgent.enabled;
    config.checks.push({ name: "temp", command: "echo temp" });

    expect(snapshot.reviewAgent.enabled).not.toBe(config.reviewAgent.enabled);
    expect(snapshot.checks.some((check) => check.name === "temp")).toBe(false);
  });

  test("createSingleFlightExecutor dedupes concurrent executions and resets after settle", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = createSingleFlightExecutor(async () => {
      runs += 1;
      await gate;
      return runs;
    });

    const first = run();
    const second = run();
    expect(first).toBe(second);

    release();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(1);
    await expect(run()).resolves.toBe(2);
  });

  test("createStartupStatusTracker prevents stale initializing emissions after online", () => {
    const tracker = createStartupStatusTracker();

    expect(tracker.getPhase()).toBe("startup");
    expect(tracker.canEmitInitializing(true)).toBe(true);
    expect(tracker.beginOnlineTransition()).toBe(true);
    expect(tracker.getPhase()).toBe("online");
    expect(tracker.canEmitInitializing(true)).toBe(false);
    expect(tracker.beginOnlineTransition()).toBe(false);
  });

  test("createStartupStatusTracker can revert a failed online transition before shutdown", () => {
    const tracker = createStartupStatusTracker();

    expect(tracker.beginOnlineTransition()).toBe(true);
    tracker.revertOnlineTransition();
    expect(tracker.getPhase()).toBe("startup");
    expect(tracker.canEmitInitializing(true)).toBe(true);

    tracker.markShutdown();
    expect(tracker.getPhase()).toBe("shutdown");
    expect(tracker.canEmitInitializing(true)).toBe(false);
    expect(tracker.beginOnlineTransition()).toBe(false);
  });
});
