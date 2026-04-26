#!/usr/bin/env bun

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join, resolve } from "path";

type SmokeOptions = {
  packageSpec: string;
  durationMs: number;
  repoPath: string | null;
  useRepoDataDir: boolean;
  keepTemp: boolean;
  workerpalAutospawn: boolean;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function parseArgs(argv: string[]): SmokeOptions {
  let packageSpec = "";
  let durationMs = 5 * 60_000;
  let repoPath: string | null = null;
  let useRepoDataDir = false;
  let keepTemp = false;
  let workerpalAutospawn = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--package-spec":
        packageSpec = String(argv[++index] ?? "").trim();
        break;
      case "--duration-ms":
        durationMs = Math.max(
          30_000,
          Number.parseInt(String(argv[++index] ?? "300000"), 10) || 5 * 60_000,
        );
        break;
      case "--repo-path":
        repoPath = String(argv[++index] ?? "").trim() || null;
        break;
      case "--use-repo-data-dir":
        useRepoDataDir = true;
        break;
      case "--keep-temp":
        keepTemp = true;
        break;
      case "--workerpal-autospawn":
        workerpalAutospawn = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!packageSpec) {
    throw new Error("--package-spec is required");
  }

  return {
    packageSpec,
    durationMs,
    repoPath: repoPath ? resolve(repoPath) : null,
    useRepoDataDir,
    keepTemp,
    workerpalAutospawn,
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

async function runWithTimeout(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = proc.stdout ? new Response(proc.stdout).text() : Promise.resolve("");
  const stderrPromise = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("");
  const exitCode = await Promise.race([
    proc.exited,
    Bun.sleep(timeoutMs).then(() => {
      try {
        proc.kill();
      } catch {
        // best-effort timeout cleanup only
      }
      return -999;
    }),
  ]);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode === -999) {
    throw new Error(
      `Timed out after ${timeoutMs}ms: ${cmd.join(" ")}\n${summarizeTail(`${stdout}\n${stderr}`)}`,
    );
  }
  return {
    exitCode,
    stdout,
    stderr,
  };
}

function initializeTempRepo(root: string): string {
  const repoPath = join(root, "repo");
  const remotePath = join(root, "origin.git");
  mkdirSync(repoPath, { recursive: true });
  runChecked(["git", "init"], repoPath);
  runChecked(["git", "branch", "-M", "main"], repoPath);
  runChecked(["git", "config", "user.name", "PushPals Installed Smoke"], repoPath);
  runChecked(["git", "config", "user.email", "pushpals-installed-smoke@example.com"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# Installed CLI Smoke\n", "utf8");
  writeFileSync(
    join(repoPath, "vision.md"),
    "# Installed CLI Smoke Vision\n\n> **One sentence:** Validate the published PushPals package cold-starts cleanly.\n",
    "utf8",
  );
  runChecked(["git", "add", "README.md", "vision.md"], repoPath);
  runChecked(["git", "commit", "-m", "chore: seed installed CLI smoke repo"], repoPath);
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
  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`--repo-path is not a git repository: ${repoPath}`);
  }
  return repoPath;
}

function resolvePushpalsCommand(globalBinDir: string): string {
  const candidates =
    process.platform === "win32"
      ? ["pushpals.exe", "pushpals.cmd", "pushpals"]
      : ["pushpals"];
  for (const candidate of candidates) {
    const pathValue = join(globalBinDir, candidate);
    if (existsSync(pathValue)) return pathValue;
  }
  const installed = readdirSync(globalBinDir)
    .filter((entry) => entry.toLowerCase().startsWith("pushpals"))
    .join(", ");
  throw new Error(
    `Could not locate installed pushpals command under ${globalBinDir} (found: ${installed || "nothing"}).`,
  );
}

function summarizeTail(text: string, maxChars = 16_000): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `...[truncated]...\n${normalized.slice(-maxChars)}`;
}

function assertCommandSucceeded(result: CommandResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.exitCode}\n${summarizeTail(`${result.stdout}\n${result.stderr}`)}`,
    );
  }
}

function assertNoStartupFailure(text: string): void {
  const blockers = [
    "Auto-start failed:",
    "Fatal:",
    "panic(main thread):",
    "Segmentation fault",
    "oh no: Bun has crashed",
    "Embedded remotebuddy exited during startup",
  ];
  for (const blocker of blockers) {
    if (text.includes(blocker)) {
      throw new Error(`Installed CLI smoke observed failure marker "${blocker}"\n${summarizeTail(text)}`);
    }
  }
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = mkdtempSync(join(tmpdir(), "pushpals-installed-cli-smoke-"));
  const bunInstallRoot = join(root, "bun-install");
  const runtimeRoot = join(root, "runtime");
  const dataDir = join(root, "data");
  mkdirSync(bunInstallRoot, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  try {
    const repoPath = resolveRepoPath(root, options.repoPath);
    const installEnv = {
      ...process.env,
      BUN_INSTALL: bunInstallRoot,
    } as Record<string, string>;

    console.log(`[installed-cli-smoke] Installing ${options.packageSpec}`);
    runChecked([process.execPath, "install", "-g", options.packageSpec], root, installEnv);
    const globalBinDir = runChecked([process.execPath, "pm", "bin", "-g"], root, installEnv).stdout.trim();
    if (!globalBinDir) {
      throw new Error("bun pm bin -g returned an empty path.");
    }
    const pushpalsPath = resolvePushpalsCommand(globalBinDir);
    const commandEnv = {
      ...installEnv,
      PATH: `${globalBinDir}${delimiter}${process.env.PATH ?? ""}`,
      PUSHPALS_OPENAI_CODEX_AUTH_MODE: "api_key",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "pushpals-installed-cli-smoke-openai-key",
      REMOTEBUDDY_AUTONOMY_ENABLED: "true",
      ...(options.workerpalAutospawn ? {} : { REMOTEBUDDY_AUTO_SPAWN_WORKERPALS: "false" }),
      ...(options.useRepoDataDir ? {} : { PUSHPALS_DATA_DIR_OVERRIDE: dataDir }),
    } as Record<string, string>;

    const clearResult = await runWithTimeout(
      [pushpalsPath, "--clear", "--runtime-root", runtimeRoot],
      repoPath,
      commandEnv,
      10 * 60_000,
    );
    assertCommandSucceeded(clearResult, "pushpals --clear");

    const statusResult = await runWithTimeout(
      [pushpalsPath, "--status-once", "--runtime-root", runtimeRoot],
      repoPath,
      commandEnv,
      options.durationMs,
    );
    assertCommandSucceeded(statusResult, "pushpals --status-once");

    const combined = `${statusResult.stdout}\n${statusResult.stderr}`;
    assertNoStartupFailure(combined);
    if (!combined.includes("[pushpals] startup timing summary: outcome=ready")) {
      throw new Error(`Missing startup readiness summary.\n${summarizeTail(combined)}`);
    }
    if (!combined.includes("[pushpals] Embedded runtime is ready.")) {
      throw new Error(`Missing embedded runtime ready log line.\n${summarizeTail(combined)}`);
    }
    if (!combined.includes("[pushpals] Connected.")) {
      throw new Error(`Missing connected log line.\n${summarizeTail(combined)}`);
    }
    console.log(
      `[installed-cli-smoke] Installed package ${options.packageSpec} cold-started successfully on ${process.platform}/${process.arch}.`,
    );
  } finally {
    if (options.keepTemp) {
      console.log(`[installed-cli-smoke] Preserved temp root at ${root}`);
    } else {
      try {
        await removeTreeWithRetries(root);
      } catch (error) {
        console.warn(`[installed-cli-smoke] Temp cleanup warning for ${root}: ${String(error)}`);
      }
    }
  }
}

await main();
