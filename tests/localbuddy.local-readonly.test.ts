import { describe, expect, test } from "bun:test";
import {
  isGitStatusPrompt,
  isLocalReadonlyQueryPrompt,
  isSystemStatusPrompt,
} from "../apps/localbuddy/src/local_readonly";

describe("local readonly prompt detection", () => {
  test("detects git status prompts", () => {
    expect(isGitStatusPrompt("can you run git status on the repo?")).toBe(true);
    expect(isGitStatusPrompt("show me git status")).toBe(true);
  });

  test("detects system/database status prompts", () => {
    expect(isSystemStatusPrompt("check database status")).toBe(true);
    expect(isSystemStatusPrompt("what is the system status right now?")).toBe(true);
  });

  test("flags local readonly prompts correctly", () => {
    expect(isLocalReadonlyQueryPrompt("can you run git status?")).toBe(true);
    expect(isLocalReadonlyQueryPrompt("check db status")).toBe(true);
    expect(isLocalReadonlyQueryPrompt("fix a bug in apps/server")).toBe(false);
  });
});
