import { describe, expect, test } from "bun:test";
import {
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
});
