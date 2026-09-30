import { describe, expect, test } from "bun:test";
import {
  IncompleteRuntimeShutdownError,
  shutdownEmbeddedServiceManagerGracefully,
  stopRuntimeServicesGracefully,
} from "../scripts/pushpals-cli.ts";

type RuntimeService = Parameters<typeof stopRuntimeServicesGracefully>[0][number];
type ShutdownOptions = Parameters<typeof shutdownEmbeddedServiceManagerGracefully>[0];

function fakeService(name: string, onKill?: (signal: NodeJS.Signals | number | undefined) => void) {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const service: RuntimeService = {
    name,
    proc: {
      // Never provide an OS PID, even though every termination path below is injected.
      pid: undefined,
      exited,
      kill: (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
        onKill?.(signal);
      },
    } as unknown as RuntimeService["proc"],
    command: ["fake-service"],
    cwd: "shutdown-unit-fixture",
    env: {},
    exited: false,
    exitCode: null,
    launchedAtMs: 0,
  };
  return {
    service,
    signals,
    confirmExit(code = 0) {
      service.exited = true;
      service.exitCode = code;
      resolveExit(code);
    },
  };
}

function shutdownFixture(services: RuntimeService[]) {
  const counts = { begin: 0, get: 0, finish: 0, request: 0, cleanup: 0 };
  const warnings: string[] = [];
  const events: string[] = [];
  const serviceManager = {
    beginShutdown() {
      counts.begin += 1;
      events.push("begin");
    },
    getServices() {
      counts.get += 1;
      events.push("get");
      return services;
    },
    finishShutdownAfterTermination() {
      counts.finish += 1;
      events.push("finish");
    },
  } as any;
  return {
    counts,
    warnings,
    events,
    run(overrides: Partial<ShutdownOptions> = {}) {
      return shutdownEmbeddedServiceManagerGracefully({
        serviceManager,
        serverUrl: "http://shutdown.invalid",
        repoRoot: "shutdown-unit-fixture",
        reason: "mock shutdown regression",
        requestShutdown: async () => {
          counts.request += 1;
          events.push("request");
          return { attempted: false, accepted: false };
        },
        shutdownAcceptedDelayMs: 0,
        serviceStopTimeoutMs: 20,
        serviceStopOptions: { platform: "win32", terminateService: async () => {} },
        onLog: () => {},
        onWarn: (line) => warnings.push(line),
        cleanupTasks: [
          () => {
            counts.cleanup += 1;
            events.push("cleanup");
          },
        ],
        ...overrides,
      });
    },
  };
}

async function expectIncomplete(operation: Promise<void>): Promise<IncompleteRuntimeShutdownError> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IncompleteRuntimeShutdownError);
  return caught as IncompleteRuntimeShutdownError;
}

describe("CLI shutdown exit confirmation", () => {
  test("rejected Windows termination preserves resources and does not finish supervision", async () => {
    const target = fakeService("remotebuddy");
    const fixture = shutdownFixture([target.service]);
    const error = await expectIncomplete(
      fixture.run({
        serviceStopOptions: {
          platform: "win32",
          terminateService: async () => {
            throw new Error("termination denied");
          },
        },
      }),
    );

    expect(error.pendingServices).toEqual([{ name: "remotebuddy", pid: null }]);
    expect(error.terminationErrors).toEqual(["remotebuddy: Error: termination denied"]);
    expect(error.message).toContain("Preserving runtime worktrees and containers");
    expect(fixture.counts).toEqual({ begin: 1, get: 1, finish: 0, request: 1, cleanup: 0 });
    expect(fixture.warnings.some((line) => line.includes("termination denied"))).toBe(true);
    expect(target.service.exited).toBe(false);
    expect(target.signals).toEqual([]);
  });

  test("fulfilled termination without confirmed exit does not permit cleanup", async () => {
    const target = fakeService("server");
    const fixture = shutdownFixture([target.service]);
    const error = await expectIncomplete(fixture.run());

    expect(error.pendingServices).toEqual([{ name: "server", pid: null }]);
    expect(error.terminationErrors).toEqual([]);
    expect(fixture.counts.finish).toBe(0);
    expect(fixture.counts.cleanup).toBe(0);
  });

  test("never-settling termination is bounded and leaves cleanup unattempted", async () => {
    const target = fakeService("workerpals");
    const fixture = shutdownFixture([target.service]);
    const startedAt = Date.now();
    const error = await expectIncomplete(
      fixture.run({
        serviceStopOptions: {
          platform: "win32",
          terminateService: async () => await new Promise<void>(() => {}),
        },
      }),
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(error.pendingServices).toEqual([{ name: "workerpals", pid: null }]);
    expect(error.terminationErrors).toContain("Process-tree termination deadline exceeded");
    expect(fixture.counts.finish).toBe(0);
    expect(fixture.counts.cleanup).toBe(0);
  });

  test("root exit does not permit cleanup while its requested tree termination remains pending", async () => {
    const target = fakeService("workerpals");
    const fixture = shutdownFixture([target.service]);
    const startedAt = Date.now();
    const error = await expectIncomplete(
      fixture.run({
        serviceStopOptions: {
          platform: "win32",
          terminateService: async () => {
            target.confirmExit();
            await new Promise<void>(() => {});
          },
        },
      }),
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(target.service.exited).toBe(true);
    expect(error.pendingServices).toEqual([{ name: "workerpals", pid: null }]);
    expect(error.terminationErrors).toContain("Process-tree termination deadline exceeded");
    expect(fixture.counts.finish).toBe(0);
    expect(fixture.counts.cleanup).toBe(0);
  });

  test("root exit does not permit cleanup after its requested tree termination rejects", async () => {
    const target = fakeService("workerpals");
    const fixture = shutdownFixture([target.service]);
    const error = await expectIncomplete(
      fixture.run({
        serviceStopOptions: {
          platform: "win32",
          terminateService: async () => {
            target.confirmExit();
            throw new Error("descendant termination failed");
          },
        },
      }),
    );

    expect(target.service.exited).toBe(true);
    expect(error.pendingServices).toEqual([{ name: "workerpals", pid: null }]);
    expect(error.terminationErrors).toEqual(["workerpals: Error: descendant termination failed"]);
    expect(fixture.counts.finish).toBe(0);
    expect(fixture.counts.cleanup).toBe(0);
  });

  test("retry waits for the original pending tree termination before allowing cleanup", async () => {
    const target = fakeService("workerpals");
    const fixture = shutdownFixture([target.service]);
    let resolveTreeTermination!: () => void;
    const treeTermination = new Promise<void>((resolve) => {
      resolveTreeTermination = resolve;
    });
    let attempts = 0;
    const serviceStopOptions: NonNullable<ShutdownOptions["serviceStopOptions"]> = {
      platform: "win32",
      terminateService: async () => {
        attempts += 1;
        target.confirmExit();
        await treeTermination;
      },
    };

    await expectIncomplete(fixture.run({ serviceStopOptions }));
    const retryStartedAt = Date.now();
    const retryError = await expectIncomplete(fixture.run({ serviceStopOptions }));

    expect(Date.now() - retryStartedAt).toBeLessThan(1_000);
    expect(retryError.pendingServices).toEqual([{ name: "workerpals", pid: null }]);
    expect(attempts).toBe(1);
    expect(fixture.counts.finish).toBe(0);
    expect(fixture.counts.cleanup).toBe(0);

    resolveTreeTermination();
    await treeTermination;
    await fixture.run({ serviceStopOptions });

    expect(attempts).toBe(1);
    expect(fixture.counts).toEqual({ begin: 3, get: 3, finish: 1, request: 3, cleanup: 1 });
    expect(target.signals).toEqual([]);
  });

  test("retry stays fail-closed after tree termination rejects for an exited root", async () => {
    const target = fakeService("workerpals");
    const fixture = shutdownFixture([target.service]);
    let attempts = 0;
    const serviceStopOptions: NonNullable<ShutdownOptions["serviceStopOptions"]> = {
      platform: "win32",
      terminateService: async () => {
        attempts += 1;
        target.confirmExit();
        throw new Error("descendant sweep failed after launcher exit");
      },
    };

    await expectIncomplete(fixture.run({ serviceStopOptions }));
    const retryError = await expectIncomplete(fixture.run({ serviceStopOptions }));

    expect(retryError.pendingServices).toEqual([{ name: "workerpals", pid: null }]);
    expect(retryError.terminationErrors.join(" ")).toContain(
      "descendant sweep failed after launcher exit",
    );
    expect(attempts).toBe(1);
    expect(fixture.counts).toEqual({ begin: 2, get: 2, finish: 0, request: 2, cleanup: 0 });
    expect(target.signals).toEqual([]);
  });

  test("partial service exit identifies the remaining service and preserves all cleanup", async () => {
    const stopped = fakeService("remotebuddy");
    const pending = fakeService("server");
    const fixture = shutdownFixture([pending.service, stopped.service]);
    const attempted: string[] = [];
    const error = await expectIncomplete(
      fixture.run({
        serviceStopOptions: {
          platform: "win32",
          terminateService: async (service) => {
            attempted.push(service.name);
            if (service === stopped.service) stopped.confirmExit();
          },
        },
      }),
    );

    expect(attempted).toEqual(["remotebuddy", "server"]);
    expect(error.pendingServices).toEqual([{ name: "server", pid: null }]);
    expect(stopped.service.exited).toBe(true);
    expect(fixture.counts.finish).toBe(0);
    expect(fixture.counts.cleanup).toBe(0);
  });

  test("already-exited services do not receive a redundant termination", async () => {
    const target = fakeService("server");
    target.confirmExit();
    const fixture = shutdownFixture([target.service]);
    let attempts = 0;

    await fixture.run({
      serviceStopOptions: {
        platform: "win32",
        terminateService: async () => {
          attempts += 1;
        },
      },
    });

    expect(attempts).toBe(0);
    expect(target.signals).toEqual([]);
    expect(fixture.counts.finish).toBe(1);
    expect(fixture.counts.cleanup).toBe(1);
  });

  test("a successful retry after rejected termination performs cleanup only once", async () => {
    const target = fakeService("source_control_manager");
    const fixture = shutdownFixture([target.service]);
    let attempts = 0;
    const serviceStopOptions: NonNullable<ShutdownOptions["serviceStopOptions"]> = {
      platform: "win32",
      terminateService: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary termination failure");
        target.confirmExit();
      },
    };

    await expectIncomplete(fixture.run({ serviceStopOptions }));
    expect(fixture.counts.finish).toBe(0);
    expect(fixture.counts.cleanup).toBe(0);
    await fixture.run({ serviceStopOptions });

    expect(attempts).toBe(2);
    expect(fixture.counts).toEqual({ begin: 2, get: 2, finish: 1, request: 2, cleanup: 1 });
    expect(fixture.events.slice(-2)).toEqual(["finish", "cleanup"]);
    expect(target.service.exited).toBe(true);
  });

  test("successful Windows shutdown confirms every service before finalization and cleanup", async () => {
    const server = fakeService("server");
    const remote = fakeService("remotebuddy");
    const scm = fakeService("source_control_manager");
    const targets = [server, remote, scm];
    const fixture = shutdownFixture(targets.map((target) => target.service));
    const attempts: Array<{
      name: string;
      platform: NodeJS.Platform | undefined;
      graceful: boolean;
    }> = [];

    await fixture.run({
      serviceStopOptions: {
        platform: "win32",
        terminateService: async (service, platform, options) => {
          expect(fixture.counts.finish).toBe(0);
          expect(fixture.counts.cleanup).toBe(0);
          attempts.push({
            name: service.name,
            platform,
            graceful: options?.gracefulSignalAlreadySent === true,
          });
          targets.find((target) => target.service === service)!.confirmExit();
        },
      },
    });

    expect(attempts).toEqual([
      { name: "source_control_manager", platform: "win32", graceful: false },
      { name: "remotebuddy", platform: "win32", graceful: false },
      { name: "server", platform: "win32", graceful: false },
    ]);
    expect(targets.every((target) => target.service.exited)).toBe(true);
    expect(targets.flatMap((target) => target.signals)).toEqual([]);
    expect(fixture.events).toEqual(["begin", "get", "request", "finish", "cleanup"]);
    expect(fixture.warnings).toEqual([]);
  });

  test("POSIX fallback only terminates remaining services after sending graceful signals", async () => {
    const graceful = fakeService("remotebuddy", () => graceful.confirmExit());
    const pending = fakeService("server");
    const attempts: string[] = [];

    await stopRuntimeServicesGracefully([pending.service, graceful.service], 20, {
      platform: "linux",
      terminateService: async (service, platform, options) => {
        attempts.push(service.name);
        expect(platform).toBe("linux");
        expect(options?.gracefulSignalAlreadySent).toBe(true);
        expect(graceful.signals).toEqual(["SIGTERM"]);
        expect(pending.signals).toEqual(["SIGTERM"]);
        pending.confirmExit();
      },
    });

    expect(attempts).toEqual(["server"]);
    expect(graceful.service.exited).toBe(true);
    expect(pending.service.exited).toBe(true);
  });

  test("POSIX fallback also rejects unconfirmed exit without running cleanup", async () => {
    const target = fakeService("server");
    const fixture = shutdownFixture([target.service]);
    const error = await expectIncomplete(
      fixture.run({
        serviceStopOptions: { platform: "linux", terminateService: async () => {} },
      }),
    );

    expect(error.pendingServices).toEqual([{ name: "server", pid: null }]);
    expect(target.signals).toEqual(["SIGTERM"]);
    expect(fixture.counts.finish).toBe(0);
    expect(fixture.counts.cleanup).toBe(0);
  });

  test("a throwing shutdown request still attempts and confirms local termination", async () => {
    const target = fakeService("server");
    const fixture = shutdownFixture([target.service]);
    let terminationAttempts = 0;

    await fixture.run({
      requestShutdown: async () => {
        throw new Error("shutdown endpoint unavailable");
      },
      serviceStopOptions: {
        platform: "win32",
        terminateService: async () => {
          terminationAttempts += 1;
          target.confirmExit();
        },
      },
    });

    expect(terminationAttempts).toBe(1);
    expect(fixture.warnings.some((line) => line.includes("shutdown endpoint unavailable"))).toBe(
      true,
    );
    expect(fixture.counts.finish).toBe(1);
    expect(fixture.counts.cleanup).toBe(1);
    expect(target.service.exited).toBe(true);
  });
});
