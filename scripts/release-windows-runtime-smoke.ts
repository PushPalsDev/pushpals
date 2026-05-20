#!/usr/bin/env bun

import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

type SmokeOptions = {
  runtimeBinDir: string;
  promptsRoot: string;
  durationMs: number;
  repoPath: string | null;
  useRepoDataDir: boolean;
};

type SpawnedProc = ReturnType<typeof Bun.spawn>;

const thisFilePath = fileURLToPath(import.meta.url);
const scriptsDir = dirname(thisFilePath);
const repoRoot = resolve(scriptsDir, "..");
export const WORKERPAL_WARMUP_OUTCOME_PATTERN =
  /Initial WorkerPal capacity ready via|Auto-spawn disabled:|WorkerPal process .* exited with code|Failed to prepare Docker image|Direct mode with isolated worktrees enabled|\[WorkerPals workerpal-[^\]]+\] Polling/i;

function parseArgs(argv: string[]): SmokeOptions {
  let runtimeBinDir = "";
  let promptsRoot = repoRoot;
  let durationMs = 60_000;
  let repoPath: string | null = null;
  let useRepoDataDir = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--runtime-bin-dir":
        runtimeBinDir = String(argv[++index] ?? "").trim();
        break;
      case "--prompts-root":
        promptsRoot = String(argv[++index] ?? "").trim() || repoRoot;
        break;
      case "--duration-ms":
        durationMs = Math.max(10_000, Number.parseInt(String(argv[++index] ?? "60000"), 10) || 60_000);
        break;
      case "--repo-path":
        repoPath = String(argv[++index] ?? "").trim() || null;
        break;
      case "--use-repo-data-dir":
        useRepoDataDir = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!runtimeBinDir) {
    throw new Error("--runtime-bin-dir is required");
  }
  return {
    runtimeBinDir: resolve(runtimeBinDir),
    promptsRoot: resolve(promptsRoot),
    durationMs,
    repoPath: repoPath ? resolve(repoPath) : null,
    useRepoDataDir,
  };
}

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

function buildServiceEnv(options: {
  configDir: string;
  repoPath: string;
  promptsRoot: string;
  protocolSchemasDir: string;
  dataDir?: string | null;
  workerpalBin?: string | null;
  sandboxRoot?: string | null;
}): Record<string, string> {
  return {
    ...process.env,
    PUSHPALS_PROFILE: "dev",
    PUSHPALS_CONFIG_DIR_OVERRIDE: options.configDir,
    PUSHPALS_PROJECT_ROOT_OVERRIDE: options.repoPath,
    PUSHPALS_REPO_ROOT_OVERRIDE: options.repoPath,
    PUSHPALS_PROMPTS_ROOT_OVERRIDE: options.promptsRoot,
    PUSHPALS_PROTOCOL_SCHEMAS_DIR: options.protocolSchemasDir,
    PUSHPALS_OPENAI_CODEX_AUTH_MODE: "api_key",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "pushpals-release-smoke-openai-key",
    ...(options.dataDir ? { PUSHPALS_DATA_DIR_OVERRIDE: options.dataDir } : {}),
    ...(options.workerpalBin ? { PUSHPALS_WORKERPALS_BIN: options.workerpalBin } : {}),
    ...(options.sandboxRoot ? { PUSHPALS_WORKERPALS_SANDBOX_ROOT: options.sandboxRoot } : {}),
  } as Record<string, string>;
}

function resolveRuntimeConfigSourceDir(promptsRoot: string): string {
  const candidates = [
    join(promptsRoot, "configs"),
    join(repoRoot, "packages", "cli", "runtime", "configs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "default.toml"))) return candidate;
  }
  throw new Error(`Could not locate runtime configs under ${promptsRoot} or ${repoRoot}.`);
}

function resolveProtocolSchemasDir(promptsRoot: string): string {
  const candidates = [
    join(promptsRoot, "protocol", "schemas"),
    join(promptsRoot, "packages", "cli", "runtime", "protocol", "schemas"),
    join(repoRoot, "packages", "cli", "runtime", "protocol", "schemas"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "envelope.schema.json"))) return candidate;
  }
  throw new Error(`Could not locate protocol schemas under ${promptsRoot} or ${repoRoot}.`);
}

export function buildRuntimeConfigToml(portBase: number): string {
  return [
    'profile = "dev"',
    'session_id = "dev"',
    "",
    "[server]",
    `url = "http://127.0.0.1:${portBase}"`,
    `port = ${portBase}`,
    "",
    "[localbuddy]",
    "enabled = false",
    `port = ${portBase + 2}`,
    "",
    "[remotebuddy]",
    "auto_spawn_workerpals = true",
    "min_workerpals = 1",
    "max_workerpals = 1",
    "wait_for_workerpal_ms = 5000",
    "workerpal_startup_timeout_ms = 5000",
    "workerpal_docker = false",
    "workerpal_require_docker = false",
    "",
    "[remotebuddy.autonomy]",
    "enabled = true",
    "tick_interval_ms = 300000",
    "",
    "[source_control_manager]",
    `port = ${portBase + 1}`,
    'remote = "origin"',
    'pushpals_branch = "main_agents"',
    'base_branch = "main"',
    "skip_clean_check = true",
    "",
    "[source_control_manager.review_agent]",
    "enabled = false",
    "",
    "[startup]",
    "log_config_on_start = false",
    "sync_integration_with_main = false",
    "skip_llm_preflight = true",
    "auto_start_lmstudio = false",
    "startup_warmup = false",
    "",
  ].join("\n");
}

function writeRuntimeConfig(configDir: string, promptsRoot: string, portBase: number): void {
  const sourceDir = resolveRuntimeConfigSourceDir(promptsRoot);
  cpSync(sourceDir, configDir, { recursive: true, force: true });
  writeFileSync(join(configDir, "local.toml"), buildRuntimeConfigToml(portBase), "utf8");
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
    const base = 31000 + Math.floor(Math.random() * 10000);
    let ok = true;
    for (let offset = 0; offset < size; offset += 1) {
      if (!(await isPortAvailable(base + offset))) {
        ok = false;
        break;
      }
    }
    if (ok) return base;
  }
  throw new Error("Failed to reserve an available port block for Windows runtime smoke.");
}

function initializeTempRepo(root: string): string {
  const repoPath = join(root, "repo");
  const remotePath = join(root, "origin.git");
  mkdirSync(repoPath, { recursive: true });
  runChecked(["git", "init"], repoPath);
  runChecked(["git", "branch", "-M", "main"], repoPath);
  runChecked(["git", "config", "user.name", "PushPals Windows Smoke"], repoPath);
  runChecked(["git", "config", "user.email", "pushpals-windows-smoke@example.com"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# Windows Runtime Smoke\n", "utf8");
  writeFileSync(
    join(repoPath, "vision.md"),
    "# Windows Runtime Smoke Vision\n\n> **One sentence:** Keep autonomy enabled and verify compiled Windows runtime services stay alive.\n",
    "utf8",
  );
  runChecked(["git", "add", "README.md", "vision.md"], repoPath);
  runChecked(["git", "commit", "-m", "chore: seed windows smoke repo"], repoPath);
  runChecked(["git", "init", "--bare", remotePath], root);
  runChecked(["git", "remote", "add", "origin", remotePath], repoPath);
  runChecked(["git", "push", "-u", "origin", "main"], repoPath);
  runChecked(["git", "checkout", "-b", "main_agents"], repoPath);
  runChecked(["git", "push", "-u", "origin", "main_agents"], repoPath);
  runChecked(["git", "checkout", "main"], repoPath);
  return repoPath;
}

function resolveRepoPath(root: string, repoPath: string | null): string {
  if (!repoPath) {
    return initializeTempRepo(root);
  }
  if (!existsSync(join(repoPath, ".git")) && !existsSync(join(repoPath, ".git", "HEAD"))) {
    throw new Error(`--repo-path is not a git repository: ${repoPath}`);
  }
  return repoPath;
}

function startTextCapture(stream: ReadableStream<Uint8Array> | null | undefined): {
  promise: Promise<string>;
  getSnapshot: () => string;
} {
  let buffer = "";
  const promise = (async () => {
    if (!stream) return buffer;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });
      }
      buffer += decoder.decode();
      return buffer;
    } finally {
      reader.releaseLock();
    }
  })();
  return { promise, getSnapshot: () => buffer };
}

async function waitForHttpOk(
  url: string,
  timeoutMs: number,
  getCapturedOutput?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await Bun.sleep(250);
  }
  const details = getCapturedOutput ? `\n${summarizeTail(getCapturedOutput())}` : "";
  throw new Error(`Timed out waiting for ${url}${details}`);
}

async function waitForCapturedOutput(
  getSnapshot: () => string,
  pattern: RegExp,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(getSnapshot())) return;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}\n${summarizeTail(getSnapshot())}`);
}

function spawnService(binaryPath: string, cwd: string, env: Record<string, string>, args: string[] = []): SpawnedProc {
  return Bun.spawn([binaryPath, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function summarizeTail(text: string, maxChars = 10_000): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(-maxChars);
}

async function ensureProcessStable(
  proc: SpawnedProc,
  label: string,
  timeoutMs: number,
  getCapturedOutput: () => string,
): Promise<void> {
  const exitCode = await Promise.race([
    proc.exited.then((value) => value),
    Bun.sleep(timeoutMs).then(() => null),
  ]);
  if (exitCode === null) return;
  throw new Error(
    `${label} exited early with code ${exitCode}\n${summarizeTail(getCapturedOutput())}`,
  );
}

async function removeTreeWithRetries(root: string, attempts = 10, delayMs = 500): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function ensureBinaryExists(pathValue: string): void {
  if (!existsSync(pathValue)) {
    throw new Error(`Required binary missing: ${pathValue}`);
  }
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("release-windows-runtime-smoke.ts must run on Windows.");
  }
  const options = parseArgs(process.argv.slice(2));
  const serverBin = join(options.runtimeBinDir, "pushpals-runtime-server-windows-x64.exe");
  const remoteBuddyBin = join(options.runtimeBinDir, "pushpals-runtime-remotebuddy-windows-x64.exe");
  const workerpalBin = join(options.runtimeBinDir, "pushpals-runtime-workerpals-windows-x64.exe");
  ensureBinaryExists(serverBin);
  ensureBinaryExists(remoteBuddyBin);

  const root = mkdtempSync(join(tmpdir(), "pushpals-release-windows-smoke-"));
  let serverProc: SpawnedProc | null = null;
  let remoteBuddyProc: SpawnedProc | null = null;
  try {
    const repoPath = resolveRepoPath(root, options.repoPath);
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });
    const dataDir = options.useRepoDataDir ? null : join(root, "data");
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    const portBase = await findAvailablePortBlock();
    writeRuntimeConfig(configDir, options.promptsRoot, portBase);
    const protocolSchemasDir = resolveProtocolSchemasDir(options.promptsRoot);
    const env = buildServiceEnv({
      configDir,
      repoPath,
      promptsRoot: options.promptsRoot,
      protocolSchemasDir,
      dataDir,
      workerpalBin: existsSync(workerpalBin) ? workerpalBin : null,
      sandboxRoot: existsSync(join(repoRoot, "apps", "workerpals", "Dockerfile.sandbox"))
        ? repoRoot
        : null,
    });

    serverProc = spawnService(serverBin, repoPath, env);
    const serverStdoutCapture = startTextCapture(serverProc.stdout);
    const serverStderrCapture = startTextCapture(serverProc.stderr);
    await waitForHttpOk(`http://127.0.0.1:${portBase}/healthz`, 60_000, () => {
      return `${serverStdoutCapture.getSnapshot()}\n${serverStderrCapture.getSnapshot()}`;
    });

    remoteBuddyProc = spawnService(remoteBuddyBin, repoPath, env, [
      "--server",
      `http://127.0.0.1:${portBase}`,
      "--sessionId",
      "dev",
    ]);
    const remoteStdoutCapture = startTextCapture(remoteBuddyProc.stdout);
    const remoteStderrCapture = startTextCapture(remoteBuddyProc.stderr);

    const remoteSnapshot = () =>
      `${remoteStdoutCapture.getSnapshot()}\n${remoteStderrCapture.getSnapshot()}`;
    await waitForCapturedOutput(
      remoteSnapshot,
      /Autonomous engine:\s*enabled/i,
      30_000,
      "RemoteBuddy autonomy-enabled startup log",
    );
    if (existsSync(workerpalBin)) {
      await waitForCapturedOutput(
        remoteSnapshot,
        WORKERPAL_WARMUP_OUTCOME_PATTERN,
        45_000,
        "RemoteBuddy worker warmup outcome log",
      );
    }
    await ensureProcessStable(serverProc, "server", options.durationMs, () => {
      return `${serverStdoutCapture.getSnapshot()}\n${serverStderrCapture.getSnapshot()}`;
    });
    await ensureProcessStable(remoteBuddyProc, "remotebuddy", options.durationMs, remoteSnapshot);

    const finalRemoteOutput = remoteSnapshot();
    if (/Segmentation fault|oh no: Bun has crashed|panic\(main thread\)/i.test(finalRemoteOutput)) {
      throw new Error(`RemoteBuddy emitted a Bun crash signature.\n${summarizeTail(finalRemoteOutput)}`);
    }
    console.log(
      `[windows-runtime-smoke] Embedded server and RemoteBuddy remained healthy with autonomy enabled${existsSync(workerpalBin) ? " after exercising the WorkerPal warmup path" : ""}.`,
    );
  } finally {
    for (const proc of [remoteBuddyProc, serverProc]) {
      if (!proc) continue;
      try {
        proc.kill();
      } catch {
        // best-effort cleanup
      }
    }
    await Bun.sleep(500);
    try {
      await removeTreeWithRetries(root);
    } catch (error) {
      console.warn(`[windows-runtime-smoke] Temp cleanup warning for ${root}: ${String(error)}`);
    }
  }
}

if (import.meta.main) {
  await main();
}
