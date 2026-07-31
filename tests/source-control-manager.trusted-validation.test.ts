import { describe, expect, test } from "bun:test";
import { runTrustedValidationCommands } from "../apps/source_control_manager/src/trusted_validation";

describe("SourceControlManager trusted validation", () => {
  test("runs normalized commands directly in order", async () => {
    const calls: string[][] = [];
    const results = await runTrustedValidationCommands({
      repoPath: "C:/repo",
      commandsJson: JSON.stringify(["bun run validate:publish", 'bun test "tests/unit test.ts"']),
      runner: async (argv, options) => {
        calls.push(argv);
        expect(options.cwd).toBe("C:/repo");
        return { ok: true, output: "passed", exitCode: 0 };
      },
    });

    expect(calls).toEqual([
      ["bun", "run", "validate:publish"],
      ["bun", "test", "tests/unit test.ts"],
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
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
