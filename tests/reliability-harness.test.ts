import { describe, expect, test } from "bun:test";
import {
  buildHarnessWindowsTreeKillArgv,
  listReliabilityHarnessPhaseFiles,
  terminateHarnessProcessTree,
} from "../scripts/reliability-harness";

describe("reliability harness release coverage", () => {
  test("gates RepositoryAgent liveness, durable memory, and autonomy integration", () => {
    const files = listReliabilityHarnessPhaseFiles("repository_intelligence");

    expect(files).toContain("tests/remotebuddy.repository-agent.test.ts");
    expect(files).toContain("tests/server.repository-agent-queue.test.ts");
    expect(files).toContain("tests/memory-store-conformance.test.ts");
    expect(files).toContain("tests/remotebuddy.autonomous-engine.tick.test.ts");
  });

  test("gates the composed worker quality loop and watchdog policy", () => {
    const files = listReliabilityHarnessPhaseFiles("quality_loop");
    const watchdogFiles = listReliabilityHarnessPhaseFiles("worker_watchdog");

    expect(files).toContain("tests/workerpals.quality-gate-issues.test.ts");
    expect(files).toContain("tests/workerpals.quality-loop-durability.test.ts");
    expect(files).toContain("tests/workerpals.validation-command-safety.test.ts");
    expect(watchdogFiles).toContain(
      "apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py",
    );
  });

  test("gates both source and packaged generic-executor progress behavior", () => {
    const files = listReliabilityHarnessPhaseFiles("runtime_boundary");

    expect(files).toContain("tests/workerpals.generic-python-executor.test.ts");
    expect(files).toContain("tests/workerpals.packaged-generic-python-executor.test.ts");
  });

  test("gates durable runtime-circuit and claim-generation recovery behavior", () => {
    const lifecycleFiles = listReliabilityHarnessPhaseFiles("durable_lifecycle");
    const runtimeFiles = listReliabilityHarnessPhaseFiles("runtime_boundary");

    expect(lifecycleFiles).toContain("tests/server.job-diagnostics.test.ts");
    expect(lifecycleFiles).toContain("tests/server.jobs.stale-recovery.test.ts");
    expect(lifecycleFiles).toContain("tests/server.jobs-repair-scheduling.test.ts");
    expect(lifecycleFiles).toContain("tests/server.session-message-route.test.ts");
    expect(runtimeFiles).toContain("tests/workerpals.server-transport.test.ts");
  });
});

describe("reliability harness process cleanup", () => {
  test("uses taskkill tree termination on Windows and confirms target exit", async () => {
    const spawned: string[][] = [];
    const target = {
      pid: 4321,
      exited: Promise.resolve(124),
      kill() {},
    };
    const settled = await terminateHarnessProcessTree(target, {
      platform: "win32",
      graceMs: 20,
      spawn: (argv) => {
        spawned.push(argv);
        return { pid: 999, exited: Promise.resolve(0), kill() {} };
      },
    });

    expect(spawned).toEqual([buildHarnessWindowsTreeKillArgv(4321)]);
    expect(settled).toBe(true);
  });

  test("reports an unsettled timeout process instead of silently continuing", async () => {
    let directKills = 0;
    const never = new Promise<number>(() => {});
    const settled = await terminateHarnessProcessTree(
      {
        pid: 4322,
        exited: never,
        kill() {
          directKills += 1;
        },
      },
      {
        platform: "win32",
        graceMs: 5,
        spawn: () => ({ pid: 998, exited: Promise.resolve(0), kill() {} }),
      },
    );

    expect(settled).toBe(false);
    expect(directKills).toBe(1);
  });

  test("terminates the detached POSIX process group before falling back to the root", async () => {
    const groupSignals: Array<[number, NodeJS.Signals]> = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const settled = await terminateHarnessProcessTree(
      {
        pid: 4323,
        exited,
        kill() {
          throw new Error("root-only kill must not be needed");
        },
      },
      {
        platform: "linux",
        graceMs: 20,
        killGroup: (pid, signal) => {
          groupSignals.push([pid, signal]);
          if (signal === "SIGTERM") resolveExit(143);
        },
      },
    );

    expect(settled).toBe(true);
    expect(groupSignals).toEqual([[4323, "SIGTERM"]]);
  });
});
