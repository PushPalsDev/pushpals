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

afterEach(async () => {
  (Bun as any).spawn = originalSpawn;

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
    terminateProcessTreeImpl,
  });
  // These tests replace spawnWorker with deterministic fixtures. Keep the
  // scheduler under test independent of host-specific standalone launch assets.
  (orchestrator as any).autoSpawnWorkers = true;
  (orchestrator as any).workerpalsUnavailableReason = null;
  return orchestrator;
}

describe("RemoteBuddy worker autoscaling", () => {
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
