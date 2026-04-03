import { describe, expect, test } from "bun:test";
import {
  resolveReviewFixCompletionBranch,
  resolveReviewNoChangeCompletionBranch,
} from "../apps/workerpals/src/execute_job";

describe("workerpals review fix completion branch resolution", () => {
  test("uses ReviewAgent-provided PR head branch when valid", () => {
    const resolved = resolveReviewFixCompletionBranch(
      "refs/heads/agent/workerpal-1/job-abc",
      "agent/default",
    );
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

  test("resolves no-change re-review branch from completionBranch", () => {
    const branch = resolveReviewNoChangeCompletionBranch({
      completionBranch: "refs/heads/agent/workerpal-1/job-abc",
      reviewAgent: { prHeadRef: "refs/heads/agent/workerpal-1/ignored" },
    });
    expect(branch).toBe("agent/workerpal-1/job-abc");
  });

  test("resolves no-change re-review branch from reviewAgent.prHeadRef", () => {
    const branch = resolveReviewNoChangeCompletionBranch({
      reviewAgent: { prHeadRef: "refs/heads/agent/workerpal-1/job-xyz" },
    });
    expect(branch).toBe("agent/workerpal-1/job-xyz");
  });

  test("returns null for unsafe no-change re-review branch", () => {
    const branch = resolveReviewNoChangeCompletionBranch({
      completionBranch: "../main",
      reviewAgent: { prHeadRef: "agent/workerpal-1/job-xyz" },
    });
    expect(branch).toBeNull();
  });
});
