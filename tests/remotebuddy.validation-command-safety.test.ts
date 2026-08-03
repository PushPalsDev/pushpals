import { describe, expect, test } from "bun:test";
import { normalizeValidationSteps } from "../apps/remotebuddy/src/remotebuddy_main";

describe("RemoteBuddy planner validation command safety", () => {
  test("removes shell pipelines before dispatch while preserving plain commands", () => {
    expect(
      normalizeValidationSteps(
        [
          "git diff --check -- README.md",
          "git diff --name-only | grep -qx 'README.md'",
          "bun test",
        ],
        ["README.md"],
      ),
    ).toEqual(["git diff --check -- README.md", "bun test"]);
  });

  test("keeps a quoted pipe that is an argument instead of a shell control token", () => {
    expect(normalizeValidationSteps(['bun test -t "route|shell"'], ["README.md"])).toEqual([
      'bun test -t "route|shell"',
    ]);
  });
});
