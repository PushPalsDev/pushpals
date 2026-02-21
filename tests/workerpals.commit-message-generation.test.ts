import { describe, expect, test } from "bun:test";
import {
  buildCommitMessageGeneratorUserMessage,
  sanitizeGeneratedCommitMessage,
} from "../apps/workerpals/src/execute_job";

describe("workerpals commit message generation helpers", () => {
  test("builds user prompt with background context, filtered test commands, and staged diff", () => {
    const prompt = buildCommitMessageGeneratorUserMessage(
      "can you add more tests for localbuddy",
      ["bun --cwd apps/localbuddy test", "echo hello", "pytest -q tests/foo.py"],
      "diff --git a/a.ts b/a.ts",
    );

    expect(prompt).toContain("Background context (do not copy into subject line):");
    expect(prompt).toContain("Validation steps:");
    expect(prompt).toContain("- bun --cwd apps/localbuddy test");
    expect(prompt).toContain("- pytest -q tests/foo.py");
    expect(prompt).not.toContain("echo hello");
    expect(prompt).toContain("Staged diff (derive subject and bullets from this):");
    expect(prompt).toContain("diff --git a/a.ts b/a.ts");
  });

  test("falls back to '- (none)' when no validation step is test-like", () => {
    const prompt = buildCommitMessageGeneratorUserMessage(
      "do a small tweak",
      ["echo hi", "ls -la"],
      "diff --git a/README.md b/README.md",
    );

    expect(prompt).toContain("Validation steps:");
    expect(prompt).toContain("- (none)");
  });

  test("truncates instruction to 400 chars", () => {
    const instruction = "x".repeat(450);
    const prompt = buildCommitMessageGeneratorUserMessage(instruction, [], "diff --git a/x b/x");

    const expected = `Background context (do not copy into subject line): ${"x".repeat(400)}`;
    expect(prompt).toContain(expected);
    expect(prompt).not.toContain(`Background context (do not copy into subject line): ${"x".repeat(401)}`);
  });

  test("sanitizes fenced commit output and validates prefix", () => {
    const content = [
      "```text",
      "fix(workerpals): tighten commit prompt guidance",
      "",
      "- update prompt instructions",
      "",
      "Tests:",
      "- bun run test:root",
      "```",
    ].join("\n");

    expect(sanitizeGeneratedCommitMessage(content, "fix", "workerpals")).toBe(
      [
        "fix(workerpals): tighten commit prompt guidance",
        "",
        "- update prompt instructions",
        "",
        "Tests:",
        "- bun run test:root",
      ].join("\n"),
    );
    expect(sanitizeGeneratedCommitMessage(content, "feat", "workerpals")).toBeNull();
  });
});
