import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { BackendTaskExecutor } from "../../apps/workerpals/src/backends/types";
import {
  getBackendTaskExecutor,
  registerBackendTaskExecutor,
} from "../../apps/workerpals/src/backends/task_execute_registry";
import type { WorkerpalsRuntimeConfig } from "../../apps/workerpals/src/common/executor_backend";
import { executeJob } from "../../apps/workerpals/src/execute_job";
import { loadPushPalsConfig } from "../../packages/shared/src/config";

const TEST_BACKEND = "miniswe";
const QUEUE_SEED_SUMMARY = "queue:baseline";
const QUEUE_FIXTURES = {
  baseline: [QUEUE_SEED_SUMMARY],
  success: ["queue:apply-scope", "queue:cleanup"],
  failure: ["fail:queue-empty"],
} as const;

type QueueFixtureName = keyof typeof QUEUE_FIXTURES;

function seedQueueFixture(queue: string[], fixture: QueueFixtureName): void {
  queue.splice(0, queue.length, ...QUEUE_FIXTURES[fixture]);
}

const repoFixtureRoot = mkdtempSync(join(tmpdir(), "task-exec-repo-"));
mkdirSync(join(repoFixtureRoot, "docs"), { recursive: true });
writeFileSync(join(repoFixtureRoot, "README.md"), "# WorkerPal task.execute fixture\n");
writeFileSync(join(repoFixtureRoot, "docs", "architecture.md"), "# Fixture doc\n");

const baseRuntimeConfig = loadPushPalsConfig({ reload: true });
let harness: ExecutorHarness;
let originalExecutor: BackendTaskExecutor | undefined;

describe("task.execute integration harness", () => {
  beforeAll(() => {
    originalExecutor = getBackendTaskExecutor(TEST_BACKEND);
  });

  beforeEach(() => {
    // Recreate the deterministic harness + queue stub so each test starts fresh.
    harness = createExecutorHarness(createDeterministicClock());
    harness.reset();
    seedQueueFixture(harness.queue, "baseline");
    registerBackendTaskExecutor(TEST_BACKEND, harness.handler);
  });

  afterEach(() => {
    // Flush queue/timer/mocks (including the deterministic clock) to avoid leakage.
    harness.reset();
  });

  afterAll(() => {
    if (originalExecutor) {
      registerBackendTaskExecutor(TEST_BACKEND, originalExecutor);
    }
    rmSync(repoFixtureRoot, { recursive: true, force: true });
  });

  test("uses deterministic stubbed queue entries to isolate backend calls", async () => {
    seedQueueFixture(harness.queue, "success");

    const params = createTaskExecuteParams({
      instruction: "Document deterministic queue behavior",
    });
    const runtime = createRuntimeConfig();
    const logs = createLogSink();

    const result = await executeJob("task.execute", params, repoFixtureRoot, logs.capture, runtime);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(QUEUE_FIXTURES.success[0]);
    expect(harness.calls.length).toBe(1);
    expect(asPlanning(harness.calls[0].params.planning)?.queuePriority).toBe("normal");
    expect(logs.stdout.join("\n")).toContain(`[stub-backend] ${QUEUE_FIXTURES.success[0]}`);
    expect(harness.timers).toEqual([1]);
  });

  test("resets task queue and timers between tests to avoid flakiness", async () => {
    expect([...harness.queue]).toEqual([...QUEUE_FIXTURES.baseline]);

    seedQueueFixture(harness.queue, "failure");

    const runtime = createRuntimeConfig();
    const logs = createLogSink();
    const params = createTaskExecuteParams({
      instruction: "Surface queue reset diagnostics",
    });

    const result = await executeJob("task.execute", params, repoFixtureRoot, logs.capture, runtime);

    expect(result.ok).toBe(false);
    expect(result.summary).toBe(QUEUE_FIXTURES.failure[0]);
    expect(harness.queue.length).toBe(0);
    expect(harness.timers).toEqual([1]);
    expect(logs.stderr.join("\n")).toContain(`[stub-backend] ${QUEUE_FIXTURES.failure[0]}`);
    expect(String(harness.calls[0].params.instruction)).toContain("Surface queue reset diagnostics");
  });
});

interface TaskExecutePlanningInput {
  intent: "chat" | "status" | "code_change" | "analysis" | "other";
  riskLevel: "low" | "medium" | "high";
  targetPaths?: string[];
  scope: {
    readAnywhere: boolean;
    writeAllowed: boolean;
    writeGlobs?: string[];
    forbiddenGlobs?: string[];
    maxFilesToEdit?: number;
  };
  discovery?: {
    ripgrepQueries: string[];
    likelyDirs?: string[];
    keywords?: string[];
  };
  acceptanceCriteria: string[];
  validationSteps: string[];
  queuePriority: "interactive" | "normal" | "background";
  queueWaitBudgetMs: number;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
}

type PlanningOverrides = Partial<Omit<TaskExecutePlanningInput, "scope" | "discovery">> & {
  scope?: Partial<TaskExecutePlanningInput["scope"]>;
  discovery?: Partial<NonNullable<TaskExecutePlanningInput["discovery"]>>;
};

interface TaskExecuteParamsOverrides {
  instruction?: string;
  planning?: PlanningOverrides;
}

const BASE_PLANNING: TaskExecutePlanningInput = {
  intent: "code_change",
  riskLevel: "medium",
  targetPaths: ["docs/architecture.md"],
  scope: {
    readAnywhere: false,
    writeAllowed: true,
    writeGlobs: [],
    forbiddenGlobs: [],
    maxFilesToEdit: 2,
  },
  discovery: {
    ripgrepQueries: ["queue state guidance"],
    likelyDirs: ["docs"],
    keywords: ["queue", "deterministic"],
  },
  acceptanceCriteria: ["Summaries describe deterministic queue handling."],
  validationSteps: ["bun lint"],
  queuePriority: "normal",
  queueWaitBudgetMs: 600_000,
  executionBudgetMs: 900_000,
  finalizationBudgetMs: 120_000,
};

function createTaskExecuteParams(
  overrides?: TaskExecuteParamsOverrides,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    requestId: "integration-task-fixture",
    instruction: overrides?.instruction ?? "Document deterministic queue behavior",
    planning: mergePlanning(overrides?.planning),
  };
}

function mergePlanning(overrides?: PlanningOverrides): TaskExecutePlanningInput {
  const snapshot = JSON.parse(JSON.stringify(BASE_PLANNING)) as TaskExecutePlanningInput;
  if (!overrides) {
    return snapshot;
  }
  const { scope, discovery, ...rest } = overrides;
  Object.assign(snapshot, rest);
  if (scope) {
    snapshot.scope = { ...snapshot.scope, ...scope };
  }
  if (discovery) {
    snapshot.discovery = {
      ...(snapshot.discovery ?? { ripgrepQueries: [] }),
      ...discovery,
    };
  }
  return snapshot;
}

function createRuntimeConfig(
  overrides?: Partial<WorkerpalsRuntimeConfig["workerpals"]>,
): WorkerpalsRuntimeConfig {
  const clone = JSON.parse(JSON.stringify(baseRuntimeConfig)) as WorkerpalsRuntimeConfig;
  const llmConfig = clone.workerpals.llm ?? { endpoint: "", model: "" };
  clone.workerpals = {
    ...clone.workerpals,
    executor: TEST_BACKEND,
    fileModifyingJobs: ["task.execute"],
    qualityMaxAutoRevisions: 0,
    qualitySoftPassOnExhausted: true,
    llm: {
      ...llmConfig,
      endpoint: "",
      model: "",
    },
    ...overrides,
  };
  return clone;
}

interface ExecutorCall {
  kind: string;
  params: Record<string, unknown>;
  repo: string;
  budgets?: { executionBudgetMs?: number; finalizationBudgetMs?: number };
}

interface DeterministicClock {
  tick: (step?: number) => number;
  reset: (seed?: number) => void;
}

interface ExecutorHarness {
  queue: string[];
  timers: number[];
  calls: ExecutorCall[];
  handler: BackendTaskExecutor;
  reset: (seedSummary?: string) => void;
}

function createExecutorHarness(clock: DeterministicClock = createDeterministicClock()): ExecutorHarness {
  const queue: string[] = [];
  const timers: number[] = [];
  const calls: ExecutorCall[] = [];
  const handler: BackendTaskExecutor = async (
    kind,
    params,
    repo,
    runtimeConfig,
    onLog,
    budgets,
  ) => {
    calls.push({ kind, params, repo, budgets });
    const summary = queue.shift() ?? "stubbed completion";
    timers.push(clock.tick());
    const failure = summary.startsWith("fail:");
    onLog?.(failure ? "stderr" : "stdout", `[stub-backend] ${summary}`);
    return failure
      ? { ok: false, summary, exitCode: 1 }
      : { ok: true, summary, stdout: `[${runtimeConfig.workerpals.executor}] ${summary}` };
  };

  const reset = (seedSummary?: string) => {
    queue.length = 0;
    timers.length = 0;
    calls.length = 0;
    clock.reset();
    if (seedSummary) {
      queue.push(seedSummary);
    }
  };

  return { queue, timers, calls, handler, reset };
}

function createDeterministicClock(): DeterministicClock {
  let now = 0;
  return {
    tick(step = 1) {
      now += step;
      return now;
    },
    reset(seed = 0) {
      now = seed;
    },
  };
}

interface LogSink {
  stdout: string[];
  stderr: string[];
  capture: (stream: "stdout" | "stderr", line: string) => void;
}

function createLogSink(): LogSink {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    capture(stream, line) {
      (stream === "stdout" ? stdout : stderr).push(line);
    },
  };
}

function asPlanning(value: unknown): TaskExecutePlanningInput | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as TaskExecutePlanningInput;
}
