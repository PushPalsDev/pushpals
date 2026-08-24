#!/usr/bin/env bun

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, delimiter, join, resolve } from "path";
import { runBoundedProcess } from "../packages/shared/src/bounded_process.ts";

type SmokeOptions = {
  packageSpec: string;
  durationMs: number;
  soakMs: number;
  repoPath: string | null;
  useRepoDataDir: boolean;
  keepTemp: boolean;
  workerpalAutospawn: boolean;
  runtimeBinDir: string | null;
  runtimeTag: string | null;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ProcessOutputCollector = {
  done: Promise<string>;
  snapshot: () => string;
  cancel: () => void;
};

const OUTPUT_DRAIN_TIMEOUT_MS = 2_000;
const OUTPUT_MAX_CHARS = 512_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const TEMP_CLEANUP_TIMEOUT_MS = 15_000;
const RUNTIME_SERVICE_TOKENS = [
  "server",
  "localbuddy",
  "remotebuddy",
  "workerpals",
  "source-control-manager",
] as const;

export function runtimeCandidateBinaryNames(platformKey: string): string[] {
  if (!/^(?:linux|windows|macos)-(?:x64|arm64)$/.test(platformKey)) {
    throw new Error(`Unsupported candidate runtime platform: ${platformKey}`);
  }
  const extension = platformKey.startsWith("windows-") ? ".exe" : "";
  return RUNTIME_SERVICE_TOKENS.map(
    (service) => `pushpals-runtime-${service}-${platformKey}${extension}`,
  );
}

export function currentRuntimePlatformKey(
  platform = process.platform,
  architecture = process.arch,
): string {
  const family = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform;
  const platformKey = `${family}-${architecture}`;
  runtimeCandidateBinaryNames(platformKey);
  return platformKey;
}

export function expectedCliVersionFromReleaseInput(
  packageSpec: string,
  runtimeTag: string | null,
): string | null {
  const runtimeVersion = String(runtimeTag ?? "")
    .trim()
    .match(/^v(\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?)$/)?.[1];
  if (runtimeVersion) return runtimeVersion;

  const spec = String(packageSpec ?? "").trim();
  const exactPackageVersion = spec.match(/@(\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?)$/)?.[1];
  if (exactPackageVersion) return exactPackageVersion;

  return basename(spec).match(/-(\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?)\.tgz$/)?.[1] ?? null;
}

export function seedCandidateRuntimeBinaries(input: {
  runtimeRoot: string;
  runtimeBinDir: string;
  runtimeTag: string;
  platformKey?: string;
}): { binDir: string; binaryNames: string[]; tagMarkerPath: string } {
  const runtimeTag = String(input.runtimeTag ?? "").trim();
  if (!/^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(runtimeTag)) {
    throw new Error(`Invalid candidate runtime tag: ${runtimeTag || "(empty)"}`);
  }
  const platformKey = input.platformKey ?? currentRuntimePlatformKey();
  const binaryNames = runtimeCandidateBinaryNames(platformKey);
  const sourceDir = resolve(input.runtimeBinDir);
  const binDir = join(resolve(input.runtimeRoot), "bin", platformKey);
  const tagMarkerPath = join(binDir, ".runtime-tag");
  mkdirSync(binDir, { recursive: true });

  // A marker is authoritative only after every candidate binary is validated and copied.
  rmSync(tagMarkerPath, { force: true });
  const invalidSources = binaryNames.filter((name) => {
    const source = join(sourceDir, name);
    try {
      const stat = statSync(source);
      return !stat.isFile() || stat.size <= 0;
    } catch {
      return true;
    }
  });
  if (invalidSources.length > 0) {
    throw new Error(
      `Candidate runtime artifact is missing required non-empty file(s): ${invalidSources.join(", ")}`,
    );
  }

  for (const name of binaryNames) {
    const destination = join(binDir, name);
    copyFileSync(join(sourceDir, name), destination);
    if (!platformKey.startsWith("windows-") && process.platform !== "win32") {
      chmodSync(destination, 0o755);
    }
  }

  const pendingMarker = join(
    binDir,
    `.runtime-tag.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(pendingMarker, `${runtimeTag}\n`, "utf8");
    renameSync(pendingMarker, tagMarkerPath);
  } finally {
    rmSync(pendingMarker, { force: true });
  }
  return { binDir, binaryNames, tagMarkerPath };
}

function parseArgs(argv: string[]): SmokeOptions {
  let packageSpec = "";
  let durationMs = 7 * 60_000;
  let soakMs = 0;
  let repoPath: string | null = null;
  let useRepoDataDir = false;
  let keepTemp = false;
  let workerpalAutospawn = false;
  let runtimeBinDir: string | null = null;
  let runtimeTag: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--package-spec":
        packageSpec = String(argv[++index] ?? "").trim();
        break;
      case "--duration-ms":
        durationMs = Math.max(
          30_000,
          Number.parseInt(String(argv[++index] ?? "420000"), 10) || 7 * 60_000,
        );
        break;
      case "--soak-ms":
        soakMs = Math.max(0, Number.parseInt(String(argv[++index] ?? "0"), 10) || 0);
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
      case "--runtime-bin-dir":
        runtimeBinDir = String(argv[++index] ?? "").trim() || null;
        break;
      case "--runtime-tag":
        runtimeTag = String(argv[++index] ?? "").trim() || null;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!packageSpec) {
    throw new Error("--package-spec is required");
  }
  if (Boolean(runtimeBinDir) !== Boolean(runtimeTag)) {
    throw new Error("--runtime-bin-dir and --runtime-tag must be provided together");
  }

  return {
    packageSpec,
    durationMs,
    soakMs,
    repoPath: repoPath ? resolve(repoPath) : null,
    useRepoDataDir,
    keepTemp,
    workerpalAutospawn,
    runtimeBinDir: runtimeBinDir ? resolve(runtimeBinDir) : null,
    runtimeTag,
  };
}

function appendBoundedOutput(existing: string, next: string): string {
  if (!next) return existing;
  const combined = `${existing}${next}`;
  if (combined.length <= OUTPUT_MAX_CHARS) return combined;
  return combined.slice(combined.length - OUTPUT_MAX_CHARS);
}

function collectOutput(
  stream: ReadableStream<Uint8Array> | null | undefined,
): ProcessOutputCollector {
  if (!stream) {
    return {
      done: Promise.resolve(""),
      snapshot: () => "",
      cancel: () => {},
    };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let cancelled = false;
  let finished = false;
  const done = (async (): Promise<string> => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output = appendBoundedOutput(output, decoder.decode(chunk.value, { stream: true }));
      }
      output = appendBoundedOutput(output, decoder.decode());
    } catch (err) {
      if (!cancelled) {
        output = appendBoundedOutput(output, `\n[smoke] output read failed: ${String(err)}`);
      }
    } finally {
      finished = true;
      try {
        reader.releaseLock();
      } catch {
        // best-effort stream cleanup only
      }
    }
    return output;
  })();

  return {
    done,
    snapshot: () => output,
    cancel: () => {
      if (finished || cancelled) return;
      cancelled = true;
      try {
        void reader.cancel().catch(() => {});
      } catch {
        // best-effort stream cleanup only
      }
    },
  };
}

async function finishOutput(collector: ProcessOutputCollector): Promise<string> {
  const result = await Promise.race([
    collector.done.then((text) => ({ text, timedOut: false })),
    Bun.sleep(OUTPUT_DRAIN_TIMEOUT_MS).then(() => ({
      text: collector.snapshot(),
      timedOut: true,
    })),
  ]);
  if (result.timedOut) {
    collector.cancel();
  }
  return result.text;
}

function killProcessTree(proc: ReturnType<typeof Bun.spawn>): void {
  try {
    if (process.platform === "win32" && typeof proc.pid === "number" && proc.pid > 0) {
      Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      return;
    }
    proc.kill("SIGKILL");
  } catch {
    // best-effort timeout cleanup only
  }
}

async function runChecked(
  cmd: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
  timeoutMs = 2 * 60_000,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runWithTimeout(
    cmd,
    cwd,
    env ?? (process.env as Record<string, string>),
    timeoutMs,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${cmd.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function runWithTimeout(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<CommandResult> {
  const result = await runBoundedProcess(cmd, {
    cwd,
    env,
    stdin: "ignore",
    timeoutMs,
    outputLimitBytes: OUTPUT_MAX_CHARS,
    streamDrainTimeoutMs: OUTPUT_DRAIN_TIMEOUT_MS,
    retainOutputTail: true,
    preserveOutputWhitespace: true,
  });
  if (result.timedOut) {
    throw new Error(
      `Timed out after ${timeoutMs}ms: ${cmd.join(" ")}\n${summarizeTail(`${result.stdout}\n${result.stderr}`)}`,
    );
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function initializeTempRepo(root: string): Promise<string> {
  const repoPath = join(root, "repo");
  const remotePath = join(root, "origin.git");
  mkdirSync(repoPath, { recursive: true });
  await runChecked(["git", "init"], repoPath);
  await runChecked(["git", "branch", "-M", "main"], repoPath);
  await runChecked(["git", "config", "user.name", "PushPals Installed Smoke"], repoPath);
  await runChecked(
    ["git", "config", "user.email", "pushpals-installed-smoke@example.com"],
    repoPath,
  );
  writeFileSync(join(repoPath, "README.md"), "# Installed CLI Smoke\n", "utf8");
  writeFileSync(
    join(repoPath, "vision.md"),
    "# Installed CLI Smoke Vision\n\n> **One sentence:** Validate the published PushPals package cold-starts cleanly.\n",
    "utf8",
  );
  await runChecked(["git", "add", "README.md", "vision.md"], repoPath);
  await runChecked(["git", "commit", "-m", "chore: seed installed CLI smoke repo"], repoPath);
  await runChecked(["git", "init", "--bare", remotePath], root);
  await runChecked(["git", "remote", "add", "origin", remotePath], repoPath);
  await runChecked(["git", "push", "-u", "origin", "main"], repoPath);
  await runChecked(["git", "checkout", "-b", "main_agents"], repoPath);
  await runChecked(["git", "push", "-u", "origin", "main_agents"], repoPath);
  await runChecked(["git", "checkout", "main"], repoPath);
  return repoPath;
}

async function resolveRepoPath(root: string, repoPath: string | null): Promise<string> {
  if (!repoPath) {
    return await initializeTempRepo(root);
  }
  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`--repo-path is not a git repository: ${repoPath}`);
  }
  return repoPath;
}

function resolvePushpalsCommand(globalBinDir: string): string {
  const candidates =
    process.platform === "win32" ? ["pushpals.exe", "pushpals.cmd", "pushpals"] : ["pushpals"];
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

export async function assertCliVersionCommand(input: {
  command: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  expectedVersion: string;
  timeoutMs?: number;
  label?: string;
}): Promise<string> {
  const expectedVersion = String(input.expectedVersion ?? "").trim();
  if (!/^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
    throw new Error(`Invalid expected CLI version: ${expectedVersion || "(empty)"}`);
  }
  if (input.command.length === 0 || input.command.some((part) => !String(part).trim())) {
    throw new Error("CLI version command must contain non-empty arguments");
  }

  const result = await runWithTimeout(
    [...input.command, "--version"],
    input.cwd,
    input.env,
    Math.max(1_000, input.timeoutMs ?? 30_000),
  );
  const label = input.label ?? "CLI --version";
  assertCommandSucceeded(result, label);
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(`[pushpals] version=${expectedVersion} runtime=bun@`)) {
    throw new Error(
      `${label} did not report exact package version ${expectedVersion}.\n${summarizeTail(output)}`,
    );
  }
  if (
    output.includes("Unknown argument") ||
    output.includes("Running runtime preflight") ||
    output.includes("Starting embedded")
  ) {
    throw new Error(`${label} performed unexpected startup work.\n${summarizeTail(output)}`);
  }
  return output;
}

function assertNoStartupFailure(text: string): void {
  const blockers = [
    "Auto-start failed:",
    "Fatal:",
    "panic(main thread):",
    "Segmentation fault",
    "oh no: Bun has crashed",
    "Embedded remotebuddy exited during startup",
    "embeddedRuntimeCrash=",
    "embeddedRuntime=degraded",
  ];
  for (const blocker of blockers) {
    if (text.includes(blocker)) {
      throw new Error(
        `Installed CLI smoke observed failure marker "${blocker}"\n${summarizeTail(text)}`,
      );
    }
  }
}

async function runInstalledRuntimeSoak(options: {
  pushpalsPath: string;
  repoPath: string;
  runtimeRoot: string;
  env: Record<string, string | undefined>;
  soakMs: number;
  startupTimeoutMs: number;
}): Promise<void> {
  if (options.soakMs <= 0) return;
  const proc = Bun.spawn(
    [options.pushpalsPath, "--runtime-only", "--runtime-root", options.runtimeRoot],
    {
      cwd: options.repoPath,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutCollector = collectOutput(proc.stdout);
  const stderrCollector = collectOutput(proc.stderr);
  let exitCode: number | null = null;
  void proc.exited.then((code) => {
    exitCode = code;
  });
  const combinedSnapshot = () => `${stdoutCollector.snapshot()}\n${stderrCollector.snapshot()}`;

  try {
    const startupDeadline = Date.now() + options.startupTimeoutMs;
    while (Date.now() < startupDeadline) {
      const snapshot = combinedSnapshot();
      assertNoStartupFailure(snapshot);
      if (snapshot.includes("[pushpals] Embedded runtime is ready.")) break;
      if (exitCode !== null) {
        throw new Error(
          `Installed runtime-only soak exited ${exitCode} before readiness.\n${summarizeTail(snapshot)}`,
        );
      }
      await Bun.sleep(500);
    }
    if (!combinedSnapshot().includes("[pushpals] Embedded runtime is ready.")) {
      throw new Error(
        `Installed runtime-only soak did not become ready within ${options.startupTimeoutMs}ms.\n${summarizeTail(combinedSnapshot())}`,
      );
    }

    const soakDeadline = Date.now() + options.soakMs;
    while (Date.now() < soakDeadline) {
      const snapshot = combinedSnapshot();
      assertNoStartupFailure(snapshot);
      if (exitCode !== null) {
        throw new Error(
          `Installed runtime-only soak exited ${exitCode} before the ${options.soakMs}ms soak completed.\n${summarizeTail(snapshot)}`,
        );
      }
      await Bun.sleep(Math.min(1_000, Math.max(1, soakDeadline - Date.now())));
    }
    assertNoStartupFailure(combinedSnapshot());
    console.log(
      `[installed-cli-smoke] Runtime remained healthy for ${options.soakMs}ms after readiness.`,
    );
  } finally {
    if (exitCode === null) {
      try {
        proc.stdin.write("exit\n");
        proc.stdin.end();
      } catch {
        killProcessTree(proc);
      }
      await Promise.race([proc.exited.catch(() => -1), Bun.sleep(60_000)]);
    }
    if (exitCode === null) killProcessTree(proc);
    await Promise.all([finishOutput(stdoutCollector), finishOutput(stderrCollector)]);
  }
}

async function runBestEffortClear(
  pushpalsPath: string,
  repoPath: string,
  runtimeRoot: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  try {
    const result = await runWithTimeout(
      [pushpalsPath, "--clear", "--runtime-root", runtimeRoot],
      repoPath,
      env,
      60_000,
    );
    if (result.exitCode !== 0) {
      console.warn(
        `[installed-cli-smoke] Final clear warning: exit ${result.exitCode}\n${summarizeTail(`${result.stdout}\n${result.stderr}`)}`,
      );
    }
  } catch (error) {
    console.warn(`[installed-cli-smoke] Final clear warning: ${String(error)}`);
  }
}

function assertSafeSmokeTempRoot(root: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTmp = resolve(tmpdir());
  if (
    !normalizedRoot.toLowerCase().startsWith(normalizedTmp.toLowerCase()) ||
    !basename(normalizedRoot).startsWith("pushpals-installed-cli-smoke-")
  ) {
    throw new Error(`Refusing to cleanup unexpected temp root: ${root}`);
  }
}

async function removeTreeWithRetries(root: string, attempts = 3, delayMs = 500): Promise<void> {
  assertSafeSmokeTempRoot(root);
  const cleanupScript =
    "import { rmSync } from 'fs'; const target = process.argv[1]; if (!target) process.exit(2); rmSync(target, { recursive: true, force: true });";
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await runWithTimeout(
        [process.execPath, "-e", cleanupScript, root],
        tmpdir(),
        process.env as Record<string, string | undefined>,
        TEMP_CLEANUP_TIMEOUT_MS,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `temp cleanup exited ${result.exitCode}: ${summarizeTail(`${result.stdout}\n${result.stderr}`)}`,
        );
      }
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
  let finalClear: {
    pushpalsPath: string;
    repoPath: string;
    commandEnv: Record<string, string>;
  } | null = null;

  try {
    const repoPath = await resolveRepoPath(root, options.repoPath);
    const installEnv = {
      ...process.env,
      BUN_INSTALL: bunInstallRoot,
    } as Record<string, string>;

    console.log(`[installed-cli-smoke] Installing ${options.packageSpec}`);
    await runChecked(
      [process.execPath, "install", "-g", options.packageSpec],
      root,
      installEnv,
      5 * 60_000,
    );
    const globalBinDir = (
      await runChecked([process.execPath, "pm", "bin", "-g"], root, installEnv, 30_000)
    ).stdout.trim();
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
    finalClear = { pushpalsPath, repoPath, commandEnv };

    const expectedCliVersion = expectedCliVersionFromReleaseInput(
      options.packageSpec,
      options.runtimeTag,
    );
    if (!expectedCliVersion) {
      throw new Error(
        `Could not derive an exact CLI version from package spec ${options.packageSpec} and runtime tag ${options.runtimeTag ?? "(none)"}.`,
      );
    }
    await assertCliVersionCommand({
      command: [pushpalsPath],
      cwd: root,
      env: commandEnv,
      expectedVersion: expectedCliVersion,
      label: "Installed pushpals --version",
    });

    const clearResult = await runWithTimeout(
      [pushpalsPath, "--clear", "--runtime-root", runtimeRoot],
      repoPath,
      commandEnv,
      10 * 60_000,
    );
    assertCommandSucceeded(clearResult, "pushpals --clear");

    if (options.runtimeBinDir && options.runtimeTag) {
      const seeded = seedCandidateRuntimeBinaries({
        runtimeRoot,
        runtimeBinDir: options.runtimeBinDir,
        runtimeTag: options.runtimeTag,
      });
      console.log(
        `[installed-cli-smoke] Seeded ${seeded.binaryNames.length} candidate runtime binaries for ${options.runtimeTag} in ${seeded.binDir}.`,
      );
    }

    const statusResult = await runWithTimeout(
      [pushpalsPath, "--status-once", "--runtime-root", runtimeRoot],
      repoPath,
      commandEnv,
      options.durationMs,
    );
    assertCommandSucceeded(statusResult, "pushpals --status-once");

    const combined = `${statusResult.stdout}\n${statusResult.stderr}`;
    assertNoStartupFailure(combined);
    if (options.runtimeTag) {
      if (!combined.includes(`[pushpals] runtimeTag=${options.runtimeTag}`)) {
        throw new Error(
          `Installed CLI did not select candidate runtime ${options.runtimeTag}.\n${summarizeTail(combined)}`,
        );
      }
      if (!combined.includes("[pushpals] Embedded runtime binaries are already present.")) {
        throw new Error(
          `Installed CLI did not reuse the seeded candidate runtime binaries.\n${summarizeTail(combined)}`,
        );
      }
      if (
        combined.includes("Downloading embedded runtime binary") ||
        combined.includes("runtime binary asset(s) with bounded parallelism")
      ) {
        throw new Error(
          `Installed CLI attempted a GitHub runtime download during candidate validation.\n${summarizeTail(combined)}`,
        );
      }
    }
    if (!combined.includes("[pushpals] startup timing summary: outcome=ready")) {
      throw new Error(`Missing startup readiness summary.\n${summarizeTail(combined)}`);
    }
    if (!combined.includes("[pushpals] Embedded runtime is ready.")) {
      throw new Error(`Missing embedded runtime ready log line.\n${summarizeTail(combined)}`);
    }
    if (!combined.includes("[pushpals] Connected.")) {
      throw new Error(`Missing connected log line.\n${summarizeTail(combined)}`);
    }
    await runInstalledRuntimeSoak({
      pushpalsPath,
      repoPath,
      runtimeRoot,
      env: commandEnv,
      soakMs: options.soakMs,
      startupTimeoutMs: options.durationMs,
    });
    console.log(
      `[installed-cli-smoke] Installed package ${options.packageSpec} cold-started successfully on ${process.platform}/${process.arch}.`,
    );
  } finally {
    if (options.keepTemp) {
      console.log(`[installed-cli-smoke] Preserved temp root at ${root}`);
    } else {
      if (finalClear) {
        await runBestEffortClear(
          finalClear.pushpalsPath,
          finalClear.repoPath,
          runtimeRoot,
          finalClear.commandEnv,
        );
      }
      try {
        await removeTreeWithRetries(root);
      } catch (error) {
        console.warn(`[installed-cli-smoke] Temp cleanup warning for ${root}: ${String(error)}`);
      }
    }
  }
}

if (import.meta.main) {
  await main();
}
