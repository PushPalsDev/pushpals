import { describe, expect, test } from "bun:test";

import type { AutonomyComponentArea } from "shared";

import {
  QueueBackpressureController,
  buildQueueBacklogMetrics,
  shouldThrottleQueue,
  type QueueTelemetry,
} from "./autonomous_engine";

function makeTelemetry(overrides: Partial<QueueTelemetry> = {}): QueueTelemetry {
  return {
    capturedAt: "2026-03-06T00:00:00.000Z",
    queueP95Ms: 750,
    idleWorkers: 3,
    pendingByPriority: {
      interactive: 4,
      normal: 6,
      background: 2,
    },
    pendingSnapshot: [],
    ...overrides,
  };
}

describe("shouldThrottleQueue", () => {
  test("throttles when queue latency exceeds the threshold", () => {
    const decision = shouldThrottleQueue(makeTelemetry({ queueP95Ms: 1800 }), 1000);
    expect(decision.throttle).toBe(true);
    expect(decision.reason).toBe("queue_latency_exceeded");
    expect(decision.queueP95Ms).toBe(1800);
  });

  test("throttles when idle workers are exhausted", () => {
    const decision = shouldThrottleQueue(makeTelemetry({ idleWorkers: 0 }), 1000);
    expect(decision.throttle).toBe(true);
    expect(decision.reason).toBe("no_idle_workers");
    expect(decision.idleWorkers).toBe(0);
  });

  test("allows minting when telemetry is healthy", () => {
    const decision = shouldThrottleQueue(makeTelemetry(), 1000);
    expect(decision.throttle).toBe(false);
    expect(decision.reason).toBeNull();
    expect(decision.queueP95Ms).toBe(750);
  });

  test("fails safe when telemetry is unavailable", () => {
    const decision = shouldThrottleQueue(null, 1000);
    expect(decision.throttle).toBe(true);
    expect(decision.reason).toBe("telemetry_unavailable");
  });

  test("fails safe when telemetry is missing critical fields", () => {
    const decision = shouldThrottleQueue(
      makeTelemetry({ queueP95Ms: null, idleWorkers: null }),
      1000,
    );
    expect(decision.throttle).toBe(true);
    expect(decision.reason).toBe("telemetry_unavailable");
  });
});

describe("QueueBackpressureController", () => {
  test("requires stabilized samples before clearing backpressure", () => {
    const controller = new QueueBackpressureController({
      thresholdMs: 1000,
      recoverySamples: 2,
      recoveryDurationMs: 1_000,
    });
    const breach = controller.evaluate(makeTelemetry({ queueP95Ms: 2000 }), 0);
    expect(breach.decision.throttle).toBe(true);
    expect(breach.decision.reason).toBe("queue_latency_exceeded");

    const firstHealthy = controller.evaluate(makeTelemetry({ queueP95Ms: 800 }), 200);
    expect(firstHealthy.decision.throttle).toBe(true);
    expect(firstHealthy.decision.reason).toBe("recovery_cooldown");
    expect(firstHealthy.transition).toBeNull();

    const cleared = controller.evaluate(makeTelemetry({ queueP95Ms: 800 }), 1_300);
    expect(cleared.decision.throttle).toBe(false);
    expect(cleared.transition).toBe("cleared");
  });

  test("keeps throttling when telemetry drops during recovery", () => {
    const controller = new QueueBackpressureController({
      thresholdMs: 1000,
      recoverySamples: 2,
      recoveryDurationMs: 1_000,
    });
    const idleBreach = controller.evaluate(makeTelemetry({ idleWorkers: 0 }), 0);
    expect(idleBreach.decision.reason).toBe("no_idle_workers");

    const telemetryGap = controller.evaluate(null, 250);
    expect(telemetryGap.decision.reason).toBe("telemetry_unavailable");
    expect(telemetryGap.decision.throttle).toBe(true);

    const recoveryStart = controller.evaluate(makeTelemetry(), 600);
    expect(recoveryStart.decision.reason).toBe("recovery_cooldown");
    expect(recoveryStart.decision.throttle).toBe(true);

    const recoveryComplete = controller.evaluate(makeTelemetry(), 1_700);
    expect(recoveryComplete.decision.throttle).toBe(false);
    expect(recoveryComplete.transition).toBe("cleared");
  });

  test("fails open when telemetry is unavailable for an extended window", () => {
    const controller = new QueueBackpressureController({
      thresholdMs: 1000,
      recoverySamples: 1,
      recoveryDurationMs: 200,
      telemetryFailOpenMs: 300,
    });
    controller.evaluate(makeTelemetry({ queueP95Ms: 1500 }), 0);

    const telemetryGap = controller.evaluate(null, 150);
    expect(telemetryGap.decision.reason).toBe("telemetry_unavailable");
    expect(telemetryGap.decision.throttle).toBe(true);

    const failOpen = controller.evaluate(null, 500);
    expect(failOpen.decision.throttle).toBe(false);
    expect(failOpen.transition).toBe("cleared");

    const reengage = controller.evaluate(makeTelemetry({ queueP95Ms: 1700 }), 800);
    expect(reengage.decision.throttle).toBe(true);
    expect(reengage.decision.reason).toBe("queue_latency_exceeded");
  });
});

describe("buildQueueBacklogMetrics", () => {
  test("returns structured per-skill backlog data with complete metadata", () => {
    const backlogMetrics = buildQueueBacklogMetrics({
      telemetry: makeTelemetry({ queueP95Ms: 900, idleWorkers: 4 }),
      pendingAutonomyBySkill: {
        "apps/server": 3,
        "apps/remotebuddy": 2,
        "apps/workerpals": 1,
      } as Record<AutonomyComponentArea, number>,
      dispatchByComponent: {
        "apps/server": 5,
        "apps/workerpals": 1,
      },
      targetSkill: "apps/remotebuddy" as AutonomyComponentArea,
      pendingAutonomySampleLimit: 500,
      pendingAutonomySampleSize: 6,
      pendingAutonomySampleTruncated: true,
    });
    expect(backlogMetrics).not.toBeNull();
    expect(backlogMetrics?.skills.length).toBeGreaterThanOrEqual(8);
    const pendingTotal =
      backlogMetrics?.skills.reduce((sum, row) => sum + row.pending_autonomy_requests, 0) ?? 0;
    expect(pendingTotal).toBe(6);
    const ratioSum =
      backlogMetrics?.skills.reduce((sum, row) => sum + row.backlog_ratio, 0) ?? 0;
    expect(ratioSum).toBeCloseTo(1, 5);
    const targetSkill = backlogMetrics?.skills.find((row) => row.skill === "apps/remotebuddy");
    expect(targetSkill?.is_target_skill).toBe(true);
    expect(targetSkill?.pending_autonomy_requests).toBe(2);
    expect(backlogMetrics?.pending_autonomy_sample_limit).toBe(500);
    expect(backlogMetrics?.pending_autonomy_sample_size).toBe(6);
    expect(backlogMetrics?.pending_autonomy_sample_truncated).toBe(true);
  });
});
