import { describe, expect, test } from "bun:test";
import { buildJobRunnerResult } from "../apps/workerpals/src/job_runner";

describe("workerpals Docker job runner result", () => {
  test("preserves executor cooldowns in the structured sentinel result", () => {
    const result = buildJobRunnerResult({
      ok: false,
      summary: "openai_codex stalled before first response",
      stderr: "Codex event trace:\n- thread.started\n- turn.started",
      exitCode: 124,
      cooldownMs: 600_000,
      diagnostics: {
        terminal: {
          failureClass: "codex_startup_stall",
          terminalStage: "executor_startup",
        },
      },
    });

    expect(result.cooldownMs).toBe(600_000);
    expect(result.diagnostics?.terminal?.failureClass).toBe("codex_startup_stall");
  });
});
