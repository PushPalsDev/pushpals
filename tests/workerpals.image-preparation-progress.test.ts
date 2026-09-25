import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DockerExecutor } from "../apps/workerpals/src/docker_executor";

type CaptureResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  drainTimedOut: boolean;
};

type CaptureOptions = {
  cwd?: string;
  timeoutMs?: number;
  onOutput?: (stream: "stdout" | "stderr", byteCount: number) => void;
};

type ImagePreparationExecutor = {
  deadlineMonotonicNow: () => number;
  runDockerCommandCapture: (command: string[], options: CaptureOptions) => Promise<CaptureResult>;
  runDockerImageCommandCapture: (
    phase: "docker-image-build" | "docker-image-pull",
    command: string[],
    options: { cwd?: string; timeoutMs: number },
  ) => Promise<CaptureResult>;
};

const success: CaptureResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  drainTimedOut: false,
};

function createExecutor(): ImagePreparationExecutor {
  // Exercise production methods without constructing worktrees or Docker clients.
  const executor = Object.create(DockerExecutor.prototype) as ImagePreparationExecutor;
  executor.deadlineMonotonicNow = () => performance.now();
  return executor;
}

describe("WorkerPal image preparation progress", () => {
  let log: ReturnType<typeof spyOn> | undefined;
  afterEach(() => log?.mockRestore());

  function observeMarkers() {
    const lines: string[] = [];
    log = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    return {
      lines,
      markers: () =>
        lines
          .filter((line) => line.startsWith("[WorkerPalStartup] "))
          .map((line) => JSON.parse(line.slice("[WorkerPalStartup] ".length))),
    };
  }

  test("reports actual output bytes at most once per second without leaking captured output", async () => {
    const executor = createExecutor();
    const observed = observeMarkers();
    let now = 1_000;
    executor.deadlineMonotonicNow = () => now;
    executor.runDockerCommandCapture = async (_command, options) => {
      expect(options.timeoutMs).toBe(600_000);
      options.onOutput?.("stdout", 2);
      now = 1_100;
      options.onOutput?.("stderr", 3);
      now = 1_999;
      options.onOutput?.("stdout", 4);
      now = 2_000;
      options.onOutput?.("stderr", 5);
      return { ...success, stdout: "sensitive build output", stderr: "secret build path" };
    };

    const result = await executor.runDockerImageCommandCapture(
      "docker-image-build",
      ["docker", "build"],
      {
        timeoutMs: 600_000,
      },
    );

    expect(result.stdout).toBe("sensitive build output");
    expect(observed.markers()).toEqual([
      {
        phase: "docker-image-build",
        event: "start",
        timeoutMs: 600_000,
        elapsedMs: 0,
        outputBytes: 0,
      },
      {
        phase: "docker-image-build",
        event: "progress",
        timeoutMs: 600_000,
        elapsedMs: 0,
        outputBytes: 2,
      },
      {
        phase: "docker-image-build",
        event: "progress",
        timeoutMs: 600_000,
        elapsedMs: 1_000,
        outputBytes: 14,
      },
      {
        phase: "docker-image-build",
        event: "complete",
        timeoutMs: 600_000,
        elapsedMs: 1_000,
        outputBytes: 14,
      },
    ]);
    expect(observed.lines.join("\n")).not.toContain("sensitive");
    expect(observed.lines.join("\n")).not.toContain("secret");
  });

  test("silent timeout emits no synthetic progress and preserves the capped deadline", async () => {
    const executor = createExecutor();
    const observed = observeMarkers();
    let now = 0;
    executor.deadlineMonotonicNow = () => now;
    executor.runDockerCommandCapture = async (_command, options) => {
      expect(options.timeoutMs).toBe(37_000);
      now = 37_000;
      return { ...success, timedOut: true, exitCode: 124 };
    };

    const result = await executor.runDockerImageCommandCapture(
      "docker-image-pull",
      ["docker", "pull"],
      {
        timeoutMs: 37_000,
      },
    );

    expect(result.timedOut).toBe(true);
    expect(observed.markers()).toEqual([
      {
        phase: "docker-image-pull",
        event: "start",
        timeoutMs: 37_000,
        elapsedMs: 0,
        outputBytes: 0,
      },
      {
        phase: "docker-image-pull",
        event: "failed",
        timeoutMs: 37_000,
        elapsedMs: 37_000,
        outputBytes: 0,
      },
    ]);
  });

  test("cold image preparation routes the actual local build through startup reporting", async () => {
    const executor = createExecutor() as ImagePreparationExecutor & {
      options: { repo: string; imageName: string };
      imageExists: () => Promise<boolean>;
      inspectImageRuntimeTag: () => Promise<string>;
      pullImage: () => Promise<boolean>;
    };
    const observed = observeMarkers();
    executor.options = { repo: process.cwd(), imageName: "workerpal-image-progress-test" };
    executor.imageExists = async () => false;
    executor.inspectImageRuntimeTag = async () =>
      String(process.env.PUSHPALS_RUNTIME_TAG ?? "").trim();
    executor.runDockerCommandCapture = async (command, options) => {
      expect(command[1]).toBe("build");
      expect(options.timeoutMs).toBe(600_000);
      options.onOutput?.("stderr", 42);
      return success;
    };
    const originalSandboxRoot = process.env.PUSHPALS_WORKERPALS_SANDBOX_ROOT;
    process.env.PUSHPALS_WORKERPALS_SANDBOX_ROOT = process.cwd();
    try {
      expect(await executor.pullImage()).toBe(true);
    } finally {
      if (originalSandboxRoot === undefined) delete process.env.PUSHPALS_WORKERPALS_SANDBOX_ROOT;
      else process.env.PUSHPALS_WORKERPALS_SANDBOX_ROOT = originalSandboxRoot;
    }

    expect(observed.markers().map((marker) => marker.event)).toEqual([
      "start",
      "progress",
      "complete",
    ]);
    expect(observed.markers().every((marker) => marker.phase === "docker-image-build")).toBe(true);
  });

  test("local image failure reports the bounded registry pull as its own phase", async () => {
    const executor = createExecutor() as ImagePreparationExecutor & {
      options: { imageName: string };
      imageExists: () => Promise<boolean>;
      inspectImageRuntimeTag: () => Promise<string>;
      buildLocalImage: () => Promise<boolean>;
      pullImage: () => Promise<boolean>;
    };
    const observed = observeMarkers();
    executor.options = { imageName: "workerpal-image-progress-test" };
    executor.imageExists = async () => false;
    executor.inspectImageRuntimeTag = async () => "";
    executor.buildLocalImage = async () => false;
    executor.runDockerCommandCapture = async (command, options) => {
      expect(command[1]).toBe("pull");
      expect(options.timeoutMs).toBe(600_000);
      options.onOutput?.("stdout", 21);
      return success;
    };

    expect(await executor.pullImage()).toBe(true);
    expect(observed.markers().map((marker) => marker.event)).toEqual([
      "start",
      "progress",
      "complete",
    ]);
    expect(observed.markers().every((marker) => marker.phase === "docker-image-pull")).toBe(true);
  });

  test("spawn failure closes the reported phase without exposing exception details", async () => {
    const executor = createExecutor();
    const observed = observeMarkers();
    executor.runDockerCommandCapture = async () => {
      throw new Error("private command details");
    };

    await expect(
      executor.runDockerImageCommandCapture("docker-image-build", ["docker", "build"], {
        timeoutMs: 600_000,
      }),
    ).rejects.toThrow("private command details");

    expect(observed.markers().map((marker) => marker.event)).toEqual(["start", "failed"]);
    expect(observed.lines.join("\n")).not.toContain("private");
  });

  test("expired absolute job budget does not announce a build that cannot start", async () => {
    const executor = createExecutor();
    const observed = observeMarkers();
    const result = await executor.runDockerImageCommandCapture(
      "docker-image-build",
      ["not-a-real-executable"],
      {
        timeoutMs: 0,
      },
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(observed.lines).toEqual([]);
  });

  test("large unterminated subprocess output keeps progress metadata and retained output bounded", async () => {
    const executor = createExecutor();
    const observed = observeMarkers();
    const result = await executor.runDockerImageCommandCapture(
      "docker-image-build",
      [
        process.execPath,
        "-e",
        'process.stdout.write("x".repeat(2_100_000)); process.stderr.write("private-content");',
      ],
      { timeoutMs: 10_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toStartWith("[output truncated to final 2000000 characters]");
    expect(result.stdout.length).toBeLessThan(2_000_100);
    expect(result.stderr).toBe("private-content");
    const markers = observed.markers();
    expect(markers.at(-1)).toMatchObject({
      event: "complete",
      outputBytes: 2_100_015,
      timeoutMs: 10_000,
    });
    expect(markers.some((marker) => marker.event === "progress")).toBe(true);
    expect(observed.lines.every((line) => line.length < 250)).toBe(true);
    expect(observed.lines.join("\n")).not.toContain("private-content");
  }, 15_000);
});
