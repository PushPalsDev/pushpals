import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function git(cwd: string, args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function mustGit(cwd: string, args: string[]): Promise<void> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

async function createTempRepo(options: { includeLock: boolean }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-preflight-"));
  mkdirSync(join(dir, "configs"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"preflight-temp","version":"1.0.0"}\n', "utf8");
  if (options.includeLock) {
    writeFileSync(join(dir, "bun.lock"), "lockfileVersion = 1\n", "utf8");
  }
  writeFileSync(join(dir, "configs", "default.toml"), "title = \"temp\"\n", "utf8");
  await mustGit(dir, ["init"]);
  await mustGit(dir, ["config", "user.name", "Preflight Test"]);
  await mustGit(dir, ["config", "user.email", "preflight@example.com"]);
  await mustGit(dir, ["add", "-A"]);
  await mustGit(dir, ["commit", "-m", "init"]);
  return dir;
}

async function runPreflightCli(args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "run", "remotebuddy:preflight", "--", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

describe("remotebuddy:preflight CLI", () => {
  test("reports human and JSON output for clean repos", async () => {
    const repo = await createTempRepo({ includeLock: true });
    try {
      const human = await runPreflightCli(["--repo", repo]);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("[preflight] PASSED");

      const jsonRun = await runPreflightCli(["--repo", repo, "--json"]);
      expect(jsonRun.exitCode).toBe(0);
      const parsed = JSON.parse(jsonRun.stdout);
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.checks)).toBe(true);
      expect(parsed.checks.length).toBeGreaterThanOrEqual(2);
      expect(parsed.summary.totalChecks).toBeGreaterThanOrEqual(parsed.checks.length);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("fails fast with actionable dependency guidance", async () => {
    const repo = await createTempRepo({ includeLock: false });
    try {
      const human = await runPreflightCli(["--repo", repo]);
      expect(human.exitCode).toBe(1);
      expect(human.stdout).toContain("dependencies.lockfile_missing");
      expect(human.stderr).toContain("bun install");

      const jsonRun = await runPreflightCli(["--repo", repo, "--json"]);
      expect(jsonRun.exitCode).toBe(1);
      const parsed = JSON.parse(jsonRun.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.failure?.code).toContain("dependencies");
      expect(parsed.summary.failedChecks).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
