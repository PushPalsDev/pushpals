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
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;

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

function createOrchestrator(root: string): RemoteBuddyOrchestrator {
  mkdirSync(join(root, "outputs", "data"), { recursive: true });
  const idempotency = new IdempotencyStore(
    join(root, "outputs", "data", "remotebuddy-autoscale.db"),
  );
  openStores.push(idempotency);
  return new RemoteBuddyOrchestrator({
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
  });
}

describe("RemoteBuddy worker autoscaling", () => {
  test("maintains the configured warm pool floor", async () => {
    const orchestrator = createOrchestrator(makeTempDir());
    const spawnCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/workers/autoscale") {
        return new Response(
          JSON.stringify({
            ok: true,
            workers: { total: 1, online: 1, busy: 0, idle: 1 },
            jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch in test: ${url.pathname}`);
    }) as typeof fetch;
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
    const orchestrator = createOrchestrator(makeTempDir());
    const spawnCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/workers/autoscale") {
        return new Response(
          JSON.stringify({
            ok: true,
            workers: { total: 1, online: 1, busy: 1, idle: 0 },
            jobs: { pending: 5, claimed: 1, autoscalablePending: 5 },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch in test: ${url.pathname}`);
    }) as typeof fetch;
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
});
