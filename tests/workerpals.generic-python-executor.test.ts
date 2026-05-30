import { describe, expect, test } from "bun:test";
import { resolveGenericPythonExecutorTimeoutMs } from "../apps/workerpals/src/common/generic_python_executor";

describe("generic python executor timeout resolution", () => {
  test("caps normal backends to the job execution budget", () => {
    expect(
      resolveGenericPythonExecutorTimeoutMs({
        configuredTimeoutMs: 7_200_000,
        executionBudgetMs: 1_800_000,
      }),
    ).toBe(1_800_000);
  });

  test("lets OpenAI Codex use the configured backend timeout instead of a shorter planning budget", () => {
    expect(
      resolveGenericPythonExecutorTimeoutMs({
        configuredTimeoutMs: 7_200_000,
        executionBudgetMs: 1_800_000,
        capTimeoutToExecutionBudget: false,
      }),
    ).toBe(7_200_000);
  });
});
