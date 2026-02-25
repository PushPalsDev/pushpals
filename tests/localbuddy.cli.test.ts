import { describe, expect, test } from "bun:test";
import { resolveLocalBuddyPort } from "../apps/localbuddy/src/localbuddy_main";

describe("LocalBuddy CLI parsing", () => {
  test("--port accepts separate values and enforces range", () => {
    expect(resolveLocalBuddyPort(["--port", "4004"], 3003)).toBe(4004);
    expect(resolveLocalBuddyPort(["--port", " 65535 "], 3003)).toBe(65535);
  });

  test("--port=VALUE works with inline assignment", () => {
    expect(resolveLocalBuddyPort(["--port=5000"], 3003)).toBe(5000);
    expect(resolveLocalBuddyPort(["--port=1"], 3003)).toBe(1);
  });

  test("invalid --port inputs throw descriptive errors", () => {
    expect(() => resolveLocalBuddyPort(["--port"], 3003)).toThrow(/requires a port value/i);
    expect(() => resolveLocalBuddyPort(["--port", "abc"], 3003)).toThrow(/must be an integer/i);
    expect(() => resolveLocalBuddyPort(["--port=0"], 3003)).toThrow(/between 1 and 65535/i);
    expect(() => resolveLocalBuddyPort(["--port=70000"], 3003)).toThrow(/between 1 and 65535/i);
  });
});
