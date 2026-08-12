import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildWindowsProcessTreeTerminationArgv,
  hasFreshTrustedValidationInstall,
  resolveTrustedValidationArgv,
  runProcessWithTreeTimeout,
  runTrustedValidationCommands,
  trustedValidationInstallFingerprint,
} from "../apps/source_control_manager/src/trusted_validation";

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
