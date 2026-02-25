import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { loadPushPalsConfig } from "../../packages/shared/src/config";
import { executeJob } from "../../apps/workerpals/src/execute_job";
import type { WorkerpalsRuntimeConfig } from "../../apps/workerpals/src/common/executor_backend";
import type { ExecutorBackend } from "../../apps/workerpals/src/common/types";
import {
  BACKEND_EXECUTOR_SCRIPT_SEGMENTS,
} from "../../apps/workerpals/src/backends/backend_config";
import {
  getBackendTaskExecutor,
  registerBackendTaskExecutor,
  unregisterBackendTaskExecutor,
  type BackendTaskExecutor,
} from "../../apps/workerpals/src/backends/task_execute_registry";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = resolve(__dirname, "fixtures", "task-execute-repo");
const TEST_BACKEND = "__test_task_execute_backend__" as ExecutorBackend;

type ForwardedLog = { stream: "stdout" | "stderr"; line: string };
type Cleanup = () => void;

function stubBackendScriptSegmentsForTesting(
  backend: ExecutorBackend,
  segments: readonly string[] = [],
): Cleanup {
  const hadEntry = Object.prototype.hasOwnProperty.call(
    BACKEND_EXECUTOR_SCRIPT_SEGMENTS,
    backend,
  );
  const previousSegments = BACKEND_EXECUTOR_SCRIPT_SEGMENTS[backend];
  BACKEND_EXECUTOR_SCRIPT_SEGMENTS[backend] = segments;
  return () => {
    if (!hadEntry) {
      delete BACKEND_EXECUTOR_SCRIPT_SEGMENTS[backend];
    } else {
      BACKEND_EXECUTOR_SCRIPT_SEGMENTS[backend] = previousSegments ?? [];
    }
  };
}

function installTestBackendExecutor(executor: BackendTaskExecutor): Cleanup {
  const previousExecutor = getBackendTaskExecutor(TEST_BACKEND);
  registerBackendTaskExecutor(TEST_BACKEND, executor);
  return () => {
    if (previousExecutor) {
      registerBackendTaskExecutor(TEST_BACKEND, previousExecutor);
    } else {
      unregisterBackendTaskExecutor(TEST_BACKEND);
    }
  };
}

function createTaskExecuteParams(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    lane: "deterministic",
    instruction: "Summarize the fixture repository README for release notes.",
    planning: {
      intent: "analysis",
      riskLevel: "low",
      scope: {
        readAnywhere: true,
        writeAllowed: false,
        writeGlobs: [],
      },
      discovery: {
        ripgrepQueries: ["fixture repository summary"],
        likelyDirs: ["docs"],
      },
      acceptanceCriteria: ["Summary mentions the fixture README context."],
      validationSteps: ["bun lint docs"],
      queuePriority: "normal",
      queueWaitBudgetMs: 60_000,
      executionBudgetMs: 120_000,
      finalizationBudgetMs: 60_000,
    },
  };
}

describe("task.execute integration harness", () => {
  test("returns executor result and forwards logs", async () => {
    const runtimeConfig = loadPushPalsConfig({ reload: true });

    const testRuntimeConfig: WorkerpalsRuntimeConfig = {
      ...runtimeConfig,
      workerpals: {
        ...runtimeConfig.workerpals,
        executor: TEST_BACKEND,
      },
    };

    const stubResult = {
      ok: true,
      summary: "stub executor completed",
      stdout: "__stub_stdout__",
      stderr: "__stub_stderr__",
      exitCode: 0,
    };

    const forwardedLogs: ForwardedLog[] = [];
    let observedRepo: string | null = null;
    let observedRuntime: WorkerpalsRuntimeConfig | null = null;
    let observedBudgets: { executionBudgetMs?: number; finalizationBudgetMs?: number } | null = null;

    const stubExecutor: BackendTaskExecutor = async (
      kind,
      _params,
      repo,
      runtime,
      onLog,
      budgets,
    ) => {
      observedRepo = repo;
      observedRuntime = runtime;
      observedBudgets = budgets ? { ...budgets } : null;
      onLog?.("stdout", `[stub] executing ${kind}`);
      onLog?.("stderr", `[stub] budgets=${JSON.stringify(budgets ?? {})}`);
      return stubResult;
    };
    const restoreSegments = stubBackendScriptSegmentsForTesting(TEST_BACKEND);
    const restoreExecutor = installTestBackendExecutor(stubExecutor);

    try {
      const result = await executeJob(
        "task.execute",
        createTaskExecuteParams(),
        FIXTURE_REPO,
        (stream, line) => {
          forwardedLogs.push({ stream, line });
        },
        testRuntimeConfig,
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toBe(stubResult.summary);
      expect(result.stdout).toBe(stubResult.stdout);
      expect(result.stderr).toBe(stubResult.stderr);
      expect(result.exitCode).toBe(0);
      expect(observedRepo).toBe(FIXTURE_REPO);
      expect(observedRuntime).toBe(testRuntimeConfig);
      expect(observedBudgets).toEqual({
        executionBudgetMs: 120_000,
        finalizationBudgetMs: 60_000,
      });
      expect(
        forwardedLogs.some(
          (entry) => entry.stream === "stdout" && entry.line.includes("[stub] executing"),
        ),
      ).toBe(true);
      expect(
        forwardedLogs.some(
          (entry) => entry.stream === "stderr" && entry.line.includes("budgets="),
        ),
      ).toBe(true);
    } finally {
      restoreExecutor();
      restoreSegments();
    }
  });

  test("unregister backend executors removes the binding", async () => {
    const runtimeConfig = loadPushPalsConfig({ reload: true });

    const testRuntimeConfig: WorkerpalsRuntimeConfig = {
      ...runtimeConfig,
      workerpals: {
        ...runtimeConfig.workerpals,
        executor: TEST_BACKEND,
      },
    };

    const stubResult = {
      ok: true,
      summary: "stub executor before unregister",
      stdout: "__stub_stdout__",
      stderr: "",
      exitCode: 0,
    };

    const stubExecutor: BackendTaskExecutor = async () => stubResult;
    const restoreSegments = stubBackendScriptSegmentsForTesting(TEST_BACKEND);
    const restoreExecutor = installTestBackendExecutor(stubExecutor);

    try {
      const initialResult = await executeJob(
        "task.execute",
        createTaskExecuteParams(),
        FIXTURE_REPO,
        undefined,
        testRuntimeConfig,
      );

      expect(initialResult).toEqual(stubResult);

      const removed = unregisterBackendTaskExecutor(TEST_BACKEND);
      expect(removed).toBe(true);
      expect(getBackendTaskExecutor(TEST_BACKEND)).toBeUndefined();

      const missingExecutorResult = await executeJob(
        "task.execute",
        createTaskExecuteParams(),
        FIXTURE_REPO,
        undefined,
        testRuntimeConfig,
      );

      expect(missingExecutorResult.ok).toBe(false);
      expect(missingExecutorResult.exitCode).toBe(1);
      expect(missingExecutorResult.summary).toContain(
        `No task executor registered for backend "${TEST_BACKEND}"`,
      );

      const secondRemoval = unregisterBackendTaskExecutor(TEST_BACKEND);
      expect(secondRemoval).toBe(false);
    } finally {
      restoreExecutor();
      restoreSegments();
    }
  });
});
