import { describe, expect, test } from "bun:test";
import {
  assertCompleteReviewEvidence,
  buildCompleteReviewEvidence,
} from "../packages/shared/src/review_evidence";

const diff = "diff --git a/src/example.ts b/src/example.ts\n+const value = '🙂';\n";

describe("complete immutable review evidence", () => {
  test("UTF-8 exact budget preserves every byte and binds the full patch manifest", () => {
    const evidence = buildCompleteReviewEvidence({
      diff,
      maxBytes: Buffer.byteLength(diff),
      candidateSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      expectedPaths: ["src/example.ts"],
    });
    expect(evidence.complete).toBe(true);
    expect(evidence.diff).toBe(diff);
    expect(evidence.manifest).toMatchObject({
      byteLength: Buffer.byteLength(diff),
      paths: ["src/example.ts"],
      candidateSha: "a".repeat(40),
      complete: true,
    });
    expect(evidence.manifest.sha256).toHaveLength(64);
    expect(() => assertCompleteReviewEvidence(evidence)).not.toThrow();
  });

  test("one byte over budget is held, never silently clipped to an approvable prefix", () => {
    const evidence = buildCompleteReviewEvidence({ diff, maxBytes: Buffer.byteLength(diff) - 1 });
    expect(evidence.complete).toBe(false);
    expect(evidence.diff).toBe("");
    expect(evidence.reasons.join(" ")).toContain("UTF-8 bytes");
    expect(() => assertCompleteReviewEvidence(evidence)).toThrow("Review evidence incomplete");
  });

  test("missing files, interrupted capture and unsupported binary changes fail closed", () => {
    for (const extra of [
      { captureComplete: false },
      { expectedPaths: ["src/example.ts", "src/missing.ts"] },
      { expectedFileCount: 2 },
      { diff: diff + "GIT binary patch\n" },
      { diff: diff + "...(diff truncated)\n" },
    ]) {
      const evidence = buildCompleteReviewEvidence({ diff, maxBytes: 10_000, ...extra });
      expect(evidence.complete).toBe(false);
      expect(evidence.diff).toBe("");
    }
  });

  test("counts all files, including ninth files and more than 600 patch lines", () => {
    const large = Array.from(
      { length: 9 },
      (_, index) =>
        `diff --git a/src/f${index}.ts b/src/f${index}.ts\n${Array(80).fill("+line").join("\n")}`,
    ).join("\n");
    const evidence = buildCompleteReviewEvidence({
      diff: large,
      maxBytes: 128_000,
      expectedFileCount: 9,
    });
    expect(evidence.complete).toBe(true);
    expect(evidence.diff).toBe(large);
    expect(evidence.manifest.paths).toHaveLength(9);
  });

  test("renames, spaces and quoted UTF-8 paths retain path authority", () => {
    for (const header of [
      'diff --git "a/old name.ts" "b/new name.ts"',
      'diff --git "a/old name.ts" "b/café.ts"',
      'diff --git "a/old name.ts" "b/caf\\303\\251.ts"',
    ]) {
      const expected = header.includes("new name") ? "new name.ts" : "café.ts";
      const evidence = buildCompleteReviewEvidence({
        diff: header + "\n-old\n+new",
        maxBytes: 10_000,
        expectedPaths: ["old name.ts", expected],
      });
      expect(evidence.complete).toBe(true);
      expect(evidence.manifest.paths).toEqual([expected]);
    }
  });

  test("complete hunk counts include blank context, CRLF and no-newline markers", () => {
    for (const body of [
      "@@ -1,2 +1,2 @@\n-old\n+new\n \n",
      "@@ -1 +1 @@\r\n-old\r\n\\ No newline at end of file\r\n+new\r\n\\ No newline at end of file\r\n",
      "@@ -0,0 +1 @@\n+added\n",
      "@@ -1 +0,0 @@\n-deleted\n",
      "@@ -0,0 +0,0 @@\n",
      "old mode 100644\nnew mode 100755\n",
      "similarity index 100%\nrename from old.ts\nrename to new.ts\n",
    ]) {
      expect(
        buildCompleteReviewEvidence({ diff: "diff --git a/x.ts b/x.ts\n" + body, maxBytes: 10_000 })
          .complete,
      ).toBe(true);
    }
    for (const body of [
      "@@ -1,2 +1,2 @@\n-old\n+new\n", // Missing blank context.
      "@@ -1 +1 @@\n-old\n+new\n+extra\n",
      "@@ malformed @@\n-old\n+new\n",
      "--- a/x.ts\n+++ b/x.ts\n",
      "@@ -1 +1 @@\n-old\n@@ -3 +3 @@\n-a\n+b\n",
    ]) {
      const evidence = buildCompleteReviewEvidence({
        diff: "diff --git a/x.ts b/x.ts\n" + body,
        maxBytes: 10_000,
      });
      expect(evidence.complete).toBe(false);
      expect(evidence.diff).toBe("");
      expect(evidence.reasons.join(" ")).toContain("hunk");
    }
  });
});
