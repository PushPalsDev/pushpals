import { describe, expect, test } from "bun:test";
import { formatClockTime } from "../apps/localbuddy/src/request_status";

describe("localbuddy formatClockTime", () => {
  test("formats ISO timestamp to clock time", () => {
    const result = formatClockTime("2026-02-13T01:00:00.000Z");
    expect(result).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
  });

  test("returns 'unknown' for invalid timestamp", () => {
    const result = formatClockTime("invalid");
    expect(result).toBe("unknown");
  });

  test("handles edge case with null", () => {
    const result = formatClockTime(null as unknown as string);
    expect(result).toBe("unknown");
  });
});