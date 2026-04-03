import { describe, expect, test } from "bun:test";
import {
  compactJobOutput,
  filterResultLines,
  parseStructuredResult,
} from "../apps/workerpals/src/common/execution_utils";

describe("workerpals execution utils config-aware behavior", () => {
  test("parseStructuredResult supports a custom executor prefix", () => {
    const stdout = [
      "normal line",
      '__CUSTOM_PREFIX__ {"ok":false}',
      '__CUSTOM_PREFIX__ {"ok":true,"summary":"done"}',
    ].join("\n");

    const parsed = parseStructuredResult(stdout, "__CUSTOM_PREFIX__ ");
    expect(parsed).not.toBeNull();
    expect(parsed?.ok).toBe(true);
    expect(parsed?.summary).toBe("done");
  });

  test("filterResultLines removes only lines with the configured prefix", () => {
    const stdout = ["keep this", '__CUSTOM_PREFIX__ {"ok":true}', "keep this too"].join("\n");

    const filtered = filterResultLines(stdout, "__CUSTOM_PREFIX__ ");
    expect(filtered).toContain("keep this");
    expect(filtered).toContain("keep this too");
    expect(filtered).not.toContain("__CUSTOM_PREFIX__");
  });

  test("compactJobOutput respects policy overrides", () => {
    const long = Array.from({ length: 120 }, (_, idx) => `line-${idx}`).join("\n");
    const compact = compactJobOutput(long, {
      maxOutputChars: 32_768,
      maxOutputLines: 50,
      maxOutputHeadLines: 10,
    });

    expect(compact).toContain("lines omitted");
    expect(compact).toContain("line-119");
    expect(compact).not.toContain("line-60");
  });
});
