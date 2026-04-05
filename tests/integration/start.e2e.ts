import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { createServer } from "net";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRepoRoot = resolve(__dirname, "..", "..");

function decodeOutput(data: string | Uint8Array | null | undefined): string {
  if (typeof data === "string") return data;
  if (!data) return "";
  return Buffer.from(data).toString("utf8");
}

function runChecked(
  cmd: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): { stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = decodeOutput(proc.stdout);
  const stderr = decodeOutput(proc.stderr);
  if (proc.exitCode !== 0) {
    throw new Error(
      `Command failed (${proc.exitCode}): ${cmd.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return { stdout, stderr };
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.once("listening", () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePortBlock(size = 3): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const base = 24000 + Math.floor(Math.random() * 20000);
    let ok = true;
    for (let offset = 0; offset < size; offset += 1) {
      if (!(await isPortAvailable(base + offset))) {
        ok = false;
        break;
      }
    }
    if (ok) return base;
  }
  throw new Error("Failed to reserve an available port block for start.e2e.");
}

function copyTrackedWorkingTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  const { stdout } = runChecked(["git", "ls-files", "-z"], source);
  const paths = stdout.split("\u0000").filter(Boolean);
  for (const relativePath of paths) {
    const from = join(source, relativePath);
    if (!existsSync(from)) continue;
    const to = join(destination, relativePath);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { force: true, recursive: true });
  }
}

function linkNodeModules(source: string, destination: string): boolean {
  if (!existsSync(source)) return false;
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawnSync(["cmd", "/c", "mklink", "/J", destination, source], {
        stdout: "ignore",
        stderr: "ignore",
      });
      return proc.exitCode === 0;
    }
    const proc = Bun.spawnSync(["ln", "-s", source, destination], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

function initializeSourceCheckout(root: string): { repoPath: string; remotePath: string } {
  const repoPath = join(root, "repo");
  const remotePath = join(root, "origin.git");
  copyTrackedWorkingTree(sourceRepoRoot, repoPath);
  cpSync(join(repoPath, ".env.example"), join(repoPath, ".env"), { force: true });
  const linkedNodeModules = linkNodeModules(
    join(sourceRepoRoot, "node_modules"),
    join(repoPath, "node_modules"),
  );
  if (!linkedNodeModules) {
    runChecked([process.execPath, "install", "--linker", "hoisted"], repoPath, process.env as Record<string, string>);
  }

  runChecked(["git", "init"], repoPath);
  runChecked(["git", "branch", "-M", "main"], repoPath);
  runChecked(["git", "config", "user.name", "PushPals Start E2E"], repoPath);
  runChecked(["git", "config", "user.email", "pushpals-start-e2e@example.com"], repoPath);
  runChecked(["git", "add", "."], repoPath);
  runChecked(["git", "commit", "-m", "chore: seed start e2e repo"], repoPath);
  runChecked(["git", "init", "--bare", remotePath], root);
  runChecked(["git", "remote", "add", "origin", remotePath], repoPath);
  runChecked(["git", "push", "-u", "origin", "main"], repoPath);
  runChecked(["git", "checkout", "-b", "main_agents"], repoPath);
  runChecked(["git", "push", "-u", "origin", "main_agents"], repoPath);
  runChecked(["git", "checkout", "main"], repoPath);
  return { repoPath, remotePath };
}

function ensureDockerImageTag(tag: string): void {
  const inspect = Bun.spawnSync(["docker", "image", "inspect", tag], {
    cwd: sourceRepoRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (inspect.exitCode === 0) return;
  runChecked(
    ["docker", "build", "-f", "apps/workerpals/Dockerfile.sandbox", "-t", tag, "."],
    sourceRepoRoot,
    process.env as Record<string, string>,
  );
}

function seedTemplateLocalConfig(repoPath: string): void {
  cpSync(join(repoPath, "configs", "local.example.toml"), join(repoPath, "configs", "local.toml"), {
    force: true,
  });
}

async function waitForExitWithTimeout(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      proc.exited,
      new Promise<number>((_, reject) => {
        timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          reject(new Error(`start.e2e timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for HTTP readiness at ${url}`);
}

function tailText(value: string, maxChars = 4000): string {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

async function waitForLogLine(pathValue: string, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pathValue)) {
      const content = readFileSync(pathValue, "utf8");
      if (content.includes(needle)) return;
    }
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for "${needle}" in ${pathValue}`);
}

function parsePidList(text: string): number[] {
  return text
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function findListeningPidsForPort(port: number): number[] {
  if (process.platform === "win32") {
    const proc = Bun.spawnSync(["netstat", "-ano", "-p", "tcp"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to inspect listening TCP ports: ${decodeOutput(proc.stderr)}`);
    }
    const pids = new Set<number>();
    for (const line of decodeOutput(proc.stdout).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("TCP")) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 5) continue;
      const localAddress = parts[1] ?? "";
      const state = parts[3] ?? "";
      const pid = Number.parseInt(parts[4] ?? "", 10);
      if (state !== "LISTENING") continue;
      if (!localAddress.endsWith(`:${port}`)) continue;
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    return Array.from(pids);
  }

  const proc = Bun.spawnSync(["lsof", `-tiTCP:${port}`, "-sTCP:LISTEN"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0 && decodeOutput(proc.stderr).trim().length > 0) {
    throw new Error(`Failed to inspect listening TCP ports: ${decodeOutput(proc.stderr)}`);
  }
  return parsePidList(decodeOutput(proc.stdout));
}

async function terminateListeningProcess(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = findListeningPidsForPort(port);
    if (pids.length > 0) {
      for (const pid of pids) {
        if (process.platform === "win32") {
          Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
            stdout: "ignore",
            stderr: "ignore",
          });
        } else {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // best-effort only
          }
        }
      }
      return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for a listening process on port ${port}`);
}

async function removeTreeWithRetries(pathValue: string, attempts = 8): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(pathValue, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(500 * (attempt + 1));
    }
  }
  if (lastError) throw lastError;
}

test(
  "bun run start exits non-zero after repeated server crashes exhaust restart budget",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-start-e2e-"));
    const dockerImage = `pushpals-worker-sandbox:start-e2e-${Date.now()}`;
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const { repoPath } = initializeSourceCheckout(root);
      const portBase = await findAvailablePortBlock();
      ensureDockerImageTag(dockerImage);
      seedTemplateLocalConfig(repoPath);
      const scmRepoPath = join(repoPath, ".worktrees", "source_control_manager").replace(/\\/g, "/");
      const systemLogPath = join(repoPath, "system.log");

      proc = Bun.spawn([process.execPath, "run", "scripts/start.ts"], {
        cwd: repoPath,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PUSHPALS_PORT: String(portBase),
          LOCAL_AGENT_PORT: String(portBase + 2),
          SOURCE_CONTROL_MANAGER_PORT: String(portBase + 1),
          SOURCE_CONTROL_MANAGER_NO_PUSH: "1",
          PUSHPALS_SKIP_GH_AUTH_CHECK: "1",
          SOURCE_CONTROL_MANAGER_REMOTE: "origin",
          SOURCE_CONTROL_MANAGER_MAIN_BRANCH: "main_agents",
          SOURCE_CONTROL_MANAGER_BASE_BRANCH: "main",
          SOURCE_CONTROL_MANAGER_SKIP_CLEAN_CHECK: "1",
          SOURCE_CONTROL_MANAGER_AUTO_CREATE_MAIN_BRANCH: "1",
          SOURCE_CONTROL_MANAGER_REPO_PATH: scmRepoPath,
          SOURCE_CONTROL_MANAGER_REVIEW_AGENT_ENABLED: "0",
          LOCALBUDDY_ENABLED: "0",
          REMOTEBUDDY_AUTONOMY_ENABLED: "0",
          REMOTEBUDDY_MAX_WORKERPALS: "1",
          WORKERPALS_DOCKER_IMAGE: dockerImage,
          PUSHPALS_LOG_CONFIG_ON_START: "0",
          PUSHPALS_SYNC_INTEGRATION_WITH_MAIN: "0",
          PUSHPALS_SKIP_LLM_PREFLIGHT: "1",
          PUSHPALS_AUTO_START_LMSTUDIO: "0",
          PUSHPALS_STARTUP_WARMUP: "0",
        },
      });
      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();

      const serverHealthUrl = `http://127.0.0.1:${portBase}/healthz`;
      try {
        await waitForHttpOk(serverHealthUrl, 180_000);
      } catch (error) {
        try {
          proc.kill();
        } catch {}
        const [stdout, stderr] = await Promise.all([
          stdoutPromise.catch(() => ""),
          stderrPromise.catch(() => ""),
        ]);
        const systemLog = existsSync(systemLogPath) ? readFileSync(systemLogPath, "utf8") : "";
        throw new Error(
          `${String(error)}\n--- stdout tail ---\n${tailText(stdout)}\n--- stderr tail ---\n${tailText(stderr)}\n--- system.log tail ---\n${tailText(systemLog)}`,
        );
      }

      for (let crash = 1; crash <= 5; crash += 1) {
        await terminateListeningProcess(portBase, 30_000);
        await waitForLogLine(systemLogPath, "Managed server exited", 30_000);
        if (crash < 5) {
          await waitForHttpOk(serverHealthUrl, 90_000);
        }
      }

      const [stdout, stderr, exitCode] = await Promise.all([
        stdoutPromise,
        stderrPromise,
        waitForExitWithTimeout(proc, 120_000),
      ]);
      const combined = `${stdout}\n${stderr}\n${readFileSync(systemLogPath, "utf8")}`;

      expect(exitCode).toBe(1);
      expect(combined).toContain("Critical managed service server reached restart exhaustion");
      expect(combined).toContain("Managed server exited");
    } finally {
      if (proc) {
        try {
          proc.kill();
        } catch {}
      }
      try {
        Bun.spawnSync(["docker", "image", "rm", "-f", dockerImage], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {}
      try {
        await removeTreeWithRetries(root);
      } catch (err) {
        console.warn(`[start.e2e] Temp cleanup warning for ${root}: ${String(err)}`);
      }
    }
  },
  12 * 60_000,
);
