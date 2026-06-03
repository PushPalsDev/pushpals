import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  resolveGenericPythonExecutorChildTimeoutEnv,
  resolveGenericPythonExecutorChildTimeoutMs,
  resolveGenericPythonExecutorTimeoutMs,
} from "../apps/workerpals/src/common/generic_python_executor";

describe("generic python executor timeout resolution", () => {
  test("caps normal backends to the job execution budget", () => {
    expect(
      resolveGenericPythonExecutorTimeoutMs({
        configuredTimeoutMs: 7_200_000,
        executionBudgetMs: 1_800_000,
      }),
    ).toBe(1_800_000);
  });

  test("uses finalization budget as host-side structured-result grace", () => {
    expect(
      resolveGenericPythonExecutorTimeoutMs({
        configuredTimeoutMs: 7_200_000,
        executionBudgetMs: 1_200_000,
        finalizationBudgetMs: 120_000,
      }),
    ).toBe(1_320_000);
  });

  test("still supports an explicit opt-out for bespoke backend wrappers", () => {
    expect(
      resolveGenericPythonExecutorTimeoutMs({
        configuredTimeoutMs: 7_200_000,
        executionBudgetMs: 1_800_000,
        capTimeoutToExecutionBudget: false,
      }),
    ).toBe(7_200_000);
  });

  test("keeps OpenAI Codex under the job planning budget", () => {
    for (const path of [
      "apps/workerpals/src/backends/openai_codex_backend.ts",
      "packages/cli/runtime/sandbox/apps/workerpals/src/backends/openai_codex_backend.ts",
    ]) {
      expect(readFileSync(path, "utf8")).not.toContain("capTimeoutToExecutionBudget: false");
    }
  });

  test("gives OpenAI Codex a child timeout below the host timeout for result salvage", () => {
    expect(
      resolveGenericPythonExecutorChildTimeoutMs({
        backendName: "openai_codex",
        hostTimeoutMs: 1_200_000,
      }),
    ).toBe(1_170_000);

    expect(
      resolveGenericPythonExecutorChildTimeoutEnv({
        backendName: "openai_codex",
        hostTimeoutMs: 1_200_000,
      }),
    ).toEqual({
      WORKERPALS_OPENAI_CODEX_TIMEOUT_MS: "1170000",
      WORKERPALS_OPENAI_CODEX_TIMEOUT_S: "1170",
    });
  });

  test("keeps Codex child timeout below execution budget when host has finalization grace", () => {
    expect(
      resolveGenericPythonExecutorChildTimeoutMs({
        backendName: "openai_codex",
        hostTimeoutMs: 1_320_000,
        executionBudgetMs: 1_200_000,
      }),
    ).toBe(1_170_000);
  });

  test("does not inject Codex timeout env into unrelated Python backends", () => {
    expect(
      resolveGenericPythonExecutorChildTimeoutEnv({
        backendName: "miniswe",
        hostTimeoutMs: 1_200_000,
      }),
    ).toEqual({});
  });
});
