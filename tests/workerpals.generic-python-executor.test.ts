import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  normalizeGenericPythonExecutorParsedResultForTimeout,
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

  test("normalizes host timeout SIGTERM from OpenAI Codex into a budget-expired result", () => {
    const result = normalizeGenericPythonExecutorParsedResultForTimeout({
      backendName: "openai_codex",
      kind: "task.execute",
      timedOut: true,
      timeoutMs: 1_320_000,
      timeoutDetail:
        "workerpals.openai_codex_timeout_ms=7200000ms capped by planning executionBudgetMs=1200000ms + finalizationBudgetMs=120000ms",
      summary: "openai_codex interrupted by signal 15",
      stdout: "partial stdout",
      stderr: "openai_codex interrupted by signal 15",
      exitCode: 143,
    });

    expect(result).toEqual({
      summary: "openai_codex execution budget expired after 1320000ms for task.execute",
      stdout: "partial stdout",
      stderr: [
        "OpenAI Codex exceeded the PushPals execution budget before returning a completed result.",
        "Timeout detail: workerpals.openai_codex_timeout_ms=7200000ms capped by planning executionBudgetMs=1200000ms + finalizationBudgetMs=120000ms.",
        "Last stderr:",
        "OpenAI Codex exceeded the execution budget",
      ].join("\n"),
      exitCode: 124,
    });
    expect(result.summary).not.toContain("signal 15");
    expect(result.stderr).not.toContain("signal 15");
  });

  test("does not rewrite non-timeout Codex interruptions", () => {
    expect(
      normalizeGenericPythonExecutorParsedResultForTimeout({
        backendName: "openai_codex",
        kind: "task.execute",
        timedOut: false,
        timeoutMs: 1_320_000,
        summary: "openai_codex interrupted by signal 15",
        stdout: "",
        stderr: "",
        exitCode: 143,
      }),
    ).toEqual({
      summary: "openai_codex interrupted by signal 15",
      stdout: "",
      stderr: "",
      exitCode: 143,
    });
  });
});
