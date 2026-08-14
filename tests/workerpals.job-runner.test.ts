import { describe, expect, test } from "bun:test";
import {
  buildFatalJobResult,
  buildJobRunnerResult,
  containerOwnsGitFinalization,
} from "../apps/workerpals/src/job_runner";

describe("workerpals Docker job runner result", () => {
  test("returns structured missing-runtime diagnostics for a missing prompt", () => {
    const result = buildFatalJobResult(
      new Error(
        "ENOENT: no such file or directory, open '/workspace/prompts/review_agent/reviewer.md'",
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("required runtime prompt asset");
    expect(result.diagnostics?.terminal?.failureClass).toBe("missing_runtime_asset");
    expect(result.diagnostics?.terminal?.watchdogFired).toBe(false);
  });

  test("preserves executor cooldowns in the structured sentinel result", () => {
    const result = buildJobRunnerResult({
      ok: false,
      summary: "openai_codex stalled before first response",
      stderr: "Codex event trace:\n- thread.started\n- turn.started",
      exitCode: 124,
      cooldownMs: 600_000,
      usage: {
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
        estimated: false,
        backend: "openai_codex",
        modelId: "gpt-5.6-sol",
      },
      diagnostics: {
        terminal: {
          failureClass: "codex_startup_stall",
          terminalStage: "executor_startup",
        },
      },
    });

    expect(result.cooldownMs).toBe(600_000);
    expect(result.usage?.totalTokens).toBe(1500);
    expect(result.usage?.estimated).toBe(false);
    expect(result.diagnostics?.terminal?.failureClass).toBe("codex_startup_stall");
  });

  test("keeps host-SCM review jobs edit/validate-only inside the container", () => {
    expect(
      containerOwnsGitFinalization({
        reviewAgent: {
          resolutionType: "review_fix",
          hostScmGitOwner: true,
        },
      }),
    ).toBe(false);
    expect(
      containerOwnsGitFinalization({
        reviewAgent: {
          resolutionType: "merge_conflict",
          hostScmGitOwner: true,
        },
      }),
    ).toBe(false);
    expect(containerOwnsGitFinalization({ instruction: "ordinary worker job" })).toBe(true);
  });
});
