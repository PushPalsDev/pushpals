import { describe, expect, test } from "bun:test";
import {
  followupWindow,
  parseEvidenceFollowup,
  safeFollowupPath,
} from "../apps/remotebuddy/src/repository_evidence_followup";

describe("host-mediated evidence follow-up boundaries", () => {
  test("rejects traversal, absolute paths, pathspecs, secrets and commands", () => {
    for (const path of [
      "../secret",
      "/etc/passwd",
      "C:/secret",
      "src\\outside",
      ":(glob)**",
      ".git/config",
      ".env",
      ".env.production",
      "private.key",
      ".aws/credentials",
      "src/-option",
      "src/a\n.ts",
    ])
      expect(safeFollowupPath(path)).toBe(false);
    expect(safeFollowupPath("lib/InventorySync.rs")).toBe(true);
    expect(
      parseEvidenceFollowup({ windows: [], literalQueries: ["safe"], command: "cat .env" }),
    ).toBeNull();
    expect(
      parseEvidenceFollowup({ windows: [], literalQueries: ["safe", "other", "third"] }),
    ).toBeNull();
    expect(
      parseEvidenceFollowup({
        windows: [{ path: "src/main.py", startLine: 1, endLine: 201 }],
        literalQueries: [],
      }),
    ).toBeNull();
    expect(
      parseEvidenceFollowup({
        windows: [{ path: "src/main.py", startLine: 1, endLine: 200 }],
        literalQueries: ["literal.*not-regex"],
      }),
    ).not.toBeNull();
  });
  test("bounds full UTF-8 lines and never cites a partial scanned line", () => {
    const window = followupWindow("first\n你好\nlast partial", true, 2, 3, 6);
    expect(window.content).toBe("你好");
    expect(window.lineRanges).toEqual([{ startLine: 2, endLine: 2 }]);
    expect(followupWindow("你好", false, 1, 1, 5).lineRanges).toEqual([]);
    expect(followupWindow("first\npartial", true, 2, 2, 100).content).toBe("");
    expect(followupWindow("first", false, 10, 20, 100).lineRanges).toEqual([]);
  });
});
