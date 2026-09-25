import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  resolveStartupWorkerExecutionReadiness,
  resolveWorkerExecutionReadiness,
  waitForWorkerpalCapacity,
} from "../scripts/pushpals-cli.ts";

const worker = (activeJobCount = 0) => ({
  workerId: "workerpal-readiness-test",
  status: "online",
  isOnline: true,
  activeJobCount,
});

function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    nowFn: () => now,
    advance: (durationMs: number) => {
      now += durationMs;
    },
    sleepFn: async (durationMs: number) => {
      sleeps.push(durationMs);
      now += durationMs;
    },
    sleeps,
  };
}

const startupDefaults = {
  serverUrl: "http://127.0.0.1:3001",
  ttlMs: 60_000,
  timeoutMs: 1_000,
  autoSpawnWorkerpals: true,
  requireDocker: false,
};

describe("WorkerPal startup readiness deadlines", () => {
  test("does not sleep after the final fetch consumes the complete budget", async () => {
    const clock = fakeClock();
    const timeouts: number[] = [];
    const result = await waitForWorkerpalCapacity({
      ...startupDefaults,
      ...clock,
      fetchWorkersFn: async (_url, _ttl, timeoutMs) => {
        timeouts.push(timeoutMs!);
        clock.advance(timeoutMs!);
        return [];
      },
    });

    expect(result.ok).toBe(false);
    expect(timeouts).toEqual([1_000]);
    expect(clock.sleeps).toEqual([]);
    expect(clock.nowFn()).toBe(1_000);
  });

  test("clamps the final sleep to the remaining budget", async () => {
    const clock = fakeClock();
    let queries = 0;
    const result = await waitForWorkerpalCapacity({
      ...startupDefaults,
      ...clock,
      fetchWorkersFn: async () => {
        queries += 1;
        clock.advance(999);
        return [];
      },
    });

    expect(result.ok).toBe(false);
    expect(queries).toBe(1);
    expect(clock.sleeps).toEqual([1]);
    expect(clock.nowFn()).toBe(1_000);
  });

  test("does not accept capacity returned after the foreground deadline", async () => {
    const clock = fakeClock();
    const result = await waitForWorkerpalCapacity({
      ...startupDefaults,
      ...clock,
      fetchWorkersFn: async () => {
        clock.advance(1_001);
        return [worker()];
      },
    });

    expect(result.ok).toBe(false);
    expect(clock.sleeps).toEqual([]);
  });

  test("never rounds a final fetch allowance up beyond the remaining deadline", async () => {
    const clock = fakeClock();
    const timeouts: number[] = [];
    const result = await waitForWorkerpalCapacity({
      ...startupDefaults,
      timeoutMs: 2_100,
      nowFn: clock.nowFn,
      sleepFn: async (durationMs) => {
        await clock.sleepFn(durationMs);
        // Simulate scheduler delay before the final poll without changing Date.now globally.
        if (timeouts.length === 1) clock.advance(1_000);
      },
      fetchWorkersFn: async (_url, _ttl, timeoutMs) => {
        timeouts.push(timeoutMs!);
        if (timeouts.length > 1) clock.advance(timeoutMs!);
        return [];
      },
    });

    expect(result.ok).toBe(false);
    expect(timeouts).toEqual([2_000, 100]);
    expect(clock.sleeps).toEqual([1_000]);
    expect(clock.nowFn()).toBe(2_100);
  });

  test.each([NaN, Infinity, -Infinity])(
    "uses a finite default budget for timeout %s",
    async (timeoutMs) => {
      const clock = fakeClock();
      let queries = 0;
      const result = await waitForWorkerpalCapacity({
        ...startupDefaults,
        ...clock,
        timeoutMs,
        fetchWorkersFn: async () => {
          queries += 1;
          return [];
        },
      });

      expect(result.ok).toBe(false);
      expect(queries).toBe(5);
      expect(clock.nowFn()).toBe(5_000);
      expect(clock.sleeps.every((durationMs) => Number.isFinite(durationMs))).toBe(true);
    },
  );

  test.each([0, -10, 100])("floors finite timeout %s to one second", async (timeoutMs) => {
    const clock = fakeClock();
    let queries = 0;
    await waitForWorkerpalCapacity({
      ...startupDefaults,
      ...clock,
      timeoutMs,
      fetchWorkersFn: async () => {
        queries += 1;
        return [];
      },
    });

    expect(queries).toBe(1);
    expect(clock.nowFn()).toBe(1_000);
  });

  test("recovers from a transient status failure inside the original deadline", async () => {
    const clock = fakeClock();
    let queries = 0;
    const result = await waitForWorkerpalCapacity({
      ...startupDefaults,
      ...clock,
      timeoutMs: 2_000,
      fetchWorkersFn: async () => {
        queries += 1;
        if (queries === 1) throw new Error("temporary connection failure");
        return [worker()];
      },
    });

    expect(result).toEqual({ ok: true, detail: "1 idle / 1 online" });
    expect(queries).toBe(2);
    expect(clock.sleeps).toEqual([1_000]);
  });

  test("a valid empty response clears a previous unavailable-status result", async () => {
    const clock = fakeClock();
    let queries = 0;
    const result = await waitForWorkerpalCapacity({
      ...startupDefaults,
      ...clock,
      timeoutMs: 2_000,
      fetchWorkersFn: async () => {
        queries += 1;
        if (queries === 1) throw new Error("temporary connection failure");
        return [];
      },
    });

    expect(result.ok).toBe(false);
    expect(result.statusUnavailable).not.toBe(true);
    expect(queries).toBe(2);
    expect(clock.nowFn()).toBe(2_000);
  });

  test("the final failed query is unavailable even after an earlier healthy empty snapshot", async () => {
    const clock = fakeClock();
    let queries = 0;
    const result = await waitForWorkerpalCapacity({
      ...startupDefaults,
      ...clock,
      timeoutMs: 2_000,
      fetchWorkersFn: async () => {
        queries += 1;
        if (queries === 2) throw new Error("connection failed");
        return [];
      },
    });

    expect(result.ok).toBe(false);
    expect(result.statusUnavailable).toBe(true);
    expect(queries).toBe(2);
    expect(clock.nowFn()).toBe(2_000);
  });
});

describe("WorkerPal startup readiness semantics", () => {
  test.each([
    { name: "idle", workers: [worker()], state: "ready", detail: "1 idle / 1 online" },
    { name: "busy", workers: [worker(1)], state: "warming", detail: "0 idle / 1 online" },
    { name: "missing", workers: [], state: "blocked", detail: "auto-spawn is disabled" },
  ])("queries manually managed workers once: $name", async ({ workers, state, detail }) => {
    const clock = fakeClock();
    const timeouts: number[] = [];
    const result = await resolveStartupWorkerExecutionReadiness({
      ...startupDefaults,
      ...clock,
      autoSpawnWorkerpals: false,
      fetchWorkersFn: async (_url, _ttl, timeoutMs) => {
        timeouts.push(timeoutMs!);
        return workers;
      },
    });

    expect(result.state).toBe(state);
    expect(result.detail).toContain(detail);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(1_000);
    expect(clock.sleeps).toEqual([]);
  });

  test("valid empty auto-spawn snapshots report warming without implying a service failure", async () => {
    const clock = fakeClock();
    const result = await resolveStartupWorkerExecutionReadiness({
      ...startupDefaults,
      ...clock,
      fetchWorkersFn: async () => [],
    });

    expect(result.state).toBe("warming");
    expect(clock.nowFn()).toBe(1_000);
  });

  test.each([true, false])(
    "status failures report blocked with auto-spawn=%s",
    async (autoSpawnWorkerpals) => {
      const clock = fakeClock();
      let queries = 0;
      const result = await resolveStartupWorkerExecutionReadiness({
        ...startupDefaults,
        ...clock,
        autoSpawnWorkerpals,
        fetchWorkersFn: async () => {
          queries += 1;
          throw new Error("test status unavailable");
        },
      });

      expect(result.state).toBe("blocked");
      expect(result.detail).toContain("test status unavailable");
      expect(queries).toBe(1);
      expect(clock.nowFn()).toBeLessThanOrEqual(1_000);
    },
  );

  test("required Docker failure remains blocked when no workers are online", async () => {
    const clock = fakeClock();
    const result = await resolveStartupWorkerExecutionReadiness({
      ...startupDefaults,
      ...clock,
      requireDocker: true,
      dockerPrecheck: { status: "failed", detail: "Docker unavailable", env: {} },
      fetchWorkersFn: async () => [],
    });

    expect(result.state).toBe("blocked");
    expect(result.detail).toContain("Docker unavailable");
  });

  test("an idle worker remains usable even when an earlier Docker precheck failed", async () => {
    const clock = fakeClock();
    const result = await resolveStartupWorkerExecutionReadiness({
      ...startupDefaults,
      ...clock,
      requireDocker: true,
      dockerPrecheck: { status: "failed", detail: "Docker unavailable", env: {} },
      fetchWorkersFn: async () => [worker()],
    });

    expect(result.state).toBe("ready");
    expect(clock.sleeps).toEqual([]);
  });
});

describe("WorkerPal readiness HTTP contract", () => {
  const privateBody = "DO_NOT_ECHO_PRIVATE_RESPONSE";
  const invalidResponses = [
    { name: "HTTP failure", status: 503, body: privateBody },
    { name: "invalid JSON", status: 200, body: privateBody },
    { name: "unsuccessful payload", status: 200, body: JSON.stringify({ ok: false, workers: [] }) },
    { name: "missing workers", status: 200, body: JSON.stringify({ ok: true }) },
    { name: "wrong workers shape", status: 200, body: JSON.stringify({ ok: true, workers: {} }) },
    { name: "null worker", status: 200, body: JSON.stringify({ ok: true, workers: [null] }) },
    {
      name: "wrong worker identifier",
      status: 200,
      body: JSON.stringify({ ok: true, workers: [{ ...worker(), workerId: 7 }] }),
    },
    {
      name: "non-boolean online flag",
      status: 200,
      body: JSON.stringify({ ok: true, workers: [{ ...worker(), isOnline: "true" }] }),
    },
    {
      name: "negative active jobs",
      status: 200,
      body: JSON.stringify({ ok: true, workers: [{ ...worker(), activeJobCount: -1 }] }),
    },
    {
      name: "fractional active jobs",
      status: 200,
      body: JSON.stringify({ ok: true, workers: [{ ...worker(), activeJobCount: 0.5 }] }),
    },
    {
      name: "blank worker status",
      status: 200,
      body: JSON.stringify({ ok: true, workers: [{ ...worker(), status: " " }] }),
    },
    {
      name: "non-object worker",
      status: 200,
      body: JSON.stringify({ ok: true, workers: ["worker"] }),
    },
  ];

  test.each(invalidResponses)(
    "rejects $name without exposing response content",
    async ({ status, body }) => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(body, { status }),
      });
      try {
        const serverUrl = `http://127.0.0.1:${server.port}`;
        const startup = await resolveStartupWorkerExecutionReadiness({
          ...startupDefaults,
          serverUrl,
          autoSpawnWorkerpals: false,
        });
        const statusResult = await resolveWorkerExecutionReadiness({
          serverUrl,
          ttlMs: startupDefaults.ttlMs,
          autoSpawnWorkerpals: true,
          dockerEnabled: false,
          requireDocker: false,
        });

        expect(startup.state).toBe("blocked");
        expect(statusResult.state).toBe("blocked");
        expect(startup.detail).not.toContain(privateBody);
        expect(statusResult.detail).not.toContain(privateBody);
      } finally {
        server.stop(true);
      }
    },
  );

  test("actual HTTP failure is blocked in the auto-spawn path without stopping startup", async () => {
    let queries = 0;
    const clock = fakeClock();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        queries += 1;
        return new Response(privateBody, { status: 503 });
      },
    });
    try {
      const result = await resolveStartupWorkerExecutionReadiness({
        ...startupDefaults,
        ...clock,
        serverUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(result.state).toBe("blocked");
      expect(result.detail).toContain("503");
      expect(result.detail).not.toContain(privateBody);
      expect(queries).toBe(1);
      expect(clock.nowFn()).toBe(1_000);
    } finally {
      server.stop(true);
    }
  });

  test.each([
    { name: "empty", workers: [], state: "warming" },
    { name: "idle", workers: [worker()], state: "ready" },
    { name: "busy", workers: [worker(1)], state: "warming" },
  ])("accepts an actual $name worker response", async ({ workers, state }) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ok: true, workers }),
    });
    try {
      const result = await resolveWorkerExecutionReadiness({
        serverUrl: `http://127.0.0.1:${server.port}`,
        ttlMs: startupDefaults.ttlMs,
        autoSpawnWorkerpals: true,
        dockerEnabled: false,
        requireDocker: false,
      });
      expect(result.state).toBe(state);
    } finally {
      server.stop(true);
    }
  });
});

describe("CLI readiness integration wiring", () => {
  test("embedded service startup does not wait for WorkerPal capacity before launching SCM", () => {
    const source = readFileSync(new URL("../scripts/pushpals-cli.ts", import.meta.url), "utf8");
    const begin = source.indexOf("async function autoStartRuntimeServices(");
    const end = source.indexOf("async function looksLikeMonitoringHub(", begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const embeddedStartup = source.slice(begin, end);
    expect(embeddedStartup).not.toContain("waitForWorkerpalCapacity(");
    expect(embeddedStartup).toContain('launchService("source_control_manager"');
  });

  test("main uses one startup readiness resolver instead of an additional capacity wait", () => {
    const source = readFileSync(new URL("../scripts/pushpals-cli.ts", import.meta.url), "utf8");
    const begin = source.indexOf("async function main():");
    expect(begin).toBeGreaterThanOrEqual(0);
    const main = source.slice(begin);
    expect(main.match(/resolveStartupWorkerExecutionReadiness\(/g) ?? []).toHaveLength(1);
    expect(main).not.toContain("waitForWorkerpalCapacity(");
  });
});
