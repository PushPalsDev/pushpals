import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildSandboxArtifactUnstageCommand,
  buildGitCommitArgs,
  buildStageCommand,
  buildWorkerCommitMessage,
  buildCommitMessageGeneratorUserMessage,
  explicitWorkerCommitIdentityFromEnv,
  isNonFastForwardPushOutput,
  isPullRebaseDirtyWorkingTreeOutput,
  isRebaseConflictOutput,
  isRebaseEditorPromptOutput,
  isTestLikeValidationStep,
  parseChangedPathsFromNameOnlyOutput,
  redactSensitiveText,
  sanitizeGeneratedCommitMessage,
  shouldUseCodexCliForExecutor,
  resolveWorkerCommitIdentity,
} from "../apps/workerpals/src/execute_job";

async function runGit(repo: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout.trim();
}

describe("workerpals commit message generation helpers", () => {
  test("task.execute stages the full sandbox diff instead of only target hints", () => {
    expect(
      buildStageCommand("task.execute", {
        paths: ["app/game.tsx"],
        planning: {
          scope: {
            writeGlobs: ["app/game.tsx"],
          },
        },
      }),
    ).toEqual(["add", "-A"]);
  });

  test("task.execute stage pathspec ignores runtime artifact directories cleanly", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-stage-ignore-"));
    try {
      await runGit(repo, ["init"]);
      writeFileSync(join(repo, ".gitignore"), "outputs/\nworkspace/\n");
      writeFileSync(join(repo, "README.md"), "hello\n");
      mkdirSync(join(repo, "outputs"), { recursive: true });
      mkdirSync(join(repo, "workspace", "bash_events"), { recursive: true });
      writeFileSync(join(repo, "outputs", "runtime.db"), "ignored\n");
      writeFileSync(join(repo, "workspace", "bash_events", "event.log"), "ignored\n");
      writeFileSync(join(repo, "node_modules"), "managed dependency link placeholder\n");

      const stageArgs = buildStageCommand("task.execute", {
        planning: { scope: { writeGlobs: ["README.md"] } },
      });
      expect(stageArgs).not.toBeNull();
      await runGit(repo, stageArgs!);
      await runGit(repo, buildSandboxArtifactUnstageCommand());

      const staged = await runGit(repo, ["diff", "--cached", "--name-only"]);
      expect(staged.split(/\r?\n/).filter(Boolean).sort()).toEqual([".gitignore", "README.md"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

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

  test("parses changed paths from git name-only output without '.' or duplicates", () => {
    const parsed = parseChangedPathsFromNameOnlyOutput(
      [
        ".",
        "apps/localbuddy/src/request_status.ts",
        "apps/localbuddy/src/request_status.ts",
        "wiki/05-localbuddy.md",
        "",
      ].join("\n"),
    );

    expect(parsed).toEqual(["apps/localbuddy/src/request_status.ts", "wiki/05-localbuddy.md"]);
  });

  test("deterministic fallback commit message uses changed paths over instruction text", () => {
    const message = buildWorkerCommitMessage(
      "workerpal-test",
      {
        id: "job-1",
        taskId: "task-1",
        kind: "task.execute",
        params: {
          instruction: "can you add 1 more test case for localbuddy",
          targetPath: ".",
          validationSteps: ["bun --cwd apps/localbuddy test"],
        },
      },
      ["apps/localbuddy/src/request_status.ts", "apps/localbuddy/tests/request_status.test.ts"],
    );

    expect(message).toContain(
      "feat(local_agent): update localbuddy implementation and test coverage",
    );
    expect(message).toContain("- update apps/localbuddy/src/request_status.ts");
    expect(message).toContain(
      "- add or update tests in apps/localbuddy/tests/request_status.test.ts",
    );
    expect(message).toContain("Tests:\n- bun --cwd apps/localbuddy test");
    expect(message).not.toContain("updated path: .");
    expect(message).not.toContain("can you add 1 more test case for localbuddy");
  });

  test("redacts credentialed git URL and bearer tokens from error text", () => {
    const redacted = redactSensitiveText(
      "Failed to push branch: fatal: 'https%3A//oauth2%3Agho_abcdefghijklmnopqrstuvwxyz123456@github.com/PushPalsDev/pushpals' Bearer sk-proj-secret-token",
    );

    expect(redacted).toContain("https%3A//***@github.com");
    expect(redacted).toContain("Bearer ***");
    expect(redacted).not.toContain("gho_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("sk-proj-secret-token");
  });

  test("detects non-fast-forward push rejection output", () => {
    const text = [
      "To https://github.com/PushPalsDev/pushpals.git",
      " ! [rejected] refs/foo -> refs/heads/foo (non-fast-forward)",
      "error: failed to push some refs",
      "hint: Updates were rejected because a pushed branch tip is behind its remote counterpart.",
    ].join("\n");
    expect(isNonFastForwardPushOutput(text)).toBe(true);
    expect(isNonFastForwardPushOutput("fatal: authentication failed")).toBe(false);
  });

  test("detects rebase conflict output", () => {
    expect(
      isRebaseConflictOutput(
        "CONFLICT (content): Merge conflict in apps/localbuddy/src/request_status.ts",
      ),
    ).toBe(true);
    expect(
      isRebaseConflictOutput("error: could not apply 1234abcd... add tests for request status"),
    ).toBe(true);
    expect(isRebaseConflictOutput("fatal: could not read Username for 'https://github.com'")).toBe(
      false,
    );
  });

  test("detects rebase editor prompt output", () => {
    const message = [
      "error: Terminal is dumb, but EDITOR unset",
      "Please supply the message using either -m or -F option.",
      "error: could not commit staged changes.",
    ].join("\n");
    expect(isRebaseEditorPromptOutput(message)).toBe(true);
    expect(isRebaseEditorPromptOutput("CONFLICT (content): Merge conflict in file.ts")).toBe(false);
  });

  test("detects pull --rebase dirty working-tree output", () => {
    const message = [
      "error: cannot pull with rebase: You have unstaged changes.",
      "error: Please commit or stash them.",
    ].join("\n");
    expect(isPullRebaseDirtyWorkingTreeOutput(message)).toBe(true);
    expect(
      isPullRebaseDirtyWorkingTreeOutput("fatal: cannot rebase: You have unstaged changes."),
    ).toBe(true);
    expect(
      isPullRebaseDirtyWorkingTreeOutput("fatal: unable to access 'https://github.com/...': 401"),
    ).toBe(false);
  });

  test("uses codex commit-message path when executor is openai_codex", () => {
    expect(shouldUseCodexCliForExecutor("openai_codex")).toBe(true);
    expect(shouldUseCodexCliForExecutor(" OPENAI_CODEX ")).toBe(true);
    expect(shouldUseCodexCliForExecutor("openhands")).toBe(false);
  });

  test("resolves commit identity from git config instead of GitHub user APIs", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-worker-identity-"));
    const previousEnv = {
      WORKERPALS_GIT_AUTHOR_NAME: process.env.WORKERPALS_GIT_AUTHOR_NAME,
      WORKERPALS_GIT_AUTHOR_EMAIL: process.env.WORKERPALS_GIT_AUTHOR_EMAIL,
      PUSHPALS_GIT_AUTHOR_NAME: process.env.PUSHPALS_GIT_AUTHOR_NAME,
      PUSHPALS_GIT_AUTHOR_EMAIL: process.env.PUSHPALS_GIT_AUTHOR_EMAIL,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    };
    try {
      delete process.env.WORKERPALS_GIT_AUTHOR_NAME;
      delete process.env.WORKERPALS_GIT_AUTHOR_EMAIL;
      delete process.env.PUSHPALS_GIT_AUTHOR_NAME;
      delete process.env.PUSHPALS_GIT_AUTHOR_EMAIL;
      delete process.env.GIT_AUTHOR_NAME;
      delete process.env.GIT_AUTHOR_EMAIL;

      await runGit(repo, ["init"]);
      await runGit(repo, ["config", "user.name", "PiyushDatta"]);
      await runGit(repo, ["config", "user.email", "piyushdattaca@gmail.com"]);

      await expect(resolveWorkerCommitIdentity(repo)).resolves.toEqual({
        name: "PiyushDatta",
        email: "piyushdattaca@gmail.com",
        source: "source-control-config",
      });
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("builds git commit args with resolved author identity", () => {
    expect(
      buildGitCommitArgs("feat(worker): test", {
        name: "PiyushDatta",
        email: "piyushdattaca@gmail.com",
        source: "source-control-config",
      }),
    ).toEqual([
      "-c",
      "user.name=PiyushDatta",
      "-c",
      "user.email=piyushdattaca@gmail.com",
      "commit",
      "--author",
      "PiyushDatta <piyushdattaca@gmail.com>",
      "-m",
      "feat(worker): test",
    ]);
  });

  test("explicit commit author env sanitizes unsafe fields and can reuse fallback email", () => {
    expect(
      explicitWorkerCommitIdentityFromEnv(
        {
          PUSHPALS_GIT_AUTHOR_NAME: " PushPals <Bot>\n",
        },
        "bot@example.com",
      ),
    ).toEqual({
      name: "PushPals Bot",
      email: "bot@example.com",
      source: "env",
    });
  });

  test("git commit args set author and committer identity", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-worker-commit-author-"));
    try {
      await runGit(repo, ["init"]);
      await runGit(repo, ["config", "user.name", "Host User"]);
      await runGit(repo, ["config", "user.email", "host@example.com"]);
      writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
      await runGit(repo, ["add", "README.md"]);
      await runGit(
        repo,
        buildGitCommitArgs("feat(worker): author identity", {
          name: "PiyushDatta",
          email: "piyushdattaca@gmail.com",
          source: "source-control-config",
        }),
      );

      const identity = await runGit(repo, [
        "log",
        "-1",
        "--format=%an <%ae>|%cn <%ce>",
      ]);
      expect(identity).toBe(
        "PiyushDatta <piyushdattaca@gmail.com>|PiyushDatta <piyushdattaca@gmail.com>",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
