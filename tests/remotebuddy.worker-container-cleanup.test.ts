import { describe, expect, test } from "bun:test";
import { runBoundedProcess, type BoundedProcessResult } from "shared";
import { cleanupOwnedWorkerContainers } from "../apps/remotebuddy/src/worker_container_cleanup";

const REPO = "C:/workspace/my repo";
const WORKER = "workerpal-owned123";
const WARM = "a".repeat(64);
const SELFCHECK = "b".repeat(64);

function result(stdout = "", overrides: Partial<BoundedProcessResult> = {}): BoundedProcessResult {
  return {
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutDecodeError: false,
    stderrDecodeError: false,
    exitCode: 0,
    timedOut: false,
    drainTimedOut: false,
    ...overrides,
  };
}

function inspected(id: string, component: string, labels: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Id: id,
    Labels: {
      "pushpals.repo": REPO,
      "pushpals.worker_id": WORKER,
      "pushpals.component": component,
      ...labels,
    },
  });
}

function fixture(results: Array<BoundedProcessResult | Error>) {
  const calls: Array<{ argv: string[]; options: Parameters<typeof runBoundedProcess>[1] }> = [];
  const run: typeof runBoundedProcess = async (argv, options) => {
    calls.push({ argv, options });
    const next = results.shift();
    if (!next) throw new Error("Unexpected cleanup command");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, run };
}

describe("RemoteBuddy exact-owned WorkerPal container cleanup", () => {
  test("treats verified absence as success and scopes both component queries", async () => {
    const { calls, run } = fixture([result(), result()]);
    expect(
      await cleanupOwnedWorkerContainers(REPO, WORKER, { run, env: {}, platform: "linux" }),
    ).toBe(true);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.argv.slice(0, 4)).toEqual(["docker", "ps", "-aq", "--no-trunc"]);
      expect(call.argv).toContain(`label=pushpals.repo=${REPO}`);
      expect(call.argv).toContain(`label=pushpals.worker_id=${WORKER}`);
      expect(call.options.timeoutMs).toBeLessThanOrEqual(3_000);
      expect(call.options.streamDrainTimeoutMs).toBe(250);
      expect(call.options.outputLimitBytes).toBe(64 * 1024);
    }
    expect(calls[0].argv).toContain("label=pushpals.component=workerpals-warm");
    expect(calls[1].argv).toContain("label=pushpals.component=workerpals-selfcheck");
  });

  test("revalidates every full ID and all labels before deleting only explicit IDs", async () => {
    const { calls, run } = fixture([
      result(WARM),
      result(SELFCHECK),
      result(
        [inspected(WARM, "workerpals-warm"), inspected(SELFCHECK, "workerpals-selfcheck")].join(
          "\n",
        ),
      ),
      result(),
      result(),
      result(),
    ]);
    expect(
      await cleanupOwnedWorkerContainers(REPO, WORKER, { run, env: {}, platform: "linux" }),
    ).toBe(true);
    expect(calls[2].argv).toEqual([
      "docker",
      "container",
      "inspect",
      "--format",
      '{"Id":{{json .Id}},"Labels":{{json .Config.Labels}}}',
      WARM,
      SELFCHECK,
    ]);
    expect(calls[3].argv).toEqual(["docker", "rm", "-f", WARM, SELFCHECK]);
    expect(calls).toHaveLength(6);
  });

  test.each([
    { "pushpals.repo": "C:/another-repo" },
    { "pushpals.worker_id": "workerpal-someone-else" },
    { "pushpals.component": "unrelated" },
    { "pushpals.component": "workerpals-selfcheck" },
    { "pushpals.repo": null },
  ])("refuses deletion when inspected ownership disagrees: %j", async (labels) => {
    const { calls, run } = fixture([
      result(WARM),
      result(),
      result(inspected(WARM, "workerpals-warm", labels)),
    ]);
    expect(await cleanupOwnedWorkerContainers(REPO, WORKER, { run })).toBe(false);
    expect(calls.some(({ argv }) => argv.includes("rm"))).toBe(false);
  });

  test.each(["a".repeat(12), "--all", "CONTAINER ID", `${WARM}\n${WARM}`])(
    "rejects malformed, shortened or duplicate discovery IDs: %s",
    async (stdout) => {
      const { calls, run } = fixture([result(stdout)]);
      expect(await cleanupOwnedWorkerContainers(REPO, WORKER, { run })).toBe(false);
      expect(calls).toHaveLength(1);
    },
  );

  test.each(["not-json", "null", "[]", "{}", inspected(SELFCHECK, "workerpals-warm")])(
    "rejects malformed inspection and unrequested IDs: %s",
    async (stdout) => {
      const { calls, run } = fixture([result(WARM), result(), result(stdout)]);
      expect(await cleanupOwnedWorkerContainers(REPO, WORKER, { run })).toBe(false);
      expect(calls).toHaveLength(3);
    },
  );

  test.each([
    "timedOut",
    "drainTimedOut",
    "stdoutTruncated",
    "stderrTruncated",
    "stdoutDecodeError",
    "stderrDecodeError",
    "stdoutReadError",
    "stderrReadError",
  ] as const)("fails closed on %s, even when discovery output appears empty", async (flag) => {
    const { calls, run } = fixture([result("", { [flag]: true })]);
    expect(await cleanupOwnedWorkerContainers(REPO, WORKER, { run })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("refuses success if post-removal verification still finds an owned container", async () => {
    const { run } = fixture([
      result(WARM),
      result(),
      result(inspected(WARM, "workerpals-warm")),
      result(),
      result(WARM),
      result(),
    ]);
    expect(await cleanupOwnedWorkerContainers(REPO, WORKER, { run })).toBe(false);
  });

  test.each(["", `${WARM}\n`])(
    "a real capture with failed empty/partial stream cannot authorize cleanup: %s",
    async (prefix) => {
      let calls = 0;
      let sentPrefix = false;
      const run: typeof runBoundedProcess = (argv, options) => {
        calls += 1;
        return runBoundedProcess(argv, {
          ...options,
          spawn: () => ({
            pid: 0,
            stdout: new ReadableStream<Uint8Array>({
              pull(controller) {
                if (prefix && !sentPrefix) {
                  sentPrefix = true;
                  controller.enqueue(new TextEncoder().encode(prefix));
                  return;
                }
                controller.error(new Error("Docker listing pipe failed"));
              },
            }),
            stderr: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            }),
            exited: Promise.resolve(0),
            kill() {},
          }),
          terminate: async () => {},
        });
      };
      expect(await cleanupOwnedWorkerContainers(REPO, WORKER, { run })).toBe(false);
      expect(calls).toBe(1);
    },
  );

  test("allows a concurrently vanished inspected container only after verified absence", async () => {
    const { calls, run } = fixture([
      result(WARM),
      result(),
      result("", { exitCode: 1, stderr: `Error: No such object: ${WARM}` }),
      result(),
      result(),
    ]);
    expect(await cleanupOwnedWorkerContainers(REPO, WORKER, { run })).toBe(true);
    expect(calls.some(({ argv }) => argv.includes("rm"))).toBe(false);
  });

  test("allows a concurrently vanished removal target only after verified absence", async () => {
    const { run } = fixture([
      result(WARM),
      result(),
      result(inspected(WARM, "workerpals-warm")),
      result("", { exitCode: 1, stderr: `Error response from daemon: No such container: ${WARM}` }),
      result(),
      result(),
    ]);
    expect(await cleanupOwnedWorkerContainers(REPO, WORKER, { run })).toBe(true);
  });

  test.each(["permission denied", `Error: No such object: ${SELFCHECK}`])(
    "does not treat an unexpected inspect error as verified absence: %s",
    async (stderr) => {
      const { calls, run } = fixture([result(WARM), result(), result("", { exitCode: 1, stderr })]);
      expect(await cleanupOwnedWorkerContainers(REPO, WORKER, { run })).toBe(false);
      expect(calls).toHaveLength(3);
    },
  );

  test("does not report success when the shared deadline expires during final verification", async () => {
    let nowMs = 0;
    let calls = 0;
    const run: typeof runBoundedProcess = async () => {
      calls += 1;
      if (calls === 2) nowMs = 30_000;
      return result();
    };
    expect(await cleanupOwnedWorkerContainers(REPO, WORKER, { run, now: () => nowMs })).toBe(false);
    expect(calls).toBe(2);
  });

  test("bounds a hung runner and prevents a late result from starting another command", async () => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    let finish!: (value: BoundedProcessResult) => void;
    const run: typeof runBoundedProcess = async (_argv, options) => {
      calls += 1;
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    expect(await cleanupOwnedWorkerContainers(REPO, WORKER, { run, timeoutMs: 5 })).toBe(false);
    expect(signal?.aborted).toBe(true);
    finish(result(WARM));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  test("matches the worker Docker executable override and fails closed on runner errors", async () => {
    const { calls, run } = fixture([new Error("spawn failed")]);
    expect(
      await cleanupOwnedWorkerContainers(REPO, WORKER, {
        run,
        env: {
          PUSHPALS_DOCKER_BIN_ABSOLUTE: "C:/Docker/docker.exe",
          PUSHPALS_DOCKER_BIN: "ignored",
        },
      }),
    ).toBe(false);
    expect(calls[0].argv[0]).toBe("C:/Docker/docker.exe");
  });

  test("refuses invalid ownership inputs before invoking Docker", async () => {
    const { calls, run } = fixture([]);
    expect(await cleanupOwnedWorkerContainers("", WORKER, { run })).toBe(false);
    expect(await cleanupOwnedWorkerContainers(REPO, "--all", { run })).toBe(false);
    expect(
      await cleanupOwnedWorkerContainers(REPO, WORKER, {
        run,
        timeoutMs: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
