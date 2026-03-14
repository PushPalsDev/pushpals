#!/usr/bin/env bun
/**
 * Stable start entrypoint.
 *
 * `bun run start` can be invoked with accidental extra CLI flags (e.g. `-c`)
 * from shell wrappers. This wrapper intentionally ignores forwarded args and
 * always launches the configured managed service set with the canonical
 * script options.
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

import {
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { createHash } from "crypto";
import { createServer } from "net";
import { dirname, isAbsolute, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { format } from "util";
import {
  loadPushPalsConfig,
  sanitizePushPalsConfigForLogging,
} from "../packages/shared/src/config.js";
import { loadLocalBuddyRuntimeSnapshotFromFiles } from "../packages/shared/src/localbuddy_runtime.js";
import {
  extraLocalKeys,
  missingTemplateKeys,
  readDotEnvKeys,
  readTomlLeafKeys,
} from "../packages/shared/src/config_template_parity.js";
import { validateVisionDocStructure } from "../packages/shared/src/vision.js";
import {
  buildCoreManagedServiceSpecs,
  computeLocalBuddyRestartBackoffMs,
  resolveLocalBuddyRuntimeAction,
  resolveLocalBuddyStartGate,
  type ManagedServiceSpec,
} from "./start_runtime_services.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const CONFIG = loadPushPalsConfig({ projectRoot: repoRoot });

const DEFAULT_IMAGE = "pushpals-worker-sandbox:latest";
const DEFAULT_LMSTUDIO_ENDPOINT = "http://127.0.0.1:1234";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/chat";
const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
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
const SYSTEM_LOG_PATH = resolve(repoRoot, "system.log");
const SYSTEM_LOG_TAIL_POLL_MS = 250;
const SYSTEM_LOG_TAIL_READ_CHUNK_BYTES = 64 * 1024;
const LOCALBUDDY_ENABLED = CONFIG.localbuddy.enabled;
const LOCALBUDDY_RUNTIME_CONFIG_POLL_MS = 2_000;
const LOCALBUDDY_STABLE_UPTIME_MS = 10_000;
const LOCALBUDDY_MAX_CONSECUTIVE_FAILURES = 5;
const ANSI_RESET = "\u001b[0m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_MAGENTA = "\u001b[35m";
const ANSI_RED = "\u001b[31m";
const ANSI_BRIGHT_RED = "\u001b[1;31m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_BLUE = "\u001b[34m";
const ANSI_BRIGHT_WHITE = "\u001b[97m";

const systemLogStream = createWriteStream(SYSTEM_LOG_PATH, { flags: "w" });

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let consolePassthroughEnabled = true;
let systemLogWriteFailed = false;
let systemLogTailUsesAnsi = false;

const SYSTEM_LOG_COMPONENT_COLOR_BY_TAG = new Map<string, string>([
  ["server", ANSI_CYAN],
  ["localbuddy", ANSI_MAGENTA],
  ["remotebuddy", ANSI_RED],
  ["workerpals", ANSI_YELLOW],
  ["source_control_manager", ANSI_GREEN],
  ["client", ANSI_BLUE],
  ["start", ANSI_BRIGHT_WHITE],
]);

const SYSTEM_LOG_ERROR_PATTERN =
  /\b(error|failed|fatal|panic|exception|traceback|eacces|sqlite_busy|epipe|econnreset)\b/i;
const SYSTEM_LOG_WARN_PATTERN = /\b(warn|warning)\b/i;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/;
const SYSTEM_LOG_PREFIX_PATTERN = /^((?:\[[^\]\r\n]+\]\s*)+)(.*)$/;
const SYSTEM_LOG_TAG_PATTERN = /\[[^\]\r\n]+\]/g;

function shouldUseAnsiColors(): boolean {
  const forceColor = (process.env.FORCE_COLOR ?? "").trim();
  if (forceColor === "0") return false;
  if (forceColor.length > 0) return true;
  if (process.env.NO_COLOR !== undefined) return false;
  if (!process.stdout.isTTY) return false;
  const term = (process.env.TERM ?? "").trim().toLowerCase();
  if (term === "dumb") return false;
  return true;
}

function colorizeSystemLogLine(line: string): string {
  if (!systemLogTailUsesAnsi) return line;
  if (!line) return line;
  if (ANSI_ESCAPE_PATTERN.test(line)) return line;

  const prefixMatch = line.match(SYSTEM_LOG_PREFIX_PATTERN);
  if (!prefixMatch) return line;

  const prefix = prefixMatch[1] ?? "";
  const remainder = prefixMatch[2] ?? "";
  const tags = prefix.match(SYSTEM_LOG_TAG_PATTERN) ?? [];
  if (tags.length === 0) return line;

  let color: string | null = null;
  for (const tag of tags) {
    const tagText = tag.slice(1, -1).trim().toLowerCase();
    const componentColor = SYSTEM_LOG_COMPONENT_COLOR_BY_TAG.get(tagText);
    if (componentColor) {
      color = componentColor;
      break;
    }
  }
  if (!color && SYSTEM_LOG_ERROR_PATTERN.test(line)) {
    color = ANSI_BRIGHT_RED;
  }
  if (!color && SYSTEM_LOG_WARN_PATTERN.test(line)) {
    color = ANSI_YELLOW;
  }
  if (!color) return line;

  const colorizedPrefix = prefix.replace(
    SYSTEM_LOG_TAG_PATTERN,
    (tag) => `${color}${tag}${ANSI_RESET}`,
  );
  return `${colorizedPrefix}${remainder}`;
}

function writeSystemLog(chunk: string | Uint8Array): void {
  if (systemLogStream.destroyed) return;
  try {
    systemLogStream.write(chunk);
  } catch (err) {
    if (!systemLogWriteFailed) {
      systemLogWriteFailed = true;
      originalConsole.error(`[start] Failed to write system.log: ${String(err)}`);
    }
  }
}

function mirrorConsole(level: "log" | "info" | "warn" | "error", args: unknown[]): void {
  const message = format(...args);
  writeSystemLog(`${message}\n`);
  if (consolePassthroughEnabled) {
    originalConsole[level](...args);
  }
}

console.log = (...args: unknown[]) => mirrorConsole("log", args);
console.info = (...args: unknown[]) => mirrorConsole("info", args);
console.warn = (...args: unknown[]) => mirrorConsole("warn", args);
console.error = (...args: unknown[]) => mirrorConsole("error", args);

function relSystemLogPath(): string {
  const rel = relative(repoRoot, SYSTEM_LOG_PATH);
  return rel ? rel.replace(/\\/g, "/") : "system.log";
}

type SystemLogTailHandle = {
  stop: () => void;
};

function createSystemLogTail(pathValue: string): SystemLogTailHandle {
  let readOffset = 0;
  let pendingLine = "";
  let decoder = new TextDecoder();
  try {
    readOffset = statSync(pathValue).size;
  } catch {
    readOffset = 0;
  }

  const writeDecoded = (text: string, flush = false): void => {
    if (text) pendingLine += text;
    const parts = pendingLine.split(/\r\n|\n|\r/);
    pendingLine = parts.pop() ?? "";
    for (const line of parts) {
      process.stdout.write(`${colorizeSystemLogLine(line)}\n`);
    }
    if (flush && pendingLine) {
      process.stdout.write(`${colorizeSystemLogLine(pendingLine)}\n`);
      pendingLine = "";
    }
  };

  const drain = (): void => {
    let size = 0;
    try {
      size = statSync(pathValue).size;
    } catch {
      return;
    }
    if (size < readOffset) {
      readOffset = 0;
      pendingLine = "";
      decoder = new TextDecoder();
    }
    if (size === readOffset) return;

    const fd = openSync(pathValue, "r");
    try {
      let remaining = size - readOffset;
      while (remaining > 0) {
        const chunkSize = Math.min(remaining, SYSTEM_LOG_TAIL_READ_CHUNK_BYTES);
        const buffer = Buffer.allocUnsafe(chunkSize);
        const bytesRead = readSync(fd, buffer, 0, chunkSize, readOffset);
        if (bytesRead <= 0) break;
        readOffset += bytesRead;
        remaining -= bytesRead;
        writeDecoded(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
      }
    } finally {
      closeSync(fd);
    }
  };

  const timer = setInterval(drain, SYSTEM_LOG_TAIL_POLL_MS);
  return {
    stop: () => {
      clearInterval(timer);
      drain();
      writeDecoded(decoder.decode(), true);
    },
  };
}

let systemLogTail: SystemLogTailHandle | null = null;

function startSystemLogTail(): void {
  if (systemLogTail) return;
  systemLogTailUsesAnsi = shouldUseAnsiColors();
  systemLogTail = createSystemLogTail(SYSTEM_LOG_PATH);
  consolePassthroughEnabled = false;
}

function stopSystemLogTail(): void {
  if (systemLogTail) {
    systemLogTail.stop();
    systemLogTail = null;
  }
  consolePassthroughEnabled = true;
}

async function pipeProcStreamToSystemLog(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
): Promise<void> {
  if (!stream || typeof stream === "number" || typeof stream.getReader !== "function") return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        writeSystemLog(value);
      }
    }
  } catch {
    // best-effort stream piping
  } finally {
    reader.releaseLock();
  }
}

async function pipeProcStreamToOutputAndSystemLog(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  target: { write: (chunk: Uint8Array | string) => boolean },
): Promise<void> {
  if (!stream || typeof stream === "number" || typeof stream.getReader !== "function") return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        writeSystemLog(value);
        try {
          target.write(value);
        } catch {
          // best-effort terminal mirror
        }
      }
    }
  } catch {
    // best-effort stream piping
  } finally {
    reader.releaseLock();
  }
}

function formatManagedServiceLogPrefix(serviceName: string): string {
  const stamp = new Date().toTimeString().slice(0, 8);
  return `[${stamp}][${serviceName}]`;
}

async function pipeProcStreamToTaggedConsole(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  serviceName: string,
): Promise<void> {
  if (!stream || typeof stream === "number" || typeof stream.getReader !== "function") return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
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
        console.log(`${formatManagedServiceLogPrefix(serviceName)} ${trimmed}`);
      }
    }
    const tail = pending.trim();
    if (tail) {
      console.log(`${formatManagedServiceLogPrefix(serviceName)} ${tail}`);
    }
  } catch {
    // best-effort stream piping
  } finally {
    reader.releaseLock();
  }
}

async function closeSystemLog(): Promise<void> {
  stopSystemLogTail();
  if (systemLogStream.destroyed) return;
  await new Promise<void>((resolveClose) => {
    systemLogStream.end(() => resolveClose());
  });
}
const REQUIRED_DEPENDENCY_PROBES: Array<{
  label: string;
  fromDir: string;
  moduleSpecifier: string;
  retryWithHoisted: boolean;
}> = [
  {
    label: "TypeScript compiler",
    fromDir: resolve(repoRoot, "packages", "protocol"),
    moduleSpecifier: "typescript/bin/tsc",
    retryWithHoisted: true,
  },
  {
    label: "Expo runtime package",
    fromDir: resolve(repoRoot, "apps", "client"),
    moduleSpecifier: "expo/package.json",
    retryWithHoisted: true,
  },
  {
    label: "Server protocol workspace package",
    fromDir: resolve(repoRoot, "apps", "server"),
    moduleSpecifier: "protocol/package.json",
    retryWithHoisted: true,
  },
  {
    label: "LocalBuddy shared workspace package",
    fromDir: resolve(repoRoot, "apps", "localbuddy"),
    moduleSpecifier: "shared",
    retryWithHoisted: true,
  },
  {
    label: "RemoteBuddy shared workspace package",
    fromDir: resolve(repoRoot, "apps", "remotebuddy"),
    moduleSpecifier: "shared",
    retryWithHoisted: true,
  },
  {
    label: "WorkerPals shared workspace package",
    fromDir: resolve(repoRoot, "apps", "workerpals"),
    moduleSpecifier: "shared",
    retryWithHoisted: true,
  },
  {
    label: "SourceControlManager protocol workspace package",
    fromDir: resolve(repoRoot, "apps", "source_control_manager"),
    moduleSpecifier: "protocol/package.json",
    retryWithHoisted: true,
  },
  {
    label: "packages/shared protocol workspace package",
    fromDir: resolve(repoRoot, "packages", "shared"),
    moduleSpecifier: "protocol/package.json",
    retryWithHoisted: true,
  },
];

const ROOT_WORKSPACE_LINK_HEALTH_CHECKS: Array<{ path: string; label: string }> = [
  {
    path: resolve(repoRoot, "node_modules", "shared"),
    label: "node_modules/shared workspace link",
  },
  {
    path: resolve(repoRoot, "node_modules", "protocol"),
    label: "node_modules/protocol workspace link",
  },
  {
    path: resolve(repoRoot, "node_modules", "client"),
    label: "node_modules/client workspace link",
  },
];
const WORKSPACE_NODE_MODULES_HEALTH_CHECKS: Array<{
  nodeModulesPath: string;
  resolveFromDir: string;
  moduleSpecifier: string;
  label: string;
  moduleLabel: string;
}> = [
  {
    nodeModulesPath: resolve(repoRoot, "packages", "protocol", "node_modules"),
    resolveFromDir: resolve(repoRoot, "packages", "protocol"),
    moduleSpecifier: "typescript/bin/tsc",
    label: "packages/protocol node_modules",
    moduleLabel: "packages/protocol TypeScript compiler",
  },
  {
    nodeModulesPath: resolve(repoRoot, "apps", "client", "node_modules"),
    resolveFromDir: resolve(repoRoot, "apps", "client"),
    moduleSpecifier: "expo/package.json",
    label: "apps/client node_modules",
    moduleLabel: "apps/client Expo runtime package",
  },
  {
    nodeModulesPath: resolve(repoRoot, "apps", "server", "node_modules"),
    resolveFromDir: resolve(repoRoot, "apps", "server"),
    moduleSpecifier: "protocol/package.json",
    label: "apps/server node_modules",
    moduleLabel: "apps/server protocol workspace link",
  },
  {
    nodeModulesPath: resolve(repoRoot, "apps", "localbuddy", "node_modules"),
    resolveFromDir: resolve(repoRoot, "apps", "localbuddy"),
    moduleSpecifier: "shared",
    label: "apps/localbuddy node_modules",
    moduleLabel: "apps/localbuddy shared workspace link",
  },
  {
    nodeModulesPath: resolve(repoRoot, "apps", "remotebuddy", "node_modules"),
    resolveFromDir: resolve(repoRoot, "apps", "remotebuddy"),
    moduleSpecifier: "shared",
    label: "apps/remotebuddy node_modules",
    moduleLabel: "apps/remotebuddy shared workspace link",
  },
  {
    nodeModulesPath: resolve(repoRoot, "apps", "workerpals", "node_modules"),
    resolveFromDir: resolve(repoRoot, "apps", "workerpals"),
    moduleSpecifier: "shared",
    label: "apps/workerpals node_modules",
    moduleLabel: "apps/workerpals shared workspace link",
  },
  {
    nodeModulesPath: resolve(repoRoot, "apps", "source_control_manager", "node_modules"),
    resolveFromDir: resolve(repoRoot, "apps", "source_control_manager"),
    moduleSpecifier: "protocol/package.json",
    label: "apps/source_control_manager node_modules",
    moduleLabel: "apps/source_control_manager protocol workspace link",
  },
  {
    nodeModulesPath: resolve(repoRoot, "packages", "shared", "node_modules"),
    resolveFromDir: resolve(repoRoot, "packages", "shared"),
    moduleSpecifier: "protocol/package.json",
    label: "packages/shared node_modules",
    moduleLabel: "packages/shared protocol workspace link",
  },
];
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

function logEffectiveConfigSnapshot(): void {
  if (!CONFIG.startup.logConfigOnStart) {
    console.log("[start] Config snapshot logging disabled (startup.log_config_on_start=false).");
    return;
  }
  const sanitized = sanitizePushPalsConfigForLogging(CONFIG);
  console.log("[start] Effective config snapshot (sanitized):");
  console.log(JSON.stringify(sanitized, null, 2));
}

type SupportedLlmBackend = "lmstudio" | "ollama" | "openai" | "openai_codex";
type CodexAuthMode = "auto" | "api_key" | "chatgpt";

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

function toRepoRelativePosix(pathValue: string): string | null {
  const rel = relative(repoRoot, pathValue);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}

function isGitIgnoredPath(pathValue: string): boolean {
  const rel = toRepoRelativePosix(pathValue);
  if (!rel || rel === ".") return false;
  try {
    const result = Bun.spawnSync(["git", "check-ignore", "-q", rel], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function errorCode(err: unknown): string {
  return typeof (err as any)?.code === "string" ? (err as any).code : "";
}

function isRecoverableCleanError(err: unknown): boolean {
  const code = errorCode(err);
  return code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY";
}

function removeUnlockedChildrenBestEffort(pathValue: string): number {
  if (!existsSync(pathValue)) return 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(pathValue);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    const fullPath = resolve(pathValue, entry);
    try {
      rmSync(fullPath, { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort only
    }
  }
  return removed;
}

function removePathForClean(pathValue: string, label: string): void {
  if (!existsSync(pathValue)) {
    console.log(`[start] Clean run: no ${label} found at ${pathValue} (nothing to delete).`);
    return;
  }

  try {
    rmSync(pathValue, { recursive: true, force: true });
    console.log(`[start] Clean run: removed ${label} at ${pathValue}`);
    return;
  } catch (err) {
    const code = errorCode(err);
    const ignored = isGitIgnoredPath(pathValue);
    if (ignored || isRecoverableCleanError(err)) {
      const removedChildren = removeUnlockedChildrenBestEffort(pathValue);
      const parts = [
        `[start] Clean run: could not fully remove ${label} at ${pathValue}`,
        code ? `(code=${code})` : "",
        ignored ? "(gitignored path)" : "",
        removedChildren > 0
          ? `removed ${removedChildren} unlocked child entr${removedChildren === 1 ? "y" : "ies"}`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.warn(`${parts}; continuing.`);
      return;
    }
    throw err;
  }
}

type LocalConfigPaths = {
  localTomlPath: string;
  localTomlRel: string;
  localExampleTomlPath: string;
  localExampleTomlRel: string;
};

function quoteForPowerShell(value: string): string {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function quoteForBash(value: string): string {
  return `'${String(value ?? "").replace(/'/g, "'\\''")}'`;
}

function printTemplateCopyCommands(templateRel: string, targetRel: string): void {
  console.error(
    `[start]   Windows (PowerShell): Copy-Item -Force ${quoteForPowerShell(templateRel)} ${quoteForPowerShell(targetRel)}`,
  );
  console.error(
    `[start]   Linux/macOS (bash): cp -f ${quoteForBash(templateRel)} ${quoteForBash(targetRel)}`,
  );
}

function resolveLocalConfigPaths(): {
  localTomlPath: string;
  localTomlRel: string;
  localExampleTomlPath: string;
  localExampleTomlRel: string;
  usingLegacyLocalTomlFallback: boolean;
} {
  const configDirRel = relative(repoRoot, CONFIG.configDir).replace(/\\/g, "/");
  const normalizedConfigDirRel = configDirRel && configDirRel !== "." ? configDirRel : "configs";
  const localTomlRel = `${normalizedConfigDirRel}/local.toml`;
  const localExampleTomlRel = `${normalizedConfigDirRel}/local.example.toml`;
  const canonicalLocalTomlPath = resolve(CONFIG.configDir, "local.toml");
  const localExampleTomlPath = resolve(CONFIG.configDir, "local.example.toml");
  const legacyLocalTomlPath = resolve(repoRoot, "config", "local.toml");
  const usingLegacyLocalTomlFallback =
    canonicalLocalTomlPath !== legacyLocalTomlPath &&
    !existsSync(canonicalLocalTomlPath) &&
    existsSync(legacyLocalTomlPath);
  return {
    localTomlPath: usingLegacyLocalTomlFallback ? legacyLocalTomlPath : canonicalLocalTomlPath,
    localTomlRel,
    localExampleTomlPath,
    localExampleTomlRel,
    usingLegacyLocalTomlFallback,
  };
}

function ensureRequiredLocalConfigFiles(): LocalConfigPaths {
  const localConfigPaths = resolveLocalConfigPaths();
  const {
    localTomlPath,
    localTomlRel,
    localExampleTomlPath,
    localExampleTomlRel,
    usingLegacyLocalTomlFallback,
  } = localConfigPaths;

  if (usingLegacyLocalTomlFallback) {
    console.warn(
      `[start] Legacy local config detected at config/local.toml; migrate to ${localTomlRel} (legacy fallback will be removed in a future release).`,
    );
  }

  const required: Array<{ path: string; hint: string; windowsCopy: string; linuxCopy: string }> = [
    {
      path: resolve(repoRoot, ".env"),
      hint: "Create .env from .env.example and set your local secrets/wiring.",
      windowsCopy: "Copy-Item .env.example .env",
      linuxCopy: "cp .env.example .env",
    },
    {
      path: localTomlPath,
      hint: `Create ${localTomlRel} from ${localExampleTomlRel} for local overrides.`,
      windowsCopy: `Copy-Item ${localExampleTomlRel} ${localTomlRel}`,
      linuxCopy: `cp ${localExampleTomlRel} ${localTomlRel}`,
    },
  ];

  const missing = required.filter((entry) => !existsSync(entry.path));
  if (missing.length === 0) {
    return {
      localTomlPath,
      localTomlRel,
      localExampleTomlPath,
      localExampleTomlRel,
    };
  }

  console.error("[start] Missing required local config file(s):");
  for (const entry of missing) {
    const rel = relative(repoRoot, entry.path).replace(/\\/g, "/");
    console.error(`[start] - ${rel}`);
    console.error(`[start]   ${entry.hint}`);
    console.error(`[start]   Windows (PowerShell): ${entry.windowsCopy}`);
    console.error(`[start]   Linux/macOS (bash): ${entry.linuxCopy}`);
  }
  abortStart(1);
}

function ensureLocalConfigTemplateKeyParity(localConfigPaths: LocalConfigPaths): void {
  const envExamplePath = resolve(repoRoot, ".env.example");
  const envPath = resolve(repoRoot, ".env");
  const envExampleRel = relative(repoRoot, envExamplePath).replace(/\\/g, "/");
  const envRel = relative(repoRoot, envPath).replace(/\\/g, "/");
  const localExampleRel = relative(repoRoot, localConfigPaths.localExampleTomlPath).replace(
    /\\/g,
    "/",
  );

  const problems: Array<{
    label: string;
    templateLabel: string;
    missingKeys: string[];
    extraKeys: string[];
  }> = [];

  try {
    const envExampleKeys = readDotEnvKeys(envExamplePath);
    const envKeys = readDotEnvKeys(envPath);
    const missingEnvKeys = missingTemplateKeys(envExampleKeys, envKeys);
    const extraEnvKeys = extraLocalKeys(envExampleKeys, envKeys);
    if (missingEnvKeys.length > 0 || extraEnvKeys.length > 0) {
      problems.push({
        label: envRel,
        templateLabel: envExampleRel,
        missingKeys: missingEnvKeys,
        extraKeys: extraEnvKeys,
      });
    }
  } catch (err) {
    console.error(`[start] Local env key-parity preflight failed: ${String(err)}`);
    abortStart(1);
  }

  try {
    const localExampleKeys = readTomlLeafKeys(localConfigPaths.localExampleTomlPath);
    const localTomlKeys = readTomlLeafKeys(localConfigPaths.localTomlPath);
    const missingTomlKeys = missingTemplateKeys(localExampleKeys, localTomlKeys);
    const extraTomlKeys = extraLocalKeys(localExampleKeys, localTomlKeys);
    if (missingTomlKeys.length > 0 || extraTomlKeys.length > 0) {
      problems.push({
        label: localConfigPaths.localTomlRel,
        templateLabel: localExampleRel,
        missingKeys: missingTomlKeys,
        extraKeys: extraTomlKeys,
      });
    }
  } catch (err) {
    console.error(
      `[start] Local TOML key-parity preflight failed (${localExampleRel} vs ${localConfigPaths.localTomlRel}): ${String(err)}`,
    );
    abortStart(1);
  }

  if (problems.length === 0) return;

  console.error("[start] Template key-parity preflight failed:");
  for (const problem of problems) {
    let shouldPrintCopyCommands = false;
    if (problem.missingKeys.length > 0) {
      console.error(
        `[start] - ${problem.label} is missing ${problem.missingKeys.length} key(s) from ${problem.templateLabel}:`,
      );
      for (const key of problem.missingKeys) {
        console.error(`[start]   ${key}`);
      }
      shouldPrintCopyCommands = true;
    }
    if (problem.extraKeys.length > 0) {
      console.error(
        `[start] - ${problem.label} has ${problem.extraKeys.length} extra key(s) not present in ${problem.templateLabel}:`,
      );
      for (const key of problem.extraKeys) {
        console.error(`[start]   ${key}`);
      }
      shouldPrintCopyCommands = true;
    }
    if (shouldPrintCopyCommands) {
      console.error(
        `[start]   Quick template reset (overwrites ${problem.label}):`,
      );
      printTemplateCopyCommands(problem.templateLabel, problem.label);
    }
  }
  console.error(
    "[start] Keep local files in strict key parity with templates before startup.",
  );
  abortStart(1);
}

function ensureAutonomyVisionFile(): void {
  if (!CONFIG.remotebuddy.autonomy.enabled) return;

  const visionPath = resolve(repoRoot, "vision.md");
  const relVisionPath = relative(repoRoot, visionPath).replace(/\\/g, "/");
  if (!existsSync(visionPath)) {
    console.error(
      `[start] Missing required autonomy vision file: ${relVisionPath} (required when remotebuddy.autonomy.enabled=true).`,
    );
    console.error("[start]   Windows (PowerShell): Copy-Item vision.example.md vision.md");
    console.error("[start]   Linux/macOS (bash): cp vision.example.md vision.md");
    abortStart(1);
  }

  let visionRaw = "";
  try {
    visionRaw = readFileSync(visionPath, "utf8");
  } catch (err) {
    console.error(
      `[start] Autonomy vision preflight failed: could not read ${relVisionPath}: ${String(err)}`,
    );
    abortStart(1);
  }

  const visionText = visionRaw.trim();
  if (!visionText) {
    console.error(
      `[start] Autonomy vision preflight failed: ${relVisionPath} is empty. Add repository vision/goals before startup.`,
    );
    abortStart(1);
  }

  const validation = validateVisionDocStructure(visionText);
  if (!validation.ok) {
    console.error(
      `[start] Autonomy vision preflight failed: ${relVisionPath} must follow the required vision template structure.`,
    );
    for (const error of validation.errors) {
      console.error(`[start]   ${error}`);
    }
    abortStart(1);
  }

  console.log(
    `[start] Autonomy preflight: loaded ${relVisionPath} (${visionText.length} chars, ${validation.sectionCount} section(s)).`,
  );
}

function probeModuleResolution(
  fromDir: string,
  moduleSpecifier: string,
): { ok: boolean; error: string } {
  try {
    const req = createRequire(resolve(fromDir, "package.json"));
    req.resolve(moduleSpecifier);
    return { ok: true, error: "" };
  } catch (err: any) {
    const code = typeof err?.code === "string" ? err.code : "";
    return { ok: false, error: code || String(err) };
  }
}

function missingDependencySentinels(): Array<{
  label: string;
  fromDir: string;
  moduleSpecifier: string;
  retryWithHoisted: boolean;
  probeError: string;
}> {
  return REQUIRED_DEPENDENCY_PROBES.flatMap((entry) => {
    const probe = probeModuleResolution(entry.fromDir, entry.moduleSpecifier);
    if (probe.ok) return [];
    return [{ ...entry, probeError: probe.error }];
  });
}

function shouldRetryInstallWithHoistedLinker(
  missing: Array<{
    label: string;
    fromDir: string;
    moduleSpecifier: string;
    retryWithHoisted: boolean;
    probeError: string;
  }>,
): boolean {
  return missing.some((entry) => entry.retryWithHoisted);
}

function brokenWorkspaceNodeModules(): Array<{
  nodeModulesPath: string;
  resolveFromDir: string;
  moduleSpecifier: string;
  label: string;
  moduleLabel: string;
  probeError: string;
}> {
  return WORKSPACE_NODE_MODULES_HEALTH_CHECKS.flatMap((entry) => {
    if (!existsSync(entry.nodeModulesPath)) return [];
    const probe = probeModuleResolution(entry.resolveFromDir, entry.moduleSpecifier);
    if (probe.ok) return [];
    return [{ ...entry, probeError: probe.error }];
  });
}

function inspectRootWorkspaceLinks(): Array<{ path: string; label: string; probeError: string }> {
  return ROOT_WORKSPACE_LINK_HEALTH_CHECKS.flatMap((entry) => {
    if (!existsSync(entry.path)) {
      return [{ path: entry.path, label: entry.label, probeError: "ENOENT" }];
    }
    try {
      lstatSync(entry.path);
      return [];
    } catch (err: any) {
      const code = typeof err?.code === "string" ? err.code : "";
      return [{ path: entry.path, label: entry.label, probeError: code || String(err) }];
    }
  });
}

function currentBunBinary(): string {
  const execPath = (process.execPath ?? "").trim();
  if (!execPath) return "bun";
  const lower = execPath.toLowerCase();
  if (lower.endsWith("bun") || lower.endsWith("bun.exe")) return execPath;
  return "bun";
}

async function ensureWorkspaceDependenciesInstalled(): Promise<void> {
  const brokenWorkspaceModules = brokenWorkspaceNodeModules();
  const rootWorkspaceLinkIssues = inspectRootWorkspaceLinks();
  const missing = missingDependencySentinels();
  if (
    missing.length === 0 &&
    brokenWorkspaceModules.length === 0 &&
    rootWorkspaceLinkIssues.length === 0
  ) {
    return;
  }

  if (rootWorkspaceLinkIssues.length > 0) {
    console.warn(
      "[start] Dependency preflight detected broken/inaccessible root workspace links (often caused by cross-OS installs):",
    );
    for (const entry of rootWorkspaceLinkIssues) {
      const relPath = relative(repoRoot, entry.path).replace(/\\/g, "/");
      console.warn(
        `[start] - ${entry.label} (error=${entry.probeError}); removing ${relPath} for clean reinstall`,
      );
      if (!existsSync(entry.path)) continue;
      try {
        rmSync(entry.path, { recursive: true, force: true });
      } catch (err) {
        console.error(
          `[start] Failed to remove broken root workspace link ${relPath}: ${String(err)}`,
        );
        abortStart(1);
      }
    }
  }

  if (brokenWorkspaceModules.length > 0) {
    console.warn("[start] Dependency preflight detected stale workspace node_modules links:");
    for (const entry of brokenWorkspaceModules) {
      const relPath = relative(repoRoot, entry.nodeModulesPath).replace(/\\/g, "/");
      const relResolveFrom = relative(repoRoot, entry.resolveFromDir).replace(/\\/g, "/");
      console.warn(
        `[start] - ${entry.label} cannot resolve ${entry.moduleLabel} (${entry.moduleSpecifier} from ${relResolveFrom}, error=${entry.probeError}); removing ${relPath}`,
      );
      try {
        rmSync(entry.nodeModulesPath, { recursive: true, force: true });
      } catch (err) {
        console.error(
          `[start] Failed to remove stale workspace dependencies at ${relPath}: ${String(err)}`,
        );
        abortStart(1);
      }
    }
  }

  if (missing.length > 0) {
    console.log("[start] Dependency preflight detected missing workspace artifacts:");
    for (const entry of missing) {
      const relResolveFrom = relative(repoRoot, entry.fromDir).replace(/\\/g, "/");
      console.log(
        `[start] - ${entry.label}: unable to resolve ${entry.moduleSpecifier} from ${relResolveFrom} (error=${entry.probeError})`,
      );
    }
  }
  const forceInstall = brokenWorkspaceModules.length > 0 || rootWorkspaceLinkIssues.length > 0;
  const installArgs = forceInstall
    ? [currentBunBinary(), "install", "--force"]
    : [currentBunBinary(), "install"];
  const installDisplay = forceInstall ? "`bun install --force`" : "`bun install`";
  console.log(`[start] Running ${installDisplay} to restore workspace dependencies...`);

  const installExitCode = await runInherited(installArgs, repoRoot);
  if (installExitCode !== 0) {
    console.error(`[start] ${installDisplay} failed with exit code ${installExitCode}.`);
    abortStart(installExitCode);
  }

  let missingAfterInstall = missingDependencySentinels();
  let brokenAfterInstall = brokenWorkspaceNodeModules();
  let rootWorkspaceLinkIssuesAfterInstall = inspectRootWorkspaceLinks();
  if (missingAfterInstall.length > 0 && shouldRetryInstallWithHoistedLinker(missingAfterInstall)) {
    console.warn(
      "[start] Dependency preflight still missing root artifacts after install; retrying with `bun install --linker hoisted --force`...",
    );
    const hoistedInstallArgs = [currentBunBinary(), "install", "--linker", "hoisted", "--force"];
    const hoistedInstallExitCode = await runInherited(hoistedInstallArgs, repoRoot);
    if (hoistedInstallExitCode !== 0) {
      console.error(
        `[start] \`bun install --linker hoisted --force\` failed with exit code ${hoistedInstallExitCode}.`,
      );
      abortStart(hoistedInstallExitCode);
    }
    missingAfterInstall = missingDependencySentinels();
    brokenAfterInstall = brokenWorkspaceNodeModules();
    rootWorkspaceLinkIssuesAfterInstall = inspectRootWorkspaceLinks();
    if (
      missingAfterInstall.length === 0 &&
      brokenAfterInstall.length === 0 &&
      rootWorkspaceLinkIssuesAfterInstall.length === 0
    ) {
      console.log("[start] Dependency preflight recovered after hoisted-linker install.");
    }
  }
  if (
    missingAfterInstall.length > 0 ||
    brokenAfterInstall.length > 0 ||
    rootWorkspaceLinkIssuesAfterInstall.length > 0
  ) {
    console.error("[start] Dependency preflight still failing after install:");
    for (const entry of missingAfterInstall) {
      const relResolveFrom = relative(repoRoot, entry.fromDir).replace(/\\/g, "/");
      console.error(
        `[start] - ${entry.label}: unable to resolve ${entry.moduleSpecifier} from ${relResolveFrom} (error=${entry.probeError})`,
      );
    }
    for (const entry of brokenAfterInstall) {
      const relPath = relative(repoRoot, entry.nodeModulesPath).replace(/\\/g, "/");
      const relResolveFrom = relative(repoRoot, entry.resolveFromDir).replace(/\\/g, "/");
      console.error(
        `[start] - ${entry.label}: cannot resolve ${entry.moduleLabel} (${entry.moduleSpecifier} from ${relResolveFrom}, error=${entry.probeError}) in ${relPath}`,
      );
    }
    for (const entry of rootWorkspaceLinkIssuesAfterInstall) {
      const relPath = relative(repoRoot, entry.path).replace(/\\/g, "/");
      console.error(
        `[start] - ${entry.label}: path ${relPath} remains inaccessible after reinstall (error=${entry.probeError})`,
      );
    }
    abortStart(1);
  }

  console.log("[start] Dependency preflight: workspace dependencies look healthy.");
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
    console.log(`[start] Clean run: no runtime state found at ${dataDir} (nothing to delete).`);
  } else {
    removePathForClean(dataDir, "runtime state");
  }

  const scratchWorkspaceDir = resolve(repoRoot, "workspace");
  if (existsSync(scratchWorkspaceDir)) {
    removePathForClean(scratchWorkspaceDir, "runtime scratch dir");
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

function normalizeCodexAuthMode(value: string | null | undefined): CodexAuthMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized === "api_key" || normalized === "api-key" || normalized === "api") {
    return "api_key";
  }
  if (
    normalized === "chatgpt" ||
    normalized === "chatgpt_login" ||
    normalized === "chatgpt-pro" ||
    normalized === "subscription"
  ) {
    return "chatgpt";
  }
  return "auto";
}

function codexAuthModeFromConfig(): string {
  return firstNonEmpty(
    CONFIG.remotebuddy.llm.codexAuthMode,
    LOCALBUDDY_ENABLED ? CONFIG.localbuddy.llm.codexAuthMode : "",
    CONFIG.workerpals.llm.codexAuthMode,
    "auto",
  );
}

function codexConfiguredAuthMode(): CodexAuthMode {
  return normalizeCodexAuthMode(
    firstNonEmpty(process.env.PUSHPALS_OPENAI_CODEX_AUTH_MODE, codexAuthModeFromConfig(), "auto"),
  );
}

function codexBackendEnabled(): boolean {
  if ((CONFIG.workerpals.executor ?? "").trim().toLowerCase() === "openai_codex") return true;
  const remoteBackend = resolveServiceBackendForPreflight({
    backend: CONFIG.remotebuddy.llm.backend,
    endpoint: firstNonEmpty(CONFIG.remotebuddy.llm.endpoint) || DEFAULT_LMSTUDIO_ENDPOINT,
    model: CONFIG.remotebuddy.llm.model,
    apiKey: CONFIG.remotebuddy.llm.apiKey,
    allowCodexFallback: true,
  });
  if (remoteBackend === "openai_codex") return true;
  if (LOCALBUDDY_ENABLED) {
    const localBackend = resolveServiceBackendForPreflight({
      backend: CONFIG.localbuddy.llm.backend,
      endpoint: firstNonEmpty(CONFIG.localbuddy.llm.endpoint) || DEFAULT_LMSTUDIO_ENDPOINT,
      model: CONFIG.localbuddy.llm.model,
      apiKey: CONFIG.localbuddy.llm.apiKey,
      allowCodexFallback: true,
    });
    if (localBackend === "openai_codex") return true;
  }
  const workerBackend = resolveServiceBackendForPreflight({
    backend: CONFIG.workerpals.llm.backend,
    endpoint: firstNonEmpty(CONFIG.workerpals.llm.endpoint) || DEFAULT_LMSTUDIO_ENDPOINT,
    model: CONFIG.workerpals.llm.model,
    apiKey: CONFIG.workerpals.llm.apiKey,
    allowCodexFallback: false,
  });
  if (workerBackend === "openai_codex") return true;
  return false;
}

function codexApiKeyPresent(): boolean {
  const envKey = (process.env.OPENAI_API_KEY ?? "").trim();
  const cfgKeys = [
    CONFIG.remotebuddy.llm.apiKey,
    LOCALBUDDY_ENABLED ? CONFIG.localbuddy.llm.apiKey : "",
    CONFIG.workerpals.llm.apiKey,
  ]
    .map((value) => (value ?? "").trim())
    .filter((value) => value && value.toLowerCase() !== "lmstudio");
  return Boolean(envKey || cfgKeys.length > 0);
}

function codexEffectiveAuthMode(): CodexAuthMode | null {
  if (!codexBackendEnabled()) return null;
  const configured = codexConfiguredAuthMode();
  if (configured === "auto") {
    return codexApiKeyPresent() ? "api_key" : "chatgpt";
  }
  return configured;
}

function codexHostCommandPrefix(): string[] {
  const jsonOverride = firstNonEmpty(process.env.PUSHPALS_OPENAI_CODEX_BIN_JSON);
  if (jsonOverride) {
    try {
      const parsed = JSON.parse(jsonOverride);
      if (Array.isArray(parsed)) {
        const args = parsed
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter((item) => item.length > 0);
        if (args.length > 0) return args;
      }
    } catch {
      // fall through to string override parsing
    }
  }
  const override = firstNonEmpty(
    process.env.PUSHPALS_OPENAI_CODEX_BIN,
    CONFIG.remotebuddy.llm.codexBin,
    LOCALBUDDY_ENABLED ? CONFIG.localbuddy.llm.codexBin : "",
    CONFIG.workerpals.llm.codexBin,
  );
  if (override) {
    const parsed = splitArgs(override);
    if (parsed.length > 0) return parsed;
  }
  return ["bun", "x", "--yes", "@openai/codex"];
}

function persistResolvedCodexCommandPrefix(commandPrefix: string[]): void {
  if (commandPrefix.length === 0) return;
  const serialized = commandPrefix.join(" ");
  const json = JSON.stringify(commandPrefix);
  process.env.PUSHPALS_OPENAI_CODEX_BIN = serialized;
  process.env.PUSHPALS_OPENAI_CODEX_BIN_JSON = json;
}

async function resolveHostCodexCommandPrefix(commandPrefix: string[]): Promise<string[]> {
  const candidates: string[][] = [];
  const pushCandidate = (cmd: string[]) => {
    if (cmd.length === 0) return;
    const key = cmd.join("\u0000");
    if (candidates.some((existing) => existing.join("\u0000") === key)) return;
    candidates.push(cmd);
  };

  pushCandidate(commandPrefix);
  const execPath = (process.execPath ?? "").trim();
  if (execPath) {
    const lower = execPath.toLowerCase();
    if (lower.endsWith("bun") || lower.endsWith("bun.exe")) {
      pushCandidate([execPath, "x", "--yes", "@openai/codex"]);
    }
  }
  pushCandidate(["bun", "x", "--yes", "@openai/codex"]);
  pushCandidate(["bunx", "--yes", "@openai/codex"]);
  pushCandidate(["codex"]);

  const attempted: string[] = [];
  for (const candidate of candidates) {
    const renderedCandidate = candidate.join(" ");
    attempted.push(`${renderedCandidate} --version`);
    const versionExit = await runQuiet([...candidate, "--version"]);
    if (versionExit === 0) return candidate;
  }

  console.error("[start] openai_codex backend selected but Codex CLI is unavailable.");
  if (attempted.length > 0) {
    console.error("[start] Tried:");
    for (const line of attempted) {
      console.error(`[start] - ${line}`);
    }
  }
  console.error("[start] Install/use Codex CLI, then retry start.");
  abortStart(1);
}

async function ensureCodexCliAuthPreflight(): Promise<void> {
  if (!codexBackendEnabled()) return;

  const configuredMode = codexConfiguredAuthMode();
  const effectiveMode = codexEffectiveAuthMode() ?? "chatgpt";
  const hasApiKey = codexApiKeyPresent();
  const commandPrefix = await resolveHostCodexCommandPrefix(codexHostCommandPrefix());
  process.env.PUSHPALS_OPENAI_CODEX_AUTH_MODE = configuredMode;
  persistResolvedCodexCommandPrefix(commandPrefix);

  console.log(
    `[start] openai_codex auth preflight: configured=${configuredMode} effective=${effectiveMode}`,
  );

  if (effectiveMode === "api_key") {
    if (!hasApiKey) {
      console.error(
        "[start] openai_codex API-key auth requires OPENAI_API_KEY (or a service llm.api_key) but none was found.",
      );
      abortStart(1);
    }
    console.log(`[start] Codex CLI preflight ok: ${commandPrefix.join(" ")}`);
    return;
  }

  const statusExit = await runQuiet([...commandPrefix, "login", "status"]);
  if (statusExit === 0) {
    console.log("[start] Codex CLI login status: already authenticated.");
    return;
  }

  console.log("[start] Codex CLI is not logged in. Launching interactive login now...");
  const loginExit = await runInherited([...commandPrefix, "login"], repoRoot);
  if (loginExit !== 0) {
    console.error(`[start] Codex login exited with code ${loginExit}.`);
    console.error(
      "[start] Complete `codex login` (or `bunx --yes @openai/codex login`) and retry.",
    );
    abortStart(1);
  }

  const verifyExit = await runQuiet([...commandPrefix, "login", "status"]);
  if (verifyExit !== 0) {
    console.error("[start] Codex login did not persist. Verify login and retry.");
    abortStart(1);
  }
  console.log("[start] Codex CLI login completed.");
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

function endpointLooksOpenAI(endpoint: string): boolean {
  const parsed = parseUrl(endpoint.trim());
  if (!parsed) return false;
  const host = parsed.hostname.trim().toLowerCase();
  if (!host) return false;
  return host === "api.openai.com" || host.endsWith(".api.openai.com");
}

function normalizeLlmBackend(value: string | null | undefined): SupportedLlmBackend | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "lmstudio") return "lmstudio";
  if (normalized === "ollama") return "ollama";
  if (normalized === "openai" || normalized === "openai_compatible") return "openai";
  if (normalized === "openai_codex" || normalized === "codex" || normalized === "codex_cli") {
    return "openai_codex";
  }
  if (normalized === "ollama_chat") return "ollama";
  return null;
}

function configuredLlmBackend(
  endpoint: string,
  explicitBackend?: string | null | undefined,
): SupportedLlmBackend {
  const explicit = normalizeLlmBackend(explicitBackend);
  if (explicit === "openai_codex") return explicit;
  if (explicit === "ollama") return "ollama";
  if (endpointLooksOpenAI(endpoint)) return "openai";
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
  if (backend === "openai_codex") {
    return normalizeCompletionEndpoint(source, DEFAULT_OPENAI_ENDPOINT);
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

function streamProcessOutput(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  prefix: string,
): void {
  if (!stream || typeof stream === "number" || typeof stream.getReader !== "function") return;

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
  backend: SupportedLlmBackend;
  configuredModel: string;
  apiKey: string;
  endpoint: string;
  probes: string[];
};

type LlmPreflightCheck = { ok: boolean; url?: string; status?: number; error?: string };

type LlmPreflightEndpointGroup = {
  endpoint: string;
  probes: string[];
  services: string[];
};

const KNOWN_MODEL_PROVIDER_PREFIXES = new Set([
  "openai",
  "ollama",
  "openrouter",
  "anthropic",
  "google",
  "gemini",
  "groq",
  "mistral",
  "cohere",
  "vertex_ai",
  "bedrock",
  "deepseek",
  "xai",
  "together_ai",
  "fireworks_ai",
  "huggingface",
  "replicate",
]);

function normalizeModelName(value: string): string {
  return value.trim().toLowerCase();
}

function configuredModelCandidates(configuredModel: string): string[] {
  const raw = configuredModel.trim();
  if (!raw) return [];
  const candidates = new Set<string>();
  candidates.add(raw);
  if (raw.includes("/")) {
    const parts = raw.split("/");
    const first = parts[0]?.trim().toLowerCase() ?? "";
    if (parts.length > 1 && KNOWN_MODEL_PROVIDER_PREFIXES.has(first)) {
      const withoutPrefix = parts.slice(1).join("/").trim();
      if (withoutPrefix) candidates.add(withoutPrefix);
    }
  }
  return Array.from(candidates);
}

function isLikelyCodexModel(configuredModel: string): boolean {
  return configuredModelCandidates(configuredModel).some((candidate) =>
    normalizeModelName(candidate).includes("codex"),
  );
}

function shouldUseCodexCliFallbackBackend(
  backend: SupportedLlmBackend,
  configuredModel: string,
  apiKey: string,
): boolean {
  if (backend !== "openai") return false;
  if (!isLikelyCodexModel(configuredModel)) return false;
  const mode = codexConfiguredAuthMode();
  if (mode === "api_key") return false;
  if (mode === "chatgpt") return true;
  return !apiKey.trim();
}

function configuredModelMatchesAvailable(
  backend: SupportedLlmBackend,
  configuredModel: string,
  availableModel: string,
): boolean {
  const availableNorm = normalizeModelName(availableModel);
  if (!availableNorm) return false;
  const candidates = configuredModelCandidates(configuredModel);
  for (const candidateRaw of candidates) {
    const candidate = normalizeModelName(candidateRaw);
    if (!candidate) continue;
    if (candidate === availableNorm) return true;
    if (backend === "ollama") {
      if (availableNorm.startsWith(`${candidate}:`)) return true;
      if (candidate.startsWith(`${availableNorm}:`)) return true;
    }
  }
  return false;
}

function extractModelIds(payload: any): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    out.push(trimmed);
  };

  const fromArray = (rows: unknown[]) => {
    for (const row of rows) {
      if (typeof row === "string") {
        add(row);
        continue;
      }
      if (row && typeof row === "object") {
        const item = row as Record<string, unknown>;
        add(item.id);
        add(item.model);
        add(item.name);
      }
    }
  };

  if (Array.isArray(payload?.data)) fromArray(payload.data);
  if (Array.isArray(payload?.models)) fromArray(payload.models);
  if (Array.isArray(payload)) fromArray(payload);

  return Array.from(new Set(out));
}

function modelProbeUrls(target: LlmPreflightTarget): string[] {
  const normalized = target.endpoint.trim().replace(/\/+$/, "");
  if (!normalized) return [];
  if (target.backend === "ollama") {
    if (normalized.endsWith("/api/chat")) {
      const root = normalized.slice(0, -"/api/chat".length);
      return Array.from(new Set([`${root}/api/tags`, `${root}/tags`]));
    }
    return Array.from(new Set([`${normalized}/api/tags`, `${normalized}/tags`]));
  }
  if (target.backend === "openai") {
    if (normalized.endsWith("/v1/chat/completions")) {
      const root = normalized.slice(0, -"/v1/chat/completions".length);
      return Array.from(new Set([`${root}/v1/models`]));
    }
    if (normalized.endsWith("/chat/completions")) {
      const root = normalized.slice(0, -"/chat/completions".length);
      if (root.endsWith("/v1")) {
        return Array.from(new Set([`${root}/models`]));
      }
      return Array.from(new Set([`${root}/v1/models`]));
    }
    if (normalized.endsWith("/v1")) {
      return Array.from(new Set([`${normalized}/models`]));
    }
    const parsed = parseUrl(normalized);
    if (parsed) return Array.from(new Set([`${parsed.origin}/v1/models`]));
    return Array.from(new Set([`${normalized}/v1/models`]));
  }

  if (normalized.endsWith("/v1/chat/completions")) {
    const root = normalized.slice(0, -"/v1/chat/completions".length);
    return Array.from(new Set([`${root}/v1/models`, `${root}/models`]));
  }
  if (normalized.endsWith("/chat/completions")) {
    const root = normalized.slice(0, -"/chat/completions".length);
    if (root.endsWith("/v1")) {
      const parent = root.slice(0, -"/v1".length).replace(/\/+$/, "");
      return Array.from(new Set([`${root}/models`, `${parent}/models`]));
    }
    return Array.from(new Set([`${root}/v1/models`, `${root}/models`]));
  }
  if (normalized.endsWith("/v1")) {
    const parent = normalized.slice(0, -"/v1".length).replace(/\/+$/, "");
    return Array.from(new Set([`${normalized}/models`, `${parent}/models`]));
  }
  return Array.from(new Set([`${normalized}/v1/models`, `${normalized}/models`]));
}

async function discoverModelsForTarget(
  target: LlmPreflightTarget,
): Promise<{ models: string[]; detail: string }> {
  const probes = modelProbeUrls(target);
  if (probes.length === 0) return { models: [], detail: "no model probes derived from endpoint" };

  const headers: Record<string, string> = { Accept: "application/json, text/plain, */*" };
  const apiKey = target.apiKey.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let lastDetail = "model list probe failed";
  for (const probe of probes) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), 4_000);
    try {
      const response = await fetch(probe, {
        method: "GET",
        signal: controller.signal,
        headers,
      });
      const text = await response.text();
      if (!response.ok) {
        const hint = text.trim().replace(/\s+/g, " ").slice(0, 180);
        lastDetail = `${probe} -> HTTP ${response.status}${hint ? ` (${hint})` : ""}`;
        continue;
      }

      let payload: any = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      const models = extractModelIds(payload);
      if (models.length > 0) {
        return { models, detail: `${probe} -> HTTP ${response.status}` };
      }
      lastDetail = `${probe} -> no models in payload`;
    } catch (err) {
      lastDetail = `${probe}: ${String(err)}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { models: [], detail: lastDetail };
}

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

function resolveServiceBackendForPreflight(opts: {
  backend: string | null | undefined;
  endpoint: string;
  model: string;
  apiKey: string;
  allowCodexFallback?: boolean;
}): SupportedLlmBackend {
  let backend =
    normalizeLlmBackend(firstNonEmpty(opts.backend)) ??
    configuredLlmBackend(opts.endpoint || DEFAULT_LMSTUDIO_ENDPOINT);
  if (
    (opts.allowCodexFallback ?? true) &&
    shouldUseCodexCliFallbackBackend(backend, opts.model, opts.apiKey)
  ) {
    backend = "openai_codex";
  }
  return backend;
}

function llmPreflightTargets(): LlmPreflightTarget[] {
  const out: LlmPreflightTarget[] = [];
  const configuredRemoteRaw = firstNonEmpty(CONFIG.remotebuddy.llm.endpoint);
  const configuredLocalRaw = LOCALBUDDY_ENABLED
    ? firstNonEmpty(CONFIG.localbuddy.llm.endpoint)
    : "";
  const configuredWorkerRaw = firstNonEmpty(CONFIG.workerpals.llm.endpoint);

  const remoteBackend = resolveServiceBackendForPreflight({
    backend: CONFIG.remotebuddy.llm.backend,
    endpoint: configuredRemoteRaw || DEFAULT_LMSTUDIO_ENDPOINT,
    model: CONFIG.remotebuddy.llm.model,
    apiKey: CONFIG.remotebuddy.llm.apiKey,
    allowCodexFallback: true,
  });
  const localBackend = LOCALBUDDY_ENABLED
    ? resolveServiceBackendForPreflight({
        backend: CONFIG.localbuddy.llm.backend,
        endpoint: configuredLocalRaw || DEFAULT_LMSTUDIO_ENDPOINT,
        model: CONFIG.localbuddy.llm.model,
        apiKey: CONFIG.localbuddy.llm.apiKey,
        allowCodexFallback: true,
      })
    : null;
  const workerBackend = resolveServiceBackendForPreflight({
    backend: CONFIG.workerpals.llm.backend,
    endpoint: configuredWorkerRaw || DEFAULT_LMSTUDIO_ENDPOINT,
    model: CONFIG.workerpals.llm.model,
    apiKey: CONFIG.workerpals.llm.apiKey,
    allowCodexFallback: false,
  });

  const remoteFallback =
    remoteBackend === "ollama"
      ? DEFAULT_OLLAMA_ENDPOINT
      : remoteBackend === "openai" || remoteBackend === "openai_codex"
        ? DEFAULT_OPENAI_ENDPOINT
        : DEFAULT_LMSTUDIO_ENDPOINT;
  const localFallback =
    localBackend === "ollama"
      ? DEFAULT_OLLAMA_ENDPOINT
      : localBackend === "openai" || localBackend === "openai_codex"
        ? DEFAULT_OPENAI_ENDPOINT
        : DEFAULT_LMSTUDIO_ENDPOINT;
  const workerFallback =
    workerBackend === "ollama"
      ? DEFAULT_OLLAMA_ENDPOINT
      : workerBackend === "openai" || workerBackend === "openai_codex"
        ? DEFAULT_OPENAI_ENDPOINT
        : DEFAULT_LMSTUDIO_ENDPOINT;

  const addTarget = (
    name: string,
    backend: SupportedLlmBackend,
    model: string,
    apiKey: string,
    endpoint: string,
  ): void => {
    if (backend === "openai_codex") return;
    const normalized = endpoint.trim();
    if (!normalized) return;

    const probes: string[] = [];
    const parsed = parseUrl(normalized);
    if (backend === "openai" && normalized.includes("/v1/chat/completions")) {
      probes.push(normalized.replace(/\/v1\/chat\/completions$/, "/v1/models"));
    } else if (normalized.endsWith("/api/chat")) {
      probes.push(normalized.replace(/\/api\/chat$/, "/api/tags"));
    } else if (normalized.includes("/chat/completions")) {
      probes.push(normalized.replace(/\/chat\/completions$/, "/models"));
    }
    probes.push(normalized);
    if (parsed) {
      probes.push(`${parsed.origin}/health`);
    }

    out.push({
      name,
      backend,
      configuredModel: model.trim(),
      apiKey: apiKey.trim(),
      endpoint: normalized,
      probes: Array.from(new Set(probes)),
    });
  };

  addTarget(
    "RemoteBuddy LLM",
    remoteBackend,
    CONFIG.remotebuddy.llm.model,
    CONFIG.remotebuddy.llm.apiKey,
    normalizeEndpointForBackend(configuredRemoteRaw, remoteFallback, remoteBackend),
  );
  if (localBackend) {
    addTarget(
      "LocalBuddy LLM",
      localBackend,
      CONFIG.localbuddy.llm.model,
      CONFIG.localbuddy.llm.apiKey,
      normalizeEndpointForBackend(configuredLocalRaw, localFallback, localBackend),
    );
  }
  const workerExecutorUsesCodex =
    (CONFIG.workerpals.executor ?? "").trim().toLowerCase() === "openai_codex";
  const skipWorkerLlmTarget = workerExecutorUsesCodex && codexEffectiveAuthMode() === "chatgpt";
  if (!skipWorkerLlmTarget) {
    addTarget(
      "WorkerPal LLM",
      workerBackend,
      CONFIG.workerpals.llm.model,
      CONFIG.workerpals.llm.apiKey,
      normalizeEndpointForBackend(configuredWorkerRaw, workerFallback, workerBackend),
    );
  }

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

function codexLlmPreflightSkippedServices(): string[] {
  const services: string[] = [];
  const remoteEndpoint =
    firstNonEmpty(CONFIG.remotebuddy.llm.endpoint) || DEFAULT_LMSTUDIO_ENDPOINT;
  const localEndpoint = LOCALBUDDY_ENABLED
    ? firstNonEmpty(CONFIG.localbuddy.llm.endpoint) || DEFAULT_LMSTUDIO_ENDPOINT
    : "";
  const workerEndpoint = firstNonEmpty(CONFIG.workerpals.llm.endpoint) || DEFAULT_LMSTUDIO_ENDPOINT;

  const remoteBackend = resolveServiceBackendForPreflight({
    backend: CONFIG.remotebuddy.llm.backend,
    endpoint: remoteEndpoint,
    model: CONFIG.remotebuddy.llm.model,
    apiKey: CONFIG.remotebuddy.llm.apiKey,
    allowCodexFallback: true,
  });
  const localBackend = LOCALBUDDY_ENABLED
    ? resolveServiceBackendForPreflight({
        backend: CONFIG.localbuddy.llm.backend,
        endpoint: localEndpoint,
        model: CONFIG.localbuddy.llm.model,
        apiKey: CONFIG.localbuddy.llm.apiKey,
        allowCodexFallback: true,
      })
    : null;
  const workerBackend = resolveServiceBackendForPreflight({
    backend: CONFIG.workerpals.llm.backend,
    endpoint: workerEndpoint,
    model: CONFIG.workerpals.llm.model,
    apiKey: CONFIG.workerpals.llm.apiKey,
    allowCodexFallback: false,
  });

  if (remoteBackend === "openai_codex") {
    services.push("RemoteBuddy LLM");
  }
  if (localBackend === "openai_codex") {
    services.push("LocalBuddy LLM");
  }
  const workerViaExecutor =
    (CONFIG.workerpals.executor ?? "").trim().toLowerCase() === "openai_codex" &&
    codexEffectiveAuthMode() === "chatgpt";
  if (workerViaExecutor || workerBackend === "openai_codex") {
    services.push("WorkerPal LLM");
  }
  return services;
}

function lmStudioReadyTimeoutMs(): number {
  return Math.max(
    1_000,
    CONFIG.startup.lmStudioReadyTimeoutMs || DEFAULT_LMSTUDIO_READY_TIMEOUT_MS,
  );
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
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of raw.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (current.length > 0) out.push(current);
  return out;
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
  console.error(
    "[start] Optional: set startup.auto_start_lmstudio=false and run LM Studio yourself.",
  );
}

async function ensureLlmPreflight(): Promise<void> {
  if (CONFIG.startup.skipLlmPreflight) return;

  const skippedServices = codexLlmPreflightSkippedServices();
  for (const serviceName of skippedServices) {
    console.log(
      `[start] Skipping ${serviceName} endpoint/model preflight (openai_codex backend uses Codex CLI auth).`,
    );
  }

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
    const check = checksByEndpoint.get(target.endpoint) ?? {
      ok: false,
      error: "missing check result",
    };
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
      } else if (primaryBackend === "openai") {
        console.error(
          "[start] OpenAI backend selected. Verify OPENAI_API_KEY is set and the configured endpoint is https://api.openai.com/v1/chat/completions.",
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

  const modelFailures: Array<{ target: LlmPreflightTarget; detail: string }> = [];
  const configuredModelMissingFailures: Array<{
    target: LlmPreflightTarget;
    configuredModel: string;
    discoveredDetail: string;
    discoveredFallback: string;
  }> = [];
  for (const target of serviceTargets) {
    if (target.backend === "openai" && !target.apiKey.trim()) {
      let detail =
        "OpenAI model preflight requires API-key authentication, but no API key is configured for this service.";
      if (codexBackendEnabled() && codexEffectiveAuthMode() === "chatgpt") {
        detail +=
          " Codex CLI login only applies to services configured with backend=openai_codex; OpenAI HTTP backends still require OPENAI_API_KEY.";
      }
      modelFailures.push({ target, detail });
      continue;
    }
    const discovered = await discoverModelsForTarget(target);
    if (discovered.models.length === 0) {
      modelFailures.push({
        target,
        detail: discovered.detail,
      });
      continue;
    }

    const configuredModel = target.configuredModel.trim();
    if (configuredModel) {
      const matched = discovered.models.some((available) =>
        configuredModelMatchesAvailable(target.backend, configuredModel, available),
      );
      if (matched) {
        console.log(
          `[start] LLM model preflight ok for ${target.name}: configured model "${configuredModel}" is available (${discovered.detail}).`,
        );
        continue;
      }

      const fallback = discovered.models[0] ?? "(none)";
      configuredModelMissingFailures.push({
        target,
        configuredModel,
        discoveredDetail: discovered.detail,
        discoveredFallback: fallback,
      });
      continue;
    }

    const fallback = discovered.models[0] ?? "(none)";
    console.log(
      `[start] LLM model preflight ok for ${target.name}: no configured model set; discovered "${fallback}" (${discovered.detail}).`,
    );
  }

  if (configuredModelMissingFailures.length > 0 || modelFailures.length > 0) {
    for (const failure of configuredModelMissingFailures) {
      console.error(`[start] LLM model preflight failed for ${failure.target.name}.`);
      console.error(`[start] Endpoint: ${failure.target.endpoint}`);
      console.error(`[start] Backend: ${failure.target.backend}`);
      console.error(`[start] Configured model: ${failure.configuredModel}`);
      console.error(
        `[start] Reason: configured model not found in endpoint model list (${failure.discoveredDetail}).`,
      );
      console.error(`[start] Discovered fallback model: ${failure.discoveredFallback}`);
    }

    for (const failure of modelFailures) {
      console.error(`[start] LLM model preflight failed for ${failure.target.name}.`);
      console.error(`[start] Endpoint: ${failure.target.endpoint}`);
      console.error(`[start] Backend: ${failure.target.backend}`);
      console.error(`[start] Configured model: ${failure.target.configuredModel || "(empty)"}`);
      console.error(`[start] Reason: ${failure.detail}`);
    }
    if (autoStartAttempted) {
      await stopManagedLmStudio();
    }
    if (configuredModelMissingFailures.length > 0) {
      console.error(
        "[start] Startup aborted: configured service model(s) are missing. Update configs/*.toml model names or load those exact models in your LLM server.",
      );
    } else {
      console.error(
        "[start] LLM server is reachable but no models were discovered. Load a model or update service model config.",
      );
    }
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
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPump = pipeProcStreamToOutputAndSystemLog(proc.stdout, process.stdout);
    const stderrPump = pipeProcStreamToOutputAndSystemLog(proc.stderr, process.stderr);
    const exitCode = await proc.exited;
    await Promise.allSettled([stdoutPump, stderrPump]);
    return exitCode;
  } catch {
    return 127;
  }
}

type SpawnedChild = ReturnType<typeof Bun.spawn>;

let localBuddyProc: SpawnedChild | null = null;
let localBuddyStdoutPump: Promise<void> | null = null;
let localBuddyStderrPump: Promise<void> | null = null;
let localBuddyConfigPollTimer: ReturnType<typeof setInterval> | null = null;
let localBuddyStabilityTimer: ReturnType<typeof setTimeout> | null = null;
let localBuddyRuntimeEnabled = LOCALBUDDY_ENABLED;
let localBuddyConfigPollInFlight = false;
let localBuddyStopRequested = false;
let localBuddyConsecutiveFailures = 0;
let localBuddyRetryAfterMs = 0;
let localBuddyRestartLimitLogged = false;

function resetLocalBuddyRestartBudget(): void {
  localBuddyConsecutiveFailures = 0;
  localBuddyRetryAfterMs = 0;
  localBuddyRestartLimitLogged = false;
}

function clearLocalBuddyStabilityTimer(): void {
  if (!localBuddyStabilityTimer) return;
  clearTimeout(localBuddyStabilityTimer);
  localBuddyStabilityTimer = null;
}

function markLocalBuddyUnexpectedFailure(reason: string): void {
  localBuddyConsecutiveFailures += 1;
  clearLocalBuddyStabilityTimer();
  localBuddyRetryAfterMs =
    Date.now() + computeLocalBuddyRestartBackoffMs(localBuddyConsecutiveFailures);
  if (localBuddyConsecutiveFailures >= LOCALBUDDY_MAX_CONSECUTIVE_FAILURES) {
    if (!localBuddyRestartLimitLogged) {
      localBuddyRestartLimitLogged = true;
      console.warn(
        `[start] LocalBuddy restart limit reached after ${localBuddyConsecutiveFailures} consecutive failure(s). Toggle localbuddy.enabled off and on after fixing the cause to retry. Last failure: ${reason}`,
      );
    }
    return;
  }
  const delayMs = Math.max(0, localBuddyRetryAfterMs - Date.now());
  console.warn(
    `[start] LocalBuddy start/restart failed (${reason}). Retrying in ${delayMs}ms (failure ${localBuddyConsecutiveFailures}/${LOCALBUDDY_MAX_CONSECUTIVE_FAILURES}).`,
  );
}

async function waitForChildExit(
  child: SpawnedChild,
  timeoutMs: number,
): Promise<number | "timeout"> {
  return await Promise.race<number | "timeout">([
    child.exited,
    new Promise<"timeout">((resolveTimeout) =>
      setTimeout(() => resolveTimeout("timeout"), timeoutMs),
    ),
  ]);
}

function summarizeLocalBuddyReadinessFailure(detail: string): string {
  const compact = detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
  if (!compact) return "unknown validation failure";
  return compact.length <= 360 ? compact : `${compact.slice(0, 357)}...`;
}

async function ensureLocalBuddyManagedStartReady(bunExecPath: string): Promise<void> {
  const snapshot = loadLocalBuddyRuntimeSnapshotFromFiles(repoRoot, process.env);
  if (!snapshot.localbuddy.enabled) return;

  console.log("[start] Running LocalBuddy readiness preflight...");
  const result = await runCapture(
    [
      bunExecPath,
      "--cwd",
      "apps/localbuddy",
      "--env-file",
      "../../.env",
      "run",
      "src/localbuddy_main.ts",
      "--validate-config",
    ],
    repoRoot,
  );
  if (!result.ok) {
    const detail = summarizeLocalBuddyReadinessFailure(result.stderr || result.stdout);
    throw new Error(detail);
  }

  console.log("[start] LocalBuddy readiness preflight passed.");
}

async function terminateManagedChildTree(
  child: SpawnedChild,
  label: string,
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill();
    } catch {}
    return;
  }

  if (process.platform === "win32") {
    const result = await runCapture(["taskkill", "/PID", String(pid), "/T", "/F"], repoRoot);
    if (!result.ok) {
      console.warn(
        `[start] taskkill returned ${result.exitCode} for ${label}. Verifying process exit...`,
      );
    }
    await waitForChildExit(child, 4_000);
    if (child.exitCode == null && child.signalCode == null) {
      try {
        child.kill("SIGKILL");
      } catch {}
      await waitForChildExit(child, 1_500);
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  await waitForChildExit(child, 5_000);
  if (child.exitCode == null && child.signalCode == null) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    await waitForChildExit(child, 1_500);
  }
}

async function startLocalBuddyManagedProcess(reason: string, bunExecPath: string): Promise<void> {
  if (localBuddyProc) return;
  console.log(`[start] Starting LocalBuddy (${reason}).`);
  localBuddyStopRequested = false;
  let child: SpawnedChild;
  try {
    child = Bun.spawn([bunExecPath, "run", "localbuddy:only"], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
      env: { ...process.env },
    });
  } catch (err) {
    markLocalBuddyUnexpectedFailure(String(err));
    throw err;
  }

  localBuddyProc = child;
  localBuddyStdoutPump = pipeProcStreamToTaggedConsole(child.stdout, "localbuddy");
  localBuddyStderrPump = pipeProcStreamToTaggedConsole(child.stderr, "localbuddy");
  clearLocalBuddyStabilityTimer();
  localBuddyStabilityTimer = setTimeout(() => {
    if (localBuddyProc === child && localBuddyRuntimeEnabled) {
      resetLocalBuddyRestartBudget();
    }
    localBuddyStabilityTimer = null;
  }, LOCALBUDDY_STABLE_UPTIME_MS);

  void child.exited.then(async (code) => {
    const stdoutPump = localBuddyStdoutPump;
    const stderrPump = localBuddyStderrPump;
    clearLocalBuddyStabilityTimer();
    if (localBuddyProc === child) {
      localBuddyProc = null;
      localBuddyStdoutPump = null;
      localBuddyStderrPump = null;
    }
    await Promise.allSettled([
      stdoutPump ?? Promise.resolve(),
      stderrPump ?? Promise.resolve(),
    ]);
    const expectedExit = shuttingDown || localBuddyStopRequested || !localBuddyRuntimeEnabled;
    if (expectedExit) {
      console.log(`[start] LocalBuddy exited with code ${code}.`);
      return;
    }
    markLocalBuddyUnexpectedFailure(`exit code ${code}`);
    console.warn(
      `[start] LocalBuddy exited unexpectedly with code ${code} while localbuddy.enabled=true.`,
    );
  });
}

async function stopLocalBuddyManagedProcess(reason: string): Promise<void> {
  const child = localBuddyProc;
  if (!child) return;

  console.log(`[start] Stopping LocalBuddy (${reason}).`);
  localBuddyStopRequested = true;
  clearLocalBuddyStabilityTimer();
  await terminateManagedChildTree(child, "LocalBuddy");
  const exited = await waitForChildExit(child, 1_000);
  if (exited === "timeout") {
    console.warn("[start] LocalBuddy did not exit promptly; forcing shutdown.");
    try {
      child.kill("SIGKILL");
    } catch {}
    await waitForChildExit(child, 2_000);
  }
}

async function syncLocalBuddyRuntimeConfig(bunExecPath: string): Promise<void> {
  if (localBuddyConfigPollInFlight || shuttingDown) return;
  localBuddyConfigPollInFlight = true;
  try {
    const latest = loadLocalBuddyRuntimeSnapshotFromFiles(repoRoot, process.env);
    const previousEnabled = localBuddyRuntimeEnabled;
    const nextEnabled = Boolean(latest.localbuddy.enabled);
    const nextPort = latest.localbuddy.port;
    if (previousEnabled !== nextEnabled) {
      resetLocalBuddyRestartBudget();
    }
    localBuddyRuntimeEnabled = nextEnabled;
    const action = resolveLocalBuddyRuntimeAction(Boolean(localBuddyProc), nextEnabled);
    if (action === "start") {
      const startGate = resolveLocalBuddyStartGate({
        nowMs: Date.now(),
        retryAfterMs: localBuddyRetryAfterMs,
        consecutiveFailures: localBuddyConsecutiveFailures,
        maxConsecutiveFailures: LOCALBUDDY_MAX_CONSECUTIVE_FAILURES,
      });
      if (startGate === "retry_exhausted" || startGate === "backoff") {
        return;
      }
      const portAvailable = await isPortAvailable(nextPort);
      if (!portAvailable) {
        markLocalBuddyUnexpectedFailure(`port ${nextPort} is unavailable`);
        return;
      }
      if (previousEnabled !== nextEnabled) {
        console.log(
          "[start] LocalBuddy enabled via runtime config (localbuddy.enabled=true); starting LocalBuddy.",
        );
      } else {
        console.log("[start] LocalBuddy is enabled but not running; starting LocalBuddy.");
      }
      try {
        await ensureLocalBuddyManagedStartReady(bunExecPath);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`[start] LocalBuddy readiness preflight failed: ${detail}`);
        markLocalBuddyUnexpectedFailure(`preflight failed: ${detail}`);
        return;
      }
      await startLocalBuddyManagedProcess("runtime config enabled", bunExecPath);
      return;
    }
    if (action === "stop") {
      if (previousEnabled !== nextEnabled) {
        console.log(
          "[start] LocalBuddy disabled via runtime config (localbuddy.enabled=false); stopping LocalBuddy.",
        );
      } else {
        console.log("[start] LocalBuddy is disabled but still running; stopping LocalBuddy.");
      }
      await stopLocalBuddyManagedProcess("runtime config disabled");
      resetLocalBuddyRestartBudget();
    }
  } catch (err) {
    console.warn(`[start] LocalBuddy runtime config poll failed: ${String(err)}`);
  } finally {
    localBuddyConfigPollInFlight = false;
  }
}

function startLocalBuddyRuntimeConfigPolling(bunExecPath: string): void {
  if (localBuddyConfigPollTimer) return;
  localBuddyConfigPollTimer = setInterval(() => {
    void syncLocalBuddyRuntimeConfig(bunExecPath);
  }, LOCALBUDDY_RUNTIME_CONFIG_POLL_MS);
}

function stopLocalBuddyRuntimeConfigPolling(): void {
  if (!localBuddyConfigPollTimer) return;
  clearInterval(localBuddyConfigPollTimer);
  localBuddyConfigPollTimer = null;
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

type StartupPortSpec = {
  name: string;
  port: number;
};

type ListeningProcess = {
  pid: number;
  name: string;
  commandLine: string;
};

function startupPortPreflightEnabled(): boolean {
  return CONFIG.startup.portPreflight;
}

function startupPortConflictPolicy(): "fail" | "terminate_pushpals" {
  return CONFIG.startup.portConflictPolicy;
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/");
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function isLikelyPushPalsListener(listener: ListeningProcess): boolean {
  const processName = normalizeForMatch(listener.name);
  if (
    processName === "powershell.exe" ||
    processName === "pwsh.exe" ||
    processName === "cmd.exe" ||
    processName === "conhost.exe"
  ) {
    return false;
  }

  const haystack = normalizeForMatch(`${listener.name} ${listener.commandLine}`);
  if (!haystack) return false;

  const repoHint = normalizeForMatch(repoRoot);
  if (repoHint && haystack.includes(repoHint)) return true;

  return (
    haystack.includes("/pushpals/") ||
    haystack.includes("scripts/start.ts") ||
    haystack.includes("scripts/start-client.ts") ||
    haystack.includes("apps/localbuddy") ||
    haystack.includes("apps/remotebuddy") ||
    haystack.includes("apps/workerpals") ||
    haystack.includes("apps/source_control_manager") ||
    haystack.includes("apps/server") ||
    haystack.includes("src/server_main.ts") ||
    haystack.includes("src/localbuddy_main.ts") ||
    haystack.includes("src/remotebuddy_main.ts") ||
    haystack.includes("src/workerpals_main.ts") ||
    haystack.includes("src/source_control_manager_main.ts")
  );
}

function isLikelyWorkerPalsProcess(listener: ListeningProcess): boolean {
  if (listener.pid === process.pid) return false;

  const processName = normalizeForMatch(listener.name);
  if (processName === "conhost.exe") return false;

  const haystack = normalizeForMatch(`${listener.name} ${listener.commandLine}`);
  if (!haystack) return false;

  const repoHint = normalizeForMatch(repoRoot);
  if (repoHint && !haystack.includes(repoHint)) return false;

  return (
    haystack.includes("src/workerpals_main.ts") ||
    haystack.includes("apps/workerpals") ||
    haystack.includes("workerpals:only")
  );
}

function resolveConcurrentlyCommand(bunExecPath: string): string[] {
  try {
    const req = createRequire(resolve(repoRoot, "package.json"));
    const packageJsonPath = req.resolve("concurrently/package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binField = packageJson.bin;
    const binRelative =
      typeof binField === "string"
        ? binField
        : typeof binField?.concurrently === "string"
          ? binField.concurrently
          : Object.values(binField ?? {}).find((value) => typeof value === "string");
    if (typeof binRelative === "string" && binRelative.trim()) {
      return [bunExecPath, resolve(dirname(packageJsonPath), binRelative)];
    }
  } catch {}
  return [bunExecPath, "x", "concurrently"];
}

function requiredStartupPorts(): StartupPortSpec[] {
  const rawPorts: StartupPortSpec[] = [
    { name: "Server", port: CONFIG.server.port },
    { name: "SourceControlManager", port: CONFIG.sourceControlManager.port },
  ];
  if (LOCALBUDDY_ENABLED) {
    rawPorts.splice(1, 0, { name: "LocalBuddy", port: CONFIG.localbuddy.port });
  }

  const out: StartupPortSpec[] = [];
  const seen = new Set<number>();
  for (const item of rawPorts) {
    const port = Math.floor(item.port);
    if (!Number.isFinite(port) || port < 1 || port > 65_535) continue;
    if (seen.has(port)) continue;
    seen.add(port);
    out.push({ name: item.name, port });
  }
  return out;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveAvailability) => {
    const server = createServer();
    let settled = false;

    const settle = (available: boolean) => {
      if (settled) return;
      settled = true;
      resolveAvailability(available);
    };

    server.once("error", () => {
      try {
        server.close();
      } catch {}
      settle(false);
    });

    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => settle(true));
    });
  });
}

function parseJsonLoose(text: string): any {
  const raw = text.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeListenerRows(parsed: any): ListeningProcess[] {
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const out: ListeningProcess[] = [];
  const seen = new Set<number>();

  for (const row of rows) {
    const pid = Number.parseInt(String(row?.pid ?? row?.ProcessId ?? ""), 10);
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    out.push({
      pid,
      name: String(row?.name ?? row?.Name ?? "").trim(),
      commandLine: String(row?.commandLine ?? row?.CommandLine ?? "").trim(),
    });
  }

  return out;
}

function parseWindowsNetstatListeningPids(stdout: string, port: number): number[] {
  const out = new Set<number>();
  const targetPort = String(port);

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!/\bLISTENING\b/i.test(line)) continue;

    const cols = line.split(/\s+/);
    if (cols.length < 5) continue;

    const localAddress = cols[1] ?? "";
    const pidToken = cols[4] ?? "";
    const portMatch = localAddress.match(/:(\d+)$/);
    if (!portMatch) continue;
    if (portMatch[1] !== targetPort) continue;

    const pid = Number.parseInt(pidToken, 10);
    if (Number.isFinite(pid) && pid > 0) out.add(pid);
  }

  return Array.from(out);
}

function parseTasklistName(stdout: string): string {
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !/no tasks are running/i.test(item));
  if (!line) return "";
  if (line.startsWith('"') && line.endsWith('"')) {
    const cols = line.slice(1, -1).split('","');
    return (cols[0] ?? "").trim();
  }
  const cols = line.split(/\s+/);
  return (cols[0] ?? "").trim();
}

async function describeWindowsPid(pid: number): Promise<ListeningProcess> {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    "if ($null -eq $proc) { '{}' } else {",
    "  [pscustomobject]@{ pid = [int]$proc.ProcessId; name = [string]$proc.Name; commandLine = [string]$proc.CommandLine } | ConvertTo-Json -Compress",
    "}",
  ].join("; ");
  const cim = await runCapture(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
    repoRoot,
  );
  if (cim.ok && cim.stdout.trim()) {
    const parsed = parseJsonLoose(cim.stdout);
    const rows = normalizeListenerRows(parsed);
    if (rows.length > 0) return rows[0];
  }

  const tasklist = await runCapture(
    ["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    repoRoot,
  );
  const name = tasklist.ok ? parseTasklistName(tasklist.stdout) : "";
  return {
    pid,
    name,
    commandLine: "",
  };
}

async function listPortListenersWindows(port: number): Promise<ListeningProcess[]> {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$pids = @(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess -Unique)`,
    "$rows = @()",
    "foreach ($pid in $pids) {",
    "  if (-not $pid) { continue }",
    '  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pid"',
    "  if ($null -eq $proc) { continue }",
    "  $rows += [pscustomobject]@{ pid = [int]$proc.ProcessId; name = [string]$proc.Name; commandLine = [string]$proc.CommandLine }",
    "}",
    "if ($rows.Count -eq 0) { '[]' } else { $rows | ConvertTo-Json -Compress }",
  ].join("; ");

  const result = await runCapture(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
    repoRoot,
  );
  if (!result.stdout.trim()) return [];

  const parsed = parseJsonLoose(result.stdout);
  const direct = normalizeListenerRows(parsed);
  if (direct.length > 0) return direct;

  const netstat = await runCapture(["netstat", "-ano", "-p", "tcp"], repoRoot);
  if (!netstat.ok || !netstat.stdout.trim()) return [];
  const pids = parseWindowsNetstatListeningPids(netstat.stdout, port);
  if (pids.length === 0) return [];

  const described: ListeningProcess[] = [];
  for (const pid of pids) {
    described.push(await describeWindowsPid(pid));
  }
  return described;
}

async function describePosixPid(pid: number): Promise<ListeningProcess> {
  const [nameResult, argsResult] = await Promise.all([
    runCapture(["ps", "-p", String(pid), "-o", "comm="], repoRoot),
    runCapture(["ps", "-p", String(pid), "-o", "args="], repoRoot),
  ]);

  return {
    pid,
    name: (nameResult.stdout || "").trim(),
    commandLine: (argsResult.stdout || "").trim(),
  };
}

async function listPortListenersPosix(port: number): Promise<ListeningProcess[]> {
  const pids = new Set<number>();

  const lsofResult = await runCapture(
    ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    repoRoot,
  );
  if (lsofResult.ok && lsofResult.stdout) {
    for (const line of lsofResult.stdout.split(/\r?\n/)) {
      const pid = Number.parseInt(line.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
  }

  if (pids.size === 0) {
    const netstatResult = await runCapture(["netstat", "-ltnp"], repoRoot);
    if (netstatResult.ok && netstatResult.stdout) {
      for (const line of netstatResult.stdout.split(/\r?\n/)) {
        if (!line.includes("LISTEN") || !line.includes(`:${port}`)) continue;
        const cols = line.trim().split(/\s+/);
        const pidProgram = cols[cols.length - 1] ?? "";
        const pidToken = pidProgram.split("/", 1)[0] ?? "";
        const pid = Number.parseInt(pidToken, 10);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
    }
  }

  const out: ListeningProcess[] = [];
  for (const pid of pids) {
    out.push(await describePosixPid(pid));
  }
  return out;
}

async function listPortListeners(port: number): Promise<ListeningProcess[]> {
  if (process.platform === "win32") {
    return listPortListenersWindows(port);
  }
  return listPortListenersPosix(port);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(pid: number): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;

  if (process.platform === "win32") {
    const result = await runCapture(["taskkill", "/PID", String(pid), "/T", "/F"], repoRoot);
    return result.ok;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  await delay(100);
  return !isPidAlive(pid);
}

async function listLikelyPushPalsHostProcessesWindows(): Promise<ListeningProcess[]> {
  const repoNeedle = normalizeForMatch(repoRoot);
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$needle = '${escapePowerShellSingleQuoted(repoNeedle)}'`,
    "$rows = Get-CimInstance Win32_Process | Where-Object {",
    "  $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle)",
    "} | Select-Object @{n='pid';e={[int]$_.ProcessId}}, @{n='name';e={[string]$_.Name}}, @{n='commandLine';e={[string]$_.CommandLine}}",
    "if ($rows.Count -eq 0) { '[]' } else { $rows | ConvertTo-Json -Compress }",
  ].join("; ");

  const result = await runCapture(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
    repoRoot,
  );
  if (!result.ok || !result.stdout.trim()) return [];
  const parsed = parseJsonLoose(result.stdout);
  return normalizeListenerRows(parsed).filter(
    (listener) => listener.pid !== process.pid && isLikelyPushPalsListener(listener),
  );
}

async function listLikelyWorkerPalsProcessesWindows(): Promise<ListeningProcess[]> {
  const repoNeedle = normalizeForMatch(repoRoot);
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$needle = '${escapePowerShellSingleQuoted(repoNeedle)}'`,
    "$rows = Get-CimInstance Win32_Process | Where-Object {",
    "  $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle)",
    "} | Select-Object @{n='pid';e={[int]$_.ProcessId}}, @{n='name';e={[string]$_.Name}}, @{n='commandLine';e={[string]$_.CommandLine}}",
    "if ($rows.Count -eq 0) { '[]' } else { $rows | ConvertTo-Json -Compress }",
  ].join("; ");

  const result = await runCapture(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
    repoRoot,
  );
  if (!result.ok || !result.stdout.trim()) return [];
  const parsed = parseJsonLoose(result.stdout);
  return normalizeListenerRows(parsed).filter((listener) => isLikelyWorkerPalsProcess(listener));
}

async function listLikelyWorkerPalsProcessesPosix(): Promise<ListeningProcess[]> {
  const result = await runCapture(["ps", "-eo", "pid=,comm=,args="], repoRoot);
  if (!result.ok || !result.stdout.trim()) return [];

  const out: ListeningProcess[] = [];
  const seen = new Set<number>();
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    const row: ListeningProcess = {
      pid,
      name: match[2] ?? "",
      commandLine: match[3] ?? "",
    };
    if (isLikelyWorkerPalsProcess(row)) {
      out.push(row);
    }
  }
  return out;
}

async function listLikelyWorkerPalsProcesses(): Promise<ListeningProcess[]> {
  if (process.platform === "win32") {
    return listLikelyWorkerPalsProcessesWindows();
  }
  return listLikelyWorkerPalsProcessesPosix();
}

async function cleanupStaleWorkerPalsProcesses(): Promise<void> {
  const initial = await listLikelyWorkerPalsProcesses();
  if (initial.length === 0) return;

  console.warn(
    `[start] Startup preflight: found ${initial.length} stale WorkerPals process(es); terminating before warmup.`,
  );

  let terminated = 0;
  for (const candidate of initial) {
    const summary = shortCommandLine(candidate.commandLine) || "<no command line>";
    console.warn(
      `[start] Startup preflight: terminating stale WorkerPals pid=${candidate.pid} (${candidate.name || "unknown"}) ${summary}`,
    );
    if (await terminateProcess(candidate.pid)) {
      terminated += 1;
    } else {
      console.warn(
        `[start] Startup preflight: failed to terminate stale WorkerPals pid=${candidate.pid}.`,
      );
    }
  }

  if (terminated > 0) {
    await delay(400);
  }

  const remaining = await listLikelyWorkerPalsProcesses();
  if (remaining.length > 0) {
    console.error(
      `[start] Startup preflight: ${remaining.length} stale WorkerPals process(es) remain after cleanup.`,
    );
    for (const candidate of remaining) {
      const summary = shortCommandLine(candidate.commandLine) || "<no command line>";
      console.error(
        `[start]   pid=${candidate.pid} name=${candidate.name || "unknown"} cmd=${summary}`,
      );
    }
    console.error(
      "[start] Stop remaining stale WorkerPals processes and retry. This prevents warmup worktree races.",
    );
    abortStart(1);
  }

  console.log(`[start] Startup preflight: terminated ${terminated} stale WorkerPals process(es).`);
}

async function terminateLikelyPushPalsHostProcessesWindows(): Promise<number> {
  const candidates = await listLikelyPushPalsHostProcessesWindows();
  let terminated = 0;

  for (const candidate of candidates) {
    const summary = shortCommandLine(candidate.commandLine) || "<no command line>";
    console.warn(
      `[start] Port preflight fallback: terminating likely stale PushPals host process pid=${candidate.pid} (${candidate.name || "unknown"}) ${summary}`,
    );
    if (await terminateProcess(candidate.pid)) {
      terminated += 1;
      continue;
    }
    console.warn(`[start] Port preflight fallback: failed to terminate pid ${candidate.pid}.`);
  }

  return terminated;
}

function shortCommandLine(value: string, maxChars = 180): string {
  const text = (value || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

async function ensureServicePortsAvailable(): Promise<void> {
  if (!startupPortPreflightEnabled()) return;

  const specs = requiredStartupPorts();
  const conflicts: Array<{ spec: StartupPortSpec; listeners: ListeningProcess[] }> = [];
  let attemptedWindowsFallbackCleanup = false;

  for (const spec of specs) {
    if (await isPortAvailable(spec.port)) continue;

    let listeners = await listPortListeners(spec.port);
    if (startupPortConflictPolicy() === "terminate_pushpals" && listeners.length > 0) {
      const staleCandidates = listeners.filter(
        (listener) => listener.pid !== process.pid && isLikelyPushPalsListener(listener),
      );
      for (const candidate of staleCandidates) {
        const summary = shortCommandLine(candidate.commandLine) || "<no command line>";
        console.warn(
          `[start] Port ${spec.port} occupied by stale PushPals process; terminating pid=${candidate.pid} (${candidate.name || "unknown"}) ${summary}`,
        );
        const terminated = await terminateProcess(candidate.pid);
        if (!terminated) {
          console.warn(`[start] Failed to terminate pid ${candidate.pid} on port ${spec.port}.`);
        }
      }

      if (staleCandidates.length > 0) {
        await delay(300);
        if (await isPortAvailable(spec.port)) continue;
        listeners = await listPortListeners(spec.port);
      }
    }

    if (
      startupPortConflictPolicy() === "terminate_pushpals" &&
      process.platform === "win32" &&
      !attemptedWindowsFallbackCleanup
    ) {
      const anyKnownPushPals = listeners.some((listener) => isLikelyPushPalsListener(listener));
      if (!anyKnownPushPals) {
        attemptedWindowsFallbackCleanup = true;
        const terminated = await terminateLikelyPushPalsHostProcessesWindows();
        if (terminated > 0) {
          await delay(500);
          if (await isPortAvailable(spec.port)) continue;
          listeners = await listPortListeners(spec.port);
        }
      }
    }

    conflicts.push({ spec, listeners });
  }

  if (conflicts.length === 0) return;

  console.error("[start] Required service port(s) are already in use:");
  for (const conflict of conflicts) {
    console.error(`[start] - ${conflict.spec.name} (${conflict.spec.port})`);
    if (conflict.listeners.length === 0) {
      console.error(
        `[start]   owner: unavailable (could not resolve process for port ${conflict.spec.port})`,
      );
      continue;
    }
    for (const listener of conflict.listeners) {
      const summary = shortCommandLine(listener.commandLine) || "<no command line>";
      console.error(
        `[start]   pid=${listener.pid} name=${listener.name || "unknown"} cmd=${summary}`,
      );
    }
  }

  if (startupPortConflictPolicy() === "fail") {
    console.error(
      '[start] Set startup.port_conflict_policy = "terminate_pushpals" to auto-clean stale PushPals listeners.',
    );
  } else {
    console.error(
      "[start] One or more conflicting listeners are not recognized as PushPals processes; stop them manually and retry.",
    );
  }
  abortStart(1);
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
  const probeSaysReachable = /\bworkerpal llm probe:\s+reachable\b/i.test(value);
  if (probeSaysReachable) return false;
  return (
    value.includes("could not reach llm endpoint") ||
    value.includes("workerpal llm probe failed") ||
    value.includes("[llm-probe-container] unreachable") ||
    value.includes("connection refused") ||
    value.includes("name or service not known") ||
    value.includes("network is unreachable") ||
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

  const combined = `${terminal.summary}\n${llmProbe}\n${terminal.logTail.join("\n")}`.slice(
    0,
    12_000,
  );
  const likelyLlmIssue = isLikelyLlmReachabilityFailure(combined);
  const alert = likelyLlmIssue
    ? `${terminal.summary} Likely cause: WorkerPal LLM endpoint is unavailable or timing out. ${llmProbe}`
    : `${terminal.summary} WorkerPal LLM endpoint appears reachable. Likely cause: warm OpenHands agent health checks are failing inside Docker. ${llmProbe}`;
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

function ghRefreshOnStartEnabled(): boolean {
  const raw = (process.env.PUSHPALS_GH_AUTH_REFRESH_ON_START ?? "").trim().toLowerCase();
  if (!raw) return true;
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}
let ghRefreshOnStartAttempted = false;
let ghAuthPreflightSatisfied = false;
let ghLastRefreshEnteredDeviceFlow = false;

async function ghAuthStatusOk(): Promise<boolean> {
  return (
    (await runQuiet(["gh", "auth", "status", "--hostname", "github.com"])) === 0 ||
    (await runQuiet(["gh", "auth", "status"])) === 0
  );
}

async function ghApiAccessOk(): Promise<boolean> {
  // Verifies that the active gh token can actually call GitHub APIs.
  return (await runQuiet(["gh", "api", "user", "--hostname", "github.com"])) === 0;
}

async function exportGitTokenFromGhAuth(): Promise<boolean> {
  const tokenResult = await runCapture(
    ["gh", "auth", "token", "--hostname", "github.com"],
    repoRoot,
  );
  if (!tokenResult.ok) return false;
  const token = tokenResult.stdout.trim();
  if (!token) return false;
  process.env.PUSHPALS_GIT_TOKEN = token;
  return true;
}

function openUrlInBrowser(url: string): boolean {
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(["cmd", "/c", "start", "", url], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      void proc.exited;
      return true;
    }
    if (process.platform === "darwin") {
      const proc = Bun.spawn(["open", url], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      void proc.exited;
      return true;
    }
    const proc = Bun.spawn(["xdg-open", url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    void proc.exited;
    return true;
  } catch {
    return false;
  }
}

async function attemptGhAuthRefresh(
  reason: string,
  opts: { allowInteractive?: boolean } = {},
): Promise<boolean> {
  const allowInteractive = opts.allowInteractive ?? false;
  ghLastRefreshEnteredDeviceFlow = false;
  let openedDeviceFlowUrl = false;
  let deviceFlowDetected = false;
  console.log(`[start] ${reason} Attempting non-interactive \`gh auth refresh\`...`);
  try {
    const proc = Bun.spawn(["gh", "auth", "refresh", "-h", "github.com"], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
      },
    });
    let stderrTail = "";
    const maybeHandleDeviceFlowUrl = (text: string): void => {
      stderrTail = `${stderrTail}${text}`;
      if (stderrTail.length > 2048) {
        stderrTail = stderrTail.slice(-2048);
      }
      const match = stderrTail.match(/https:\/\/github\.com\/login\/device[^\s)]*/i);
      if (!match || openedDeviceFlowUrl) return;
      const url = match[0];
      openedDeviceFlowUrl = true;
      if (openUrlInBrowser(url)) {
        console.log(`[start] Opened browser for GitHub device flow: ${url}`);
      } else {
        console.warn(`[start] Could not auto-open browser. Open this URL manually: ${url}`);
      }
      deviceFlowDetected = true;
      if (!allowInteractive) {
        try {
          proc.kill();
        } catch {
          // ignore
        }
      }
    };
    const streamToTerminal = async (
      stream: ReadableStream<Uint8Array> | null,
      write: (value: string) => void,
      onChunk?: (value: string) => void,
    ): Promise<void> => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (!chunk) continue;
          write(chunk);
          if (onChunk) onChunk(chunk);
        }
        const tail = decoder.decode();
        if (tail) {
          write(tail);
          if (onChunk) onChunk(tail);
        }
      } finally {
        reader.releaseLock();
      }
    };
    const stdoutPump = streamToTerminal(proc.stdout, (value) => process.stdout.write(value));
    const stderrPump = streamToTerminal(
      proc.stderr,
      (value) => process.stderr.write(value),
      maybeHandleDeviceFlowUrl,
    );
    const timeoutMs = allowInteractive ? 180_000 : 12_000;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);
    const exitCode = await proc.exited;
    await Promise.allSettled([stdoutPump, stderrPump]);
    clearTimeout(timeout);
    if (deviceFlowDetected) {
      ghLastRefreshEnteredDeviceFlow = true;
      if (!allowInteractive) {
        console.warn(
          "[start] Non-interactive `gh auth refresh` entered device flow and requires browser completion.",
        );
        return false;
      }
      if (timedOut) {
        console.error(
          `[start] GitHub device-flow authentication did not complete within ${Math.round(
            timeoutMs / 1000,
          )}s. Complete it in browser and rerun startup.`,
        );
        return false;
      }
      if (exitCode === 0) {
        ghLastRefreshEnteredDeviceFlow = false;
        return ghAuthStatusOk();
      }
      console.error(
        "[start] GitHub device-flow authentication did not complete successfully. Finish browser auth and rerun startup.",
      );
      return false;
    }
    if (timedOut) {
      console.warn(
        `[start] Non-interactive \`gh auth refresh\` timed out after ${timeoutMs}ms; continuing startup.`,
      );
      return false;
    }
    if (exitCode === 0) {
      return ghAuthStatusOk();
    }
  } catch {
    // Continue to optional interactive fallback below.
  }

  if (!allowInteractive) {
    console.warn("[start] `gh auth refresh` did not succeed in non-interactive mode.");
    return false;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.warn("[start] Unable to run interactive `gh auth refresh` (non-interactive shell).");
    return false;
  }

  const deviceFlowUrl = "https://github.com/login/device";
  if (!openedDeviceFlowUrl && openUrlInBrowser(deviceFlowUrl)) {
    console.log(`[start] Opened browser for GitHub device flow: ${deviceFlowUrl}`);
  } else if (!openedDeviceFlowUrl) {
    console.warn(`[start] Could not auto-open browser. Open this URL manually: ${deviceFlowUrl}`);
  } else {
    console.log("[start] Browser was already opened for GitHub device flow.");
  }
  console.log(
    "[start] Non-interactive refresh failed; opening browser auth flow via `gh auth login --web`...",
  );
  const loginExitCode = await runInherited(
    ["gh", "auth", "login", "--hostname", "github.com", "--web"],
    repoRoot,
  );
  if (loginExitCode !== 0) {
    console.warn("[start] Interactive GitHub auth login did not succeed.");
    return false;
  }
  return ghAuthStatusOk();
}

async function ensureGitHubAuthPreflight(): Promise<void> {
  const skipCheck = envTruthy("PUSHPALS_SKIP_GH_AUTH_CHECK");
  const sourceControlManagerPushDisabled = envTruthy("SOURCE_CONTROL_MANAGER_NO_PUSH");
  if (skipCheck || sourceControlManagerPushDisabled) {
    const reason = skipCheck ? "PUSHPALS_SKIP_GH_AUTH_CHECK=1" : "SOURCE_CONTROL_MANAGER_NO_PUSH=1";
    console.log(`[start] GitHub auth preflight skipped (${reason}).`);
    ghAuthPreflightSatisfied = true;
    return;
  }

  const gitToken = CONFIG.gitToken;
  if (gitToken) {
    process.env.PUSHPALS_GIT_TOKEN = gitToken;
    ghAuthPreflightSatisfied = true;
    console.log("[start] GitHub auth preflight: token is configured via env/config.");
    return;
  }

  const ghAvailable = (await runQuiet(["gh", "--version"])) === 0;
  if (!ghAvailable) {
    console.error("[start] GitHub auth preflight failed: `gh` CLI is not installed.");
    console.error(
      "[start] Install GitHub CLI or set one of: PUSHPALS_GIT_TOKEN, GITHUB_TOKEN, GH_TOKEN.",
    );
    abortStart(1);
  }

  const ghAuthed = await ghAuthStatusOk();
  if (!ghAuthed) {
    console.error("[start] GitHub auth preflight failed: GitHub CLI is not authenticated.");
    console.error("[start] Run: gh auth login --hostname github.com --web");
    abortStart(1);
  }

  const apiAccessOk = await ghApiAccessOk();
  if (!apiAccessOk) {
    console.error(
      "[start] GitHub auth preflight failed: authenticated CLI token cannot access GitHub API.",
    );
    console.error("[start] Run: gh auth refresh -h github.com");
    abortStart(1);
  }

  const exported = await exportGitTokenFromGhAuth();
  if (exported) {
    console.log(
      "[start] GitHub auth preflight: authenticated and token exported for startup services.",
    );
  } else {
    console.warn(
      "[start] GitHub auth preflight: authenticated, but `gh auth token` export failed. Services will use direct gh auth as needed.",
    );
  }
  ghAuthPreflightSatisfied = true;
}

async function ensureGitHubAuth(force = false): Promise<void> {
  if (ghAuthPreflightSatisfied) {
    return;
  }

  const skipCheck = envTruthy("PUSHPALS_SKIP_GH_AUTH_CHECK");
  const sourceControlManagerPushDisabled = envTruthy("SOURCE_CONTROL_MANAGER_NO_PUSH");
  if (!force && (skipCheck || sourceControlManagerPushDisabled)) {
    return;
  }

  const gitToken = CONFIG.gitToken;
  if (gitToken) {
    process.env.PUSHPALS_GIT_TOKEN = gitToken;
    ghAuthPreflightSatisfied = true;
    return;
  }

  const ghAvailable = (await runQuiet(["gh", "--version"])) === 0;
  if (ghAvailable) {
    if (ghRefreshOnStartEnabled() && !ghRefreshOnStartAttempted) {
      ghRefreshOnStartAttempted = true;
      const allowInteractiveRefresh = process.stdin.isTTY && process.stdout.isTTY;
      const refreshed = await attemptGhAuthRefresh(
        "GitHub CLI auth refresh-on-start is enabled (PUSHPALS_GH_AUTH_REFRESH_ON_START=1).",
        { allowInteractive: allowInteractiveRefresh },
      );
      if (!refreshed) {
        if (allowInteractiveRefresh) {
          console.error(
            "[start] GitHub auth refresh-on-start did not complete. Finish browser authentication and rerun.",
          );
          abortStart(1);
        } else {
          console.warn(
            "[start] GitHub auth refresh-on-start could not run interactively in this shell; continuing with existing auth checks.",
          );
        }
      }
    }

    let ghAuthed = await ghAuthStatusOk();
    if (!ghAuthed) {
      console.log("[start] GitHub CLI is not authenticated. Starting `gh auth login`...");
      const loginExitCode = await runInherited(
        ["gh", "auth", "login", "--hostname", "github.com", "--web"],
        repoRoot,
      );
      if (loginExitCode !== 0) {
        console.error("[start] `gh auth login` failed.");
        abortStart(loginExitCode);
      }
      ghAuthed = await ghAuthStatusOk();
      if (!ghAuthed) {
        console.error("[start] GitHub CLI is still not authenticated after login.");
        abortStart(1);
      }
    }

    let apiAccessOk = await ghApiAccessOk();
    if (!apiAccessOk) {
      const refreshed = await attemptGhAuthRefresh(
        "GitHub CLI auth is present but API validation failed.",
        { allowInteractive: true },
      );
      if (!refreshed && ghLastRefreshEnteredDeviceFlow) {
        console.error(
          "[start] GitHub device-flow authentication is pending. Complete browser authentication and rerun startup.",
        );
        abortStart(1);
      }
      apiAccessOk = refreshed ? await ghApiAccessOk() : false;
    }
    if (!apiAccessOk) {
      console.log(
        "[start] GitHub CLI token could not access GitHub API. Starting `gh auth login`...",
      );
      const loginExitCode = await runInherited(
        ["gh", "auth", "login", "--hostname", "github.com", "--web"],
        repoRoot,
      );
      if (loginExitCode !== 0) {
        console.error("[start] `gh auth login` failed.");
        abortStart(loginExitCode);
      }
      const apiAccessAfterLogin = await ghApiAccessOk();
      if (!apiAccessAfterLogin) {
        console.error("[start] GitHub CLI auth exists, but API access is still failing.");
        abortStart(1);
      }
    }

    const exported = await exportGitTokenFromGhAuth();
    if (exported) {
      console.log(
        "[start] GitHub CLI auth preflight: authenticated and token exported for startup services.",
      );
    } else {
      console.warn(
        "[start] GitHub CLI auth is valid, but `gh auth token` export failed. Services will fall back to direct gh auth when needed.",
      );
    }
    ghAuthPreflightSatisfied = true;
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
let proc: SpawnedChild | null = null;
const shutdown = async (code: number) => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    proc?.kill();
  } catch {}
  stopLocalBuddyRuntimeConfigPolling();
  await stopLocalBuddyManagedProcess("shutdown");
  await cleanupWorkerWarmContainers("shutdown");
  await stopManagedLmStudio();
  await closeSystemLog();
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
  await ensureWorkspaceDependenciesInstalled();
  sanitizeWindowsWatcherPaths();
  const localConfigPaths = ensureRequiredLocalConfigFiles();
  ensureLocalConfigTemplateKeyParity(localConfigPaths);
  ensureAutonomyVisionFile();
  logEffectiveConfigSnapshot();
  await ensureServicePortsAvailable();
  await cleanupStaleWorkerPalsProcesses();
  await ensureCodexCliAuthPreflight();
  await ensureGitHubAuthPreflight();
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
  await closeSystemLog();
  if (err instanceof StartAbort) {
    process.exit(err.exitCode);
  }
  console.error(`[start] Unexpected startup failure: ${String(err)}`);
  process.exit(1);
}

const bunExecPath = (process.execPath ?? "").trim() || "bun";
const serviceSpecs = buildCoreManagedServiceSpecs();
console.log(`[start] Runtime logs are being written to ${relSystemLogPath()}.`);
if (!LOCALBUDDY_ENABLED) {
  console.log(
    "[start] LocalBuddy disabled (localbuddy.enabled=false); skipping LocalBuddy startup and LLM preflight.",
  );
}
console.log("[start] Building protocol package before launching managed services...");
const protocolBuildExit = await runInherited([bunExecPath, "run", "protocol:build"], repoRoot);
if (protocolBuildExit !== 0) {
  await cleanupWorkerWarmContainers("protocol build failure");
  await stopManagedLmStudio();
  await closeSystemLog();
  process.exit(protocolBuildExit);
}
console.log(
  `[start] Launching managed services: ${serviceSpecs.map((spec) => spec.name).join(", ")}.`,
);
const concurrentlyCommand = [
  ...resolveConcurrentlyCommand(bunExecPath),
  "-p",
  "[{time}][{name}]",
  "-t",
  "HH:mm:ss",
  "-n",
  serviceSpecs.map((spec) => spec.name).join(","),
  "-c",
  serviceSpecs.map((spec) => spec.color).join(","),
  ...serviceSpecs.map((spec) => spec.command),
];
proc = Bun.spawn(concurrentlyCommand, {
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env },
});
startSystemLogTail();

if (LOCALBUDDY_ENABLED) {
  await startLocalBuddyManagedProcess("startup config enabled", bunExecPath);
}
startLocalBuddyRuntimeConfigPolling(bunExecPath);

const devStdoutPump = pipeProcStreamToSystemLog(proc.stdout);
const devStderrPump = pipeProcStreamToSystemLog(proc.stderr);

const startupWarmupPromise = runStartupWarmup().catch((err) => {
  console.warn(`[start] Startup warmup failed: ${String(err)}`);
});

const exitCode = await proc.exited;
await Promise.allSettled([devStdoutPump, devStderrPump]);
await Promise.race([
  startupWarmupPromise,
  new Promise((resolveWait) => setTimeout(resolveWait, 500)),
]);
stopLocalBuddyRuntimeConfigPolling();
await stopLocalBuddyManagedProcess("core services exit");
await cleanupWorkerWarmContainers("managed services exit");
await stopManagedLmStudio();
await closeSystemLog();
process.exit(exitCode);
