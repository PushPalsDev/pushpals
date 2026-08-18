import { describe, expect, test } from "bun:test";
import { appendSessionEventBuffer } from "../scripts/pushpals-cli";

describe("CLI SSE buffering", () => {
  test("rejects malformed events that never provide a frame delimiter", () => {
    expect(() => appendSessionEventBuffer("data: 1234", "56789", 12)).toThrow(
      "exceeded 12 character buffer limit",
    );
  });

  test("accepts chunks within the configured bound", () => {
    expect(appendSessionEventBuffer("data: ", "{}", 16)).toBe("data: {}");
  });
});
