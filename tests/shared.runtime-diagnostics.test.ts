import { describe, expect, spyOn, test } from "bun:test";
import {
  RuntimeDiagnostics,
  RuntimeLogSinkDiagnostics,
  summarizeRuntimeDiagnostics,
  type RuntimeDiagnosticEvent,
  type RuntimeDiagnosticsOptions,
} from "../packages/shared/src/runtime_diagnostics";

function fixture(
  options: Pick<RuntimeDiagnosticsOptions, "maxSamples" | "onEvent" | "cpuUsage" | "rssBytes"> = {},
) {
  let monotonic = 0;
  let wall = Date.UTC(2026, 8, 28);
  const pending = new Set<() => void>();
  const scheduled: { callback: () => void; delayMs: number }[] = [];
  const logged: RuntimeDiagnosticEvent[] = [];
  const diagnostics = new RuntimeDiagnostics({
    service: "fixture_service",
    now: () => monotonic,
    wallNow: () => wall,
    onEvent: options.onEvent ?? ((event) => logged.push(event)),
    maxSamples: options.maxSamples,
    cpuUsage: options.cpuUsage ?? (() => ({ user: 0, system: 0 })),
    rssBytes: options.rssBytes ?? (() => 0),
    schedule(callback, delayMs) {
      scheduled.push({ callback, delayMs });
      pending.add(callback);
      return () => {
        pending.delete(callback);
      };
    },
  });
  return {
    diagnostics,
    pending,
    scheduled,
    logged,
    advance(ms: number) {
      monotonic += ms;
      wall += ms;
    },
    setWall(ms: number) {
      wall = ms;
    },
    tick() {
      const callback = pending.values().next().value;
      expect(callback).toBeDefined();
      pending.delete(callback!);
      callback!();
    },
  };
}

describe("bounded runtime diagnostics", () => {
  test("body waits and synchronous store work remain distinct and always release active spans", async () => {
    const f = fixture();
    let release!: () => void;
    const body = f.diagnostics.runAsync(
      "worker_heartbeat.body",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    f.advance(1500);
    expect(f.diagnostics.snapshot().activeOperations).toEqual([
      { stage: "worker_heartbeat.body", elapsedMs: 1500 },
    ]);
    release();
    await body;
    const sentinel = new Error("private body contents and request id");
    expect(() =>
      f.diagnostics.run("worker_heartbeat.store", () => {
        expect(f.diagnostics.snapshot().activeOperations).toEqual([
          { stage: "worker_heartbeat.store", elapsedMs: 0 },
        ]);
        f.advance(2000);
        throw sentinel;
      }),
    ).toThrow(sentinel);
    expect(f.diagnostics.snapshot().activeOperations).toEqual([]);
    expect(
      f.diagnostics
        .snapshot()
        .recentSlowEvents.map((event) => event.event === "runtime_slow_operation" && event.stage),
    ).toEqual(["worker_heartbeat.body", "worker_heartbeat.store"]);
    expect(JSON.stringify(f.diagnostics.snapshot())).not.toContain("private");
    expect(f.pending.size).toBe(0);
  });

  test("log sink observations remain fixed-size, memory-only, and do not recursively log failures", () => {
    let now = 0;
    const sink = new RuntimeLogSinkDiagnostics({ now: () => now });
    const log = spyOn(console, "log").mockImplementation(() => {
      throw new Error("logging forbidden");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logging forbidden");
    });
    const error = spyOn(console, "error").mockImplementation(() => {
      throw new Error("logging forbidden");
    });
    try {
      expect(
        sink.write(() => {
          expect(sink.snapshot().activeWrites).toBe(1);
          now += 1500;
        }),
      ).toBe(true);
      expect(
        sink.write(() => {
          now += 2500;
          throw new Error("private file path and secret");
        }),
      ).toBe(false);
      for (let i = 0; i < 1000; i++)
        expect(
          sink.write(() => {
            now += 1;
          }),
        ).toBe(true);
      const snapshot = sink.snapshot();
      expect(snapshot).toEqual({
        attempts: 1002,
        failures: 1,
        slowWrites: 2,
        activeWrites: 0,
        lastWriteDurationMs: 1,
        maxWriteDurationMs: 2500,
        lastSlowWriteAgoMs: 1000,
        lastFailureAgoMs: 1000,
      });
      snapshot.failures = 999;
      expect(sink.snapshot().failures).toBe(1);
      expect(JSON.stringify(snapshot).length).toBeLessThan(400);
      expect(JSON.stringify(snapshot)).not.toContain("private");
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test("failed sink clocks cannot alter the write outcome or retain active operations", () => {
    for (const now of [
      () => NaN,
      () => Infinity,
      () => {
        throw new Error("clock failed");
      },
    ]) {
      const sink = new RuntimeLogSinkDiagnostics({ now });
      let calls = 0;
      expect(
        sink.write(() => {
          calls += 1;
        }),
      ).toBe(true);
      expect(
        sink.write(() => {
          calls += 1;
          throw new Error("write failed");
        }),
      ).toBe(false);
      expect(calls).toBe(2);
      expect(sink.snapshot()).toMatchObject({
        attempts: 2,
        failures: 1,
        activeWrites: 0,
        lastWriteDurationMs: null,
        maxWriteDurationMs: 0,
        lastFailureAgoMs: null,
      });
    }
  });
  test("production timers are unref'd and cancelled on stop", () => {
    let unrefs = 0;
    const timer = {
      unref: () => {
        unrefs += 1;
      },
    } as unknown as ReturnType<typeof setTimeout>;
    const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(
      (() => timer) as unknown as typeof setTimeout,
    );
    const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    try {
      const diagnostics = new RuntimeDiagnostics({ service: "test" });
      expect(setTimer).not.toHaveBeenCalled();
      diagnostics.start();
      expect(unrefs).toBe(1);
      expect(setTimer).toHaveBeenCalledTimes(1);
      diagnostics.stop();
      expect(clearTimer).toHaveBeenCalledWith(timer);
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  });

  test("construction is inert and start/stop are idempotent with one timer", () => {
    const f = fixture();
    expect(f.pending.size).toBe(0);
    expect(f.diagnostics.snapshot().running).toBe(false);
    f.diagnostics.stop();
    f.diagnostics.start();
    f.diagnostics.start();
    expect(f.pending.size).toBe(1);
    expect(f.scheduled).toHaveLength(1);
    expect(f.scheduled[0].delayMs).toBe(1000);
    f.diagnostics.stop();
    f.diagnostics.stop();
    expect(f.pending.size).toBe(0);
    expect(f.diagnostics.snapshot().running).toBe(false);
  });

  test("measures late timer firing and rebases without catch-up drift", () => {
    const f = fixture();
    f.diagnostics.start();
    f.advance(12_000);
    f.tick();
    expect(f.logged).toEqual([
      {
        event: "runtime_event_loop_delay",
        service: "fixture_service",
        delayMs: 11_000,
        sampleIntervalMs: 1000,
        observedAt: "2026-09-28T00:00:12.000Z",
        context: {
          sampleElapsedMs: 12_000,
          cpuUserMs: 0,
          cpuSystemMs: 0,
          rssBytes: 0,
          activeOperations: [],
        },
      },
    ]);
    expect(f.pending.size).toBe(1);
    expect(f.scheduled).toHaveLength(2);
    f.advance(1000);
    f.tick();
    expect(f.diagnostics.snapshot()).toMatchObject({
      lastEventLoopDelayMs: 0,
      maxEventLoopDelayMs: 11_000,
      slowEventLoopSamples: 1,
    });
    expect(f.logged).toHaveLength(1);
    f.diagnostics.stop();
  });

  test("stale callbacks cannot revive stopped or restarted samplers", () => {
    const f = fixture();
    f.diagnostics.start();
    const oldCallback = f.scheduled[0].callback;
    f.diagnostics.stop();
    f.advance(40_000);
    oldCallback();
    expect(f.scheduled).toHaveLength(1);
    f.diagnostics.start();
    oldCallback();
    expect(f.pending.size).toBe(1);
    expect(f.scheduled).toHaveLength(2);
    f.advance(1000);
    f.tick();
    expect(f.diagnostics.snapshot().lastEventLoopDelayMs).toBe(0);
    expect(f.logged).toHaveLength(0);
    f.diagnostics.stop();
  });

  test("sink may stop the sampler during notification without rescheduling", () => {
    const f = fixture({ onEvent: () => f.diagnostics.stop() });
    f.diagnostics.start();
    f.advance(2000);
    f.tick();
    expect(f.pending.size).toBe(0);
    expect(f.diagnostics.snapshot().running).toBe(false);
  });

  test("operation wrappers preserve exact return values and thrown values", () => {
    const f = fixture();
    const result = {};
    expect(f.diagnostics.run("fast", () => result)).toBe(result);
    expect(f.logged).toHaveLength(0);
    const failure = { code: "PRIVATE_ERROR_MUST_NOT_BE_LOGGED" };
    let caught: unknown;
    try {
      f.diagnostics.run("snapshot.build", () => {
        f.advance(1500);
        throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(f.logged[0]).toMatchObject({
      event: "runtime_slow_operation",
      stage: "snapshot.build",
      durationMs: 1500,
    });
    expect(JSON.stringify(f.diagnostics.snapshot())).not.toContain(failure.code);
  });

  test("async wrappers record successful and rejected operations in finally", async () => {
    const f = fixture();
    const result = {};
    expect(
      await f.diagnostics.runAsync("publish", async () => {
        f.advance(1000);
        return result;
      }),
    ).toBe(result);
    const error = new Error("private rejection");
    await expect(
      f.diagnostics.runAsync("validate", async () => {
        f.advance(1500);
        throw error;
      }),
    ).rejects.toBe(error);
    expect(f.diagnostics.snapshot().slowOperationSamples).toBe(2);
    expect(f.logged.map((event) => event.event)).toEqual([
      "runtime_slow_operation",
      "runtime_slow_operation",
    ]);
    expect(JSON.stringify(f.logged)).not.toContain(error.message);
  });

  test("operation wrappers record before sampler start and after stop", async () => {
    const f = fixture();
    f.diagnostics.run("startup", () => f.advance(1000));
    f.diagnostics.start();
    f.diagnostics.stop();
    await f.diagnostics.runAsync("shutdown", async () => {
      f.advance(1000);
    });
    expect(f.diagnostics.snapshot().slowOperationSamples).toBe(2);
    expect(f.pending.size).toBe(0);
  });

  test("durations use monotonic time even when the wall clock moves backwards", () => {
    const f = fixture();
    f.diagnostics.run("database.query", () => {
      f.advance(1500);
      f.setWall(Date.UTC(2020, 0, 1));
    });
    expect(f.logged[0]).toMatchObject({ durationMs: 1500, observedAt: "2020-01-01T00:00:00.000Z" });
  });

  test("ring size is bounded and snapshots and sinks cannot mutate retained samples", () => {
    const f = fixture({
      maxSamples: 2,
      onEvent: (event) => {
        event.service = "sink_mutation";
      },
    });
    for (let i = 0; i < 10; i += 1) f.diagnostics.run(`step${i}`, () => f.advance(1000));
    const snapshot = f.diagnostics.snapshot();
    expect(snapshot.recentSlowEvents).toHaveLength(2);
    expect(snapshot.slowOperationSamples).toBe(10);
    expect(snapshot.recentSlowEvents[0]).toMatchObject({
      service: "fixture_service",
      stage: "step8",
    });
    snapshot.recentSlowEvents[0].service = "snapshot_mutation";
    snapshot.recentSlowEvents.length = 0;
    expect(f.diagnostics.snapshot().recentSlowEvents).toHaveLength(2);
    expect(f.diagnostics.snapshot().recentSlowEvents[0].service).toBe("fixture_service");
  });

  test("concurrent slow completions retain samples but rate-limit log emission", async () => {
    const f = fixture();
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operations = Array.from({ length: 30 }, () =>
      f.diagnostics.runAsync("parallel", () => ready),
    );
    f.advance(1000);
    finish();
    await Promise.all(operations);
    expect(f.logged).toHaveLength(1);
    expect(f.diagnostics.snapshot()).toMatchObject({
      slowOperationSamples: 30,
      suppressedLogEvents: 29,
    });
    expect(f.diagnostics.snapshot().recentSlowEvents).toHaveLength(16);
    f.diagnostics.run("next", () => f.advance(1000));
    expect(f.logged).toHaveLength(2);
  });

  test("throwing and rejecting sinks do not change results, errors, or timer continuity", async () => {
    const f = fixture({
      onEvent: () => {
        throw new Error("sink failed");
      },
    });
    expect(
      f.diagnostics.run("work", () => {
        f.advance(1000);
        return 42;
      }),
    ).toBe(42);
    f.diagnostics.start();
    f.advance(2000);
    f.tick();
    expect(f.pending.size).toBe(1);
    f.diagnostics.stop();
    const asyncSink = fixture({
      onEvent: async () => {
        throw new Error("async sink failed");
      },
    });
    const original = new Error("original");
    await expect(
      asyncSink.diagnostics.runAsync("work", async () => {
        asyncSink.advance(1000);
        throw original;
      }),
    ).rejects.toBe(original);
    await Promise.resolve();
    expect(asyncSink.diagnostics.snapshot().slowOperationSamples).toBe(1);
  });

  test("failed or invalid clocks cannot prevent work or replace results and failures", async () => {
    for (const now of [
      () => {
        throw new Error("clock failed");
      },
      () => NaN,
      () => Infinity,
    ]) {
      const diagnostics = new RuntimeDiagnostics({ service: "test", now });
      expect(diagnostics.run("work", () => 42)).toBe(42);
      const failure = {};
      let caught: unknown;
      try {
        diagnostics.run("work", () => {
          throw failure;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(await diagnostics.runAsync("work", async () => 42)).toBe(42);
      await expect(
        diagnostics.runAsync("work", async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(() => diagnostics.start()).not.toThrow();
      expect(diagnostics.snapshot().running).toBe(false);
      expect(diagnostics.snapshot().recentSlowEvents).toHaveLength(0);
    }
  });

  test("a completion clock failure does not mask successful or failed work", () => {
    let broken = false;
    const diagnostics = new RuntimeDiagnostics({
      service: "test",
      now: () => {
        if (broken) throw new Error("clock failed");
        return 0;
      },
    });
    expect(
      diagnostics.run("work", () => {
        broken = true;
        return 42;
      }),
    ).toBe(42);
    broken = false;
    const failure = new Error("original");
    expect(() =>
      diagnostics.run("work", () => {
        broken = true;
        throw failure;
      }),
    ).toThrow(failure);
  });

  test("a broken clock during sampling disables diagnostics without escaping the callback", () => {
    let broken = false;
    let callback!: () => void;
    const diagnostics = new RuntimeDiagnostics({
      service: "test",
      now: () => {
        if (broken) throw new Error("clock failed");
        return 0;
      },
      schedule: (next) => {
        callback = next;
        return () => undefined;
      },
    });
    diagnostics.start();
    broken = true;
    expect(() => callback()).not.toThrow();
    expect(diagnostics.snapshot().running).toBe(false);
  });

  test("scheduler failures during start or rescheduling disable only diagnostics", () => {
    const initialFailure = new RuntimeDiagnostics({
      service: "test",
      schedule: () => {
        throw new Error("schedule failed");
      },
    });
    expect(() => initialFailure.start()).not.toThrow();
    expect(initialFailure.snapshot().running).toBe(false);
    let callback!: () => void;
    let schedules = 0;
    const rescheduleFailure = new RuntimeDiagnostics({
      service: "test",
      now: () => 0,
      schedule: (next) => {
        schedules += 1;
        if (schedules > 1) throw new Error("reschedule failed");
        callback = next;
        return () => undefined;
      },
    });
    rescheduleFailure.start();
    expect(() => callback()).not.toThrow();
    expect(rescheduleFailure.snapshot().running).toBe(false);
    expect(schedules).toBe(2);
  });

  test("throwing cancellation does not block shutdown or revive stale callbacks", () => {
    let callback!: () => void;
    let cancellations = 0;
    const diagnostics = new RuntimeDiagnostics({
      service: "test",
      schedule: (next) => {
        callback = next;
        return () => {
          cancellations += 1;
          throw new Error("cancel failed");
        };
      },
    });
    diagnostics.start();
    expect(() => diagnostics.stop()).not.toThrow();
    expect(() => diagnostics.stop()).not.toThrow();
    expect(() => callback()).not.toThrow();
    expect(cancellations).toBe(1);
    expect(diagnostics.snapshot().running).toBe(false);
  });

  test("invalid wall timestamps do not replace caller outcomes or break sampler continuity", () => {
    let now = 0;
    let callback!: () => void;
    const diagnostics = new RuntimeDiagnostics({
      service: "test",
      now: () => now,
      wallNow: () => NaN,
      schedule: (next) => {
        callback = next;
        return () => undefined;
      },
    });
    expect(
      diagnostics.run("work", () => {
        now = 1000;
        return 42;
      }),
    ).toBe(42);
    diagnostics.start();
    now = 4000;
    expect(() => callback()).not.toThrow();
    expect(diagnostics.snapshot().running).toBe(true);
    diagnostics.stop();
  });

  test("invalid stage labels are not recorded as raw request or error text", () => {
    const f = fixture();
    f.diagnostics.run("request body: secret password", () => f.advance(1000));
    expect(f.logged[0]).toMatchObject({ stage: "operation" });
    expect(JSON.stringify(f.logged)).not.toContain("secret");
  });

  test("strict options reject nonfinite, negative, fractional, and unsafe sizes", () => {
    for (const name of ["sampleIntervalMs", "slowThresholdMs", "maxSamples"] as const) {
      for (const value of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => new RuntimeDiagnostics({ service: "test", [name]: value })).toThrow(
          RangeError,
        );
      }
    }
    expect(() => new RuntimeDiagnostics({ service: "test", sampleIntervalMs: 60_001 })).toThrow(
      RangeError,
    );
    expect(() => new RuntimeDiagnostics({ service: "test", slowThresholdMs: 86_400_001 })).toThrow(
      RangeError,
    );
    expect(() => new RuntimeDiagnostics({ service: "request body: secret" })).toThrow(TypeError);
    const f = fixture({ maxSamples: 1000 });
    for (let i = 0; i < 100; i += 1) f.diagnostics.run("work", () => f.advance(1000));
    expect(f.diagnostics.snapshot().recentSlowEvents).toHaveLength(64);
  });

  test("latest loop-delay evidence survives later operation samples evicting its ring entry", () => {
    const f = fixture({ maxSamples: 1 });
    f.diagnostics.start();
    f.advance(11_000);
    f.tick();
    f.diagnostics.run("integration_maintenance", () => f.advance(1500));
    const snapshot = f.diagnostics.snapshot();
    expect(snapshot.recentSlowEvents).toHaveLength(1);
    expect(snapshot.recentSlowEvents[0].event).toBe("runtime_slow_operation");
    expect(summarizeRuntimeDiagnostics(snapshot)).toMatchObject({
      latestEventLoopDelay: { delayMs: 10_000, observedAt: "2026-09-28T00:00:11.000Z" },
      latestSlowOperation: { stage: "integration_maintenance", durationMs: 1500 },
    });
    f.diagnostics.stop();
  });

  test("lag context includes process CPU window/RSS and at most eight fixed active labels", async () => {
    let cpu = { user: 1000, system: 2000 };
    const f = fixture({ cpuUsage: () => cpu, rssBytes: () => 64 * 1024 * 1024 });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operations = Array.from({ length: 20 }, (_, index) =>
      f.diagnostics.runAsync(
        index === 0 ? "request body: private text" : `stage${index}`,
        () => pending,
      ),
    );
    f.diagnostics.start();
    f.advance(12_000);
    cpu = { user: 251_000, system: 52_000 };
    f.tick();
    const snapshot = f.diagnostics.snapshot();
    expect(snapshot.latestEventLoopDelay?.context).toMatchObject({
      sampleElapsedMs: 12_000,
      cpuUserMs: 250,
      cpuSystemMs: 50,
      rssBytes: 64 * 1024 * 1024,
    });
    expect(snapshot.activeOperations).toHaveLength(8);
    expect(snapshot.activeOperations[0]).toEqual({ stage: "operation", elapsedMs: 12_000 });
    expect(snapshot.latestEventLoopDelay?.context?.activeOperations).toHaveLength(8);
    snapshot.latestEventLoopDelay!.context!.activeOperations![0].stage = "mutated";
    expect(
      f.diagnostics.snapshot().latestEventLoopDelay?.context?.activeOperations?.[0].stage,
    ).toBe("operation");
    expect(JSON.stringify(f.diagnostics.snapshot())).not.toContain("private text");
    finish();
    await Promise.all(operations);
    expect(f.diagnostics.snapshot().activeOperations).toEqual([]);
    f.diagnostics.stop();
  });

  test("resource counter failures cannot hide a stall or retain completed operation context", async () => {
    const unavailable = () => {
      throw new Error("private resource error");
    };
    const f = fixture({ cpuUsage: unavailable, rssBytes: unavailable });
    f.diagnostics.start();
    f.advance(3000);
    f.tick();
    expect(f.logged[0]).toMatchObject({ delayMs: 2000, context: { sampleElapsedMs: 3000 } });
    expect(f.logged[0].context?.cpuUserMs).toBeUndefined();
    expect(f.logged[0].context?.rssBytes).toBeUndefined();
    const failure = new Error("operation failed");
    await expect(
      f.diagnostics.runAsync("request", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(f.diagnostics.snapshot().activeOperations).toEqual([]);
    expect(JSON.stringify(f.logged)).not.toContain("private resource error");
    expect(f.pending.size).toBe(1);
    f.diagnostics.stop();
  });

  test("typed summaries keep only bounded allowlisted incident data from legacy history", () => {
    const oldEvent = {
      event: "runtime_event_loop_delay",
      observedAt: "2026-09-28T00:00:00.000Z",
      delayMs: 1000,
      sampleIntervalMs: 1000,
    };
    const newest = {
      ...oldEvent,
      observedAt: "2026-09-28T09:00:00.000Z",
      delayMs: 9000,
      rawError: "private error text",
      context: {
        cpuUserMs: 20,
        rssBytes: 10_000,
        cpuSystemMs: Infinity,
        environment: "private environment",
        activeOperations: Array.from({ length: 100 }, () => ({
          stage: "x".repeat(96),
          elapsedMs: 9000,
          input: "private input",
        })),
      },
    };
    const summary = summarizeRuntimeDiagnostics({
      service: "server",
      maxEventLoopDelayMs: 9000,
      lastEventLoopDelayMs: -1,
      secret: "private secret",
      recentSlowEvents: [...Array(200).fill(oldEvent), newest],
      activeOperations: [{ stage: "C:/private/path", elapsedMs: 1 }],
    });
    expect(summary?.latestEventLoopDelay).toMatchObject({
      observedAt: newest.observedAt,
      delayMs: 9000,
    });
    expect(summary?.latestEventLoopDelay?.context?.activeOperations).toHaveLength(8);
    expect(summary?.latestEventLoopDelay?.context?.cpuSystemMs).toBeUndefined();
    expect(summary?.lastEventLoopDelayMs).toBeUndefined();
    expect(summary?.activeOperations).toEqual([]);
    expect(JSON.stringify(summary).length).toBeLessThan(6000);
    expect(JSON.stringify(summary)).not.toContain("private");
    expect(summarizeRuntimeDiagnostics({ service: "request body: secret" })).toBeUndefined();
    expect(summarizeRuntimeDiagnostics(null)).toBeUndefined();
  });
});
