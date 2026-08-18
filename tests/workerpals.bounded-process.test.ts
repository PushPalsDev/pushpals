import { describe, expect, test } from "bun:test";
import {
  buildWindowsProcessTreeTerminationArgv as buildWindowsWorkerProcessTreeTerminationArgv,
  runBoundedProcess as runBoundedWorkerProcess,
  terminateProcessTree as terminateWorkerProcessTree,
  type BoundedProcessSpawner as WorkerProcessSpawner,
  type BoundedSubprocess as WorkerSubprocess,
} from "../packages/shared/src/bounded_process";
import { resolveWorkerGitCommandTimeoutMs } from "../apps/workerpals/src/execute_job";

function streamFromText(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function streamFromChunks(values: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of values) controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function neverEndingStream(onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    cancel() {
      onCancel?.();
    },
  });
}

function fakeProcess(overrides: Partial<WorkerSubprocess> = {}): WorkerSubprocess {
  return {
    pid: 4242,
    stdout: streamFromText(""),
    stderr: streamFromText(""),
    exited: Promise.resolve(0),
    kill: () => undefined,
    ...overrides,
  };
}

describe("bounded WorkerPal subprocesses", () => {
  test("caps noisy stdout and stderr while draining them concurrently", async () => {
    const spawn: WorkerProcessSpawner = () =>
      fakeProcess({
        stdout: streamFromText("o".repeat(64 * 1024)),
        stderr: streamFromText("e".repeat(64 * 1024)),
      });

    const result = await runBoundedWorkerProcess(["fake"], {
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
      spawn,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeFalse();
    expect(result.drainTimedOut).toBeFalse();
    expect(result.stdout).toContain("[pushpals: process output truncated]");
    expect(result.stderr).toContain("[pushpals: process output truncated]");
    expect(result.stdout.length).toBeLessThan(1_100);
    expect(result.stderr.length).toBeLessThan(1_100);
  });

  test("retains tail sentinels and emits complete streaming lines after compaction", async () => {
    const lines: string[] = [];
    const sentinel = '__PUSHPALS_OH_RESULT__ {"ok":true}';
    const spawn: WorkerProcessSpawner = () =>
      fakeProcess({
        stdout: streamFromChunks([
          "first partial",
          " line\n",
          "x".repeat(8_000),
          `\n${sentinel}\n`,
        ]),
      });

    const result = await runBoundedWorkerProcess(["fake-noisy-wrapper"], {
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
      retainOutputTail: true,
      onStdoutLine: (line) => lines.push(line),
      spawn,
    });

    expect(result.stdout).toContain("[pushpals: process output truncated]");
    expect(result.stdout).toContain(sentinel);
    expect(lines[0]).toBe("first partial line");
    expect(lines.at(-1)).toBe(sentinel);
  });

  test("returns after a hard deadline even when exit and pipes never settle", async () => {
    let stdoutCancelled = false;
    let stderrCancelled = false;
    let terminationCalls = 0;
    const spawn: WorkerProcessSpawner = () =>
      fakeProcess({
        stdout: neverEndingStream(() => {
          stdoutCancelled = true;
        }),
        stderr: neverEndingStream(() => {
          stderrCancelled = true;
        }),
        exited: new Promise<number>(() => {}),
      });

    const startedAt = Date.now();
    const result = await runBoundedWorkerProcess(["fake-never-exits"], {
      timeoutMs: 20,
      streamDrainTimeoutMs: 20,
      spawn,
      terminate: async () => {
        terminationCalls += 1;
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBeTrue();
    expect(result.drainTimedOut).toBeTrue();
    expect(result.stderr).toContain("timed out after 20ms");
    expect(terminationCalls).toBeGreaterThanOrEqual(1);
    expect(stdoutCancelled).toBeTrue();
    expect(stderrCancelled).toBeTrue();
  });

  test("does not deadlock when the root exits but a descendant retains its pipes", async () => {
    let terminated = false;
    const spawn: WorkerProcessSpawner = () =>
      fakeProcess({
        stdout: neverEndingStream(),
        stderr: neverEndingStream(),
        exited: Promise.resolve(7),
      });

    const startedAt = Date.now();
    const result = await runBoundedWorkerProcess(["fake-leaked-pipe"], {
      timeoutMs: 1_000,
      streamDrainTimeoutMs: 20,
      spawn,
      terminate: async () => {
        terminated = true;
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBeFalse();
    expect(result.drainTimedOut).toBeTrue();
    expect(terminated).toBeTrue();
  });

  test("uses taskkill tree and force flags on Windows", async () => {
    const spawnedArgv: string[][] = [];
    const spawn: WorkerProcessSpawner = (argv) => {
      spawnedArgv.push(argv);
      return fakeProcess();
    };
    const root = fakeProcess({ pid: 9911 });

    await terminateWorkerProcessTree(root, { platform: "win32", spawn });

    expect(buildWindowsWorkerProcessTreeTerminationArgv(9911)).toEqual([
      "taskkill",
      "/PID",
      "9911",
      "/T",
      "/F",
    ]);
    expect(spawnedArgv).toEqual([["taskkill", "/PID", "9911", "/T", "/F"]]);
  });

  test("allows one bounded activity extension without weakening the hard maximum", async () => {
    let extensionCalls = 0;
    let terminationCalls = 0;
    const spawn: WorkerProcessSpawner = () =>
      fakeProcess({
        exited: new Promise<number>(() => {}),
      });

    const startedAt = Date.now();
    const result = await runBoundedWorkerProcess(["fake-active-wrapper"], {
      timeoutMs: 20,
      maxTotalTimeoutMs: 50,
      extendTimeoutMs: () => {
        extensionCalls += 1;
        return 30;
      },
      spawn,
      terminate: async () => {
        terminationCalls += 1;
      },
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.timedOut).toBeTrue();
    expect(extensionCalls).toBe(2);
    expect(terminationCalls).toBeGreaterThanOrEqual(1);
  });

  test("assigns every WorkerPal Git command a configurable deadline", () => {
    expect(resolveWorkerGitCommandTimeoutMs(["status"], {})).toBe(120_000);
    expect(resolveWorkerGitCommandTimeoutMs(["fetch", "origin"], {})).toBe(300_000);
    expect(
      resolveWorkerGitCommandTimeoutMs(["push", "origin", "main"], {
        PUSHPALS_WORKERPAL_GIT_NETWORK_TIMEOUT_MS: "450000",
      }),
    ).toBe(450_000);
    expect(
      resolveWorkerGitCommandTimeoutMs(["rev-parse", "HEAD"], {
        PUSHPALS_WORKERPAL_GIT_COMMAND_TIMEOUT_MS: "30000",
      }),
    ).toBe(30_000);
  });
});
