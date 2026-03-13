import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const thisFilePath = fileURLToPath(import.meta.url);
const testsDir = dirname(thisFilePath);
const repoRoot = resolve(testsDir, "..");
const cliScriptPath = resolve(repoRoot, "scripts", "pushpals-cli.ts");
const bunExecPath = process.execPath;

describe("pushpals CLI invocation logging", () => {
  test("prints invocation context before help output", async () => {
    const proc = Bun.spawn([bunExecPath, cliScriptPath, "--help"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PUSHPALS_CLI_PACKAGE_VERSION: "1.0.5-test" },
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).toBe(0);
    expect(stderr.trim()).toBe("");
    expect(stdout).toContain("[pushpals] invocation=");
    expect(stdout).toContain("[pushpals] version=1.0.5-test");
    expect(stdout).toContain("[pushpals] platform=");
    expect(stdout).toContain(`[pushpals] cwd=${repoRoot}`);
    expect(stdout).toContain("[pushpals] args=--help");
    expect(stdout).toContain("PushPals CLI");
  });

  test("prints invocation context before early non-git failure", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pushpals-cli-non-git-"));

    try {
      const proc = Bun.spawn([bunExecPath, cliScriptPath, "--no-auto-start"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PUSHPALS_CLI_PACKAGE_VERSION: "1.0.5-test" },
      });

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(1);
      expect(stdout).toContain("[pushpals] invocation=");
      expect(stdout).toContain("[pushpals] version=1.0.5-test");
      expect(stdout).toContain("[pushpals] args=--no-auto-start");
      expect(stdout).toContain(`[pushpals] cwd=${cwd}`);
      expect(stderr).toContain("Refusing to start: current directory is not a git repository.");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
