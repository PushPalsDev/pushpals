import { describe, expect, test } from "bun:test";
import { classifyAutonomyJobCompletion } from "../apps/server/src/job_completion_outcome";

describe("autonomy completion outcome provenance", () => {
  test.each([
    "No clarification needed",
    "Fixed needs_clarification reporting",
    "Added clarification regression tests",
    "Clarification handling now preserves published results",
    "Fixed OpenHands needs clarification: outcome reporting",
  ])("incidental or negated clarification text is not a clarification outcome: %s", (summary) => {
    expect(
      classifyAutonomyJobCompletion({
        summary,
        result: {
          summary: "Candidate published successfully",
          artifacts: [{ text: "Earlier attempt requested clarification" }],
          stdout: "Needs clarification: historical test output",
          history: { userAction: "needs_clarification" },
        },
      }),
    ).toEqual({
      success: true,
      userAction: "applied",
      reopenedWithin24h: false,
      regressionFlag: false,
    });
  });

  test.each([
    { userAction: "needs_clarification" },
    { result: { status: "needs_clarification" } },
    {
      result: JSON.stringify({
        summary: "Requires clarification: which interface should be used?",
      }),
    },
    { diagnostics: { terminal: { failureClass: "needs_clarification" } } },
    { summary: "Clarification required." },
    { result: "Requested clarification: select the deployment target." },
    { ok: true, summary: "OpenHands needs clarification: Which interface should be used?" },
  ])("genuine current clarification outcomes remain unsuccessful", (body) => {
    expect(classifyAutonomyJobCompletion(body)).toEqual({
      success: false,
      userAction: "needs_clarification",
      reopenedWithin24h: true,
      regressionFlag: false,
    });
  });

  test("historical clarification cannot override a genuine no-change outcome", () => {
    expect(
      classifyAutonomyJobCompletion({
        summary: "Completed with no file changes",
        artifacts: [{ text: "No clarification needed" }],
      }),
    ).toEqual({
      success: false,
      userAction: "no_change",
      reopenedWithin24h: true,
      regressionFlag: false,
    });
  });

  test("malformed serialized artifacts are not promoted to terminal clarification evidence", () => {
    expect(
      classifyAutonomyJobCompletion({
        summary: "Published successfully",
        result: '{"artifacts":[{"text":"Needs clarification:',
      }).success,
    ).toBe(true);
  });
});
