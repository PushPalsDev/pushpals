import { describe, expect, test } from "bun:test";
import {
  compactJobOutput,
  filterResultLines,
  hasStructuredResultSentinel,
  parseStructuredResult,
  validateStructuredJobResultEnvelope,
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

  test("treats a newest empty sentinel as authoritative and malformed", () => {
    const prefix = "__CUSTOM_PREFIX__ ";
    const stdout = [`${prefix}{"ok":true}`, prefix.trimEnd()].join("\n");

    expect(hasStructuredResultSentinel(stdout, prefix)).toBe(true);
    expect(parseStructuredResult(stdout, prefix)).toBeNull();
    expect(filterResultLines(stdout, prefix)).toBe("");
  });

  test("validates process-boundary result fields without coercion", () => {
    expect(validateStructuredJobResultEnvelope({ ok: true })).toEqual({
      valid: true,
      ok: true,
    });
    expect(validateStructuredJobResultEnvelope({ ok: false, exitCode: -3 })).toEqual({
      valid: true,
      ok: false,
      exitCode: -3,
    });

    for (const value of [
      null,
      [],
      { exitCode: 0 },
      { ok: "false", exitCode: 0 },
      { ok: true, exitCode: "3" },
      { ok: true, exitCode: 0.5 },
      { ok: true, exitCode: Number.POSITIVE_INFINITY },
    ]) {
      expect(validateStructuredJobResultEnvelope(value).valid).toBe(false);
    }
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
