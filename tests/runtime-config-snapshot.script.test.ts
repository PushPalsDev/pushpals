import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsDir, "..");
const bunExecPath = (process.execPath ?? "").trim() || "bun";
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-runtime-snapshot-"));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("runtime config snapshot script", () => {
  test("prints parseable localbuddy runtime state for external supervisors", async () => {
    const proc = Bun.spawn([bunExecPath, "run", "scripts/runtime_config_snapshot.ts"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr.trim()).toBe("");

    const parsed = JSON.parse(stdout) as {
      localbuddy?: { enabled?: unknown; port?: unknown };
    };
    expect(typeof parsed.localbuddy?.enabled).toBe("boolean");
    expect(typeof parsed.localbuddy?.port).toBe("number");
    expect(Number.isFinite(parsed.localbuddy?.port)).toBe(true);
  });

  test("reads live LOCALBUDDY env aliases from on-disk .env instead of stale parent env", async () => {
    const root = makeTempDir();
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "default.toml"),
      ['profile = "dev"', "", "[localbuddy]", "enabled = false", "port = 3003", ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(root, ".env"),
      ["LOCALBUDDY_ENABLED=true", "LOCAL_AGENT_PORT=4105", ""].join("\n"),
      "utf8",
    );

    const proc = Bun.spawn([bunExecPath, "run", resolve(repoRoot, "scripts/runtime_config_snapshot.ts")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        LOCALBUDDY_ENABLED: "false",
        LOCAL_AGENT_PORT: "3003",
      },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    cleanupTempDirs();

    expect(exitCode).toBe(0);
    expect(stderr.trim()).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      localbuddy: {
        enabled: true,
        port: 4105,
      },
    });
  });
});
