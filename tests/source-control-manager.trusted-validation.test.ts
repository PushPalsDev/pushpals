import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildWindowsProcessTreeTerminationArgv,
  createTrustedValidationProgressLogger,
  hasFreshTrustedValidationInstall,
  normalizeTrustedValidationAffectedPaths,
  resolveTrustedValidationOutcome,
  resolveTrustedValidationArgv,
  runProcessWithTreeTimeout,
  runTrustedValidationCommands,
  trustedValidationHealthPhase,
  trustedValidationInstallFingerprint,
  type TrustedValidationProgressEvent,
} from "../apps/source_control_manager/src/trusted_validation";
import { createSourceControlManagerHealthTracker } from "../apps/source_control_manager/src/runtime_helpers";
import { assertExactCleanValidationWorktree } from "../apps/source_control_manager/src/validation_worktree";
import { SCM_REPAIR_AUTHORITY_SECRET_ENV } from "../packages/shared/src/scm_repair_authority";

function gitResult(repoPath: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repoPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    stdout: Buffer.from(result.stdout).toString("utf8").trim(),
    stderr: Buffer.from(result.stderr).toString("utf8").trim(),
    exitCode: result.exitCode,
  };
}

describe("SourceControlManager trusted validation", () => {
  test("builds a forced Windows process-tree termination command", () => {
    expect(buildWindowsProcessTreeTerminationArgv(4321)).toEqual([
      "taskkill",
      "/PID",
      "4321",
      "/T",
      "/F",
    ]);
  });

  test("returns after a bounded timeout even when the command keeps its streams open", async () => {
    const startedAt = Date.now();
    const result = await runProcessWithTreeTimeout(
      [process.execPath, "-e", "console.log('started'); setInterval(() => {}, 1000)"],
      { cwd: process.cwd(), timeoutMs: 250 },
    );

    expect(result).toMatchObject({ ok: false, exitCode: 124, timedOut: true });
    expect(result.output).toContain("terminated process tree");
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  test("does not expose SCM repair authority to trusted validation commands", async () => {
    const previous = process.env[SCM_REPAIR_AUTHORITY_SECRET_ENV];
    process.env[SCM_REPAIR_AUTHORITY_SECRET_ENV] =
      "test-validation-scm-repair-authority-secret-0123456789abcdef";
    try {
      const result = await runProcessWithTreeTimeout(
        [
          process.execPath,
          "-e",
          `console.log(Object.keys(process.env).filter((key) => key.toLowerCase() === ${JSON.stringify(
            SCM_REPAIR_AUTHORITY_SECRET_ENV.toLowerCase(),
          )}).join(",") || "authority-absent")`,
        ],
        { cwd: process.cwd(), timeoutMs: 2_000 },
      );

      expect(result.ok).toBe(true);
      expect(result.output.trim()).toBe("authority-absent");
    } finally {
      if (previous === undefined) delete process.env[SCM_REPAIR_AUTHORITY_SECRET_ENV];
      else process.env[SCM_REPAIR_AUTHORITY_SECRET_ENV] = previous;
    }
  });

  (process.platform === "win32" ? test : test.skip)(
    "kills inherited-pipe descendants when trusted validation times out on Windows",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-process-tree-"));
      const pidPath = join(root, "descendant.pid");
      try {
        const parentScript = [
          "const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'inherit', stderr: 'inherit' });",
          "await Bun.write(Bun.argv[1], String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" ");
        const result = await runProcessWithTreeTimeout(
          [process.execPath, "-e", parentScript, pidPath],
          { cwd: root, timeoutMs: 750 },
        );
        expect(result.timedOut).toBe(true);
        const descendantPid = (await Bun.file(pidPath).text()).trim();
        const tasklist = Bun.spawn(
          ["tasklist", "/FI", `PID eq ${descendantPid}`, "/FO", "CSV", "/NH"],
          { stdout: "pipe", stderr: "pipe" },
        );
        const output = await new Response(tasklist.stdout).text();
        await tasklist.exited;
        expect(output).not.toContain(`,\"${descendantPid}\",`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("runs normalized commands directly in order", async () => {
    const calls: string[][] = [];
    const results = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun run validate:publish", 'bun test "tests/unit test.ts"']),
      bunExecutable: "C:/runtime/bun.exe",
      runner: async (argv, options) => {
        calls.push(argv);
        expect(options.cwd).toBe("C:/repo");
        expect(options.timeoutMs).toBe(8 * 60_000);
        return { ok: true, output: "passed", exitCode: 0 };
      },
    });

    expect(calls).toEqual([
      ["C:/runtime/bun.exe", "run", "validate:publish"],
      ["C:/runtime/bun.exe", "test", "tests/unit test.ts"],
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  test("keeps a healthy multi-command retry batch fresh with typed progress boundaries", async () => {
    let now = Date.parse("2026-08-18T00:00:00.000Z");
    const tracker = createSourceControlManagerHealthTracker({
      tickStallMs: 17 * 60_000,
      idleBacklogGraceMs: 30_000,
      now: () => now,
    });
    const events: TrustedValidationProgressEvent[] = [];
    const healthDuringAttempts: boolean[] = [];
    let calls = 0;
    tracker.beginTick("trusted_validation");

    await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify([
        "bun test tests/first.test.ts",
        "bun test tests/second.test.ts",
        "bun test tests/third.test.ts",
      ]),
      runner: async () => {
        calls += 1;
        now += 8 * 60_000;
        healthDuringAttempts.push(tracker.snapshot().healthy);
        return calls === 1
          ? { ok: false, output: "TLS handshake timeout", exitCode: 124 }
          : { ok: true, output: "passed", exitCode: 0 };
      },
      onProgress: (event) => {
        events.push(event);
        tracker.progress(trustedValidationHealthPhase(event), "completion-progress");
      },
    });

    expect(calls).toBe(4);
    expect(now).toBe(Date.parse("2026-08-18T00:00:00.000Z") + 32 * 60_000);
    expect(healthDuringAttempts).toEqual([true, true, true, true]);
    expect(events.map(({ boundary, phase, attempt }) => [boundary, phase, attempt])).toEqual([
      ["start", "validation", 1],
      ["complete", "validation", 1],
      ["retry", "validation", 2],
      ["start", "validation", 2],
      ["complete", "validation", 2],
      ["start", "validation", 1],
      ["complete", "validation", 1],
      ["start", "validation", 1],
      ["complete", "validation", 1],
    ]);
    expect(tracker.snapshot()).toMatchObject({
      healthy: true,
      activeCompletionId: "completion-progress",
      phase: "trusted_validation_validation_complete_attempt_1",
    });
  });

  test("marks a validation command unhealthy when its runner stops making progress", async () => {
    let now = Date.parse("2026-08-18T00:00:00.000Z");
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolveGate) => {
      releaseRunner = resolveGate;
    });
    const tracker = createSourceControlManagerHealthTracker({
      tickStallMs: 17 * 60_000,
      idleBacklogGraceMs: 30_000,
      now: () => now,
    });
    tracker.beginTick("trusted_validation");

    const validation = runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun test tests/stuck.test.ts"]),
      runner: async () => {
        await runnerGate;
        return { ok: true, output: "passed", exitCode: 0 };
      },
      onProgress: (event) =>
        tracker.progress(trustedValidationHealthPhase(event), "completion-stuck"),
    });
    await Promise.resolve();

    now += 17 * 60_000;
    expect(tracker.snapshot()).toMatchObject({
      healthy: false,
      activeCompletionId: "completion-stuck",
      phase: "trusted_validation_validation_start_attempt_1",
      reason: expect.stringContaining("tick_stalled"),
    });

    releaseRunner();
    await validation;
    expect(tracker.snapshot()).toMatchObject({
      healthy: true,
      phase: "trusted_validation_validation_complete_attempt_1",
    });
  });

  test("resolves bun and bunx through the absolute embedded runtime without changing other tools", () => {
    const bun = "C:/Users/test/node_modules/bun/bin/bun.exe";
    expect(resolveTrustedValidationArgv(["bun", "test", "tests/a.test.ts"], bun)).toEqual([
      bun,
      "test",
      "tests/a.test.ts",
    ]);
    expect(resolveTrustedValidationArgv(["bunx", "vitest", "run"], bun)).toEqual([
      bun,
      "x",
      "vitest",
      "run",
    ]);
    expect(resolveTrustedValidationArgv(["npm", "test"], bun)).toEqual(["npm", "test"]);
  });

  test("installs a locked Bun workspace before trusted validation in an isolated worktree", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-trusted-validation-"));
    try {
      writeFileSync(join(repoPath, "package.json"), '{"scripts":{"validate":"bun test"}}');
      writeFileSync(join(repoPath, "bun.lock"), "");
      const calls: string[][] = [];
      const results = await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        runner: async (argv) => {
          calls.push(argv);
          return { ok: true, output: "passed", exitCode: 0 };
        },
      });

      expect(calls).toEqual([
        ["/runtime/bun", "install", "--frozen-lockfile"],
        ["/runtime/bun", "run", "validate"],
      ]);
      expect(results.map((result) => result.command)).toEqual([
        "bun install --frozen-lockfile",
        "bun run validate",
      ]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("stops before trusted validation when locked dependency preparation fails", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-trusted-validation-"));
    try {
      writeFileSync(join(repoPath, "package.json"), "{}");
      writeFileSync(join(repoPath, "bun.lockb"), "");
      let calls = 0;
      const results = await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun test"]),
        runner: async () => {
          calls += 1;
          return { ok: false, output: "lockfile mismatch", exitCode: 1 };
        },
      });

      expect(calls).toBe(1);
      expect(results).toMatchObject([
        {
          ok: false,
          command: "bun install --frozen-lockfile",
          output: "lockfile mismatch",
          exitCode: 1,
          durationMs: expect.any(Number),
          phase: "dependency_install",
          failureClass: "dependency_setup_failed",
        },
      ]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("stops after the first trusted validation failure", async () => {
    let calls = 0;
    const results = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify([
        "bun test tests/first.test.ts",
        "bun test tests/second.test.ts",
      ]),
      runner: async () => {
        calls += 1;
        return { ok: false, output: "assertion failed", exitCode: 1 };
      },
    });

    expect(calls).toBe(1);
    expect(results).toMatchObject([
      {
        ok: false,
        command: "bun test tests/first.test.ts",
        output: "assertion failed",
        exitCode: 1,
        durationMs: expect.any(Number),
        phase: "validation",
        failureClass: "test_failure",
      },
    ]);
  });

  test("retries a known transient validation failure exactly once and records the reason", async () => {
    let calls = 0;
    const results = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun test tests/transient.test.ts"]),
      runner: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, output: "TLS handshake timeout", exitCode: 124 }
          : { ok: true, output: "1 pass", exitCode: 0 };
      },
    });

    expect(calls).toBe(2);
    expect(results).toMatchObject([
      {
        ok: false,
        attempt: 1,
        failureClass: "timeout",
        retryReason: "transient_infrastructure",
      },
      {
        ok: true,
        attempt: 2,
        retryReason: "transient_infrastructure",
      },
    ]);
    const outcome = resolveTrustedValidationOutcome(results);
    expect(outcome.terminalResults).toEqual([results[1]]);
    expect(outcome.terminalFailure).toBeNull();
  });

  test("keeps failed retry telemetry but blocks on the terminal attempt when retry also fails", () => {
    const firstAttempt = {
      ok: false,
      command: "bun test tests/transient.test.ts",
      output: "TLS handshake timeout",
      exitCode: 124,
      durationMs: 120,
      phase: "validation" as const,
      attempt: 1,
      retryReason: "transient_infrastructure" as const,
    };
    const terminalAttempt = {
      ...firstAttempt,
      output: "connection reset",
      durationMs: 80,
      attempt: 2,
    };

    const outcome = resolveTrustedValidationOutcome([firstAttempt, terminalAttempt]);

    expect(outcome.terminalResults).toEqual([terminalAttempt]);
    expect(outcome.terminalFailure).toBe(terminalAttempt);
  });

  test("allows publication when dependency preparation recovers on its terminal retry", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-trusted-validation-retry-"));
    try {
      writeFileSync(join(repoPath, "package.json"), "{}");
      writeFileSync(join(repoPath, "bun.lock"), "");
      let calls = 0;
      const progress: TrustedValidationProgressEvent[] = [];
      const results = await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun test"]),
        runner: async (argv) => {
          calls += 1;
          if (argv.includes("install") && calls === 1) {
            return { ok: false, output: "connection reset", exitCode: 1 };
          }
          return { ok: true, output: "passed", exitCode: 0 };
        },
        onProgress: (event) => progress.push(event),
      });

      expect(results).toMatchObject([
        {
          command: "bun install --frozen-lockfile",
          ok: false,
          attempt: 1,
          retryReason: "transient_infrastructure",
        },
        {
          command: "bun install --frozen-lockfile",
          ok: true,
          attempt: 2,
          retryReason: "transient_infrastructure",
        },
        { command: "bun test", ok: true },
      ]);
      expect(resolveTrustedValidationOutcome(results).terminalFailure).toBeNull();
      expect(progress.map(({ boundary, phase, attempt }) => [boundary, phase, attempt])).toEqual([
        ["start", "dependency_install", 1],
        ["complete", "dependency_install", 1],
        ["retry", "dependency_install", 2],
        ["start", "dependency_install", 2],
        ["complete", "dependency_install", 2],
        ["start", "validation", 1],
        ["complete", "validation", 1],
      ]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("does not retry deterministic validation failures", async () => {
    let calls = 0;
    const results = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun test tests/deterministic.test.ts"]),
      runner: async () => {
        calls += 1;
        return { ok: false, output: "expect(received).toBe(expected)", exitCode: 1 };
      },
    });

    expect(calls).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ attempt: 1, failureClass: "test_failure" });
  });

  test("extracts stable Bun failed-test evidence for cross-job correlation", async () => {
    const output = [
      "account\\__tests__\\AccountContext.test.tsx:",
      "(fail) mandatory AccountProvider state machine > fails account deletion locally when the account API is not configured [7ms]",
      "error: expect(received).toBe(expected)",
    ].join("\n");
    const [result] = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun run validate"]),
      runner: async () => ({ ok: false, output, exitCode: 1 }),
    });

    expect(result).toMatchObject({
      ok: false,
      failureClass: "test_failure",
      failedTests: [
        "mandatory AccountProvider state machine > fails account deletion locally when the account API is not configured",
      ],
      targetPathHints: ["account/__tests__/AccountContext.test.tsx"],
    });
  });

  test("keeps named test failures classified as tests when diagnostics mention timeouts", async () => {
    const output = [
      "tests/runWebE2e.test.ts:",
      "(fail) runWebE2e lifecycle > reports a timeout while draining the process tree [21ms]",
      "ProcessTerminationError: teardown timeout after the assertion failed",
    ].join("\n");
    const [result] = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun run validate"]),
      runner: async () => ({ ok: false, output, exitCode: 1 }),
    });

    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      failureClass: "test_failure",
      failedTests: ["runWebE2e lifecycle > reports a timeout while draining the process tree"],
    });
  });

  test("retries an explicit named Vitest timeout once without losing failed-test evidence", async () => {
    let calls = 0;
    const results = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun run validate"]),
      runner: async () => {
        calls += 1;
        return calls === 1
          ? {
              ok: false,
              output: [
                "\u001b[41m FAIL \u001b[49m tests/notifications.vitest.ts > notifications > rejects invalid input",
                "\u001b[31mError: Test timed out in 5000ms.\u001b[39m",
                "If this is a long-running test, pass a timeout value as the last argument.",
              ].join("\n"),
              exitCode: 1,
            }
          : { ok: true, output: "passed", exitCode: 0 };
      },
    });

    expect(calls).toBe(2);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      ok: false,
      attempt: 1,
      failureClass: "test_failure",
      failedTests: ["notifications > rejects invalid input"],
      targetPathHints: ["tests/notifications.vitest.ts"],
      retryReason: "transient_infrastructure",
    });
    expect(results[1]).toMatchObject({ ok: true, attempt: 2 });
    expect(resolveTrustedValidationOutcome(results).terminalFailure).toBeNull();
  });

  test("blocks publication after the second explicit runner timeout", async () => {
    let calls = 0;
    const results = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun run validate", "bun run later"]),
      runner: async () => {
        calls += 1;
        return {
          ok: false,
          output:
            "FAIL tests/notifications.vitest.ts > rejects invalid input\nError: Test timed out in 5000ms.",
          exitCode: 1,
        };
      },
    });

    expect(calls).toBe(2);
    expect(results).toHaveLength(2);
    expect(resolveTrustedValidationOutcome(results).terminalFailure).toMatchObject({
      ok: false,
      attempt: 2,
      failureClass: "test_failure",
      command: "bun run validate",
    });
  });

  test.each([
    {
      name: "a test name quoting a runner timeout",
      output:
        "FAIL tests/runner.vitest.ts > reports Error: Test timed out in 5000ms.\nAssertionError: expected status 1 to be 0",
    },
    {
      name: "an assertion in a second failing test",
      output:
        "FAIL tests/runner.vitest.ts > slow test\nError: Test timed out in 5000ms.\nFAIL tests/runner.vitest.ts > rejects invalid input\nAssertionError: expected status 1 to be 0",
    },
    {
      name: "an assertion before timeout cleanup in the same failed test",
      output:
        "FAIL tests/runner.vitest.ts > rejects invalid input\nAssertionError: expected status 1 to be 0\nError: Test timed out in 5000ms.",
    },
    {
      name: "a second unexplained failed test",
      output:
        "FAIL tests/runner.vitest.ts > unexplained failure\ncustom assertion failed\nFAIL tests/runner.vitest.ts > slow test\nError: Test timed out in 5000ms.",
    },
    {
      name: "another error before a runner timeout",
      output:
        "FAIL tests/runner.vitest.ts > rejects invalid input\nError: invalid response\nError: Test timed out in 5000ms.",
    },
    {
      name: "an assertion diagnostic without an Error class",
      output:
        "FAIL tests/runner.vitest.ts > rejects invalid input\nassertion failed: response status is invalid\nError: Test timed out in 5000ms.",
    },
    {
      name: "a mixed report with a failure from another runner",
      output:
        "FAIL tests/runner.vitest.ts > slow test\nError: Test timed out in 5000ms.\n(fail) another runner > custom failure",
    },
  ])("does not retry $name", async ({ output }) => {
    let calls = 0;
    const results = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun run validate"]),
      runner: async () => {
        calls += 1;
        return { ok: false, output, exitCode: 1 };
      },
    });

    expect(calls).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ attempt: 1, ok: false, failureClass: "test_failure" });
  });

  test("logs identified progress and retries before the validation batch finishes", async () => {
    const lines: string[] = [];
    const identity = {
      jobId: "job-progress",
      completionId: "completion-progress",
      commitSha: "a".repeat(40),
      candidateSha: "b".repeat(40),
    };
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolveGate) => {
      releaseRunner = resolveGate;
    });
    let notifyLastCommandStarted!: () => void;
    const lastCommandStarted = new Promise<void>((resolveStarted) => {
      notifyLastCommandStarted = resolveStarted;
    });
    let calls = 0;
    const validation = runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun run first", "bun run second"]),
      onProgress: createTrustedValidationProgressLogger(identity, (line) => lines.push(line)),
      runner: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            output: "FAIL tests/runner.vitest.ts > slow test\nError: Test timed out in 5000ms.",
            exitCode: 1,
          };
        }
        if (calls === 3) {
          notifyLastCommandStarted();
          await runnerGate;
        }
        return { ok: true, output: "private command output", exitCode: 0 };
      },
    });

    try {
      await lastCommandStarted;
      const events = lines.map((line) => JSON.parse(line.split("trustedValidationProgress=")[1]));
      expect(events.map(({ boundary, attempt }) => [boundary, attempt])).toEqual([
        ["start", 1],
        ["complete", 1],
        ["retry", 2],
        ["start", 2],
        ["complete", 2],
        ["start", 1],
      ]);
      for (const event of events) {
        expect(event).toMatchObject({
          ...identity,
          event: "trusted_validation_progress",
          observedAt: expect.any(String),
          phase: "validation",
        });
      }
      expect(events.at(-1)).toMatchObject({ command: "bun run second", boundary: "start" });
      expect(lines.join("\n")).not.toContain("private command output");
    } finally {
      releaseRunner();
      await validation;
    }
    expect(lines).toHaveLength(7);
  });

  test("decides timeout retries before report truncation can hide a mixed assertion", async () => {
    const output = [
      "FAIL tests/runner.vitest.ts > slow test",
      "Error: Test timed out in 5000ms.",
      ...Array.from({ length: 200 }, () => `failure context ${"x".repeat(100)}`),
      "AssertionError: a deterministic failure must not be retried",
      ...Array.from({ length: 200 }, () => `other diagnostic ${"x".repeat(100)}`),
    ].join("\n");
    let calls = 0;
    const results = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun run validate"]),
      runner: async () => {
        calls += 1;
        return { ok: false, output, exitCode: 1 };
      },
    });

    expect(calls).toBe(1);
    expect(results[0].output).toContain("Test timed out in 5000ms.");
    expect(results[0].output).not.toContain("AssertionError");
    expect(results[0]).toMatchObject({ ok: false, attempt: 1, failureClass: "test_failure" });
  });

  test("redacts credentials from progress logs without changing the executed command", async () => {
    const lines: string[] = [];
    const fakeToken = `ghp_${"synthetic".repeat(4)}`;
    const fakeKey = `sk-${"synthetic".repeat(4)}`;
    const command = `node scripts/check.js --token ${fakeToken} --password "synthetic password with spaces" --api-key=generic-synthetic-key --data ${fakeKey} --url https://synthetic-user:synthetic-password@example.test/check`;
    let executed: string[] = [];
    const results = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify([command]),
      onProgress: createTrustedValidationProgressLogger(
        {
          jobId: "job-redacted",
          completionId: "completion-redacted",
          commitSha: "a".repeat(40),
          candidateSha: "b".repeat(40),
        },
        (line) => lines.push(line),
      ),
      runner: async (argv) => {
        executed = argv;
        return { ok: true, output: "passed", exitCode: 0 };
      },
    });

    expect(results[0].ok).toBe(true);
    expect(executed).toContain(fakeToken);
    expect(executed).toContain("synthetic password with spaces");
    expect(executed).toContain("--api-key=generic-synthetic-key");
    expect(lines).toHaveLength(2);
    const logged = lines.join("\n");
    expect(logged).toContain("node scripts/check.js");
    for (const secret of [
      fakeToken,
      fakeKey,
      "synthetic password",
      "generic-synthetic-key",
      "synthetic-user",
      "synthetic-password",
    ]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain("[redacted]");
  });

  test("reuses a successful trusted install until dependency inputs change", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-trusted-validation-cache-"));
    try {
      writeFileSync(join(repoPath, "package.json"), '{"scripts":{"validate":"bun test"}}');
      writeFileSync(join(repoPath, "bun.lock"), "lock-a");
      const calls: string[][] = [];
      const runner = async (argv: string[]) => {
        calls.push(argv);
        if (argv.includes("install"))
          mkdirSync(join(repoPath, "node_modules"), { recursive: true });
        return { ok: true, output: "passed", exitCode: 0 };
      };
      const invariantContext = {
        baseSha: "a".repeat(40),
        candidateSha: "b".repeat(40),
        affectedPaths: ["src/file.ts"],
      };

      const firstFingerprint = trustedValidationInstallFingerprint({
        repoPath,
        bunExecutable: "/runtime/bun",
        invariantContext,
      });
      const first = await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        invariantContext,
        runner,
      });
      const second = await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        invariantContext,
        runner,
      });

      expect(first[0]?.cached).not.toBe(true);
      expect(second[0]).toMatchObject({
        command: "bun install --frozen-lockfile",
        ok: true,
        cached: true,
        durationMs: 0,
        phase: "dependency_install",
      });
      expect(
        hasFreshTrustedValidationInstall({
          repoPath,
          bunExecutable: "/runtime/bun",
          invariantContext,
        }),
      ).toBe(true);
      expect(calls.filter((argv) => argv.includes("install"))).toHaveLength(1);

      writeFileSync(join(repoPath, "bun.lock"), "lock-b");
      expect(
        trustedValidationInstallFingerprint({
          repoPath,
          bunExecutable: "/runtime/bun",
          invariantContext,
        }),
      ).not.toBe(firstFingerprint);
      await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        invariantContext,
        runner,
      });
      expect(calls.filter((argv) => argv.includes("install"))).toHaveLength(2);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("does not cache install artifacts without exact candidate tree identity", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-trusted-no-tree-cache-"));
    try {
      writeFileSync(join(repoPath, "package.json"), '{"scripts":{"validate":"bun test"}}');
      writeFileSync(join(repoPath, "bun.lock"), "lock-a");
      let installCalls = 0;
      const runner = async (argv: string[]) => {
        if (argv.includes("install")) {
          installCalls += 1;
          mkdirSync(join(repoPath, "node_modules"), { recursive: true });
        }
        return { ok: true, output: "passed", exitCode: 0 };
      };
      await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        runner,
      });
      await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        runner,
      });
      expect(trustedValidationInstallFingerprint({ repoPath })).toBeNull();
      expect(installCalls).toBe(2);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("scopes trusted preparation cache by candidate, base, toolchain, lockfile, and paths", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-trusted-invariant-cache-"));
    try {
      writeFileSync(join(repoPath, "package.json"), '{"scripts":{"validate":"bun test"}}');
      writeFileSync(join(repoPath, "bun.lock"), "lock-a");
      const calls: string[][] = [];
      const runner = async (argv: string[]) => {
        calls.push(argv);
        if (argv.includes("install"))
          mkdirSync(join(repoPath, "node_modules"), { recursive: true });
        return { ok: true, output: "passed", exitCode: 0 };
      };
      const baseSha = "a".repeat(40);
      const candidateSha = "c".repeat(40);
      const firstContext = {
        baseSha,
        candidateSha,
        affectedPaths: ["src\\router.ts", "./tests/router.test.ts", "src/router.ts"],
      };
      const equivalentContext = {
        baseSha: baseSha.toUpperCase(),
        candidateSha: candidateSha.toUpperCase(),
        affectedPaths: ["tests/router.test.ts", "src/router.ts"],
      };

      expect(normalizeTrustedValidationAffectedPaths(firstContext.affectedPaths)).toEqual([
        "src/router.ts",
        "tests/router.test.ts",
      ]);
      expect(
        trustedValidationInstallFingerprint({
          repoPath,
          bunExecutable: "/runtime/bun",
          invariantContext: firstContext,
        }),
      ).toBe(
        trustedValidationInstallFingerprint({
          repoPath,
          bunExecutable: "/runtime/bun",
          invariantContext: equivalentContext,
        }),
      );
      expect(
        trustedValidationInstallFingerprint({
          repoPath,
          bunExecutable: "/runtime/other-bun",
          invariantContext: equivalentContext,
        }),
      ).not.toBe(
        trustedValidationInstallFingerprint({
          repoPath,
          bunExecutable: "/runtime/bun",
          invariantContext: equivalentContext,
        }),
      );

      await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        invariantContext: firstContext,
        runner,
      });
      const repeated = await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        invariantContext: equivalentContext,
        runner,
      });
      expect(repeated[0]).toMatchObject({ phase: "dependency_install", cached: true });
      expect(calls.filter((argv) => argv.includes("install"))).toHaveLength(1);
      // Candidate-sensitive validation is intentionally executed for both
      // candidates even though invariant dependency preparation was cached.
      expect(calls.filter((argv) => argv.includes("validate"))).toHaveLength(2);

      await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        invariantContext: { ...firstContext, baseSha: "b".repeat(40) },
        runner,
      });
      await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        invariantContext: {
          baseSha: "b".repeat(40),
          candidateSha,
          affectedPaths: ["src/other.ts"],
        },
        runner,
      });
      expect(calls.filter((argv) => argv.includes("install"))).toHaveLength(3);

      await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        invariantContext: {
          ...firstContext,
          baseSha: "b".repeat(40),
          affectedPaths: ["src/other.ts"],
          candidateSha: "d".repeat(40),
        },
        runner,
      });
      expect(calls.filter((argv) => argv.includes("install"))).toHaveLength(4);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("serializes different candidate install preparation for the same repository", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-trusted-single-flight-"));
    try {
      writeFileSync(join(repoPath, "package.json"), '{"scripts":{"validate":"bun test"}}');
      writeFileSync(join(repoPath, "bun.lock"), "lock-a");
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise;
      });
      let installCalls = 0;
      let activeInstalls = 0;
      let maxActiveInstalls = 0;
      const runner = async (argv: string[]) => {
        if (argv.includes("install")) {
          installCalls += 1;
          activeInstalls += 1;
          maxActiveInstalls = Math.max(maxActiveInstalls, activeInstalls);
          if (installCalls === 1) await firstGate;
          mkdirSync(join(repoPath, "node_modules"), { recursive: true });
          activeInstalls -= 1;
        }
        return { ok: true, output: "passed", exitCode: 0 };
      };
      const common = {
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        runner,
      };
      const first = runTrustedValidationCommands({
        ...common,
        invariantContext: {
          baseSha: "a".repeat(40),
          candidateSha: "b".repeat(40),
          affectedPaths: ["src/file.ts"],
        },
      });
      while (installCalls === 0) await Bun.sleep(1);
      const second = runTrustedValidationCommands({
        ...common,
        invariantContext: {
          baseSha: "a".repeat(40),
          candidateSha: "c".repeat(40),
          affectedPaths: ["src/file.ts"],
        },
      });
      await Bun.sleep(10);
      expect(installCalls).toBe(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(installCalls).toBe(2);
      expect(maxActiveInstalls).toBe(1);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("waits for an active repo install before trusting a matching cached marker", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-trusted-marker-flight-"));
    try {
      writeFileSync(join(repoPath, "package.json"), '{"scripts":{"validate":"bun test"}}');
      writeFileSync(join(repoPath, "bun.lock"), "lock-a");
      mkdirSync(join(repoPath, "node_modules"), { recursive: true });
      const contextA = {
        baseSha: "a".repeat(40),
        candidateSha: "b".repeat(40),
        affectedPaths: ["src/file.ts"],
      };
      const contextB = {
        baseSha: "a".repeat(40),
        candidateSha: "c".repeat(40),
        affectedPaths: ["src/file.ts"],
      };
      const cachedFingerprintB = trustedValidationInstallFingerprint({
        repoPath,
        bunExecutable: "/runtime/bun",
        invariantContext: contextB,
      });
      writeFileSync(
        join(repoPath, "node_modules", ".pushpals-trusted-install.json"),
        JSON.stringify({ schemaVersion: 3, fingerprint: cachedFingerprintB }),
      );

      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise;
      });
      let installCalls = 0;
      const runner = async (argv: string[]) => {
        if (argv.includes("install")) {
          installCalls += 1;
          if (installCalls === 1) await firstGate;
        }
        return { ok: true, output: "passed", exitCode: 0 };
      };
      const common = {
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        runner,
      };
      const first = runTrustedValidationCommands({ ...common, invariantContext: contextA });
      while (installCalls === 0) await Bun.sleep(1);
      let secondSettled = false;
      const second = runTrustedValidationCommands({
        ...common,
        invariantContext: contextB,
      }).finally(() => {
        secondSettled = true;
      });
      await Bun.sleep(10);
      expect(secondSettled).toBe(false);
      expect(installCalls).toBe(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(installCalls).toBe(2);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("does not let a different-candidate waiter reuse a marker after the active install fails", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-trusted-failed-stale-marker-"));
    let releaseFailedInstall: (() => void) | undefined;
    let activeRun: ReturnType<typeof runTrustedValidationCommands> | undefined;
    let waitingRun: ReturnType<typeof runTrustedValidationCommands> | undefined;
    try {
      writeFileSync(join(repoPath, "package.json"), '{"scripts":{"validate":"bun test"}}');
      writeFileSync(join(repoPath, "bun.lock"), "lock-a");
      mkdirSync(join(repoPath, "node_modules"), { recursive: true });
      const activeContext = {
        baseSha: "a".repeat(40),
        candidateSha: "b".repeat(40),
        affectedPaths: ["src/file.ts"],
      };
      const waitingContext = {
        baseSha: "a".repeat(40),
        candidateSha: "c".repeat(40),
        affectedPaths: ["src/file.ts"],
      };
      const markerPath = join(repoPath, "node_modules", ".pushpals-trusted-install.json");
      const waitingFingerprint = trustedValidationInstallFingerprint({
        repoPath,
        bunExecutable: "/runtime/bun",
        invariantContext: waitingContext,
      });
      writeFileSync(
        markerPath,
        JSON.stringify({ schemaVersion: 3, fingerprint: waitingFingerprint }),
      );

      const failedInstallGate = new Promise<void>((resolvePromise) => {
        releaseFailedInstall = resolvePromise;
      });
      let installCalls = 0;
      const markerPresentAtInstall: boolean[] = [];
      const runner = async (argv: string[]) => {
        if (argv.includes("install")) {
          installCalls += 1;
          markerPresentAtInstall.push(existsSync(markerPath));
          if (installCalls === 1) {
            await failedInstallGate;
            return { ok: false, output: "dependency install failed", exitCode: 1 };
          }
        }
        return { ok: true, output: "passed", exitCode: 0 };
      };
      const common = {
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        runner,
        retryTransientFailures: false,
      };
      activeRun = runTrustedValidationCommands({
        ...common,
        invariantContext: activeContext,
      });
      while (installCalls === 0) await Bun.sleep(1);
      expect(existsSync(markerPath)).toBe(false);

      let waiterSettled = false;
      waitingRun = runTrustedValidationCommands({
        ...common,
        invariantContext: waitingContext,
      }).finally(() => {
        waiterSettled = true;
      });
      await Bun.sleep(10);
      expect(waiterSettled).toBe(false);
      expect(installCalls).toBe(1);

      releaseFailedInstall();
      const [activeResults, waitingResults] = await Promise.all([activeRun, waitingRun]);
      expect(activeResults[0]).toMatchObject({ ok: false, phase: "dependency_install" });
      expect(waitingResults[0]).toMatchObject({
        ok: true,
        phase: "dependency_install",
      });
      expect(waitingResults[0]?.cached).not.toBe(true);
      expect(installCalls).toBe(2);
      expect(markerPresentAtInstall).toEqual([false, false]);
      expect(
        hasFreshTrustedValidationInstall({
          repoPath,
          bunExecutable: "/runtime/bun",
          invariantContext: waitingContext,
        }),
      ).toBe(true);
    } finally {
      releaseFailedInstall?.();
      if (activeRun) await activeRun.catch(() => undefined);
      if (waitingRun) await waitingRun.catch(() => undefined);
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("drains a cancelled different-candidate install before its waiter can replace stale state", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-trusted-cancelled-stale-marker-"));
    let releaseDrain: (() => void) | undefined;
    let activeRun: ReturnType<typeof runTrustedValidationCommands> | undefined;
    let waitingRun: ReturnType<typeof runTrustedValidationCommands> | undefined;
    try {
      writeFileSync(join(repoPath, "package.json"), '{"scripts":{"validate":"bun test"}}');
      writeFileSync(join(repoPath, "bun.lock"), "lock-a");
      mkdirSync(join(repoPath, "node_modules"), { recursive: true });
      const activeContext = {
        baseSha: "a".repeat(40),
        candidateSha: "d".repeat(40),
        affectedPaths: ["src/file.ts"],
      };
      const waitingContext = {
        baseSha: "a".repeat(40),
        candidateSha: "e".repeat(40),
        affectedPaths: ["src/file.ts"],
      };
      const markerPath = join(repoPath, "node_modules", ".pushpals-trusted-install.json");
      const waitingFingerprint = trustedValidationInstallFingerprint({
        repoPath,
        bunExecutable: "/runtime/bun",
        invariantContext: waitingContext,
      });
      writeFileSync(
        markerPath,
        JSON.stringify({ schemaVersion: 3, fingerprint: waitingFingerprint }),
      );

      const drainGate = new Promise<void>((resolvePromise) => {
        releaseDrain = resolvePromise;
      });
      let installCalls = 0;
      let activeAbortObserved = false;
      const markerPresentAtInstall: boolean[] = [];
      const runner = async (argv: string[], options: { signal?: AbortSignal }) => {
        if (argv.includes("install")) {
          installCalls += 1;
          markerPresentAtInstall.push(existsSync(markerPath));
          if (installCalls === 1) {
            await new Promise<void>((resolvePromise) => {
              if (options.signal?.aborted) {
                resolvePromise();
                return;
              }
              options.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
            });
            activeAbortObserved = true;
            await drainGate;
            throw new Error("cancelled install finished draining");
          }
        }
        return { ok: true, output: "passed", exitCode: 0 };
      };
      const common = {
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        runner,
        retryTransientFailures: false,
      };
      const activeController = new AbortController();
      activeRun = runTrustedValidationCommands({
        ...common,
        invariantContext: activeContext,
        signal: activeController.signal,
      });
      while (installCalls === 0) await Bun.sleep(1);
      expect(existsSync(markerPath)).toBe(false);

      let waiterSettled = false;
      waitingRun = runTrustedValidationCommands({
        ...common,
        invariantContext: waitingContext,
      }).finally(() => {
        waiterSettled = true;
      });
      activeController.abort();
      while (!activeAbortObserved) await Bun.sleep(1);
      await Bun.sleep(10);
      expect(waiterSettled).toBe(false);
      expect(installCalls).toBe(1);

      releaseDrain();
      const [activeResults, waitingResults] = await Promise.all([activeRun, waitingRun]);
      expect(activeResults[0]).toMatchObject({
        ok: false,
        phase: "dependency_install",
        failureClass: "timeout",
      });
      expect(activeResults[0]?.output).toContain("cancelled");
      expect(waitingResults[0]).toMatchObject({
        ok: true,
        phase: "dependency_install",
      });
      expect(waitingResults[0]?.cached).not.toBe(true);
      expect(installCalls).toBe(2);
      expect(markerPresentAtInstall).toEqual([false, false]);
    } finally {
      releaseDrain?.();
      if (activeRun) await activeRun.catch(() => undefined);
      if (waitingRun) await waitingRun.catch(() => undefined);
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("cancels a bounded wait without starting a second install", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-trusted-flight-cancel-"));
    try {
      writeFileSync(join(repoPath, "package.json"), '{"scripts":{"validate":"bun test"}}');
      writeFileSync(join(repoPath, "bun.lock"), "lock-a");
      let releaseInstall!: () => void;
      const installGate = new Promise<void>((resolvePromise) => {
        releaseInstall = resolvePromise;
      });
      let installCalls = 0;
      const runner = async (argv: string[]) => {
        if (argv.includes("install")) {
          installCalls += 1;
          await installGate;
          mkdirSync(join(repoPath, "node_modules"), { recursive: true });
        }
        return { ok: true, output: "passed", exitCode: 0 };
      };
      const first = runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        runner,
      });
      while (installCalls === 0) await Bun.sleep(1);
      const controller = new AbortController();
      const waiting = runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        runner,
        signal: controller.signal,
        singleFlightWaitMs: 1_000,
        retryTransientFailures: false,
      });
      controller.abort();
      const waitingResults = await waiting;
      expect(waitingResults[0]).toMatchObject({
        ok: false,
        phase: "dependency_install",
        failureClass: "timeout",
      });
      expect(waitingResults[0]?.output).toContain("cancelled");
      expect(installCalls).toBe(1);
      releaseInstall();
      await first;
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("rejects shell-control payloads before invoking a runner", async () => {
    let called = false;
    await expect(
      runTrustedValidationCommands({
        repoPath: "C:/repo",
        commandsJson: JSON.stringify(["bun test; echo bypass"]),
        runner: async () => {
          called = true;
          return { ok: true, output: "", exitCode: 0 };
        },
      }),
    ).rejects.toThrow("Invalid trusted-validation handoff");
    expect(called).toBe(false);
  });

  test("refuses publication when a passing validation command mutates the candidate", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-validation-mutator-"));
    try {
      expect(gitResult(repoPath, ["init"]).ok).toBe(true);
      expect(gitResult(repoPath, ["config", "user.email", "tests@pushpals.local"]).ok).toBe(true);
      expect(gitResult(repoPath, ["config", "user.name", "PushPals Tests"]).ok).toBe(true);
      writeFileSync(join(repoPath, "candidate.txt"), "immutable\n");
      expect(gitResult(repoPath, ["add", "candidate.txt"]).ok).toBe(true);
      expect(gitResult(repoPath, ["commit", "-m", "candidate"]).ok).toBe(true);
      const candidateSha = gitResult(repoPath, ["rev-parse", "HEAD"]).stdout;

      const results = await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun test"]),
        runner: async () => {
          writeFileSync(join(repoPath, "candidate.txt"), "mutated but command passed\n");
          return { ok: true, output: "1 pass", exitCode: 0 };
        },
      });
      expect(results.at(-1)?.ok).toBe(true);
      await expect(
        assertExactCleanValidationWorktree({
          expectedSha: candidateSha,
          phase: "after trusted validation",
          git: async (args) => gitResult(repoPath, args),
        }),
      ).rejects.toThrow("mutated the candidate worktree");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test.each([
    "powershell -Command Write-Host bypass",
    "bun -e console.log(1)",
    "python -c print(1)",
    "C:/tools/bun run validate",
  ])("rejects host-execution escape command: %s", async (command) => {
    await expect(
      runTrustedValidationCommands({
        repoPath: "C:/repo",
        commandsJson: JSON.stringify([command]),
        runner: async () => ({ ok: true, output: "", exitCode: 0 }),
      }),
    ).rejects.toThrow("Invalid trusted-validation handoff");
  });
});
