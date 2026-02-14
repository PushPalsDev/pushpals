#!/usr/bin/env bun
/**
 * Stable start entrypoint.
 *
 * `bun run start` can be invoked with accidental extra CLI flags (e.g. `-c`)
 * from shell wrappers. This wrapper intentionally ignores forwarded args and
 * always launches `dev:full` with the canonical script options.
 *
 * Supported flags:
 * - `-c` / `--clean`: wipe runtime data dir (`PUSHPALS_DATA_DIR`, default `outputs/data`)
 *   before bootstrapping services.
 *
 * It also performs startup preflights:
 * - LLM endpoint reachability (and optional LM Studio headless auto-start)
 * - integration branch/worktree safety
 * - worker Docker image existence
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { createHash } from "crypto";
import { dirname, isAbsolute, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { loadPushPalsConfig } from "../packages/shared/src/config.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const CONFIG = loadPushPalsConfig({ projectRoot: repoRoot });

const DEFAULT_IMAGE = "pushpals-worker-sandbox:latest";
const DEFAULT_LMSTUDIO_ENDPOINT = "http://127.0.0.1:1234";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/chat";
const DEFAULT_LMSTUDIO_READY_TIMEOUT_MS = 120_000;
const DEFAULT_INTEGRATION_BRANCH = "main_agents";
const INTEGRATION_BRANCH =
  (CONFIG.sourceControlManager.mainBranch ?? "").trim() || DEFAULT_INTEGRATION_BRANCH;
const INTEGRATION_REMOTE_REF = `origin/${INTEGRATION_BRANCH}`;
const DEFAULT_INTEGRATION_BASE_BRANCH = "main";
const INTEGRATION_BASE_BRANCH =
  (CONFIG.sourceControlManager.baseBranch ?? "").trim() || DEFAULT_INTEGRATION_BASE_BRANCH;
const INTEGRATION_BASE_REMOTE_REF = `origin/${INTEGRATION_BASE_BRANCH}`;
const START_SYNC_GIT_USER_NAME = "PushPals Start Sync";
const START_SYNC_GIT_USER_EMAIL = "pushpals-start@local";
const DEFAULT_PUSHPALS_PORT = CONFIG.server.port;
const DEFAULT_STARTUP_WARMUP_TIMEOUT_MS = 120_000;
const DEFAULT_STARTUP_WARMUP_POLL_MS = 1_000;
const workerImage = CONFIG.workerpals.dockerImage || DEFAULT_IMAGE;
const WORKER_IMAGE_INPUTS_HASH_LABEL = "pushpals.worker.inputs_hash";
const WORKER_IMAGE_INPUT_PATHS = [
  "apps/workerpals",
  "packages/protocol",
  "packages/shared",
  "prompts/workerpals",
  "package.json",
  "bun.lock",
  "bun.lockb",
];
const WORKER_IMAGE_HASH_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".worktrees",
  "outputs",
  "workspace",
  ".venv",
  "dist",
  "build",
  ".next",
  ".expo",
]);
const DEFAULT_SOURCE_CONTROL_MANAGER_WORKTREE = resolve(CONFIG.sourceControlManager.repoPath);
const TRUTHY = new Set(["1", "true", "yes", "on"]);

type StartOptions = {
  clean: boolean;
};

let managedLmStudioProc: ReturnType<typeof Bun.spawn> | null = null;
let managedLmStudioExitCode: number | null = null;
let managedLmStudioCommand: string[] | null = null;
const managedLmStudioLogTail: string[] = [];
let managedLmStudioStartedByUs = false;
let managedLmStudioDaemonized = false;
let managedLmStudioStopCli: string | null = null;
let managedLmStudioStopPort: number | null = null;

class StartAbort extends Error {
  exitCode: number;

  constructor(exitCode: number, message?: string) {
    super(message ?? `startup aborted (${exitCode})`);
    this.exitCode = exitCode;
  }
}

function parseStartOptions(argv: string[]): StartOptions {
  let clean = false;

  for (const arg of argv) {
    if (arg === "-c" || arg === "--clean") {
      clean = true;
      continue;
    }
    if (arg === "--") break;
    console.warn(`[start] Ignoring unknown start flag: ${arg}`);
  }

  return { clean };
}

const startOptions = parseStartOptions(process.argv.slice(2));

type SupportedLlmBackend = "lmstudio" | "ollama";

function abortStart(exitCode: number): never {
  throw new StartAbort(exitCode);
}

function envTruthy(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? "").toLowerCase());
}

type WorkerImageRebuildMode = "auto" | "always" | "never";

function workerImageRebuildMode(): WorkerImageRebuildMode {
  return CONFIG.startup.workerImageRebuild;
}

function syncIntegrationWithMainEnabled(): boolean {
  return CONFIG.startup.syncIntegrationWithMain;
}

function resolveFromRepo(pathValue: string): string {
  return isAbsolute(pathValue) ? pathValue : resolve(repoRoot, pathValue);
}

function isWithinRepo(pathValue: string): boolean {
  const rel = relative(repoRoot, pathValue);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function dataDirPath(): string {
  return resolve(CONFIG.paths.dataDir);
}

function cleanRuntimeStateIfRequested(): void {
  if (!startOptions.clean) return;

  const dataDir = dataDirPath();
  const allowExternalClean = CONFIG.startup.allowExternalClean;
  if (!isWithinRepo(dataDir) && !allowExternalClean) {
    console.warn(
      `[start] Refusing to clean data dir outside repo without PUSHPALS_ALLOW_EXTERNAL_CLEAN=1: ${dataDir}`,
    );
    return;
  }

  if (!existsSync(dataDir)) {
    console.log(
      `[start] Clean run: no runtime data directory found at ${dataDir} (nothing to delete).`,
    );
  } else {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`[start] Clean run: removed runtime state at ${dataDir}`);
  }

  const scratchWorkspaceDir = resolve(repoRoot, "workspace");
  if (existsSync(scratchWorkspaceDir)) {
    rmSync(scratchWorkspaceDir, { recursive: true, force: true });
    console.log(`[start] Clean run: removed runtime scratch dir at ${scratchWorkspaceDir}`);
  }
}

function sanitizeInaccessibleEntries(dirPath: string, label: string): number {
  if (!existsSync(dirPath)) return 0;

  const pending: string[] = [dirPath];
  let removed = 0;

  while (pending.length > 0) {
    const currentDir = pending.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch (err: any) {
      const code = typeof err?.code === "string" ? err.code : "";
      if (code === "EACCES" || code === "EPERM" || code === "UNKNOWN") {
        try {
          // Avoid deleting the root scan dir itself; remove inaccessible children only.
          if (currentDir !== dirPath) {
            rmSync(currentDir, { recursive: true, force: true });
            removed += 1;
            console.warn(`[start] Removed inaccessible ${label} entry: ${currentDir}`);
          }
        } catch {
          // best-effort only; if this fails, downstream watcher will surface path details.
        }
      }
      continue;
    }

    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry);
      let stat: ReturnType<typeof lstatSync> | null = null;
      try {
        stat = lstatSync(fullPath);
      } catch (err: any) {
        const code = typeof err?.code === "string" ? err.code : "";
        if (code === "EACCES" || code === "EPERM" || code === "UNKNOWN") {
          try {
            rmSync(fullPath, { recursive: true, force: true });
            removed += 1;
            console.warn(`[start] Removed inaccessible ${label} entry: ${fullPath}`);
          } catch {
            // best-effort only; if this fails, downstream watcher will surface path details.
          }
        }
        continue;
      }

      if (stat.isDirectory()) {
        pending.push(fullPath);
      }
    }
  }

  return removed;
}

function removeWindowsIncompatibleBunArtifacts(bunStoreDir: string): number {
  if (!existsSync(bunStoreDir)) return 0;

  let removed = 0;
  const queue: string[] = [bunStoreDir];

  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = resolve(current, entry);
      let stat: ReturnType<typeof lstatSync> | null = null;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }

      if (!stat.isDirectory()) continue;

      // Expo/Metro can choke on Linux-targeted optional binaries in Bun's store on Windows.
      if (/-linux-/i.test(entry)) {
        try {
          rmSync(fullPath, { recursive: true, force: true });
          removed += 1;
          console.warn(`[start] Removed Windows-incompatible Bun artifact: ${fullPath}`);
        } catch {
          // best effort
        }
        continue;
      }

      queue.push(fullPath);
    }
  }

  return removed;
}

function sanitizeWindowsWatcherPaths(): void {
  if (process.platform !== "win32") return;

  const binDirs = [resolve(repoRoot, "node_modules", ".bin")];
  const bunStoreDirs = [resolve(repoRoot, "node_modules", ".bun", "node_modules")];

  for (const group of ["apps", "packages"]) {
    const groupPath = resolve(repoRoot, group);
    if (!existsSync(groupPath)) continue;
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      binDirs.push(resolve(groupPath, entry.name, "node_modules", ".bin"));
      bunStoreDirs.push(resolve(groupPath, entry.name, "node_modules", ".bun", "node_modules"));
    }
  }

  let removedBin = 0;
  for (const dir of binDirs) {
    removedBin += sanitizeInaccessibleEntries(dir, "node_modules/.bin");
  }
  if (removedBin > 0) {
    console.log(
      `[start] Cleaned ${removedBin} inaccessible node_modules/.bin entries for Windows watcher compatibility.`,
    );
  }

  let removedBunStore = 0;
  for (const dir of bunStoreDirs) {
    removedBunStore += removeWindowsIncompatibleBunArtifacts(dir);
    removedBunStore += sanitizeInaccessibleEntries(dir, "node_modules/.bun/node_modules");
  }
  if (removedBunStore > 0) {
    console.log(
      `[start] Cleaned ${removedBunStore} inaccessible node_modules/.bun/node_modules entries for Windows watcher compatibility.`,
    );
  }
}

function parsePositiveInt(value: string | null | undefined): number | null {
  const normalized = (value ?? "").trim();
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function normalizeCompletionEndpoint(raw: string, fallback: string): string {
  const source = (raw.trim() || fallback).replace(/\/+$/, "");
  if (source.includes("/chat/completions")) return source;
  if (source.endsWith("/api/chat")) return source;
  if (source.endsWith("/v1")) return `${source}/chat/completions`;
  return `${source}/v1/chat/completions`;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeLlmBackend(value: string | null | undefined): SupportedLlmBackend | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "lmstudio") return "lmstudio";
  if (normalized === "ollama") return "ollama";
  if (normalized === "openai" || normalized === "openai_compatible") return "lmstudio";
  if (normalized === "ollama_chat") return "ollama";
  return null;
}

function configuredLlmBackend(
  endpoint: string,
  explicitBackend?: string | null | undefined,
): SupportedLlmBackend {
  const explicit = normalizeLlmBackend(explicitBackend);
  if (explicit) return explicit;
  return endpoint.includes("/api/chat") ? "ollama" : "lmstudio";
}

function normalizeEndpointForBackend(
  raw: string,
  fallback: string,
  backend: SupportedLlmBackend,
): string {
  const source = (raw.trim() || fallback).replace(/\/+$/, "");
  if (backend === "ollama") {
    if (source.endsWith("/api/chat")) return source;
    return `${source}/api/chat`;
  }
  return normalizeCompletionEndpoint(source, fallback);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function appendLmStudioLogTail(line: string): void {
  managedLmStudioLogTail.push(line);
  if (managedLmStudioLogTail.length > 120) {
    managedLmStudioLogTail.splice(0, managedLmStudioLogTail.length - 120);
  }
}

function streamProcessOutput(stream: ReadableStream<Uint8Array> | null, prefix: string): void {
  if (!stream) return;

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  void (async () => {
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trimEnd();
          if (!trimmed) continue;
          appendLmStudioLogTail(trimmed);
          console.log(`${prefix}${trimmed}`);
        }
      }
      const tail = pending.trim();
      if (tail) {
        appendLmStudioLogTail(tail);
        console.log(`${prefix}${tail}`);
      }
    } catch {
      // best effort log streaming only
    } finally {
      reader.releaseLock();
    }
  })();
}

async function probeHttpReachable(
  url: string,
  timeoutMs = 2500,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json, text/plain, */*" },
    });
    if (response.status >= 200 && response.status < 500) {
      return { ok: true, status: response.status };
    }
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

type LlmPreflightTarget = {
  name: string;
  endpoint: string;
  probes: string[];
};

type LlmPreflightCheck = { ok: boolean; url?: string; status?: number; error?: string };

type LlmPreflightEndpointGroup = {
  endpoint: string;
  probes: string[];
  services: string[];
};

async function checkTargetReachable(target: {
  endpoint: string;
  probes: string[];
}): Promise<LlmPreflightCheck> {
  let lastError = "unknown error";
  for (const probe of target.probes) {
    const result = await probeHttpReachable(probe);
    if (result.ok) return { ok: true, url: probe, status: result.status };
    lastError = `${probe}: ${result.error ?? "connection failed"}`;
  }
  return { ok: false, error: lastError };
}

function llmPreflightTargets(): LlmPreflightTarget[] {
  const out: LlmPreflightTarget[] = [];
  const configuredRemoteRaw = firstNonEmpty(CONFIG.remotebuddy.llm.endpoint);
  const configuredLocalRaw = firstNonEmpty(CONFIG.localbuddy.llm.endpoint);
  const configuredWorkerRaw = firstNonEmpty(CONFIG.workerpals.llm.endpoint);

  const remoteBackend =
    normalizeLlmBackend(firstNonEmpty(CONFIG.remotebuddy.llm.backend)) ??
    configuredLlmBackend(configuredRemoteRaw || DEFAULT_LMSTUDIO_ENDPOINT);
  const localBackend =
    normalizeLlmBackend(firstNonEmpty(CONFIG.localbuddy.llm.backend)) ??
    configuredLlmBackend(configuredLocalRaw || DEFAULT_LMSTUDIO_ENDPOINT);
  const workerBackend =
    normalizeLlmBackend(firstNonEmpty(CONFIG.workerpals.llm.backend)) ??
    configuredLlmBackend(configuredWorkerRaw || DEFAULT_LMSTUDIO_ENDPOINT);

  const remoteFallback =
    remoteBackend === "ollama" ? DEFAULT_OLLAMA_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT;
  const localFallback =
    localBackend === "ollama" ? DEFAULT_OLLAMA_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT;
  const workerFallback =
    workerBackend === "ollama" ? DEFAULT_OLLAMA_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT;

  const addTarget = (name: string, endpoint: string): void => {
    const normalized = endpoint.trim();
    if (!normalized) return;

    const probes: string[] = [];
    const parsed = parseUrl(normalized);
    if (normalized.includes("/v1/chat/completions")) {
      probes.push(normalized.replace(/\/v1\/chat\/completions$/, "/v1/models"));
    } else if (normalized.endsWith("/api/chat")) {
      probes.push(normalized.replace(/\/api\/chat$/, "/api/tags"));
    } else if (normalized.includes("/chat/completions")) {
      probes.push(normalized.replace(/\/chat\/completions$/, "/models"));
    }
    probes.push(normalized);
    if (parsed) {
      probes.push(`${parsed.origin}/health`);
      probes.push(parsed.origin);
    }

    out.push({ name, endpoint: normalized, probes: Array.from(new Set(probes)) });
  };

  addTarget(
    "RemoteBuddy LLM",
    normalizeEndpointForBackend(configuredRemoteRaw, remoteFallback, remoteBackend),
  );
  addTarget(
    "LocalBuddy LLM",
    normalizeEndpointForBackend(configuredLocalRaw, localFallback, localBackend),
  );
  addTarget(
    "WorkerPal LLM",
    normalizeEndpointForBackend(configuredWorkerRaw, workerFallback, workerBackend),
  );

  return out;
}

function llmPreflightEndpointGroups(targets: LlmPreflightTarget[]): LlmPreflightEndpointGroup[] {
  const groups = new Map<string, LlmPreflightEndpointGroup>();
  for (const target of targets) {
    const key = target.endpoint;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        endpoint: target.endpoint,
        probes: [...target.probes],
        services: [target.name],
      });
      continue;
    }
    existing.services.push(target.name);
    for (const probe of target.probes) {
      if (!existing.probes.includes(probe)) existing.probes.push(probe);
    }
  }
  return Array.from(groups.values());
}

function lmStudioReadyTimeoutMs(): number {
  return Math.max(1_000, CONFIG.startup.lmStudioReadyTimeoutMs || DEFAULT_LMSTUDIO_READY_TIMEOUT_MS);
}

function shouldAutoStartLmStudio(primaryEndpoint: string): boolean {
  if (configuredLlmBackend(primaryEndpoint) !== "lmstudio") return false;

  if (!CONFIG.startup.autoStartLmStudio) return false;

  const parsed = parseUrl(primaryEndpoint);
  return parsed ? isLoopbackHost(parsed.hostname) : false;
}

function lmStudioCliCandidates(): string[] {
  const explicit = (CONFIG.startup.lmStudioCli ?? "").trim();
  const candidates = explicit ? [explicit] : ["lms", "lmstudio"];
  return Array.from(new Set(candidates));
}

function splitArgs(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

function resolveLmStudioPort(primaryEndpoint: string): number {
  const parsed = parseUrl(primaryEndpoint);
  const endpointPort = parsed?.port ? Number.parseInt(parsed.port, 10) : 1234;
  return Math.max(
    1,
    CONFIG.startup.lmStudioPort || (Number.isFinite(endpointPort) ? endpointPort : 1234),
  );
}

function lmStudioStartCommands(primaryEndpoint: string): string[][] {
  const port = resolveLmStudioPort(primaryEndpoint);
  const extraArgs = splitArgs(CONFIG.startup.lmStudioStartArgs ?? "");

  const commands: string[][] = [];
  for (const cli of lmStudioCliCandidates()) {
    commands.push([cli, "server", "start", "--port", String(port), ...extraArgs]);
    commands.push([cli, "server", "start", ...extraArgs]);
  }

  const seen = new Set<string>();
  return commands.filter((cmd) => {
    const key = cmd.join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function startManagedLmStudio(primaryEndpoint: string): Promise<void> {
  const attempts: string[] = [];
  const fallbackPort = resolveLmStudioPort(primaryEndpoint);

  managedLmStudioStartedByUs = false;
  managedLmStudioDaemonized = false;
  managedLmStudioStopCli = null;
  managedLmStudioStopPort = null;

  for (const cmd of lmStudioStartCommands(primaryEndpoint)) {
    console.log(`[start] Launching LM Studio headless: ${cmd.join(" ")}`);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(cmd, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      attempts.push(`${cmd.join(" ")} -> ${String(err)}`);
      continue;
    }

    managedLmStudioProc = proc;
    managedLmStudioCommand = cmd;
    managedLmStudioExitCode = null;

    void proc.exited.then((code) => {
      managedLmStudioExitCode = code;
    });

    streamProcessOutput(proc.stdout, "[lmstudio] ");
    streamProcessOutput(proc.stderr, "[lmstudio] ");

    const outcome = await Promise.race<
      { exited: true; code: number } | { exited: false; code: null }
    >([
      proc.exited.then((code) => ({ exited: true as const, code })),
      new Promise<{ exited: false; code: null }>((resolveAttempt) => {
        setTimeout(() => resolveAttempt({ exited: false, code: null }), 1800);
      }),
    ]);

    if (!outcome.exited) {
      const explicitPortIndex = cmd.indexOf("--port");
      const explicitPort =
        explicitPortIndex >= 0 && explicitPortIndex + 1 < cmd.length
          ? parsePositiveInt(cmd[explicitPortIndex + 1])
          : null;
      managedLmStudioStartedByUs = true;
      managedLmStudioDaemonized = false;
      managedLmStudioStopCli = cmd[0] ?? null;
      managedLmStudioStopPort = explicitPort ?? fallbackPort;
      return;
    }

    if (outcome.code === 0) {
      // Some LM Studio CLIs daemonize and exit quickly with success.
      const explicitPortIndex = cmd.indexOf("--port");
      const explicitPort =
        explicitPortIndex >= 0 && explicitPortIndex + 1 < cmd.length
          ? parsePositiveInt(cmd[explicitPortIndex + 1])
          : null;
      managedLmStudioStartedByUs = true;
      managedLmStudioDaemonized = true;
      managedLmStudioStopCli = cmd[0] ?? null;
      managedLmStudioStopPort = explicitPort ?? fallbackPort;
      managedLmStudioProc = null;
      managedLmStudioCommand = null;
      managedLmStudioExitCode = null;
      return;
    }

    attempts.push(`${cmd.join(" ")} -> exited ${outcome.code}`);
    managedLmStudioProc = null;
    managedLmStudioCommand = null;
    managedLmStudioExitCode = null;
  }

  const details = attempts.length > 0 ? attempts.join("; ") : "no command candidates were runnable";
  throw new Error(`Unable to launch LM Studio headless server (${details}).`);
}

async function stopManagedLmStudio(): Promise<void> {
  const proc = managedLmStudioProc;
  const startedByUs = managedLmStudioStartedByUs;
  const daemonized = managedLmStudioDaemonized;
  const stopCli = managedLmStudioStopCli;
  const stopPort = managedLmStudioStopPort;

  managedLmStudioProc = null;
  managedLmStudioExitCode = null;
  managedLmStudioCommand = null;
  managedLmStudioStartedByUs = false;
  managedLmStudioDaemonized = false;
  managedLmStudioStopCli = null;
  managedLmStudioStopPort = null;

  if (proc) {
    try {
      proc.kill();
    } catch {}

    try {
      await Promise.race([
        proc.exited,
        new Promise((resolveWait) => setTimeout(resolveWait, 2500)),
      ]);
    } catch {}
  }

  if (startedByUs && daemonized && stopCli) {
    const stopWithPort =
      stopPort != null ? ["server", "stop", "--port", String(stopPort)] : ["server", "stop"];
    let stopExit = await runQuiet([stopCli, ...stopWithPort]);
    if (stopExit !== 0 && stopPort != null) {
      stopExit = await runQuiet([stopCli, "server", "stop"]);
    }
    if (stopExit === 0) {
      console.log("[start] Stopped managed LM Studio headless server.");
    }
  }
}

function printLmStudioAutoStartHelp(primaryEndpoint: string): void {
  console.error("[start] Could not auto-start LM Studio.");
  console.error("[start] Verify:");
  console.error("[start] - LM Studio is installed and CLI is available (`lms --help`)");
  console.error("[start] - LM Studio headless server can run (`lms server start`)");
  console.error(
    "[start] - endpoint matches your LM Studio server (default http://127.0.0.1:1234/v1/chat/completions)",
  );
  console.error(`[start] - current endpoint: ${primaryEndpoint}`);
  if (managedLmStudioCommand) {
    console.error(`[start] - last launch command: ${managedLmStudioCommand.join(" ")}`);
  }
  if (managedLmStudioLogTail.length > 0) {
    console.error("[start] LM Studio recent logs:");
    for (const line of managedLmStudioLogTail.slice(-30)) {
      console.error(`[lmstudio] ${line}`);
    }
  }
  console.error("[start] Optional: set startup.auto_start_lmstudio=false and run LM Studio yourself.");
}

async function ensureLlmPreflight(): Promise<void> {
  if (CONFIG.startup.skipLlmPreflight) return;

  const serviceTargets = llmPreflightTargets();
  if (serviceTargets.length === 0) return;
  const endpointGroups = llmPreflightEndpointGroups(serviceTargets);
  if (endpointGroups.length === 0) return;

  const primary = endpointGroups[0];
  const primaryBackend = configuredLlmBackend(primary.endpoint);
  const autoStartEligible = shouldAutoStartLmStudio(primary.endpoint);
  let autoStartAttempted = false;
  let primaryReachable = await checkTargetReachable(primary);
  const checksByEndpoint = new Map<string, LlmPreflightCheck>();
  checksByEndpoint.set(primary.endpoint, primaryReachable);

  if (!primaryReachable.ok && autoStartEligible) {
    autoStartAttempted = true;
    try {
      await startManagedLmStudio(primary.endpoint);
    } catch (err) {
      console.error(`[start] Failed to auto-start LM Studio: ${String(err)}`);
      printLmStudioAutoStartHelp(primary.endpoint);
      await stopManagedLmStudio();
      abortStart(1);
    }

    const timeoutMs = lmStudioReadyTimeoutMs();
    console.log(
      `[start] Waiting for local LM Studio to become reachable (timeout ${timeoutMs}ms)...`,
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      primaryReachable = await checkTargetReachable(primary);
      if (primaryReachable.ok) break;

      if (managedLmStudioProc && managedLmStudioExitCode != null && managedLmStudioExitCode !== 0) {
        break;
      }

      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1200));
    }
  }
  checksByEndpoint.set(primary.endpoint, primaryReachable);

  for (const group of endpointGroups) {
    if (checksByEndpoint.has(group.endpoint)) continue;
    checksByEndpoint.set(group.endpoint, await checkTargetReachable(group));
  }

  const failures: Array<{ target: LlmPreflightTarget; check: LlmPreflightCheck }> = [];
  for (const target of serviceTargets) {
    const check = checksByEndpoint.get(target.endpoint) ?? { ok: false, error: "missing check result" };
    if (check.ok) {
      const statusText = typeof check.status === "number" ? `HTTP ${check.status}` : "reachable";
      console.log(
        `[start] LLM preflight ok for ${target.name}: ${check.url ?? target.endpoint} (${statusText})`,
      );
      continue;
    }
    failures.push({ target, check });
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      const { target, check } = failure;
      console.error(`[start] LLM preflight failed for ${target.name}.`);
      console.error(`[start] Endpoint: ${target.endpoint}`);
      console.error(`[start] Probes: ${target.probes.join(", ")}`);
      console.error(`[start] Last error: ${check.error ?? "connection failed"}`);
    }

    const primaryFailed = failures.some((failure) => failure.target.endpoint === primary.endpoint);

    if (autoStartAttempted && primaryFailed) {
      printLmStudioAutoStartHelp(primary.endpoint);
      await stopManagedLmStudio();
    } else if (!autoStartEligible && primaryFailed) {
      if (primaryBackend === "ollama") {
        console.error(
          `[start] Ollama backend selected. Start Ollama manually and ensure ${primary.services.join(", ")} endpoint points to /api/chat.`,
        );
      } else {
        console.error(
          "[start] LM Studio auto-start is disabled or endpoint is not local. Enable startup.auto_start_lmstudio in config to auto-start localhost endpoints.",
        );
      }
    }

    console.error(
      "[start] Start your model server or set startup.skip_llm_preflight=true in config to bypass this check.",
    );
    abortStart(1);
  }
}

async function runQuiet(cmd: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.exited;
  } catch {
    return 127;
  }
}

async function runInherited(cmd: string[], cwd?: string): Promise<number> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  } catch {
    return 127;
  }
}

type CmdResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCapture(cmd: string[], cwd = repoRoot): Promise<CmdResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: exitCode === 0,
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (err) {
    return {
      ok: false,
      exitCode: 127,
      stdout: "",
      stderr: String(err),
    };
  }
}

function startupWarmupEnabled(): boolean {
  return CONFIG.startup.startupWarmup;
}

function startupWarmupTimeoutMs(): number {
  const configured = CONFIG.startup.startupWarmupTimeoutMs || DEFAULT_STARTUP_WARMUP_TIMEOUT_MS;
  return Math.max(15_000, configured);
}

function startupWarmupPollMs(): number {
  const configured = CONFIG.startup.startupWarmupPollMs || DEFAULT_STARTUP_WARMUP_POLL_MS;
  return Math.max(250, Math.min(configured, 5_000));
}

function startupServerUrl(): string {
  const configured = CONFIG.server.url.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const port = DEFAULT_PUSHPALS_PORT;
  return `http://127.0.0.1:${port}`;
}

function startupWarmupSessionId(): string {
  const raw = (CONFIG.sessionId ?? "dev").trim();
  return raw || "dev";
}

function startupAuthHeaders(includeContentType: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) headers["Content-Type"] = "application/json";
  const token = (CONFIG.authToken ?? "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function startupFetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; json: any | null; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForServerHealth(
  baseUrl: string,
  deadlineMs: number,
  pollMs: number,
): Promise<boolean> {
  const healthUrl = `${baseUrl}/healthz`;
  while (Date.now() < deadlineMs) {
    const result = await startupFetchJson(healthUrl, { method: "GET" }, 1_500);
    if (result.ok) return true;
    await delay(pollMs);
  }
  return false;
}

async function waitForOnlineWorker(
  baseUrl: string,
  headers: Record<string, string>,
  deadlineMs: number,
  pollMs: number,
): Promise<boolean> {
  const workersUrl = `${baseUrl}/workers`;
  while (Date.now() < deadlineMs) {
    const result = await startupFetchJson(workersUrl, { method: "GET", headers }, 2_500);
    if (result.ok && Array.isArray(result.json?.workers)) {
      const anyOnline = result.json.workers.some((worker: any) => worker?.isOnline === true);
      if (anyOnline) return true;
    }
    await delay(pollMs);
  }
  return false;
}

function parseJobFailureSummary(job: Record<string, unknown>): string {
  const rawError = typeof job.error === "string" ? job.error : "";
  if (!rawError) return "unknown error";
  try {
    const parsed = JSON.parse(rawError) as Record<string, unknown>;
    const message = String(parsed.message ?? "").trim();
    const detail = String(parsed.detail ?? "").trim();
    if (message && detail) return `${message}: ${detail}`;
    if (message) return message;
    if (detail) return detail;
  } catch {
    // Use raw error payload fallback.
  }
  return rawError.replace(/\s+/g, " ").trim();
}

type WarmupTerminalState = "completed" | "failed" | "timeout";

type WarmupTerminalResult = {
  state: WarmupTerminalState;
  summary: string;
  logTail: string[];
};

function isLikelyLlmReachabilityFailure(text: string): boolean {
  const value = text.toLowerCase();
  return (
    value.includes("could not reach llm endpoint") ||
    value.includes("llm endpoint") ||
    value.includes("connection refused") ||
    value.includes("timed out") ||
    value.includes("host.docker.internal") ||
    value.includes("model preflight failed") ||
    value.includes("api timeout")
  );
}

async function fetchWarmupJobLogTail(
  baseUrl: string,
  headers: Record<string, string>,
  jobId: string,
  limit = 60,
): Promise<string[]> {
  const url = `${baseUrl}/jobs/${encodeURIComponent(jobId)}/logs?limit=${Math.max(
    10,
    Math.min(500, Math.floor(limit)),
  )}`;
  const result = await startupFetchJson(url, { method: "GET", headers }, 4_000);
  if (!result.ok || !Array.isArray(result.json?.logs)) return [];
  return result.json.logs
    .map((row: any) => String(row?.message ?? "").trim())
    .filter((line: string) => line.length > 0);
}

async function emitStartupWarmupAlert(
  baseUrl: string,
  headers: Record<string, string>,
  sessionId: string,
  text: string,
): Promise<void> {
  const writeHeaders = {
    ...headers,
    "Content-Type": "application/json",
  };
  await startupFetchJson(
    `${baseUrl}/sessions`,
    {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ sessionId }),
    },
    3_000,
  );
  await startupFetchJson(
    `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/command`,
    {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        type: "assistant_message",
        from: "start:warmup",
        payload: { text },
      }),
    },
    4_000,
  );
}

async function probeWorkerLlmForWarmup(): Promise<string> {
  const targets = llmPreflightTargets();
  const workerTarget = targets.find((target) => target.name === "WorkerPal LLM");
  if (!workerTarget) return "WorkerPal LLM probe unavailable (no endpoint configured).";
  const check = await checkTargetReachable(workerTarget);
  if (check.ok) {
    const statusText = typeof check.status === "number" ? `HTTP ${check.status}` : "reachable";
    return `WorkerPal LLM probe: reachable via ${check.url ?? workerTarget.endpoint} (${statusText}).`;
  }
  return `WorkerPal LLM probe failed: ${check.error ?? "unreachable endpoint"} (${workerTarget.endpoint}).`;
}

async function waitForWarmupJobTerminal(
  baseUrl: string,
  headers: Record<string, string>,
  jobId: string,
  deadlineMs: number,
  pollMs: number,
): Promise<WarmupTerminalResult> {
  const jobsUrl = `${baseUrl}/jobs?status=all&limit=200`;
  while (Date.now() < deadlineMs) {
    const result = await startupFetchJson(jobsUrl, { method: "GET", headers }, 4_000);
    if (result.ok && Array.isArray(result.json?.jobs)) {
      const job = result.json.jobs.find(
        (row: any) => row && typeof row === "object" && String(row.id ?? "") === jobId,
      ) as Record<string, unknown> | undefined;
      if (job) {
        const status = String(job.status ?? "")
          .trim()
          .toLowerCase();
        if (status === "completed") {
          return {
            state: "completed",
            summary: `Startup warmup job ${jobId} completed.`,
            logTail: [],
          };
        }
        if (status === "failed") {
          const summary = parseJobFailureSummary(job);
          const logTail = await fetchWarmupJobLogTail(baseUrl, headers, jobId, 80);
          return {
            state: "failed",
            summary: `Startup warmup job ${jobId} failed: ${summary}`,
            logTail,
          };
        }
      }
    }
    await delay(pollMs);
  }
  const logTail = await fetchWarmupJobLogTail(baseUrl, headers, jobId, 80);
  return {
    state: "timeout",
    summary: `Startup warmup job did not reach a terminal state before timeout (jobId=${jobId}).`,
    logTail,
  };
}

async function runStartupWarmup(): Promise<void> {
  if (!startupWarmupEnabled()) {
    console.log("[start] Startup warmup disabled (startup.startup_warmup=false).");
    return;
  }

  const baseUrl = startupServerUrl();
  const timeoutMs = startupWarmupTimeoutMs();
  const pollMs = startupWarmupPollMs();
  const deadlineMs = Date.now() + timeoutMs;
  const readHeaders = startupAuthHeaders(false);
  const writeHeaders = startupAuthHeaders(true);

  console.log(`[start] Startup warmup enabled; probing ${baseUrl} (timeout ${timeoutMs}ms)...`);

  const serverReady = await waitForServerHealth(baseUrl, deadlineMs, pollMs);
  if (!serverReady) {
    console.warn("[start] Startup warmup skipped: server did not become healthy in time.");
    return;
  }

  const workerReady = await waitForOnlineWorker(baseUrl, readHeaders, deadlineMs, pollMs);
  if (!workerReady) {
    console.warn("[start] Startup warmup skipped: no online WorkerPal was detected in time.");
    return;
  }

  const warmupBody = {
    taskId: `startup-warmup-${Date.now().toString(36)}`,
    sessionId: startupWarmupSessionId(),
    kind: "warmup.execute",
    priority: "interactive",
    queueWaitBudgetMs: 20_000,
    executionBudgetMs: 60_000,
    finalizationBudgetMs: 15_000,
    params: {
      reason: "startup_warmup",
      startupWarmup: true,
      commit: false,
    },
  };

  const enqueue = await startupFetchJson(
    `${baseUrl}/jobs/enqueue`,
    {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(warmupBody),
    },
    5_000,
  );

  const jobId = typeof enqueue.json?.jobId === "string" ? enqueue.json.jobId : "";
  if (!enqueue.ok || !enqueue.json?.ok || !jobId) {
    const reason = enqueue.text || enqueue.json?.message || `HTTP ${enqueue.status}`;
    console.warn(`[start] Startup warmup enqueue failed: ${reason}`);
    return;
  }

  console.log(`[start] Enqueued startup warmup job ${jobId} (warm path, no commit).`);
  const terminal = await waitForWarmupJobTerminal(baseUrl, readHeaders, jobId, deadlineMs, pollMs);
  if (terminal.state === "completed") {
    console.log(`[start] ${terminal.summary}`);
    return;
  }

  const llmProbe = await probeWorkerLlmForWarmup();
  console.warn(`[start] ${terminal.summary}`);
  console.warn(`[start] ${llmProbe}`);
  if (terminal.logTail.length > 0) {
    const tail = terminal.logTail.slice(-12);
    console.warn("[start] Warmup log tail:");
    for (const line of tail) {
      console.warn(`[start]   ${line}`);
    }
  }

  const combined = `${terminal.summary}\n${llmProbe}\n${terminal.logTail.join("\n")}`.slice(0, 12_000);
  const likelyLlmIssue = isLikelyLlmReachabilityFailure(combined);
  const alert = likelyLlmIssue
    ? `${terminal.summary} Likely cause: WorkerPal LLM endpoint is unavailable or timing out. ${llmProbe}`
    : `${terminal.summary} ${llmProbe}`;
  try {
    await emitStartupWarmupAlert(baseUrl, writeHeaders, startupWarmupSessionId(), alert);
  } catch (err) {
    console.warn(`[start] Failed to emit warmup alert to session stream: ${String(err)}`);
  }
}

function collectFilesForHash(rootPath: string, out: string[]): void {
  if (!existsSync(rootPath)) return;

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(rootPath);
  } catch {
    return;
  }

  if (stat.isFile()) {
    out.push(rootPath);
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(rootPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (WORKER_IMAGE_HASH_IGNORE_DIRS.has(entry)) continue;
    collectFilesForHash(resolve(rootPath, entry), out);
  }
}

function computeWorkerImageInputsHash(): string {
  const files: string[] = [];
  for (const relPath of WORKER_IMAGE_INPUT_PATHS) {
    collectFilesForHash(resolve(repoRoot, relPath), files);
  }

  const normalizedFiles = files
    .map((filePath) => relative(repoRoot, filePath).replace(/\\/g, "/"))
    .sort((a, b) => a.localeCompare(b));

  const hash = createHash("sha256");
  for (const relPath of normalizedFiles) {
    hash.update(relPath);
    hash.update("\n");
    try {
      hash.update(readFileSync(resolve(repoRoot, relPath)));
    } catch {
      // If a file disappears during hashing, include marker and continue.
      hash.update("__MISSING__");
    }
    hash.update("\n");
  }

  return hash.digest("hex");
}

async function dockerImageInputsHash(image: string): Promise<string | null> {
  const inspect = await runCapture([
    "docker",
    "image",
    "inspect",
    "--format",
    `{{ index .Config.Labels "${WORKER_IMAGE_INPUTS_HASH_LABEL}" }}`,
    image,
  ]);
  if (!inspect.ok) return null;
  const value = inspect.stdout.trim();
  if (!value || value === "<no value>") return null;
  return value;
}

function parseDockerIdList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizePathForCompare(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function collectWorkerWarmContainersForRepo(): Promise<string[]> {
  const candidateIds = new Set<string>();
  const repoNeedle = normalizePathForCompare(repoRoot);

  const labeled = await runCapture([
    "docker",
    "ps",
    "-aq",
    "--filter",
    "label=pushpals.component=workerpals-warm",
  ]);
  if (labeled.ok) {
    for (const id of parseDockerIdList(labeled.stdout)) {
      candidateIds.add(id);
    }
  }

  const byName = await runCapture(["docker", "ps", "-aq", "--filter", "name=pushpals-workerpal-"]);
  if (byName.ok) {
    for (const id of parseDockerIdList(byName.stdout)) {
      candidateIds.add(id);
    }
  }

  const matchedIds = new Set<string>();
  for (const id of candidateIds) {
    const inspected = await runCapture([
      "docker",
      "inspect",
      "-f",
      '{{.Name}}||{{index .Config.Labels "pushpals.repo"}}||{{range .Mounts}}{{.Source}};;{{end}}',
      id,
    ]);
    if (!inspected.ok) continue;

    const [namePart, labeledRepo = "", mountsPart = ""] = inspected.stdout.split("||", 3);
    const containerName = namePart.trim().replace(/^\//, "");
    if (!containerName.startsWith("pushpals-workerpal-") || !containerName.endsWith("-warm")) {
      continue;
    }

    const normalizedLabeledRepo = normalizePathForCompare(labeledRepo.trim());
    if (normalizedLabeledRepo && normalizedLabeledRepo === repoNeedle) {
      matchedIds.add(id);
      continue;
    }

    const hasRepoMount = mountsPart
      .split(";;")
      .map((source) => normalizePathForCompare(source.trim()))
      .filter(Boolean)
      .some((source) => source === repoNeedle || source.startsWith(`${repoNeedle}/`));
    if (hasRepoMount) {
      matchedIds.add(id);
    }
  }

  return Array.from(matchedIds);
}

async function cleanupWorkerWarmContainers(reason: string): Promise<void> {
  const ids = await collectWorkerWarmContainersForRepo();
  if (ids.length === 0) return;

  let removed = 0;
  for (const id of ids) {
    if ((await runQuiet(["docker", "rm", "-f", id])) === 0) {
      removed += 1;
    }
  }

  if (removed > 0) {
    console.log(`[start] Removed ${removed} WorkerPals warm container(s) (${reason}).`);
  }
  const failed = ids.length - removed;
  if (failed > 0) {
    console.warn(
      `[start] Failed to remove ${failed} WorkerPals warm container(s) during ${reason}.`,
    );
  }
}

async function git(args: string[]): Promise<CmdResult> {
  return runCapture(["git", ...args], repoRoot);
}

async function cleanLegacyLocalBranchesIfRequested(): Promise<void> {
  if (!startOptions.clean) return;

  const patterns = ["refs/heads/agent/workerpal-", "refs/heads/_source_control_manager/local"];
  const branches = new Set<string>();

  for (const pattern of patterns) {
    const list = await git(["for-each-ref", "--format=%(refname:short)", pattern]);
    if (!list.ok || !list.stdout) continue;
    for (const line of list.stdout.split(/\r?\n/)) {
      const branch = line.trim();
      if (branch) branches.add(branch);
    }
  }

  if (branches.size === 0) return;

  let removed = 0;
  for (const branch of branches) {
    const del = await git(["branch", "-D", branch]);
    if (del.ok) {
      removed += 1;
      continue;
    }
    const details = del.stderr || del.stdout;
    console.warn(`[start] Clean run: could not delete legacy branch ${branch}: ${details}`);
  }

  if (removed > 0) {
    console.log(`[start] Clean run: removed ${removed} legacy local PushPals branch(es).`);
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolveAnswer) => {
    rl.question(`${question} [y/N]: `, (value) => resolveAnswer(value));
  });
  rl.close();
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function ensureGitHubAuth(force = false): Promise<void> {
  const skipCheck = envTruthy("PUSHPALS_SKIP_GH_AUTH_CHECK");
  const sourceControlManagerPushDisabled = envTruthy("SOURCE_CONTROL_MANAGER_NO_PUSH");
  if (!force && (skipCheck || sourceControlManagerPushDisabled)) {
    return;
  }

  const gitToken = CONFIG.gitToken;
  if (gitToken) {
    process.env.PUSHPALS_GIT_TOKEN = gitToken;
    return;
  }

  const ghAvailable = (await runQuiet(["gh", "--version"])) === 0;
  if (ghAvailable) {
    const ghAuthed = (await runQuiet(["gh", "auth", "status"])) === 0;
    if (ghAuthed) return;

    console.log("[start] GitHub CLI is not authenticated. Starting `gh auth login`...");
    const loginExitCode = await runInherited(["gh", "auth", "login"]);
    if (loginExitCode !== 0) {
      console.error("[start] `gh auth login` failed.");
      abortStart(loginExitCode);
    }

    const ghAuthedAfterLogin = (await runQuiet(["gh", "auth", "status"])) === 0;
    if (!ghAuthedAfterLogin) {
      console.error("[start] GitHub CLI is still not authenticated after login.");
      abortStart(1);
    }
    return;
  }

  console.error("[start] SourceControlManager push is enabled but no GitHub auth is configured.");
  console.error("[start] Provide one of: PUSHPALS_GIT_TOKEN, GITHUB_TOKEN, GH_TOKEN.");
  console.error(
    "[start] Or install GitHub CLI (`gh`) for interactive login, or disable push via SOURCE_CONTROL_MANAGER_NO_PUSH=1.",
  );
  abortStart(1);
}

async function ensureIntegrationBranch(): Promise<void> {
  const fetchResult = await git(["fetch", "origin", "--prune", "--quiet"]);
  if (!fetchResult.ok) {
    console.error("[start] Failed to fetch remote refs before integration-branch precheck.");
    console.error(fetchResult.stderr || fetchResult.stdout);
    abortStart(fetchResult.exitCode || 1);
  }

  const remoteExists = await git([
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${INTEGRATION_REMOTE_REF}`,
  ]);
  if (remoteExists.ok) {
    const localExists = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${INTEGRATION_BRANCH}`,
    ]);
    if (!localExists.ok) {
      const createLocal = await git(["branch", "-f", INTEGRATION_BRANCH, INTEGRATION_REMOTE_REF]);
      if (!createLocal.ok) {
        console.error(
          `[start] Failed to create local ${INTEGRATION_BRANCH} from ${INTEGRATION_REMOTE_REF}.`,
        );
        console.error(createLocal.stderr || createLocal.stdout);
        abortStart(createLocal.exitCode || 1);
      }
    }

    const setUpstream = await git([
      "branch",
      "--set-upstream-to",
      INTEGRATION_BASE_REMOTE_REF,
      INTEGRATION_BRANCH,
    ]);
    if (!setUpstream.ok) {
      console.error(
        `[start] Failed to set upstream for ${INTEGRATION_BRANCH} to ${INTEGRATION_BASE_REMOTE_REF}.`,
      );
      console.error(setUpstream.stderr || setUpstream.stdout);
      abortStart(setUpstream.exitCode || 1);
    }

    process.env.WORKERPALS_BASE_REF = process.env.WORKERPALS_BASE_REF ?? INTEGRATION_REMOTE_REF;
    return;
  }

  console.warn(`[start] Required branch ${INTEGRATION_REMOTE_REF} does not exist on remote.`);
  const autoCreate =
    CONFIG.sourceControlManager.autoCreateMainBranch ||
    envTruthy("PUSHPALS_AUTO_CREATE_INTEGRATION_BRANCH");

  let approved = autoCreate;
  if (!approved) {
    approved = await promptYesNo(
      `Create ${INTEGRATION_BRANCH} from ${INTEGRATION_BASE_REMOTE_REF} and push it to origin now?`,
    );
  }

  if (!approved) {
    console.error(
      `[start] Cannot continue without ${INTEGRATION_REMOTE_REF}. Create it on the remote repo, then rerun.`,
    );
    abortStart(1);
  }

  await ensureGitHubAuth(true);

  const ensureLocalBranch = await git([
    "branch",
    "-f",
    INTEGRATION_BRANCH,
    INTEGRATION_BASE_REMOTE_REF,
  ]);
  if (!ensureLocalBranch.ok) {
    console.error(
      `[start] Failed to create local ${INTEGRATION_BRANCH} from ${INTEGRATION_BASE_REMOTE_REF}.`,
    );
    console.error(ensureLocalBranch.stderr || ensureLocalBranch.stdout);
    abortStart(ensureLocalBranch.exitCode || 1);
  }

  const setUpstream = await git([
    "branch",
    "--set-upstream-to",
    INTEGRATION_BASE_REMOTE_REF,
    INTEGRATION_BRANCH,
  ]);
  if (!setUpstream.ok) {
    console.error(
      `[start] Failed to set upstream for ${INTEGRATION_BRANCH} to ${INTEGRATION_BASE_REMOTE_REF}.`,
    );
    console.error(setUpstream.stderr || setUpstream.stdout);
    abortStart(setUpstream.exitCode || 1);
  }

  const pushResult = await git([
    "push",
    "origin",
    `refs/heads/${INTEGRATION_BRANCH}:refs/heads/${INTEGRATION_BRANCH}`,
  ]);
  if (!pushResult.ok) {
    console.error(`[start] Failed to push ${INTEGRATION_BRANCH} to origin.`);
    console.error(pushResult.stderr || pushResult.stdout);
    console.error(
      `[start] Cannot continue unless ${INTEGRATION_REMOTE_REF} exists on the remote repository.`,
    );
    abortStart(pushResult.exitCode || 1);
  }

  const refresh = await git(["fetch", "origin", INTEGRATION_BRANCH, "--quiet"]);
  if (!refresh.ok) {
    console.warn(
      `[start] Created ${INTEGRATION_BRANCH}, but refresh fetch failed: ${refresh.stderr || refresh.stdout}`,
    );
  }

  process.env.WORKERPALS_BASE_REF = process.env.WORKERPALS_BASE_REF ?? INTEGRATION_REMOTE_REF;
  console.log(`[start] Ready: ${INTEGRATION_REMOTE_REF} exists and workers will base from it.`);
}

async function ensureSourceControlManagerWorktree(): Promise<void> {
  const repoPath = resolve(CONFIG.sourceControlManager.repoPath);

  if (repoPath === repoRoot) {
    console.error(
      "[start] SOURCE_CONTROL_MANAGER_REPO_PATH points to the primary workspace. Refusing to run SourceControlManager in-place.",
    );
    console.error(
      "[start] Set SOURCE_CONTROL_MANAGER_REPO_PATH to a dedicated worktree path, or unset it to use the default.",
    );
    abortStart(1);
  }

  const isGitRepo = await runCapture(
    ["git", "-C", repoPath, "rev-parse", "--is-inside-work-tree"],
    repoRoot,
  );
  if (!isGitRepo.ok) {
    mkdirSync(resolve(repoPath, ".."), { recursive: true });

    const pruneResult = await git(["worktree", "prune"]);
    if (!pruneResult.ok) {
      console.warn(
        `[start] Could not prune stale worktree metadata before creating ${repoPath}: ${pruneResult.stderr || pruneResult.stdout}`,
      );
    }

    const seedCandidates = [
      INTEGRATION_REMOTE_REF,
      INTEGRATION_BRANCH,
      INTEGRATION_BASE_REMOTE_REF,
      "HEAD",
    ];
    let seedRef = "HEAD";
    for (const ref of seedCandidates) {
      const exists = await git(["rev-parse", "--verify", "--quiet", ref]);
      if (exists.ok) {
        seedRef = ref;
        break;
      }
    }

    let addResult = await git(["worktree", "add", "--detach", repoPath, seedRef]);
    if (!addResult.ok) {
      const detail = `${addResult.stderr}\n${addResult.stdout}`.toLowerCase();
      if (detail.includes("already registered worktree")) {
        await git(["worktree", "prune"]);
        addResult = await git(["worktree", "add", "--force", "--detach", repoPath, seedRef]);
      }
    }

    if (!addResult.ok) {
      console.error(
        `[start] Failed to create SourceControlManager worktree at ${repoPath} from ${seedRef}: ${addResult.stderr || addResult.stdout}`,
      );
      abortStart(addResult.exitCode || 1);
    }
    console.log(`[start] Created SourceControlManager worktree: ${repoPath}`);
  }

  process.env.SOURCE_CONTROL_MANAGER_REPO_PATH = repoPath;
}

async function ensureIntegrationBranchUpToDateWithMain(): Promise<void> {
  if (!syncIntegrationWithMainEnabled()) {
    console.log("[start] Skipping integration-branch sync with main (disabled by env).");
    return;
  }

  await ensureGitHubAuth(true);

  const repoPath = resolve(CONFIG.sourceControlManager.repoPath);
  if (!repoPath) {
    console.error(
      "[start] SourceControlManager worktree is not configured; cannot sync integration branch with main.",
    );
    abortStart(1);
  }

  const gitInScm = (args: string[]) => runCapture(["git", ...args], repoPath);
  const integrationRemoteTrackingRef = `refs/remotes/${INTEGRATION_REMOTE_REF}`;
  const baseRemoteTrackingRef = `refs/remotes/${INTEGRATION_BASE_REMOTE_REF}`;
  const syncBranch = `_source_control_manager/start-sync-${Date.now().toString(36)}`;
  let checkoutCreated = false;

  console.log(
    `[start] Syncing ${INTEGRATION_REMOTE_REF} with ${INTEGRATION_BASE_REMOTE_REF} before launching RemoteBuddy...`,
  );

  const status = await gitInScm(["status", "--porcelain"]);
  if (!status.ok) {
    console.error(
      "[start] Failed to read SourceControlManager worktree status before branch sync.",
    );
    console.error(status.stderr || status.stdout);
    abortStart(status.exitCode || 1);
  }
  if (status.stdout) {
    console.error(
      `[start] SourceControlManager worktree is not clean (${repoPath}). Resolve local changes before startup.`,
    );
    abortStart(1);
  }

  const fetch = await gitInScm([
    "fetch",
    "origin",
    INTEGRATION_BRANCH,
    INTEGRATION_BASE_BRANCH,
    "--prune",
    "--quiet",
  ]);
  if (!fetch.ok) {
    console.error("[start] Failed to fetch remote refs before integration/main sync.");
    console.error(fetch.stderr || fetch.stdout);
    abortStart(fetch.exitCode || 1);
  }

  for (const ref of [integrationRemoteTrackingRef, baseRemoteTrackingRef]) {
    const exists = await gitInScm(["rev-parse", "--verify", "--quiet", ref]);
    if (!exists.ok) {
      console.error(`[start] Missing required ref for startup sync: ${ref}`);
      abortStart(1);
    }
  }

  const baseAlreadyIncluded = await gitInScm([
    "merge-base",
    "--is-ancestor",
    baseRemoteTrackingRef,
    integrationRemoteTrackingRef,
  ]);
  if (baseAlreadyIncluded.ok) {
    console.log(
      `[start] ${INTEGRATION_REMOTE_REF} is already up to date with ${INTEGRATION_BASE_REMOTE_REF}.`,
    );
    return;
  }

  const integrationBehindBase = await gitInScm([
    "merge-base",
    "--is-ancestor",
    integrationRemoteTrackingRef,
    baseRemoteTrackingRef,
  ]);

  const checkout = await gitInScm(["checkout", "-B", syncBranch, integrationRemoteTrackingRef]);
  if (!checkout.ok) {
    console.error(`[start] Failed to create sync branch ${syncBranch}.`);
    console.error(checkout.stderr || checkout.stdout);
    abortStart(checkout.exitCode || 1);
  }
  checkoutCreated = true;
  try {
    if (integrationBehindBase.ok) {
      const pullFfOnly = await gitInScm(["pull", "--ff-only", "origin", INTEGRATION_BASE_BRANCH]);
      if (!pullFfOnly.ok) {
        console.error(
          `[start] Failed to fast-forward ${INTEGRATION_BRANCH} from ${INTEGRATION_BASE_REMOTE_REF}.`,
        );
        console.error(pullFfOnly.stderr || pullFfOnly.stdout);
        abortStart(pullFfOnly.exitCode || 1);
      }
    } else {
      const merge = await runCapture(
        [
          "git",
          "-c",
          `user.name=${START_SYNC_GIT_USER_NAME}`,
          "-c",
          `user.email=${START_SYNC_GIT_USER_EMAIL}`,
          "merge",
          "--no-ff",
          "--no-edit",
          baseRemoteTrackingRef,
        ],
        repoPath,
      );
      if (!merge.ok) {
        await gitInScm(["merge", "--abort"]);
        console.error(
          `[start] Failed to merge ${INTEGRATION_BASE_REMOTE_REF} into ${INTEGRATION_BRANCH}.`,
        );
        console.error(merge.stderr || merge.stdout);
        abortStart(merge.exitCode || 1);
      }
    }

    const push = await gitInScm(["push", "origin", `HEAD:refs/heads/${INTEGRATION_BRANCH}`]);
    if (!push.ok) {
      console.error(
        `[start] Failed to push synced ${INTEGRATION_BRANCH} branch to origin after startup merge/pull.`,
      );
      console.error(push.stderr || push.stdout);
      abortStart(push.exitCode || 1);
    }

    const refresh = await gitInScm(["fetch", "origin", INTEGRATION_BRANCH, "--quiet"]);
    if (!refresh.ok) {
      console.error("[start] Failed to refresh integration branch after startup sync push.");
      console.error(refresh.stderr || refresh.stdout);
      abortStart(refresh.exitCode || 1);
    }

    console.log(
      `[start] Synced ${INTEGRATION_REMOTE_REF} with ${INTEGRATION_BASE_REMOTE_REF} successfully.`,
    );
  } finally {
    if (checkoutCreated) {
      await gitInScm(["checkout", "--detach", integrationRemoteTrackingRef]);
      await gitInScm(["branch", "-D", syncBranch]);
    }
  }
}

async function ensureDockerImage(): Promise<void> {
  const dockerAvailable = (await runQuiet(["docker", "version"])) === 0;
  if (!dockerAvailable) {
    console.error("[start] Docker is required for `bun run start` but is not available.");
    abortStart(1);
  }

  const rebuildMode = workerImageRebuildMode();
  const imageExists = (await runQuiet(["docker", "image", "inspect", workerImage])) === 0;
  if (imageExists && rebuildMode === "never") {
    console.log(`[start] Worker image rebuild disabled; using ${workerImage} as-is.`);
    return;
  }

  let currentInputsHash: string | null = null;
  const getCurrentInputsHash = (): string => {
    if (!currentInputsHash) currentInputsHash = computeWorkerImageInputsHash();
    return currentInputsHash;
  };
  const existingInputsHash =
    imageExists && rebuildMode === "auto" ? await dockerImageInputsHash(workerImage) : null;

  let shouldBuild = !imageExists;
  let buildReason = "";

  if (!imageExists) {
    buildReason = `Worker image not found: ${workerImage}`;
  } else if (rebuildMode === "always") {
    shouldBuild = true;
    buildReason = "Worker image rebuild forced by startup.worker_image_rebuild=always";
  } else if (rebuildMode === "auto") {
    const currentHash = getCurrentInputsHash();
    if (!existingInputsHash) {
      shouldBuild = true;
      buildReason = "Worker image is missing inputs hash label; rebuilding to enable auto-refresh";
    } else if (existingInputsHash !== currentHash) {
      shouldBuild = true;
      buildReason = `Worker image inputs changed (${existingInputsHash.slice(0, 12)} -> ${currentHash.slice(0, 12)})`;
    }
  }

  if (!shouldBuild) {
    console.log(`[start] Worker image is up to date: ${workerImage}`);
    return;
  }

  console.log(`[start] ${buildReason}`);
  console.log("[start] Building worker image...");

  const buildExitCode = await runInherited(
    [
      "docker",
      "build",
      "-f",
      "apps/workerpals/Dockerfile.sandbox",
      "--label",
      `${WORKER_IMAGE_INPUTS_HASH_LABEL}=${getCurrentInputsHash()}`,
      "-t",
      workerImage,
      ".",
    ],
    repoRoot,
  );

  if (buildExitCode !== 0) {
    console.error(`[start] Failed to build worker image (${workerImage}).`);
    abortStart(buildExitCode);
  }
}

let shuttingDown = false;
let proc: ReturnType<typeof Bun.spawn> | null = null;
const shutdown = async (code: number) => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    proc?.kill();
  } catch {}
  await cleanupWorkerWarmContainers("shutdown");
  await stopManagedLmStudio();
  process.exit(code);
};

process.on("SIGINT", () => {
  void shutdown(130);
});
process.on("SIGTERM", () => {
  void shutdown(143);
});

try {
  cleanRuntimeStateIfRequested();
  sanitizeWindowsWatcherPaths();
  await cleanupWorkerWarmContainers("startup preflight");
  await ensureLlmPreflight();
  await ensureIntegrationBranch();
  await cleanLegacyLocalBranchesIfRequested();
  await ensureGitHubAuth();
  await ensureSourceControlManagerWorktree();
  await ensureIntegrationBranchUpToDateWithMain();
  await ensureDockerImage();
} catch (err) {
  await cleanupWorkerWarmContainers("startup failure");
  await stopManagedLmStudio();
  if (err instanceof StartAbort) {
    process.exit(err.exitCode);
  }
  console.error(`[start] Unexpected startup failure: ${String(err)}`);
  process.exit(1);
}

proc = Bun.spawn(["bun", "run", "dev:full"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const startupWarmupPromise = runStartupWarmup().catch((err) => {
  console.warn(`[start] Startup warmup failed: ${String(err)}`);
});

const exitCode = await proc.exited;
await Promise.race([
  startupWarmupPromise,
  new Promise((resolveWait) => setTimeout(resolveWait, 500)),
]);
await cleanupWorkerWarmContainers("dev:full exit");
await stopManagedLmStudio();
process.exit(exitCode);
