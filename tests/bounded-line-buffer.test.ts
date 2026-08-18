import { describe, expect, test } from "bun:test";
import {
  OUTPUT_LINE_TRUNCATED_MARKER,
  appendBoundedLineChunk,
  finishBoundedLineBuffer,
} from "../scripts/bounded_line_buffer";

describe("bounded runtime line buffering", () => {
  test("caps a no-newline stream and continues with later lines", () => {
    const oversized = appendBoundedLineChunk("", "x".repeat(20), 8);
    expect(oversized.lines).toEqual(["xxxxxxxx", OUTPUT_LINE_TRUNCATED_MARKER]);
    expect(oversized.pending).toBe("");

    const resumed = appendBoundedLineChunk(oversized.pending, "tail\n", 8);
    expect(resumed.lines).toEqual(["tail"]);
    expect(resumed.pending).toBe("");
  });

  test("caps a completed oversized line and flushes the final decoder tail", () => {
    const chunk = appendBoundedLineChunk("", "abcdefghijkl\nnext", 6);
    expect(chunk.lines).toEqual(["abcdef", OUTPUT_LINE_TRUNCATED_MARKER]);
    expect(finishBoundedLineBuffer(chunk.pending, "-tail", 16)).toEqual(["next-tail"]);
  });
});
