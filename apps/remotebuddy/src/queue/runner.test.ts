import { describe, expect, spyOn, test } from "bun:test";

import {
  QueueRunner,
  RollingLatencyMonitor,
  type QueueTelemetryEvent,
} from "./runner";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const describeEvent = (event: QueueTelemetryEvent): string => {
  if (event.type === "runner_state") return `state:${event.state}`;
  if (event.type === "job") return `job:${event.phase}`;
  return `fast_fail:${event.reason}`;
};

describe("QueueRunner telemetry handling", () => {
  test("serializes telemetry events even when async sinks reject", async () => {
    const jobQueue = [{ id: "job-1" }, { id: "job-2" }];
    const slowSinkEvents: string[] = [];
    const flakySinkEvents: string[] = [];

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      async function slowTelemetrySink(event: QueueTelemetryEvent): Promise<void> {
        await sleep(1);
        slowSinkEvents.push(describeEvent(event));
      }

      let failureInjected = false;
      async function flakyTelemetrySink(event: QueueTelemetryEvent): Promise<void> {
        flakySinkEvents.push(describeEvent(event));
        if (!failureInjected && event.type === "job" && event.phase === "success") {
          failureInjected = true;
          await sleep(0);
          throw new Error("sink failure");
        }
      }

      const runner = new QueueRunner({
        name: "telemetry-runner",
        fetchJob: async () => jobQueue.shift() ?? null,
        handleJob: async () => {
          await sleep(2);
        },
        telemetrySinks: [slowTelemetrySink, flakyTelemetrySink],
        idleBackoffMs: 0,
      });

      await runner.run({ stopOnIdle: true });

      const expectedSequence = [
        "state:fetching",
        "state:processing",
        "job:start",
        "job:success",
        "state:fetching",
        "state:processing",
        "job:start",
        "job:success",
        "state:fetching",
        "state:idle",
        "state:stopped",
      ];
      expect(slowSinkEvents).toEqual(expectedSequence);
      expect(flakySinkEvents).toEqual(expectedSequence);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("telemetry sink flakyTelemetrySink rejected");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("RollingLatencyMonitor.shouldFastFail", () => {
  test("first SLA breach at time zero bypasses cooldown, later breaches honor cooldown", () => {
    let now = 0;
    const monitor = new RollingLatencyMonitor({
      slaMs: 1_000,
      windowMs: 60_000,
      cooldownMs: 30_000,
      now: () => now,
    });

    monitor.record({ p95Ms: 1_500, timestamp: now });
    expect(monitor.shouldFastFail()).toBe(true);

    monitor.markAlertSent();
    expect(monitor.getLastAlertAt()).toBe(0);

    now = 10_000;
    monitor.record({ p95Ms: 1_500, timestamp: now });
    expect(monitor.shouldFastFail()).toBe(false);

    now = 40_000;
    monitor.record({ p95Ms: 1_500, timestamp: now });
    expect(monitor.shouldFastFail()).toBe(true);
  });
});
