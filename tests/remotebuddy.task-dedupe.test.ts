import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannerOutput } from "../apps/remotebuddy/src/brain";
import { IdempotencyStore } from "../apps/remotebuddy/src/idempotency";
import { NoopSessionMemory } from "../apps/remotebuddy/src/memory";
import {
  buildTaskExecuteDedupeKey,
  type TaskExecuteJobParams,
  RemoteBuddyOrchestrator,
} from "../apps/remotebuddy/src/remotebuddy_main";

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
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await Bun.sleep(50 * attempt);
      }
    }
    if (lastError) throw lastError;
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-remotebuddy-dedupe-"));
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
      write_globs: ["components/__tests__/AnimatedSelectionRing.test.ts"],
      max_files_to_edit: 1,
    },
    discovery: {
      ripgrep_queries: ["AnimatedSelectionRing.test.ts"],
    },
    acceptance_criteria: ["Update the requested test coverage."],
    validation_steps: ["bun test components/__tests__/AnimatedSelectionRing.test.ts"],
    risk_level: "low",
    assistant_message: "Delegating to a worker.",
    worker_instruction: "Update the targeted test file.",
    user_message: "Update AnimatedSelectionRing test coverage.",
  };
}

function createUserTaskParams(targetPaths: string[]): TaskExecuteJobParams {
  return {
    schemaVersion: 2,
    requestId: "req-test",
    sessionId: "dev",
    instruction: "Update the file.",
    lane: "worker",
    planning: {
      intent: "code_change",
      riskLevel: "low",
      targetPaths,
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: [...targetPaths],
        maxFilesToEdit: 1,
      },
      acceptanceCriteria: ["Ship the requested update."],
      validationSteps: ["bun test"],
      queuePriority: "normal",
      queueWaitBudgetMs: 90_000,
      executionBudgetMs: 900_000,
      finalizationBudgetMs: 120_000,
    },
    recentContext: [],
    recentJobs: [],
    origin: "user",
  };
}

function createOrchestrator(root: string): RemoteBuddyOrchestrator {
  mkdirSync(join(root, "outputs", "data"), { recursive: true });
  const idempotency = new IdempotencyStore(join(root, "outputs", "data", "remotebuddy-dedupe.db"));
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

describe("RemoteBuddy task.execute dedupe", () => {
  test("buildTaskExecuteDedupeKey stays stable for narrow user target paths", () => {
    const params = createUserTaskParams([
      "components/__tests__/AnimatedSelectionRing.test.ts",
      "components/__tests__/AnimatedSelectionRing.test.ts",
    ]);

    const dedupeKey = buildTaskExecuteDedupeKey("Dev", params);

    expect(dedupeKey).toBe(
      "task.execute:user:dev:components/__tests__/animatedselectionring.test.ts",
    );
  });

  test("buildTaskExecuteDedupeKey skips broad or non-user tasks", () => {
    const broad = createUserTaskParams([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
      "e.ts",
    ]);
    const autonomy: TaskExecuteJobParams = {
      ...createUserTaskParams(["components/__tests__/AnimatedSelectionRing.test.ts"]),
      origin: "autonomy",
      autonomy: { origin: "autonomy" },
    };

    expect(buildTaskExecuteDedupeKey("dev", broad)).toBeNull();
    expect(buildTaskExecuteDedupeKey("dev", autonomy)).toBeNull();
  });

  test("processRequest reuses the existing task when enqueue dedupes same-file work", async () => {
    const root = makeTempDir();
    const orchestrator = createOrchestrator(root);
    const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const assistantMessages: string[] = [];
    const requestCompletions: Array<Record<string, unknown>> = [];
    let firstTaskId = "";
    let enqueueCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/requests/req-1/complete") || url.endsWith("/requests/req-2/complete")) {
        requestCompletions.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;

    (orchestrator as any).ensureSessionWithRetry = async () => {};
    (orchestrator as any).ensureSessionEventMonitor = () => {};
    (orchestrator as any).getRecentJobContext = () => [];
    (orchestrator as any).selectTargetWorkerForJob = async () => "workerpal-1";
    (orchestrator as any).sendCommand = async (
      _sessionId: string,
      command: { type: string; payload: Record<string, unknown> },
    ) => {
      commands.push(command);
    };
    (orchestrator as any).assistantMessage = async (
      _sessionId: string,
      text: string,
    ) => {
      assistantMessages.push(text);
    };
    (orchestrator as any).enqueueJob = async (
      taskId: string,
    ) => {
      enqueueCount += 1;
      if (enqueueCount === 1) {
        firstTaskId = taskId;
        return { jobId: "job-1", taskId, deduped: false };
      }
      return { jobId: "job-1", taskId: firstTaskId, deduped: true };
    };

    try {
      await (orchestrator as any).processRequest({
        id: "req-1",
        sessionId: "dev",
        prompt: "Update components/__tests__/AnimatedSelectionRing.test.ts to cover charge state",
      });
      await (orchestrator as any).processRequest({
        id: "req-2",
        sessionId: "dev",
        prompt: "Extend components/__tests__/AnimatedSelectionRing.test.ts with charge-state assertions",
      });
    } finally {
      await orchestrator.dispose();
    }

    const taskCreated = commands.filter((command) => command.type === "task_created");
    const taskStarted = commands.filter((command) => command.type === "task_started");
    const jobEnqueued = commands.filter((command) => command.type === "job_enqueued");
    const taskProgress = commands.filter((command) => command.type === "task_progress");

    expect(taskCreated).toHaveLength(1);
    expect(taskStarted).toHaveLength(1);
    expect(jobEnqueued).toHaveLength(1);
    expect(taskProgress).toHaveLength(2);
    expect(String(taskProgress[0]?.payload.taskId ?? "")).toBe(firstTaskId);
    expect(String(taskProgress[1]?.payload.taskId ?? "")).toBe(firstTaskId);
    expect(String(taskProgress[1]?.payload.message ?? "")).toContain("Reused active WorkerPal task");
    expect(assistantMessages.some((message) => message.includes("Reusing that task"))).toBe(true);
    expect(requestCompletions).toHaveLength(2);
  });

  test("processRequest does not create an orphan task when enqueue fails", async () => {
    const root = makeTempDir();
    const orchestrator = createOrchestrator(root);
    const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const assistantMessages: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/requests/req-fail/complete")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;

    (orchestrator as any).ensureSessionWithRetry = async () => {};
    (orchestrator as any).ensureSessionEventMonitor = () => {};
    (orchestrator as any).getRecentJobContext = () => [];
    (orchestrator as any).selectTargetWorkerForJob = async () => "workerpal-1";
    (orchestrator as any).sendCommand = async (
      _sessionId: string,
      command: { type: string; payload: Record<string, unknown> },
    ) => {
      commands.push(command);
    };
    (orchestrator as any).assistantMessage = async (
      _sessionId: string,
      text: string,
    ) => {
      assistantMessages.push(text);
    };
    (orchestrator as any).enqueueJob = async () => null;

    try {
      await (orchestrator as any).processRequest({
        id: "req-fail",
        sessionId: "dev",
        prompt: "Update components/__tests__/AnimatedSelectionRing.test.ts for cooldown behavior",
      });
    } finally {
      await orchestrator.dispose();
    }

    expect(commands.some((command) => command.type === "task_created")).toBe(false);
    expect(commands.some((command) => command.type === "task_started")).toBe(false);
    expect(assistantMessages.some((message) => message.includes("No task was started"))).toBe(true);
  });
});
