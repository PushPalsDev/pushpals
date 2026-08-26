import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  buildWindowsDescendantSweepArgv,
  buildWindowsProcessTreeTerminationArgv,
  runBoundedProcess,
  terminateProcessTree,
  type BoundedProcessSpawner,
  type BoundedSubprocess,
} from "../packages/shared/src/bounded_process";

function isEffectivelyAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/, 1)[0];
      // A container without a subreaper can retain an already-terminated
      // orphan as a zombie. It has no executable process left to terminate.
      if (state === "Z") return false;
    } catch {
      return false;
    }
  }
  return true;
}

describe("shared bounded subprocess", () => {
  test("uses taskkill /T /F for Windows process trees", async () => {
    const spawned: string[][] = [];
    const target: BoundedSubprocess = {
      pid: 4321,
      exited: Promise.resolve(1),
      kill() {},
    };
    const spawn: BoundedProcessSpawner = (argv) => {
      spawned.push(argv);
      return { pid: 99, exited: Promise.resolve(0), kill() {} };
    };

    await terminateProcessTree(target, { platform: "win32", spawn, exitGraceMs: 5 });

    expect(spawned).toEqual([buildWindowsProcessTreeTerminationArgv(4321)]);
  });

  test("falls back to a bounded descendant sweep when taskkill loses an exited root", async () => {
    const spawned: string[][] = [];
    const target: BoundedSubprocess = {
      pid: 4324,
      exited: Promise.resolve(0),
      kill() {},
    };
    const spawn: BoundedProcessSpawner = (argv) => {
      spawned.push(argv);
      const isTaskkill = argv[0]?.toLowerCase() === "taskkill";
      return { pid: 99, exited: Promise.resolve(isTaskkill ? 128 : 0), kill() {} };
    };

    await terminateProcessTree(target, { platform: "win32", spawn, exitGraceMs: 5 });

    expect(spawned[0]).toEqual(buildWindowsProcessTreeTerminationArgv(4324));
    expect(spawned[1]).toEqual(buildWindowsDescendantSweepArgv(4324));
  });

  test("returns after the hard deadline even when exit and pipes never settle", async () => {
    let terminated = 0;
    let stdoutCancelled = 0;
    const stalledOutput = new ReadableStream<Uint8Array>({
      cancel() {
        stdoutCancelled += 1;
      },
    });
    const never = new Promise<number>(() => {});
    const processHandle: BoundedSubprocess = {
      pid: 4322,
      stdout: stalledOutput,
      stderr: null,
      exited: never,
      kill() {},
    };
    const startedAt = Date.now();

    const result = await runBoundedProcess(["stalled"], {
      timeoutMs: 20,
      streamDrainTimeoutMs: 20,
      spawn: () => processHandle,
      terminate: async () => {
        terminated += 1;
      },
    });

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.drainTimedOut).toBe(true);
    expect(result.stderr).toContain("terminated process tree");
    expect(terminated).toBe(1);
    expect(stdoutCancelled).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("acknowledges cancellation only after tree termination and bounded stream drain", async () => {
    const controller = new AbortController();
    const reason = new Error("provider discovery cancelled");
    let releaseTermination: (() => void) | null = null;
    const terminationGate = new Promise<void>((resolveTermination) => {
      releaseTermination = resolveTermination;
    });
    let terminated = 0;
    let outputCancelled = 0;
    const processHandle: BoundedSubprocess = {
      pid: 4330,
      stdout: new ReadableStream<Uint8Array>({
        cancel() {
          outputCancelled += 1;
        },
      }),
      stderr: null,
      exited: new Promise<number>(() => {}),
      kill() {},
    };

    let settled = false;
    const operation = runBoundedProcess(["cancelled-provider"], {
      timeoutMs: 10_000,
      streamDrainTimeoutMs: 20,
      signal: controller.signal,
      spawn: () => processHandle,
      terminate: async () => {
        terminated += 1;
        await terminationGate;
      },
    }).finally(() => {
      settled = true;
    });

    controller.abort(reason);
    await Bun.sleep(20);
    expect(settled).toBe(false);
    expect(terminated).toBe(1);

    releaseTermination?.();
    await expect(operation).rejects.toBe(reason);
    expect(outputCancelled).toBe(1);
  });

  test("does not spawn a subprocess for an already-aborted request", async () => {
    const controller = new AbortController();
    const reason = new Error("request already expired");
    controller.abort(reason);
    let spawned = 0;

    await expect(
      runBoundedProcess(["must-not-start"], {
        timeoutMs: 1_000,
        signal: controller.signal,
        spawn: () => {
          spawned += 1;
          throw new Error("unexpected spawn");
        },
      }),
    ).rejects.toBe(reason);
    expect(spawned).toBe(0);
  });

  test("force-stops without repeating a graceful signal that already timed out", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const target: BoundedSubprocess = {
      pid: 0,
      exited: new Promise<number>(() => {}),
      kill(signal) {
        signals.push(signal);
      },
    };

    await terminateProcessTree(target, {
      platform: "linux",
      exitGraceMs: 5,
      gracefulSignalAlreadySent: true,
    });

    expect(signals).toEqual(["SIGKILL"]);
  });

  test("caps captured output and marks truncation", async () => {
    const bytes = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz");
    const processHandle: BoundedSubprocess = {
      pid: 4323,
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      stderr: null,
      exited: Promise.resolve(0),
      kill() {},
    };

    const result = await runBoundedProcess(["verbose"], {
      timeoutMs: 100,
      outputLimitBytes: 5,
      spawn: () => processHandle,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("abcde");
    expect(result.stdout).toContain("process output truncated");
  });

  test("kills a real orphan descendant after its root exits", async () => {
    const parentScript = [
      `const { spawn } = require("node:child_process");`,
      `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });`,
      `console.log(child.pid);`,
      `setTimeout(() => process.exit(0), 10);`,
    ].join("\n");
    let childPid = 0;
    try {
      const root = Bun.spawn([process.execPath, "-e", parentScript], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      });
      const [stdout, rootExit] = await Promise.all([new Response(root.stdout).text(), root.exited]);
      childPid = Number.parseInt(stdout.match(/\b\d+\b/)?.[0] ?? "", 10);

      expect(rootExit).toBe(0);
      expect(childPid).toBeGreaterThan(0);
      await terminateProcessTree(root as unknown as BoundedSubprocess);

      let alive = true;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!isEffectivelyAlive(childPid)) {
          alive = false;
          break;
        }
        await Bun.sleep(50);
      }
      expect(alive).toBe(false);
    } finally {
      if (childPid > 0) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The bounded runner already cleaned it up.
        }
      }
    }
  }, 15_000);
});
