import { describe, expect, test } from "bun:test";
import { resolveReviewAgentPrTitle } from "../apps/source_control_manager/src/pr_title";

describe("resolveReviewAgentPrTitle", () => {
  test("uses commit subject when available", () => {
    const title = resolveReviewAgentPrTitle({
      commitSubject: "fix(review-agent): score-only gating",
      completionPrTitle: "prompt-derived title",
      prHeadBranch: "agent/workerpal-123/job-1",
      integrationBaseBranch: "main",
    });
    expect(title).toBe("fix(review-agent): score-only gating");
  });

  test("falls back to completion title when commit subject is missing", () => {
    const title = resolveReviewAgentPrTitle({
      commitSubject: " ",
      completionPrTitle: "fix(tests): add edge-case assertions",
      prHeadBranch: "agent/workerpal-123/job-2",
      integrationBaseBranch: "main",
    });
    expect(title).toBe("fix(tests): add edge-case assertions");
  });

  test("falls back to deterministic branch label when both titles are missing", () => {
    const title = resolveReviewAgentPrTitle({
      commitSubject: "",
      completionPrTitle: "",
      prHeadBranch: "agent/workerpal-123/job-3",
      integrationBaseBranch: "main",
    });
    expect(title).toBe("PushPals: workerpal-123/job-3 -> main");
  });

  test("normalizes multi-line commit subject to first line", () => {
    const title = resolveReviewAgentPrTitle({
      commitSubject: "fix(queue): handle retries\n\nextra details",
      completionPrTitle: "",
      prHeadBranch: "agent/workerpal-123/job-4",
      integrationBaseBranch: "main",
    });
    expect(title).toBe("fix(queue): handle retries");
  });
});
