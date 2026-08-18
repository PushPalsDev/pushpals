import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildWindowsProcessTreeTerminationArgv,
  hasFreshTrustedValidationInstall,
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

      const firstFingerprint = trustedValidationInstallFingerprint({
        repoPath,
        bunExecutable: "/runtime/bun",
      });
      const first = await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        runner,
      });
      const second = await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
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
      expect(hasFreshTrustedValidationInstall({ repoPath, bunExecutable: "/runtime/bun" })).toBe(
        true,
      );
      expect(calls.filter((argv) => argv.includes("install"))).toHaveLength(1);

      writeFileSync(join(repoPath, "bun.lock"), "lock-b");
      expect(
        trustedValidationInstallFingerprint({ repoPath, bunExecutable: "/runtime/bun" }),
      ).not.toBe(firstFingerprint);
      await runTrustedValidationCommands({
        repoPath,
        commandsJson: JSON.stringify(["bun run validate"]),
        bunExecutable: "/runtime/bun",
        runner,
      });
      expect(calls.filter((argv) => argv.includes("install"))).toHaveLength(2);
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
