import { describe, expect, test } from "bun:test";
import {
  buildCommitMessageGeneratorUserMessage,
  isTestLikeValidationStep,
  sanitizeGeneratedCommitMessage,
} from "../apps/workerpals/src/execute_job";

describe("workerpals commit message generation helpers", () => {
  test("builds user prompt with background context, filtered test commands, and staged diff", () => {
    const prompt = buildCommitMessageGeneratorUserMessage(
      "can you add more tests for localbuddy",
      ["bun --cwd apps/localbuddy test", "echo hello", "pytest -q tests/foo.py"],
      "diff --git a/a.ts b/a.ts",
    );

    expect(prompt).toContain("Background context (do not restate in subject or bullets):");
    expect(prompt).toContain("Validation steps (for Tests section only):");
    expect(prompt).toContain("- bun --cwd apps/localbuddy test");
    expect(prompt).toContain("- pytest -q tests/foo.py");
    expect(prompt).not.toContain("echo hello");
    expect(prompt).toContain("Staged diff (derive subject line and all bullets from this):");
    expect(prompt).toContain("diff --git a/a.ts b/a.ts");
  });

  test("includes bun run test:root in validation steps", () => {
    const prompt = buildCommitMessageGeneratorUserMessage(
      "fix something",
      ["bun run test:root", "git status --porcelain"],
      "diff --git a/x.ts b/x.ts",
    );

    expect(prompt).toContain("- bun run test:root");
    expect(prompt).not.toContain("git status");
  });

  test("falls back to '- (none)' when no validation step is test-like", () => {
    const prompt = buildCommitMessageGeneratorUserMessage(
      "do a small tweak",
      ["echo hi", "ls -la"],
      "diff --git a/README.md b/README.md",
    );

    expect(prompt).toContain("Validation steps (for Tests section only):");
    expect(prompt).toContain("- (none)");
  });

  test("truncates instruction to 400 chars", () => {
    const instruction = "x".repeat(450);
    const prompt = buildCommitMessageGeneratorUserMessage(instruction, [], "diff --git a/x b/x");

    const expected = `Background context (do not restate in subject or bullets): ${"x".repeat(400)}`;
    expect(prompt).toContain(expected);
    expect(prompt).not.toContain(
      `Background context (do not restate in subject or bullets): ${"x".repeat(401)}`,
    );
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

  test("isTestLikeValidationStep recognises bun run test:* script aliases", () => {
    // npm-script-style test aliases — most common pattern in this repo
    expect(isTestLikeValidationStep("bun run test:root")).toBe(true);
    expect(isTestLikeValidationStep("bun run test:integration")).toBe(true);
    expect(isTestLikeValidationStep("npm run test:unit")).toBe(true);
    expect(isTestLikeValidationStep("pnpm run test:e2e")).toBe(true);
    // bare "bun test" still passes
    expect(isTestLikeValidationStep("bun test")).toBe(true);
    expect(isTestLikeValidationStep("bun --cwd apps/localbuddy test")).toBe(true);
    // yarn shorthand: "yarn test:integration" (no "run")
    expect(isTestLikeValidationStep("yarn test:integration")).toBe(true);
    // direct bun execution of test files
    expect(isTestLikeValidationStep("bun ./tests/protocol.integration.ts")).toBe(true);
    expect(isTestLikeValidationStep("bun ./apps/localbuddy/tests/routing.test.ts")).toBe(true);
    // non-test commands must still be rejected
    expect(isTestLikeValidationStep("bun run build")).toBe(false);
    expect(isTestLikeValidationStep("npm run lint")).toBe(false);
    expect(isTestLikeValidationStep("git status --porcelain")).toBe(false);
    expect(isTestLikeValidationStep("echo hello")).toBe(false);
  });

  test("rejects planning-heavy implementation bullets even when tests section has concrete commands", () => {
    const content = [
      "fix(workerpals): improve localbuddy tests",
      "",
      "- At least one new unit test is added.",
      "- All existing and new tests pass.",
      "- No unrelated files are modified.",
      "",
      "Tests:",
      "- bun --cwd apps/localbuddy test",
      "- bun run test:root",
    ].join("\n");

    expect(sanitizeGeneratedCommitMessage(content, "fix", "workerpals")).toBeNull();
  });
});
