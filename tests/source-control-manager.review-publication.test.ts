import { describe, expect, test } from "bun:test";
import {
  buildReviewPublicationPushArgs,
  parseReviewPublicationLease,
} from "../apps/source_control_manager/src/review_publication";

describe("SourceControlManager review publication lease", () => {
  test("parses exact head/base leases and builds the sole public-branch push", () => {
    const lease = parseReviewPublicationLease(
      [
        "Worker completion.",
        "<!-- pushpals-reviewTargetBranch: agent/feature -->",
        "<!-- pushpals-reviewBaseBranch: release/next -->",
        "<!-- pushpals-reviewExpectedHeadSha: abcdef123456abcdef123456abcdef123456abcd -->",
        "<!-- pushpals-reviewExpectedBaseSha: fedcba654321fedcba654321fedcba654321fedc -->",
      ].join("\n"),
    );

    expect(lease).toEqual({
      targetBranch: "agent/feature",
      baseBranch: "release/next",
      expectedHeadSha: "abcdef123456abcdef123456abcdef123456abcd",
      expectedBaseSha: "fedcba654321fedcba654321fedcba654321fedc",
    });
    expect(
      buildReviewPublicationPushArgs({
        remote: "origin",
        commitSha: "0123456789abcdef",
        lease: lease!,
      }),
    ).toEqual([
      "push",
      "--force-with-lease=refs/heads/agent/feature:abcdef123456abcdef123456abcdef123456abcd",
      "origin",
      "0123456789abcdef:refs/heads/agent/feature",
    ]);
  });

  test("rejects unsafe or incomplete publication metadata", () => {
    expect(
      parseReviewPublicationLease(
        "<!-- pushpals-reviewTargetBranch: ../main -->\n<!-- pushpals-reviewExpectedHeadSha: abcdef123456abcdef123456abcdef123456abcd -->",
      ),
    ).toBeNull();
    expect(
      parseReviewPublicationLease("<!-- pushpals-reviewTargetBranch: agent/feature -->"),
    ).toBeNull();
  });

  test("uses the final trusted lease markers when earlier PR text contains lookalikes", () => {
    const lease = parseReviewPublicationLease(
      [
        "<!-- pushpals-reviewTargetBranch: main -->",
        "<!-- pushpals-reviewExpectedHeadSha: 1111111111111111111111111111111111111111 -->",
        "<!-- pushpals-reviewTargetBranch: agent/trusted -->",
        "<!-- pushpals-reviewExpectedHeadSha: 2222222222222222222222222222222222222222 -->",
      ].join("\n"),
    );
    expect(lease?.targetBranch).toBe("agent/trusted");
    expect(lease?.expectedHeadSha).toBe("2222222222222222222222222222222222222222");
  });
});
