import { describe, expect, test } from "bun:test";
import { deriveReviewPrHeadBranch } from "../apps/source_control_manager/src/review_pr_branch";

describe("deriveReviewPrHeadBranch", () => {
  test("materializes refs/pushpals agent refs into public agent branch", () => {
    const resolved = deriveReviewPrHeadBranch(
      "refs/pushpals/agent/workerpal-123/job-456",
      "completion-1",
    );
    expect(resolved.requiresMaterialize).toBe(true);
    expect(resolved.headBranch).toBe("agent/workerpal-123/job-456");
  });

  test("falls back to scm branch when hidden ref does not map to agent prefix", () => {
    const resolved = deriveReviewPrHeadBranch(
      "refs/pushpals/internal/path",
      "completion-xyz",
    );
    expect(resolved.requiresMaterialize).toBe(true);
    expect(resolved.headBranch).toBe("agent/source_control_manager/completion-xyz");
  });

  test("keeps refs/heads branch names for PR head", () => {
    const resolved = deriveReviewPrHeadBranch("refs/heads/agent/feature-a", "completion-2");
    expect(resolved.requiresMaterialize).toBe(false);
    expect(resolved.headBranch).toBe("agent/feature-a");
  });

  test("accepts plain branch names", () => {
    const resolved = deriveReviewPrHeadBranch("agent/feature-b", "completion-3");
    expect(resolved.requiresMaterialize).toBe(false);
    expect(resolved.headBranch).toBe("agent/feature-b");
  });
});
