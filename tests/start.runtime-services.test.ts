import { describe, expect, test } from "bun:test";
import {
  ServiceManager,
  buildCoreManagedServiceSpecs,
  computeLocalBuddyRestartBackoffMs,
  resolveLocalBuddyRuntimeAction,
  resolveLocalBuddyStartGate,
} from "../scripts/start_runtime_services";

describe("start runtime service helpers", () => {
  test("buildCoreManagedServiceSpecs excludes LocalBuddy so it can be supervised dynamically", () => {
    const specs = buildCoreManagedServiceSpecs();
    expect(specs.map((spec) => spec.name)).toEqual([
      "server",
      "remotebuddy",
      "workerpals",
      "source_control_manager",
      "client",
    ]);
  });

  test("resolveLocalBuddyRuntimeAction starts and stops only when runtime state changes require it", () => {
    expect(resolveLocalBuddyRuntimeAction(false, true)).toBe("start");
    expect(resolveLocalBuddyRuntimeAction(true, false)).toBe("stop");
    expect(resolveLocalBuddyRuntimeAction(false, false)).toBe("noop");
    expect(resolveLocalBuddyRuntimeAction(true, true)).toBe("noop");
  });

  test("computeLocalBuddyRestartBackoffMs grows exponentially and clamps at the configured max", () => {
    expect(computeLocalBuddyRestartBackoffMs(1)).toBe(5_000);
    expect(computeLocalBuddyRestartBackoffMs(2)).toBe(10_000);
    expect(computeLocalBuddyRestartBackoffMs(3)).toBe(20_000);
    expect(computeLocalBuddyRestartBackoffMs(10)).toBe(60_000);
  });

  test("resolveLocalBuddyStartGate blocks retries during backoff and after exhaustion", () => {
    expect(
      resolveLocalBuddyStartGate({
        nowMs: 1_000,
        retryAfterMs: 0,
        consecutiveFailures: 0,
        maxConsecutiveFailures: 5,
      }),
    ).toBe("ready");
    expect(
      resolveLocalBuddyStartGate({
        nowMs: 1_000,
        retryAfterMs: 2_000,
        consecutiveFailures: 1,
        maxConsecutiveFailures: 5,
      }),
    ).toBe("backoff");
    expect(
      resolveLocalBuddyStartGate({
        nowMs: 10_000,
        retryAfterMs: 9_000,
        consecutiveFailures: 5,
        maxConsecutiveFailures: 5,
      }),
    ).toBe("retry_exhausted");
  });

  test("ServiceManager notifies when a service reaches restart exhaustion", async () => {
    let degraded: { name: string; reason: string; detail: string } | null = null;
    const manager = new ServiceManager({
      pollMs: 25,
      maxRestartAttempts: 1,
      computeRestartBackoffMs: () => 25,
      spawnService: (spec) => ({
        name: spec.name,
        proc: {} as any,
        command: [...spec.command],
        cwd: spec.cwd,
        env: { ...(spec.env ?? {}) },
        exited: true,
        exitCode: 42,
        launchedAtMs: Date.now(),
        logPath: spec.logPath,
      }),
      onServiceDegraded: (name, reason, health) => {
        degraded = {
          name,
          reason,
          detail: health.detail,
        };
      },
    });
    try {
      manager.startService({
        name: "server",
        color: "blue",
        command: ["fake-server"],
        cwd: process.cwd(),
      });

      await Bun.sleep(150);
      expect(degraded).not.toBeNull();
      expect(degraded?.name).toBe("server");
      expect(degraded?.reason).toContain("reached restart limit");
      expect(degraded?.detail).toContain("server:");
    } finally {
      manager.stop();
    }
  });
});
