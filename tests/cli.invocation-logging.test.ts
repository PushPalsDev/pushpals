import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const thisFilePath = fileURLToPath(import.meta.url);
const testsDir = dirname(thisFilePath);
const repoRoot = resolve(testsDir, "..");
const cliScriptPath = resolve(repoRoot, "scripts", "pushpals-cli.ts");
const bunExecPath = process.execPath;

function currentRuntimePlatformKey(): string {
  if (process.platform === "win32") return "windows-x64";
  if (process.platform === "linux") return "linux-x64";
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "macos-arm64" : "macos-x64";
  }
  throw new Error(`Unsupported test platform: ${process.platform}/${process.arch}`);
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to resolve temporary test port."));
        return;
      }
      const port = address.port;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

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
    expect(stdout).toMatch(/\[\d{4}-\d{2}-\d{2}T[^\]]+Z\]\[pushpals\] invocation=/);
    expect(stdout).toContain("[pushpals] version=1.0.5-test");
    expect(stdout).toContain("[pushpals] platform=");
    expect(stdout).toContain(`[pushpals] cwd=${repoRoot}`);
    expect(stdout).toContain("[pushpals] args=--help");
    expect(stdout).toContain("PushPals CLI");
    expect(stdout).toContain("--open_config, --open-config");
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
      expect(stdout).toMatch(/\[\d{4}-\d{2}-\d{2}T[^\]]+Z\]\[pushpals\] invocation=/);
      expect(stdout).toContain("[pushpals] version=1.0.5-test");
      expect(stdout).toContain("[pushpals] args=--no-auto-start");
      expect(stdout).toContain(`[pushpals] cwd=${cwd}`);
      expect(stderr).toContain("Refusing to start: current directory is not a git repository.");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("runs runtime preflight before server availability failure for external repos", async () => {
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
      writeFileSync(
        join(runtimeRoot, "protocol", "schemas", "envelope.schema.json"),
        "{}\n",
        "utf8",
      );
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
      expect(combined).toContain("pushpals --create_vision_md");
      expect(combined.indexOf("[pushpals] Running runtime preflight...")).toBeGreaterThanOrEqual(0);
      expect(combined.indexOf("Missing required autonomy vision file: vision.md")).toBeGreaterThan(
        combined.indexOf("[pushpals] Running runtime preflight..."),
      );
      expect(combined).not.toContain("LocalBuddy is unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("pushpals --create_vision_md creates a starter vision document and exits before preflight", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-create-vision-"));
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

      const proc = Bun.spawn(
        [
          bunExecPath,
          cliScriptPath,
          "--create_vision_md",
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

      const visionPath = join(repoRoot, "vision.md");
      if (code !== 0) {
        throw new Error(
          `pushpals --create_vision_md exited ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      }
      expect(stderr.trim()).toBe("");
      expect(existsSync(visionPath)).toBe(true);
      expect(readFileSync(visionPath, "utf8")).toContain("# Vision");
      expect(stdout).toContain("[pushpals] args=--create_vision_md");
      expect(stdout).toContain("[pushpals] Created vision.md");
      expect(stdout).toContain("Then run `pushpals` again.");
      expect(stdout).not.toContain("[pushpals] Running runtime preflight...");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("uses the preflighted runtime config for server URL selection", async () => {
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
enabled = true
`,
        "utf8",
      );
      writeFileSync(
        join(repoRoot, "vision.md"),
        "# Vision\n\n> **One sentence:** Keep autonomy active for CLI sessions.\n",
        "utf8",
      );

      const proc = Bun.spawn(
        [
          bunExecPath,
          cliScriptPath,
          "--no-auto-start",
          "--runtime-root",
          runtimeRoot,
          "--server-url",
          "http://127.0.0.1:65534",
        ],
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PUSHPALS_CLI_PACKAGE_VERSION: "1.0.6-test",
            PUSHPALS_SERVER_URL: "",
            EXPO_PUBLIC_LOCAL_AGENT_URL: "",
          },
        },
      );

      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(code).toBe(1);
      expect(stderr).toContain("Server is unavailable at http://127.0.0.1:");
      expect(stderr).not.toContain("http://127.0.0.1:3001");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("reports an unavailable runtime and exits cleanly when --no-auto-start is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-remote-branch-precheck-"));
    const repoRoot = join(root, "repo");
    const remoteRepoRoot = join(root, "remote.git");
    const runtimeRoot = join(root, "runtime");
    const unavailablePort = await findAvailablePort();
    const unavailableServerUrl = `http://127.0.0.1:${unavailablePort}`;

    try {
      mkdirSync(repoRoot, { recursive: true });
      const init = Bun.spawnSync(["git", "init"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);
      const initRemote = Bun.spawnSync(["git", "init", "--bare", remoteRepoRoot], {
        cwd: root,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(initRemote.exitCode).toBe(0);
      const addRemote = Bun.spawnSync(["git", "remote", "add", "origin", remoteRepoRoot], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(addRemote.exitCode).toBe(0);

      mkdirSync(join(runtimeRoot, "configs"), { recursive: true });
      writeFileSync(join(runtimeRoot, ".env"), "PUSHPALS_PROFILE=dev\n", "utf8");
      writeFileSync(join(runtimeRoot, ".env.example"), "PUSHPALS_PROFILE=dev\n", "utf8");
      writeFileSync(join(runtimeRoot, "configs", "local.toml"), "# local overrides\n", "utf8");
      writeFileSync(
        join(runtimeRoot, "configs", "default.toml"),
        `profile = "dev"
session_id = "dev"

[server]
url = "${unavailableServerUrl}"

[localbuddy]
enabled = false
port = 3003

[source_control_manager]
remote = "origin"
pushpals_branch = "main_agents"

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
          "--server-url",
          unavailableServerUrl,
        ],
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PUSHPALS_CLI_PACKAGE_VERSION: "1.0.15-test",
          },
        },
      );

      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(1);
      expect(stderr).toContain(`Server is unavailable at ${unavailableServerUrl}.`);
      expect(stderr).toContain("Auto-start is disabled (--no-auto-start).");
      expect(stderr).not.toContain(
        'Precheck failed: remote branch "origin/main_agents" was not found.',
      );
      expect(stderr).not.toContain("Repo affinity check failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("pushpals --clear removes repo-local state and exits without requiring runtime preflight success", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-clear-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");
    const gitDir = join(repoRoot, ".git");
    const dataDir = join(repoRoot, "outputs", "data");
    const scmWorktree = join(repoRoot, ".worktrees", "source_control_manager");

    try {
      mkdirSync(repoRoot, { recursive: true });
      const init = Bun.spawnSync(["git", "init"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(scmWorktree, { recursive: true });
      mkdirSync(runtimeRoot, { recursive: true });
      writeFileSync(join(dataDir, "pushpals.db"), "placeholder\n", "utf8");
      writeFileSync(join(gitDir, "pushpals-cli-state.json"), "{}\n", "utf8");
      writeFileSync(join(gitDir, "pushpals-client-state.json"), "{}\n", "utf8");

      const proc = Bun.spawn(
        [
          bunExecPath,
          cliScriptPath,
          "--clear",
          "--runtime-root",
          runtimeRoot,
          "--server-url",
          "http://127.0.0.1:65534",
        ],
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PUSHPALS_CLI_PACKAGE_VERSION: "1.0.16-test",
          },
        },
      );

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (code !== 0) {
        throw new Error(
          `pushpals --clear exited ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      }
      expect(stderr.trim()).toBe("");
      expect(stdout).toContain("[pushpals] Clear requested. Removing repo-local PushPals state.");
      expect(stdout).toContain("[pushpals] Clear completed.");
      expect(existsSync(dataDir)).toBe(false);
      expect(existsSync(scmWorktree)).toBe(false);
      expect(existsSync(join(gitDir, "pushpals-cli-state.json"))).toBe(false);
      expect(existsSync(join(gitDir, "pushpals-client-state.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("refuses to attach to a healthy server that belongs to a different repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-repo-affinity-"));
    const repoRoot = join(root, "repo");
    const otherRepoRoot = join(root, "other-repo");
    const runtimeRoot = join(root, "runtime");
    let mockServer: ReturnType<typeof Bun.serve> | null = null;

    try {
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(otherRepoRoot, { recursive: true });
      const init = Bun.spawnSync(["git", "init"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);

      mockServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/healthz") {
            return Response.json({ ok: true });
          }
          if (url.pathname === "/sessions" && req.method === "POST") {
            return Response.json({ sessionId: "dev" }, { status: 201 });
          }
          if (url.pathname === "/system/status") {
            return Response.json({
              ok: true,
              repo: {
                root: otherRepoRoot,
                remote: "origin",
                remoteUrl: null,
                browserUrl: null,
                provider: "unknown",
              },
            });
          }
          return new Response("not found", { status: 404 });
        },
      });

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
url = "http://127.0.0.1:${mockServer.port}"

[localbuddy]
port = 3003

[remotebuddy.autonomy]
enabled = true
`,
        "utf8",
      );
      writeFileSync(
        join(repoRoot, "vision.md"),
        "# Vision\n\n> **One sentence:** Keep autonomy active for CLI sessions.\n",
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "vision.example.md"),
        "# Vision\n\n> **One sentence:** Ship better automation.\n",
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "protocol", "schemas", "envelope.schema.json"),
        "{}\n",
        "utf8",
      );
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
          env: {
            ...process.env,
            PUSHPALS_CLI_PACKAGE_VERSION: "1.0.11-test",
            PUSHPALS_SERVER_URL: "",
            EXPO_PUBLIC_LOCAL_AGENT_URL: "",
          },
        },
      );

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(1);
      expect(stdout).toContain("[pushpals] Running runtime preflight...");
      expect(stderr).toContain("[pushpals] Repo affinity check failed:");
      expect(stderr).toContain(`currentRepo=${repoRoot}`);
      expect(stderr).toContain(`serverRepo=${otherRepoRoot}`);
    } finally {
      mockServer?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("warns and continues when RemoteBuddy autonomy is disabled in runtime config", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-autonomy-required-"));
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
enabled = false
port = 3003

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
          "--runtime-tag",
          "vtest-local",
        ],
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PUSHPALS_CLI_PACKAGE_VERSION: "1.0.13-test",
          },
        },
      );

      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(code).toBe(1);
      expect(stderr).toContain(
        "RemoteBuddy autonomy is disabled in config (remotebuddy.autonomy.enabled=false); continuing.",
      );
      expect(
        stderr.includes("Server is unavailable at http://127.0.0.1:") ||
          stderr.includes("[pushpals] Repo affinity check failed:"),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("refuses to attach to a healthy same-repo server when RemoteBuddy is not connected for the target session", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-remotebuddy-ready-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");
    let mockServer: ReturnType<typeof Bun.serve> | null = null;

    try {
      mkdirSync(repoRoot, { recursive: true });
      const init = Bun.spawnSync(["git", "init"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);

      mockServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/healthz") {
            return Response.json({ ok: true });
          }
          if (url.pathname === "/sessions" && req.method === "POST") {
            return Response.json({ sessionId: "dev" }, { status: 201 });
          }
          if (url.pathname === "/system/status") {
            return Response.json({
              ok: true,
              repo: {
                root: repoRoot,
                remote: "origin",
                remoteUrl: null,
                browserUrl: null,
                provider: "unknown",
              },
              clients: {
                total: 0,
                connected: 0,
                byKind: {},
                items: [],
              },
            });
          }
          return new Response("not found", { status: 404 });
        },
      });

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
url = "http://127.0.0.1:${mockServer.port}"

[localbuddy]
enabled = false
port = 3003

[remotebuddy.autonomy]
enabled = true
`,
        "utf8",
      );
      writeFileSync(
        join(repoRoot, "vision.md"),
        "# Vision\n\n> **One sentence:** Keep autonomy active for CLI sessions.\n",
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "vision.example.md"),
        "# Vision\n\n> **One sentence:** Ship better automation.\n",
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "protocol", "schemas", "envelope.schema.json"),
        "{}\n",
        "utf8",
      );
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
          env: {
            ...process.env,
            PUSHPALS_CLI_PACKAGE_VERSION: "1.0.12-test",
            PUSHPALS_SERVER_URL: "",
            EXPO_PUBLIC_LOCAL_AGENT_URL: "",
          },
        },
      );

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(1);
      expect(stdout).toContain("[pushpals] Running runtime preflight...");
      expect(stderr).toContain("RemoteBuddy is not ready for session dev");
      expect(stderr).toContain(
        "Refusing to start another embedded RemoteBuddy against the same runtime.",
      );
    } finally {
      mockServer?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("creates the interactive session before judging RemoteBuddy readiness on a healthy runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-session-bootstrap-order-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");
    const targetSessionId = "fresh-session";
    let mockServer: ReturnType<typeof Bun.serve> | null = null;
    const createdSessions = new Set<string>();

    try {
      mkdirSync(repoRoot, { recursive: true });
      const init = Bun.spawnSync(["git", "init"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);

      mockServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/healthz") {
            return Response.json({ ok: true });
          }
          if (url.pathname === "/sessions" && req.method === "POST") {
            const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
            const sessionId = String(body.sessionId ?? "").trim() || "dev";
            createdSessions.add(sessionId);
            return Response.json({ sessionId }, { status: 201 });
          }
          if (url.pathname === "/system/status") {
            const items = createdSessions.has(targetSessionId)
              ? [
                  {
                    clientId: "agent_remotebuddy_orchestrator",
                    label: "agent:remotebuddy-orchestrator",
                    kind: "agent",
                    sessionId: targetSessionId,
                    status: "connected",
                  },
                ]
              : [];
            return Response.json({
              ok: true,
              repo: {
                root: repoRoot,
                remote: "origin",
                remoteUrl: null,
                browserUrl: null,
                provider: "unknown",
              },
              clients: {
                total: items.length,
                connected: items.length,
                byKind: items.length > 0 ? { agent: items.length } : {},
                items,
              },
            });
          }
          if (url.pathname === "/workers") {
            return Response.json({
              ok: true,
              workers: [
                {
                  workerId: "workerpal-1",
                  sessionId: targetSessionId,
                  isOnline: true,
                  status: "online",
                  activeJobCount: 0,
                  lastSeenAt: new Date().toISOString(),
                },
              ],
            });
          }
          return new Response("not found", { status: 404 });
        },
      });

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
url = "http://127.0.0.1:${mockServer.port}"

[localbuddy]
enabled = false
port = 3003

[remotebuddy.autonomy]
enabled = true
`,
        "utf8",
      );
      writeFileSync(
        join(repoRoot, "vision.md"),
        "# Vision\n\n> **One sentence:** Keep autonomy active for CLI sessions.\n",
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "vision.example.md"),
        "# Vision\n\n> **One sentence:** Ship better automation.\n",
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "protocol", "schemas", "envelope.schema.json"),
        "{}\n",
        "utf8",
      );
      writeFileSync(join(runtimeRoot, "protocol", "schemas", "events.schema.json"), "{}\n", "utf8");

      const proc = Bun.spawn(
        [
          bunExecPath,
          cliScriptPath,
          "--no-stream",
          "--session-id",
          targetSessionId,
          "--runtime-root",
          runtimeRoot,
          "--runtime-tag",
          "vtest-local",
        ],
        {
          cwd: repoRoot,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PUSHPALS_CLI_PACKAGE_VERSION: "1.0.12-test",
            PUSHPALS_SERVER_URL: "",
            EXPO_PUBLIC_LOCAL_AGENT_URL: "",
          },
        },
      );

      const writer = (async () => {
        await Bun.sleep(300);
        proc.stdin.write("exit\n");
        proc.stdin.end();
      })();

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
        writer,
      ]);

      expect(code).toBe(0);
      expect(
        stderr.trim() === "" ||
          stderr.includes(
            'Precheck: git remote "origin" is not configured in this repo; cannot verify pushpals branch.',
          ),
      ).toBe(true);
      expect(stdout).toContain("[pushpals] Connected.");
      expect(stdout).toContain(`[pushpals] sessionId=${targetSessionId}`);
      expect(createdSessions.has(targetSessionId)).toBe(true);
    } finally {
      mockServer?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("runtime-only mode keeps running after stdin EOF", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-runtime-only-eof-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");
    const targetSessionId = "runtime-only-eof";
    let mockServer: ReturnType<typeof Bun.serve> | null = null;
    let proc: ReturnType<typeof Bun.spawn> | null = null;

    try {
      mkdirSync(repoRoot, { recursive: true });
      const init = Bun.spawnSync(["git", "init"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);

      mockServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/healthz") {
            return Response.json({ ok: true });
          }
          if (url.pathname === "/sessions" && req.method === "POST") {
            const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
            const sessionId = String(body.sessionId ?? "").trim() || targetSessionId;
            return Response.json({ sessionId }, { status: 201 });
          }
          if (url.pathname === "/system/status") {
            return Response.json({
              ok: true,
              repo: {
                root: repoRoot,
                remote: "origin",
                remoteUrl: null,
                browserUrl: null,
                provider: "unknown",
              },
              clients: {
                total: 1,
                connected: 1,
                byKind: { agent: 1 },
                items: [
                  {
                    clientId: "agent_remotebuddy_orchestrator",
                    label: "agent:remotebuddy-orchestrator",
                    kind: "agent",
                    sessionId: targetSessionId,
                    status: "connected",
                  },
                ],
              },
            });
          }
          if (url.pathname === "/workers") {
            return Response.json({
              ok: true,
              workers: [
                {
                  workerId: "workerpal-1",
                  sessionId: targetSessionId,
                  isOnline: true,
                  status: "online",
                  activeJobCount: 0,
                  lastSeenAt: new Date().toISOString(),
                },
              ],
            });
          }
          return new Response("not found", { status: 404 });
        },
      });

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
url = "http://127.0.0.1:${mockServer.port}"

[localbuddy]
enabled = false
port = 3003

[remotebuddy.autonomy]
enabled = true
`,
        "utf8",
      );
      writeFileSync(
        join(repoRoot, "vision.md"),
        "# Vision\n\n> **One sentence:** Keep runtime-only alive for monitoring.\n",
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "vision.example.md"),
        "# Vision\n\n> **One sentence:** Ship better automation.\n",
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "protocol", "schemas", "envelope.schema.json"),
        "{}\n",
        "utf8",
      );
      writeFileSync(join(runtimeRoot, "protocol", "schemas", "events.schema.json"), "{}\n", "utf8");

      proc = Bun.spawn(
        [
          bunExecPath,
          cliScriptPath,
          "--runtime-only",
          "--no-auto-start",
          "--session-id",
          targetSessionId,
          "--runtime-root",
          runtimeRoot,
          "--runtime-tag",
          "vtest-local",
        ],
        {
          cwd: repoRoot,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PUSHPALS_CLI_PACKAGE_VERSION: "1.0.12-test",
            PUSHPALS_SERVER_URL: "",
            EXPO_PUBLIC_LOCAL_AGENT_URL: "",
          },
        },
      );

      await Bun.sleep(700);
      proc.stdin.end();
      const exitedAfterStdinClose = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(900).then(() => false),
      ]);
      expect(exitedAfterStdinClose).toBe(false);

      proc.kill();
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr.trim()).toBe("");
      expect(stdout).toContain("[pushpals] runtimeOnly=true");
      expect(stdout).toContain(
        "[pushpals] Runtime-only stdin closed; continuing until terminated.",
      );
    } finally {
      if (proc) {
        try {
          proc.kill();
        } catch {}
      }
      mockServer?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("does not try to spawn a second RemoteBuddy against an already healthy same-repo runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-remotebuddy-no-duplicate-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");
    const platformKey = currentRuntimePlatformKey();
    const binDir = join(runtimeRoot, "bin", platformKey);
    const extension = platformKey.startsWith("windows-") ? ".exe" : "";
    let mockServer: ReturnType<typeof Bun.serve> | null = null;

    try {
      mkdirSync(repoRoot, { recursive: true });
      const init = Bun.spawnSync(["git", "init"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);

      mockServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/healthz") {
            return Response.json({ ok: true });
          }
          if (url.pathname === "/sessions" && req.method === "POST") {
            return Response.json({ sessionId: "dev" }, { status: 201 });
          }
          if (url.pathname === "/system/status") {
            return Response.json({
              ok: true,
              repo: {
                root: repoRoot,
                remote: "origin",
                remoteUrl: null,
                browserUrl: null,
                provider: "unknown",
              },
              clients: {
                total: 0,
                connected: 0,
                byKind: {},
                items: [],
              },
            });
          }
          return new Response("not found", { status: 404 });
        },
      });

      mkdirSync(join(runtimeRoot, "configs"), { recursive: true });
      mkdirSync(join(runtimeRoot, "prompts"), { recursive: true });
      mkdirSync(join(runtimeRoot, "protocol", "schemas"), { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, ".runtime-tag"), "vtest-local\n", "utf8");
      writeFileSync(join(runtimeRoot, ".env"), "PUSHPALS_PROFILE=dev\n", "utf8");
      writeFileSync(join(runtimeRoot, ".env.example"), "PUSHPALS_PROFILE=dev\n", "utf8");
      writeFileSync(join(runtimeRoot, "configs", "local.toml"), "# local overrides\n", "utf8");
      writeFileSync(
        join(runtimeRoot, "configs", "default.toml"),
        `profile = "dev"
session_id = "dev"

[server]
url = "http://127.0.0.1:${mockServer.port}"

[localbuddy]
enabled = false
port = 3003

[remotebuddy.autonomy]
enabled = true
`,
        "utf8",
      );
      writeFileSync(
        join(repoRoot, "vision.md"),
        "# Vision\n\n> **One sentence:** Keep autonomy active for CLI sessions.\n",
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "vision.example.md"),
        "# Vision\n\n> **One sentence:** Ship better automation.\n",
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "protocol", "schemas", "envelope.schema.json"),
        "{}\n",
        "utf8",
      );
      writeFileSync(join(runtimeRoot, "protocol", "schemas", "events.schema.json"), "{}\n", "utf8");
      writeFileSync(join(binDir, `pushpals-runtime-server-${platformKey}${extension}`), "", "utf8");
      writeFileSync(
        join(binDir, `pushpals-runtime-localbuddy-${platformKey}${extension}`),
        "",
        "utf8",
      );
      writeFileSync(
        join(binDir, `pushpals-runtime-remotebuddy-${platformKey}${extension}`),
        "",
        "utf8",
      );
      writeFileSync(
        join(binDir, `pushpals-runtime-workerpals-${platformKey}${extension}`),
        "",
        "utf8",
      );
      writeFileSync(
        join(binDir, `pushpals-runtime-source-control-manager-${platformKey}${extension}`),
        "",
        "utf8",
      );

      const proc = Bun.spawn(
        [bunExecPath, cliScriptPath, "--runtime-root", runtimeRoot, "--runtime-tag", "vtest-local"],
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PUSHPALS_CLI_PACKAGE_VERSION: "1.0.12-test",
            PUSHPALS_SERVER_URL: "",
            EXPO_PUBLIC_LOCAL_AGENT_URL: "",
          },
        },
      );

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain("RemoteBuddy is not ready for session dev");
      expect(stderr).toContain(
        "Refusing to start another embedded RemoteBuddy against the same runtime.",
      );
      expect(stdout).not.toContain("attempting runtime recovery");
      expect(stdout).not.toContain("Starting embedded RemoteBuddy...");
    } finally {
      mockServer?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
});
