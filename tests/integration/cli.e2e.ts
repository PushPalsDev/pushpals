import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { createServer } from "net";
import { delimiter, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const packagedCliPath = resolve(repoRoot, "packages", "cli", "dist", "pushpals-cli.js");
const packagedRuntimeAssetRoot = resolve(repoRoot, "packages", "cli", "runtime");
const buildCacheRoot = mkdtempSync(join(tmpdir(), "pushpals-cli-e2e-cache-"));
const runtimeTag = "vcli-e2e";

type BuildArtifacts = {
  cliPath: string;
  runtimeBinaryDir: string;
  platformKey: string;
  dockerImage: string;
};

let buildArtifactsPromise: Promise<BuildArtifacts> | null = null;
let cliPackageTarballPromise: Promise<string> | null = null;
const sharedDockerImageTag = `pushpals-worker-sandbox:cli-e2e-shared-${Date.now()}`;
let sharedDockerImageBuilt = false;

process.on("exit", () => {
  try {
    rmSync(buildCacheRoot, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup only
  }
  if (sharedDockerImageBuilt) {
    try {
      Bun.spawnSync(["docker", "image", "rm", "-f", sharedDockerImageTag], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // best-effort cleanup only
    }
  }
});

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

function resolveRuntimeTarget(): { target: string; platformKey: string; extension: string } {
  if (process.platform === "win32" && process.arch === "x64") {
    return { target: "bun-windows-x64", platformKey: "windows-x64", extension: ".exe" };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return { target: "bun-linux-x64", platformKey: "linux-x64", extension: "" };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return { target: "bun-darwin-x64", platformKey: "macos-x64", extension: "" };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { target: "bun-darwin-arm64", platformKey: "macos-arm64", extension: "" };
  }
  throw new Error(`Unsupported CLI E2E platform: ${process.platform}/${process.arch}`);
}

function runtimeBinaryFilename(
  service: "server" | "localbuddy" | "remotebuddy" | "workerpals" | "source_control_manager",
  platformKey: string,
  extension: string,
): string {
  const token = service === "source_control_manager" ? "source-control-manager" : service;
  return `pushpals-runtime-${token}-${platformKey}${extension}`;
}

async function ensureBuildArtifacts(): Promise<BuildArtifacts> {
  if (buildArtifactsPromise) return await buildArtifactsPromise;
  buildArtifactsPromise = (async () => {
    runChecked(["docker", "version", "--format", "{{.Server.Version}}"], repoRoot);
    runChecked(
      [process.execPath, "run", "cli:bundle"],
      repoRoot,
      process.env as Record<string, string>,
    );
    runChecked(
      [process.execPath, "run", "protocol:build"],
      repoRoot,
      process.env as Record<string, string>,
    );
    runChecked(
      ["docker", "build", "-f", "apps/workerpals/Dockerfile.sandbox", "-t", sharedDockerImageTag, "."],
      repoRoot,
      process.env as Record<string, string>,
    );
    sharedDockerImageBuilt = true;

    const target = resolveRuntimeTarget();
    const cacheDir = join(buildCacheRoot, target.platformKey);
    mkdirSync(cacheDir, { recursive: true });

    const serviceBuilds: Array<{
      source: string;
      service: "server" | "localbuddy" | "remotebuddy" | "workerpals" | "source_control_manager";
    }> = [
      { source: "apps/server/src/server_main.ts", service: "server" },
      { source: "apps/localbuddy/src/localbuddy_main.ts", service: "localbuddy" },
      { source: "apps/remotebuddy/src/remotebuddy_main.ts", service: "remotebuddy" },
      { source: "apps/workerpals/src/workerpals_main.ts", service: "workerpals" },
      {
        source: "apps/source_control_manager/src/source_control_manager_main.ts",
        service: "source_control_manager",
      },
    ];

    for (const build of serviceBuilds) {
      const outfile = join(
        cacheDir,
        runtimeBinaryFilename(build.service, target.platformKey, target.extension),
      );
      if (existsSync(outfile)) continue;
      runChecked(
        [
          process.execPath,
          "build",
          build.source,
          "--compile",
          `--target=${target.target}`,
          `--outfile=${outfile}`,
        ],
        repoRoot,
        process.env as Record<string, string>,
      );
    }

    return {
      cliPath: packagedCliPath,
      runtimeBinaryDir: cacheDir,
      platformKey: target.platformKey,
      dockerImage: sharedDockerImageTag,
    };
  })();
  return await buildArtifactsPromise;
}

async function ensureCliPackageTarball(): Promise<string> {
  if (cliPackageTarballPromise) return await cliPackageTarballPromise;
  cliPackageTarballPromise = (async () => {
    runChecked(
      [process.execPath, "run", "cli:bundle"],
      repoRoot,
      process.env as Record<string, string>,
    );
    const packageDir = join(repoRoot, "packages", "cli");
    for (const entry of readdirSync(packageDir)) {
      if (entry.startsWith("pushpalsdev-cli-") && entry.endsWith(".tgz")) {
        rmSync(join(packageDir, entry), { force: true });
      }
    }
    runChecked(["npm", "pack"], packageDir, process.env as Record<string, string>);
    const filename =
      readdirSync(packageDir)
        .filter((entry) => entry.startsWith("pushpalsdev-cli-") && entry.endsWith(".tgz"))
        .sort()[0] ?? "";
    if (!filename) {
      throw new Error(`npm pack did not produce a tarball under ${packageDir}`);
    }
    const sourceTarballPath = join(packageDir, filename);
    const cachedTarballPath = join(buildCacheRoot, filename);
    cpSync(sourceTarballPath, cachedTarballPath, { force: true });
    rmSync(sourceTarballPath, { force: true });
    return cachedTarballPath;
  })();
  return await cliPackageTarballPromise;
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
    const base = 20000 + Math.floor(Math.random() * 20000);
    let ok = true;
    for (let offset = 0; offset < size; offset += 1) {
      if (!(await isPortAvailable(base + offset))) {
        ok = false;
        break;
      }
    }
    if (ok) return base;
  }
  throw new Error("Failed to reserve an available port block for CLI E2E.");
}

function prepareRuntimeRoot(
  runtimeRoot: string,
  artifacts: BuildArtifacts,
  dockerImage: string,
  portBase: number,
  options: {
    autonomyEnabled?: boolean;
  } = {},
): void {
  const autonomyEnabled = options.autonomyEnabled ?? false;
  cpSync(packagedRuntimeAssetRoot, runtimeRoot, { recursive: true, force: true });
  const runtimeBinDir = join(runtimeRoot, "bin", artifacts.platformKey);
  mkdirSync(runtimeBinDir, { recursive: true });
  const extension = artifacts.platformKey.startsWith("windows-") ? ".exe" : "";
  for (const service of [
    "server",
    "localbuddy",
    "remotebuddy",
    "workerpals",
    "source_control_manager",
  ] as const) {
    const filename = runtimeBinaryFilename(service, artifacts.platformKey, extension);
    cpSync(join(artifacts.runtimeBinaryDir, filename), join(runtimeBinDir, filename), {
      force: true,
    });
  }
  writeFileSync(join(runtimeBinDir, ".runtime-tag"), `${runtimeTag}\n`, "utf8");
  writeFileSync(join(runtimeRoot, ".runtime-assets-tag"), `${runtimeTag}\n`, "utf8");

  writeFileSync(
    join(runtimeRoot, "configs", "local.toml"),
    `profile = "dev"
session_id = "dev"

[server]
url = "http://127.0.0.1:${portBase}"
port = ${portBase}

[localbuddy]
enabled = false
port = ${portBase + 2}

[remotebuddy]
max_workerpals = 1
wait_for_workerpal_ms = 30000
workerpal_startup_timeout_ms = 30000

[remotebuddy.autonomy]
enabled = ${autonomyEnabled ? "true" : "false"}

[workerpals]
docker_image = "${dockerImage}"
docker_agent_startup_timeout_ms = 90000

[source_control_manager]
port = ${portBase + 1}
remote = "origin"
pushpals_branch = "main_agents"
base_branch = "main"
skip_clean_check = true

[source_control_manager.review_agent]
enabled = false

[startup]
log_config_on_start = false
sync_integration_with_main = false
skip_llm_preflight = true
auto_start_lmstudio = false
startup_warmup = true
startup_warmup_timeout_ms = 120000
`,
    "utf8",
  );
}

function initializeTempRepo(root: string): { repoPath: string; remotePath: string } {
  const repoPath = join(root, "repo");
  const remotePath = join(root, "origin.git");
  mkdirSync(repoPath, { recursive: true });
  runChecked(["git", "init"], repoPath);
  runChecked(["git", "branch", "-M", "main"], repoPath);
  runChecked(["git", "config", "user.name", "PushPals E2E"], repoPath);
  runChecked(["git", "config", "user.email", "pushpals-e2e@example.com"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# CLI E2E Sandbox\n", "utf8");
  writeFileSync(
    join(repoPath, "vision.md"),
    "# CLI E2E Vision\n\n> **One sentence:** Validate packaged CLI startup against a real Docker engine.\n",
    "utf8",
  );
  runChecked(["git", "add", "README.md", "vision.md"], repoPath);
  runChecked(["git", "commit", "-m", "chore: seed cli e2e repo"], repoPath);
  runChecked(["git", "init", "--bare", remotePath], root);
  runChecked(["git", "remote", "add", "origin", remotePath], repoPath);
  runChecked(["git", "push", "-u", "origin", "main"], repoPath);
  runChecked(["git", "checkout", "-b", "main_agents"], repoPath);
  runChecked(["git", "push", "-u", "origin", "main_agents"], repoPath);
  runChecked(["git", "checkout", "main"], repoPath);
  return { repoPath, remotePath };
}

function buildCliE2EEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    PUSHPALS_CLI_PACKAGE_VERSION: "cli-e2e",
    EXPO_PUBLIC_LOCAL_AGENT_URL: "",
    PUSHPALS_SERVER_URL: "",
    PUSHPALS_CONFIG_DIR_OVERRIDE: "",
    PUSHPALS_PROJECT_ROOT_OVERRIDE: "",
    PUSHPALS_REPO_ROOT_OVERRIDE: "",
    PUSHPALS_RUNTIME_ROOT: "",
    ...extra,
  } as Record<string, string>;
}

function resolveInstalledPushpalsPath(globalBinDir: string): string {
  const candidates =
    process.platform === "win32"
      ? ["pushpals.exe", "pushpals.cmd", "pushpals"]
      : ["pushpals"];
  for (const candidate of candidates) {
    const candidatePath = join(globalBinDir, candidate);
    if (existsSync(candidatePath)) return candidatePath;
  }
  throw new Error(`Installed pushpals entrypoint was not found under ${globalBinDir}`);
}

async function installCliTarballGlobally(root: string): Promise<{
  bunInstallRoot: string;
  globalBinDir: string;
  pushpalsPath: string;
}> {
  const bunInstallRoot = join(root, "bun-install");
  mkdirSync(bunInstallRoot, { recursive: true });
  const tarballPath = await ensureCliPackageTarball();
  const installEnv = {
    ...process.env,
    BUN_INSTALL: bunInstallRoot,
  } as Record<string, string>;
  runChecked([process.execPath, "install", "-g", tarballPath], root, installEnv);
  const globalBinDir = runChecked([process.execPath, "pm", "bin", "-g"], root, installEnv).stdout.trim();
  if (!globalBinDir) {
    throw new Error("bun pm bin -g returned an empty global bin directory.");
  }
  return {
    bunInstallRoot,
    globalBinDir,
    pushpalsPath: resolveInstalledPushpalsPath(globalBinDir),
  };
}

function shouldKeepE2ETempRoot(): boolean {
  return String(process.env.PUSHPALS_KEEP_E2E_TMP ?? "").trim() === "1";
}

async function createFailingDockerExecutable(root: string): Promise<string> {
  if (process.platform === "win32") {
    const sourcePath = join(root, "docker-fail.ts");
    const outputPath = join(root, "docker.exe");
    writeFileSync(
      sourcePath,
      "console.error('Docker engine unavailable for CLI E2E'); process.exit(1);\n",
      "utf8",
    );
    runChecked(
      [process.execPath, "build", sourcePath, "--compile", `--outfile=${outputPath}`],
      root,
      process.env as Record<string, string>,
    );
    return outputPath;
  }
  const outputPath = join(root, "docker");
  writeFileSync(
    outputPath,
    "#!/usr/bin/env sh\necho 'Docker engine unavailable for CLI E2E' >&2\nexit 1\n",
    "utf8",
  );
  chmodSync(outputPath, 0o755);
  return outputPath;
}

async function createCrashingRemoteBuddyExecutable(root: string): Promise<string> {
  const sourcePath = join(root, "remotebuddy-crash.ts");
  const extension = process.platform === "win32" ? ".exe" : "";
  const outputPath = join(root, `pushpals-runtime-remotebuddy-crash${extension}`);
  writeFileSync(
    sourcePath,
    [
      "console.error('panic(main thread): Segmentation fault at address 0xFFFFFFFFFFFFFFFF');",
      "console.error('oh no: Bun has crashed. This indicates a bug in Bun, not your code.');",
      "process.exit(3);",
      "",
    ].join("\n"),
    "utf8",
  );
  const buildArgs = [process.execPath, "build", sourcePath, "--compile", `--outfile=${outputPath}`];
  if (process.platform === "win32") {
    buildArgs.splice(3, 0, "--target=bun-windows-x64");
  }
  runChecked(buildArgs, root, process.env as Record<string, string>);
  return outputPath;
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function resolveDockerExecutablePath(): string {
  if (process.platform === "win32") {
    return (
      runChecked(["where.exe", "docker"], repoRoot)
        .stdout.split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "docker.exe"
    );
  }
  return (
    runChecked(["which", "docker"], repoRoot)
      .stdout.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "docker"
  );
}

async function createTimedOutInspectDockerExecutable(root: string, targetImage: string): Promise<string> {
  if (process.platform === "win32") {
    throw new Error("Timed-out docker inspect wrapper is not implemented for Windows");
  }
  const outputPath = join(root, "docker-timeout");
  const statePath = join(root, "docker-inspect-timeout.once");
  const realDockerPath = resolveDockerExecutablePath();
  writeFileSync(
    outputPath,
    `#!/usr/bin/env sh
set -eu
REAL_DOCKER=${shSingleQuote(realDockerPath)}
STATE_FILE=${shSingleQuote(statePath)}
TARGET_IMAGE=${shSingleQuote(targetImage)}
is_inspect="0"
has_target="0"
if [ "$#" -ge 2 ] && [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  is_inspect="1"
fi
if [ "$#" -ge 1 ] && [ "$1" = "inspect" ]; then
  is_inspect="1"
fi
for arg in "$@"; do
  if [ "$arg" = "$TARGET_IMAGE" ]; then
    has_target="1"
  fi
done
if [ "$is_inspect" = "1" ] && [ "$has_target" = "1" ] && [ ! -f "$STATE_FILE" ]; then
  : > "$STATE_FILE"
  sleep 20
  exit 124
fi
exec "$REAL_DOCKER" "$@"
`,
    "utf8",
  );
  chmodSync(outputPath, 0o755);
  return outputPath;
}

function summarizeCapturedOutput(text: string, maxChars = 16_000): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `...[truncated]...\n${normalized.slice(-maxChars)}`;
}

async function waitForExitWithTimeout(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
  getCapturedOutput?: () => string,
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
          const captured = summarizeCapturedOutput(getCapturedOutput?.() ?? "");
          const suffix = captured ? `\nCaptured output:\n${captured}` : "";
          reject(new Error(`CLI E2E timed out after ${timeoutMs}ms${suffix}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startTextCapture(
  stream: ReadableStream<Uint8Array> | null | undefined,
): { promise: Promise<string>; getSnapshot: () => string } {
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
  return {
    promise,
    getSnapshot: () => buffer,
  };
}

async function waitForCapturedOutput(
  getSnapshot: () => string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(getSnapshot())) return;
    await Bun.sleep(100);
  }
  throw new Error(
    `Timed out waiting for captured output: ${label}\n${summarizeCapturedOutput(getSnapshot())}`,
  );
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

async function removeTreeWithRetries(path: string, attempts = 8): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(500 * (attempt + 1));
    }
  }
  if (lastError) throw lastError;
}

function findLatestRuntimeServicesLogPath(runtimeRoot: string): string | null {
  const logDir = join(runtimeRoot, "logs", "bootstrap");
  if (!existsSync(logDir)) return null;
  const candidates = readdirSync(logDir)
    .filter((name) => name.endsWith("-runtime-services.log"))
    .map((name) => join(logDir, name));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

async function waitForRuntimeServicesLogPath(runtimeRoot: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logPath = findLatestRuntimeServicesLogPath(runtimeRoot);
    if (logPath) return logPath;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for runtime-services log path under ${runtimeRoot}`);
}

async function waitForLogLine(logPath: string, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, "utf8");
      if (content.includes(needle)) return;
    }
    await Bun.sleep(300);
  }
  throw new Error(`Timed out waiting for log line "${needle}" in ${logPath}`);
}

function parsePidList(text: string): number[] {
  return text
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function findProcessIdsByCommandNeedle(commandNeedle: string): number[] {
  if (process.platform === "win32") {
    const proc = Bun.spawnSync(
      [
        "powershell",
        "-NoProfile",
        "-Command",
        "$needle = $env:PUSHPALS_PROC_NEEDLE; " +
          "Get-CimInstance Win32_Process | " +
          "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } | " +
          "ForEach-Object { $_.ProcessId }",
      ],
      {
        env: {
          ...process.env,
          PUSHPALS_PROC_NEEDLE: commandNeedle,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (proc.exitCode !== 0) {
      const stderr = decodeOutput(proc.stderr);
      throw new Error(`Failed to enumerate processes by command line on Windows: ${stderr}`);
    }
    return parsePidList(decodeOutput(proc.stdout));
  }

  const proc = Bun.spawnSync(["ps", "-eo", "pid=,args="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = decodeOutput(proc.stderr);
    throw new Error(`Failed to enumerate processes via ps: ${stderr}`);
  }
  const lines = decodeOutput(proc.stdout).split(/\r?\n/);
  const pids: number[] = [];
  for (const line of lines) {
    const match = /^(\d+)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const args = match[2] ?? "";
    if (!args.includes(commandNeedle)) continue;
    pids.push(pid);
  }
  return pids;
}

async function terminateProcessByCommandNeedle(commandNeedle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = findProcessIdsByCommandNeedle(commandNeedle);
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
            // best-effort terminate only
          }
        }
      }
      return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for process matching command needle: ${commandNeedle}`);
}

describe("packaged CLI end-to-end", () => {
  test(
    "boots from a bun-installed package entrypoint with an isolated runtime root",
    async () => {
      const artifacts = await ensureBuildArtifacts();
      const root = mkdtempSync(join(tmpdir(), "pushpals-cli-e2e-installed-"));
      let clearProc: ReturnType<typeof Bun.spawn> | null = null;
      let statusProc: ReturnType<typeof Bun.spawn> | null = null;
      try {
        const { repoPath } = initializeTempRepo(root);
        const runtimeRoot = join(root, "runtime");
        const portBase = await findAvailablePortBlock();
        prepareRuntimeRoot(runtimeRoot, artifacts, artifacts.dockerImage, portBase, {
          autonomyEnabled: process.platform === "win32",
        });
        const installed = await installCliTarballGlobally(root);
        const env = buildCliE2EEnv({
          BUN_INSTALL: installed.bunInstallRoot,
          PATH: `${installed.globalBinDir}${delimiter}${process.env.PATH ?? ""}`,
          OPENAI_API_KEY: "cli-e2e-installed-package-key",
          PUSHPALS_OPENAI_CODEX_AUTH_MODE: "api_key",
          PUSHPALS_DATA_DIR_OVERRIDE: join(root, "data"),
          REMOTEBUDDY_AUTO_SPAWN_WORKERPALS: "false",
          REMOTEBUDDY_AUTONOMY_ENABLED: process.platform === "win32" ? "true" : "false",
        });

        clearProc = Bun.spawn(
          [installed.pushpalsPath, "--clear", "--runtime-root", runtimeRoot],
          {
            cwd: repoPath,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env,
          },
        );
        const clearStdoutCapture = startTextCapture(clearProc.stdout);
        const clearStderrCapture = startTextCapture(clearProc.stderr);
        const [clearStdout, clearStderr, clearExitCode] = await Promise.all([
          clearStdoutCapture.promise,
          clearStderrCapture.promise,
          waitForExitWithTimeout(
            clearProc,
            5 * 60_000,
            () => `${clearStdoutCapture.getSnapshot()}\n${clearStderrCapture.getSnapshot()}`,
          ),
        ]);
        if (clearExitCode !== 0) {
          throw new Error(`Installed-package clear exited ${clearExitCode}\n${clearStdout}\n${clearStderr}`);
        }

        statusProc = Bun.spawn(
          [
            installed.pushpalsPath,
            "--status-once",
            "--runtime-root",
            runtimeRoot,
            "--runtime-tag",
            runtimeTag,
          ],
          {
            cwd: repoPath,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env,
          },
        );

        const stdoutCapture = startTextCapture(statusProc.stdout);
        const stderrCapture = startTextCapture(statusProc.stderr);
        const runtimeServicesLogPath = await waitForRuntimeServicesLogPath(runtimeRoot, 120_000);
        await waitForLogLine(runtimeServicesLogPath, "[pushpals] embedded runtime is ready.", 180_000);

        const [stdout, stderr, exitCode] = await Promise.all([
          stdoutCapture.promise,
          stderrCapture.promise,
          waitForExitWithTimeout(
            statusProc,
            10 * 60_000,
            () => `${stdoutCapture.getSnapshot()}\n${stderrCapture.getSnapshot()}`,
          ),
        ]);
        const combined = `${stdout}\n${stderr}`;

        if (exitCode !== 0) {
          throw new Error(`Installed-package CLI E2E exited ${exitCode}\n${combined}`);
        }
        expect(combined).toContain("[pushpals] startup timing summary: outcome=ready");
        expect(combined).toContain("[pushpals] Embedded runtime is ready.");
        expect(combined).toContain("[pushpals] Connected.");
        expect(combined).not.toContain("[pushpals] Auto-start failed:");
        expect(combined).not.toContain("[pushpals] Fatal:");
        expect(combined).not.toContain("panic(main thread):");
        expect(combined).not.toContain("Segmentation fault");
      } finally {
        if (clearProc) {
          try {
            clearProc.kill();
          } catch {}
        }
        if (statusProc) {
          try {
            statusProc.kill();
          } catch {}
        }
        if (!shouldKeepE2ETempRoot()) {
          try {
            await removeTreeWithRetries(root);
          } catch (err) {
            console.warn(`[cli.e2e] Temp cleanup warning for ${root}: ${String(err)}`);
          }
        }
      }
    },
    20 * 60_000,
  );

  test(
    "boots embedded runtime in a temp repo with real Docker and reports readiness via /status",
    async () => {
      const artifacts = await ensureBuildArtifacts();
      const root = mkdtempSync(join(tmpdir(), "pushpals-cli-e2e-"));
      let proc: ReturnType<typeof Bun.spawn> | null = null;
      try {
        const { repoPath } = initializeTempRepo(root);
        const runtimeRoot = join(root, "runtime");
        const portBase = await findAvailablePortBlock();
        prepareRuntimeRoot(runtimeRoot, artifacts, artifacts.dockerImage, portBase);

        proc = Bun.spawn(
          [
            process.execPath,
            artifacts.cliPath,
            "--status-once",
            "--runtime-root",
            runtimeRoot,
            "--runtime-tag",
            runtimeTag,
          ],
          {
            cwd: repoPath,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: buildCliE2EEnv(),
          },
        );

        const stdoutCapture = startTextCapture(proc.stdout);
        const stderrCapture = startTextCapture(proc.stderr);
        const runtimeServicesLogPath = await waitForRuntimeServicesLogPath(runtimeRoot, 120_000);
        await waitForLogLine(runtimeServicesLogPath, "[pushpals] embedded runtime is ready.", 180_000);

        const [stdout, stderr, exitCode] = await Promise.all([
          stdoutCapture.promise,
          stderrCapture.promise,
          waitForExitWithTimeout(
            proc,
            15 * 60_000,
            () => `${stdoutCapture.getSnapshot()}\n${stderrCapture.getSnapshot()}`,
          ),
        ]);
        const combined = `${stdout}\n${stderr}`;

        if (exitCode !== 0) {
          throw new Error(`CLI E2E exited ${exitCode}\n${combined}`);
        }
        expect(combined).toContain("[pushpals] startup timing summary: outcome=ready");
        expect(combined).toContain("[pushpals] Embedded runtime is ready.");
        expect(combined).toContain("[pushpals] Connected.");
        expect(combined).toContain("[pushpals] Shutting down CLI session...");
        expect(
          (combined.match(/\[pushpals\] workerExecution=/g) ?? []).length,
        ).toBeGreaterThanOrEqual(2);
        expect(combined).not.toContain("[pushpals] workerExecution=blocked");
        expect(combined).not.toContain("[pushpals] Precheck failed:");
        expect(combined).not.toContain("[pushpals] Auto-start failed:");
        expect(combined).not.toContain("[pushpals] Fatal:");
      } finally {
        if (proc) {
          try {
            proc.kill();
          } catch {}
        }
        if (!shouldKeepE2ETempRoot()) {
          try {
            await removeTreeWithRetries(root);
          } catch (err) {
            console.warn(`[cli.e2e] Temp cleanup warning for ${root}: ${String(err)}`);
          }
        }
      }
    },
    20 * 60_000,
  );

  test(
    "boots packaged Windows runtime with autonomy enabled",
    async () => {
      if (process.platform !== "win32") return;
      const artifacts = await ensureBuildArtifacts();
      const root = mkdtempSync(join(tmpdir(), "pushpals-cli-e2e-autonomy-win-"));
      let proc: ReturnType<typeof Bun.spawn> | null = null;
      try {
        const { repoPath } = initializeTempRepo(root);
        const runtimeRoot = join(root, "runtime");
        const portBase = await findAvailablePortBlock();
        prepareRuntimeRoot(runtimeRoot, artifacts, artifacts.dockerImage, portBase, {
          autonomyEnabled: true,
        });

        proc = Bun.spawn(
          [
            process.execPath,
            artifacts.cliPath,
            "--status-once",
            "--runtime-root",
            runtimeRoot,
            "--runtime-tag",
            runtimeTag,
          ],
          {
            cwd: repoPath,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: buildCliE2EEnv(),
          },
        );

        const stdoutCapture = startTextCapture(proc.stdout);
        const stderrCapture = startTextCapture(proc.stderr);
        const runtimeServicesLogPath = await waitForRuntimeServicesLogPath(runtimeRoot, 120_000);
        const [stdout, stderr, exitCode] = await Promise.all([
          stdoutCapture.promise,
          stderrCapture.promise,
          waitForExitWithTimeout(
            proc,
            5 * 60_000,
            () => `${stdoutCapture.getSnapshot()}\n${stderrCapture.getSnapshot()}`,
          ),
        ]);
        const combined = `${stdout}\n${stderr}`;

        if (exitCode !== 0) {
          throw new Error(`CLI E2E exited ${exitCode}\n${combined}`);
        }
        expect(combined).toContain("[pushpals] startup timing summary: outcome=ready");
        expect(combined).toContain("[pushpals] Embedded runtime is ready.");
        expect(combined).toContain("[pushpals] Embedded RemoteBuddy autonomous engine is enabled.");
        expect(combined).toContain("[pushpals] Connected.");
        expect(combined).not.toContain("[pushpals] Auto-start failed:");
        expect(combined).not.toContain("[pushpals] Fatal:");
        expect(combined).not.toContain("panic(main thread):");
        expect(combined).not.toContain("Segmentation fault");
      } finally {
        if (proc) {
          try {
            proc.kill();
          } catch {}
        }
        if (!shouldKeepE2ETempRoot()) {
          try {
            await removeTreeWithRetries(root);
          } catch (err) {
            console.warn(`[cli.e2e] Temp cleanup warning for ${root}: ${String(err)}`);
          }
        }
      }
    },
    20 * 60_000,
  );

  test(
    "falls back to bundled RemoteBuddy source when the packaged Windows binary crashes with a Bun panic",
    async () => {
      if (process.platform !== "win32") return;
      const artifacts = await ensureBuildArtifacts();
      const root = mkdtempSync(join(tmpdir(), "pushpals-cli-e2e-remotebuddy-fallback-"));
      let proc: ReturnType<typeof Bun.spawn> | null = null;
      try {
        const { repoPath } = initializeTempRepo(root);
        const runtimeRoot = join(root, "runtime");
        const portBase = await findAvailablePortBlock();
        prepareRuntimeRoot(runtimeRoot, artifacts, artifacts.dockerImage, portBase, {
          autonomyEnabled: true,
        });

        const crashingRemoteBuddyPath = await createCrashingRemoteBuddyExecutable(root);
        cpSync(
          crashingRemoteBuddyPath,
          join(runtimeRoot, "bin", artifacts.platformKey, runtimeBinaryFilename("remotebuddy", artifacts.platformKey, ".exe")),
          { force: true },
        );

        proc = Bun.spawn(
          [
            process.execPath,
            artifacts.cliPath,
            "--status-once",
            "--runtime-root",
            runtimeRoot,
            "--runtime-tag",
            runtimeTag,
          ],
          {
            cwd: repoPath,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: buildCliE2EEnv(),
          },
        );

        const stdoutCapture = startTextCapture(proc.stdout);
        const stderrCapture = startTextCapture(proc.stderr);
        const runtimeServicesLogPath = await waitForRuntimeServicesLogPath(runtimeRoot, 120_000);
        await waitForLogLine(
          runtimeServicesLogPath,
          "source fallback under bun.",
          180_000,
        );

        const [stdout, stderr, exitCode] = await Promise.all([
          stdoutCapture.promise,
          stderrCapture.promise,
          waitForExitWithTimeout(
            proc,
            5 * 60_000,
            () => `${stdoutCapture.getSnapshot()}\n${stderrCapture.getSnapshot()}`,
          ),
        ]);
        const combined = `${stdout}\n${stderr}`;

        if (exitCode !== 0) {
          throw new Error(`CLI E2E exited ${exitCode}\n${combined}`);
        }
        expect(combined).toContain(
          "[pushpals] Embedded RemoteBuddy standalone binary crashed on Windows; retrying with source fallback under bun.",
        );
        expect(combined).toContain("[pushpals] startup timing summary: outcome=ready");
        expect(combined).toContain("[pushpals] Embedded runtime is ready.");
        expect(combined).toContain("[pushpals] Embedded RemoteBuddy autonomous engine is enabled.");
        expect(combined).toContain("[pushpals] Connected.");
        expect(combined).not.toContain("[pushpals] Auto-start failed:");
        expect(combined).not.toContain("[pushpals] Fatal:");
      } finally {
        if (proc) {
          try {
            proc.kill();
          } catch {}
        }
        if (!shouldKeepE2ETempRoot()) {
          try {
            await removeTreeWithRetries(root);
          } catch (err) {
            console.warn(`[cli.e2e] Temp cleanup warning for ${root}: ${String(err)}`);
          }
        }
      }
    },
    20 * 60_000,
  );

  test(
    "fails fast with actionable guidance when Docker-backed worker startup is unavailable",
    async () => {
      const artifacts = await ensureBuildArtifacts();
      const root = mkdtempSync(join(tmpdir(), "pushpals-cli-e2e-docker-fail-"));
      const failingDockerPath = await createFailingDockerExecutable(root);
      let proc: ReturnType<typeof Bun.spawn> | null = null;
      try {
        const { repoPath } = initializeTempRepo(root);
        const runtimeRoot = join(root, "runtime");
        const portBase = await findAvailablePortBlock();
        prepareRuntimeRoot(runtimeRoot, artifacts, artifacts.dockerImage, portBase);

        proc = Bun.spawn(
          [
            process.execPath,
            artifacts.cliPath,
            "--runtime-root",
            runtimeRoot,
            "--runtime-tag",
            runtimeTag,
          ],
          {
            cwd: repoPath,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: buildCliE2EEnv({
              PATH: `${dirname(failingDockerPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
            }),
          },
        );

        const stdoutCapture = startTextCapture(proc.stdout);
        const stderrCapture = startTextCapture(proc.stderr);
        const [stdout, stderr, exitCode] = await Promise.all([
          stdoutCapture.promise,
          stderrCapture.promise,
          waitForExitWithTimeout(proc, 5 * 60_000),
        ]);
        const combined = `${stdout}\n${stderr}`;

        expect(exitCode).toBe(1);
        expect(combined).toContain(
          "Precheck failed: Docker-backed WorkerPal auto-spawn is required but Docker is unavailable",
        );
        expect(combined).toContain(
          "Precheck failed: start Docker Desktop or the Docker daemon, then retry pushpals.",
        );
        expect(combined).not.toContain("Starting embedded server...");
        expect(combined).not.toContain("WorkerPal sandbox image");
        expect(combined).not.toContain("Connected.");
      } finally {
        if (proc) {
          try {
            proc.kill();
          } catch {}
        }
        if (!shouldKeepE2ETempRoot()) {
          try {
            await removeTreeWithRetries(root);
          } catch (err) {
            console.warn(`[cli.e2e] Temp cleanup warning for ${root}: ${String(err)}`);
          }
        }
      }
    },
    10 * 60_000,
  );

  test(
    "recovers from a timed-out sandbox image inspect by rebuilding and continuing startup",
    async () => {
      if (process.platform === "win32") return;
      const artifacts = await ensureBuildArtifacts();
      const root = mkdtempSync(join(tmpdir(), "pushpals-cli-e2e-docker-timeout-"));
      const timedOutDockerPath = await createTimedOutInspectDockerExecutable(root, artifacts.dockerImage);
      let proc: ReturnType<typeof Bun.spawn> | null = null;
      try {
        const { repoPath } = initializeTempRepo(root);
        const runtimeRoot = join(root, "runtime");
        const portBase = await findAvailablePortBlock();
        prepareRuntimeRoot(runtimeRoot, artifacts, artifacts.dockerImage, portBase);

        proc = Bun.spawn(
          [
            process.execPath,
            artifacts.cliPath,
            "--status-once",
            "--runtime-root",
            runtimeRoot,
            "--runtime-tag",
            runtimeTag,
          ],
          {
            cwd: repoPath,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: buildCliE2EEnv({
              PUSHPALS_DOCKER_BIN_ABSOLUTE: timedOutDockerPath,
            }),
          },
        );

        const stdoutCapture = startTextCapture(proc.stdout);
        const stderrCapture = startTextCapture(proc.stderr);
        const [stdout, stderr, exitCode] = await Promise.all([
          stdoutCapture.promise,
          stderrCapture.promise,
          waitForExitWithTimeout(
            proc,
            20 * 60_000,
            () => `${stdoutCapture.getSnapshot()}\n${stderrCapture.getSnapshot()}`,
          ),
        ]);
        const combined = `${stdout}\n${stderr}`;

        if (exitCode !== 0) {
          throw new Error(`CLI E2E exited ${exitCode}\n${combined}`);
        }
        expect(combined).toContain(
          `[pushpals] failed to inspect local WorkerPal sandbox image ${artifacts.dockerImage}:`,
        );
        expect(combined).toContain("timed out after 15000ms");
        expect(combined).toContain(
          `[pushpals] WorkerPal sandbox image ${artifacts.dockerImage} could not be inspected; attempting local rebuild...`,
        );
        expect(combined).toContain("[pushpals] Embedded runtime is ready.");
        expect(combined).toContain("[pushpals] Connected.");
        expect(combined).not.toContain("[pushpals] Precheck failed:");
        expect(combined).not.toContain("[pushpals] Auto-start failed:");
      } finally {
        if (proc) {
          try {
            proc.kill();
          } catch {}
        }
        if (!shouldKeepE2ETempRoot()) {
          try {
            await removeTreeWithRetries(root);
          } catch (err) {
            console.warn(`[cli.e2e] Temp cleanup warning for ${root}: ${String(err)}`);
          }
        }
      }
    },
    25 * 60_000,
  );

  test(
    "supervisor restarts source_control_manager after crash and CLI stays usable",
    async () => {
      const artifacts = await ensureBuildArtifacts();
      const root = mkdtempSync(join(tmpdir(), "pushpals-cli-e2e-supervisor-"));
      let runtimeProc: ReturnType<typeof Bun.spawn> | null = null;
      let statusProc: ReturnType<typeof Bun.spawn> | null = null;
      try {
        const { repoPath } = initializeTempRepo(root);
        const runtimeRoot = join(root, "runtime");
        const portBase = await findAvailablePortBlock();
        prepareRuntimeRoot(runtimeRoot, artifacts, artifacts.dockerImage, portBase);

        runtimeProc = Bun.spawn(
          [
            process.execPath,
            artifacts.cliPath,
            "--runtime-only",
            "--runtime-root",
            runtimeRoot,
            "--runtime-tag",
            runtimeTag,
          ],
          {
            cwd: repoPath,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: buildCliE2EEnv(),
          },
        );

        const runtimeStdoutCapture = startTextCapture(runtimeProc.stdout);
        const runtimeStderrCapture = startTextCapture(runtimeProc.stderr);
        const runtimeServicesLogPath = await waitForRuntimeServicesLogPath(runtimeRoot, 120_000);
        await waitForLogLine(runtimeServicesLogPath, "[pushpals] embedded runtime is ready.", 180_000);

        const extension = artifacts.platformKey.startsWith("windows-") ? ".exe" : "";
        const scmBinaryPath = join(
          runtimeRoot,
          "bin",
          artifacts.platformKey,
          runtimeBinaryFilename("source_control_manager", artifacts.platformKey, extension),
        );
        await terminateProcessByCommandNeedle(scmBinaryPath, 30_000);
        await waitForLogLine(
          runtimeServicesLogPath,
          "[pushpals] Embedded source_control_manager exited",
          45_000,
        );
        await waitForLogLine(
          runtimeServicesLogPath,
          "[pushpals] Restarted embedded source_control_manager.",
          60_000,
        );

        statusProc = Bun.spawn(
          [
            process.execPath,
            artifacts.cliPath,
            "--status-once",
            "--no-auto-start",
            "--server-url",
            `http://127.0.0.1:${portBase}`,
            "--session-id",
            "dev",
          ],
          {
            cwd: repoPath,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: buildCliE2EEnv(),
          },
        );

        const statusStdoutCapture = startTextCapture(statusProc.stdout);
        const statusStderrCapture = startTextCapture(statusProc.stderr);
        const [stdout, stderr, exitCode] = await Promise.all([
          statusStdoutCapture.promise,
          statusStderrCapture.promise,
          waitForExitWithTimeout(
            statusProc,
            10 * 60_000,
            () => `${statusStdoutCapture.getSnapshot()}\n${statusStderrCapture.getSnapshot()}`,
          ),
        ]);
        const combined = `${stdout}\n${stderr}`;

        if (exitCode !== 0) {
          throw new Error(`CLI E2E exited ${exitCode}\n${combined}`);
        }
        expect(combined).toContain("[pushpals] Connected.");
        expect(combined).toContain(`[pushpals] serverUrl=http://127.0.0.1:${portBase}`);
        expect(combined).toContain("[pushpals] Shutting down CLI session...");
        expect(combined).toContain("[pushpals] workerExecution=");
        expect(combined).not.toContain("[pushpals] Fatal:");

        runtimeProc.stdin.end();
        await Promise.all([
          runtimeStdoutCapture.promise,
          runtimeStderrCapture.promise,
          waitForExitWithTimeout(
            runtimeProc,
            10 * 60_000,
            () => `${runtimeStdoutCapture.getSnapshot()}\n${runtimeStderrCapture.getSnapshot()}`,
          ),
        ]);
      } finally {
        if (statusProc) {
          try {
            statusProc.kill();
          } catch {}
        }
        if (runtimeProc) {
          try {
            runtimeProc.kill();
          } catch {}
        }
        if (!shouldKeepE2ETempRoot()) {
          try {
            await removeTreeWithRetries(root);
          } catch (err) {
            console.warn(`[cli.e2e] Temp cleanup warning for ${root}: ${String(err)}`);
          }
        }
      }
    },
    25 * 60_000,
  );
});
