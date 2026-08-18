import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannerOutput } from "../apps/remotebuddy/src/brain";
import { IdempotencyStore } from "../apps/remotebuddy/src/idempotency";
import { NoopSessionMemory } from "../apps/remotebuddy/src/memory";
import { JobQueue } from "../apps/server/src/jobs";
import {
  buildTaskExecuteDedupeKey,
  buildTaskExecuteRequestDedupeKey,
  resolveTaskExecuteDedupeCooldownMs,
  type TaskExecuteJobParams,
  RemoteBuddyOrchestrator,
} from "../apps/remotebuddy/src/remotebuddy_main";

const tempDirs: string[] = [];
const openStores: IdempotencyStore[] = [];

afterEach(
  async () => {
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
  },
  { timeout: 20_000 },
);

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

function createAutonomyTaskParams(targetPaths: string[]): TaskExecuteJobParams {
  return {
    ...createUserTaskParams(targetPaths),
    origin: "autonomy",
    autonomy: { origin: "autonomy" },
  };
}

function createOrchestrator(root: string, fetchImpl?: typeof fetch): RemoteBuddyOrchestrator {
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
    fetchImpl,
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
      "task.execute:user:dev:request:req-test:components/__tests__/animatedselectionring.test.ts",
    );
  });

  test("buildTaskExecuteDedupeKey skips only broad tasks and keeps origin-specific keys", () => {
    const broad = createUserTaskParams(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    const autonomy = createAutonomyTaskParams([
      "components/__tests__/AnimatedSelectionRing.test.ts",
    ]);

    expect(buildTaskExecuteDedupeKey("dev", broad)).toBeNull();
    expect(buildTaskExecuteRequestDedupeKey("dev", broad)).toBe(
      "task.execute:user:dev:request:req-test:idempotent",
    );
    expect(buildTaskExecuteDedupeKey("dev", autonomy)).toBe(
      "task.execute:autonomy:dev:request:req-test:components/__tests__/animatedselectionring.test.ts",
    );
  });

  test("resolveTaskExecuteDedupeCooldownMs fences retry duplicates for every durable request", () => {
    const user = createUserTaskParams(["components/__tests__/AnimatedSelectionRing.test.ts"]);
    const autonomy = createAutonomyTaskParams([
      "components/__tests__/AnimatedSelectionRing.test.ts",
    ]);

    expect(resolveTaskExecuteDedupeCooldownMs(user, buildTaskExecuteDedupeKey("dev", user))).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(
      resolveTaskExecuteDedupeCooldownMs(autonomy, buildTaskExecuteDedupeKey("dev", autonomy)),
    ).toBe(24 * 60 * 60 * 1000);
    expect(resolveTaskExecuteDedupeCooldownMs(autonomy, null)).toBe(0);
  });

  test("never dedupes distinct requests that happen to target the same file", () => {
    const first = createAutonomyTaskParams(["tests/remotebuddy.task-dedupe.test.ts"]);
    const second: TaskExecuteJobParams = {
      ...first,
      requestId: "req-other",
      autonomy: {
        origin: "autonomy",
        objectiveId: "objective-other",
        validationIncident: {
          incidentId: "incident-shared",
          candidateSha: "candidate-other",
        },
      },
    };

    const firstKey = buildTaskExecuteDedupeKey("dev", first);
    const secondKey = buildTaskExecuteDedupeKey("dev", second);
    expect(firstKey).toContain(":request:req-test:");
    expect(secondKey).toContain(":request:req-other:");
    expect(firstKey).not.toBe(secondKey);
  });

  test("renews a planning lease without overlapping requests and stops cleanly", async () => {
    const root = makeTempDir();
    let renewCalls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/requests/req-heartbeat/lease/renew")) {
        throw new Error(`Unexpected fetch in test: ${url}`);
      }
      renewCalls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body).toMatchObject({
        agentId: "remotebuddy-orchestrator",
        claimToken: "claim-heartbeat",
        leaseMs: 60_000,
      });
      await Bun.sleep(8);
      inFlight -= 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);
    const stop = (orchestrator as any).startRequestLeaseHeartbeat(
      "req-heartbeat",
      "claim-heartbeat",
      {
        heartbeatMs: 2,
        leaseMs: 60_000,
        timeoutMs: 1_000,
      },
    ) as () => void;
    await Bun.sleep(35);
    stop();
    const callsAtStop = renewCalls;
    await Bun.sleep(15);

    expect(callsAtStop).toBeGreaterThanOrEqual(2);
    expect(renewCalls).toBe(callsAtStop);
    expect(maxInFlight).toBe(1);
    await orchestrator.dispose();
  });

  test("retries a lost terminal response and accepts the idempotent acknowledgement", async () => {
    const root = makeTempDir();
    let completeCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/requests/req-terminal-retry/complete")) {
        completeCalls += 1;
        if (completeCalls === 1) throw new Error("response lost after commit");
        return new Response(JSON.stringify({ ok: true, idempotent: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);
    try {
      const result = await (orchestrator as any).postRequestLifecycleTransition({
        requestId: "req-terminal-retry",
        transition: "complete",
        claimToken: "claim-terminal-retry",
        body: {
          agentId: "remotebuddy-orchestrator",
          claimToken: "claim-terminal-retry",
          result: { requiresWorker: false },
        },
      });
      expect(result).toEqual({ ok: true });
      expect(completeCalls).toBe(2);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("confirms committed terminal state when every callback response is lost", async () => {
    const root = makeTempDir();
    let completeCalls = 0;
    let stateCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/requests/req-terminal-state/complete")) {
        completeCalls += 1;
        throw new Error("callback response unavailable");
      }
      if (url.endsWith("/requests/req-terminal-state") && init?.method === "GET") {
        stateCalls += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            request: {
              status: "completed",
              agentId: "remotebuddy-orchestrator",
              claimToken: "claim-terminal-state",
              workerRequired: 0,
              handoffJobId: null,
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);
    try {
      const result = await (orchestrator as any).postRequestLifecycleTransition({
        requestId: "req-terminal-state",
        transition: "complete",
        claimToken: "claim-terminal-state",
        body: {
          agentId: "remotebuddy-orchestrator",
          claimToken: "claim-terminal-state",
          result: { requiresWorker: false },
        },
      });
      expect(result).toEqual({ ok: true, recoveredFromState: true });
      expect(completeCalls).toBe(3);
      expect(stateCalls).toBe(1);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("bounds lifecycle callbacks and state lookup when fetch ignores AbortSignal", async () => {
    const root = makeTempDir();
    const fetchImpl = (async () => new Promise<Response>(() => {})) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);
    const startedAt = Date.now();
    try {
      const result = await (orchestrator as any).postRequestLifecycleTransition({
        requestId: "req-never-settles",
        transition: "complete",
        claimToken: "claim-never-settles",
        body: {
          agentId: "remotebuddy-orchestrator",
          claimToken: "claim-never-settles",
          result: { requiresWorker: false },
        },
        attempts: 1,
        timeoutMs: 100,
        retryDelayMs: 0,
      });
      expect(result.ok).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("bounds stalled lifecycle error and durable-state response bodies", async () => {
    const root = makeTempDir();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 503,
          text: () => new Promise<string>(() => {}),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => {}),
      } as Response;
    }) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);
    const startedAt = Date.now();
    try {
      const result = await (orchestrator as any).postRequestLifecycleTransition({
        requestId: "req-stalled-response-body",
        transition: "complete",
        claimToken: "claim-stalled-response-body",
        body: {
          agentId: "remotebuddy-orchestrator",
          claimToken: "claim-stalled-response-body",
          result: { requiresWorker: false },
        },
        attempts: 1,
        timeoutMs: 100,
        retryDelayMs: 0,
      });
      expect(result.ok).toBe(false);
      expect(calls).toBe(2);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("processRequest sends dedupe cooldown for narrow autonomy job enqueue", async () => {
    const root = makeTempDir();
    const enqueueBodies: Array<Record<string, unknown>> = [];
    const requestTransitions: string[] = [];
    const targetPath = "tests/remotebuddy.task-dedupe.test.ts";

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/jobs/enqueue")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        enqueueBodies.push(body);
        return new Response(
          JSON.stringify({ ok: true, jobId: "job-auto-cooldown", taskId: body.taskId }),
          { status: 200 },
        );
      }
      if (url.endsWith("/requests/auto-cooldown/worker-handoff")) {
        requestTransitions.push("handoff");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/requests/auto-cooldown/complete")) {
        requestTransitions.push("complete");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);

    (orchestrator as any).ensureSessionWithRetry = async () => {};
    (orchestrator as any).ensureSessionEventMonitor = () => {};
    (orchestrator as any).getRecentJobContext = () => [];
    (orchestrator as any).selectTargetWorkerForJob = async () => "workerpal-1";
    (orchestrator as any).sendCommand = async () => {};
    (orchestrator as any).assistantMessage = async () => {};

    try {
      await (orchestrator as any).processRequest({
        id: "auto-cooldown",
        claimToken: "claim-auto-cooldown",
        sessionId: "dev",
        prompt: `Update ${targetPath} with focused contract coverage`,
        priority: "background",
        metadata: {
          origin: "autonomy",
          autonomy: {
            objectiveId: "obj-cooldown",
            runId: "run-cooldown",
            snapshotId: "snap-cooldown",
            patternKey: "pk-cooldown",
            componentArea: "tests/unit",
            targetPaths: [targetPath],
            writeGlobs: [targetPath],
          },
        },
        forceWorker: true,
        forceLane: "worker",
      });
    } finally {
      await orchestrator.dispose();
    }

    expect(enqueueBodies).toHaveLength(1);
    expect(enqueueBodies[0]?.dedupeKey).toBe(
      "task.execute:autonomy:dev:request:auto-cooldown:tests/remotebuddy.task-dedupe.test.ts",
    );
    expect(enqueueBodies[0]?.dedupeCooldownMs).toBe(24 * 60 * 60 * 1000);
    expect(enqueueBodies[0]).toMatchObject({
      requestAgentId: "remotebuddy-orchestrator",
      requestClaimToken: "claim-auto-cooldown",
    });
    expect(requestTransitions).toEqual(["handoff", "complete"]);
  }, 15000);

  test("recovers the same terminal job when the first enqueue response is lost", async () => {
    const root = makeTempDir();
    mkdirSync(join(root, "outputs", "data"), { recursive: true });
    const queue = new JobQueue(join(root, "outputs", "data", "enqueue-response-lost.db"));
    const enqueuePayloads: string[] = [];
    let enqueueCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/jobs/enqueue")) {
        enqueueCalls += 1;
        const serialized = String(init?.body ?? "");
        enqueuePayloads.push(serialized);
        const result = queue.enqueue(JSON.parse(serialized) as Record<string, unknown>);
        expect(result.ok).toBe(true);
        if (enqueueCalls === 1) {
          const claimed = queue.claim("worker-response-lost");
          expect(claimed.ok).toBe(true);
          expect(claimed.job?.id).toBe(result.jobId);
          expect(
            queue.complete(String(result.jobId), { summary: "completed before retry" }).ok,
          ).toBe(true);
          throw new Error("response lost after JobQueue committed the enqueue");
        }
        return new Response(JSON.stringify(result), { status: 201 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);
    const broadParams = createUserTaskParams(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    broadParams.requestId = "req-enqueue-response-lost";
    let jobCounts: ReturnType<JobQueue["countByStatus"]> | null = null;

    try {
      const result = await (orchestrator as any).enqueueJob(
        "task-enqueue-response-lost",
        "task.execute",
        "dev",
        broadParams,
        "workerpal-1",
        "claim-enqueue-response-lost",
      );
      expect(result).toMatchObject({ deduped: true });
      jobCounts = queue.countByStatus();
    } finally {
      await orchestrator.dispose();
      queue.close();
    }

    expect(enqueueCalls).toBe(2);
    expect(enqueuePayloads[1]).toBe(enqueuePayloads[0]);
    expect(JSON.parse(enqueuePayloads[0] ?? "{}").dedupeKey).toBe(
      "task.execute:user:dev:request:req-enqueue-response-lost:idempotent",
    );
    expect(JSON.parse(enqueuePayloads[0] ?? "{}").dedupeCooldownMs).toBe(24 * 60 * 60 * 1000);
    expect(jobCounts).toMatchObject({ completed: 1, pending: 0, claimed: 0, finalizing: 0 });
    expect(Object.values(jobCounts ?? {}).reduce((sum, count) => sum + count, 0)).toBe(1);
  }, 15_000);

  test("leaves the request recoverable when every enqueue acknowledgement is ambiguous", async () => {
    const root = makeTempDir();
    let enqueueCalls = 0;
    let failCalls = 0;
    const assistantMessages: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/jobs/enqueue")) {
        enqueueCalls += 1;
        throw new Error("connection closed before enqueue acknowledgement");
      }
      if (url.endsWith("/requests/req-enqueue-ambiguous/fail")) {
        failCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);
    (orchestrator as any).ensureSessionWithRetry = async () => {};
    (orchestrator as any).ensureSessionEventMonitor = () => {};
    (orchestrator as any).getRecentJobContext = () => [];
    (orchestrator as any).selectTargetWorkerForJob = async () => "workerpal-1";
    (orchestrator as any).sendCommand = async () => {};
    (orchestrator as any).assistantMessage = async (_sessionId: string, text: string) => {
      assistantMessages.push(text);
    };

    try {
      await (orchestrator as any).processRequest({
        id: "req-enqueue-ambiguous",
        claimToken: "claim-enqueue-ambiguous",
        sessionId: "dev",
        prompt: "Update tests/remotebuddy.task-dedupe.test.ts",
      });
    } finally {
      await orchestrator.dispose();
    }

    expect(enqueueCalls).toBe(3);
    expect(failCalls).toBe(0);
    expect(assistantMessages.some((message) => message.includes("preserving the request"))).toBe(
      true,
    );
  }, 15_000);

  test("bounds enqueue when fetch ignores AbortSignal", async () => {
    const root = makeTempDir();
    const fetchImpl = (async () => new Promise<Response>(() => {})) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);
    const startedAt = Date.now();
    try {
      const result = await (orchestrator as any).enqueueJob(
        "task-never-settles",
        "task.execute",
        "dev",
        createUserTaskParams([]),
        null,
        "claim-never-settles",
        { attempts: 1, timeoutMs: 100, retryDelayMs: 0 },
      );
      expect(result).toMatchObject({ ambiguous: true });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("bounds enqueue when the success response body never settles", async () => {
    const root = makeTempDir();
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Headers arrive, but the response body never finishes.
          },
        }),
        { status: 201 },
      )) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);
    const startedAt = Date.now();
    try {
      const result = await (orchestrator as any).enqueueJob(
        "task-stalled-response-body",
        "task.execute",
        "dev",
        createUserTaskParams([]),
        null,
        "claim-stalled-response-body",
        { attempts: 1, timeoutMs: 100, retryDelayMs: 0 },
      );
      expect(result).toMatchObject({ ambiguous: true });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await orchestrator.dispose();
    }
  });

  test("does not let an analysis classification downgrade a durable autonomy worker request", async () => {
    const root = makeTempDir();
    const requestTransitions: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/requests/auto-analysis/worker-handoff")) {
        requestTransitions.push("handoff");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/requests/auto-analysis/complete")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          result?: Record<string, unknown>;
        };
        expect(body.result?.requiresWorker).toBe(true);
        requestTransitions.push("complete");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);
    (orchestrator as any).brain = {
      think: async () => ({
        ...createWorkerPlan(),
        intent: "analysis",
        requires_worker: false,
        job_kind: "none",
      }),
    };
    (orchestrator as any).ensureSessionWithRetry = async () => {};
    (orchestrator as any).ensureSessionEventMonitor = () => {};
    (orchestrator as any).getRecentJobContext = () => [];
    (orchestrator as any).selectTargetWorkerForJob = async () => "workerpal-1";
    (orchestrator as any).sendCommand = async () => {};
    (orchestrator as any).assistantMessage = async () => {};
    let enqueueCalls = 0;
    (orchestrator as any).enqueueJob = async (taskId: string) => {
      enqueueCalls += 1;
      return { jobId: "job-auto-analysis", taskId, deduped: false };
    };

    try {
      await (orchestrator as any).processRequest({
        id: "auto-analysis",
        claimToken: "claim-auto-analysis",
        sessionId: "dev",
        prompt: "Inspect and repair tests/remotebuddy.task-dedupe.test.ts",
        priority: "background",
        forceWorker: true,
        forceLane: "worker",
        metadata: {
          origin: "autonomy",
          autonomy: {
            objectiveId: "obj-analysis",
            runId: "run-analysis",
            snapshotId: "snap-analysis",
            patternKey: "pattern-analysis",
            componentArea: "tests/unit",
            targetPaths: ["tests/remotebuddy.task-dedupe.test.ts"],
            writeGlobs: ["tests/remotebuddy.task-dedupe.test.ts"],
          },
        },
      });
    } finally {
      await orchestrator.dispose();
    }

    expect(enqueueCalls).toBe(1);
    expect(requestTransitions).toEqual(["handoff", "complete"]);
  }, 15_000);

  test("processRequest does not create an orphan task when enqueue fails", async () => {
    const root = makeTempDir();
    const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const assistantMessages: string[] = [];
    const requestTransitions: string[] = [];

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/requests/req-fail/fail")) {
        requestTransitions.push("failed");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);

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
    (orchestrator as any).assistantMessage = async (_sessionId: string, text: string) => {
      assistantMessages.push(text);
    };
    (orchestrator as any).enqueueJob = async () => null;

    try {
      await (orchestrator as any).processRequest({
        id: "req-fail",
        claimToken: "claim-req-fail",
        sessionId: "dev",
        prompt: "Update components/__tests__/AnimatedSelectionRing.test.ts for cooldown behavior",
      });
    } finally {
      await orchestrator.dispose();
    }

    expect(commands.some((command) => command.type === "task_created")).toBe(false);
    expect(commands.some((command) => command.type === "task_started")).toBe(false);
    expect(assistantMessages.some((message) => message.includes("No task was started"))).toBe(true);
    expect(requestTransitions).toEqual(["failed"]);
  }, 15000);

  test("does not report planning failure after a durable job survives callback uncertainty", async () => {
    const root = makeTempDir();
    const assistantMessages: string[] = [];
    let handoffCalls = 0;
    let failCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/requests/req-durable-callback/worker-handoff")) {
        handoffCalls += 1;
        return new Response("temporarily unavailable", { status: 503 });
      }
      if (url.endsWith("/requests/req-durable-callback") && init?.method === "GET") {
        return new Response(
          JSON.stringify({
            ok: true,
            request: {
              status: "claimed",
              agentId: "remotebuddy-orchestrator",
              claimToken: "claim-durable-callback",
              workerRequired: 0,
              handoffJobId: null,
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/requests/req-durable-callback/fail")) {
        failCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    const orchestrator = createOrchestrator(root, fetchImpl);
    (orchestrator as any).brain = { think: async () => createWorkerPlan() };
    (orchestrator as any).ensureSessionWithRetry = async () => {};
    (orchestrator as any).ensureSessionEventMonitor = () => {};
    (orchestrator as any).getRecentJobContext = () => [];
    (orchestrator as any).selectTargetWorkerForJob = async () => "workerpal-1";
    (orchestrator as any).sendCommand = async () => {};
    (orchestrator as any).assistantMessage = async (_sessionId: string, text: string) => {
      assistantMessages.push(text);
    };
    (orchestrator as any).enqueueJob = async (taskId: string) => ({
      jobId: "job-durable-callback",
      taskId,
      deduped: false,
    });

    try {
      await (orchestrator as any).processRequest({
        id: "req-durable-callback",
        claimToken: "claim-durable-callback",
        sessionId: "dev",
        prompt: "Update tests/remotebuddy.task-dedupe.test.ts",
      });
    } finally {
      await orchestrator.dispose();
    }

    expect(handoffCalls).toBe(3);
    expect(failCalls).toBe(0);
    expect(assistantMessages.some((message) => message.includes("planning failed"))).toBe(false);
  }, 15_000);
});
