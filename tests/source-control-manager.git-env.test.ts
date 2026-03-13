import { afterEach, describe, expect, test } from "bun:test";
import { resolveGitExecutableFromEnv } from "../apps/source_control_manager/src/git.ts";

const originalGitBin = process.env.PUSHPALS_GIT_BIN;

afterEach(() => {
  if (originalGitBin === undefined) {
    delete process.env.PUSHPALS_GIT_BIN;
  } else {
    process.env.PUSHPALS_GIT_BIN = originalGitBin;
  }
});

describe("source_control_manager git executable resolution", () => {
  test("defaults to git when no override is configured", () => {
    delete process.env.PUSHPALS_GIT_BIN;
    expect(resolveGitExecutableFromEnv()).toBe("git");
  });

  test("uses PUSHPALS_GIT_BIN when configured", () => {
    process.env.PUSHPALS_GIT_BIN = "C:\\Program Files\\Git\\cmd\\git.exe";
    expect(resolveGitExecutableFromEnv()).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });
});
