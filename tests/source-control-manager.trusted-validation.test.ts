import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveTrustedValidationArgv,
  runTrustedValidationCommands,
} from "../apps/source_control_manager/src/trusted_validation";

describe("SourceControlManager trusted validation", () => {
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
      expect(results).toEqual([
        {
          ok: false,
          command: "bun install --frozen-lockfile",
          output: "lockfile mismatch",
          exitCode: 1,
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
    expect(results).toEqual([
      {
        ok: false,
        command: "bun test tests/first.test.ts",
        output: "assertion failed",
        exitCode: 1,
      },
    ]);
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
