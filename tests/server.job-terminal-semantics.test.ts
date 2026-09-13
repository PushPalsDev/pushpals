import { describe, expect, test } from "bun:test";
import {
  classifyJobTerminalSemantics,
  collectJobTerminalEvidence,
} from "../apps/server/src/job_terminal_semantics";
import { JobQueue } from "../apps/server/src/jobs";

describe("terminal outcome provenance", () => {
  test.each([
    "Fixed no-change reporting",
    "Added a no-change regression test",
    "No changes to commit handling now reports accurately",
    "Implemented handling for completed_no_change results",
    "Corrected the no file changes message",
  ])("does not confuse a task topic with an actual no-change declaration: %s", (summary) => {
    expect(
      classifyJobTerminalSemantics({
        status: "completed",
        failureClass: "success",
        summary: "Candidate published successfully",
        result: JSON.stringify({ summary }),
      }),
    ).toMatchObject({ success: true, noChange: false });
  });

  test.each([
    "Completed with no file changes",
    "completed_no_change: no publishable patch was produced",
    "No modified files were detected",
    "No file changes were detected.",
    "No changes to commit",
    "Nothing to commit, working tree clean",
    "Executed task via openai_codex (no file changes detected)",
    "Executor produced no publishable code changes (artifact-only output)",
  ])("recognizes an actual legacy terminal declaration: %s", (summary) => {
    expect(classifyJobTerminalSemantics({ status: "completed", summary }).noChange).toBe(true);
  });

  test("exports typed outcomes separately from legacy prose without exposing artifacts", () => {
    expect(
      collectJobTerminalEvidence({
        status: "completed",
        summary: "Changed a reporting component",
        result: JSON.stringify({ userAction: "applied", message: "Updated implementation" }),
        diagnostics: { terminal: { failureClass: "success" } },
        artifacts: [{ text: "needs_clarification" }],
        history: [{ status: "completed_no_change" }],
      }),
    ).toEqual({
      typed: ["completed", "applied", "success"],
      prose: ["Changed a reporting component", "Updated implementation"],
    });
  });

  const delivered = {
    summary: "Candidate patch queued for trusted host validation",
    artifacts: [{ text: "Historical run: completed_no_change; nothing to commit" }],
    stdout: "A regression test covers no file changes detected",
    stderr: "Previous attempt modified 0 files",
    history: { failureClass: "artifact_only_no_publishable_patch" },
  };

  test.each([delivered, JSON.stringify(delivered)])(
    "published delivery is not overridden by nested logs or artifacts",
    (result) => {
      expect(
        classifyJobTerminalSemantics({
          status: "completed",
          result,
          summary: "Candidate published successfully: https://example.test/pull/1",
          failureClass: "success",
          additionalEvidence: [JSON.stringify(delivered), "Historical artifact says no_change"],
        }),
      ).toEqual({ kind: "success", terminal: true, noChange: false, success: true });
    },
  );

  test.each([
    "Completed with no file changes",
    { ok: true, summary: "completed_no_change: no publishable patch was produced" },
    JSON.stringify({ summary: "No modified files were detected" }),
    { ok: true, status: "completed_no_change", artifacts: [{ text: "success" }] },
    { diagnostics: { terminal: { failureClass: "artifact_only_no_publishable_patch" } } },
    { result: { userAction: "no_change" }, ok: true },
  ])(
    "keeps explicit legacy and structured no-change outcomes despite nominal success",
    (result) => {
      expect(
        classifyJobTerminalSemantics({ status: "completed", result, failureClass: "success" }),
      ).toEqual({ kind: "no_change", terminal: true, noChange: true, success: false });
    },
  );

  test("typed no-change fields win over an optimistic summary", () => {
    for (const typed of [{ failureClass: "completed_no_change" }, { userAction: "no_change" }]) {
      expect(
        classifyJobTerminalSemantics({ status: "completed", summary: "Success", ...typed })
          .noChange,
      ).toBe(true);
    }
    expect(
      classifyJobTerminalSemantics({ status: "completed_no_change", summary: "Success" }).noChange,
    ).toBe(true);
  });

  test("malformed JSON, arrays and nonterminal history cannot manufacture terminal no-change", () => {
    for (const result of ['{"artifacts":[{"text":"no_change"', [{ summary: "no_change" }]]) {
      expect(classifyJobTerminalSemantics({ status: "completed", result }).noChange).toBe(false);
    }
    expect(
      classifyJobTerminalSemantics({ status: "claimed", result: "Earlier no_change" }),
    ).toEqual({
      kind: "non_terminal",
      terminal: false,
      noChange: false,
      success: false,
    });
  });

  test("JobQueue SLO counts the published patch and truthful no-change separately", () => {
    const queue = new JobQueue(":memory:");
    try {
      for (const [id, body] of [
        ["delivered", delivered],
        ["no-change", { summary: "completed_no_change: no publishable patch was produced" }],
      ] as const) {
        const enqueued = queue.enqueue({
          taskId: id,
          sessionId: "dev",
          kind: "task.execute",
          params: {},
        });
        const claimed = queue.claim(`worker-${id}`);
        expect(claimed.job?.id).toBe(enqueued.jobId);
        expect(queue.complete(String(enqueued.jobId), body).ok).toBe(true);
      }
      expect(queue.sloSummary()).toMatchObject({
        terminal: 2,
        completed: 2,
        noChange: 1,
        successRate: 0.5,
      });
    } finally {
      queue.close();
    }
  });
});
