import { describe, expect, test } from "bun:test";
import {
  allocateEvidenceBytes,
  excerptRepositoryText,
} from "../apps/remotebuddy/src/repository_evidence";

describe("bounded repository evidence windows", () => {
  test("fair allocation preserves small later files and never exceeds either byte cap", () => {
    const budgets = allocateEvidenceBytes(
      [100_000, 100_000, 100_000, 100_000, 100_000, 200],
      32_000,
      16_384,
    );
    expect(budgets).toEqual([6_360, 6_360, 6_360, 6_360, 6_360, 200]);
    expect(allocateEvidenceBytes([100, 100, 100], 10, 100)).toEqual([4, 3, 3]);
    expect(allocateEvidenceBytes([10, 100, 100], 100, 20)).toEqual([10, 20, 20]);
    expect(allocateEvidenceBytes([100], 0, 100)).toEqual([0]);
  });

  test("preserves complete small files and their original CRLF line coordinates", () => {
    const text = "first\r\n日本語🙂\r\nlast";
    expect(excerptRepositoryText(text, false, 1_000, [])).toEqual({
      content: text,
      truncated: false,
      scanTruncated: false,
      lineRanges: [{ startLine: 1, endLine: 3 }],
    });
  });

  test("finds a relevant implementation beyond the old prefix and preserves its line number", () => {
    const lines = Array.from(
      { length: 900 },
      (_, index) => `row ${index + 1}: ${"neutral ".repeat(12)}`,
    );
    lines[611] = "export function reconcileSchedulingLease() { return recoverLostClaim(); }";
    const excerpt = excerptRepositoryText(lines.join("\n"), false, 8_192, [
      "reconcileSchedulingLease",
      "recoverLostClaim",
    ]);
    expect(excerpt.content).toContain(lines[611]!);
    expect(excerpt.lineRanges.some((range) => range.startLine <= 612 && range.endLine >= 612)).toBe(
      true,
    );
    expect(excerpt.lineRanges.some((range) => range.startLine === 1)).toBe(true);
    expect(excerpt.lineRanges.some((range) => range.endLine === 900)).toBe(true);
    expect(Buffer.byteLength(excerpt.content, "utf8")).toBeLessThanOrEqual(8_192);
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.scanTruncated).toBe(false);
  });

  test.each([{ terms: [] as string[] }, { terms: ["header_keyword"] }])(
    "retains body coverage when terms match only headers or nowhere: %j",
    ({ terms }) => {
      const lines = Array.from(
        { length: 600 },
        (_, index) =>
          `${index < 200 ? "header_keyword" : "body implementation"} ${index}: ${"padding ".repeat(12)}`,
      );
      const excerpt = excerptRepositoryText(lines.join("\n"), false, 4_096, terms);
      expect(excerpt.content).toContain("body implementation");
      expect(excerpt.lineRanges.some((range) => range.startLine > 200 && range.endLine < 590)).toBe(
        true,
      );
      expect(excerpt.lineRanges.some((range) => range.endLine === 600)).toBe(true);
      expect(Buffer.byteLength(excerpt.content, "utf8")).toBeLessThanOrEqual(4_096);
    },
  );

  test.each(["支付", "日本語", "결제", "カナ"])(
    "ranks short CJK terms beyond the fixed coverage windows: %s",
    (term) => {
      const lines = Array.from(
        { length: 900 },
        (_, index) => `row ${index + 1}: ${"neutral ".repeat(12)}`,
      );
      lines[611] = `export function ${term}() { return verifyClaim(); }`;
      const unranked = excerptRepositoryText(lines.join("\n"), false, 4_096, []);
      expect(unranked.content).not.toContain(lines[611]!);
      const ranked = excerptRepositoryText(lines.join("\n"), false, 4_096, [term]);
      expect(ranked.content).toContain(lines[611]!);
      expect(
        ranked.lineRanges.some((range) => range.startLine <= 612 && range.endLine >= 612),
      ).toBe(true);
    },
  );

  test("accounts for UTF-8 bytes rather than UTF-16 characters in CRLF windows", () => {
    const lines = Array.from(
      { length: 400 },
      (_, index) => `第${index + 1}行 ${"日本語🙂".repeat(12)}`,
    );
    const excerpt = excerptRepositoryText(lines.join("\r\n"), false, 2_000, ["日本語"]);
    expect(Buffer.byteLength(excerpt.content, "utf8")).toBeLessThanOrEqual(2_000);
    expect(excerpt.content).not.toContain("\uFFFD");
    expect(excerpt.lineRanges[0]?.startLine).toBe(1);
    expect(excerpt.lineRanges.at(-1)?.endLine).toBe(400);
    for (const range of excerpt.lineRanges) {
      expect(excerpt.content).toContain(lines[range.startLine - 1]!);
      expect(excerpt.content).toContain(lines[range.endLine - 1]!);
    }
  });

  test("huge individual lines and tiny budgets cannot acquire complete-line citations", () => {
    const text = "🙂".repeat(32_768);
    for (const budget of [0, 1, 31, 1_024]) {
      const excerpt = excerptRepositoryText(text, true, budget, []);
      expect(Buffer.byteLength(excerpt.content, "utf8")).toBeLessThanOrEqual(budget);
      expect(excerpt.content).not.toContain("\uFFFD");
      expect(excerpt.lineRanges).toEqual([]);
      expect(excerpt.truncated).toBe(true);
      expect(excerpt.scanTruncated).toBe(true);
    }
  });

  test("never presents the incomplete final scanned line as a fully observed line", () => {
    const excerpt = excerptRepositoryText("first\nsecond\npartial", true, 1_000, []);
    expect(excerpt.lineRanges).toEqual([{ startLine: 1, endLine: 2 }]);
    expect(excerpt.scanTruncated).toBe(true);
    const bounded = excerptRepositoryText(`${"complete\n".repeat(1_000)}partial`, true, 2_000, []);
    expect(bounded.lineRanges.every((range) => range.endLine <= 1_000)).toBe(true);
  });
});
