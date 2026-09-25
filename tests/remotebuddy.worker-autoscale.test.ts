import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannerOutput } from "../apps/remotebuddy/src/brain";
import { IdempotencyStore } from "../apps/remotebuddy/src/idempotency";
import { NoopSessionMemory } from "../apps/remotebuddy/src/memory";
import { RemoteBuddyOrchestrator } from "../apps/remotebuddy/src/remotebuddy_main";

const tempDirs: string[] = [];
const openStores: IdempotencyStore[] = [];
const originalSpawn = Bun.spawn;
const originalNow = Date.now;
const originalSleep = Bun.sleep;

afterEach(async () => {
  (Bun as any).spawn = originalSpawn;
  Date.now = originalNow;
  (Bun as any).sleep = originalSleep;

  while (openStores.length > 0) {
    try {
      openStores.pop()?.close();
    } catch {
      // best effort
    }
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 20; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await Bun.sleep(50 * attempt);
      }
    }
    if (lastError && existsSync(dir)) throw lastError;
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-remotebuddy-autoscale-"));
  tempDirs.push(dir);
  return dir;
}

function createWorkerPlan(): PlannerOutput {
  return {
    intent: "code_change",
    requires_worker: true,
    job_kind: "task.execute",
    lane: "worker",
    scope: {
      read_anywhere: true,
      write_allowed: true,
      write_globs: ["src/example.ts"],
      max_files_to_edit: 1,
    },
    discovery: {
      ripgrep_queries: ["example"],
    },
    acceptance_criteria: ["Ship the requested code change."],
    validation_steps: ["bun test"],
    risk_level: "low",
    assistant_message: "Delegating to a worker.",
    worker_instruction: "Update the targeted file.",
    user_message: "Update the targeted file.",
  };
}

function createOrchestrator(
  root: string,
  fetchImpl?: typeof fetch,
  terminateProcessTreeImpl?: (proc: any, options?: any) => Promise<void>,
): RemoteBuddyOrchestrator {
  mkdirSync(join(root, "outputs", "data"), { recursive: true });
  const idempotency = new IdempotencyStore(
    join(root, "outputs", "data", "remotebuddy-autoscale.db"),
  );
  openStores.push(idempotency);
  const orchestrator = new RemoteBuddyOrchestrator({
    server: "http://127.0.0.1:3001",
    sessionId: "dev",
    authToken: null,
    brain: {
      think: async () => createWorkerPlan(),
    } as any,
    llm: {} as any,
    idempotency,
    persistentMemory: new NoopSessionMemory(),
    jobsDbPath: join(root, "outputs", "data", "pushpals.db"),
    fetchImpl,
    terminateProcessTreeImpl: terminateProcessTreeImpl ?? (async () => {}),
  });
  // These tests replace spawnWorker with deterministic fixtures. Keep the
  // scheduler under test independent of host-specific standalone launch assets.
  (orchestrator as any).autoSpawnWorkers = true;
  (orchestrator as any).workerpalsUnavailableReason = null;
  (orchestrator as any).cleanupWorkerContainersImpl = async () => true;
  return orchestrator;
}

describe("RemoteBuddy worker autoscaling", () => {
  test("a prewarm fetch completing after disposal cannot spawn a worker", async () => {
    const orchestrator = createOrchestrator(makeTempDir());
    let releaseFetch!: (workers: unknown[]) => void;
    (orchestrator as any).fetchWorkers = () =>
      new Promise((resolve) => {
        releaseFetch = resolve;
      });
    let spawnCalls = 0;
    (Bun as any).spawn = () => {
      spawnCalls += 1;
      throw new Error("spawn after disposal");
    };
    const prewarm = orchestrator.ensureWorkerCapacityOnStartup();
    await orchestrator.dispose();
    releaseFetch([]);
    await prewarm;
    expect(spawnCalls).toBe(0);
    expect((orchestrator as any).managedWorkers.size).toBe(0);
    expect(await (orchestrator as any).spawnWorker()).toBeNull();
  });

  test("disposal joins in-flight startup termination and is idempotent", async () => {
    let exitChild!: (code: number) => void;
    let finishReadiness!: (ready: null) => void;
    const exited = new Promise<number>((resolve) => {
      exitChild = resolve;
    });
    let terminations = 0;
    const orchestrator = createOrchestrator(makeTempDir(), undefined, async () => {
      terminations += 1;
      exitChild(0);
    });
    (orchestrator as any).waitForOnlineWorker = () =>
      new Promise((resolve) => {
        finishReadiness = resolve;
      });
    (Bun as any).spawn = () => ({ pid: 12345, exited, stdout: null, stderr: null, kill() {} });
    const startup = (orchestrator as any).spawnWorker();
    const disposing = orchestrator.dispose();
    expect(orchestrator.dispose()).toBe(disposing);
    await disposing;
    finishReadiness(null);
    expect(await startup).toBeNull();
    expect(terminations).toBe(1);
    expect((orchestrator as any).managedWorkers.size).toBe(0);
  });

  test("failed Docker cleanup fences replacements and retries without signalling an exited PID", async () => {
    let terminations = 0;
    let cleanupCalls = 0;
    let cleanupSucceeds = false;
    let spawnCalls = 0;
    const orchestrator = createOrchestrator(makeTempDir(), undefined, async () => {
      terminations += 1;
    });
    const workerId = "workerpal-owned";
    const child = { pid: 12345, exited: Promise.resolve(0), kill() {} };
    (orchestrator as any).managedWorkers.set(workerId, child);
    (orchestrator as any).dockerManagedWorkers.add(workerId);
    (orchestrator as any).cleanupWorkerContainersImpl = async (repo: string, id: string) => {
      expect(repo).toBe((orchestrator as any).repo);
      expect(id).toBe(workerId);
      cleanupCalls += 1;
      return cleanupSucceeds;
    };
    (Bun as any).spawn = () => {
      spawnCalls += 1;
      throw new Error("replacement must remain blocked");
    };
    try {
      await expect(
        (orchestrator as any).terminateManagedWorkerProcess(workerId, child, "test timeout"),
      ).rejects.toThrow("cleanup could not be verified");
      expect((orchestrator as any).managedWorkers.has(workerId)).toBe(true);
      expect(await (orchestrator as any).spawnWorker()).toBeNull();
      expect(spawnCalls).toBe(0);
      expect(terminations).toBe(1);
      expect(cleanupCalls).toBe(2);
      expect((orchestrator as any).workerShutdownPending.has(workerId)).toBe(true);
      cleanupSucceeds = true;
      await (orchestrator as any).terminateManagedWorkerProcess(workerId, child, "retry cleanup");
      expect(terminations).toBe(1);
      expect(cleanupCalls).toBe(3);
      expect((orchestrator as any).managedWorkers.size).toBe(0);
      expect((orchestrator as any).workerShutdownPending.size).toBe(0);
      await (orchestrator as any).terminateManagedWorkerProcess(
        workerId,
        child,
        "already released",
      );
      expect(terminations).toBe(1);
      expect(cleanupCalls).toBe(3);
    } finally {
      cleanupSucceeds = true;
      await orchestrator.dispose();
    }
  });

  test("an unexpected readiness exception still cleans the spawned worker", async () => {
    let exitChild!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      exitChild = resolve;
    });
    let terminations = 0;
    let cleanups = 0;
    const orchestrator = createOrchestrator(makeTempDir(), undefined, async () => {
      terminations += 1;
      exitChild(0);
    });
    (orchestrator as any).spawnWorkerDocker = true;
    (orchestrator as any).cleanupWorkerContainersImpl = async () => {
      cleanups += 1;
      return true;
    };
    (orchestrator as any).waitForOnlineWorker = async () => {
      throw new Error("unexpected readiness failure");
    };
    (Bun as any).spawn = () => ({ pid: 12345, exited, stdout: null, stderr: null, kill() {} });
    try {
      expect(await (orchestrator as any).spawnWorker()).toBeNull();
      expect(terminations).toBe(1);
      expect(cleanups).toBe(1);
      expect((orchestrator as any).managedWorkers.size).toBe(0);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("natural worker exit cleans owned containers before a replacement starts", async () => {
    let releaseCleanup!: () => void;
    let cleanupStarted!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupEntered = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const exits: Array<(code: number) => void> = [];
    let spawns = 0;
    const firstSpawnTime = originalNow();
    Date.now = () => firstSpawnTime + spawns * 1_000;
    const orchestrator = createOrchestrator(makeTempDir());
    (orchestrator as any).spawnWorkerDocker = true;
    (orchestrator as any).waitForOnlineWorker = async (_timeout: number, workerId: string) => ({
      workerId,
      status: "idle",
      activeJobCount: 0,
    });
    (orchestrator as any).cleanupWorkerContainersImpl = async () => {
      cleanupStarted();
      await cleanupGate;
      return true;
    };
    (Bun as any).spawn = () => {
      spawns += 1;
      return {
        pid: 12345 + spawns,
        exited: new Promise<number>((resolve) => {
          exits.push(resolve);
        }),
        stdout: null,
        stderr: null,
        kill() {},
      };
    };
    try {
      const first = await (orchestrator as any).spawnWorker();
      exits[0](0);
      await cleanupEntered;
      expect((orchestrator as any).managedWorkers.has(first)).toBe(true);
      const replacement = (orchestrator as any).spawnWorker();
      await Promise.resolve();
      expect(spawns).toBe(1);
      releaseCleanup();
      expect(await replacement).toMatch(/^workerpal-/);
      expect(spawns).toBe(2);
      expect((orchestrator as any).managedWorkers.has(first)).toBe(false);
    } finally {
      Date.now = originalNow;
      releaseCleanup();
      for (const exit of exits) exit(0);
      await orchestrator.dispose();
    }
  });

  test("routes managed WorkerPal shutdown through process-tree termination", async () => {
    const terminations: Array<{ pid: number; options: Record<string, unknown> }> = [];
    const orchestrator = createOrchestrator(makeTempDir(), undefined, async (proc, options) => {
      terminations.push({ pid: proc.pid, options });
    });
    const proc = {
      pid: 4242,
      exited: Promise.resolve(0),
      kill() {},
    } as ReturnType<typeof Bun.spawn>;
    (orchestrator as any).managedWorkers.set("workerpal-tree", proc);
    const outputAbort = new AbortController();
    (orchestrator as any).workerOutputAborts.set("workerpal-tree", outputAbort);

    try {
      await (orchestrator as any).terminateManagedWorkerProcess(
        "workerpal-tree",
        proc,
        "test shutdown",
        1234,
      );

      expect(terminations).toEqual([
        {
          pid: 4242,
          options: { terminationTimeoutMs: 1234, exitGraceMs: 2_000 },
        },
      ]);
      expect((orchestrator as any).managedWorkers.has("workerpal-tree")).toBe(false);
      expect(outputAbort.signal.aborted).toBe(true);
      expect((orchestrator as any).workerOutputAborts.has("workerpal-tree")).toBe(false);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("bounds autoscale polling when response headers arrive but the body stalls", async () => {
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Deliberately leave the body stream open without producing data.
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const orchestrator = createOrchestrator(makeTempDir(), fetchImpl);
    const startedAt = Date.now();

    try {
      expect(await (orchestrator as any).fetchWorkerAutoscaleSnapshot(20)).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("maintains the configured warm pool floor", async () => {
    const spawnCalls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/workers/autoscale") {
        return new Response(
          JSON.stringify({
            ok: true,
            workers: { total: 1, online: 1, busy: 0, idle: 1 },
            jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
            prs: { openUnmerged: 0 },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch in test: ${url.pathname}`);
    }) as typeof fetch;
    const orchestrator = createOrchestrator(makeTempDir(), fetchImpl);
    (orchestrator as any).minWorkers = 3;
    (orchestrator as any).maxWorkers = 4;
    (orchestrator as any).spawnWorker = async () => {
      const workerId = `workerpal-${spawnCalls.length + 1}`;
      spawnCalls.push(workerId);
      return workerId;
    };

    try {
      await (orchestrator as any).ensureAutoscaledWorkerCapacity("test warm pool");
      expect(spawnCalls).toEqual(["workerpal-1", "workerpal-2"]);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("scales to claimable queued task.execute backlog up to maxWorkers", async () => {
    const spawnCalls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/workers/autoscale") {
        return new Response(
          JSON.stringify({
            ok: true,
            workers: { total: 1, online: 1, busy: 1, idle: 0 },
            jobs: { pending: 5, claimed: 1, autoscalablePending: 5 },
            prs: { openUnmerged: 0 },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch in test: ${url.pathname}`);
    }) as typeof fetch;
    const orchestrator = createOrchestrator(makeTempDir(), fetchImpl);
    (orchestrator as any).minWorkers = 1;
    (orchestrator as any).maxWorkers = 4;
    (orchestrator as any).spawnWorker = async () => {
      const workerId = `workerpal-${spawnCalls.length + 1}`;
      spawnCalls.push(workerId);
      return workerId;
    };

    try {
      await (orchestrator as any).ensureAutoscaledWorkerCapacity("test backlog");
      expect(spawnCalls).toEqual(["workerpal-1", "workerpal-2", "workerpal-3"]);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("prewarms a second worker when open PR backlog exists", async () => {
    const spawnCalls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/workers/autoscale") {
        return new Response(
          JSON.stringify({
            ok: true,
            workers: { total: 1, online: 1, busy: 0, idle: 1 },
            jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
            prs: { openUnmerged: 3 },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch in test: ${url.pathname}`);
    }) as typeof fetch;
    const orchestrator = createOrchestrator(makeTempDir(), fetchImpl);
    (orchestrator as any).minWorkers = 1;
    (orchestrator as any).maxWorkers = 4;
    (orchestrator as any).spawnWorker = async () => {
      const workerId = `workerpal-${spawnCalls.length + 1}`;
      spawnCalls.push(workerId);
      return workerId;
    };

    try {
      await (orchestrator as any).ensureAutoscaledWorkerCapacity("test pr backlog");
      expect(spawnCalls).toEqual(["workerpal-1"]);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("treats a freshly spawned busy worker as startup-ready", async () => {
    const orchestrator = createOrchestrator(makeTempDir());
    let waitForOnlineCalls = 0;
    (orchestrator as any).waitForOnlineWorker = async (_timeoutMs: number, workerId: string) => {
      waitForOnlineCalls += 1;
      return {
        workerId,
        status: "busy",
        currentJobId: "job-123",
        lastHeartbeat: new Date().toISOString(),
        pollMs: 2000,
        capabilities: {},
        details: {},
        activeJobCount: 1,
        isOnline: true,
      };
    };
    (orchestrator as any).waitForIdleWorker = async () => {
      throw new Error("spawnWorker should not wait for idle capacity");
    };
    (Bun as any).spawn = () =>
      ({
        pid: 12345,
        kill() {},
        exited: Promise.resolve(0),
      }) as any;

    try {
      const workerId = await (orchestrator as any).spawnWorker();
      expect(workerId).toMatch(/^workerpal-/);
      expect(waitForOnlineCalls).toBe(1);
      expect(String((orchestrator as any).workerpalsUnavailableReason ?? "")).toBe("");
    } finally {
      await orchestrator.dispose();
    }
  });

  test("starts initial WorkerPal prewarm without blocking RemoteBuddy startup", async () => {
    const orchestrator = createOrchestrator(makeTempDir());
    let prewarmStarted = false;
    let releasePrewarm!: () => void;
    const prewarmGate = new Promise<void>((resolve) => {
      releasePrewarm = resolve;
    });
    (orchestrator as any).ensureWorkerCapacityOnStartup = async () => {
      prewarmStarted = true;
      await prewarmGate;
    };

    try {
      (orchestrator as any).startWorkerCapacityPrewarmOnStartup();
      expect(prewarmStarted).toBe(true);
      expect((orchestrator as any).workerStartupPrewarmInFlight).toBeInstanceOf(Promise);
      releasePrewarm();
      await (orchestrator as any).workerStartupPrewarmInFlight;
      expect((orchestrator as any).workerStartupPrewarmInFlight).toBeNull();
    } finally {
      await orchestrator.dispose();
    }
  });

  test("request dispatch joins a quiet cold-build prewarm past the normal startup deadline", async () => {
    let clockMs = 0;
    let spawnCalls = 0;
    let workerId = "";
    let exitChild!: (code: number) => void;
    const childExited = new Promise<number>((resolve) => {
      exitChild = resolve;
    });
    const orchestrator = createOrchestrator(makeTempDir(), undefined, async () => exitChild(0));
    (orchestrator as any).spawnWorkerDocker = true;
    (orchestrator as any).workerStartupTimeoutMs = 120_000;
    (orchestrator as any).fetchWorkers = async () => {
      await Promise.resolve();
      return clockMs >= 150_000
        ? [{ workerId, isOnline: true, status: "idle", activeJobCount: 0 }]
        : [];
    };
    Date.now = () => clockMs;
    (Bun as any).sleep = async (ms: number) => {
      clockMs += ms;
      await Promise.resolve();
    };
    (Bun as any).spawn = (command: string[]) => {
      spawnCalls += 1;
      workerId = command[command.indexOf("--workerId") + 1];
      return {
        pid: 12345,
        kill() {},
        exited: childExited,
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '[WorkerPalStartup] {"phase":"docker-image-build","event":"start","timeoutMs":600000}\n',
              ),
            );
            // Deliberately leave the cold build completely quiet afterward.
          },
        }),
        stderr: null,
      };
    };

    try {
      const prewarm = (orchestrator as any).spawnWorker();
      const dispatch = (orchestrator as any).selectTargetWorkerForJob();
      expect(await prewarm).toBe(workerId);
      expect(await dispatch).toBe(workerId);
      expect(spawnCalls).toBe(1);
      expect(clockMs).toBeGreaterThanOrEqual(150_000);
      expect(clockMs).toBeLessThan(600_000);
      expect((orchestrator as any).workerpalsUnavailableReason).toBeNull();
    } finally {
      Date.now = originalNow;
      (Bun as any).sleep = originalSleep;
      await orchestrator.dispose();
    }
  });

  test("image progress alone never makes a worker online and startup still terminates", async () => {
    let clockMs = 0;
    let terminations = 0;
    let exitChild!: (code: number) => void;
    const childExited = new Promise<number>((resolve) => {
      exitChild = resolve;
    });
    const orchestrator = createOrchestrator(makeTempDir(), undefined, async () => {
      terminations += 1;
      exitChild(1);
    });
    (orchestrator as any).spawnWorkerDocker = true;
    (orchestrator as any).workerStartupTimeoutMs = 120_000;
    (orchestrator as any).fetchWorkers = async () => [
      { workerId: "unrelated-worker", isOnline: true, status: "idle", activeJobCount: 0 },
    ];
    Date.now = () => clockMs;
    (Bun as any).sleep = async (ms: number) => {
      clockMs += ms;
      await Promise.resolve();
    };
    (Bun as any).spawn = () => ({
      pid: 12345,
      kill() {},
      exited: childExited,
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '[WorkerPalStartup] {"phase":"docker-image-build","event":"start","timeoutMs":600000}\n',
            ),
          );
        },
      }),
      stderr: null,
    });

    try {
      expect(await (orchestrator as any).spawnWorker()).toBeNull();
      expect(terminations).toBe(1);
      expect(clockMs).toBeGreaterThanOrEqual(630_000);
      expect(clockMs).toBeLessThan(631_000);
      expect((orchestrator as any).managedWorkers.size).toBe(0);
    } finally {
      Date.now = originalNow;
      (Bun as any).sleep = originalSleep;
      await orchestrator.dispose();
    }
  });

  test("falls back from Docker WorkerPal after a Codex startup-stall recycle", async () => {
    const orchestrator = createOrchestrator(makeTempDir());
    (orchestrator as any).spawnWorkerDocker = true;
    (orchestrator as any).spawnWorkerRequireDocker = true;
    (orchestrator as any).workerSpawnCooldownUntil = Date.now() + 60_000;

    try {
      const activated = (orchestrator as any).maybeFallbackFromDockerAfterWorkerExit(
        "workerpal-stalled",
        87,
      );

      expect(activated).toBe(true);
      expect((orchestrator as any).spawnWorkerDocker).toBe(false);
      expect((orchestrator as any).spawnWorkerRequireDocker).toBe(false);
      expect((orchestrator as any).workerSpawnCooldownUntil).toBe(0);
      expect(String((orchestrator as any).workerpalsUnavailableReason)).toContain(
        "falling back to direct isolated-worktree WorkerPal",
      );
    } finally {
      await orchestrator.dispose();
    }
  });
});
