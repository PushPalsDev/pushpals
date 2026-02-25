import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerpalsRuntimeConfig } from "../../apps/workerpals/src/common/executor_backend";
import { executeJob } from "../../apps/workerpals/src/execute_job";
import type { BackendTaskExecutor } from "../../apps/workerpals/src/backends/types";
import {
  getBackendTaskExecutor,
  registerBackendTaskExecutor,
} from "../../apps/workerpals/src/backends/task_execute_registry";

const REPO_ROOT = process.cwd();
const TEST_RUNTIME_WORKERPALS_CONFIG = {
  executor: "miniswe",
  fileModifyingJobs: ["task.execute"],
  outputMaxChars: 32_768,
  outputMaxLines: 400,
  outputMaxHeadLines: 120,
  executorResultPrefix: "__PUSHPALS_TEST_RESULT__ ",
  qualityValidationStepTimeoutMs: 120_000,
  qualityCriticMaxDiffChars: 16_000,
  qualityCriticMaxValidationOutputChars: 8_000,
  qualityCriticTimeoutMs: 45_000,
  qualityMaxAutoRevisions: 0,
  qualitySoftPassOnExhausted: false,
  qualityCriticMinScore: 8,
  requirePush: false,
  pushAgentBranch: false,
  llm: {
    backend: "local",
    endpoint: "http://127.0.0.1:1234/v1/chat/completions",
    model: "codellama:13b",
    apiKey: "",
    sessionId: "test-session",
    reasoningEffort: "medium",
    codexAuthMode: "local",
    codexBin: "codex",
    codexTimeoutMs: 60_000,
  },
} as const;

const TEST_RUNTIME_CONFIG_TEMPLATE: WorkerpalsRuntimeConfig = {
  projectRoot: REPO_ROOT,
  workerpals: {
    ...TEST_RUNTIME_WORKERPALS_CONFIG,
    fileModifyingJobs: [...TEST_RUNTIME_WORKERPALS_CONFIG.fileModifyingJobs],
    llm: { ...TEST_RUNTIME_WORKERPALS_CONFIG.llm },
  },
};

interface HarnessCall {
  stream: "stdout" | "stderr";
  line: string;
}

function createHarness() {
  const calls: HarnessCall[] = [];
  const log = (stream: "stdout" | "stderr", line: string) => {
    calls.push({ stream, line });
  };
  return { calls, log };
}

function createTaskParams(overrides: Record<string, unknown> = {}) {
  const basePlanning = {
    intent: "code_change",
    riskLevel: "low",
    scope: {
      readAnywhere: true,
      writeAllowed: true,
      writeGlobs: ["README.md"],
    },
    discovery: {
      ripgrepQueries: ["readme"],
      likelyDirs: ["."],
      keywords: ["docs"],
    },
    acceptanceCriteria: ["Document change applied"],
    validationSteps: ["bun test tests/workerpals.task-execute-schema.test.ts"],
    queuePriority: "normal",
    queueWaitBudgetMs: 60_000,
    executionBudgetMs: 120_000,
    finalizationBudgetMs: 60_000,
  };

  return {
    schemaVersion: 2,
    instruction: "Append a changelog entry.",
    planning: basePlanning,
    ...overrides,
  };
}

function createRuntimeConfig(): WorkerpalsRuntimeConfig {
  return {
    projectRoot: TEST_RUNTIME_CONFIG_TEMPLATE.projectRoot,
    workerpals: {
      ...TEST_RUNTIME_CONFIG_TEMPLATE.workerpals,
      fileModifyingJobs: [...TEST_RUNTIME_CONFIG_TEMPLATE.workerpals.fileModifyingJobs],
      llm: { ...TEST_RUNTIME_CONFIG_TEMPLATE.workerpals.llm },
    },
  } satisfies WorkerpalsRuntimeConfig;
}

interface MinisweExecutorSnapshot {
  executor?: BackendTaskExecutor;
  hadExecutor: boolean;
}

function captureMinisweExecutorSnapshot(): MinisweExecutorSnapshot {
  const executor = getBackendTaskExecutor("miniswe");
  return { executor, hadExecutor: typeof executor === "function" };
}

function unregisterMinisweExecutor(): void {
  registerBackendTaskExecutor("miniswe", undefined as unknown as BackendTaskExecutor);
}

function restoreMinisweExecutor(snapshot: MinisweExecutorSnapshot): void {
  if (snapshot.hadExecutor && snapshot.executor) {
    registerBackendTaskExecutor("miniswe", snapshot.executor);
    return;
  }
  unregisterMinisweExecutor();
}

function stubMinisweExecutor(stub: BackendTaskExecutor): void {
  registerBackendTaskExecutor("miniswe", stub);
}

function temporarilyRemoveMinisweExecutor(): void {
  unregisterMinisweExecutor();
}

describe("task.execute integration harness", () => {
  let runtimeConfig: WorkerpalsRuntimeConfig;
  let minisweSnapshot: MinisweExecutorSnapshot | null = null;

  beforeEach(() => {
    runtimeConfig = createRuntimeConfig();
    minisweSnapshot = captureMinisweExecutorSnapshot();
  });

  afterEach(() => {
    if (minisweSnapshot) {
      try {
        restoreMinisweExecutor(minisweSnapshot);
      } finally {
        minisweSnapshot = null;
      }
    } else {
      unregisterMinisweExecutor();
    }
  });

  test("propagates backend failure contract with captured stderr", async () => {
    const harness = createHarness();
    const params = createTaskParams();
    const failureResult = {
      ok: false,
      summary: "stubbed backend failure",
      stdout: "partial context",
      stderr: "fatal: repo dirty",
      exitCode: 87,
    };
    const stub: BackendTaskExecutor = async (kind, receivedParams, repo, config, onLog, budgets) => {
      expect(kind).toBe("task.execute");
      expect(receivedParams.planning).toEqual(params.planning);
      expect(repo).toBe(REPO_ROOT);
      expect(config).toBe(runtimeConfig);
      expect(budgets).toEqual({
        executionBudgetMs: params.planning.executionBudgetMs,
        finalizationBudgetMs: params.planning.finalizationBudgetMs,
      });
      onLog?.("stderr", "backend stderr line");
      return failureResult;
    };

    stubMinisweExecutor(stub);

    const result = await executeJob(
      "task.execute",
      params,
      REPO_ROOT,
      harness.log,
      runtimeConfig,
    );

    expect(result).toMatchObject(failureResult);

    expect(harness.calls.length).toBe(2);
    const qualityGateLog = harness.calls[0]!;
    const backendLog = harness.calls[1]!;
    expect(qualityGateLog.stream).toBe("stdout");
    expect(qualityGateLog.line).toContain("[QualityGate]");
    expect(backendLog.stream).toBe("stderr");
    expect(backendLog.line).toContain("backend stderr line");
  });

  test("fails fast when configured executor has no registered backend", async () => {
    const harness = createHarness();
    temporarilyRemoveMinisweExecutor();

    const result = await executeJob(
      "task.execute",
      createTaskParams(),
      REPO_ROOT,
      harness.log,
      runtimeConfig,
    );

    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      summary: expect.stringContaining('No task executor registered for backend "miniswe"'),
    });
    expect(result.stderr).toBeUndefined();
    expect(result.stdout).toBeUndefined();

    expect(harness.calls.length).toBe(1);
    const qualityGateLog = harness.calls[0]!;
    expect(qualityGateLog.stream).toBe("stdout");
    expect(qualityGateLog.line).toContain("[QualityGate]");
  });
});
