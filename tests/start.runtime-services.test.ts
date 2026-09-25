import { describe, expect, test } from "bun:test";
import {
  ServiceManager,
  buildWindowsManagedServiceTreeTerminationArgv,
  buildCoreManagedServiceSpecs,
  computeLocalBuddyRestartBackoffMs,
  defaultProbeServiceHealth,
  pipeProcessStreamToLines,
  resolveLocalBuddyRuntimeAction,
  resolveLocalBuddyStartGate,
  shouldDetachManagedServiceProcess,
  shouldTerminateAfterHealthFailure,
  type ManagedServiceHealthResult,
  type ManagedServiceLifecycleEvent,
} from "../scripts/start_runtime_services";
import { SCM_REPAIR_AUTHORITY_SECRET_ENV } from "../packages/shared/src/scm_repair_authority";
import { createServer, type Socket } from "node:net";

describe("start runtime service helpers", () => {
  test("health probes bypass a silent pooled socket without weakening the deadline", async () => {
    const sockets = new Set<Socket>();
    let connections = 0;
    const listener = createServer((socket) => {
      sockets.add(socket);
      connections += 1;
      let requests = 0;
      socket.on("data", () => {
        requests += 1;
        // A new connection is healthy; a reused one simulates a half-open peer.
        if (requests === 1)
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok");
      });
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("TCP fixture has no port");
    const url = `http://127.0.0.1:${address.port}/health`;
    try {
      await (await fetch(url)).text();
      await Bun.sleep(10);
      expect(connections).toBe(1);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const health = await defaultProbeServiceHealth({ url, timeoutMs: 250 });
        expect(health.ok).toBe(true);
        expect(health.responseStatus).toBe(200);
      }
      expect(connections).toBe(4);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 5_000);
  test("caps no-newline managed service output while continuing to drain", async () => {
    const lines: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(70_000)));
        controller.enqueue(new TextEncoder().encode("tail\n"));
        controller.close();
      },
    });
    const pipe = pipeProcessStreamToLines(stream, (line) => lines.push(line));
    await pipe.done;

    expect(lines).toContain("[pushpals: managed service output line truncated]");
    expect(lines.at(-1)).toBe("tail");
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(64 * 1024);
  });

  test("health probes time out when response bodies never finish", async () => {
    let bodyCancelled = false;
    const startedAt = Date.now();
    const health = await defaultProbeServiceHealth(
      { url: "http://127.0.0.1/stalled", timeoutMs: 25 },
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {},
            cancel() {
              bodyCancelled = true;
            },
          }),
        ),
    );

    await Bun.sleep(0);
    expect(health.ok).toBe(false);
    expect(health.failureKind).toBe("transport_error");
    expect(health.detail).toContain("timed out after 250ms");
    expect(bodyCancelled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("explicit unhealthy responses stay distinct from transport timeouts", async () => {
    const health = await defaultProbeServiceHealth(
      { url: "http://127.0.0.1/unhealthy" },
      async () => Response.json({ healthy: false, reason: "tick stalled" }, { status: 503 }),
    );
    expect(health.failureKind).toBe("unhealthy_response");
    expect(health.responseStatus).toBe(503);
    expect(health.ok).toBe(false);
  });

  test("three brief transport timeouts cannot kill validation, but sustained failure remains bounded", () => {
    const failure = {
      failureKind: "transport_error" as const,
      consecutiveFailures: 3,
      unhealthyThreshold: 3,
      failureDurationMs: 10_000,
    };
    expect(shouldTerminateAfterHealthFailure(failure)).toBe(false);
    expect(shouldTerminateAfterHealthFailure({ ...failure, failureDurationMs: 59_999 })).toBe(
      false,
    );
    expect(shouldTerminateAfterHealthFailure({ ...failure, failureDurationMs: 60_000 })).toBe(true);
    expect(
      shouldTerminateAfterHealthFailure({ ...failure, failureKind: "unhealthy_response" }),
    ).toBe(true);
    expect(
      shouldTerminateAfterHealthFailure({
        ...failure,
        consecutiveFailures: 2,
        failureDurationMs: 90_000,
      }),
    ).toBe(false);
  });

  test("cold-start refusals report starting then ready, but failures after readiness are degraded immediately", async () => {
    let now = 1_000;
    let health: ManagedServiceHealthResult = {
      ok: false,
      detail: "connection refused",
      failureKind: "transport_error",
    };
    const events: ManagedServiceLifecycleEvent[] = [];
    const logs: { level: string; line: string }[] = [];
    const healthChanges: unknown[] = [];
    let terminations = 0;
    const manager = new ServiceManager({
      now: () => now,
      pollMs: 1_000_000,
      probeServiceHealth: async () => health,
      onLifecycleEvent: (event) => events.push(event),
      onHealthChange: (health) => healthChanges.push(health),
      onEvent: (level, line) => logs.push({ level, line }),
      spawnService: (spec) => ({
        name: spec.name,
        proc: { kill() {} } as any,
        command: spec.command,
        cwd: spec.cwd,
        env: {},
        exited: false,
        exitCode: null,
        launchedAtMs: now,
      }),
      terminateService: async () => {
        terminations += 1;
      },
    });
    const tick = async (at: number) => {
      now = at;
      (manager as any).tick();
      await Bun.sleep(0);
    };
    try {
      manager.startService({
        name: "service",
        color: "",
        command: ["fake"],
        cwd: process.cwd(),
        healthCheck: { url: "http://127.0.0.1/health", intervalMs: 50 },
      });
      await tick(1_000);
      await tick(1_050);
      await tick(1_100);
      expect(manager.getHealth()).toBeNull();
      expect(healthChanges).toEqual([]);
      expect(events).toHaveLength(3);
      expect(events.every((event) => event.type === "health" && event.phase === "starting")).toBe(
        true,
      );
      expect(logs.every(({ level, line }) => level === "log" && line.includes("is starting"))).toBe(
        true,
      );
      health = { ok: true, detail: "healthy", responseStatus: 200 };
      await tick(1_150);
      expect(manager.getHealth()).toBeNull();
      expect(events.at(-1)).toMatchObject({ type: "health", healthy: true, phase: "ready" });
      expect(events.some((event) => event.type === "recovered")).toBe(false);
      expect(logs.at(-1)?.line).toContain("is ready");
      expect(healthChanges).toEqual([]);

      health = { ok: false, detail: "connection refused", failureKind: "transport_error" };
      await tick(1_200);
      expect(manager.getHealth()?.state).toBe("degraded");
      expect(healthChanges).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "health", healthy: false, phase: "degraded" });
      expect(terminations).toBe(0);
    } finally {
      manager.stop();
    }
  });

  test.each(
    [undefined, NaN, Infinity, -Infinity].flatMap((transportFailureGraceMs) =>
      [false, true].map((restartOnFailure) => ({ restartOnFailure, transportFailureGraceMs })),
    ),
  )(
    "cold-start health reporting stays bounded (restart=$restartOnFailure, grace=$transportFailureGraceMs)",
    async ({ restartOnFailure, transportFailureGraceMs }) => {
      let now = 1_000;
      let terminations = 0;
      const events: ManagedServiceLifecycleEvent[] = [];
      const manager = new ServiceManager({
        now: () => now,
        pollMs: 1_000_000,
        probeServiceHealth: async () => ({
          ok: false,
          detail: "connection refused",
          failureKind: "transport_error",
        }),
        onLifecycleEvent: (event) => events.push(event),
        spawnService: (spec) => ({
          name: spec.name,
          proc: { kill() {} } as any,
          command: spec.command,
          cwd: spec.cwd,
          env: {},
          exited: false,
          exitCode: null,
          launchedAtMs: now,
        }),
        terminateService: async (service) => {
          terminations += 1;
          service.exited = true;
          service.exitCode = 1;
        },
      });
      const tick = async (at: number) => {
        now = at;
        (manager as any).tick();
        await Bun.sleep(0);
      };
      try {
        manager.startService({
          name: "service",
          color: "",
          command: ["fake"],
          cwd: process.cwd(),
          healthCheck: {
            url: "http://127.0.0.1/health",
            intervalMs: 50,
            restartOnFailure,
            transportFailureGraceMs,
          },
        });
        // Reporting is bounded from launch, even if the first probe was delayed.
        await tick(2_000);
        await tick(60_000);
        await tick(60_950);
        expect(manager.getHealth()).toBeNull();
        expect(events.at(-1)).toMatchObject({ phase: "starting", consecutiveFailures: 3 });
        await tick(61_000);
        expect(manager.getHealth()?.state).toBe("degraded");
        expect(events.at(-1)).toMatchObject({ phase: "degraded", consecutiveFailures: 4 });
        expect(terminations).toBe(0);
        // The existing sustained-outage clock still starts at the first failed probe.
        await tick(62_000);
        expect(terminations).toBe(restartOnFailure ? 1 : 0);
        expect(events.at(-1)).toMatchObject({
          phase: "degraded",
          consecutiveFailures: 5,
          failureDurationMs: 60_000,
        });
      } finally {
        manager.stop();
      }
    },
  );

  test("cold-start crashes remain degraded through restart until health confirms recovery", async () => {
    let now = 1_000;
    let spawns = 0;
    let health: ManagedServiceHealthResult = {
      ok: false,
      detail: "connection refused",
      failureKind: "transport_error",
    };
    const events: ManagedServiceLifecycleEvent[] = [];
    const manager = new ServiceManager({
      now: () => now,
      pollMs: 1_000_000,
      computeRestartBackoffMs: () => 1,
      probeServiceHealth: async () => health,
      onLifecycleEvent: (event) => events.push(event),
      spawnService: (spec) => ({
        name: spec.name,
        proc: { kill() {} } as any,
        command: spec.command,
        cwd: spec.cwd,
        env: {},
        exited: ++spawns === 1,
        exitCode: spawns === 1 ? 1 : null,
        launchedAtMs: now,
      }),
    });
    try {
      manager.startService({
        name: "service",
        color: "",
        command: ["fake"],
        cwd: process.cwd(),
        healthCheck: { url: "http://127.0.0.1/health", intervalMs: 50 },
      });
      (manager as any).tick();
      expect(manager.getHealth()?.state).toBe("degraded");
      expect(events.at(-1)).toMatchObject({ type: "exit", exitCause: "unexpected_exit" });
      await Bun.sleep(5);
      expect(spawns).toBe(2);
      now = 1_050;
      (manager as any).tick();
      await Bun.sleep(0);
      expect(manager.getHealth()?.state).toBe("degraded");
      expect(events.at(-1)).toMatchObject({ type: "health", healthy: false, phase: "degraded" });
      expect(events.some((event) => event.type === "recovered")).toBe(false);
      health = { ok: true, detail: "healthy", responseStatus: 200 };
      now = 1_100;
      (manager as any).tick();
      await Bun.sleep(0);
      expect(manager.getHealth()).toBeNull();
      expect(events.at(-1)).toMatchObject({ type: "recovered", confirmation: "health_probe" });
      expect(events.some((event) => event.type === "health" && event.phase === "ready")).toBe(
        false,
      );
    } finally {
      manager.stop();
    }
  });

  test("shared transport outage is visible, recovers without kills, and a later sustained SCM outage restarts only SCM", async () => {
    let now = 0;
    let health: ManagedServiceHealthResult = { ok: true, detail: "healthy", responseStatus: 200 };
    const terminated: string[] = [];
    const events: ManagedServiceLifecycleEvent[] = [];
    const manager = new ServiceManager({
      now: () => now,
      pollMs: 1_000_000,
      computeRestartBackoffMs: () => 1,
      probeServiceHealth: async () => health,
      onLifecycleEvent: (event) => events.push(event),
      spawnService: (spec) => ({
        name: spec.name,
        proc: { kill() {} } as any,
        command: spec.command,
        cwd: spec.cwd,
        env: {},
        exited: false,
        exitCode: null,
        launchedAtMs: now,
      }),
      terminateService: async (service) => {
        terminated.push(service.name);
        service.exited = true;
        service.exitCode = 1;
      },
      // A prior native signature must not open the crash circuit for health-directed kills.
      resolveExitFingerprint: () => {
        throw new Error("must not fingerprint a health-directed kill");
      },
    });
    const tick = async (at: number) => {
      now = at;
      (manager as any).tick();
      await Bun.sleep(0);
    };
    try {
      for (const name of ["server", "source_control_manager"])
        manager.startService({
          name,
          color: "",
          command: ["fake"],
          cwd: process.cwd(),
          healthCheck: {
            url: `http://127.0.0.1/${name}`,
            intervalMs: 50,
            restartOnFailure: name !== "server",
          },
        });
      await tick(0);
      health = { ok: false, detail: "HTTP timeout", failureKind: "transport_error" };
      await tick(1_000);
      await tick(6_000);
      await tick(11_000);
      expect(terminated).toEqual([]);
      expect(manager.getHealth()?.detail).toContain("server");
      expect(manager.getHealth()?.detail).toContain("source_control_manager");
      health = { ok: true, detail: "healthy", responseStatus: 200 };
      await tick(16_000);
      expect(manager.getHealth()).toBeNull();

      health = { ok: false, detail: "HTTP timeout", failureKind: "transport_error" };
      await tick(20_000);
      await tick(50_000);
      await tick(79_999);
      expect(terminated).toEqual([]);
      await tick(80_100);
      expect(terminated).toEqual(["source_control_manager"]);
      await tick(80_200);
      await Bun.sleep(5);
      expect(events.filter((event) => event.type === "restarted")).toHaveLength(1);
      expect(events.filter((event) => event.type === "recovered")).toHaveLength(0);
      const exit = events.find((event) => event.type === "exit");
      expect(exit?.type === "exit" && exit.exitCause).toBe("health_termination");
      expect(manager.getHealth()).not.toBeNull();
      health = { ok: true, detail: "healthy", responseStatus: 200 };
      await tick(85_000);
      expect(events.filter((event) => event.type === "recovered")).toEqual([
        expect.objectContaining({
          service: "source_control_manager",
          confirmation: "health_probe",
          observedAt: new Date(85_000).toISOString(),
        }),
      ]);
      expect(manager.getHealth()).toBeNull();
      expect(terminated).toEqual(["source_control_manager"]);
    } finally {
      manager.stop();
    }
  });

  test("alternating HTTP errors and timeouts cannot reset the sustained-outage deadline", async () => {
    let now = 1_000;
    let probes = 0;
    let terminations = 0;
    const manager = new ServiceManager({
      now: () => now,
      pollMs: 1_000_000,
      probeServiceHealth: async () => ({
        ok: false,
        detail: "unavailable",
        failureKind: ++probes % 2 ? "unhealthy_response" : "transport_error",
      }),
      spawnService: (spec) => ({
        name: spec.name,
        proc: { kill() {} } as any,
        command: spec.command,
        cwd: spec.cwd,
        env: {},
        exited: false,
        exitCode: null,
        launchedAtMs: now,
      }),
      terminateService: async (service) => {
        terminations += 1;
        service.exited = true;
        service.exitCode = 1;
      },
    });
    const tick = async (at: number) => {
      now = at;
      (manager as any).tick();
      await Bun.sleep(0);
    };
    try {
      manager.startService({
        name: "scm",
        color: "",
        command: ["fake"],
        cwd: process.cwd(),
        healthCheck: { url: "http://127.0.0.1/health", intervalMs: 50, unhealthyThreshold: 3 },
      });
      await tick(1_000);
      await tick(20_000);
      await tick(40_000);
      expect(terminations).toBe(0); // No three consecutive explicit unhealthy responses.
      await tick(61_000);
      expect(terminations).toBe(1); // Continuous outage still reached its 60-second bound.
    } finally {
      manager.stop();
    }
  });

  test("best-effort termination without process exit is bounded and retried instead of latching forever", async () => {
    let now = 1_000;
    let terminations = 0;
    const logs: string[] = [];
    const manager = new ServiceManager({
      now: () => now,
      pollMs: 1_000_000,
      terminationExitConfirmationMs: 5,
      probeServiceHealth: async () => ({
        ok: false,
        detail: "tick stalled",
        failureKind: "unhealthy_response",
      }),
      onEvent: (_level, line) => logs.push(line),
      spawnService: (spec) => ({
        name: spec.name,
        proc: { kill() {}, exited: new Promise<number>(() => {}) } as any,
        command: spec.command,
        cwd: spec.cwd,
        env: {},
        exited: false,
        exitCode: null,
        launchedAtMs: now,
      }),
      terminateService: async (service) => {
        terminations += 1;
        if (terminations === 2) {
          service.exited = true;
          service.exitCode = 1;
        }
      },
    });
    try {
      manager.startService({
        name: "scm",
        color: "",
        command: ["fake"],
        cwd: process.cwd(),
        healthCheck: { url: "http://127.0.0.1/health", intervalMs: 50, unhealthyThreshold: 1 },
      });
      (manager as any).tick();
      await Bun.sleep(15);
      expect(terminations).toBe(1);
      expect(manager.getHealth()?.state).toBe("degraded");
      expect(manager.getService("scm")?.exited).toBe(false);
      expect(logs.some((line) => line.includes("without confirmed process exit"))).toBe(true);
      now = 2_000;
      (manager as any).tick();
      await Bun.sleep(0);
      expect(terminations).toBe(2);
      expect(manager.getService("scm")?.exited).toBe(true);
    } finally {
      manager.stop();
    }
  });

  test("builds forced Windows process-tree termination for unhealthy services", () => {
    expect(buildWindowsManagedServiceTreeTerminationArgv(7654)).toEqual([
      "taskkill",
      "/PID",
      "7654",
      "/T",
      "/F",
    ]);
  });

  test("creates Unix process groups for managed service tree termination", () => {
    expect(shouldDetachManagedServiceProcess("linux")).toBe(true);
    expect(shouldDetachManagedServiceProcess("darwin")).toBe(true);
    expect(shouldDetachManagedServiceProcess("win32")).toBe(false);
  });

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

  test("buildCoreManagedServiceSpecs isolates SCM repair authority to its two owners", () => {
    const secret = "test-start-scm-repair-authority-secret-0123456789abcdef";
    const specs = buildCoreManagedServiceSpecs(
      "bun",
      "C:/repo/example",
      {
        SAFE_RUNTIME_VALUE: "retained",
        [SCM_REPAIR_AUTHORITY_SECRET_ENV.toLowerCase()]: "must-be-replaced",
      },
      secret,
    );

    for (const spec of specs) {
      expect(spec.env?.SAFE_RUNTIME_VALUE).toBe("retained");
      const authorityKeys = Object.keys(spec.env ?? {}).filter(
        (key) => key.toLowerCase() === SCM_REPAIR_AUTHORITY_SECRET_ENV.toLowerCase(),
      );
      if (spec.name === "server" || spec.name === "source_control_manager") {
        expect(authorityKeys).toEqual([SCM_REPAIR_AUTHORITY_SECRET_ENV]);
        expect(spec.env?.[SCM_REPAIR_AUTHORITY_SECRET_ENV]).toBe(secret);
      } else {
        expect(authorityKeys).toEqual([]);
      }
    }
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

  test("ServiceManager beginShutdown suppresses restart scheduling without killing services", async () => {
    let killCalls = 0;
    let spawnCalls = 0;
    let managedService: ReturnType<ServiceManager["startService"]> | null = null;
    const manager = new ServiceManager({
      pollMs: 25,
      computeRestartBackoffMs: () => 25,
      spawnService: (spec) => {
        spawnCalls += 1;
        return {
          name: spec.name,
          proc: {
            pid: 123,
            kill: () => {
              killCalls += 1;
            },
          } as any,
          command: [...spec.command],
          cwd: spec.cwd,
          env: { ...(spec.env ?? {}) },
          exited: false,
          exitCode: null,
          launchedAtMs: Date.now(),
          logPath: spec.logPath,
        };
      },
    });
    try {
      managedService = manager.startService({
        name: "server",
        color: "blue",
        command: ["fake-server"],
        cwd: process.cwd(),
      });
      manager.beginShutdown();
      managedService.exited = true;
      managedService.exitCode = 0;

      await Bun.sleep(125);
      expect(spawnCalls).toBe(1);
      expect(killCalls).toBe(0);
      expect(manager.getHealth()).toBeNull();
    } finally {
      manager.stop();
    }
  });

  test("ServiceManager replaceService swaps launch specs and clears pending restart timers", async () => {
    let spawnCalls = 0;
    const spawnedCommands: string[][] = [];
    const manager = new ServiceManager({
      pollMs: 25,
      maxRestartAttempts: 4,
      computeRestartBackoffMs: () => 200,
      spawnService: (spec) => {
        spawnCalls += 1;
        spawnedCommands.push([...spec.command]);
        return {
          name: spec.name,
          proc: {
            pid: 123 + spawnCalls,
            kill: () => {},
          } as any,
          command: [...spec.command],
          cwd: spec.cwd,
          env: { ...(spec.env ?? {}) },
          exited: false,
          exitCode: null,
          launchedAtMs: Date.now(),
          logPath: spec.logPath,
        };
      },
    });
    try {
      const original = manager.startService({
        name: "remotebuddy",
        color: "red",
        command: ["compiled-remotebuddy.exe"],
        cwd: process.cwd(),
      });
      original.exited = true;
      original.exitCode = 3;

      await Bun.sleep(60);

      await manager.replaceService({
        name: "remotebuddy",
        color: "red",
        command: ["bun", "run", "apps/remotebuddy/src/remotebuddy_main.ts"],
        cwd: process.cwd(),
      });

      await Bun.sleep(350);

      expect(spawnCalls).toBe(2);
      expect(spawnedCommands).toEqual([
        ["compiled-remotebuddy.exe"],
        ["bun", "run", "apps/remotebuddy/src/remotebuddy_main.ts"],
      ]);
    } finally {
      manager.stop();
    }
  });

  test("ServiceManager stop signals managed launchers without spawning a blocking cleanup process", () => {
    if (process.platform === "win32") return;
    let killSignal: string | undefined;
    const manager = new ServiceManager({
      spawnService: (spec) => ({
        name: spec.name,
        proc: {
          pid: 123,
          kill: (signal?: string) => {
            killSignal = signal;
          },
        } as any,
        command: [...spec.command],
        cwd: spec.cwd,
        env: { ...(spec.env ?? {}) },
        exited: false,
        exitCode: null,
        launchedAtMs: Date.now(),
        logPath: spec.logPath,
      }),
    });

    manager.startService({
      name: "workerpals",
      color: "yellow",
      command: ["fake-workerpals"],
      cwd: process.cwd(),
    });
    manager.stop();

    expect(killSignal).toBe("SIGTERM");
  });

  test("ServiceManager stopAndWait awaits bounded whole-tree termination for every service", async () => {
    const terminated: string[] = [];
    const manager = new ServiceManager({
      spawnService: (spec) => ({
        name: spec.name,
        proc: {
          pid: spec.name === "remotebuddy" ? 501 : 502,
          exited: Promise.resolve(0),
          kill: () => {},
        } as any,
        command: [...spec.command],
        cwd: spec.cwd,
        env: { ...(spec.env ?? {}) },
        exited: false,
        exitCode: null,
        launchedAtMs: Date.now(),
        logPath: spec.logPath,
      }),
      terminateService: async (service) => {
        await Bun.sleep(10);
        terminated.push(service.name);
        service.exited = true;
        service.exitCode = 0;
      },
    });
    manager.startService({
      name: "remotebuddy",
      color: "red",
      command: ["fake-remotebuddy"],
      cwd: process.cwd(),
    });
    manager.startService({
      name: "workerpals",
      color: "yellow",
      command: ["fake-workerpals"],
      cwd: process.cwd(),
    });

    await manager.stopAndWait(250);

    expect(terminated.sort()).toEqual(["remotebuddy", "workerpals"]);
  });

  test("ServiceManager restarts a service after consecutive unhealthy probes", async () => {
    let spawnCalls = 0;
    let terminateCalls = 0;
    let probeCalls = 0;
    let current: ReturnType<ServiceManager["startService"]> | null = null;
    const manager = new ServiceManager({
      pollMs: 20,
      computeRestartBackoffMs: () => 20,
      probeServiceHealth: async () => {
        probeCalls += 1;
        return probeCalls <= 2
          ? { ok: false, detail: "tick stalled" }
          : { ok: true, detail: "healthy" };
      },
      terminateService: async (service) => {
        terminateCalls += 1;
        service.exited = true;
        service.exitCode = 1;
      },
      spawnService: (spec) => {
        spawnCalls += 1;
        current = {
          name: spec.name,
          proc: { pid: 9000 + spawnCalls, kill: () => {} } as any,
          command: [...spec.command],
          cwd: spec.cwd,
          env: { ...(spec.env ?? {}) },
          exited: false,
          exitCode: null,
          launchedAtMs: Date.now(),
          logPath: spec.logPath,
        };
        return current;
      },
    });
    try {
      manager.startService({
        name: "source_control_manager",
        color: "green",
        command: ["fake-scm"],
        cwd: process.cwd(),
        healthCheck: {
          url: "http://127.0.0.1:1/health",
          intervalMs: 50,
          unhealthyThreshold: 2,
        },
      });

      await Bun.sleep(300);
      expect(terminateCalls).toBe(1);
      expect(spawnCalls).toBeGreaterThanOrEqual(2);
      expect(current?.exited).toBe(false);
    } finally {
      manager.stop();
    }
  });
});
