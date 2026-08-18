import { describe, expect, test } from "bun:test";
import {
  isCherryPickConflictOutput,
  reviewApplyFailureBlocksPublication,
} from "../apps/source_control_manager/src/review_apply_fallback";

describe("source-control-manager review apply fallback", () => {
  test("detects cherry-pick conflict output", () => {
    const message = [
      "error: could not apply 1a645ea... feat(remote_agent): allow overriding config loader and test session tags",
      'hint: After resolving the conflicts, mark them with "git add/rm <pathspec>", then run "git cherry-pick --continue".',
    ].join("\n");
    expect(isCherryPickConflictOutput(message)).toBe(true);
    expect(
      isCherryPickConflictOutput("fatal: could not read Username for 'https://github.com'"),
    ).toBe(false);
  });

  test("never bypasses a failed apply before review publication", async () => {
    const base = {
      applyStdout: "",
      applyStderr: "error: could not apply abc123... feature",
    };

    expect(
      reviewApplyFailureBlocksPublication({
        ...base,
        reviewAgentEnabled: true,
        mergeStrategy: "cherry-pick",
      }),
    ).toBe(true);

    expect(
      reviewApplyFailureBlocksPublication({
        ...base,
        reviewAgentEnabled: false,
        mergeStrategy: "cherry-pick",
      }),
    ).toBe(true);

    expect(
      reviewApplyFailureBlocksPublication({
        ...base,
        reviewAgentEnabled: true,
        mergeStrategy: "ff-only",
      }),
    ).toBe(true);

    expect(
      reviewApplyFailureBlocksPublication({
        applyStdout: "",
        applyStderr: "fatal: could not read Username for 'https://github.com'",
        reviewAgentEnabled: true,
        mergeStrategy: "cherry-pick",
      }),
    ).toBe(true);

    let pushed = false;
    const orchestrateReviewPublication = async () => {
      if (
        reviewApplyFailureBlocksPublication({
          ...base,
          reviewAgentEnabled: true,
          mergeStrategy: "cherry-pick",
        })
      ) {
        throw new Error("candidate apply failed; publication blocked");
      }
      pushed = true;
    };
    await expect(orchestrateReviewPublication()).rejects.toThrow("publication blocked");
    expect(pushed).toBe(false);
  });
});
