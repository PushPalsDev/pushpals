#!/usr/bin/env bun

import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, delimiter, dirname, extname, join, resolve, win32 as pathWin32 } from "path";
import { createInterface, type Interface } from "readline";
import {
  ServiceManager,
  computeServiceRestartBackoffMs,
  formatEmbeddedRuntimeHealthLines as formatSharedEmbeddedRuntimeHealthLines,
  shouldRestartService,
  type EmbeddedRuntimeHealth,
  type ManagedServiceProcess,
} from "./start_runtime_services.js";
import { forceDeleteWorktreePath } from "../apps/workerpals/src/common/worktree_cleanup.js";
import {
  evaluateClientRuntimePreflight,
  formatClientRuntimePreflightLines,
  type ClientRuntimePreflightResult,
} from "../packages/shared/src/client_preflight.js";
import { normalizePresenceLookupToken } from "../packages/shared/src/communication.js";
import { resolveGitStateFilePath } from "../packages/shared/src/repo.js";
import { shouldDisplayInteractiveSessionEvent } from "../packages/shared/src/session_event_visibility.js";

type CliOptions = {
  serverUrl?: string;
  localAgentUrl?: string;
  sessionId?: string;
  monitoringHubUrl?: string;
  runtimeRoot?: string;
  runtimeTag?: string;
  noAutoStart: boolean;
  noStream: boolean;
  runtimeOnly: boolean;
  statusOnce: boolean;
  clear: boolean;
};

type LocalBuddyHealth = {
  ok?: boolean;
  agentId?: string;
  repo?: string;
  sessionId?: string;
};

type CliState = {
  monitoringHubUrl?: string;
  serverUrl?: string;
  localAgentUrl?: string;
  sessionId?: string;
  repoRoot?: string;
  pushpalsLogPath?: string;
  updatedAt?: string;
};

type CliClearTarget = {
  label: string;
  path: string;
};

type CliClearFailure = CliClearTarget & {
  detail: string;
};

type SessionStreamPayload = {
  envelope?: {
    id?: string;
    type?: string;
    from?: string;
    ts?: string;
    payload?: Record<string, unknown>;
  };
  cursor?: number;
};

type SessionEventReplayFilter = {
  shouldRender: (event: NonNullable<SessionStreamPayload["envelope"]>) => boolean;
};

type SystemStatusClientRow = {
  clientId?: unknown;
  kind?: unknown;
  label?: unknown;
  sessionId?: unknown;
  status?: unknown;
  connectedTransports?: unknown;
};

type WorkerStatusRow = {
  workerId?: unknown;
  status?: unknown;
  isOnline?: unknown;
  activeJobCount?: unknown;
};

type RemoteBuddySessionConsumerHealth = {
  ok: boolean;
  detail: string;
  clientId?: string;
  sessionId?: string;
};

type RemoteBuddyAutonomousEngineState = "unknown" | "enabled" | "disabled";
type SourceControlManagerGitPrecheckResult =
  | { status: "ok"; detail: string; env: Record<string, string> }
  | { status: "skipped"; detail: string; env: Record<string, string> }
  | { status: "failed"; detail: string; env: Record<string, string> };
type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};
type WorkerpalDockerPrecheckResult =
  | { status: "ok"; detail: string; env: Record<string, string> }
  | { status: "skipped"; detail: string; env: Record<string, string> }
  | { status: "failed"; detail: string; env: Record<string, string> };
type GitRemoteCheckResult =
  | { status: "ok"; remote: string }
  | { status: "missing_remote"; remote: string }
  | { status: "error"; remote: string; detail: string };

type RuntimeServiceName = "server" | "localbuddy" | "remotebuddy" | "source_control_manager";
type RuntimeBinaryName = RuntimeServiceName | "workerpals";

type RuntimeServiceLogPaths = Record<RuntimeServiceName, string>;

type RuntimeServiceProcess = ManagedServiceProcess;

type RuntimeBinarySet = {
  server: string;
  localbuddy: string;
  remotebuddy: string;
  workerpals: string;
  sourceControlManager: string;
};

type RuntimeBinaryInstallState = {
  binDir: string;
  tagMarkerPath: string;
  installedTag: string;
};

type RuntimeAssetSource = {
  root: string;
  envExamplePath: string;
  visionExamplePath: string;
  configsDir: string;
  promptsDir: string;
  protocolSchemasDir: string;
};

type WorkerpalSandboxPaths = {
  root: string;
  dockerfilePath: string;
  packageJsonPath: string;
  workerpalsDir: string;
  sharedDir: string;
  protocolDir: string;
  configsDir: string;
  workerpalsPromptsDir: string;
  protocolSchemasDir: string;
};

type PreparedCliRuntime = {
  runtimeRoot: string;
  runtimeTag: string;
  runtimePreflight: ClientRuntimePreflightResult;
  preflightUsesEmbeddedRuntime: boolean;
};

type AutoStartedRuntime = {
  serviceManager: ServiceManager;
  pushpalsLogPath: string;
};

type MonitoringHubHandle = {
  url: string;
  port: number;
  stop: () => void;
  embedded: boolean;
};

type MonitoringHubRuntimeBootstrap = {
  serverUrl: string;
  sessionId: string;
  clientId: string;
  clientKind: string;
  clientLabel: string;
};

type ClientStreamIdentity = {
  clientId: string;
  kind: string;
  label: string;
  version: string;
  platform: string;
  repoRoot: string;
};

type SessionClientRegistration = ClientStreamIdentity;

type RuntimeStartupPhaseName =
  | "server"
  | "localbuddy"
  | "remotebuddy"
  | "workerpal"
  | "source_control_manager"
  | "readiness";

type RuntimeStartupPhaseTiming = {
  name: RuntimeStartupPhaseName;
  durationMs: number;
  status: string;
};

type WorkerExecutionReadiness = {
  state: "ready" | "warming" | "blocked";
  detail: string;
  action?: string;
};

const DEFAULT_MONITOR_PORT = 8081;
const MONITOR_SCAN_PORTS = 32;
const MONITOR_POLL_MS = 2_000;
const HTTP_TIMEOUT_MS = 2_500;
const LOCALBUDDY_TIMEOUT_MS = 4_000;
const SSE_RECONNECT_MS = 1_500;
const DOCKER_VERSION_PROBE_TIMEOUT_MS = 10_000;
const WORKERPAL_IMAGE_INSPECT_TIMEOUT_MS = 15_000;
const WORKERPAL_IMAGE_BUILD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RUNTIME_BOOT_TIMEOUT_MS = 90_000;
const DEFAULT_RUNTIME_BOOT_POLL_MS = 1_000;
const DEFAULT_SERVER_BOOT_TIMEOUT_MS = 20_000;
const DEFAULT_SERVICE_STABILITY_GRACE_MS = 4_000;
const DEFAULT_EMBEDDED_SERVICE_SUPERVISOR_POLL_MS = 1_000;
const EMBEDDED_SERVICE_RESTART_MAX_ATTEMPTS = 4;
const EMBEDDED_SERVICE_RESTART_STABLE_WINDOW_MS = 60_000;
const EMBEDDED_SERVICE_RESTART_BASE_BACKOFF_MS = 2_000;
const EMBEDDED_SERVICE_RESTART_MAX_BACKOFF_MS = 30_000;
const WORKERPAL_STARTUP_READINESS_PROBE_MAX_MS = 15_000;
const EMBEDDED_RUNTIME_SAFETY_CAP_DISABLE_ENV = "PUSHPALS_DISABLE_EMBEDDED_SAFETY_CAPS";
const EMBEDDED_RUNTIME_WINDOWS_SAFETY_CAPS: Readonly<Record<string, string>> = {
  REMOTEBUDDY_WORKERPAL_STARTUP_TIMEOUT_MS: "120000",
  WORKERPALS_DOCKER_AGENT_STARTUP_TIMEOUT_MS: "90000",
  WORKERPALS_SKIP_DOCKER_SELF_CHECK: "1",
  WORKERPALS_DOCKER_WARM_MEMORY_MB: "1024",
  WORKERPALS_DOCKER_WARM_CPUS: "1",
};
const GITHUB_OWNER = "PushPalsDev";
const GITHUB_REPO = "pushpals";
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
const GITHUB_RELEASE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download`;
const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "pushpals-cli",
};
const ASK_REMOTE_BUDDY_COMMAND = "/ask_remote_buddy";
const stateVersion = 1;
let cliTimestampedConsoleInstalled = false;

export function formatTimestampedCliLine(line: string, at = new Date()): string {
  const text = String(line ?? "");
  if (!text.startsWith("[pushpals]") && !text.startsWith("[localbuddy]")) {
    return text;
  }
  return `[${at.toISOString()}]${text}`;
}

export function formatRuntimeStartupTimingSummary(input: {
  outcome: "ready" | "failed";
  totalDurationMs: number;
  phases: RuntimeStartupPhaseTiming[];
  detail?: string;
}): string {
  const phaseSummary = input.phases
    .map(
      (phase) =>
        `${phase.name}=${Math.max(0, Math.floor(phase.durationMs))}ms(${phase.status.trim() || "unknown"})`,
    )
    .join(" ");
  const detail =
    typeof input.detail === "string" && input.detail.trim() ? ` detail=${input.detail.trim()}` : "";
  return (
    `[pushpals] startup timing summary: outcome=${input.outcome} ` +
    `total=${Math.max(0, Math.floor(input.totalDurationMs))}ms${detail}` +
    (phaseSummary ? ` ${phaseSummary}` : "")
  );
}

export function describeWorkerExecutionReadiness(opts: {
  autoSpawnWorkerpals: boolean;
  requireDocker: boolean;
  dockerPrecheck?: WorkerpalDockerPrecheckResult | null;
  onlineWorkers: number;
  idleWorkers: number;
}): WorkerExecutionReadiness {
  const onlineWorkers = Math.max(0, Math.floor(opts.onlineWorkers));
  const idleWorkers = Math.max(0, Math.floor(opts.idleWorkers));
  if (idleWorkers > 0) {
    return {
      state: "ready",
      detail: `${idleWorkers} idle / ${onlineWorkers} online`,
    };
  }
  if (onlineWorkers > 0) {
    return {
      state: "warming",
      detail: `${idleWorkers} idle / ${onlineWorkers} online`,
      action:
        "Wait for WorkerPal warmup or active jobs to finish, then retry /status or send the request again.",
    };
  }
  if (!opts.autoSpawnWorkerpals) {
    return {
      state: "blocked",
      detail: "No online WorkerPals are reported and auto-spawn is disabled.",
      action: "Start a WorkerPals backend manually or enable RemoteBuddy auto-spawn.",
    };
  }
  if (opts.requireDocker && opts.dockerPrecheck?.status === "failed") {
    return {
      state: "blocked",
      detail: `Docker-backed WorkerPal auto-spawn is unavailable: ${opts.dockerPrecheck.detail}`,
      action: "Start Docker Desktop or the Docker daemon, then retry startup or rerun /status.",
    };
  }
  return {
    state: "warming",
    detail: "No online WorkerPals are reported yet.",
    action: "Wait for WorkerPal auto-spawn/warmup to finish, then rerun /status.",
  };
}

export function formatWorkerExecutionReadinessLines(readiness: WorkerExecutionReadiness): string[] {
  const lines = [`[pushpals] workerExecution=${readiness.state} detail=${readiness.detail}`];
  if (readiness.action) {
    lines.push(`[pushpals] workerExecutionAction=${readiness.action}`);
  }
  return lines;
}

export function formatEmbeddedRuntimeHealthLines(health: EmbeddedRuntimeHealth | null): string[] {
  return formatSharedEmbeddedRuntimeHealthLines(health);
}

function summarizeWorkerStatusRows(workers: WorkerStatusRow[]): {
  onlineWorkers: number;
  idleWorkers: number;
} {
  const onlineWorkers = workers.filter(
    (worker) =>
      Boolean(worker?.isOnline) &&
      String(worker?.status ?? "")
        .trim()
        .toLowerCase() !== "offline",
  );
  const idleWorkers = onlineWorkers.filter((worker) => Number(worker?.activeJobCount ?? 0) <= 0);
  return {
    onlineWorkers: onlineWorkers.length,
    idleWorkers: idleWorkers.length,
  };
}

export async function resolveWorkerExecutionReadiness(opts: {
  serverUrl: string;
  ttlMs: number;
  autoSpawnWorkerpals: boolean;
  dockerEnabled: boolean;
  requireDocker: boolean;
  repoRoot?: string;
  runtimeRoot?: string;
  preflightUsesEmbeddedRuntime?: boolean;
  sessionId?: string;
  dockerPrecheck?: WorkerpalDockerPrecheckResult | null;
  baseEnv?: Record<string, string | undefined>;
  fetchWorkersFn?: typeof fetchWorkerStatusRows;
  precheckDockerAvailabilityFn?: typeof precheckWorkerpalDockerAvailability;
}): Promise<WorkerExecutionReadiness> {
  let workers: WorkerStatusRow[] = [];
  try {
    workers = await (opts.fetchWorkersFn ?? fetchWorkerStatusRows)(opts.serverUrl, opts.ttlMs);
  } catch (error) {
    return {
      state: "blocked",
      detail: `Unable to query WorkerPal status: ${String(error)}`,
      action: "Check runtime connectivity, then retry /status or restart the runtime.",
    };
  }

  const { onlineWorkers, idleWorkers } = summarizeWorkerStatusRows(workers);
  let dockerPrecheck = opts.dockerPrecheck ?? null;
  const shouldProbeDockerAvailability =
    onlineWorkers === 0 &&
    opts.autoSpawnWorkerpals &&
    opts.dockerEnabled &&
    opts.requireDocker &&
    !dockerPrecheck &&
    typeof opts.repoRoot === "string" &&
    opts.repoRoot.trim().length > 0 &&
    typeof opts.runtimeRoot === "string" &&
    opts.runtimeRoot.trim().length > 0 &&
    typeof opts.preflightUsesEmbeddedRuntime === "boolean";
  if (shouldProbeDockerAvailability) {
    dockerPrecheck = await (
      opts.precheckDockerAvailabilityFn ?? precheckWorkerpalDockerAvailability
    )({
      repoRoot: opts.repoRoot!,
      runtimeRoot: opts.runtimeRoot!,
      preflightUsesEmbeddedRuntime: opts.preflightUsesEmbeddedRuntime!,
      autoSpawnWorkerpals: opts.autoSpawnWorkerpals,
      dockerEnabled: opts.dockerEnabled,
      requireDocker: opts.requireDocker,
      sessionId: opts.sessionId,
      baseEnv: opts.baseEnv,
    });
  }

  return describeWorkerExecutionReadiness({
    autoSpawnWorkerpals: opts.autoSpawnWorkerpals,
    requireDocker: opts.dockerEnabled && opts.requireDocker,
    dockerPrecheck,
    onlineWorkers,
    idleWorkers,
  });
}

export function normalizeCliInteractiveMessage(input: string): {
  text: string;
  usageMessage?: string;
} {
  const trimmed = String(input ?? "").trim();
  const command = ASK_REMOTE_BUDDY_COMMAND.toLowerCase();
  if (!trimmed.toLowerCase().startsWith(command)) {
    return { text: trimmed };
  }

  const rest = trimmed
    .slice(command.length)
    .replace(/^[:\-]\s*/, "")
    .trim();
  if (!rest) {
    return {
      text: "",
      usageMessage:
        "Usage: /ask_remote_buddy <request>. Example: /ask_remote_buddy fix the failing job status in the dashboard.",
    };
  }
  return { text: rest };
}

function installTimestampedCliConsole(): void {
  if (cliTimestampedConsoleInstalled) return;
  cliTimestampedConsoleInstalled = true;

  const patch = <T extends (...args: any[]) => unknown>(original: T): T =>
    ((...args: any[]) => {
      if (args.length > 0 && typeof args[0] === "string") {
        args[0] = formatTimestampedCliLine(args[0]);
      }
      return original(...args);
    }) as T;

  console.log = patch(console.log.bind(console)) as typeof console.log;
  console.warn = patch(console.warn.bind(console)) as typeof console.warn;
  console.error = patch(console.error.bind(console)) as typeof console.error;
}

installTimestampedCliConsole();

function logCliInvocation(argv: string[]): void {
  const startedAt = new Date().toISOString();
  const cliVersion = String(process.env.PUSHPALS_CLI_PACKAGE_VERSION ?? "").trim() || "unknown";
  const argsText = argv.length > 0 ? argv.join(" ") : "(none)";
  console.log(`[pushpals] invocation=${startedAt}`);
  console.log(`[pushpals] version=${cliVersion} runtime=bun@${Bun.version}`);
  console.log(`[pushpals] platform=${process.platform}/${process.arch}`);
  console.log(`[pushpals] cwd=${process.cwd()}`);
  console.log(`[pushpals] args=${argsText}`);
}

function printUsage(): void {
  console.log("PushPals CLI");
  console.log("");
  console.log("Usage:");
  console.log("  pushpals [options]");
  console.log("");
  console.log("Options:");
  console.log("  --server-url <url>     Override PushPals server URL");
  console.log("  --local-agent-url <url> Override LocalBuddy URL for monitoring/runtime state");
  console.log("  --session-id <id>      Override session ID");
  console.log("  --hub-url <url>        Override monitoring hub URL");
  console.log("  --runtime-root <path>  Override embedded runtime directory for auto-start");
  console.log("  --runtime-tag <tag>    Override runtime release tag (e.g. v1.0.2)");
  console.log("  --no-auto-start        Disable runtime auto-start when the server is down");
  console.log("  --no-stream            Disable live session event stream");
  console.log(
    "  --runtime-only         Start the local runtime and wait for shutdown without opening the interactive chat",
  );
  console.log("  --status-once          Print active endpoints once and exit");
  console.log("  --clear                Remove repo-local PushPals state and exit");
  console.log("  -h, --help             Show this help");
  console.log("");
  console.log("Chat commands:");
  console.log("  /hub                   Print monitoring hub URL");
  console.log("  /open                  Open monitoring hub in browser");
  console.log("  /status                Print active endpoints");
  console.log("  /exit, /quit           Quit CLI");
  console.log("");
  console.log("Notes:");
  console.log("  - Must be run from inside a git repository.");
  console.log(
    "  - Auto-start can bootstrap server/remotebuddy/source_control_manager and LocalBuddy when runtime config enables it.",
  );
  console.log("  - Interactive CLI talks directly to server sessions; LocalBuddy is optional.");
}

function parseArgs(argv: string[]): CliOptions | null {
  const options: CliOptions = {
    noAutoStart: false,
    noStream: false,
    runtimeOnly: false,
    statusOnce: false,
    clear: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printUsage();
      return null;
    }
    if (arg === "--no-stream") {
      options.noStream = true;
      continue;
    }
    if (arg === "--no-auto-start") {
      options.noAutoStart = true;
      continue;
    }
    if (arg === "--runtime-only") {
      options.runtimeOnly = true;
      continue;
    }
    if (arg === "--status-once") {
      options.statusOnce = true;
      continue;
    }
    if (arg === "--clear") {
      options.clear = true;
      continue;
    }
    if (arg === "--server-url") {
      options.serverUrl = argv[++i];
      continue;
    }
    if (arg === "--local-agent-url") {
      options.localAgentUrl = argv[++i];
      continue;
    }
    if (arg === "--session-id") {
      options.sessionId = argv[++i];
      continue;
    }
    if (arg === "--hub-url") {
      options.monitoringHubUrl = argv[++i];
      continue;
    }
    if (arg === "--runtime-root") {
      options.runtimeRoot = argv[++i];
      continue;
    }
    if (arg === "--runtime-tag") {
      options.runtimeTag = argv[++i];
      continue;
    }
    console.error(`[pushpals] Unknown argument: ${arg}`);
    printUsage();
    process.exit(2);
  }

  return options;
}

function normalizeUrl(value: string, fallback = ""): string {
  const text = String(value ?? "").trim();
  const selected = text || fallback;
  return selected.replace(/\/+$/, "");
}

function normalizeLoopbackUrl(value: string, fallback: string): string {
  const selected = normalizeUrl(value, fallback);
  if (!selected) return "";
  try {
    const parsed = new URL(selected);
    parsed.protocol = "http:";
    parsed.username = "";
    parsed.password = "";
    parsed.hostname = "127.0.0.1";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return normalizeUrl(fallback);
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(normalizeUrl(value));
    const hostname = String(parsed.hostname ?? "")
      .trim()
      .toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function jsonHtmlBootstrap(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

async function runCommandWithEnv(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs?: number,
): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(command, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          const stopCommand = buildServiceStopCommand(proc.pid, process.platform);
          if (stopCommand) {
            Bun.spawnSync(stopCommand, {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            });
          } else {
            proc.kill("SIGKILL");
          }
        } catch {
          // best-effort timeout termination only
        }
      }, timeoutMs);
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timer) clearTimeout(timer);
    const normalizedStdout = stdout.trim();
    const normalizedStderr = stderr.trim();
    if (timedOut) {
      return {
        ok: false,
        stdout: normalizedStdout,
        stderr: `timed out after ${timeoutMs}ms${normalizedStderr ? ` | ${normalizedStderr}` : ""}`,
        exitCode,
      };
    }
    return {
      ok: exitCode === 0,
      stdout: normalizedStdout,
      stderr: normalizedStderr,
      exitCode,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
    };
  }
}

async function runGitWithEnv(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<CommandResult> {
  return await runCommandWithEnv(["git", ...args], cwd, env);
}

async function runGit(args: string[], cwd: string): Promise<CommandResult> {
  return await runGitWithEnv(args, cwd, {
    ...(process.env as Record<string, string | undefined>),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  });
}

async function resolveCurrentGitRepoRoot(cwd: string): Promise<string | null> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!inside.ok || inside.stdout !== "true") return null;
  const root = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!root.ok || !root.stdout) return null;
  return resolve(root.stdout);
}

function resolveDefaultRuntimeRoot(): string {
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  return resolve(home, ".pushpals", "runtime");
}

function buildRuntimeAssetSource(root: string, protocolSchemasDir: string): RuntimeAssetSource {
  return {
    root,
    envExamplePath: join(root, ".env.example"),
    visionExamplePath: join(root, "vision.example.md"),
    configsDir: join(root, "configs"),
    promptsDir: join(root, "prompts"),
    protocolSchemasDir,
  };
}

export function buildWorkerpalSandboxPaths(runtimeRoot: string): WorkerpalSandboxPaths {
  const root = join(runtimeRoot, "sandbox");
  return {
    root,
    dockerfilePath: join(root, "apps", "workerpals", "Dockerfile.sandbox"),
    packageJsonPath: join(root, "package.json"),
    workerpalsDir: join(root, "apps", "workerpals"),
    sharedDir: join(root, "packages", "shared"),
    protocolDir: join(root, "packages", "protocol"),
    configsDir: join(root, "configs"),
    workerpalsPromptsDir: join(root, "prompts", "workerpals"),
    protocolSchemasDir: join(root, "protocol", "schemas"),
  };
}

function normalizeGitTrackedPath(pathValue: string): string {
  return String(pathValue ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function listTrackedRepoFilesForPath(repoRoot: string, sourcePath: string): string[] {
  const normalizedSource = normalizeGitTrackedPath(sourcePath);
  if (!normalizedSource) return [];
  const proc = Bun.spawnSync(["git", "ls-files", "-z", "--", normalizedSource], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string | undefined>),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
  });
  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr ?? [])
      .toString("utf8")
      .trim();
    throw new Error(`git ls-files failed for ${normalizedSource}${stderr ? `: ${stderr}` : ""}`);
  }
  return Buffer.from(proc.stdout ?? [])
    .toString("utf8")
    .split("\0")
    .map(normalizeGitTrackedPath)
    .filter(Boolean);
}

export function copyTrackedRepoPath(
  repoRoot: string,
  sourcePath: string,
  destinationPath: string,
  force = true,
): void {
  const normalizedSource = normalizeGitTrackedPath(sourcePath);
  if (!normalizedSource) {
    throw new Error("sourcePath is required");
  }
  const absoluteSource = resolve(repoRoot, normalizedSource);
  if (!existsSync(absoluteSource)) {
    throw new Error(`tracked repo source is missing: ${absoluteSource}`);
  }

  const trackedFiles = listTrackedRepoFilesForPath(repoRoot, normalizedSource);
  const sourceStat = lstatSync(absoluteSource);
  if (!sourceStat.isDirectory()) {
    if (!trackedFiles.includes(normalizedSource)) {
      throw new Error(`tracked repo file is not tracked by git: ${normalizedSource}`);
    }
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(absoluteSource, destinationPath, {
      recursive: false,
      force,
      errorOnExist: false,
    });
    return;
  }

  if (trackedFiles.length === 0) {
    throw new Error(`tracked repo directory has no tracked files: ${normalizedSource}`);
  }
  for (const trackedFile of trackedFiles) {
    const relativePath =
      trackedFile === normalizedSource
        ? basename(trackedFile)
        : trackedFile.slice(normalizedSource.length + 1);
    const sourceFile = resolve(repoRoot, trackedFile);
    const targetFile = join(destinationPath, relativePath);
    mkdirSync(dirname(targetFile), { recursive: true });
    cpSync(sourceFile, targetFile, {
      recursive: false,
      force,
      errorOnExist: false,
    });
  }
}

function isCompleteWorkerpalSandboxRoot(root: string): boolean {
  return (
    existsSync(join(root, "package.json")) &&
    existsSync(join(root, "apps", "workerpals", "Dockerfile.sandbox")) &&
    existsSync(join(root, "packages", "shared", "package.json")) &&
    existsSync(join(root, "packages", "protocol", "package.json")) &&
    existsSync(join(root, "configs", "default.toml")) &&
    existsSync(join(root, "prompts", "workerpals")) &&
    existsSync(join(root, "protocol", "schemas", "envelope.schema.json")) &&
    existsSync(join(root, "protocol", "schemas", "events.schema.json"))
  );
}

function populateWorkerpalSandboxRuntimeAssets(runtimeRoot: string, force: boolean): void {
  const sandbox = buildWorkerpalSandboxPaths(runtimeRoot);
  cpSync(join(runtimeRoot, "configs"), sandbox.configsDir, {
    recursive: true,
    force,
    errorOnExist: false,
  });
  cpSync(join(runtimeRoot, "prompts", "workerpals"), sandbox.workerpalsPromptsDir, {
    recursive: true,
    force,
    errorOnExist: false,
  });
  cpSync(join(runtimeRoot, "protocol", "schemas"), sandbox.protocolSchemasDir, {
    recursive: true,
    force,
    errorOnExist: false,
  });
}

function copySourceCheckoutWorkerpalSandboxBuildContext(
  sourceRoot: string,
  runtimeRoot: string,
  force: boolean,
): void {
  const sandbox = buildWorkerpalSandboxPaths(runtimeRoot);
  const copyPairs: Array<[string, string]> = [
    ["package.json", sandbox.packageJsonPath],
    ["apps/workerpals", sandbox.workerpalsDir],
    ["packages/shared", sandbox.sharedDir],
    ["packages/protocol", sandbox.protocolDir],
  ];

  for (const [fromPath, toPath] of copyPairs) {
    copyTrackedRepoPath(sourceRoot, fromPath, toPath, force);
  }
  if (existsSync(join(sourceRoot, "bun.lock"))) {
    copyTrackedRepoPath(sourceRoot, "bun.lock", join(sandbox.root, "bun.lock"), force);
  }
  populateWorkerpalSandboxRuntimeAssets(runtimeRoot, force);
}

function copyWorkerpalSandboxBuildContext(
  source: RuntimeAssetSource,
  runtimeRoot: string,
  force: boolean,
): void {
  const packagedSandboxRoot = join(source.root, "sandbox");
  if (isCompleteWorkerpalSandboxRoot(packagedSandboxRoot)) {
    cpSync(packagedSandboxRoot, join(runtimeRoot, "sandbox"), {
      recursive: true,
      force,
      errorOnExist: false,
    });
    return;
  }

  copySourceCheckoutWorkerpalSandboxBuildContext(source.root, runtimeRoot, force);
}

function isCompleteRuntimeAssetSource(source: RuntimeAssetSource): boolean {
  return (
    existsSync(source.envExamplePath) &&
    existsSync(source.visionExamplePath) &&
    existsSync(join(source.configsDir, "default.toml")) &&
    existsSync(source.promptsDir) &&
    existsSync(join(source.protocolSchemasDir, "envelope.schema.json")) &&
    existsSync(join(source.protocolSchemasDir, "events.schema.json"))
  );
}

export function resolveBundledRuntimeAssetSource(): RuntimeAssetSource | null {
  const candidates = [
    buildRuntimeAssetSource(
      resolve(import.meta.dir, "..", "runtime"),
      resolve(import.meta.dir, "..", "runtime", "protocol", "schemas"),
    ),
    buildRuntimeAssetSource(
      resolve(import.meta.dir, ".."),
      resolve(import.meta.dir, "..", "packages", "protocol", "src", "schemas"),
    ),
    buildRuntimeAssetSource(
      resolve(import.meta.dir, "..", "packages", "cli", "runtime"),
      resolve(import.meta.dir, "..", "packages", "cli", "runtime", "protocol", "schemas"),
    ),
  ];

  for (const candidate of candidates) {
    if (isCompleteRuntimeAssetSource(candidate)) return candidate;
  }
  return null;
}

function looksLikeMonitoringHubBuild(root: string): boolean {
  return existsSync(join(root, "index.html")) && existsSync(join(root, "_expo"));
}

function latestPathMtimeMs(pathValue: string): number {
  if (!existsSync(pathValue)) return 0;
  const stat = lstatSync(pathValue);
  let latest = stat.mtimeMs;
  if (!stat.isDirectory()) return latest;
  for (const entry of readdirSync(pathValue)) {
    latest = Math.max(latest, latestPathMtimeMs(join(pathValue, entry)));
  }
  return latest;
}

function bundledMonitoringHubSourceWatchPaths(sourceRoot: string): string[] {
  return [
    join(sourceRoot, "apps", "client", "app"),
    join(sourceRoot, "apps", "client", "assets"),
    join(sourceRoot, "apps", "client", "components"),
    join(sourceRoot, "apps", "client", "constants"),
    join(sourceRoot, "apps", "client", "hooks"),
    join(sourceRoot, "apps", "client", "scripts"),
    join(sourceRoot, "apps", "client", "src"),
    join(sourceRoot, "apps", "client", "app.json"),
    join(sourceRoot, "apps", "client", "package.json"),
    join(sourceRoot, "packages", "shared", "src"),
    join(sourceRoot, "scripts", "sync-cli-monitor-ui.ts"),
  ];
}

export function bundledMonitoringHubNeedsRefresh(
  existingRoot: string,
  sourceRoot: string,
): boolean {
  if (!looksLikeMonitoringHubBuild(existingRoot)) return true;
  const bundleMtimeMs = latestPathMtimeMs(existingRoot);
  if (bundleMtimeMs <= 0) return true;
  const sourceMtimeMs = bundledMonitoringHubSourceWatchPaths(sourceRoot).reduce(
    (latest, pathValue) => Math.max(latest, latestPathMtimeMs(pathValue)),
    0,
  );
  return sourceMtimeMs > bundleMtimeMs;
}

export function resolveBundledMonitoringHubRoot(): string | null {
  const candidates = [
    resolve(import.meta.dir, "..", "monitor-ui"),
    resolve(import.meta.dir, "..", "packages", "cli", "monitor-ui"),
  ];

  for (const candidate of candidates) {
    if (looksLikeMonitoringHubBuild(candidate)) return candidate;
  }
  return null;
}

function resolveCliSourceCheckoutRoot(): string | null {
  const candidates = [
    resolve(import.meta.dir, ".."),
    resolve(import.meta.dir, "..", ".."),
    resolve(import.meta.dir, "..", "..", ".."),
  ];

  for (const candidate of candidates) {
    if (
      existsSync(join(candidate, "package.json")) &&
      existsSync(join(candidate, "apps", "client", "app.json")) &&
      existsSync(join(candidate, "scripts", "sync-cli-monitor-ui.ts"))
    ) {
      return candidate;
    }
  }
  return null;
}

function exportBundledMonitoringHubFromSourceCheckout(sourceRoot: string): void {
  const exportScriptPath = join(sourceRoot, "scripts", "sync-cli-monitor-ui.ts");
  console.log("[pushpals] Packaged monitor UI missing; exporting the shared client monitor...");
  const proc = Bun.spawnSync([process.execPath, exportScriptPath], {
    cwd: sourceRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `Failed to export packaged monitor UI from source checkout (exit ${proc.exitCode || 1})`,
    );
  }
}

async function ensureBundledMonitoringHubRoot(): Promise<string | null> {
  const existingRoot = resolveBundledMonitoringHubRoot();
  const sourceRoot = resolveCliSourceCheckoutRoot();
  if (!sourceRoot) return existingRoot;

  if (existingRoot && !bundledMonitoringHubNeedsRefresh(existingRoot, sourceRoot)) {
    return existingRoot;
  }

  if (existingRoot) {
    console.log(
      "[pushpals] Packaged monitor UI is stale; refreshing the exported client monitor...",
    );
  }

  exportBundledMonitoringHubFromSourceCheckout(sourceRoot);
  return resolveBundledMonitoringHubRoot();
}

export function repoLooksLikePushPalsSourceCheckout(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "configs", "default.toml"));
}

function parseSemverFromPackageVersion(value: string | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/);
  return match ? raw : "";
}

function resolveRuntimePlatformKey(): string {
  if (process.platform === "win32") return "windows-x64";
  if (process.platform === "linux") return "linux-x64";
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "macos-arm64" : "macos-x64";
  }
  throw new Error(
    `Unsupported platform for embedded runtime binaries: ${process.platform}/${process.arch}`,
  );
}

async function fetchLatestReleaseTag(): Promise<string> {
  const response = await fetchWithTimeout(
    `${GITHUB_API_URL}/releases/latest`,
    { headers: GITHUB_HEADERS },
    20_000,
  );
  if (!response.ok) {
    throw new Error(`Failed to resolve latest release tag (HTTP ${response.status})`);
  }
  const payload = (await response.json()) as { tag_name?: unknown };
  const tagName = String(payload.tag_name ?? "").trim();
  if (!tagName) throw new Error("Latest release payload did not include tag_name");
  return tagName;
}

export function resolvePreferredRuntimeReleaseTag(
  explicitTag?: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const fromArg = String(explicitTag ?? "").trim();
  if (fromArg) return fromArg;

  const fromEnv = String(env.PUSHPALS_RUNTIME_TAG ?? "").trim();
  if (fromEnv) return fromEnv;

  const packageVersion = parseSemverFromPackageVersion(env.PUSHPALS_CLI_PACKAGE_VERSION);
  if (packageVersion) return `v${packageVersion}`;
  return "";
}

async function resolveRuntimeReleaseTag(explicitTag?: string): Promise<string> {
  const preferredTag = resolvePreferredRuntimeReleaseTag(
    explicitTag,
    process.env as Record<string, string | undefined>,
  );
  if (preferredTag) return preferredTag;

  console.log("[pushpals] Resolving embedded runtime release tag from GitHub...");
  return await fetchLatestReleaseTag();
}

function writeTextFileIfMissing(pathValue: string, text: string): void {
  if (existsSync(pathValue)) return;
  mkdirSync(dirname(pathValue), { recursive: true });
  writeFileSync(pathValue, text, "utf8");
}

function migrateEmbeddedRuntimeLocalToml(localTomlPath: string): void {
  if (!existsSync(localTomlPath)) return;
  let original: string;
  try {
    original = readFileSync(localTomlPath, "utf8");
  } catch {
    return;
  }
  const updated = original.replace(
    /^(\[remotebuddy\.autonomy\]\r?\n)(enabled\s*=\s*false\s*\r?\n)/m,
    "$1enabled = true\n",
  );
  if (updated !== original) {
    writeFileSync(localTomlPath, updated, "utf8");
  }
}

function copyRuntimeAssetBundle(
  source: RuntimeAssetSource,
  runtimeRoot: string,
  force: boolean,
): void {
  mkdirSync(runtimeRoot, { recursive: true });
  cpSync(source.envExamplePath, join(runtimeRoot, ".env.example"), {
    force,
    errorOnExist: false,
  });
  cpSync(source.visionExamplePath, join(runtimeRoot, "vision.example.md"), {
    force,
    errorOnExist: false,
  });
  cpSync(source.configsDir, join(runtimeRoot, "configs"), {
    recursive: true,
    force,
    errorOnExist: false,
  });
  cpSync(source.promptsDir, join(runtimeRoot, "prompts"), {
    recursive: true,
    force,
    errorOnExist: false,
  });
  cpSync(source.protocolSchemasDir, join(runtimeRoot, "protocol", "schemas"), {
    recursive: true,
    force,
    errorOnExist: false,
  });
  copyWorkerpalSandboxBuildContext(source, runtimeRoot, force);
}

function copyBundledRuntimeAssets(runtimeRoot: string, force = true): boolean {
  const bundledSource = resolveBundledRuntimeAssetSource();
  if (!bundledSource) return false;
  copyRuntimeAssetBundle(bundledSource, runtimeRoot, force);
  return true;
}

function hasSeededRuntimePreflightAssets(runtimeRoot: string): boolean {
  const protocolSchemasDir = join(runtimeRoot, "protocol", "schemas");
  const hasProtocolSchemas =
    existsSync(join(protocolSchemasDir, "envelope.schema.json")) &&
    existsSync(join(protocolSchemasDir, "events.schema.json"));
  return (
    existsSync(join(runtimeRoot, ".env.example")) &&
    existsSync(join(runtimeRoot, "vision.example.md")) &&
    existsSync(join(runtimeRoot, "configs", "default.toml")) &&
    existsSync(join(runtimeRoot, "prompts")) &&
    hasProtocolSchemas &&
    isCompleteWorkerpalSandboxRoot(join(runtimeRoot, "sandbox"))
  );
}

function seedRuntimePreflightAssets(runtimeRoot: string): void {
  if (!hasSeededRuntimePreflightAssets(runtimeRoot)) {
    copyBundledRuntimeAssets(runtimeRoot, false);
  }
  writeTextFileIfMissing(join(runtimeRoot, ".env"), "# Local PushPals runtime environment\n");
  const localExamplePath = join(runtimeRoot, "configs", "local.example.toml");
  const localTomlPath = join(runtimeRoot, "configs", "local.toml");
  if (existsSync(localExamplePath)) {
    writeTextFileIfMissing(localTomlPath, readFileSync(localExamplePath, "utf8"));
  } else {
    writeTextFileIfMissing(localTomlPath, "# Local PushPals runtime overrides\n");
  }
  migrateEmbeddedRuntimeLocalToml(localTomlPath);
}

async function fetchTextFromUrl(url: string, timeoutMs = 20_000): Promise<string> {
  const response = await fetchWithTimeout(url, { headers: GITHUB_HEADERS }, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return await response.text();
}

export async function downloadRuntimeAssetsFromSourceTag(
  runtimeRoot: string,
  tag: string,
): Promise<void> {
  console.log(`[pushpals] Downloading embedded runtime assets from source tag ${tag}...`);
  const treeUrl = `${GITHUB_API_URL}/git/trees/${encodeURIComponent(tag)}?recursive=1`;
  const treeResponse = await fetchWithTimeout(treeUrl, { headers: GITHUB_HEADERS }, 30_000);
  if (!treeResponse.ok) {
    throw new Error(`Failed to fetch runtime source tree for ${tag} (HTTP ${treeResponse.status})`);
  }
  const treePayload = (await treeResponse.json()) as {
    tree?: Array<{ path?: string; type?: string }>;
  };
  const paths = (treePayload.tree ?? [])
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => String(entry.path))
    .filter(
      (pathValue) =>
        pathValue === ".env.example" ||
        pathValue === "vision.example.md" ||
        pathValue === "package.json" ||
        pathValue === "bun.lock" ||
        pathValue.startsWith("configs/") ||
        pathValue.startsWith("prompts/workerpals/") ||
        pathValue.startsWith("prompts/") ||
        pathValue.startsWith("apps/workerpals/") ||
        pathValue.startsWith("packages/shared/") ||
        pathValue.startsWith("packages/protocol/") ||
        pathValue.startsWith("packages/protocol/src/schemas/"),
    );

  if (paths.length === 0) {
    throw new Error(`Runtime source tree for ${tag} did not include prompts/config assets`);
  }

  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  for (const pathValue of sorted) {
    const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${encodeURIComponent(tag)}/${pathValue}`;
    const body = await fetchTextFromUrl(rawUrl, 20_000);
    const outPath =
      pathValue === "package.json" || pathValue === "bun.lock"
        ? join(runtimeRoot, "sandbox", pathValue)
        : pathValue.startsWith("apps/workerpals/") ||
            pathValue.startsWith("packages/shared/") ||
            pathValue.startsWith("packages/protocol/")
          ? join(runtimeRoot, "sandbox", pathValue)
          : join(runtimeRoot, pathValue);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, body, "utf8");
    if (pathValue.startsWith("packages/protocol/src/schemas/")) {
      const runtimeSchemaPath = join(
        runtimeRoot,
        "protocol",
        "schemas",
        pathValue.slice("packages/protocol/src/schemas/".length),
      );
      mkdirSync(dirname(runtimeSchemaPath), { recursive: true });
      writeFileSync(runtimeSchemaPath, body, "utf8");
    }
  }
  populateWorkerpalSandboxRuntimeAssets(runtimeRoot, true);
}

async function ensureRuntimeAssets(runtimeRoot: string, runtimeTag: string): Promise<void> {
  console.log(`[pushpals] Preparing embedded runtime assets for ${runtimeTag}...`);
  const markerPath = join(runtimeRoot, ".runtime-assets-tag");
  const currentTag = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "";
  const protocolSchemasDir = join(runtimeRoot, "protocol", "schemas");
  const hasProtocolSchemas =
    existsSync(join(protocolSchemasDir, "envelope.schema.json")) &&
    existsSync(join(protocolSchemasDir, "events.schema.json"));
  const hasAssets =
    existsSync(join(runtimeRoot, ".env.example")) &&
    existsSync(join(runtimeRoot, "vision.example.md")) &&
    existsSync(join(runtimeRoot, "configs", "default.toml")) &&
    existsSync(join(runtimeRoot, "prompts")) &&
    hasProtocolSchemas &&
    isCompleteWorkerpalSandboxRoot(join(runtimeRoot, "sandbox"));
  if (!hasAssets || currentTag !== runtimeTag) {
    console.log(
      `[pushpals] Embedded runtime assets ${hasAssets ? "are stale" : "are missing"}; refreshing bundle...`,
    );
    copyBundledRuntimeAssets(runtimeRoot);
    const hasProtocolSchemasAfterCopy =
      existsSync(join(protocolSchemasDir, "envelope.schema.json")) &&
      existsSync(join(protocolSchemasDir, "events.schema.json"));
    const hasAssetsAfterCopy =
      existsSync(join(runtimeRoot, ".env.example")) &&
      existsSync(join(runtimeRoot, "vision.example.md")) &&
      existsSync(join(runtimeRoot, "configs", "default.toml")) &&
      existsSync(join(runtimeRoot, "prompts")) &&
      hasProtocolSchemasAfterCopy &&
      isCompleteWorkerpalSandboxRoot(join(runtimeRoot, "sandbox"));
    if (!hasAssetsAfterCopy) {
      console.log(
        "[pushpals] Bundled runtime assets are incomplete; falling back to release source downloads...",
      );
      await downloadRuntimeAssetsFromSourceTag(runtimeRoot, runtimeTag);
    }
    writeFileSync(markerPath, `${runtimeTag}\n`, "utf8");
  }

  writeTextFileIfMissing(join(runtimeRoot, ".env"), "# Local PushPals runtime environment\n");
  const localExamplePath = join(runtimeRoot, "configs", "local.example.toml");
  const localTomlPath = join(runtimeRoot, "configs", "local.toml");
  if (existsSync(localExamplePath)) {
    writeTextFileIfMissing(localTomlPath, readFileSync(localExamplePath, "utf8"));
  } else {
    writeTextFileIfMissing(localTomlPath, "# Local PushPals runtime overrides\n");
  }
  migrateEmbeddedRuntimeLocalToml(localTomlPath);
  console.log("[pushpals] Embedded runtime assets are ready.");
}

function resolveDeferredRuntimeTagHint(explicitTag?: string): string {
  return String(explicitTag || process.env.PUSHPALS_RUNTIME_TAG || "").trim();
}

export async function prepareCliRuntime(opts: {
  repoRoot: string;
  runtimeRoot?: string;
  runtimeTag?: string;
}): Promise<PreparedCliRuntime> {
  const runtimeRoot = resolve(
    opts.runtimeRoot || process.env.PUSHPALS_RUNTIME_ROOT || resolveDefaultRuntimeRoot(),
  );

  if (repoLooksLikePushPalsSourceCheckout(opts.repoRoot)) {
    return {
      runtimeRoot,
      runtimeTag: "",
      runtimePreflight: evaluateClientRuntimePreflight({
        projectRoot: opts.repoRoot,
      }),
      preflightUsesEmbeddedRuntime: false,
    };
  }

  seedRuntimePreflightAssets(runtimeRoot);
  return {
    runtimeRoot,
    runtimeTag: resolveDeferredRuntimeTagHint(opts.runtimeTag),
    runtimePreflight: evaluateClientRuntimePreflight({
      projectRoot: opts.repoRoot,
      runtimeRoot,
      visionTemplateRoot: runtimeRoot,
    }),
    preflightUsesEmbeddedRuntime: true,
  };
}

function emitCliRuntimePreflight(result: ClientRuntimePreflightResult): void {
  const lines = formatClientRuntimePreflightLines(result, "[pushpals]");
  if (result.ok) {
    for (const line of lines) console.log(line);
    return;
  }
  for (const line of lines) console.error(line);
}

function runtimeBinaryFilename(serviceName: RuntimeBinaryName, platformKey: string): string {
  const serviceToken =
    serviceName === "source_control_manager" ? "source-control-manager" : serviceName;
  const extension = platformKey.startsWith("windows-") ? ".exe" : "";
  return `pushpals-runtime-${serviceToken}-${platformKey}${extension}`;
}

function resolveRuntimeBinaryInstallState(
  runtimeRoot: string,
  platformKey: string,
): RuntimeBinaryInstallState {
  const binDir = join(runtimeRoot, "bin", platformKey);
  const tagMarkerPath = join(binDir, ".runtime-tag");
  const installedTag = existsSync(tagMarkerPath) ? readFileSync(tagMarkerPath, "utf8").trim() : "";
  return { binDir, tagMarkerPath, installedTag };
}

function cleanupLegacyRuntimeBinaryLayouts(
  runtimeRoot: string,
  platformKey: string,
  activeBinDir: string,
): void {
  const legacyRoot = join(runtimeRoot, "bin");
  if (!existsSync(legacyRoot)) return;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(legacyRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidateDir = join(legacyRoot, entry.name);
    if (candidateDir === activeBinDir) continue;
    if (!entry.name.endsWith(`-${platformKey}`)) continue;
    try {
      rmSync(candidateDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of the legacy per-tag install layout
    }
  }
}

export function buildEmbeddedRuntimeEnv(
  baseEnv: Record<string, string | undefined>,
  opts: {
    repoRoot: string;
    runtimeRoot: string;
    useRuntimeConfig?: boolean;
    sessionId?: string;
    runtimeTag?: string;
    platform?: NodeJS.Platform;
  },
): Record<string, string> {
  const env = normalizeChildProcessEnv(baseEnv);
  const useRuntimeConfig = opts.useRuntimeConfig !== false;
  const platform = opts.platform ?? process.platform;
  const embeddedBunBin = resolveEmbeddedBunExecutableFromEnv(env, platform);
  const inherited = { ...env };
  if (!useRuntimeConfig) {
    delete inherited.PUSHPALS_CONFIG_DIR_OVERRIDE;
    delete inherited.PUSHPALS_WORKERPALS_SANDBOX_ROOT;
    delete inherited.PUSHPALS_RUNTIME_TAG;
  }
  const disableEmbeddedSafetyCaps =
    parseBooleanFlag(env[EMBEDDED_RUNTIME_SAFETY_CAP_DISABLE_ENV]) === true;
  const shouldApplyEmbeddedWindowsSafetyCaps =
    useRuntimeConfig && platform === "win32" && !disableEmbeddedSafetyCaps;
  const embeddedWindowsSafetyCaps = shouldApplyEmbeddedWindowsSafetyCaps
    ? Object.fromEntries(
        Object.entries(EMBEDDED_RUNTIME_WINDOWS_SAFETY_CAPS).filter(([key]) => {
          const existing = env[key];
          return typeof existing !== "string" || existing.trim().length === 0;
        }),
      )
    : {};
  return {
    ...inherited,
    PUSHPALS_REPO_ROOT_OVERRIDE: opts.repoRoot,
    PUSHPALS_PROJECT_ROOT_OVERRIDE: opts.repoRoot,
    ...(useRuntimeConfig
      ? {
          PUSHPALS_CONFIG_DIR_OVERRIDE: join(opts.runtimeRoot, "configs"),
          PUSHPALS_PROMPTS_ROOT_OVERRIDE: opts.runtimeRoot,
          PUSHPALS_WORKERPALS_SANDBOX_ROOT: join(opts.runtimeRoot, "sandbox"),
          ...(typeof opts.runtimeTag === "string" && opts.runtimeTag.trim()
            ? { PUSHPALS_RUNTIME_TAG: opts.runtimeTag.trim() }
            : {}),
        }
      : {
          PUSHPALS_PROMPTS_ROOT_OVERRIDE: opts.repoRoot,
        }),
    PUSHPALS_PROTOCOL_SCHEMAS_DIR: join(opts.runtimeRoot, "protocol", "schemas"),
    ...(typeof opts.sessionId === "string" && opts.sessionId.trim()
      ? { PUSHPALS_SESSION_ID: opts.sessionId.trim() }
      : {}),
    ...(embeddedBunBin ? { PUSHPALS_BUN_BIN: embeddedBunBin } : {}),
    ...embeddedWindowsSafetyCaps,
    ...(typeof env.PUSHPALS_GIT_BIN === "string" && env.PUSHPALS_GIT_BIN.trim()
      ? { PUSHPALS_GIT_BIN: env.PUSHPALS_GIT_BIN.trim() }
      : {}),
    ...(typeof env.PUSHPALS_GIT_BIN_ABSOLUTE === "string" && env.PUSHPALS_GIT_BIN_ABSOLUTE.trim()
      ? { PUSHPALS_GIT_BIN_ABSOLUTE: env.PUSHPALS_GIT_BIN_ABSOLUTE.trim() }
      : {}),
    ...(typeof env.PUSHPALS_DOCKER_BIN === "string" && env.PUSHPALS_DOCKER_BIN.trim()
      ? { PUSHPALS_DOCKER_BIN: env.PUSHPALS_DOCKER_BIN.trim() }
      : {}),
    ...(typeof env.PUSHPALS_DOCKER_BIN_ABSOLUTE === "string" &&
    env.PUSHPALS_DOCKER_BIN_ABSOLUTE.trim()
      ? { PUSHPALS_DOCKER_BIN_ABSOLUTE: env.PUSHPALS_DOCKER_BIN_ABSOLUTE.trim() }
      : {}),
  };
}

function parseBooleanFlag(raw: string | undefined): boolean | null {
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "n"].includes(normalized)) return false;
  return null;
}

export function resolveEmbeddedBunExecutableFromEnv(
  env: Record<string, string | undefined>,
  platform = process.platform,
  currentExecPathOverride?: string,
): string {
  const explicit = String(env.PUSHPALS_BUN_BIN ?? "").trim();
  if (explicit) return explicit;

  const currentExecPath = String(currentExecPathOverride ?? process.execPath ?? "").trim();
  const currentExecLeaf = basename(currentExecPath).toLowerCase();
  if (currentExecLeaf === "bun" || currentExecLeaf === "bun.exe") {
    return currentExecPath;
  }

  const pathValue =
    platform === "win32"
      ? String(env.PATH ?? env.Path ?? "").trim()
      : String(env.PATH ?? "").trim();
  if (!pathValue) return "";

  const candidates = platform === "win32" ? ["bun.exe", "bun", "bun.cmd", "bun.bat"] : ["bun"];
  for (const rawDir of pathValue.split(delimiter)) {
    const dir = rawDir.trim();
    if (!dir) continue;
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return "";
}

export function normalizeChildProcessEnv(
  baseEnv: Record<string, string | undefined>,
  platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") env[key] = value;
  }

  if (platform === "win32") {
    const resolvedPath = String(
      env.Path ?? env.PATH ?? process.env.Path ?? process.env.PATH ?? "",
    ).trim();
    if (resolvedPath) {
      env.Path = resolvedPath;
      env.PATH = resolvedPath;
    }

    const systemRoot = String(
      env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
    ).trim();
    if (systemRoot) {
      env.SystemRoot = systemRoot;
      env.SYSTEMROOT = systemRoot;
    }

    const comSpec = String(
      env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC ?? "",
    ).trim();
    if (comSpec) {
      env.ComSpec = comSpec;
      env.COMSPEC = comSpec;
    }
  }

  return env;
}

export async function resolveCommandPath(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<string | null> {
  const lookupCommands =
    process.platform === "win32"
      ? resolveWindowsWhereExecutableCandidatesForEnv(
          env as Record<string, string | undefined>,
          process.platform,
        ).map((lookup) => [lookup, command])
      : [["which", command]];

  for (const lookup of lookupCommands) {
    try {
      const proc = Bun.spawn(lookup, {
        cwd,
        env,
        stdout: "pipe",
        stderr: "ignore",
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (exitCode !== 0) continue;
      const resolved = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (resolved) return resolved;
    } catch {
      // try the next lookup strategy
    }
  }

  return null;
}

function timestampFileToken(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function buildRuntimeServiceLogPaths(
  logDir: string,
  runToken: string,
): RuntimeServiceLogPaths {
  return {
    server: join(logDir, `${runToken}-server.log`),
    localbuddy: join(logDir, `${runToken}-localbuddy.log`),
    remotebuddy: join(logDir, `${runToken}-remotebuddy.log`),
    source_control_manager: join(logDir, `${runToken}-source_control_manager.log`),
  };
}

function appendRuntimeServicesLogLine(logPath: string, line: string): void {
  const text = String(line ?? "").trim();
  if (!text) return;
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`, "utf8");
  } catch {
    // best-effort diagnostics only
  }
}

function readLogTail(logPath: string, maxLines = 40): string {
  if (!existsSync(logPath)) return "";
  const raw = readFileSync(logPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  return lines.slice(-maxLines).join("\n");
}

export function extractRemoteBuddyAutonomousEngineState(
  logText: string,
): RemoteBuddyAutonomousEngineState {
  const text = String(logText ?? "");
  if (!text) return "unknown";
  let state: RemoteBuddyAutonomousEngineState = "unknown";
  for (const line of text.split(/\r?\n/)) {
    if (/Autonomous engine:\s*enabled\b/i.test(line)) {
      state = "enabled";
      continue;
    }
    if (/Autonomous engine:\s*disabled\b/i.test(line)) {
      state = "disabled";
    }
  }
  return state;
}

function readRemoteBuddyAutonomousEngineState(logPath: string): RemoteBuddyAutonomousEngineState {
  if (!existsSync(logPath)) return "unknown";
  try {
    return extractRemoteBuddyAutonomousEngineState(readFileSync(logPath, "utf8"));
  } catch {
    return "unknown";
  }
}

async function downloadBinaryAsset(tag: string, assetName: string, outPath: string): Promise<void> {
  console.log(`[pushpals] Downloading embedded runtime binary ${assetName} from ${tag}...`);
  const url = `${GITHUB_RELEASE_URL}/${encodeURIComponent(tag)}/${assetName}`;
  const response = await fetchWithTimeout(url, { headers: GITHUB_HEADERS }, 60_000);
  if (!response.ok) {
    throw new Error(`Failed to download ${assetName} from ${tag} (HTTP ${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  mkdirSync(dirname(outPath), { recursive: true });
  await Bun.write(outPath, bytes);
}

export async function ensureRuntimeBinaries(
  runtimeRoot: string,
  runtimeTag: string,
): Promise<RuntimeBinarySet> {
  const platformKey = resolveRuntimePlatformKey();
  console.log(
    `[pushpals] Preparing embedded runtime binaries for ${runtimeTag} (${platformKey})...`,
  );
  const installState = resolveRuntimeBinaryInstallState(runtimeRoot, platformKey);
  const { binDir, tagMarkerPath, installedTag } = installState;
  mkdirSync(binDir, { recursive: true });

  const runtimeBinaries: RuntimeBinarySet = {
    server: join(binDir, runtimeBinaryFilename("server", platformKey)),
    localbuddy: join(binDir, runtimeBinaryFilename("localbuddy", platformKey)),
    remotebuddy: join(binDir, runtimeBinaryFilename("remotebuddy", platformKey)),
    workerpals: join(binDir, runtimeBinaryFilename("workerpals", platformKey)),
    sourceControlManager: join(
      binDir,
      runtimeBinaryFilename("source_control_manager", platformKey),
    ),
  };

  const requiredAssets = [
    runtimeBinaries.server,
    runtimeBinaries.localbuddy,
    runtimeBinaries.remotebuddy,
    runtimeBinaries.workerpals,
    runtimeBinaries.sourceControlManager,
  ];
  const shouldRefreshAll = installedTag !== runtimeTag;
  let downloadedCount = 0;
  for (const binaryPath of requiredAssets) {
    if (!shouldRefreshAll && existsSync(binaryPath)) continue;
    const assetName = binaryPath.split(/[\\/]/).pop() || "";
    await downloadBinaryAsset(runtimeTag, assetName, binaryPath);
    downloadedCount++;
  }

  writeFileSync(tagMarkerPath, `${runtimeTag}\n`, "utf8");
  cleanupLegacyRuntimeBinaryLayouts(runtimeRoot, platformKey, binDir);

  if (process.platform !== "win32") {
    for (const binaryPath of requiredAssets) {
      try {
        chmodSync(binaryPath, 0o755);
      } catch {
        // best-effort
      }
    }
  }

  if (downloadedCount === 0) {
    console.log("[pushpals] Embedded runtime binaries are already present.");
  } else {
    console.log(`[pushpals] Embedded runtime binaries downloaded: ${downloadedCount}.`);
  }
  console.log("[pushpals] Embedded runtime binaries are ready.");
  return runtimeBinaries;
}

export function buildServiceStopCommand(
  pid: number | undefined,
  platform = process.platform,
): string[] | null {
  if (platform === "win32" && typeof pid === "number" && pid > 0) {
    return ["taskkill", "/PID", String(pid), "/T", "/F"];
  }
  return null;
}

function stopRuntimeServices(services: RuntimeServiceProcess[]): void {
  for (const service of services) {
    try {
      const stopCommand = buildServiceStopCommand(service.proc.pid, process.platform);
      if (stopCommand) {
        Bun.spawnSync(stopCommand, {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      } else {
        service.proc.kill("SIGKILL");
      }
    } catch {
      // ignore
    }
  }
}

function resolveGracefulShutdownPriority(name: RuntimeServiceName): number {
  if (name === "source_control_manager") return 0;
  if (name === "remotebuddy") return 1;
  if (name === "localbuddy") return 2;
  return 3;
}

async function waitForRuntimeServicesExit(
  services: RuntimeServiceProcess[],
  timeoutMs: number,
): Promise<boolean> {
  if (services.length === 0) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (services.every((service) => service.exited)) return true;
    await Bun.sleep(100);
  }
  return services.every((service) => service.exited);
}

async function stopRuntimeServicesGracefully(
  services: RuntimeServiceProcess[],
  timeoutMs = 10_000,
): Promise<void> {
  if (services.length === 0) return;
  const running = services.filter((service) => !service.exited);
  if (running.length === 0) return;
  const ordered = [...running].sort(
    (a, b) =>
      resolveGracefulShutdownPriority(a.name as RuntimeServiceName) -
      resolveGracefulShutdownPriority(b.name as RuntimeServiceName),
  );
  const nonServer = ordered.filter((service) => service.name !== "server");
  const server = ordered.filter((service) => service.name === "server");

  for (const service of nonServer) {
    try {
      service.proc.kill("SIGTERM");
    } catch {
      // Ignore and rely on force-stop fallback.
    }
  }

  await waitForRuntimeServicesExit(nonServer, Math.max(1_000, timeoutMs - 2_000));

  for (const service of server) {
    try {
      service.proc.kill("SIGTERM");
    } catch {
      // Ignore and rely on force-stop fallback.
    }
  }

  await waitForRuntimeServicesExit(server, Math.min(3_000, timeoutMs));

  const remaining = ordered.filter((service) => !service.exited);
  if (remaining.length > 0) {
    stopRuntimeServices(remaining);
  }
}

type LocalRuntimeShutdownAttempt = {
  attempted: boolean;
  accepted: boolean;
  detail?: string;
};

export async function shutdownEmbeddedServiceManagerGracefully(options: {
  serviceManager: ServiceManager;
  serverUrl: string;
  repoRoot: string;
  reason: string;
  requestShutdown?: (
    serverUrl: string,
    repoRoot: string,
    reason: string,
  ) => Promise<LocalRuntimeShutdownAttempt>;
  shutdownAcceptedDelayMs?: number;
  onLog?: (line: string) => void;
  onWarn?: (line: string) => void;
  cleanupTasks?: Array<() => Promise<void> | void>;
}): Promise<void> {
  const {
    serviceManager,
    serverUrl,
    repoRoot,
    reason,
    requestShutdown = requestLocalRuntimeShutdown,
    shutdownAcceptedDelayMs = 1_500,
    onLog = (line) => console.log(line),
    onWarn = (line) => console.warn(line),
    cleanupTasks = [],
  } = options;

  serviceManager.beginShutdown();
  const services = serviceManager.getServices();
  const shutdown = await requestShutdown(serverUrl, repoRoot, reason);
  if (shutdown.attempted && shutdown.accepted) {
    onLog("[pushpals] Local runtime shutdown accepted; waiting for services to exit...");
    await Bun.sleep(Math.max(0, shutdownAcceptedDelayMs));
  } else if (shutdown.attempted) {
    onWarn(
      `[pushpals] Local runtime shutdown request was not accepted${shutdown.detail ? `: ${shutdown.detail}` : "."}`,
    );
  } else if (shutdown.detail) {
    onWarn(`[pushpals] ${shutdown.detail}`);
  }

  await stopRuntimeServicesGracefully(services);
  for (const task of cleanupTasks) {
    await task();
  }
}

function prependExecutableDirToPath(
  env: Record<string, string>,
  executablePath: string,
  platform = process.platform,
): Record<string, string> {
  const resolvedPath = String(executablePath ?? "").trim();
  if (!resolvedPath) return env;
  if (!resolvedPath.includes("/") && !resolvedPath.includes("\\")) {
    return env;
  }

  const executableDir = dirname(resolvedPath);
  const existingPath =
    platform === "win32" ? String(env.Path ?? env.PATH ?? "") : String(env.PATH ?? "");
  const pathEntries = existingPath
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const hasDir = pathEntries.some((entry) =>
    platform === "win32"
      ? entry.toLowerCase() === executableDir.toLowerCase()
      : entry === executableDir,
  );
  const nextPath = hasDir ? existingPath : [executableDir, ...pathEntries].join(delimiter);

  if (platform === "win32") {
    env.Path = nextPath;
    env.PATH = nextPath;
  } else {
    env.PATH = nextPath;
  }
  return env;
}

export function applyResolvedGitBinaryToRuntimeEnv(
  env: Record<string, string>,
  resolvedGitBinary: string,
  platform = process.platform,
): Record<string, string> {
  const resolvedPath = String(resolvedGitBinary ?? "").trim();
  if (!resolvedPath) return env;
  prependExecutableDirToPath(env, resolvedPath, platform);
  env.PUSHPALS_GIT_BIN = basename(resolvedPath);
  if (resolvedPath.includes("/") || resolvedPath.includes("\\")) {
    env.PUSHPALS_GIT_BIN_ABSOLUTE = resolvedPath;
  } else {
    delete env.PUSHPALS_GIT_BIN_ABSOLUTE;
  }
  return env;
}

export function applyResolvedDockerBinaryToRuntimeEnv(
  env: Record<string, string>,
  resolvedDockerBinary: string,
  platform = process.platform,
): Record<string, string> {
  const resolvedPath = String(resolvedDockerBinary ?? "").trim();
  if (!resolvedPath) return env;
  prependExecutableDirToPath(env, resolvedPath, platform);
  env.PUSHPALS_DOCKER_BIN = basename(resolvedPath);
  if (resolvedPath.includes("/") || resolvedPath.includes("\\")) {
    env.PUSHPALS_DOCKER_BIN_ABSOLUTE = resolvedPath;
  } else {
    delete env.PUSHPALS_DOCKER_BIN_ABSOLUTE;
  }
  return env;
}

export function resolveRuntimeGitExecutableCandidates(
  env: Record<string, string | undefined>,
  platform = process.platform,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value: string): void => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return;
    const key = platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(trimmed);
  };

  pushCandidate(env.PUSHPALS_GIT_BIN ?? "");
  pushCandidate(env.PUSHPALS_GIT_BIN_ABSOLUTE ?? "");
  pushCandidate(platform === "win32" ? "git.exe" : "git");
  pushCandidate("git");
  return candidates;
}

export function resolveRuntimeDockerExecutableCandidates(
  env: Record<string, string | undefined>,
  platform = process.platform,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value: string): void => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return;
    const key = platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(trimmed);
  };

  pushCandidate(env.PUSHPALS_DOCKER_BIN ?? "");
  pushCandidate(env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? "");
  pushCandidate(platform === "win32" ? "docker.exe" : "docker");
  pushCandidate("docker");
  return candidates;
}

export function resolveWindowsShellExecutableCandidatesForEnv(
  env: Record<string, string | undefined>,
  platform = process.platform,
): string[] {
  if (platform !== "win32") return [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value: string): void => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(trimmed);
  };

  const comSpec = String(
    env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC ?? "",
  ).trim();
  const systemRoot = String(
    env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
  ).trim();

  pushCandidate(comSpec);
  if (systemRoot) {
    pushCandidate(pathWin32.join(systemRoot, "System32", "cmd.exe"));
    pushCandidate(pathWin32.join(systemRoot, "Sysnative", "cmd.exe"));
  }
  pushCandidate("cmd.exe");
  return candidates;
}

export function resolveWindowsWhereExecutableCandidatesForEnv(
  env: Record<string, string | undefined>,
  platform = process.platform,
): string[] {
  if (platform !== "win32") return [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value: string): void => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(trimmed);
  };

  const systemRoot = String(
    env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
  ).trim();
  if (systemRoot) {
    pushCandidate(pathWin32.join(systemRoot, "System32", "where.exe"));
    pushCandidate(pathWin32.join(systemRoot, "Sysnative", "where.exe"));
  }
  pushCandidate("where.exe");
  pushCandidate("where");
  return candidates;
}

function quoteWindowsCmdArg(value: string): string {
  const text = String(value ?? "");
  if (!text.length) return '""';
  if (!/[ \t"]/.test(text)) return text;
  const escaped = text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

function isOptionalEmbeddedService(name: RuntimeServiceName): boolean {
  return name === "source_control_manager";
}

export function computeEmbeddedServiceRestartBackoffMs(attempt: number): number {
  return computeServiceRestartBackoffMs(attempt);
}

export function shouldRestartEmbeddedService(
  attempts: number,
  maxAttempts = EMBEDDED_SERVICE_RESTART_MAX_ATTEMPTS,
): boolean {
  return shouldRestartService(attempts, maxAttempts);
}

async function canSpawnCommand(
  command: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<boolean> {
  try {
    const proc = Bun.spawn(command, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function canSpawnGitViaWindowsShell(
  commandArgs: string[],
  cwd: string,
  env: Record<string, string>,
  platform = process.platform,
): Promise<boolean> {
  if (platform !== "win32") return false;
  const commandLine = commandArgs.map((arg) => quoteWindowsCmdArg(arg)).join(" ");
  for (const shellExecutable of resolveWindowsShellExecutableCandidatesForEnv(env, platform)) {
    try {
      const proc = Bun.spawn([shellExecutable, "/d", "/s", "/c", commandLine], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      // Try the next shell candidate.
    }
  }
  return false;
}

async function resolveSourceControlManagerGitProbe(
  cwd: string,
  env: Record<string, string>,
  platform = process.platform,
): Promise<{ ok: boolean; detail: string }> {
  const candidates = resolveRuntimeGitExecutableCandidates(env, platform);
  for (const candidate of candidates) {
    if (await canSpawnCommand([candidate, "--version"], cwd, env)) {
      return { ok: true, detail: candidate };
    }
  }

  if (platform === "win32") {
    for (const candidate of candidates) {
      if (await canSpawnGitViaWindowsShell([candidate, "--version"], cwd, env, platform)) {
        return { ok: true, detail: `${candidate} via shell` };
      }
    }
  }

  return {
    ok: false,
    detail: candidates.join(", ") || "git",
  };
}

async function resolveWorkerpalDockerProbe(
  cwd: string,
  env: Record<string, string>,
  platform = process.platform,
): Promise<{ ok: boolean; detail: string }> {
  const resolvedDockerBinary = await resolveCommandPath(
    platform === "win32" ? "docker.exe" : "docker",
    cwd,
    env,
  );
  if (resolvedDockerBinary) {
    prependExecutableDirToPath(env, resolvedDockerBinary, platform);
    env.PUSHPALS_DOCKER_BIN = basename(resolvedDockerBinary);
    env.PUSHPALS_DOCKER_BIN_ABSOLUTE = resolvedDockerBinary;
  }

  const candidates = resolveRuntimeDockerExecutableCandidates(env, platform);
  const failures: string[] = [];
  for (const candidate of candidates) {
    const result = await runCommandWithEnv(
      [candidate, "version", "--format", "{{.Server.Version}}"],
      cwd,
      env,
      DOCKER_VERSION_PROBE_TIMEOUT_MS,
    );
    if (result.ok) {
      const version = result.stdout.trim();
      return {
        ok: true,
        detail: version ? `${candidate} (${version})` : candidate,
      };
    }
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    failures.push(`${candidate}: ${detail}`);
  }

  return {
    ok: false,
    detail: failures.join(" | ") || "docker",
  };
}

const WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL = "pushpals.runtime_tag";
const WORKERPAL_SANDBOX_COMPONENT_LABEL = "pushpals.component=workerpals-sandbox";
const WORKERPAL_WARM_COMPONENT_LABEL = "pushpals.component=workerpals-warm";
const SOURCE_CONTROL_MANAGER_TEMP_BRANCH_PREFIX = "_source_control_manager/";

type GitWorktreeEntry = {
  path: string;
  branch: string | null;
  detached: boolean;
};

type DockerImageRuntimeTagInspection =
  | { status: "ok"; runtimeTag: string }
  | { status: "missing"; runtimeTag: "" }
  | { status: "failed"; runtimeTag: ""; detail: string };

function normalizeFsPathForComparison(value: string): string {
  const resolved = resolve(String(value ?? "").trim())
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parseGitWorktreeListPorcelain(stdout: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  const blocks = String(stdout ?? "")
    .split(/\r?\n\r?\n/g)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/g);
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine) continue;
    const branchLine = lines.find((line) => line.startsWith("branch "));
    entries.push({
      path: pathLine.slice("worktree ".length).trim(),
      branch: branchLine ? branchLine.slice("branch ".length).trim() : null,
      detached: lines.includes("detached"),
    });
  }

  return entries;
}

function isWorkerpalEphemeralWorktreePath(repoRoot: string, worktreePath: string): boolean {
  const expectedPrefix = `${normalizeFsPathForComparison(join(repoRoot, ".worktrees"))}/`;
  const normalizedPath = normalizeFsPathForComparison(worktreePath);
  if (!normalizedPath.startsWith(expectedPrefix)) return false;
  const leaf = basename(normalizedPath);
  return /^(job|selfcheck)-.*-workerpal-[a-z0-9._-]+/i.test(leaf);
}

function resolveConfiguredDockerExecutable(
  env: Record<string, string | undefined>,
  platform = process.platform,
): string {
  const configured = String(
    env.PUSHPALS_DOCKER_BIN_ABSOLUTE ??
      env.PUSHPALS_DOCKER_BIN ??
      (platform === "win32" ? "docker.exe" : "docker"),
  ).trim();
  return configured || (platform === "win32" ? "docker.exe" : "docker");
}

export async function cleanupLingeringWorkerpalWarmContainers(opts: {
  repoRoot: string;
  env: Record<string, string>;
  platform?: NodeJS.Platform;
  runCommandWithEnvFn?: typeof runCommandWithEnv;
  commandTimeoutMs?: number;
}): Promise<{ ok: boolean; detail: string; removed: number }> {
  const runCommandWithEnvFn = opts.runCommandWithEnvFn ?? runCommandWithEnv;
  const commandTimeoutMs =
    typeof opts.commandTimeoutMs === "number" && Number.isFinite(opts.commandTimeoutMs)
      ? Math.max(1, Math.floor(opts.commandTimeoutMs))
      : 5_000;
  const dockerExecutable = resolveConfiguredDockerExecutable(
    opts.env,
    opts.platform ?? process.platform,
  );
  const list = await runCommandWithEnvFn(
    [
      dockerExecutable,
      "ps",
      "-aq",
      "--filter",
      `label=${WORKERPAL_WARM_COMPONENT_LABEL}`,
      "--filter",
      `label=pushpals.repo=${opts.repoRoot}`,
    ],
    opts.repoRoot,
    opts.env,
    commandTimeoutMs,
  );
  if (!list.ok) {
    const detail = list.stderr || list.stdout || `exit ${list.exitCode}`;
    return {
      ok: false,
      detail: `failed to inspect lingering WorkerPal warm containers: ${detail}`,
      removed: 0,
    };
  }

  const containerIds = list.stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (containerIds.length === 0) {
    return {
      ok: true,
      detail: "no lingering WorkerPal warm containers found",
      removed: 0,
    };
  }

  const remove = await runCommandWithEnvFn(
    [dockerExecutable, "rm", "-f", ...containerIds],
    opts.repoRoot,
    opts.env,
    commandTimeoutMs,
  );
  if (!remove.ok) {
    const detail = remove.stderr || remove.stdout || `exit ${remove.exitCode}`;
    return {
      ok: false,
      detail: `failed to remove lingering WorkerPal warm containers: ${detail}`,
      removed: 0,
    };
  }
  return {
    ok: true,
    detail: `removed ${containerIds.length} lingering WorkerPal warm container(s)`,
    removed: containerIds.length,
  };
}

export async function cleanupLingeringPushPalsGitWorktrees(opts: {
  repoRoot: string;
  env: Record<string, string>;
  runCommandWithEnvFn?: typeof runCommandWithEnv;
  forceDeleteWorktreePathFn?: typeof forceDeleteWorktreePath;
  commandTimeoutMs?: number;
}): Promise<{ ok: boolean; detail: string; removed: number }> {
  const runCommandWithEnvFn = opts.runCommandWithEnvFn ?? runCommandWithEnv;
  const forceDeleteWorktreePathFn = opts.forceDeleteWorktreePathFn ?? forceDeleteWorktreePath;
  const commandTimeoutMs =
    typeof opts.commandTimeoutMs === "number" && Number.isFinite(opts.commandTimeoutMs)
      ? Math.max(1, Math.floor(opts.commandTimeoutMs))
      : 5_000;
  const list = await runCommandWithEnvFn(
    ["git", "worktree", "list", "--porcelain"],
    opts.repoRoot,
    opts.env,
    commandTimeoutMs,
  );
  if (!list.ok) {
    const detail = list.stderr || list.stdout || `exit ${list.exitCode}`;
    return {
      ok: false,
      detail: `failed to inspect lingering PushPals git artifacts: ${detail}`,
      removed: 0,
    };
  }

  const currentRepoPath = normalizeFsPathForComparison(opts.repoRoot);
  const removable = parseGitWorktreeListPorcelain(list.stdout).filter((entry) => {
    const normalizedPath = normalizeFsPathForComparison(entry.path);
    if (normalizedPath === currentRepoPath) return false;
    if (entry.branch?.startsWith(`refs/heads/${SOURCE_CONTROL_MANAGER_TEMP_BRANCH_PREFIX}`)) {
      return true;
    }
    return isWorkerpalEphemeralWorktreePath(opts.repoRoot, entry.path);
  });

  let removed = 0;
  const failures: string[] = [];
  for (const entry of removable) {
    const remove = await runCommandWithEnvFn(
      ["git", "worktree", "remove", "--force", "--force", entry.path],
      opts.repoRoot,
      opts.env,
      commandTimeoutMs,
    );
    if (remove.ok) {
      removed += 1;
      continue;
    }
    const forced = await forceDeleteWorktreePathFn(entry.path);
    if (forced.removed) {
      removed += 1;
      continue;
    }
    const removeDetail = remove.stderr || remove.stdout || `exit ${remove.exitCode}`;
    failures.push(
      `${entry.path}: ${removeDetail}${forced.lastError ? ` | fallback: ${forced.lastError}` : ""}`,
    );
  }

  const prune = await runCommandWithEnvFn(
    ["git", "worktree", "prune"],
    opts.repoRoot,
    opts.env,
    commandTimeoutMs,
  );
  if (!prune.ok) {
    failures.push(`prune: ${prune.stderr || prune.stdout || `exit ${prune.exitCode}`}`);
  }

  const deleteTempBranches = await runCommandWithEnvFn(
    [
      "git",
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/${SOURCE_CONTROL_MANAGER_TEMP_BRANCH_PREFIX}`,
    ],
    opts.repoRoot,
    opts.env,
    commandTimeoutMs,
  );
  if (!deleteTempBranches.ok) {
    failures.push(
      `list temp branches: ${deleteTempBranches.stderr || deleteTempBranches.stdout || `exit ${deleteTempBranches.exitCode}`}`,
    );
  } else {
    const branches = deleteTempBranches.stdout
      .split(/\r?\n/g)
      .map((value) => value.trim())
      .filter(Boolean);
    for (const branch of branches) {
      const deleteResult = await runCommandWithEnvFn(
        ["git", "branch", "-D", branch],
        opts.repoRoot,
        opts.env,
        commandTimeoutMs,
      );
      if (!deleteResult.ok) {
        failures.push(
          `${branch}: ${deleteResult.stderr || deleteResult.stdout || `exit ${deleteResult.exitCode}`}`,
        );
      } else {
        removed += 1;
      }
    }
  }

  if (removed === 0 && failures.length === 0) {
    return {
      ok: true,
      detail: "no lingering PushPals git artifacts found",
      removed: 0,
    };
  }

  if (failures.length > 0) {
    return {
      ok: false,
      detail: `removed ${removed} lingering PushPals git artifact(s), but cleanup was incomplete: ${failures.join(" | ")}`,
      removed,
    };
  }

  return {
    ok: true,
    detail: `removed ${removed} lingering PushPals git artifact(s)`,
    removed,
  };
}

function isMissingDockerImageDetail(detail: string): boolean {
  return /\b(no such object|no such image|not found)\b/i.test(String(detail ?? ""));
}

async function inspectDockerImageRuntimeTag(
  dockerExecutable: string,
  imageName: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs = WORKERPAL_IMAGE_INSPECT_TIMEOUT_MS,
): Promise<DockerImageRuntimeTagInspection> {
  const inspect = await runCommandWithEnv(
    [
      dockerExecutable,
      "image",
      "inspect",
      "--format",
      `{{ index .Config.Labels "${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}" }}`,
      imageName,
    ],
    cwd,
    env,
    timeoutMs,
  );
  if (!inspect.ok) {
    const detail = inspect.stderr || inspect.stdout || `exit ${inspect.exitCode}`;
    if (isMissingDockerImageDetail(detail)) {
      return { status: "missing", runtimeTag: "" };
    }
    return {
      status: "failed",
      runtimeTag: "",
      detail: `failed to inspect local WorkerPal sandbox image ${imageName}: ${detail}`,
    };
  }
  const value = inspect.stdout.trim();
  return {
    status: "ok",
    runtimeTag: value === "<no value>" ? "" : value,
  };
}

export async function ensureWorkerpalDockerImageReady(opts: {
  runtimeRoot: string;
  runtimeTag: string;
  dockerImage: string;
  env: Record<string, string>;
  platform?: NodeJS.Platform;
  ensureRuntimeAssetsFn?: typeof ensureRuntimeAssets;
  inspectImageRuntimeTagFn?: typeof inspectDockerImageRuntimeTag;
  runCommandWithEnvFn?: typeof runCommandWithEnv;
}): Promise<{ ok: boolean; detail: string }> {
  const runtimeTag = String(opts.runtimeTag ?? "").trim();
  if (!runtimeTag) {
    return {
      ok: false,
      detail: "embedded runtime tag is required to prepare the WorkerPal sandbox image",
    };
  }

  await (opts.ensureRuntimeAssetsFn ?? ensureRuntimeAssets)(opts.runtimeRoot, runtimeTag);
  const sandbox = buildWorkerpalSandboxPaths(opts.runtimeRoot);
  if (!isCompleteWorkerpalSandboxRoot(sandbox.root)) {
    return {
      ok: false,
      detail: `embedded WorkerPal sandbox assets are incomplete at ${sandbox.root}`,
    };
  }

  const dockerExecutable = resolveConfiguredDockerExecutable(
    opts.env,
    opts.platform ?? process.platform,
  );
  const inspectImageRuntimeTagFn = opts.inspectImageRuntimeTagFn ?? inspectDockerImageRuntimeTag;
  const runCommandWithEnvFn = opts.runCommandWithEnvFn ?? runCommandWithEnv;
  console.log(
    `[pushpals] Checking WorkerPal sandbox image ${opts.dockerImage} for runtimeTag=${runtimeTag}...`,
  );
  const inspection = await inspectImageRuntimeTagFn(
    dockerExecutable,
    opts.dockerImage,
    sandbox.root,
    opts.env,
  );
  if (inspection.status === "failed") {
    return {
      ok: false,
      detail: inspection.detail,
    };
  }
  const existingRuntimeTag = inspection.runtimeTag;
  if (existingRuntimeTag === runtimeTag) {
    return {
      ok: true,
      detail: `WorkerPal sandbox image is ready locally (${opts.dockerImage}, runtimeTag=${runtimeTag})`,
    };
  }

  console.log(
    existingRuntimeTag
      ? `[pushpals] WorkerPal sandbox image ${opts.dockerImage} is stale (runtimeTag=${existingRuntimeTag}); rebuilding locally...`
      : `[pushpals] WorkerPal sandbox image ${opts.dockerImage} is missing; building locally...`,
  );
  const build = await runCommandWithEnvFn(
    [
      dockerExecutable,
      "build",
      "-f",
      "apps/workerpals/Dockerfile.sandbox",
      "--label",
      `${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}=${runtimeTag}`,
      "--label",
      WORKERPAL_SANDBOX_COMPONENT_LABEL,
      "-t",
      opts.dockerImage,
      ".",
    ],
    sandbox.root,
    opts.env,
    WORKERPAL_IMAGE_BUILD_TIMEOUT_MS,
  );
  if (!build.ok) {
    const detail = build.stderr || build.stdout || `docker build exited ${build.exitCode}`;
    return {
      ok: false,
      detail: `failed to build local WorkerPal sandbox image ${opts.dockerImage}: ${detail}`,
    };
  }

  return {
    ok: true,
    detail: `built local WorkerPal sandbox image ${opts.dockerImage} for runtimeTag=${runtimeTag}`,
  };
}

export async function prepareEmbeddedWorkerpalDockerImageIfNeeded(opts: {
  preparedRuntime: PreparedCliRuntime;
  config: ClientRuntimePreflightResult["config"];
  dockerPrecheck: WorkerpalDockerPrecheck;
  runtimeTagHint?: string;
  resolveRuntimeReleaseTagFn?: typeof resolveRuntimeReleaseTag;
  ensureWorkerpalDockerImageReadyFn?: typeof ensureWorkerpalDockerImageReady;
}): Promise<{ status: "skipped" | "ok" | "failed"; detail: string; runtimeTag: string }> {
  if (!opts.preparedRuntime.preflightUsesEmbeddedRuntime) {
    return {
      status: "skipped",
      detail: "repo is using source-checkout runtime assets",
      runtimeTag: "",
    };
  }
  if (
    !opts.config.remotebuddy.autoSpawnWorkerpals ||
    !opts.config.remotebuddy.workerpalDocker ||
    !opts.config.remotebuddy.workerpalRequireDocker
  ) {
    return {
      status: "skipped",
      detail: "embedded docker-backed WorkerPal auto-spawn is not required",
      runtimeTag: "",
    };
  }
  if (opts.dockerPrecheck.status === "failed") {
    return {
      status: "failed",
      detail: opts.dockerPrecheck.detail,
      runtimeTag: "",
    };
  }

  const runtimeTag =
    opts.preparedRuntime.runtimeTag ||
    String(opts.runtimeTagHint ?? "").trim() ||
    (await (opts.resolveRuntimeReleaseTagFn ?? resolveRuntimeReleaseTag)(opts.runtimeTagHint));
  if (!runtimeTag) {
    return {
      status: "failed",
      detail: "embedded runtime tag is required to prepare the WorkerPal sandbox image",
      runtimeTag: "",
    };
  }

  const ensureResult = await (
    opts.ensureWorkerpalDockerImageReadyFn ?? ensureWorkerpalDockerImageReady
  )({
    runtimeRoot: opts.preparedRuntime.runtimeRoot,
    runtimeTag,
    dockerImage: opts.config.remotebuddy.workerpalImage ?? opts.config.workerpals.dockerImage,
    env: opts.dockerPrecheck.env,
  });
  return ensureResult.ok
    ? { status: "ok", detail: ensureResult.detail, runtimeTag }
    : { status: "failed", detail: ensureResult.detail, runtimeTag };
}

export async function precheckSourceControlManagerGitAvailability(opts: {
  repoRoot: string;
  remote: string;
  runtimeRoot: string;
  preflightUsesEmbeddedRuntime: boolean;
  sessionId?: string;
  baseEnv?: Record<string, string | undefined>;
  repoHasRemoteFn?: typeof repoHasRemote;
  gitRemoteCheckFn?: typeof checkGitRemoteConfigured;
  resolveCommandPathFn?: typeof resolveCommandPath;
  gitProbeFn?: typeof resolveSourceControlManagerGitProbe;
  platform?: NodeJS.Platform;
}): Promise<SourceControlManagerGitPrecheckResult> {
  const platform = opts.platform ?? process.platform;
  const env = buildEmbeddedRuntimeEnv(
    (opts.baseEnv ?? (process.env as Record<string, string | undefined>)) as Record<
      string,
      string | undefined
    >,
    {
      repoRoot: opts.repoRoot,
      runtimeRoot: opts.runtimeRoot,
      useRuntimeConfig: opts.preflightUsesEmbeddedRuntime,
      sessionId: opts.sessionId,
    },
  );

  const preconfiguredGitBinary = env.PUSHPALS_GIT_BIN_ABSOLUTE ?? env.PUSHPALS_GIT_BIN;
  if (preconfiguredGitBinary) {
    applyResolvedGitBinaryToRuntimeEnv(env, preconfiguredGitBinary, platform);
  }

  const remoteStatus = opts.gitRemoteCheckFn
    ? await opts.gitRemoteCheckFn(opts.repoRoot, opts.remote, env)
    : opts.repoHasRemoteFn
      ? (await opts.repoHasRemoteFn(opts.repoRoot, opts.remote))
        ? { status: "ok", remote: opts.remote }
        : { status: "missing_remote", remote: opts.remote }
      : await checkGitRemoteConfigured(opts.repoRoot, opts.remote, env);
  if (remoteStatus.status === "missing_remote") {
    return {
      status: "skipped",
      detail: `git remote "${opts.remote}" is not configured`,
      env,
    };
  }
  if (remoteStatus.status === "error") {
    return {
      status: "failed",
      detail: `git remote "${opts.remote}" could not be inspected: ${remoteStatus.detail}`,
      env,
    };
  }

  const gitLookupCommand =
    typeof env.PUSHPALS_GIT_BIN === "string" && env.PUSHPALS_GIT_BIN.trim()
      ? env.PUSHPALS_GIT_BIN.trim()
      : platform === "win32"
        ? "git.exe"
        : "git";
  const resolvedGitBinary = await (opts.resolveCommandPathFn ?? resolveCommandPath)(
    gitLookupCommand,
    opts.repoRoot,
    env,
  );
  if (resolvedGitBinary) {
    applyResolvedGitBinaryToRuntimeEnv(env, resolvedGitBinary, platform);
  }

  const gitProbe = await (opts.gitProbeFn ?? resolveSourceControlManagerGitProbe)(
    opts.repoRoot,
    env,
    platform,
  );
  if (!gitProbe.ok) {
    return {
      status: "failed",
      detail: gitProbe.detail,
      env,
    };
  }

  return {
    status: "ok",
    detail: gitProbe.detail,
    env,
  };
}

export async function precheckWorkerpalDockerAvailability(opts: {
  repoRoot: string;
  runtimeRoot: string;
  preflightUsesEmbeddedRuntime: boolean;
  autoSpawnWorkerpals: boolean;
  dockerEnabled: boolean;
  requireDocker: boolean;
  sessionId?: string;
  baseEnv?: Record<string, string | undefined>;
  dockerProbeFn?: typeof resolveWorkerpalDockerProbe;
  platform?: NodeJS.Platform;
}): Promise<WorkerpalDockerPrecheckResult> {
  const env = buildEmbeddedRuntimeEnv(
    (opts.baseEnv ?? (process.env as Record<string, string | undefined>)) as Record<
      string,
      string | undefined
    >,
    {
      repoRoot: opts.repoRoot,
      runtimeRoot: opts.runtimeRoot,
      useRuntimeConfig: opts.preflightUsesEmbeddedRuntime,
      sessionId: opts.sessionId,
    },
  );
  const preconfiguredDockerBinary = env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? env.PUSHPALS_DOCKER_BIN;
  if (preconfiguredDockerBinary) {
    applyResolvedDockerBinaryToRuntimeEnv(
      env,
      preconfiguredDockerBinary,
      opts.platform ?? process.platform,
    );
  }

  if (!opts.autoSpawnWorkerpals) {
    return {
      status: "skipped",
      detail: "WorkerPal auto-spawn is disabled",
      env,
    };
  }
  if (!opts.dockerEnabled) {
    return {
      status: "skipped",
      detail: "WorkerPal docker mode is disabled",
      env,
    };
  }
  if (!opts.requireDocker) {
    return {
      status: "skipped",
      detail: "WorkerPal docker mode is optional",
      env,
    };
  }

  const dockerProbe = await (opts.dockerProbeFn ?? resolveWorkerpalDockerProbe)(
    opts.repoRoot,
    env,
    opts.platform ?? process.platform,
  );
  if (!dockerProbe.ok) {
    return {
      status: "failed",
      detail: dockerProbe.detail,
      env,
    };
  }

  return {
    status: "ok",
    detail: dockerProbe.detail,
    env,
  };
}

function resolveWorkerpalCapacityTimeoutMs(config: PushPalsConfig): number {
  return Math.max(
    config.remotebuddy.waitForWorkerpalMs,
    config.remotebuddy.workerpalStartupTimeoutMs,
    config.remotebuddy.workerpalDocker ? config.workerpals.dockerAgentStartupTimeoutMs + 15_000 : 0,
    10_000,
  );
}

function resolveWorkerpalStartupReadinessProbeTimeoutMs(config: PushPalsConfig): number {
  return Math.max(
    5_000,
    Math.min(resolveWorkerpalCapacityTimeoutMs(config), WORKERPAL_STARTUP_READINESS_PROBE_MAX_MS),
  );
}

export function shouldRunEmbeddedRuntimeStartupPrechecks(opts: {
  serverHealthy: boolean;
  noAutoStart: boolean;
}): boolean {
  return !opts.serverHealthy && !opts.noAutoStart;
}

async function checkGitRemoteConfigured(
  repoRoot: string,
  remote: string,
  env?: Record<string, string | undefined>,
): Promise<GitRemoteCheckResult> {
  const normalizedRemote = String(remote ?? "").trim();
  if (!normalizedRemote) {
    return { status: "missing_remote", remote: normalizedRemote };
  }
  const result = await runGitWithEnv(
    ["remote", "get-url", normalizedRemote],
    repoRoot,
    env ?? {
      ...(process.env as Record<string, string | undefined>),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
  );
  if (result.ok && result.stdout) {
    return { status: "ok", remote: normalizedRemote };
  }
  const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
  if (/no such remote/i.test(detail)) {
    return { status: "missing_remote", remote: normalizedRemote };
  }
  return { status: "error", remote: normalizedRemote, detail };
}

async function repoHasRemote(repoRoot: string, remote: string): Promise<boolean> {
  const remoteStatus = await checkGitRemoteConfigured(repoRoot, remote);
  return remoteStatus.status === "ok";
}

type PushpalsRemoteBranchPrecheck =
  | { status: "ok" }
  | { status: "missing_remote"; remote: string }
  | { status: "missing_branch"; remote: string; branch: string }
  | { status: "error"; remote: string; branch: string; detail: string };

async function checkPushpalsBranchOnRemote(
  repoRoot: string,
  remote: string,
  branch: string,
): Promise<PushpalsRemoteBranchPrecheck> {
  const normalizedRemote = String(remote ?? "").trim();
  const normalizedBranch = String(branch ?? "").trim();
  if (!normalizedRemote || !normalizedBranch) {
    return { status: "ok" };
  }

  const remoteStatus = await checkGitRemoteConfigured(repoRoot, normalizedRemote);
  if (remoteStatus.status === "missing_remote") {
    return { status: "missing_remote", remote: normalizedRemote };
  }
  if (remoteStatus.status === "error") {
    return {
      status: "error",
      remote: normalizedRemote,
      branch: normalizedBranch,
      detail: remoteStatus.detail,
    };
  }

  const ref = `refs/heads/${normalizedBranch}`;
  const result = await runGit(["ls-remote", "--heads", normalizedRemote, ref], repoRoot);
  if (!result.ok) {
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    return {
      status: "error",
      remote: normalizedRemote,
      branch: normalizedBranch,
      detail,
    };
  }

  if (!result.stdout.trim()) {
    return {
      status: "missing_branch",
      remote: normalizedRemote,
      branch: normalizedBranch,
    };
  }

  return { status: "ok" };
}

async function enforcePushpalsRemoteBranchPrecheck(
  repoRoot: string,
  remote: string,
  branch: string,
): Promise<boolean> {
  const result = await checkPushpalsBranchOnRemote(repoRoot, remote, branch);
  if (result.status === "ok") return true;
  if (result.status === "missing_remote") {
    console.warn(
      `[pushpals] Precheck: git remote "${result.remote}" is not configured in this repo; cannot verify pushpals branch.`,
    );
    return true;
  }
  if (result.status === "missing_branch") {
    console.error(
      `[pushpals] Precheck failed: remote branch "${result.remote}/${result.branch}" was not found.`,
    );
    console.error(
      "[pushpals] Precheck failed: create/push that branch first or set source_control_manager.pushpals_branch to an existing remote branch.",
    );
    return false;
  }
  console.error(
    `[pushpals] Precheck failed: could not verify remote branch "${result.remote}/${result.branch}": ${result.detail}`,
  );
  return false;
}

function isPathEqualOrWithin(parentPath: string, childPath: string): boolean {
  const parent = normalizeRepoPathForComparison(parentPath);
  const child = normalizeRepoPathForComparison(childPath);
  return child === parent || child.startsWith(`${parent}/`);
}

function appendCliClearTarget(
  targets: CliClearTarget[],
  label: string,
  pathValue: string | null | undefined,
): void {
  const resolvedPath = String(pathValue ?? "").trim();
  if (!resolvedPath) return;
  const normalized = normalizeRepoPathForComparison(resolvedPath);
  if (targets.some((target) => normalizeRepoPathForComparison(target.path) === normalized)) return;
  targets.push({ label, path: resolve(resolvedPath) });
}

export function buildCliClearTargets(opts: {
  repoRoot: string;
  runtimeRoot: string;
  config: ClientRuntimePreflightResult["config"];
  cliStatePath?: string | null;
}): CliClearTarget[] {
  const targets: CliClearTarget[] = [];
  const dataDir = resolve(opts.config.paths.dataDir);
  appendCliClearTarget(targets, "runtime data", dataDir);

  const scmStateDir = resolve(opts.config.sourceControlManager.stateDir);
  if (!isPathEqualOrWithin(dataDir, scmStateDir)) {
    appendCliClearTarget(targets, "SourceControlManager state", scmStateDir);
  }

  const scmRepoPath = resolve(opts.config.sourceControlManager.repoPath);
  if (
    normalizeRepoPathForComparison(scmRepoPath) !== normalizeRepoPathForComparison(opts.repoRoot) &&
    isPathEqualOrWithin(opts.repoRoot, scmRepoPath)
  ) {
    appendCliClearTarget(targets, "SourceControlManager worktree", scmRepoPath);
  }

  appendCliClearTarget(targets, "CLI state file", opts.cliStatePath ?? null);
  appendCliClearTarget(
    targets,
    "client monitor state file",
    resolveGitStateFilePath(opts.repoRoot, "pushpals-client-state.json"),
  );
  appendCliClearTarget(
    targets,
    "runtime bootstrap logs",
    join(opts.runtimeRoot, "logs", "bootstrap"),
  );
  return targets;
}

function removeCliClearTarget(target: CliClearTarget): "removed" | "missing" | CliClearFailure {
  if (!existsSync(target.path)) return "missing";
  try {
    rmSync(target.path, { recursive: true, force: true });
    return "removed";
  } catch (err) {
    return {
      ...target,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function requestLocalRuntimeShutdown(
  serverUrl: string,
  repoRoot: string,
  reason: string,
): Promise<{ attempted: boolean; accepted: boolean; detail?: string }> {
  if (!(await probeServer(serverUrl))) {
    return { attempted: false, accepted: false };
  }
  try {
    await ensureServerRepoAffinity(serverUrl, repoRoot);
  } catch (err) {
    return {
      attempted: false,
      accepted: false,
      detail: `skipping shutdown because ${String(err)}`,
    };
  }

  try {
    const response = await fetchWithTimeout(
      `${serverUrl}/admin/shutdown`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      },
      5_000,
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        attempted: true,
        accepted: false,
        detail: `HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
      };
    }
    return { attempted: true, accepted: true };
  } catch (err) {
    return {
      attempted: true,
      accepted: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function clearPushpalsState(opts: {
  repoRoot: string;
  runtimeRoot: string;
  config: ClientRuntimePreflightResult["config"];
  serverUrl: string;
  cliStatePath?: string | null;
}): Promise<number> {
  console.log("[pushpals] Clear requested. Removing repo-local PushPals state.");

  const shutdown = await requestLocalRuntimeShutdown(
    opts.serverUrl,
    opts.repoRoot,
    "pushpals --clear",
  );
  if (shutdown.attempted && shutdown.accepted) {
    console.log("[pushpals] Local runtime shutdown accepted; waiting for services to exit...");
    await Bun.sleep(1_500);
  } else if (shutdown.attempted) {
    console.warn(
      `[pushpals] Local runtime shutdown request was not accepted${shutdown.detail ? `: ${shutdown.detail}` : "."}`,
    );
  } else if (shutdown.detail) {
    console.warn(`[pushpals] ${shutdown.detail}`);
  }

  const targets = buildCliClearTargets({
    repoRoot: opts.repoRoot,
    runtimeRoot: opts.runtimeRoot,
    config: opts.config,
    cliStatePath: opts.cliStatePath,
  });
  const removed: CliClearTarget[] = [];
  const missing: CliClearTarget[] = [];
  let failed: CliClearFailure[] = [];

  for (const target of targets) {
    const result = removeCliClearTarget(target);
    if (result === "removed") {
      removed.push(target);
      continue;
    }
    if (result === "missing") {
      missing.push(target);
      continue;
    }
    failed.push(result);
  }

  if (failed.length > 0 && shutdown.accepted) {
    await Bun.sleep(1_000);
    const retryFailures: CliClearFailure[] = [];
    for (const failure of failed) {
      const retry = removeCliClearTarget(failure);
      if (retry === "removed") {
        removed.push({ label: failure.label, path: failure.path });
        continue;
      }
      if (retry === "missing") {
        missing.push({ label: failure.label, path: failure.path });
        continue;
      }
      retryFailures.push(retry);
    }
    failed = retryFailures;
  }

  for (const target of removed) {
    console.log(`[pushpals] Cleared ${target.label}: ${target.path}`);
  }
  for (const target of missing) {
    console.log(`[pushpals] Nothing to clear for ${target.label}: ${target.path}`);
  }
  for (const failure of failed) {
    console.error(
      `[pushpals] Failed to clear ${failure.label}: ${failure.path} (${failure.detail})`,
    );
  }

  if (failed.length > 0) {
    console.error("[pushpals] Clear completed with errors.");
    return 1;
  }

  console.log("[pushpals] Clear completed.");
  return 0;
}

async function probeServer(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${serverUrl}/healthz`, {}, HTTP_TIMEOUT_MS);
    return response.ok;
  } catch {
    return false;
  }
}

export function normalizeRepoPathForComparison(repoPath: string): string {
  const normalized = resolve(String(repoPath ?? ""))
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function fetchServerRepoRoot(serverUrl: string): Promise<string> {
  const response = await fetchWithTimeout(`${serverUrl}/system/status`, {}, 10_000);
  if (!response.ok) {
    throw new Error(`status probe failed with HTTP ${response.status}`);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    repo?: { root?: unknown };
  };
  const repoRoot =
    payload?.repo && typeof payload.repo.root === "string" ? payload.repo.root.trim() : "";
  if (!repoRoot) {
    throw new Error("server did not report repo.root in /system/status");
  }

  return repoRoot;
}

async function ensureServerRepoAffinity(serverUrl: string, currentRepoRoot: string): Promise<void> {
  const serverRepoRoot = await fetchServerRepoRoot(serverUrl);
  if (
    normalizeRepoPathForComparison(serverRepoRoot) ===
    normalizeRepoPathForComparison(currentRepoRoot)
  ) {
    return;
  }

  throw new Error(
    `repo mismatch: currentRepo=${currentRepoRoot} serverRepo=${serverRepoRoot}. Stop the existing runtime or switch to the matching repo.`,
  );
}

function isRemoteBuddyClientRow(row: SystemStatusClientRow): boolean {
  const clientId = normalizePresenceLookupToken(row.clientId);
  const label = normalizePresenceLookupToken(row.label);
  return clientId.includes("remotebuddy") || label.includes("remotebuddy");
}

export function extractRemoteBuddySessionConsumerHealth(
  statusPayload: unknown,
  sessionId: string,
): RemoteBuddySessionConsumerHealth {
  const rows = Array.isArray((statusPayload as { clients?: { items?: unknown } })?.clients?.items)
    ? (((statusPayload as { clients?: { items?: unknown } }).clients?.items as unknown[]) ?? [])
    : [];
  const sessionRows = rows.filter((row): row is SystemStatusClientRow => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    return String((row as SystemStatusClientRow).sessionId ?? "").trim() === sessionId;
  });
  const remotebuddyRows = sessionRows.filter(isRemoteBuddyClientRow);
  const connectedRow = remotebuddyRows.find(
    (row) =>
      String(row.status ?? "")
        .trim()
        .toLowerCase() === "connected",
  );
  if (connectedRow) {
    return {
      ok: true,
      detail: `RemoteBuddy session consumer connected (${String(connectedRow.clientId ?? "").trim()})`,
      clientId: String(connectedRow.clientId ?? "").trim() || undefined,
      sessionId,
    };
  }
  const anyRemoteBuddyRows = rows.filter((row): row is SystemStatusClientRow => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    return isRemoteBuddyClientRow(row as SystemStatusClientRow);
  });
  const connectedOtherSession = anyRemoteBuddyRows.find((row) => {
    const rowSessionId = String(row.sessionId ?? "").trim();
    if (!rowSessionId || rowSessionId === sessionId) return false;
    return (
      String(row.status ?? "")
        .trim()
        .toLowerCase() === "connected"
    );
  });
  if (connectedOtherSession) {
    const otherSessionId = String(connectedOtherSession.sessionId ?? "").trim();
    const otherClientId = String(connectedOtherSession.clientId ?? "").trim();
    return {
      ok: false,
      detail:
        `RemoteBuddy is connected to session ${otherSessionId || "unknown"} ` +
        `(${otherClientId || "unknown client"}), not ${sessionId}`,
      clientId: otherClientId || undefined,
      sessionId: otherSessionId || undefined,
    };
  }
  if (remotebuddyRows.length > 0) {
    return {
      ok: false,
      detail: `RemoteBuddy session consumer exists for ${sessionId} but is not connected`,
      clientId: String(remotebuddyRows[0]?.clientId ?? "").trim() || undefined,
      sessionId,
    };
  }
  if (anyRemoteBuddyRows.length > 0) {
    const knownSessions = [
      ...new Set(anyRemoteBuddyRows.map((row) => String(row.sessionId ?? "").trim())),
    ]
      .filter(Boolean)
      .sort();
    const suffix =
      knownSessions.length > 0 ? ` Known RemoteBuddy sessions: ${knownSessions.join(", ")}.` : "";
    return {
      ok: false,
      detail:
        `No connected RemoteBuddy session consumer found for session ${sessionId}.${suffix}`.trim(),
    };
  }
  return {
    ok: false,
    detail: `No connected RemoteBuddy session consumer found for session ${sessionId}`,
  };
}

async function probeRemoteBuddySessionConsumer(
  serverUrl: string,
  sessionId: string,
): Promise<RemoteBuddySessionConsumerHealth> {
  try {
    const response = await fetchWithTimeout(`${serverUrl}/system/status`, {}, 10_000);
    if (!response.ok) {
      return {
        ok: false,
        detail: `system status probe failed with HTTP ${response.status}`,
      };
    }
    const payload = (await response.json().catch(() => ({}))) as unknown;
    return extractRemoteBuddySessionConsumerHealth(payload, sessionId);
  } catch (err) {
    return {
      ok: false,
      detail: `system status probe failed: ${String(err)}`,
    };
  }
}

async function probeSourceControlManager(port: number): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0) return false;
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${Math.floor(port)}/health`,
      {},
      HTTP_TIMEOUT_MS,
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchWorkerStatusRows(serverUrl: string, ttlMs: number): Promise<WorkerStatusRow[]> {
  const payload = await fetchJsonWithTimeout<{ ok?: boolean; workers?: WorkerStatusRow[] }>(
    `${serverUrl}/workers?ttlMs=${Math.max(1_000, Math.floor(ttlMs))}`,
    {},
    10_000,
  );
  if (!payload?.ok || !Array.isArray(payload.workers)) {
    return [];
  }
  return payload.workers;
}

export async function waitForWorkerpalCapacity(opts: {
  serverUrl: string;
  timeoutMs: number;
  ttlMs: number;
  fetchWorkersFn?: typeof fetchWorkerStatusRows;
  sleepFn?: typeof Bun.sleep;
}): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + Math.max(1_000, opts.timeoutMs);
  let lastObservedOnline = 0;
  while (Date.now() < deadline) {
    const workers = await (opts.fetchWorkersFn ?? fetchWorkerStatusRows)(
      opts.serverUrl,
      opts.ttlMs,
    );
    const summary = summarizeWorkerStatusRows(workers);
    if (summary.onlineWorkers > 0) {
      lastObservedOnline = Math.max(lastObservedOnline, summary.onlineWorkers);
    }
    if (summary.idleWorkers > 0) {
      return {
        ok: true,
        detail: `${summary.idleWorkers} idle / ${summary.onlineWorkers} online`,
      };
    }
    await (opts.sleepFn ?? Bun.sleep)(DEFAULT_RUNTIME_BOOT_POLL_MS);
  }
  if (lastObservedOnline > 0) {
    return {
      ok: false,
      detail: `${lastObservedOnline} online WorkerPal(s) reported but none became idle within ${Math.max(
        1_000,
        opts.timeoutMs,
      )}ms`,
    };
  }
  return {
    ok: false,
    detail: `no online WorkerPal reported within ${Math.max(1_000, opts.timeoutMs)}ms`,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<T | null> {
  try {
    const response = await fetchWithTimeout(url, init, timeoutMs);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function buildClientTransportQuery(cursor: number, client: ClientStreamIdentity): string {
  const params = new URLSearchParams();
  if (cursor > 0) params.set("after", String(cursor));
  params.set("clientId", client.clientId);
  params.set("clientKind", client.kind);
  params.set("clientLabel", client.label);
  params.set("clientVersion", client.version);
  params.set("clientPlatform", client.platform);
  params.set("clientRepoRoot", client.repoRoot);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function createRuntimeClientId(prefix: string): string {
  if (typeof crypto?.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function probeLocalBuddy(localAgentUrl: string): Promise<LocalBuddyHealth | null> {
  return await fetchJsonWithTimeout<LocalBuddyHealth>(
    `${localAgentUrl}/healthz`,
    {},
    LOCALBUDDY_TIMEOUT_MS,
  );
}

export function resolveCliLocalBuddyAutostart(
  runtimeOnly: boolean,
  runtimeConfigEnabled: boolean,
): boolean {
  return runtimeOnly ? runtimeConfigEnabled : false;
}

async function ensureServerSession(
  serverUrl: string,
  requestedSessionId: string,
  client: SessionClientRegistration,
): Promise<string> {
  const response = await fetchWithTimeout(
    `${serverUrl}/sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: requestedSessionId,
        client: {
          clientId: client.clientId,
          kind: client.kind,
          label: client.label,
          version: client.version,
          platform: client.platform,
          repoRoot: client.repoRoot,
        },
      }),
    },
    15_000,
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Failed to create or join session ${requestedSessionId}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as { sessionId?: unknown };
  const sessionId =
    typeof payload.sessionId === "string" && payload.sessionId.trim()
      ? payload.sessionId.trim()
      : "";
  if (!sessionId) {
    throw new Error("Server session bootstrap returned no sessionId.");
  }
  return sessionId;
}

async function autoStartRuntimeServices(opts: {
  repoRoot: string;
  serverUrl: string;
  localAgentUrl: string;
  sessionId: string;
  sourceControlManagerPort: number;
  sourceControlManagerRemote: string;
  preparedRuntime: PreparedCliRuntime;
  requestedRuntimeTag?: string;
  startLocalBuddy?: boolean;
  baseEnv?: Record<string, string | undefined>;
}): Promise<AutoStartedRuntime> {
  const { runtimePreflight } = opts.preparedRuntime;
  const runtimeRoot = opts.preparedRuntime.runtimeRoot;
  const runtimeTag =
    opts.preparedRuntime.runtimeTag || (await resolveRuntimeReleaseTag(opts.requestedRuntimeTag));
  const startLocalBuddy =
    opts.startLocalBuddy ?? Boolean(runtimePreflight.config.localbuddy.enabled);
  const localBuddyEnabled = startLocalBuddy;

  console.log(`[pushpals] Runtime unavailable. Auto-starting runtime for repo: ${opts.repoRoot}`);
  console.log(`[pushpals] runtimeRoot=${runtimeRoot}`);
  console.log(`[pushpals] runtimeTag=${runtimeTag}`);
  if (!runtimePreflight.ok) {
    throw new Error("Embedded runtime preflight failed.");
  }

  await ensureRuntimeAssets(runtimeRoot, runtimeTag);
  const runtimeBinaries = await ensureRuntimeBinaries(runtimeRoot, runtimeTag);

  const runtimeEnv = buildEmbeddedRuntimeEnv(
    (opts.baseEnv ?? (process.env as Record<string, string | undefined>)) as Record<
      string,
      string | undefined
    >,
    {
      repoRoot: opts.repoRoot,
      runtimeRoot,
      useRuntimeConfig: opts.preparedRuntime.preflightUsesEmbeddedRuntime,
      sessionId: opts.sessionId,
      runtimeTag,
    },
  );
  runtimeEnv.PUSHPALS_WORKERPALS_BIN = runtimeBinaries.workerpals;
  const preconfiguredRuntimeGitBinary =
    runtimeEnv.PUSHPALS_GIT_BIN_ABSOLUTE ?? runtimeEnv.PUSHPALS_GIT_BIN;
  if (preconfiguredRuntimeGitBinary) {
    applyResolvedGitBinaryToRuntimeEnv(runtimeEnv, preconfiguredRuntimeGitBinary);
  }
  const preconfiguredRuntimeDockerBinary =
    runtimeEnv.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? runtimeEnv.PUSHPALS_DOCKER_BIN;
  if (preconfiguredRuntimeDockerBinary) {
    applyResolvedDockerBinaryToRuntimeEnv(runtimeEnv, preconfiguredRuntimeDockerBinary);
  }
  const gitLookupCommand =
    typeof runtimeEnv.PUSHPALS_GIT_BIN === "string" && runtimeEnv.PUSHPALS_GIT_BIN.trim()
      ? runtimeEnv.PUSHPALS_GIT_BIN.trim()
      : "git";
  const resolvedGitBinary = await resolveCommandPath(gitLookupCommand, opts.repoRoot, runtimeEnv);
  if (resolvedGitBinary) {
    applyResolvedGitBinaryToRuntimeEnv(runtimeEnv, resolvedGitBinary);
  }

  const startupStartedAt = Date.now();
  const startupPhases: RuntimeStartupPhaseTiming[] = [];
  const recordStartupPhase = (
    name: RuntimeStartupPhaseName,
    startedAt: number,
    status: string,
  ): void => {
    startupPhases.push({
      name,
      durationMs: Math.max(0, Date.now() - startedAt),
      status,
    });
  };
  const emitStartupTimingSummary = (outcome: "ready" | "failed", detail?: string): void => {
    const summary = formatRuntimeStartupTimingSummary({
      outcome,
      totalDurationMs: Date.now() - startupStartedAt,
      phases: startupPhases,
      detail,
    });
    if (outcome === "failed") {
      console.warn(summary);
    } else {
      console.log(summary);
    }
    appendRuntimeServicesLogLine(runtimeServicesLogPath, summary);
  };
  const runToken = timestampFileToken();
  const logDir = join(runtimeRoot, "logs", "bootstrap");
  mkdirSync(logDir, { recursive: true });
  const serviceLogPaths = buildRuntimeServiceLogPaths(logDir, runToken);
  const runtimeServicesLogPath = join(logDir, `${runToken}-runtime-services.log`);
  writeFileSync(runtimeServicesLogPath, "", "utf8");
  appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] runtimeRoot=${runtimeRoot}`);
  appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] runtimeTag=${runtimeTag}`);
  appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] repoRoot=${opts.repoRoot}`);
  console.log(`[pushpals] pushpals log: ${runtimeServicesLogPath}`);
  console.log(`[pushpals] runtime services log: ${runtimeServicesLogPath}`);
  console.log(`[pushpals] service log (server)=${serviceLogPaths.server}`);
  console.log(`[pushpals] service log (localbuddy)=${serviceLogPaths.localbuddy}`);
  console.log(`[pushpals] service log (remotebuddy)=${serviceLogPaths.remotebuddy}`);
  console.log(
    `[pushpals] service log (source_control_manager)=${serviceLogPaths.source_control_manager}`,
  );
  const serviceManager = new ServiceManager({
    degradedAction: "Inspect the embedded service log or restart pushpals after fixing the runtime failure.",
    onEvent: (level, line) => {
      const cliLine = `[pushpals] ${line.replace(/^Managed /, "Embedded ").replace(/^Restarted managed /, "Restarted embedded ")}`;
      if (level === "error") {
        console.error(cliLine);
      } else if (level === "warn") {
        console.warn(cliLine);
      } else {
        console.log(cliLine);
      }
      appendRuntimeServicesLogLine(runtimeServicesLogPath, cliLine);
    },
    onHealthChange: (health) => {
      for (const line of formatEmbeddedRuntimeHealthLines(health)) {
        console.error(line);
        appendRuntimeServicesLogLine(runtimeServicesLogPath, line);
      }
    },
  });
  const launchService = (name: RuntimeServiceName, command: string[]): RuntimeServiceProcess => {
    const logPath = serviceLogPaths[name];
    const header = `[pushpals] service=${name} command=${command.join(" ")} cwd=${opts.repoRoot}`;
    writeFileSync(logPath, `${header}\n`, "utf8");
    appendRuntimeServicesLogLine(runtimeServicesLogPath, header);
    return serviceManager.startService({
      name,
      color: "",
      command,
      cwd: opts.repoRoot,
      env: runtimeEnv,
      logPath,
      onStdoutLine: (line) => {
        const serviceLine = `[stdout] ${line}`;
        appendFileSync(logPath, `${serviceLine}\n`, "utf8");
        appendRuntimeServicesLogLine(runtimeServicesLogPath, `[${name}] ${serviceLine}`);
      },
      onStderrLine: (line) => {
        const serviceLine = `[stderr] ${line}`;
        appendFileSync(logPath, `${serviceLine}\n`, "utf8");
        appendRuntimeServicesLogLine(runtimeServicesLogPath, `[${name}] ${serviceLine}`);
      },
    });
  };

  const serverHealthy = await probeServer(opts.serverUrl);
  if (!serverHealthy) {
    const serverPhaseStartedAt = Date.now();
    console.log("[pushpals] Starting embedded server...");
    const serverService = launchService("server", [runtimeBinaries.server]);
    const serverLogPath = serverService.logPath ?? serviceLogPaths.server;
    console.log(`[pushpals] server log: ${serverLogPath}`);

    const serverDeadline = Date.now() + DEFAULT_SERVER_BOOT_TIMEOUT_MS;
    let serverIsReady = false;
    while (Date.now() < serverDeadline) {
      if (serverService.exited) {
        const tail = readLogTail(serverLogPath);
        appendRuntimeServicesLogLine(
          runtimeServicesLogPath,
          `[pushpals] embedded server exited during bootstrap (code=${serverService.exitCode ?? "unknown"}).`,
        );
        recordStartupPhase("server", serverPhaseStartedAt, "exited");
        emitStartupTimingSummary("failed", "server exited during bootstrap");
        stopRuntimeServices(serviceManager.getServices());
        throw new Error(
          `Embedded server exited during bootstrap (code=${serverService.exitCode ?? "unknown"}). ` +
            `See ${serverLogPath}${tail ? `\n--- server log tail ---\n${tail}` : ""}`,
        );
      }
      if (await probeServer(opts.serverUrl)) {
        serverIsReady = true;
        break;
      }
      await Bun.sleep(DEFAULT_RUNTIME_BOOT_POLL_MS);
    }
    if (!serverIsReady) {
      const tail = readLogTail(serverLogPath);
      appendRuntimeServicesLogLine(
        runtimeServicesLogPath,
        `[pushpals] embedded server did not become healthy within ${DEFAULT_SERVER_BOOT_TIMEOUT_MS}ms.`,
      );
      recordStartupPhase("server", serverPhaseStartedAt, "timeout");
      emitStartupTimingSummary("failed", "server health timeout");
      stopRuntimeServices(serviceManager.getServices());
      throw new Error(
        `Embedded server did not become healthy within ${DEFAULT_SERVER_BOOT_TIMEOUT_MS}ms. ` +
          `See ${serverLogPath}${tail ? `\n--- server log tail ---\n${tail}` : ""}`,
      );
    }
    recordStartupPhase("server", serverPhaseStartedAt, "started");
    console.log("[pushpals] Embedded server is healthy.");
  } else {
    recordStartupPhase("server", Date.now(), "reused");
    console.log("[pushpals] Server already healthy; skipping embedded server start.");
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      "[pushpals] server already healthy; embedded server start skipped.",
    );
  }

  if (localBuddyEnabled) {
    const localBuddyPhaseStartedAt = Date.now();
    console.log("[pushpals] Starting embedded LocalBuddy...");
    const localbuddyService = launchService("localbuddy", [runtimeBinaries.localbuddy]);
    console.log(`[pushpals] localbuddy log: ${localbuddyService.logPath ?? serviceLogPaths.localbuddy}`);
    recordStartupPhase("localbuddy", localBuddyPhaseStartedAt, "started");
  } else {
    recordStartupPhase("localbuddy", Date.now(), "skipped");
    console.log("[pushpals] Embedded LocalBuddy disabled for this CLI session; skipping start.");
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      "[pushpals] localbuddy disabled for this CLI session; embedded localbuddy start skipped.",
    );
  }

  const remoteBuddyPhaseStartedAt = Date.now();
  console.log("[pushpals] Starting embedded RemoteBuddy...");
  const remotebuddyService = launchService("remotebuddy", [runtimeBinaries.remotebuddy]);
  const remotebuddyLogPath = remotebuddyService.logPath ?? serviceLogPaths.remotebuddy;
  console.log(`[pushpals] remotebuddy log: ${remotebuddyLogPath}`);
  recordStartupPhase("remotebuddy", remoteBuddyPhaseStartedAt, "started");
  let lastReportedRemoteBuddyAutonomyState: RemoteBuddyAutonomousEngineState = "unknown";
  const reportRemoteBuddyAutonomousEngineState = (): void => {
    const autonomyState = readRemoteBuddyAutonomousEngineState(remotebuddyLogPath);
    if (autonomyState === "unknown" || autonomyState === lastReportedRemoteBuddyAutonomyState) {
      return;
    }
    lastReportedRemoteBuddyAutonomyState = autonomyState;
    if (autonomyState === "enabled") {
      console.log("[pushpals] Embedded RemoteBuddy autonomous engine is enabled.");
      appendRuntimeServicesLogLine(
        runtimeServicesLogPath,
        "[pushpals] embedded remotebuddy autonomous engine is enabled.",
      );
      return;
    }
    console.warn(
      "[pushpals] Embedded RemoteBuddy autonomous engine is disabled (remotebuddy.autonomy.enabled=false).",
    );
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      "[pushpals] embedded remotebuddy autonomous engine is disabled (remotebuddy.autonomy.enabled=false).",
    );
  };
  reportRemoteBuddyAutonomousEngineState();

  if (runtimePreflight.config.remotebuddy.autoSpawnWorkerpals) {
    const workerpalPhaseStartedAt = Date.now();
    const workerpalReadinessProbeTimeoutMs = resolveWorkerpalStartupReadinessProbeTimeoutMs(
      runtimePreflight.config,
    );
    const workerpalCapacity = await waitForWorkerpalCapacity({
      serverUrl: opts.serverUrl,
      timeoutMs: workerpalReadinessProbeTimeoutMs,
      ttlMs: runtimePreflight.config.remotebuddy.workerpalOnlineTtlMs,
    });
    if (!workerpalCapacity.ok) {
      const startupProbeWarning =
        `embedded workerpal readiness probe did not find idle capacity within ${workerpalReadinessProbeTimeoutMs}ms ` +
        `(${workerpalCapacity.detail}); continuing startup while WorkerPal warmup finishes in the background.`;
      console.warn(`[pushpals] ${startupProbeWarning}`);
      appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] ${startupProbeWarning}`);
      recordStartupPhase("workerpal", workerpalPhaseStartedAt, "deferred");
    } else {
      console.log(`[pushpals] Embedded WorkerPal capacity is ready (${workerpalCapacity.detail}).`);
      appendRuntimeServicesLogLine(
        runtimeServicesLogPath,
        `[pushpals] embedded workerpal capacity ready (${workerpalCapacity.detail}).`,
      );
      recordStartupPhase("workerpal", workerpalPhaseStartedAt, "ready");
    }
  } else {
    recordStartupPhase("workerpal", Date.now(), "disabled");
  }

  const scmHealthy = await probeSourceControlManager(opts.sourceControlManagerPort);
  const scmGitProbe = await resolveSourceControlManagerGitProbe(
    opts.repoRoot,
    runtimeEnv,
    process.platform,
  );
  const scmRemoteStatus = await checkGitRemoteConfigured(
    opts.repoRoot,
    opts.sourceControlManagerRemote,
    runtimeEnv,
  );
  if (!scmHealthy) {
    const scmPhaseStartedAt = Date.now();
    if (!scmGitProbe.ok) {
      console.warn(
        "[pushpals] Git is not available to embedded SourceControlManager; skipping SCM startup.",
      );
      appendRuntimeServicesLogLine(
        runtimeServicesLogPath,
        `[pushpals] source_control_manager skipped: git is unavailable in embedded runtime env (${scmGitProbe.detail}).`,
      );
      recordStartupPhase("source_control_manager", scmPhaseStartedAt, "skipped_no_git");
    } else if (scmRemoteStatus.status === "error") {
      console.warn(
        `[pushpals] Could not inspect SourceControlManager git remote "${opts.sourceControlManagerRemote}"; skipping SCM startup.`,
      );
      appendRuntimeServicesLogLine(
        runtimeServicesLogPath,
        `[pushpals] source_control_manager skipped: remote "${opts.sourceControlManagerRemote}" could not be inspected (${scmRemoteStatus.detail}).`,
      );
      recordStartupPhase("source_control_manager", scmPhaseStartedAt, "skipped_remote_error");
    } else if (scmRemoteStatus.status === "ok") {
      console.log(`[pushpals] Embedded SourceControlManager git=${scmGitProbe.detail}`);
      console.log("[pushpals] Starting embedded SourceControlManager...");
      const sourceControlManagerService = launchService("source_control_manager", [
        runtimeBinaries.sourceControlManager,
        "--skip-clean-check",
      ]);
      console.log(
        `[pushpals] source_control_manager log: ${sourceControlManagerService.logPath ?? serviceLogPaths.source_control_manager}`,
      );
      recordStartupPhase("source_control_manager", scmPhaseStartedAt, "started");
    } else {
      console.log(
        `[pushpals] Repo has no git remote "${opts.sourceControlManagerRemote}"; skipping embedded SourceControlManager.`,
      );
      appendRuntimeServicesLogLine(
        runtimeServicesLogPath,
        `[pushpals] source_control_manager skipped: repo has no remote "${opts.sourceControlManagerRemote}".`,
      );
      recordStartupPhase("source_control_manager", scmPhaseStartedAt, "skipped_no_remote");
    }
  } else {
    recordStartupPhase("source_control_manager", Date.now(), "reused");
    console.log("[pushpals] SourceControlManager already healthy; skipping embedded start.");
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      "[pushpals] source_control_manager already healthy; embedded start skipped.",
    );
  }

  const deadline = Date.now() + DEFAULT_RUNTIME_BOOT_TIMEOUT_MS;
  const readinessPhaseStartedAt = Date.now();
  const optionalServiceExitWarned = new Set<RuntimeServiceName>();
  while (Date.now() < deadline) {
    reportRemoteBuddyAutonomousEngineState();
    for (const service of serviceManager.getServices()) {
      if (service.exited) {
        if (isOptionalEmbeddedService(service.name)) {
          const runtimeServiceName = service.name as RuntimeServiceName;
          const serviceLogPath = service.logPath ?? serviceLogPaths[runtimeServiceName];
          if (!optionalServiceExitWarned.has(runtimeServiceName)) {
            console.warn(
              `[pushpals] Embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}); startup will continue and host supervisor will attempt recovery.`,
            );
            appendRuntimeServicesLogLine(
              runtimeServicesLogPath,
              `[pushpals] embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}); startup will continue and host supervisor will attempt recovery.`,
            );
            const tail = readLogTail(serviceLogPath);
            if (tail) {
              console.warn(`[pushpals] ${service.name} log tail:\n${tail}`);
              appendRuntimeServicesLogLine(
                runtimeServicesLogPath,
                `[pushpals] ${service.name} log tail:\n${tail}`,
              );
            }
            optionalServiceExitWarned.add(runtimeServiceName);
          }
          continue;
        }
        const runtimeServiceName = service.name as RuntimeServiceName;
        const serviceLogPath = service.logPath ?? serviceLogPaths[runtimeServiceName];
        const tail = readLogTail(serviceLogPath);
        appendRuntimeServicesLogLine(
          runtimeServicesLogPath,
          `[pushpals] embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}).`,
        );
        recordStartupPhase("readiness", readinessPhaseStartedAt, "failed");
        emitStartupTimingSummary("failed", `${service.name} exited during startup`);
        stopRuntimeServices(serviceManager.getServices());
        throw new Error(
          `Embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}). ` +
            `See ${serviceLogPath}${tail ? `\n--- ${service.name} log tail ---\n${tail}` : ""}`,
        );
      }
    }

    const health = localBuddyEnabled ? await probeLocalBuddy(opts.localAgentUrl) : null;
    const remoteBuddyHealth = await probeRemoteBuddySessionConsumer(opts.serverUrl, opts.sessionId);
    if ((!localBuddyEnabled || health?.ok) && remoteBuddyHealth.ok) {
      reportRemoteBuddyAutonomousEngineState();
      const stabilityDeadline = Date.now() + DEFAULT_SERVICE_STABILITY_GRACE_MS;
      while (Date.now() < stabilityDeadline) {
        reportRemoteBuddyAutonomousEngineState();
        for (const service of serviceManager.getServices()) {
          if (!service.exited) continue;
          if (isOptionalEmbeddedService(service.name)) {
            const runtimeServiceName = service.name as RuntimeServiceName;
            const serviceLogPath = service.logPath ?? serviceLogPaths[runtimeServiceName];
            if (!optionalServiceExitWarned.has(runtimeServiceName)) {
              const tail = readLogTail(serviceLogPath);
              console.warn(
                `[pushpals] Embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}); startup will continue and host supervisor will attempt recovery.`,
              );
              appendRuntimeServicesLogLine(
                runtimeServicesLogPath,
                `[pushpals] embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}); startup will continue and host supervisor will attempt recovery.`,
              );
              if (tail) {
                console.warn(`[pushpals] ${service.name} log tail:\n${tail}`);
                appendRuntimeServicesLogLine(
                  runtimeServicesLogPath,
                  `[pushpals] ${service.name} log tail:\n${tail}`,
                );
              }
              optionalServiceExitWarned.add(runtimeServiceName);
            }
            continue;
          }
          const runtimeServiceName = service.name as RuntimeServiceName;
          const serviceLogPath = service.logPath ?? serviceLogPaths[runtimeServiceName];
          const tail = readLogTail(serviceLogPath);
          appendRuntimeServicesLogLine(
            runtimeServicesLogPath,
            `[pushpals] embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}).`,
          );
          recordStartupPhase("readiness", readinessPhaseStartedAt, "failed");
          emitStartupTimingSummary("failed", `${service.name} exited immediately after bootstrap`);
          stopRuntimeServices(serviceManager.getServices());
          throw new Error(
            `Embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}). ` +
              `See ${serviceLogPath}${tail ? `\n--- ${service.name} log tail ---\n${tail}` : ""}`,
          );
        }
        await Bun.sleep(250);
      }
      console.log("[pushpals] Embedded runtime is ready.");
      recordStartupPhase("readiness", readinessPhaseStartedAt, "ready");
      emitStartupTimingSummary("ready");
      appendRuntimeServicesLogLine(runtimeServicesLogPath, "[pushpals] embedded runtime is ready.");
      return {
        serviceManager,
        pushpalsLogPath: runtimeServicesLogPath,
      };
    }
    await Bun.sleep(DEFAULT_RUNTIME_BOOT_POLL_MS);
  }

  stopRuntimeServices(serviceManager.getServices());
  const remoteBuddyHealth = await probeRemoteBuddySessionConsumer(opts.serverUrl, opts.sessionId);
  if (!localBuddyEnabled && !remoteBuddyHealth.ok) {
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      `[pushpals] timed out waiting for RemoteBuddy session consumer readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms (${remoteBuddyHealth.detail}).`,
    );
    recordStartupPhase("readiness", readinessPhaseStartedAt, "timeout");
    emitStartupTimingSummary("failed", "remotebuddy readiness timeout");
    throw new Error(
      `Timed out waiting for RemoteBuddy session consumer readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms (${remoteBuddyHealth.detail})`,
    );
  }
  if (!localBuddyEnabled) {
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      `[pushpals] timed out waiting for embedded runtime readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms.`,
    );
    recordStartupPhase("readiness", readinessPhaseStartedAt, "timeout");
    emitStartupTimingSummary("failed", "embedded runtime readiness timeout");
    throw new Error(
      `Timed out waiting for embedded runtime readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms`,
    );
  }
  appendRuntimeServicesLogLine(
    runtimeServicesLogPath,
    `[pushpals] timed out waiting for LocalBuddy at ${opts.localAgentUrl} and RemoteBuddy session consumer after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms.`,
  );
  recordStartupPhase("readiness", readinessPhaseStartedAt, "timeout");
  emitStartupTimingSummary("failed", "localbuddy and remotebuddy readiness timeout");
  throw new Error(
    `Timed out waiting for LocalBuddy at ${opts.localAgentUrl} and RemoteBuddy session consumer after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms`,
  );
}

function readCliState(pathValue: string): CliState {
  if (!existsSync(pathValue)) return {};
  try {
    const raw = readFileSync(pathValue, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    return {
      monitoringHubUrl:
        typeof parsed.monitoringHubUrl === "string" ? parsed.monitoringHubUrl : undefined,
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : undefined,
      localAgentUrl: typeof parsed.localAgentUrl === "string" ? parsed.localAgentUrl : undefined,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      repoRoot: typeof parsed.repoRoot === "string" ? parsed.repoRoot : undefined,
      pushpalsLogPath:
        typeof parsed.pushpalsLogPath === "string" ? parsed.pushpalsLogPath : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch {
    return {};
  }
}

function writeCliState(pathValue: string, state: CliState): void {
  const payload = {
    version: stateVersion,
    ...state,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(pathValue), { recursive: true });
  writeFileSync(pathValue, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function resolveCliStatePath(repoRoot: string): string | null {
  return resolveGitStateFilePath(repoRoot, "pushpals-cli-state.json");
}

async function looksLikeMonitoringHub(url: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(url, {}, 700);
    if (!response.ok) return false;
    const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/html")) return false;
    const text = await response.text();
    const sample = text.slice(0, 8_192).toLowerCase();
    return (
      sample.includes("pushpals") ||
      sample.includes("mission control") ||
      sample.includes("jobs & traces")
    );
  } catch {
    return false;
  }
}

function buildMonitoringHubRuntimeBootstrap(opts: {
  serverUrl: string;
  sessionId: string;
}): MonitoringHubRuntimeBootstrap {
  return {
    serverUrl: opts.serverUrl,
    sessionId: opts.sessionId,
    clientId: `cli-monitor-${opts.sessionId}`,
    clientKind: "cli_monitor",
    clientLabel: "CLI Monitor",
  };
}

export function injectMonitoringHubBootstrap(
  html: string,
  bootstrap: MonitoringHubRuntimeBootstrap,
): string {
  const payload = jsonHtmlBootstrap(bootstrap);
  const script = `<script>globalThis.__PUSHPALS_WEB_BOOTSTRAP__=${payload};</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${script}</head>`);
  }
  return `${script}${html}`;
}

function monitoringHubContentType(pathValue: string): string {
  switch (extname(pathValue).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function resolveMonitoringHubAssetPath(assetRoot: string, pathname: string): string | null {
  const root = resolve(assetRoot);
  const rootPrefix = `${root}${root.endsWith("\\") || root.endsWith("/") ? "" : process.platform === "win32" ? "\\" : "/"}`;
  const decodedPath = decodeURIComponent(pathname);
  const trimmedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const relativePath = trimmedPath.replace(/^\/+/, "");
  const candidatePath = resolve(root, relativePath);
  if (candidatePath !== root && !candidatePath.startsWith(rootPrefix)) return null;
  if (existsSync(candidatePath)) return candidatePath;

  if (!extname(relativePath)) {
    const nestedIndexPath = resolve(root, relativePath, "index.html");
    if (
      (nestedIndexPath === root || nestedIndexPath.startsWith(rootPrefix)) &&
      existsSync(nestedIndexPath)
    ) {
      return nestedIndexPath;
    }
    return join(root, "index.html");
  }

  return null;
}

async function serveBundledMonitoringHub(
  assetRoot: string,
  pathname: string,
  bootstrap: MonitoringHubRuntimeBootstrap,
): Promise<Response | null> {
  const assetPath = resolveMonitoringHubAssetPath(assetRoot, pathname);
  if (!assetPath || !existsSync(assetPath)) return null;
  if (assetPath.endsWith("index.html")) {
    const html = injectMonitoringHubBootstrap(readFileSync(assetPath, "utf8"), bootstrap);
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  return new Response(Bun.file(assetPath), {
    headers: {
      "content-type": monitoringHubContentType(assetPath),
      "cache-control": "no-store",
    },
  });
}

export function buildEmbeddedMonitoringHubHtml(opts: {
  serverUrl: string;
  sessionId: string;
}): string {
  const bootstrap = jsonHtmlBootstrap({
    serverUrl: opts.serverUrl,
    sessionId: opts.sessionId,
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PushPals CLI Monitor</title>
  <style>
    :root { color-scheme: dark; --bg:#08111b; --panel:#112235; --panel2:#16324a; --line:#2b5876; --fg:#edf6ff; --muted:#90b5d6; --accent:#58d8c3; --warn:#ffbf5f; --bad:#ff7f7f; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Consolas, "SFMono-Regular", monospace; background:radial-gradient(circle at top, #0d2233, var(--bg) 56%); color:var(--fg); }
    main { max-width:1200px; margin:0 auto; padding:24px; }
    h1,h2 { margin:0 0 12px; }
    p { color:var(--muted); }
    .row { display:grid; gap:16px; margin-top:16px; }
    .cards { grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); }
    .panels { grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
    .card, .panel { border:1px solid var(--line); background:linear-gradient(180deg,var(--panel),var(--panel2)); border-radius:16px; padding:16px; box-shadow:0 12px 40px rgba(0,0,0,.22); }
    .label { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin-bottom:10px; }
    .value { font-size:32px; font-weight:700; color:var(--accent); }
    .sub { margin-top:8px; color:var(--muted); white-space:pre-wrap; word-break:break-word; }
    .list { display:grid; gap:10px; margin-top:12px; }
    .item { border:1px solid rgba(88,216,195,.18); border-radius:12px; padding:12px; background:rgba(8,17,27,.42); }
    .meta { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 0; }
    .pill { border:1px solid var(--line); border-radius:999px; padding:6px 10px; color:var(--muted); }
    a { color:var(--accent); }
  </style>
</head>
<body>
  <main>
    <h1>PushPals CLI Monitor</h1>
    <p>Lightweight embedded monitor for CLI-managed runtimes.</p>
    <div class="meta" id="meta"></div>
    <section class="row cards" id="cards"></section>
    <section class="row panels">
      <div class="panel">
        <h2>Requests</h2>
        <div id="requests" class="list"></div>
      </div>
      <div class="panel">
        <h2>Jobs</h2>
        <div id="jobs" class="list"></div>
      </div>
      <div class="panel">
        <h2>Completions</h2>
        <div id="completions" class="list"></div>
      </div>
    </section>
  </main>
  <script>
    const boot = ${bootstrap};
    const pollMs = ${MONITOR_POLL_MS};
    const metaEl = document.getElementById("meta");
    const cardsEl = document.getElementById("cards");
    const requestsEl = document.getElementById("requests");
    const jobsEl = document.getElementById("jobs");
    const completionsEl = document.getElementById("completions");

    function esc(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    async function fetchJson(path) {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
      return await res.json();
    }

    function setList(target, rows, emptyLabel, formatter) {
      if (!Array.isArray(rows) || rows.length === 0) {
        target.innerHTML = '<div class="item">' + esc(emptyLabel) + "</div>";
        return;
      }
      target.innerHTML = rows.map((row) => '<div class="item">' + formatter(row) + "</div>").join("");
    }

    function renderStatus(status) {
      const workers = status?.workers ?? {};
      const queues = status?.queues ?? {};
      const runtime = status?.runtime ?? {};
      const repo = status?.repo ?? {};
      const llmUsage = status?.llmUsage ?? {};
      const cards = [
        { label: "Server uptime", value: Math.round((Number(runtime.uptimeMs ?? 0) / 60000)) + "m", sub: runtime.startedAt ?? "unknown" },
        { label: "Workers online", value: String(workers.online ?? 0), sub: "busy " + String(workers.busy ?? 0) + " | idle " + String(workers.idle ?? 0) },
        { label: "Pending requests", value: String(queues.requests?.pending ?? 0), sub: "claimed " + String(queues.requests?.claimed ?? 0) },
        { label: "Pending jobs", value: String(queues.jobs?.pending ?? 0), sub: "claimed " + String(queues.jobs?.claimed ?? 0) },
        { label: "Completions", value: String(queues.completions?.pending ?? 0), sub: "processed " + String(queues.completions?.processed ?? 0) },
        { label: "LLM usage (24h)", value: String(llmUsage.totalTokens ?? 0), sub: "calls " + String(llmUsage.totalCalls ?? 0) }
      ];
      cardsEl.innerHTML = cards.map((card) => '<div class="card"><div class="label">' + esc(card.label) + '</div><div class="value">' + esc(card.value) + '</div><div class="sub">' + esc(card.sub) + '</div></div>').join("");
      metaEl.innerHTML = [
        '<span class="pill">server ' + esc(boot.serverUrl) + '</span>',
        '<span class="pill">session ' + esc(boot.sessionId) + '</span>',
        '<span class="pill">repo ' + esc(repo?.root ?? repo?.remoteUrl ?? "current repo") + '</span>'
      ].join("");
    }

    function render() {
      Promise.all([
        fetchJson('/api/status'),
        fetchJson('/api/requests'),
        fetchJson('/api/jobs'),
        fetchJson('/api/completions')
      ]).then(([status, requests, jobs, completions]) => {
        renderStatus(status);
        setList(requestsEl, requests?.requests?.slice(0, 8), 'No requests', (row) =>
          '<strong>' + esc(row?.priority ?? 'request') + '</strong><div class="sub">' +
          esc((row?.status ?? 'unknown') + ' | ' + (row?.id ?? '')) + '</div><div class="sub">' +
          esc(String(row?.prompt ?? '').slice(0, 220)) + '</div>');
        setList(jobsEl, jobs?.jobs?.slice(0, 8), 'No jobs', (row) =>
          '<strong>' + esc(row?.kind ?? 'job') + '</strong><div class="sub">' +
          esc((row?.status ?? 'unknown') + ' | worker ' + (row?.workerId ?? '--')) + '</div><div class="sub">' +
          esc((row?.summary ?? row?.error ?? row?.id ?? '').slice(0, 220)) + '</div>');
        setList(completionsEl, completions?.completions?.slice(0, 8), 'No completions', (row) =>
          '<strong>' + esc(row?.status ?? 'completion') + '</strong><div class="sub">' +
          esc((row?.jobId ?? '') + ' | ' + (row?.commitSha ?? '')) + '</div><div class="sub">' +
          esc((row?.message ?? '').slice(0, 220)) + '</div>');
      }).catch((err) => {
        cardsEl.innerHTML = '<div class="card"><div class="label">Monitor error</div><div class="sub">' + esc(err?.message ?? err) + '</div></div>';
      });
    }

    render();
    setInterval(render, pollMs);
  </script>
</body>
</html>`;
}

async function proxyMonitoringHubRequest(serverUrl: string, pathValue: string): Promise<Response> {
  const target = `${serverUrl}${pathValue}`;
  const upstream = await fetchWithTimeout(target, {}, 10_000);
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": String(upstream.headers.get("content-type") ?? "application/json"),
      "cache-control": "no-store",
    },
  });
}

export async function startEmbeddedMonitoringHub(opts: {
  serverUrl: string;
  sessionId: string;
  preferredPort: number;
  assetRoot?: string | null;
}): Promise<MonitoringHubHandle | null> {
  const monitoringHubAssetRoot =
    opts.assetRoot === undefined ? await ensureBundledMonitoringHubRoot() : opts.assetRoot;
  if (!monitoringHubAssetRoot || !looksLikeMonitoringHubBuild(monitoringHubAssetRoot)) {
    console.error(
      "[pushpals] Unified monitoring hub assets are unavailable; build or export the packaged client monitor first.",
    );
    return null;
  }
  const bootstrap = buildMonitoringHubRuntimeBootstrap({
    serverUrl: opts.serverUrl,
    sessionId: opts.sessionId,
  });

  const candidatePorts = Array.from(
    { length: MONITOR_SCAN_PORTS },
    (_, index) => opts.preferredPort + index,
  ).concat(0);

  for (const port of candidatePorts) {
    try {
      const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        idleTimeout: 30,
        fetch: async (req) => {
          const url = new URL(req.url);
          if (url.pathname === "/healthz") {
            return Response.json({
              ok: true,
              port,
              serverUrl: opts.serverUrl,
              sessionId: opts.sessionId,
            });
          }
          if (url.pathname === "/api/status") {
            return await proxyMonitoringHubRequest(opts.serverUrl, "/system/status");
          }
          if (url.pathname === "/api/requests") {
            return await proxyMonitoringHubRequest(opts.serverUrl, "/requests?status=all&limit=20");
          }
          if (url.pathname === "/api/jobs") {
            return await proxyMonitoringHubRequest(opts.serverUrl, "/jobs?status=all&limit=20");
          }
          if (url.pathname === "/api/completions") {
            return await proxyMonitoringHubRequest(
              opts.serverUrl,
              "/completions?status=all&limit=20",
            );
          }
          const bundledResponse = await serveBundledMonitoringHub(
            monitoringHubAssetRoot,
            url.pathname,
            bootstrap,
          );
          if (bundledResponse) return bundledResponse;
          return new Response("Not found", { status: 404 });
        },
      });
      return {
        url: `http://127.0.0.1:${server.port}`,
        port: Number(server.port),
        embedded: true,
        stop: () => server.stop(true),
      };
    } catch {
      // try next port
    }
  }
  return null;
}

async function resolveMonitoringHub(opts: {
  preferredUrl: string;
  fallbackPort: number;
  serverUrl: string;
  sessionId: string;
}): Promise<MonitoringHubHandle | null> {
  const explicit = normalizeUrl(opts.preferredUrl);
  if (explicit) {
    if (!isLoopbackUrl(explicit)) {
      console.warn(
        `[pushpals] Preferred monitoring hub ${explicit} is not local; ignoring it and starting a local monitor instead.`,
      );
    } else if (await looksLikeMonitoringHub(explicit)) {
      return { url: explicit, port: 0, stop: () => {}, embedded: false };
    } else {
      console.warn(
        `[pushpals] Preferred monitoring hub ${explicit} is unavailable; starting embedded monitor instead.`,
      );
    }
  }

  for (let port = opts.fallbackPort; port < opts.fallbackPort + MONITOR_SCAN_PORTS; port++) {
    const candidate = `http://127.0.0.1:${port}`;
    if (await looksLikeMonitoringHub(candidate)) {
      return { url: candidate, port, stop: () => {}, embedded: false };
    }
  }

  const embedded = await startEmbeddedMonitoringHub(opts);
  if (!embedded) {
    console.warn("[pushpals] Embedded monitoring hub could not start on any expected local port.");
  }
  return embedded;
}

async function sendMessageToServerSession(
  serverUrl: string,
  sessionId: string,
  text: string,
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${serverUrl}/sessions/${encodeURIComponent(sessionId)}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
      15_000,
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        `[pushpals] Session message rejected: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[pushpals] Failed to reach server session endpoint: ${String(err)}`);
    return false;
  }
}

export function formatSessionEventLine(
  event: NonNullable<SessionStreamPayload["envelope"]>,
): string | null {
  const type = String(event.type ?? "").toLowerCase();
  const from = String(event.from ?? "");
  const payload = event.payload ?? {};

  if (!shouldDisplayInteractiveSessionEvent(event)) return null;
  if (type === "message") return null;
  if (type === "assistant_message") {
    const text = String(payload.text ?? "").trim();
    if (!text) return null;
    return `assistant> ${text}`;
  }
  if (type === "task_progress") {
    const taskId = String(payload.taskId ?? "").slice(0, 8);
    const message = String(payload.message ?? "").trim();
    return message ? `[task ${taskId}] ${message}` : null;
  }
  if (type === "task_failed") {
    const taskId = String(payload.taskId ?? "").slice(0, 8);
    const message = String(payload.message ?? "").trim();
    return `[task ${taskId}] failed: ${message || "unknown"}`;
  }
  if (type === "task_completed") {
    const taskId = String(payload.taskId ?? "").slice(0, 8);
    const summary = String(payload.summary ?? "").trim();
    return `[task ${taskId}] completed${summary ? `: ${summary}` : ""}`;
  }
  if (type === "job_failed") {
    const jobId = String(payload.jobId ?? "").slice(0, 8);
    const message = String(payload.message ?? "").trim();
    return `[job ${jobId}] failed: ${message || "unknown"}`;
  }
  if (type === "error") {
    const message = String(payload.message ?? "").trim();
    return `[event error] ${message || "unknown"}`;
  }
  if (type === "status") {
    const state = String(payload.state ?? "").trim();
    const detail = String(payload.detail ?? "").trim();
    const source = from || String(payload.agentId ?? "status");
    return detail
      ? `[status ${source}] ${state || "unknown"} - ${detail}`
      : `[status ${source}] ${state || "unknown"}`;
  }
  return null;
}

function buildSessionEventReplayFingerprint(
  event: NonNullable<SessionStreamPayload["envelope"]>,
): { source: string; fingerprint: string } | null {
  const type = String(event.type ?? "")
    .trim()
    .toLowerCase();
  if (type !== "status") return null;
  const payload = event.payload ?? {};
  const source = String(event.from ?? payload.agentId ?? "status")
    .trim()
    .toLowerCase();
  const state = String(payload.state ?? "")
    .trim()
    .toLowerCase();
  const detail = String(payload.detail ?? "")
    .trim()
    .toLowerCase();
  const message = String(payload.message ?? "")
    .trim()
    .toLowerCase();
  return {
    source,
    fingerprint: `${type}:${source}:${state}:${detail}:${message}`,
  };
}

export function createSessionEventReplayFilter(): SessionEventReplayFilter {
  const seenEventIds = new Set<string>();
  const lastStatusFingerprintBySource = new Map<string, string>();

  return {
    shouldRender(event) {
      const eventId = String(event.id ?? "").trim();
      if (eventId) {
        if (seenEventIds.has(eventId)) return false;
        seenEventIds.add(eventId);
      }

      const replayStatus = buildSessionEventReplayFingerprint(event);
      if (!replayStatus) return true;
      const previous = lastStatusFingerprintBySource.get(replayStatus.source);
      if (previous === replayStatus.fingerprint) return false;
      lastStatusFingerprintBySource.set(replayStatus.source, replayStatus.fingerprint);
      return true;
    },
  };
}

async function runSessionStream(
  serverUrl: string,
  sessionId: string,
  client: ClientStreamIdentity,
  print: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const replayFilter = createSessionEventReplayFilter();

  while (!signal.aborted) {
    try {
      const response = await fetchWithTimeout(
        `${serverUrl}/sessions/${encodeURIComponent(sessionId)}/events${buildClientTransportQuery(cursor, client)}`,
        {},
        15_000,
      );
      if (!response.ok || !response.body) {
        print(`[pushpals] Session stream unavailable: HTTP ${response.status}`);
        await Bun.sleep(SSE_RECONNECT_MS);
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          if (!block.trim()) continue;
          let blockCursor = 0;
          let rawData = "";
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("id:")) {
              const idText = line.slice(3).trim();
              const parsed = Number.parseInt(idText, 10);
              if (Number.isFinite(parsed) && parsed > 0) {
                blockCursor = parsed;
              }
            } else if (line.startsWith("data:")) {
              rawData += `${line.slice(5).trim()}\n`;
            }
          }
          if (!rawData.trim()) continue;
          let parsed: SessionStreamPayload | null = null;
          try {
            parsed = JSON.parse(rawData.trim()) as SessionStreamPayload;
          } catch {
            continue;
          }
          const serverCursor =
            typeof parsed.cursor === "number" && Number.isFinite(parsed.cursor) ? parsed.cursor : 0;
          cursor = Math.max(cursor, blockCursor, serverCursor);
          if (!parsed.envelope) continue;
          if (!replayFilter.shouldRender(parsed.envelope)) continue;
          const line = formatSessionEventLine(parsed.envelope);
          if (line) print(line);
        }
      }
    } catch {
      // Reconnect loop.
    }
    if (!signal.aborted) {
      await Bun.sleep(SSE_RECONNECT_MS);
    }
  }
}

export function buildOpenMonitoringHubCommand(url: string, platform = process.platform): string[] {
  if (platform === "win32") {
    return ["cmd", "/c", "start", "", url];
  }
  if (platform === "darwin") {
    return ["open", url];
  }
  return ["xdg-open", url];
}

async function openMonitoringHub(url: string): Promise<boolean> {
  const cmd = buildOpenMonitoringHubCommand(url, process.platform);
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  return code === 0;
}

export function isCliExitCommand(text: string): boolean {
  const normalized = String(text ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized === "/exit" ||
    normalized === "/quit" ||
    normalized === "exit" ||
    normalized === "quit"
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  logCliInvocation(argv);
  const parsed = parseArgs(argv);
  if (!parsed) return;
  const cwd = process.cwd();
  const repoRoot = await resolveCurrentGitRepoRoot(cwd);
  if (!repoRoot) {
    console.error("[pushpals] Refusing to start: current directory is not a git repository.");
    console.error(`[pushpals] cwd=${cwd}`);
    console.error("[pushpals] Run from a repo directory, or initialize one with `git init`.");
    process.exit(1);
  }

  const preparedRuntime = await prepareCliRuntime({
    repoRoot,
    runtimeRoot: parsed.runtimeRoot,
    runtimeTag: parsed.runtimeTag,
  });
  const config = preparedRuntime.runtimePreflight.config;
  const statePath = resolveCliStatePath(repoRoot);
  if (parsed.clear) {
    const serverUrl = normalizeLoopbackUrl(
      parsed.serverUrl ?? process.env.PUSHPALS_SERVER_URL,
      config.server.url,
    );
    const exitCode = await clearPushpalsState({
      repoRoot,
      runtimeRoot: preparedRuntime.runtimeRoot,
      config,
      serverUrl,
      cliStatePath: statePath,
    });
    process.exit(exitCode);
  }
  console.log("[pushpals] Running runtime preflight...");
  console.log(`[pushpals] runtimeRoot=${preparedRuntime.runtimeRoot}`);
  if (preparedRuntime.runtimeTag) {
    console.log(`[pushpals] runtimeTag=${preparedRuntime.runtimeTag}`);
  } else if (!preparedRuntime.preflightUsesEmbeddedRuntime) {
    console.log("[pushpals] runtimeTag=(deferred; using repo config for preflight)");
  } else {
    console.log("[pushpals] runtimeTag=(deferred until embedded auto-start is needed)");
  }
  emitCliRuntimePreflight(preparedRuntime.runtimePreflight);
  if (!preparedRuntime.runtimePreflight.ok) {
    process.exit(1);
  }

  if (config.remotebuddy.autonomy.enabled) {
    console.log("[pushpals] RemoteBuddy autonomy is enabled for CLI.");
  } else {
    console.warn(
      "[pushpals] RemoteBuddy autonomy is disabled in config (remotebuddy.autonomy.enabled=false); continuing.",
    );
  }
  const serverUrl = normalizeLoopbackUrl(
    parsed.serverUrl ?? process.env.PUSHPALS_SERVER_URL,
    config.server.url,
  );
  const localAgentUrl = normalizeLoopbackUrl(
    parsed.localAgentUrl ?? process.env.EXPO_PUBLIC_LOCAL_AGENT_URL,
    config.client.localAgentUrl,
  );
  const sessionId = String(
    parsed.sessionId ?? process.env.PUSHPALS_SESSION_ID ?? config.sessionId,
  ).trim();
  let serverHealthy = await probeServer(serverUrl);
  const serverWasAlreadyHealthy = serverHealthy;
  const runEmbeddedRuntimeStartupPrechecks = shouldRunEmbeddedRuntimeStartupPrechecks({
    serverHealthy,
    noAutoStart: parsed.noAutoStart,
  });
  if (runEmbeddedRuntimeStartupPrechecks) {
    const precheckPassed = await enforcePushpalsRemoteBranchPrecheck(
      repoRoot,
      config.sourceControlManager.remote,
      config.sourceControlManager.mainBranch,
    );
    if (!precheckPassed) {
      process.exit(1);
    }
  }
  let scmGitPrecheck: SourceControlManagerGitPrecheckResult = {
    status: "skipped",
    detail: runEmbeddedRuntimeStartupPrechecks
      ? "embedded SourceControlManager startup precheck not run"
      : serverHealthy
        ? "embedded SourceControlManager startup precheck skipped because runtime is already healthy"
        : "embedded SourceControlManager startup precheck skipped because auto-start is disabled",
    env: buildEmbeddedRuntimeEnv(process.env as Record<string, string | undefined>, {
      repoRoot,
      runtimeRoot: preparedRuntime.runtimeRoot,
      useRuntimeConfig: preparedRuntime.preflightUsesEmbeddedRuntime,
      sessionId,
    }),
  };
  let workerpalDockerPrecheck: WorkerpalDockerPrecheckResult = {
    status: "skipped",
    detail: runEmbeddedRuntimeStartupPrechecks
      ? "embedded WorkerPal Docker startup precheck not run"
      : serverHealthy
        ? "embedded WorkerPal Docker startup precheck skipped because runtime is already healthy"
        : "embedded WorkerPal Docker startup precheck skipped because auto-start is disabled",
    env: scmGitPrecheck.env,
  };
  if (runEmbeddedRuntimeStartupPrechecks) {
    scmGitPrecheck = await precheckSourceControlManagerGitAvailability({
      repoRoot,
      remote: config.sourceControlManager.remote,
      runtimeRoot: preparedRuntime.runtimeRoot,
      preflightUsesEmbeddedRuntime: preparedRuntime.preflightUsesEmbeddedRuntime,
      sessionId,
    });
    if (scmGitPrecheck.status === "failed") {
      console.error(
        `[pushpals] Precheck failed: embedded SourceControlManager git command is unavailable (${scmGitPrecheck.detail}).`,
      );
      process.exit(1);
    }
    workerpalDockerPrecheck = await precheckWorkerpalDockerAvailability({
      repoRoot,
      runtimeRoot: preparedRuntime.runtimeRoot,
      preflightUsesEmbeddedRuntime: preparedRuntime.preflightUsesEmbeddedRuntime,
      autoSpawnWorkerpals: Boolean(config.remotebuddy.autoSpawnWorkerpals),
      dockerEnabled: Boolean(config.remotebuddy.workerpalDocker),
      requireDocker: Boolean(config.remotebuddy.workerpalRequireDocker),
      sessionId,
      baseEnv: scmGitPrecheck.env,
    });
  }
  const cliVersion = String(process.env.PUSHPALS_CLI_PACKAGE_VERSION ?? "").trim() || "unknown";
  const cliClient: ClientStreamIdentity = {
    clientId: createRuntimeClientId("cli"),
    kind: "cli",
    label: "CLI",
    version: cliVersion,
    platform: `${process.platform}/${process.arch}`,
    repoRoot,
  };
  let autoStartedServiceManager: ServiceManager | null = null;
  let pushpalsLogPath: string | undefined;
  let resolvedRuntimeTagForAutoStart = preparedRuntime.runtimeTag || parsed.runtimeTag || "";
  const cleanupWorkerpalWarmContainersIfNeeded = async (phase: string): Promise<void> => {
    if (workerpalDockerPrecheck.status === "failed") return;
    if (
      !config.remotebuddy.autoSpawnWorkerpals ||
      !config.remotebuddy.workerpalDocker ||
      !config.remotebuddy.workerpalRequireDocker
    ) {
      return;
    }
    const cleanup = await cleanupLingeringWorkerpalWarmContainers({
      repoRoot,
      env: workerpalDockerPrecheck.env,
    });
    if (!cleanup.ok) {
      console.warn(
        `[pushpals] WorkerPal warm-container cleanup warning (${phase}): ${cleanup.detail}`,
      );
      return;
    }
    if (cleanup.removed > 0) {
      console.log(`[pushpals] ${cleanup.detail} (${phase}).`);
    }
  };
  const cleanupPushPalsGitWorktreesIfNeeded = async (phase: string): Promise<void> => {
    const cleanup = await cleanupLingeringPushPalsGitWorktrees({
      repoRoot,
      env: workerpalDockerPrecheck.env,
    });
    if (!cleanup.ok) {
      console.warn(`[pushpals] PushPals worktree cleanup warning (${phase}): ${cleanup.detail}`);
      return;
    }
    if (cleanup.removed > 0) {
      console.log(`[pushpals] ${cleanup.detail} (${phase}).`);
    }
  };
  const reportWorkerExecutionReadiness = async (): Promise<WorkerExecutionReadiness> => {
    const readiness = await resolveWorkerExecutionReadiness({
      serverUrl,
      ttlMs: config.remotebuddy.workerpalOnlineTtlMs,
      autoSpawnWorkerpals: Boolean(config.remotebuddy.autoSpawnWorkerpals),
      dockerEnabled: Boolean(config.remotebuddy.workerpalDocker),
      requireDocker: Boolean(config.remotebuddy.workerpalRequireDocker),
      repoRoot,
      runtimeRoot: preparedRuntime.runtimeRoot,
      preflightUsesEmbeddedRuntime: preparedRuntime.preflightUsesEmbeddedRuntime,
      sessionId,
      dockerPrecheck: workerpalDockerPrecheck,
      baseEnv: workerpalDockerPrecheck.env,
    });
    for (const line of formatWorkerExecutionReadinessLines(readiness)) {
      console.log(line);
    }
    return readiness;
  };
  const reportWorkerExecutionReadinessFromSnapshot = (
    readiness: WorkerExecutionReadiness,
  ): WorkerExecutionReadiness => {
    for (const line of formatWorkerExecutionReadinessLines(readiness)) {
      console.log(line);
    }
    return readiness;
  };
  const reportEmbeddedRuntimeHealth = (): EmbeddedRuntimeHealth | null => {
    const health = autoStartedServiceManager?.getHealth() ?? null;
    for (const line of formatEmbeddedRuntimeHealthLines(health)) {
      console.log(line);
    }
    return health;
  };
  const stopAutoStartedServices = (): void => {
    if (!autoStartedServiceManager) return;
    autoStartedServiceManager.stop();
    autoStartedServiceManager = null;
  };
  const stopAutoStartedServicesGracefully = async (reason: string): Promise<void> => {
    if (!autoStartedServiceManager) return;
    const serviceManager = autoStartedServiceManager;
    autoStartedServiceManager = null;
    await shutdownEmbeddedServiceManagerGracefully({
      serviceManager,
      serverUrl,
      repoRoot,
      reason,
      cleanupTasks: [
        () => cleanupWorkerpalWarmContainersIfNeeded("cli shutdown"),
        () => cleanupPushPalsGitWorktreesIfNeeded("cli shutdown"),
      ],
    });
  };

  if (!serverHealthy && workerpalDockerPrecheck.status === "failed") {
    console.error(
      `[pushpals] Precheck failed: Docker-backed WorkerPal auto-spawn is required but Docker is unavailable (${workerpalDockerPrecheck.detail}).`,
    );
    console.error(
      "[pushpals] Precheck failed: start Docker Desktop or the Docker daemon, then retry pushpals.",
    );
    process.exit(1);
  }
  if (runEmbeddedRuntimeStartupPrechecks && workerpalDockerPrecheck.status !== "failed") {
    const workerpalImagePrecheck = await prepareEmbeddedWorkerpalDockerImageIfNeeded({
      preparedRuntime,
      config,
      dockerPrecheck: workerpalDockerPrecheck,
      runtimeTagHint: resolvedRuntimeTagForAutoStart || parsed.runtimeTag,
    });
    if (workerpalImagePrecheck.status === "failed") {
      console.error(`[pushpals] Precheck failed: ${workerpalImagePrecheck.detail}.`);
      process.exit(1);
    }
    if (workerpalImagePrecheck.runtimeTag) {
      resolvedRuntimeTagForAutoStart = workerpalImagePrecheck.runtimeTag;
    }
  }
  let remoteBuddyConsumerHealth: RemoteBuddySessionConsumerHealth = {
    ok: false,
    detail: `No connected RemoteBuddy session consumer found for session ${sessionId}`,
  };
  if (!serverHealthy) {
    if (runEmbeddedRuntimeStartupPrechecks) {
      await cleanupWorkerpalWarmContainersIfNeeded("startup preflight");
      await cleanupPushPalsGitWorktreesIfNeeded("startup preflight");
    }
    if (!parsed.noAutoStart) {
      try {
        const startedRuntime = await autoStartRuntimeServices({
          repoRoot,
          serverUrl,
          localAgentUrl,
          sessionId,
          sourceControlManagerPort: config.sourceControlManager.port,
          sourceControlManagerRemote: config.sourceControlManager.remote,
          preparedRuntime,
          requestedRuntimeTag: resolvedRuntimeTagForAutoStart || parsed.runtimeTag,
          startLocalBuddy: resolveCliLocalBuddyAutostart(
            parsed.runtimeOnly,
            Boolean(config.localbuddy.enabled),
          ),
          baseEnv: workerpalDockerPrecheck.env,
        });
        autoStartedServiceManager = startedRuntime.serviceManager;
        pushpalsLogPath = startedRuntime.pushpalsLogPath;
        serverHealthy = await probeServer(serverUrl);
      } catch (err) {
        console.error(`[pushpals] Auto-start failed: ${String(err)}`);
        stopAutoStartedServices();
        if (runEmbeddedRuntimeStartupPrechecks) {
          await cleanupWorkerpalWarmContainersIfNeeded("startup failure cleanup");
          await cleanupPushPalsGitWorktreesIfNeeded("startup failure cleanup");
        }
      }
    }
    if (!serverHealthy) {
      console.error(`[pushpals] Server is unavailable at ${serverUrl}.`);
      if (parsed.noAutoStart) {
        console.error("[pushpals] Auto-start is disabled (--no-auto-start).");
      } else {
        console.error("[pushpals] Auto-start could not bring the embedded runtime online.");
      }
      process.exit(1);
    }
  }
  try {
    await ensureServerRepoAffinity(serverUrl, repoRoot);
  } catch (err) {
    stopAutoStartedServices();
    console.error(`[pushpals] Repo affinity check failed: ${String(err)}`);
    process.exit(1);
  }
  let activeSessionId = sessionId;
  if (!parsed.runtimeOnly) {
    try {
      activeSessionId = await ensureServerSession(serverUrl, sessionId, cliClient);
    } catch (err) {
      stopAutoStartedServices();
      console.error(`[pushpals] Session bootstrap failed: ${String(err)}`);
      process.exit(1);
    }
  }
  remoteBuddyConsumerHealth = await probeRemoteBuddySessionConsumer(serverUrl, activeSessionId);
  if (!serverHealthy) {
    console.error(`[pushpals] Server is unavailable at ${serverUrl}.`);
    process.exit(1);
  }
  if (!remoteBuddyConsumerHealth.ok) {
    stopAutoStartedServices();
    console.error(
      `[pushpals] RemoteBuddy is not ready for session ${activeSessionId}: ${remoteBuddyConsumerHealth.detail}`,
    );
    if (serverWasAlreadyHealthy) {
      console.error(
        "[pushpals] A PushPals runtime is already serving this repo, but it does not have a connected RemoteBuddy consumer for this session.",
      );
      console.error(
        "[pushpals] Refusing to start another embedded RemoteBuddy against the same runtime. Restart or stop the existing runtime before retrying.",
      );
    } else if (parsed.noAutoStart) {
      console.error("[pushpals] Auto-start is disabled (--no-auto-start).");
    } else {
      console.error(
        "[pushpals] Auto-start could not bring the embedded runtime into a usable state.",
      );
    }
    process.exit(1);
  }
  const workerpalCapacity = await waitForWorkerpalCapacity({
    serverUrl,
    timeoutMs: resolveWorkerpalStartupReadinessProbeTimeoutMs(config),
    ttlMs: config.remotebuddy.workerpalOnlineTtlMs,
  });
  if (!workerpalCapacity.ok) {
    console.warn(
      `[pushpals] WorkerPal readiness probe did not find idle capacity yet (${workerpalCapacity.detail}).`,
    );
    console.warn(
      "[pushpals] Continuing startup; WorkerPal warmup may still be in progress and first task dispatch can be delayed.",
    );
    if (workerpalDockerPrecheck.status === "failed") {
      console.warn(`[pushpals] Docker precheck detail: ${workerpalDockerPrecheck.detail}`);
    } else if (serverWasAlreadyHealthy) {
      console.warn(
        "[pushpals] A PushPals runtime is already serving this repo, but it does not currently have an idle WorkerPal available.",
      );
      console.warn(
        "[pushpals] Wait for a worker to become idle or restart the runtime after fixing WorkerPal startup.",
      );
    }
  }
  const startupWorkerExecutionReadiness: WorkerExecutionReadiness = workerpalCapacity.ok
    ? {
        state: "ready",
        detail: workerpalCapacity.detail,
      }
    : workerpalDockerPrecheck.status === "failed"
      ? describeWorkerExecutionReadiness({
          autoSpawnWorkerpals: Boolean(config.remotebuddy.autoSpawnWorkerpals),
          requireDocker:
            Boolean(config.remotebuddy.workerpalDocker) &&
            Boolean(config.remotebuddy.workerpalRequireDocker),
          dockerPrecheck: workerpalDockerPrecheck,
          onlineWorkers: 0,
          idleWorkers: 0,
        })
      : {
          state: "warming",
          detail: workerpalCapacity.detail,
          action: "Wait for WorkerPal auto-spawn/warmup to finish, then rerun /status.",
        };
  const saved = statePath ? readCliState(statePath) : {};
  pushpalsLogPath =
    pushpalsLogPath ||
    (typeof saved.pushpalsLogPath === "string" ? saved.pushpalsLogPath : undefined);
  const preferredHubUrl = normalizeUrl(
    parsed.monitoringHubUrl ?? process.env.PUSHPALS_MONITOR_URL ?? saved.monitoringHubUrl ?? "",
  );
  const monitorPort = parsePositiveInt(process.env.PUSHPALS_CLIENT_PORT, DEFAULT_MONITOR_PORT);
  const monitoringHub = await resolveMonitoringHub({
    preferredUrl: preferredHubUrl,
    fallbackPort: monitorPort,
    serverUrl,
    sessionId: activeSessionId,
  });
  const monitoringHubUrl = monitoringHub?.url ?? "";

  if (statePath) {
    writeCliState(statePath, {
      monitoringHubUrl: monitoringHubUrl || undefined,
      serverUrl,
      localAgentUrl,
      sessionId: activeSessionId,
      repoRoot,
      pushpalsLogPath,
    });
  } else {
    console.warn("[pushpals] Could not resolve git metadata dir; skipping CLI state persistence.");
  }

  console.log("[pushpals] Connected.");
  if (monitoringHubUrl) {
    console.log(`[pushpals] monitoringHubUrl=${monitoringHubUrl}`);
    if (monitoringHub?.embedded) {
      console.log("[pushpals] Embedded monitoring hub is running.");
    }
  } else {
    console.log("[pushpals] monitoringHubUrl=unavailable");
  }
  console.log(`[pushpals] serverUrl=${serverUrl}`);
  console.log(`[pushpals] sessionId=${activeSessionId}`);
  console.log(`[pushpals] repoRoot=${repoRoot}`);
  console.log(`[pushpals] pushpalsLog=${pushpalsLogPath ?? "unavailable"}`);
  console.log(`[pushpals] cliStateFile=${statePath ?? "unavailable"}`);
  reportWorkerExecutionReadinessFromSnapshot(startupWorkerExecutionReadiness);
  reportEmbeddedRuntimeHealth();
  if (parsed.runtimeOnly) {
    console.log("[pushpals] runtimeOnly=true");
  } else {
    console.log("[pushpals] Type a message and press Enter. Use /exit or exit to quit.");
  }

  const streamAbort = new AbortController();
  let rl: Interface | null = null;

  const printIncoming = (line: string): void => {
    if (!line) return;
    if (rl) {
      process.stdout.write(`\n${line}\n`);
      rl.prompt();
      return;
    }
    console.log(line);
  };

  const streamTask = parsed.noStream
    ? Promise.resolve()
    : parsed.runtimeOnly || parsed.statusOnce
      ? Promise.resolve()
      : runSessionStream(serverUrl, activeSessionId, cliClient, printIncoming, streamAbort.signal);

  let stopPromise: Promise<void> | null = null;
  const requestStop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      console.log("[pushpals] Shutting down CLI session...");
      streamAbort.abort();
      const activeRl = rl;
      rl = null;
      if (activeRl) activeRl.close();
      try {
        monitoringHub?.stop();
      } catch {
        // ignore
      }
      if (autoStartedServiceManager) {
        console.log("[pushpals] Stopping embedded runtime services...");
      }
      await stopAutoStartedServicesGracefully("pushpals CLI exit");
    })();
    return stopPromise;
  };

  process.once("SIGINT", () => {
    void requestStop();
  });
  process.once("SIGTERM", () => {
    void requestStop();
  });
  process.once("exit", () => {
    stopAutoStartedServices();
  });

  if (parsed.runtimeOnly) {
    console.log(
      "[pushpals] Runtime-only mode is active. Send `exit` on stdin or terminate the process to stop.",
    );

    await new Promise<void>((resolveStop) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolveStop();
      };

      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);

      const runtimeOnlyInput = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });
      runtimeOnlyInput.on("line", (line) => {
        if (!isCliExitCommand(line)) return;
        void requestStop();
        runtimeOnlyInput.close();
        finish();
      });
      runtimeOnlyInput.on("close", () => {
        void requestStop();
        finish();
      });
    });

    await requestStop();
    await Promise.race([streamTask, Bun.sleep(2_000)]);
    return;
  }

  const printStatusSnapshot = async (): Promise<void> => {
    console.log(`[pushpals] serverUrl=${serverUrl}`);
    console.log(`[pushpals] sessionId=${activeSessionId}`);
    console.log(`[pushpals] repoRoot=${repoRoot}`);
    console.log(`[pushpals] pushpalsLog=${pushpalsLogPath ?? "unavailable"}`);
    console.log(
      monitoringHubUrl
        ? `[pushpals] monitoringHubUrl=${monitoringHubUrl}`
        : "[pushpals] monitoringHubUrl=unavailable",
    );
    await reportWorkerExecutionReadiness();
    reportEmbeddedRuntimeHealth();
  };

  if (parsed.statusOnce) {
    await printStatusSnapshot();
    await requestStop();
    await Promise.race([streamTask, Bun.sleep(2_000)]);
    return;
  }

  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  rl.setPrompt("you> ");
  rl.prompt();

  for await (const rawLine of rl) {
    const text = String(rawLine ?? "").trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    if (isCliExitCommand(text)) {
      await requestStop();
      break;
    }
    if (text === "/hub") {
      console.log(
        monitoringHubUrl
          ? `[pushpals] monitoringHubUrl=${monitoringHubUrl}`
          : "[pushpals] monitoringHubUrl=unavailable",
      );
      rl.prompt();
      continue;
    }
    if (text === "/status") {
      await printStatusSnapshot();
      rl.prompt();
      continue;
    }
    if (text === "/open") {
      if (!monitoringHubUrl) {
        console.log("[pushpals] Monitoring hub is unavailable.");
        rl.prompt();
        continue;
      }
      const opened = await openMonitoringHub(monitoringHubUrl);
      console.log(
        opened
          ? `[pushpals] Opened ${monitoringHubUrl}`
          : `[pushpals] Failed to open browser. Use this link: ${monitoringHubUrl}`,
      );
      rl.prompt();
      continue;
    }

    const normalized = normalizeCliInteractiveMessage(text);
    if (normalized.usageMessage) {
      console.log(`[pushpals] ${normalized.usageMessage}`);
      rl.prompt();
      continue;
    }

    const ok = await sendMessageToServerSession(serverUrl, activeSessionId, normalized.text);
    if (!ok) {
      console.log("[pushpals] Message failed.");
    }
    rl.prompt();
  }

  await requestStop();
  await Promise.race([streamTask, Bun.sleep(2_000)]);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[pushpals] Fatal: ${String(err)}`);
    process.exit(1);
  });
}
