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

      manager.replaceService({
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

  test("ServiceManager stop force-kills managed services on Unix", () => {
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

    expect(killSignal).toBe("SIGKILL");
  });
});
