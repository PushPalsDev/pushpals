import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
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

  test("runs runtime preflight before LocalBuddy probing for external repos", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-preflight-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");

    try {
      mkdirSync(repoRoot, { recursive: true });
      const init = Bun.spawnSync(["git", "init"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);
      mkdirSync(join(runtimeRoot, "configs"), { recursive: true });
      mkdirSync(join(runtimeRoot, "prompts"), { recursive: true });
      mkdirSync(join(runtimeRoot, "protocol", "schemas"), { recursive: true });
      writeFileSync(join(runtimeRoot, ".env"), "PUSHPALS_PROFILE=dev\n", "utf8");
      writeFileSync(join(runtimeRoot, ".env.example"), "PUSHPALS_PROFILE=dev\n", "utf8");
      writeFileSync(join(runtimeRoot, "configs", "local.toml"), "# local overrides\n", "utf8");
      writeFileSync(
        join(runtimeRoot, "configs", "default.toml"),
        `profile = "dev"
session_id = "dev"

[server]
url = "http://127.0.0.1:3001"

[localbuddy]
port = 3003

[remotebuddy.autonomy]
enabled = true
`,
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "vision.example.md"),
        "# Vision\n\n> **One sentence:** Ship better automation.\n",
        "utf8",
      );
      writeFileSync(join(runtimeRoot, "protocol", "schemas", "envelope.schema.json"), "{}\n", "utf8");
      writeFileSync(join(runtimeRoot, "protocol", "schemas", "events.schema.json"), "{}\n", "utf8");

      const proc = Bun.spawn(
        [
          bunExecPath,
          cliScriptPath,
          "--no-auto-start",
          "--runtime-root",
          runtimeRoot,
          "--runtime-tag",
          "vtest-local",
        ],
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PUSHPALS_CLI_PACKAGE_VERSION: "1.0.6-test" },
        },
      );

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      const combined = `${stdout}\n${stderr}`;

      expect(code).toBe(1);
      expect(stdout).toContain("[pushpals] Running runtime preflight...");
      expect(stdout).toContain("[pushpals] runtimeRoot=");
      expect(combined).toContain("Missing required autonomy vision file: vision.md");
      expect(combined.indexOf("[pushpals] Running runtime preflight...")).toBeGreaterThanOrEqual(0);
      expect(combined.indexOf("Missing required autonomy vision file: vision.md")).toBeGreaterThan(
        combined.indexOf("[pushpals] Running runtime preflight..."),
      );
      expect(combined).not.toContain("LocalBuddy is unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the preflighted runtime config for LocalBuddy URL selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-config-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");

    try {
      mkdirSync(repoRoot, { recursive: true });
      const init = Bun.spawnSync(["git", "init"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);
      mkdirSync(join(runtimeRoot, "configs"), { recursive: true });
      writeFileSync(join(runtimeRoot, ".env"), "PUSHPALS_PROFILE=dev\n", "utf8");
      writeFileSync(join(runtimeRoot, ".env.example"), "PUSHPALS_PROFILE=dev\n", "utf8");
      writeFileSync(join(runtimeRoot, "configs", "local.toml"), "# local overrides\n", "utf8");
      writeFileSync(
        join(runtimeRoot, "configs", "default.toml"),
        `profile = "dev"
session_id = "dev"

[server]
url = "http://127.0.0.1:3991"

[localbuddy]
port = 3999

[remotebuddy.autonomy]
enabled = false
`,
        "utf8",
      );

      const proc = Bun.spawn(
        [
          bunExecPath,
          cliScriptPath,
          "--no-auto-start",
          "--runtime-root",
          runtimeRoot,
        ],
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PUSHPALS_CLI_PACKAGE_VERSION: "1.0.6-test",
            EXPO_PUBLIC_LOCAL_AGENT_URL: "",
          },
        },
      );

      const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain("LocalBuddy is unavailable at http://localhost:3999.");
      expect(stderr).not.toContain("http://localhost:3003");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
