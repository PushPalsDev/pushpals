import { describe, expect, test } from "bun:test";
import { resolveReviewFixCompletionBranch } from "../apps/workerpals/src/execute_job";

describe("workerpals review fix completion branch resolution", () => {
  test("uses ReviewAgent-provided PR head branch when valid", () => {
    const resolved = resolveReviewFixCompletionBranch("refs/heads/agent/workerpal-1/job-abc", "agent/default");
    expect(resolved).toEqual({
      branch: "agent/workerpal-1/job-abc",
      overridden: true,
    });
  });

  test("rejects unsafe branch override and falls back", () => {
    const resolved = resolveReviewFixCompletionBranch("../main", "agent/default");
    expect(resolved).toEqual({
      branch: "agent/default",
      overridden: false,
    });
  });
});
