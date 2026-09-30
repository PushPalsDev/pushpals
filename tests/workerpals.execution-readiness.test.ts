import { describe, expect, test } from "bun:test";
import {
  WorkerExecutionReadinessGate,
  checkWorkerExecutionReadiness,
  shouldUseLegacyWorkerCooldown,
} from "../apps/workerpals/src/execution_readiness";

describe("WorkerPal execution readiness admission", () => {
  test("blocked Docker cooldowns keep live heartbeats instead of legacy offline sleeps", () => {
    const gate = new WorkerExecutionReadinessGate({
      probe: async () => {},
      classifyFailure: () => ({ failureClass: "docker_engine", retryable: true }),
    });
    expect(shouldUseLegacyWorkerCooldown(20_000)).toBe(true);
    expect(shouldUseLegacyWorkerCooldown(20_000, gate.details())).toBe(true);
    gate.block(new Error("Docker is unavailable"));
    expect(shouldUseLegacyWorkerCooldown(20_000, gate.details())).toBe(false);
    expect(gate.details().executionReady).toBe(false);
    expect(shouldUseLegacyWorkerCooldown(undefined)).toBe(false);
  });
  test("does not advertise or claim capacity before the shared probe succeeds", async () => {
    let release!: () => void;
    const gate = new WorkerExecutionReadinessGate({
      probe: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      classifyFailure: () => ({ failureClass: "docker_engine", retryable: true }),
    });
    const observations: boolean[] = [];
    let claims = 0;
    const check = checkWorkerExecutionReadiness(
      gate,
      async () => {
        observations.push(gate.details().executionReady);
      },
      1_000,
    ).then((ready) => {
      if (ready) claims += 1;
    });
    await Promise.resolve();
    expect(gate.details().executionReadiness.status).toBe("checking");
    expect(claims).toBe(0);
    release();
    await check;
    expect(observations).toEqual([false, true]);
    expect(claims).toBe(1);
  });

  test("blocks claims, backs off bounded probes, and recovers after infrastructure repair", async () => {
    let now = 100_000;
    let healthy = false;
    let probes = 0;
    const gate = new WorkerExecutionReadinessGate({
      now: () => now,
      probe: async () => {
        probes += 1;
        if (!healthy) throw new Error("Docker API 500");
      },
      classifyFailure: () => ({ failureClass: "docker_engine", retryable: true }),
    });
    expect(await gate.ensureReady()).toBe(false);
    expect(gate.details()).toMatchObject({
      executionReady: false,
      executionReadiness: {
        status: "blocked",
        failureClass: "docker_engine",
        retryAt: new Date(120_000).toISOString(),
      },
    });
    expect(await gate.ensureReady()).toBe(false);
    expect(probes).toBe(1);
    now = 120_000;
    expect(await gate.ensureReady()).toBe(false);
    expect(gate.details().executionReadiness.retryAt).toBe(new Date(160_000).toISOString());
    healthy = true;
    now = 160_000;
    expect(await gate.ensureReady()).toBe(true);
    expect(probes).toBe(3);
    expect(gate.details().executionReadiness.failureClass).toBeNull();
  });

  test("permanent configuration failures do not get immediate retries", async () => {
    let now = 0;
    let probes = 0;
    const gate = new WorkerExecutionReadinessGate({
      now: () => now,
      probe: async () => {
        probes += 1;
        throw new Error("permission denied");
      },
      classifyFailure: () => ({ failureClass: "docker_engine", retryable: false }),
    });
    expect(await gate.ensureReady()).toBe(false);
    now = 299_999;
    expect(await gate.ensureReady()).toBe(false);
    expect(probes).toBe(1);
    now = 300_000;
    expect(await gate.ensureReady()).toBe(false);
    expect(probes).toBe(2);
  });

  test("positive evidence expires and every failed job invalidates it", async () => {
    let now = 0;
    let probes = 0;
    const gate = new WorkerExecutionReadinessGate({
      now: () => now,
      probe: async () => {
        probes += 1;
      },
      classifyFailure: () => ({ failureClass: "docker_engine", retryable: true }),
    });
    expect(await gate.ensureReady()).toBe(true);
    now = 29_999;
    expect(await gate.ensureReady()).toBe(true);
    expect(probes).toBe(1);
    now = 30_000;
    expect(await gate.ensureReady()).toBe(true);
    gate.invalidate();
    expect(gate.details().executionReady).toBe(false);
    expect(await gate.ensureReady()).toBe(true);
    expect(probes).toBe(3);
    gate.block(new Error("Docker went away"));
    gate.invalidate();
    expect(await gate.ensureReady()).toBe(false);
    expect(probes).toBe(3);
  });

  test("coalesces probes and cannot resurrect readiness invalidated while a probe runs", async () => {
    let release!: () => void;
    let probes = 0;
    const gate = new WorkerExecutionReadinessGate({
      probe: () => {
        probes += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      classifyFailure: () => ({ failureClass: "docker_engine", retryable: true }),
    });
    const first = gate.ensureReady();
    const second = gate.ensureReady();
    await Promise.resolve();
    expect(probes).toBe(1);
    gate.invalidate();
    release();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(gate.details().executionReady).toBe(false);
  });

  test("keeps failed-probe heartbeats alive without granting claims", async () => {
    const gate = new WorkerExecutionReadinessGate({
      probe: async () => {
        throw new Error("Docker API 500");
      },
      classifyFailure: () => ({ failureClass: "docker_engine", retryable: true }),
    });
    const statuses: string[] = [];
    const ready = await checkWorkerExecutionReadiness(
      gate,
      async () => {
        statuses.push(gate.details().executionReadiness.status);
      },
      1_000,
    );
    expect(ready).toBe(false);
    expect(statuses).toEqual(["checking", "blocked"]);
  });
});
