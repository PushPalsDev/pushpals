import { describe, expect, test } from "bun:test";
import {
  isCherryPickConflictOutput,
  shouldBypassApplyFailureInReviewMode,
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

  test("bypasses apply failure only in ReviewAgent cherry-pick mode", () => {
    const base = {
      applyStdout: "",
      applyStderr: "error: could not apply abc123... feature",
    };

    expect(
      shouldBypassApplyFailureInReviewMode({
        ...base,
        reviewAgentEnabled: true,
        mergeStrategy: "cherry-pick",
      }),
    ).toBe(true);

    expect(
      shouldBypassApplyFailureInReviewMode({
        ...base,
        reviewAgentEnabled: false,
        mergeStrategy: "cherry-pick",
      }),
    ).toBe(false);

    expect(
      shouldBypassApplyFailureInReviewMode({
        ...base,
        reviewAgentEnabled: true,
        mergeStrategy: "ff-only",
      }),
    ).toBe(false);

    expect(
      shouldBypassApplyFailureInReviewMode({
        applyStdout: "",
        applyStderr: "fatal: could not read Username for 'https://github.com'",
        reviewAgentEnabled: true,
        mergeStrategy: "cherry-pick",
      }),
    ).toBe(false);
  });
});
