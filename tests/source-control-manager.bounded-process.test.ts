import { describe, expect, test } from "bun:test";
import {
  buildWindowsScmProcessTreeTerminationArgv,
  runBoundedScmProcess,
  terminateScmProcessTree,
  type ScmProcessSpawner,
  type ScmSubprocess,
} from "../apps/source_control_manager/src/bounded_process";
import { resolveGitCommandTimeoutMs } from "../apps/source_control_manager/src/git";

function streamFromText(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
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

function fakeProcess(overrides: Partial<ScmSubprocess> = {}): ScmSubprocess {
  return {
    pid: 4242,
    stdout: streamFromText(""),
    stderr: streamFromText(""),
    exited: Promise.resolve(0),
    kill: () => {},
    ...overrides,
  };
}

describe("bounded SourceControlManager subprocesses", () => {
  test("caps noisy stdout and stderr while draining both concurrently", async () => {
    const spawn: ScmProcessSpawner = () =>
      fakeProcess({
        stdout: streamFromText("o".repeat(64 * 1024)),
        stderr: streamFromText("e".repeat(64 * 1024)),
      });

    const result = await runBoundedScmProcess(["fake"], {
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
      spawn,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeFalse();
    expect(result.stdout).toContain("[pushpals: process output truncated]");
    expect(result.stderr).toContain("[pushpals: process output truncated]");
    expect(result.stdout.length).toBeLessThan(1_100);
    expect(result.stderr.length).toBeLessThan(1_100);
  });

  test("returns after a hard deadline even when exit and inherited pipes never settle", async () => {
    let stdoutCancelled = false;
    let stderrCancelled = false;
    let terminated = false;
    const spawn: ScmProcessSpawner = () =>
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
    const result = await runBoundedScmProcess(["fake-never-exits"], {
      timeoutMs: 20,
      streamDrainTimeoutMs: 20,
      spawn,
      terminate: async () => {
        terminated = true;
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBeTrue();
    expect(result.stderr).toContain("timed out after 20ms");
    expect(terminated).toBeTrue();
    expect(stdoutCancelled).toBeTrue();
    expect(stderrCancelled).toBeTrue();
  });

  test("does not deadlock when the root exits but a descendant retains its pipes", async () => {
    const spawn: ScmProcessSpawner = () =>
      fakeProcess({
        stdout: neverEndingStream(),
        stderr: neverEndingStream(),
        exited: Promise.resolve(7),
      });

    const startedAt = Date.now();
    const result = await runBoundedScmProcess(["fake-leaked-pipe"], {
      timeoutMs: 1_000,
      streamDrainTimeoutMs: 20,
      spawn,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBeFalse();
  });

  test("uses taskkill tree and force flags on Windows", async () => {
    const spawnedArgv: string[][] = [];
    const spawn: ScmProcessSpawner = (argv) => {
      spawnedArgv.push(argv);
      return fakeProcess();
    };
    const root = fakeProcess({ pid: 9911 });

    await terminateScmProcessTree(root, { platform: "win32", spawn });

    expect(buildWindowsScmProcessTreeTerminationArgv(9911)).toEqual([
      "taskkill",
      "/PID",
      "9911",
      "/T",
      "/F",
    ]);
    expect(spawnedArgv).toEqual([["taskkill", "/PID", "9911", "/T", "/F"]]);
  });

  test("assigns every Git command a configurable bound and gives network operations longer", () => {
    expect(resolveGitCommandTimeoutMs(["status"], undefined, {})).toBe(120_000);
    expect(resolveGitCommandTimeoutMs(["fetch", "origin"], undefined, {})).toBe(300_000);
    expect(
      resolveGitCommandTimeoutMs(["push", "origin", "main"], undefined, {
        PUSHPALS_SCM_GIT_NETWORK_TIMEOUT_MS: "450000",
      }),
    ).toBe(450_000);
    expect(
      resolveGitCommandTimeoutMs(["rev-parse", "HEAD"], undefined, {
        PUSHPALS_SCM_GIT_COMMAND_TIMEOUT_MS: "30000",
      }),
    ).toBe(30_000);
    expect(resolveGitCommandTimeoutMs(["fetch"], 321, {})).toBe(321);
  });

  test("terminates a real never-exiting process within the configured bound", async () => {
    const result = await runBoundedScmProcess(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 100 },
    );

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBeTrue();
  });
});
