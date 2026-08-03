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
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import {
  basename,
  delimiter,
  dirname,
  extname,
  join,
  relative,
  resolve,
  win32 as pathWin32,
} from "path";
import { createInterface, type Interface } from "readline";
import {
  ServiceManager,
  computeServiceRestartBackoffMs,
  formatEmbeddedRuntimeHealthLines as formatSharedEmbeddedRuntimeHealthLines,
  shouldRestartService,
  startManagedServiceWithRetry,
  type EmbeddedRuntimeHealth,
  type ManagedServiceProcess,
} from "./start_runtime_services.js";
import { forceDeleteWorktreePath } from "../apps/workerpals/src/common/worktree_cleanup.js";
import { isDirectWorkerWorktreePath } from "../apps/workerpals/src/common/direct_worktree.js";
import {
  evaluateClientRuntimePreflight,
  formatClientRuntimePreflightLines,
  type ClientRuntimePreflightResult,
} from "../packages/shared/src/client_preflight.js";
import { normalizePresenceLookupToken } from "../packages/shared/src/communication.js";
import { resolveGitStateFilePath } from "../packages/shared/src/repo.js";
import {
  MINIMUM_SUPPORTED_BUN_VERSION,
  isSupportedBunVersion,
} from "../packages/shared/src/runtime_version.js";
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
  openConfig: boolean;
  createVisionMd: boolean;
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
  runtimeHostPid?: number;
  runtimeHostManagesRuntime?: boolean;
  runtimeHostRuntimeOnly?: boolean;
  updatedAt?: string;
};

type CliClearTarget = {
  label: string;
  path: string;
};

type CliClearFailure = CliClearTarget & {
  detail: string;
};

type CliClearRemoveResult = "removed" | "missing" | CliClearFailure;

type CliClearRemoveOptions = {
  maxAttempts?: number;
  retryDelayMs?: number;
  removePath?: (pathValue: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

type CliRuntimeHostShutdownCandidate = { ok: true; pid: number } | { ok: false; detail: string };

type CliRuntimeHostStopResult = {
  attempted: boolean;
  stopped: boolean;
  pid?: number;
  detail?: string;
};

type CliRuntimeProcessInfo = {
  pid: number;
  parentPid: number;
  commandLine: string;
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
type ProcessOutputCollector = {
  done: Promise<string>;
  snapshot: () => string;
  cancel: () => void;
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
  freshlyInstalled?: boolean;
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
  serverBundlePath: string;
  localbuddyBundlePath: string;
  remotebuddyFallbackBundlePath: string;
  workerpalsBundlePath: string;
  sourceControlManagerBundlePath: string;
  runtimeLaunchTrampolinePath: string;
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
const DEFAULT_REMOTEBUDDY_CONSUMER_STARTUP_GRACE_MS = 8_000;
const DEFAULT_COMMAND_OUTPUT_DRAIN_TIMEOUT_MS = 2_000;
const DEFAULT_COMMAND_OUTPUT_MAX_CHARS = 512_000;
const DEFAULT_REMOTEBUDDY_SILENT_STARTUP_FALLBACK_MS = 20_000;
const DEFAULT_WORKERPAL_STARTUP_STATUS_FETCH_TIMEOUT_MS = 2_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const CLI_CLEAR_REMOVE_MAX_ATTEMPTS = 8;
const CLI_CLEAR_REMOVE_RETRY_DELAY_MS = 250;
const CLI_CLEAR_RUNTIME_HOST_STOP_DELAY_MS = 500;
const CLI_RUNTIME_HOST_COMMAND_PROBE_TIMEOUT_MS = 2_500;
const CLI_CLEAR_RUNTIME_HOST_DISCOVERY_ATTEMPTS = 8;
const CLI_CLEAR_RUNTIME_HOST_DISCOVERY_POLL_MS = 500;
const CLI_RUNTIME_HOST_MAX_ANCESTORS = 16;
const RUNTIME_BINARY_DOWNLOAD_ATTEMPTS = 3;
const DEFAULT_STARTUP_GIT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_GIT_REMOTE_TIMEOUT_MS = 10_000;
const DEFAULT_EMBEDDED_SERVICE_LAUNCH_WARN_MS = 5_000;
const DEFAULT_WINDOWS_RUNTIME_SERVICE_LAUNCH_TIMEOUT_MS = 15_000;
const WINDOWS_RUNTIME_SERVICE_LAUNCH_TIMEOUT_MS_ENV =
  "PUSHPALS_WINDOWS_RUNTIME_SERVICE_LAUNCH_TIMEOUT_MS";
export const RUNTIME_LAUNCH_TRAMPOLINE_READY_LINE = "[pushpals-launch-trampoline] child-started";
const DEFAULT_EMBEDDED_SERVICE_SUPERVISOR_POLL_MS = 1_000;
const EMBEDDED_SERVICE_RESTART_MAX_ATTEMPTS = 4;
const EMBEDDED_SERVICE_RESTART_STABLE_WINDOW_MS = 60_000;
const EMBEDDED_SERVICE_RESTART_BASE_BACKOFF_MS = 2_000;
const EMBEDDED_SERVICE_RESTART_MAX_BACKOFF_MS = 30_000;
const DEFAULT_WORKERPAL_STARTUP_READINESS_PROBE_MAX_MS = 5_000;
const WORKERPAL_STARTUP_READINESS_PROBE_MAX_MS_ENV =
  "PUSHPALS_WORKERPAL_STARTUP_READINESS_PROBE_MAX_MS";
const BLOCKING_WORKERPAL_IMAGE_BUILD_ENV = "PUSHPALS_BLOCKING_WORKERPAL_IMAGE_BUILD";
const WINDOWS_FRESH_RUNTIME_WORKERPAL_PREWARM_DELAY_MS_ENV =
  "PUSHPALS_WINDOWS_FRESH_RUNTIME_WORKERPAL_PREWARM_DELAY_MS";

export function remainingServiceStabilityGraceMs(opts: {
  latestServiceLaunchAtMs: number;
  nowMs?: number;
  graceMs?: number;
}): number {
  const graceMs = Math.max(0, opts.graceMs ?? DEFAULT_SERVICE_STABILITY_GRACE_MS);
  const nowMs = opts.nowMs ?? Date.now();
  if (!Number.isFinite(opts.latestServiceLaunchAtMs) || opts.latestServiceLaunchAtMs <= 0) {
    return graceMs;
  }
  return Math.max(0, graceMs - Math.max(0, nowMs - opts.latestServiceLaunchAtMs));
}
const DEFAULT_WINDOWS_FRESH_RUNTIME_WORKERPAL_PREWARM_DELAY_MS = 30_000;
const CLI_SESSION_JOB_LOG_MAX_CHARS = 700;
const CLI_SESSION_SHOW_JOB_EVENTS_ENV = "PUSHPALS_CLI_SHOW_JOB_EVENTS";
const EMBEDDED_RUNTIME_SAFETY_CAP_DISABLE_ENV = "PUSHPALS_DISABLE_EMBEDDED_SAFETY_CAPS";
const EMBEDDED_RUNTIME_WINDOWS_SAFETY_CAPS: Readonly<Record<string, string>> = {
  REMOTEBUDDY_WORKERPAL_STARTUP_TIMEOUT_MS: "120000",
  WORKERPALS_DOCKER_AGENT_STARTUP_TIMEOUT_MS: "90000",
  WORKERPALS_SKIP_DOCKER_SELF_CHECK: "1",
  WORKERPALS_DOCKER_WARM_MEMORY_MB: "2048",
  WORKERPALS_DOCKER_WARM_CPUS: "2",
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

function isTruthyCliEnvValue(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function parseCliIntEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function shouldShowCliSessionOperationalEvents(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isTruthyCliEnvValue(env[CLI_SESSION_SHOW_JOB_EVENTS_ENV]);
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

export function formatEmbeddedServiceLaunchDelayWarning(input: {
  serviceName: string;
  durationMs: number;
  platform?: NodeJS.Platform | string;
}): string {
  const durationMs = Math.max(0, Math.floor(Number(input.durationMs) || 0));
  const serviceName = String(input.serviceName || "service");
  const platform = String(input.platform ?? process.platform);
  const windowsHint =
    platform === "win32"
      ? " On Windows, first-run standalone binaries can be delayed while security software scans them."
      : "";
  return (
    `[pushpals] Embedded ${serviceName} process launch took ${durationMs}ms; startup is continuing.` +
    windowsHint
  );
}

export type EmbeddedRuntimeServiceLaunchPlan = {
  command: string[];
  cwd: string;
  launchReadyLine?: string;
  launchTimeoutMs?: number;
};

export function buildEmbeddedRuntimeServiceLaunchPlan(input: {
  serviceName: RuntimeServiceName;
  standaloneCommand: string[];
  sourceBundlePath: string;
  launchTrampolinePath: string;
  bunExecutable: string;
  cwd: string;
  platform?: NodeJS.Platform | string;
  launchTimeoutMs?: number;
  fileExists?: (path: string) => boolean;
}): EmbeddedRuntimeServiceLaunchPlan {
  const platform = String(input.platform ?? process.platform);
  if (platform !== "win32") {
    return {
      command: [...input.standaloneCommand],
      cwd: input.cwd,
    };
  }

  const bunExecutable = String(input.bunExecutable ?? "").trim();
  const sourceBundlePath = String(input.sourceBundlePath ?? "").trim();
  const launchTrampolinePath = String(input.launchTrampolinePath ?? "").trim();
  const fileExists = input.fileExists ?? existsSync;
  const missing: string[] = [];
  if (!bunExecutable || !fileExists(bunExecutable)) missing.push("Bun executable");
  if (!sourceBundlePath || !fileExists(sourceBundlePath)) missing.push("source bundle");
  if (!launchTrampolinePath || !fileExists(launchTrampolinePath)) {
    missing.push("launch trampoline");
  }
  if (missing.length > 0) {
    throw new Error(
      `Cannot safely start embedded ${input.serviceName} on Windows: missing ${missing.join(
        ", ",
      )}. Direct standalone-runtime launch is disabled because it can block the CLI process.`,
    );
  }

  const childCommand = [bunExecutable, sourceBundlePath, ...input.standaloneCommand.slice(1)];
  return {
    command: [bunExecutable, launchTrampolinePath, "--", ...childCommand],
    cwd: input.cwd,
    launchReadyLine: RUNTIME_LAUNCH_TRAMPOLINE_READY_LINE,
    launchTimeoutMs: Math.max(
      1_000,
      Math.floor(input.launchTimeoutMs ?? DEFAULT_WINDOWS_RUNTIME_SERVICE_LAUNCH_TIMEOUT_MS),
    ),
  };
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

export function formatUnsupportedBunRuntimeLines(version: string): string[] {
  const detected = String(version ?? "").trim() || "unknown";
  return [
    `[pushpals] Unsupported Bun runtime ${detected}; PushPals requires Bun ${MINIMUM_SUPPORTED_BUN_VERSION} or newer.`,
    `[pushpals] Upgrade Bun before starting services. For npm-managed Bun: npm install -g bun@${MINIMUM_SUPPORTED_BUN_VERSION}`,
    "[pushpals] PushPals refused to start the runtime so an incompatible Bun process cannot crash-loop or freeze the shell.",
  ];
}

export function enforceSupportedBunRuntime(version = Bun.version): boolean {
  if (isSupportedBunVersion(version)) return true;
  for (const line of formatUnsupportedBunRuntimeLines(version)) console.error(line);
  return false;
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
  console.log("  --open_config, --open-config");
  console.log("                        Open the active local config file and exit");
  console.log("  --create_vision_md     Create a starter vision.md in the current repo and exit");
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
    openConfig: false,
    createVisionMd: false,
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
    if (arg === "--open_config" || arg === "--open-config") {
      options.openConfig = true;
      continue;
    }
    if (arg === "--create_vision_md" || arg === "--create-vision-md") {
      options.createVisionMd = true;
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

function clampPositiveInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function resolveStartupGitProbeTimeoutMs(env: Record<string, string | undefined>): number {
  return clampPositiveInt(
    parsePositiveInt(
      env.PUSHPALS_STARTUP_GIT_PROBE_TIMEOUT_MS,
      DEFAULT_STARTUP_GIT_PROBE_TIMEOUT_MS,
    ),
    1_000,
    30_000,
  );
}

function resolveStartupGitRemoteTimeoutMs(env: Record<string, string | undefined>): number {
  return clampPositiveInt(
    parsePositiveInt(
      env.PUSHPALS_STARTUP_GIT_REMOTE_TIMEOUT_MS,
      DEFAULT_STARTUP_GIT_REMOTE_TIMEOUT_MS,
    ),
    1_000,
    60_000,
  );
}

async function withStartupTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(timeoutValue()), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function jsonHtmlBootstrap(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function appendBoundedProcessOutput(existing: string, next: string, maxChars: number): string {
  if (!next) return existing;
  const combined = `${existing}${next}`;
  if (combined.length <= maxChars) return combined;
  return combined.slice(combined.length - maxChars);
}

function createProcessOutputCollector(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxChars = DEFAULT_COMMAND_OUTPUT_MAX_CHARS,
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
        output = appendBoundedProcessOutput(
          output,
          decoder.decode(chunk.value, { stream: true }),
          maxChars,
        );
      }
      output = appendBoundedProcessOutput(output, decoder.decode(), maxChars);
    } catch (err) {
      if (!cancelled) {
        output = appendBoundedProcessOutput(
          output,
          `\n[pushpals] output read failed: ${String(err)}`,
          maxChars,
        );
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

async function finishProcessOutputCollector(
  collector: ProcessOutputCollector,
  timeoutMs = DEFAULT_COMMAND_OUTPUT_DRAIN_TIMEOUT_MS,
): Promise<string> {
  const result = await Promise.race([
    collector.done.then((text) => ({ text, timedOut: false })),
    Bun.sleep(Math.max(1, timeoutMs)).then(() => ({
      text: collector.snapshot(),
      timedOut: true,
    })),
  ]);
  if (result.timedOut) {
    collector.cancel();
  }
  return result.text;
}

function terminateSpawnedProcessTree(
  proc: ReturnType<typeof Bun.spawn>,
  platform = process.platform,
): void {
  try {
    const stopCommand = buildServiceStopCommand(proc.pid, platform);
    if (stopCommand) {
      Bun.spawnSync(stopCommand, {
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
    // best-effort process cleanup only
  }
}

export async function runCommandWithEnv(
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
    const stdoutCollector = createProcessOutputCollector(proc.stdout);
    const stderrCollector = createProcessOutputCollector(proc.stderr);
    let timedOut = false;
    const hasTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const exitCode = await Promise.race([
      proc.exited,
      hasTimeout
        ? new Promise<number>((resolveTimeout) => {
            timeout = setTimeout(() => {
              timedOut = true;
              terminateSpawnedProcessTree(proc);
              resolveTimeout(-1);
            }, timeoutMs);
          })
        : new Promise<number>(() => {}),
    ]);
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (timedOut) {
      await Promise.race([
        proc.exited.catch(() => -1),
        Bun.sleep(DEFAULT_COMMAND_OUTPUT_DRAIN_TIMEOUT_MS),
      ]);
      stdoutCollector.cancel();
      stderrCollector.cancel();
    }
    const [stdout, stderr] = await Promise.all([
      finishProcessOutputCollector(stdoutCollector),
      finishProcessOutputCollector(stderrCollector),
    ]);
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

function appendGitConfigEnv(
  env: Record<string, string | undefined>,
  key: string,
  value: string,
): Record<string, string | undefined> {
  const existingCount = Number.parseInt(String(env.GIT_CONFIG_COUNT ?? "0").trim(), 10);
  const count = Number.isFinite(existingCount) && existingCount >= 0 ? existingCount : 0;
  for (let index = 0; index < count; index++) {
    if (String(env[`GIT_CONFIG_KEY_${index}`] ?? "") === key) return env;
  }
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: key,
    [`GIT_CONFIG_VALUE_${count}`]: value,
  };
}

function withWindowsGitSchannelEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  if (platform !== "win32") return env;
  if (parseBooleanFlag(env.PUSHPALS_DISABLE_WINDOWS_GIT_SCHANNEL) === true) return env;
  return appendGitConfigEnv(env, "http.sslBackend", "schannel");
}

const WINDOWS_NODE_EXTRA_CA_CERTS_DISABLE_ENV = "PUSHPALS_DISABLE_WINDOWS_NODE_EXTRA_CA_CERTS";
const WINDOWS_NODE_EXTRA_CA_CERTS_BUNDLE_RELATIVE_PATH = ["certs", "windows-root-ca.pem"] as const;

export function resolveWindowsNodeExtraCaCertsBundlePath(runtimeRoot: string): string {
  return join(runtimeRoot, ...WINDOWS_NODE_EXTRA_CA_CERTS_BUNDLE_RELATIVE_PATH);
}

function hasUsablePemCertificate(pathValue: string): boolean {
  try {
    return /-----BEGIN CERTIFICATE-----/.test(readFileSync(pathValue, "utf8"));
  } catch {
    return false;
  }
}

function ensureWindowsNodeExtraCaCertsBundle(
  outPath: string,
  env: Record<string, string | undefined>,
): string {
  if (hasUsablePemCertificate(outPath)) return outPath;

  const outDir = dirname(outPath);
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    return "";
  }

  const script = String.raw`
$ErrorActionPreference = "Stop"
$outPath = $env:PUSHPALS_WINDOWS_NODE_EXTRA_CA_CERTS_OUT
if (-not $outPath) { throw "PUSHPALS_WINDOWS_NODE_EXTRA_CA_CERTS_OUT is required" }
$outDir = Split-Path -Parent $outPath
if ($outDir) { [System.IO.Directory]::CreateDirectory($outDir) | Out-Null }
$stores = @("Cert:\CurrentUser\Root", "Cert:\LocalMachine\Root")
$seen = @{}
$lines = New-Object System.Collections.Generic.List[string]
foreach ($store in $stores) {
  if (-not (Test-Path $store)) { continue }
  foreach ($cert in Get-ChildItem $store) {
    if (-not $cert.RawData) { continue }
    if ($cert.NotAfter -lt (Get-Date)) { continue }
    $thumbprint = [string]$cert.Thumbprint
    if ($seen.ContainsKey($thumbprint)) { continue }
    $seen[$thumbprint] = $true
    $lines.Add("-----BEGIN CERTIFICATE-----")
    $encoded = [Convert]::ToBase64String($cert.RawData, [Base64FormattingOptions]::InsertLineBreaks)
    foreach ($line in [regex]::Split($encoded, '\r?\n')) {
      if ($line) { $lines.Add($line) }
    }
    $lines.Add("-----END CERTIFICATE-----")
  }
}
if ($lines.Count -eq 0) { throw "No Windows root certificates found" }
[System.IO.File]::WriteAllLines($outPath, $lines, [System.Text.Encoding]::ASCII)
`;
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const childEnv = normalizeChildProcessEnv({
    ...env,
    PUSHPALS_WINDOWS_NODE_EXTRA_CA_CERTS_OUT: outPath,
  });
  const result = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedScript,
    ],
    {
      cwd: process.cwd(),
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) return "";
  return hasUsablePemCertificate(outPath) ? outPath : "";
}

export function withWindowsNodeExtraCaCertsEnv(
  env: Record<string, string | undefined>,
  opts: {
    platform?: NodeJS.Platform;
    runtimeRoot: string;
  },
): Record<string, string | undefined> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return env;
  if (parseBooleanFlag(env[WINDOWS_NODE_EXTRA_CA_CERTS_DISABLE_ENV]) === true) return env;
  if (typeof env.NODE_EXTRA_CA_CERTS === "string" && env.NODE_EXTRA_CA_CERTS.trim()) return env;

  const runtimeRoot = String(opts.runtimeRoot ?? "").trim();
  if (!runtimeRoot || !existsSync(runtimeRoot)) return env;

  const bundlePath = ensureWindowsNodeExtraCaCertsBundle(
    resolveWindowsNodeExtraCaCertsBundlePath(runtimeRoot),
    env,
  );
  if (!bundlePath) return env;
  return {
    ...env,
    NODE_EXTRA_CA_CERTS: bundlePath,
  };
}

async function runGitWithEnv(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs?: number,
): Promise<CommandResult> {
  return await runCommandWithEnv(["git", ...args], cwd, withWindowsGitSchannelEnv(env), timeoutMs);
}

async function runGit(args: string[], cwd: string, timeoutMs?: number): Promise<CommandResult> {
  return await runGitWithEnv(
    args,
    cwd,
    {
      ...(process.env as Record<string, string | undefined>),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
    timeoutMs,
  );
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
    serverBundlePath: join(root, ".pushpals-server-runtime.js"),
    localbuddyBundlePath: join(root, ".pushpals-localbuddy-runtime.js"),
    remotebuddyFallbackBundlePath: join(root, ".pushpals-remotebuddy-fallback.js"),
    workerpalsBundlePath: join(root, ".pushpals-workerpals-runtime.js"),
    sourceControlManagerBundlePath: join(root, ".pushpals-source-control-manager-runtime.js"),
    runtimeLaunchTrampolinePath: join(root, ".pushpals-runtime-launch-trampoline.js"),
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
  if (raw === "0.0.0-dev") return "";
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
  try {
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
  } catch (err) {
    const fallback = await fetchLatestReleaseTagWithGitFallback(err);
    if (fallback) return fallback;
    throw err;
  }
}

async function fetchLatestReleaseTagWithGitFallback(cause: unknown): Promise<string | null> {
  const message = String(cause instanceof Error ? cause.message : (cause ?? ""));
  if (
    process.platform !== "win32" ||
    (!/certificate|cert_|unable to verify|self[- ]signed|tls|ssl/i.test(message) &&
      !/fetch failed/i.test(message))
  ) {
    return null;
  }
  console.warn(
    "[pushpals] Bun could not verify the GitHub API certificate; resolving latest release tag with Git instead.",
  );
  const result = await runGitWithEnv(
    [
      "ls-remote",
      "--tags",
      "--refs",
      `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`,
      "refs/tags/v*",
    ],
    process.cwd(),
    {
      ...(process.env as Record<string, string | undefined>),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
  );
  if (!result.ok) return null;
  const tags = result.stdout
    .split(/\r?\n/g)
    .map((line) => line.trim().match(/refs\/tags\/(v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?)$/)?.[1])
    .filter((tag): tag is string => Boolean(tag));
  return sortReleaseTagsDescending(tags)[0] ?? null;
}

function sortReleaseTagsDescending(tags: string[]): string[] {
  return [...new Set(tags)].sort((a, b) => compareReleaseTags(b, a));
}

function compareReleaseTags(a: string, b: string): number {
  const parse = (value: string) =>
    String(value)
      .replace(/^v/i, "")
      .split(/[.-]/g)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(a);
  const right = parse(b);
  const max = Math.max(left.length, right.length, 3);
  for (let index = 0; index < max; index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.localeCompare(b);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function migrateEmbeddedRuntimeTomlSection(
  text: string,
  sectionName: string,
  transform: (sectionBody: string) => string,
): string {
  const sectionPattern = new RegExp(
    `(^\\[${escapeRegExp(sectionName)}\\]\\r?\\n)([\\s\\S]*?)(?=\\r?\\n\\[|(?![\\s\\S]))`,
    "m",
  );
  return text.replace(sectionPattern, (_match, header: string, body: string) => {
    return `${header}${transform(body)}`;
  });
}

function migrateLegacyOpenAICodexDefaults(sectionBody: string, opts: { includeModel: boolean }) {
  const backendIsOpenAICodex = /^\s*backend\s*=\s*"openai_codex"\s*$/m.test(sectionBody);
  if (!backendIsOpenAICodex && opts.includeModel) return sectionBody;

  let updated = sectionBody;
  if (opts.includeModel) {
    updated = updated.replace(/^(\s*model\s*=\s*)"gpt-5\.(?:4|5)"\s*$/m, '$1"gpt-5.6-sol"');
  }
  updated = updated.replace(/^(\s*reasoning_effort\s*=\s*)"high"\s*$/m, '$1"xhigh"');
  return updated;
}

const PINNED_WORKER_CODEX_COMMAND = "bun x --yes @openai/codex@0.146.0";

function migrateLegacyWorkerCodexCommandDefault(
  sectionBody: string,
  key: "codex_bin" | "bin",
): string {
  const pattern = new RegExp(
    `^(\\s*${key}\\s*=\\s*)"(?:codex|(?:bun\\s+x|bunx)\\s+--yes\\s+@openai/codex)"\\s*$`,
    "m",
  );
  return sectionBody.replace(pattern, `$1"${PINNED_WORKER_CODEX_COMMAND}"`);
}

function migrateEmbeddedRuntimeLocalToml(localTomlPath: string): void {
  if (!existsSync(localTomlPath)) return;
  let original: string;
  try {
    original = readFileSync(localTomlPath, "utf8");
  } catch {
    return;
  }
  let migrated = original;
  for (const sectionName of ["localbuddy.llm", "remotebuddy.llm"]) {
    migrated = migrateEmbeddedRuntimeTomlSection(migrated, sectionName, (sectionBody) =>
      migrateLegacyOpenAICodexDefaults(sectionBody, { includeModel: true }),
    );
  }
  migrated = migrateEmbeddedRuntimeTomlSection(migrated, "workerpals.llm", (sectionBody) =>
    migrateLegacyWorkerCodexCommandDefault(
      migrateLegacyOpenAICodexDefaults(sectionBody, { includeModel: true }),
      "codex_bin",
    ),
  );
  migrated = migrateEmbeddedRuntimeTomlSection(migrated, "workerpals.openai_codex", (sectionBody) =>
    migrateLegacyWorkerCodexCommandDefault(
      migrateLegacyOpenAICodexDefaults(sectionBody, { includeModel: false }),
      "bin",
    ),
  );
  if (migrated !== original) {
    writeFileSync(localTomlPath, migrated, "utf8");
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

function displayPath(fromRoot: string, pathValue: string): string {
  const rel = relative(fromRoot, pathValue);
  if (!rel || rel === "") return ".";
  if (rel.startsWith("..")) return pathValue;
  return rel.replace(/\\/g, "/");
}

function resolveVisionTemplatePathForCreate(opts: {
  repoRoot: string;
  runtimeRoot: string;
}): string | null {
  const candidates = [
    join(opts.runtimeRoot, "vision.example.md"),
    join(opts.repoRoot, "vision.example.md"),
    resolve(import.meta.dir, "..", "runtime", "vision.example.md"),
    resolve(import.meta.dir, "..", "packages", "cli", "runtime", "vision.example.md"),
    resolve(import.meta.dir, "..", "vision.example.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function createVisionMdFromTemplate(opts: { repoRoot: string; runtimeRoot: string }): number {
  const visionPath = join(opts.repoRoot, "vision.md");
  if (existsSync(visionPath)) {
    console.log(
      `[pushpals] vision.md already exists at ${displayPath(opts.repoRoot, visionPath)}; leaving it unchanged.`,
    );
    return 0;
  }

  const templatePath = resolveVisionTemplatePathForCreate(opts);
  if (!templatePath) {
    console.error(
      "[pushpals] Could not create vision.md: bundled vision.example.md template was not found.",
    );
    return 1;
  }

  const template = readFileSync(templatePath, "utf8");
  writeFileSync(visionPath, template, "utf8");
  console.log(
    `[pushpals] Created ${displayPath(opts.repoRoot, visionPath)} from ${displayPath(
      opts.repoRoot,
      templatePath,
    )}.`,
  );
  console.log(
    "[pushpals] Edit vision.md with this repo's users, priorities, guardrails, and validation path.",
  );
  console.log("[pushpals] Then run `pushpals` again.");
  return 0;
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
  const runtimeEnv = {
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
  const runtimeEnvWithWindowsCa = withWindowsNodeExtraCaCertsEnv(runtimeEnv, {
    platform,
    runtimeRoot: opts.runtimeRoot,
  });
  return withWindowsGitSchannelEnv(runtimeEnvWithWindowsCa, platform) as Record<string, string>;
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
  timeoutMs = resolveStartupGitProbeTimeoutMs(env),
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
      const result = await runCommandWithEnv(lookup, cwd, env, timeoutMs);
      if (!result.ok) continue;
      const resolved = result.stdout
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

export type EmbeddedRuntimeCrashEnvelope = {
  event: "embedded_runtime_crash";
  crashId: string;
  service: string;
  runtimeVersion: string | null;
  platform: string;
  uptimeMs: number;
  exitCode: number | null;
  requestId: string | null;
  jobId: string | null;
  memory: {
    rssBytes: number | null;
  };
  crashReport: string | null;
  crashSignature: string | null;
  recoveryOutcome: "restart_planned" | "restart_not_planned";
  observedAt: string;
};

function memoryValueToBytes(value: string, unit: string): number | null {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const multiplier =
    unit.toLowerCase() === "gb" ? 1024 ** 3 : unit.toLowerCase() === "mb" ? 1024 ** 2 : 1024;
  return Math.floor(amount * multiplier);
}

export function buildEmbeddedRuntimeCrashEnvelope(options: {
  service: string;
  logText: string;
  uptimeMs: number;
  exitCode: number | null;
  rssBytes?: number | null;
  recoveryPlanned: boolean;
  observedAt: string;
}): EmbeddedRuntimeCrashEnvelope {
  const logText = String(options.logText ?? "");
  const runtimeMatch = logText.match(/\bBun\s+v?(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)/i);
  const rssMatch = logText.match(
    /\b(?:RSS|resident(?:\s+set)?(?:\s+size)?)\s*[:=]\s*([\d.]+)\s*(KB|MB|GB)\b/i,
  );
  const crashReportMatch = logText.match(/https:\/\/bun\.report\/[^\s)"']+/i);
  const requestMatch = logText.match(
    /\brequest(?:Id|_id|\s+id)?\s*[:=]\s*["']?([a-z0-9][a-z0-9._:-]{3,})/i,
  );
  const jobMatch = logText.match(
    /\bjob(?:Id|_id|\s+id)?\s*[:=]\s*["']?([a-z0-9][a-z0-9._:-]{3,})/i,
  );
  const signatureMatch = logText.match(
    /\b(?:panic\(main thread\)[^\r\n]*|segmentation fault[^\r\n]*|oh no:\s*bun has crashed[^\r\n]*)/i,
  );
  const logRssBytes = rssMatch ? memoryValueToBytes(rssMatch[1], rssMatch[2]) : null;
  return {
    event: "embedded_runtime_crash",
    crashId: `crash_${crypto.randomUUID().slice(0, 12)}`,
    service: options.service,
    runtimeVersion: runtimeMatch?.[1] ?? process.versions.bun ?? null,
    platform: `${process.platform}-${process.arch}`,
    uptimeMs: Math.max(0, Math.floor(options.uptimeMs)),
    exitCode: options.exitCode,
    requestId: requestMatch?.[1] ?? null,
    jobId: jobMatch?.[1] ?? null,
    memory: {
      rssBytes:
        logRssBytes ??
        (typeof options.rssBytes === "number" && Number.isFinite(options.rssBytes)
          ? Math.max(0, Math.floor(options.rssBytes))
          : null),
    },
    crashReport: crashReportMatch?.[0] ?? null,
    crashSignature: signatureMatch?.[0] ?? null,
    recoveryOutcome: options.recoveryPlanned ? "restart_planned" : "restart_not_planned",
    observedAt: options.observedAt,
  };
}

export function buildEmbeddedRuntimeCrashFingerprint(logText: string): string | null {
  const text = String(logText ?? "");
  const signature = text.match(
    /\b(?:panic\(main thread\)[^\r\n]*|segmentation fault[^\r\n]*|oh no:\s*bun has crashed[^\r\n]*)/i,
  )?.[0];
  if (!signature) return null;
  const runtime = text.match(/\bBun\s+v?(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)/i)?.[1];
  const normalizedSignature = signature.trim().replace(/\s+/g, " ").toLowerCase();
  return `bun@${runtime ?? "unknown"}:${normalizedSignature}`;
}

function hasStandaloneBunCrashSignature(text: string): boolean {
  return /\bpanic\(main thread\)|\bsegmentation fault\b|oh no:\s*bun has crashed\b/i.test(
    String(text ?? ""),
  );
}

export function hasRemoteBuddyRuntimeOutput(logText: string): boolean {
  return String(logText ?? "")
    .split(/\r?\n/)
    .some((line) => /\[(?:stdout|stderr)\]/i.test(line));
}

export function shouldUseRemoteBuddySilentStartupFallback(opts: {
  logText: string;
  elapsedMs: number;
  thresholdMs?: number;
  platform?: NodeJS.Platform;
  fallbackAvailable?: boolean;
}): boolean {
  const platform = opts.platform ?? process.platform;
  const thresholdMs = Math.max(
    1,
    opts.thresholdMs ?? DEFAULT_REMOTEBUDDY_SILENT_STARTUP_FALLBACK_MS,
  );
  if (platform !== "win32") return false;
  if (!opts.fallbackAvailable) return false;
  if (opts.elapsedMs < thresholdMs) return false;
  const logText = String(opts.logText ?? "");
  if (hasStandaloneBunCrashSignature(logText)) return false;
  return !hasRemoteBuddyRuntimeOutput(logText);
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
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= RUNTIME_BINARY_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, { headers: GITHUB_HEADERS }, 60_000);
      if (!response.ok) {
        throw new Error(`Failed to download ${assetName} from ${tag} (HTTP ${response.status})`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      mkdirSync(dirname(outPath), { recursive: true });
      await Bun.write(outPath, bytes);
      return;
    } catch (err) {
      try {
        const fallback = await downloadBinaryAssetWithWindowsCurlFallback(url, outPath, err);
        if (fallback) return;
        lastError = err;
      } catch (fallbackErr) {
        lastError = fallbackErr;
      }
      if (attempt < RUNTIME_BINARY_DOWNLOAD_ATTEMPTS) {
        console.warn(
          `[pushpals] Runtime binary download for ${assetName} failed on attempt ${attempt}/${RUNTIME_BINARY_DOWNLOAD_ATTEMPTS}; retrying...`,
        );
        await Bun.sleep(1_000 * attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "unknown error"));
}

async function downloadBinaryAssetWithWindowsCurlFallback(
  url: string,
  outPath: string,
  cause: unknown,
): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const message = String(cause instanceof Error ? cause.message : (cause ?? ""));
  if (
    !/certificate|cert_|unable to verify|self[- ]signed|tls|ssl/i.test(message) &&
    !/fetch failed/i.test(message)
  ) {
    return false;
  }
  const tmpPath = `${outPath}.download-${process.pid}-${Date.now()}.tmp`;
  mkdirSync(dirname(outPath), { recursive: true });
  rmSync(tmpPath, { force: true });
  console.warn(
    "[pushpals] Bun could not verify the GitHub release certificate; retrying download with Windows curl certificate handling.",
  );
  const result = await runCommandWithEnv(
    [
      "curl.exe",
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--ssl-no-revoke",
      "--output",
      tmpPath,
      url,
    ],
    process.cwd(),
    process.env as Record<string, string | undefined>,
    120_000,
  );
  if (!result.ok || !existsSync(tmpPath)) {
    rmSync(tmpPath, { force: true });
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    throw new Error(`Windows curl fallback failed while downloading runtime binary: ${detail}`);
  }
  renameSync(tmpPath, outPath);
  return true;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency)));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await worker(items[currentIndex], currentIndex);
      }
    }),
  );
}

export function resolveRuntimeBinaryPaths(
  runtimeRoot: string,
  platformKey = resolveRuntimePlatformKey(),
): RuntimeBinarySet {
  const binDir = join(runtimeRoot, "bin", platformKey);
  return {
    server: join(binDir, runtimeBinaryFilename("server", platformKey)),
    localbuddy: join(binDir, runtimeBinaryFilename("localbuddy", platformKey)),
    remotebuddy: join(binDir, runtimeBinaryFilename("remotebuddy", platformKey)),
    workerpals: join(binDir, runtimeBinaryFilename("workerpals", platformKey)),
    sourceControlManager: join(
      binDir,
      runtimeBinaryFilename("source_control_manager", platformKey),
    ),
  };
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

  const runtimeBinaries = resolveRuntimeBinaryPaths(runtimeRoot, platformKey);
  const requiredAssets = [
    runtimeBinaries.server,
    runtimeBinaries.localbuddy,
    runtimeBinaries.remotebuddy,
    runtimeBinaries.workerpals,
    runtimeBinaries.sourceControlManager,
  ];
  const shouldRefreshAll = installedTag !== runtimeTag;
  const assetsToDownload = requiredAssets.filter(
    (binaryPath) => shouldRefreshAll || !existsSync(binaryPath),
  );
  if (assetsToDownload.length > 1) {
    console.log(
      `[pushpals] Downloading ${assetsToDownload.length} runtime binary asset(s) with bounded parallelism...`,
    );
  }
  await runWithConcurrency(assetsToDownload, 3, async (binaryPath) => {
    const assetName = binaryPath.split(/[\\/]/).pop() || "";
    await downloadBinaryAsset(runtimeTag, assetName, binaryPath);
  });
  const downloadedCount = assetsToDownload.length;

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
  runtimeBinaries.freshlyInstalled = downloadedCount > 0;
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
      service.stopOutputPipes?.();
      service.proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

async function stopRuntimeServicesOnWindows(
  services: RuntimeServiceProcess[],
  timeoutMs: number,
): Promise<void> {
  for (const service of services) {
    service.stopOutputPipes?.();
    try {
      service.proc.kill("SIGTERM");
    } catch {
      // ignore best-effort shutdown failures
    }
  }
  await waitForRuntimeServicesExit(services, Math.max(500, timeoutMs - 1_000));
  for (const service of services) {
    if (service.exited) continue;
    try {
      service.proc.kill("SIGKILL");
    } catch {
      // ignore best-effort shutdown failures
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
  if (process.platform === "win32") {
    await stopRuntimeServicesOnWindows(ordered, timeoutMs);
    await waitForRuntimeServicesExit(ordered, Math.min(1_000, timeoutMs));
    return;
  }
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
  serviceStopTimeoutMs?: number;
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
    serviceStopTimeoutMs = 10_000,
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

  await stopRuntimeServicesGracefully(services, serviceStopTimeoutMs);
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

  const pathApi = platform === "win32" ? pathWin32 : { dirname, basename, delimiter };
  const executableDir = pathApi.dirname(resolvedPath);
  const existingPath =
    platform === "win32" ? String(env.Path ?? env.PATH ?? "") : String(env.PATH ?? "");
  const pathEntries = existingPath
    .split(pathApi.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const hasDir = pathEntries.some((entry) =>
    platform === "win32"
      ? entry.toLowerCase() === executableDir.toLowerCase()
      : entry === executableDir,
  );
  const nextPath = hasDir ? existingPath : [executableDir, ...pathEntries].join(pathApi.delimiter);

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
  env.PUSHPALS_GIT_BIN =
    platform === "win32" ? pathWin32.basename(resolvedPath) : basename(resolvedPath);
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
  env.PUSHPALS_DOCKER_BIN =
    platform === "win32" ? pathWin32.basename(resolvedPath) : basename(resolvedPath);
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
  timeoutMs = resolveStartupGitProbeTimeoutMs(env),
): Promise<boolean> {
  const result = await runCommandWithEnv(command, cwd, env, timeoutMs);
  return result.ok;
}

async function canSpawnGitViaWindowsShell(
  commandArgs: string[],
  cwd: string,
  env: Record<string, string>,
  platform = process.platform,
  timeoutMs = resolveStartupGitProbeTimeoutMs(env),
): Promise<boolean> {
  if (platform !== "win32") return false;
  const commandLine = commandArgs.map((arg) => quoteWindowsCmdArg(arg)).join(" ");
  for (const shellExecutable of resolveWindowsShellExecutableCandidatesForEnv(env, platform)) {
    const result = await runCommandWithEnv(
      [shellExecutable, "/d", "/s", "/c", commandLine],
      cwd,
      env,
      timeoutMs,
    );
    if (result.ok) return true;
  }
  return false;
}

async function resolveSourceControlManagerGitProbe(
  cwd: string,
  env: Record<string, string>,
  platform = process.platform,
  timeoutMs = resolveStartupGitProbeTimeoutMs(env),
): Promise<{ ok: boolean; detail: string }> {
  const candidates = resolveRuntimeGitExecutableCandidates(env, platform);
  for (const candidate of candidates) {
    if (await canSpawnCommand([candidate, "--version"], cwd, env, timeoutMs)) {
      return { ok: true, detail: candidate };
    }
  }

  if (platform === "win32") {
    for (const candidate of candidates) {
      if (
        await canSpawnGitViaWindowsShell([candidate, "--version"], cwd, env, platform, timeoutMs)
      ) {
        return { ok: true, detail: `${candidate} via shell` };
      }
    }
  }

  return {
    ok: false,
    detail: candidates.join(", ") || "git",
  };
}

export async function resolveWorkerpalDockerProbe(
  cwd: string,
  env: Record<string, string>,
  platform = process.platform,
  runCommandWithEnvFn: typeof runCommandWithEnv = runCommandWithEnv,
): Promise<{ ok: boolean; detail: string }> {
  const preconfiguredDockerBinary = env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? env.PUSHPALS_DOCKER_BIN;
  if (preconfiguredDockerBinary) {
    applyResolvedDockerBinaryToRuntimeEnv(env, preconfiguredDockerBinary, platform);
  } else {
    const resolvedDockerBinary = await resolveCommandPath(
      platform === "win32" ? "docker.exe" : "docker",
      cwd,
      env,
    );
    if (resolvedDockerBinary) {
      applyResolvedDockerBinaryToRuntimeEnv(env, resolvedDockerBinary, platform);
    }
  }

  const candidates = resolveRuntimeDockerExecutableCandidates(env, platform);
  const failures: string[] = [];
  for (const candidate of candidates) {
    const result = await runCommandWithEnvFn(
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
const WORKERPAL_SANDBOX_EXTRA_CA_SECRET_ID = "pushpals_extra_ca";

export function resolveWorkerpalDockerBuildCaSecretArgs(
  env: Record<string, string | undefined>,
  fileExists: (path: string) => boolean = existsSync,
): string[] {
  const configured = String(
    env.PUSHPALS_DOCKER_BUILD_EXTRA_CA_CERTS ?? env.NODE_EXTRA_CA_CERTS ?? "",
  ).trim();
  if (!configured) return [];
  const path = resolve(configured);
  if (!fileExists(path)) return [];
  return ["--secret", `id=${WORKERPAL_SANDBOX_EXTRA_CA_SECRET_ID},src=${path}`];
}
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

function isWorkerpalEphemeralWorktreePath(
  repoRoot: string,
  worktreePath: string,
  platform: NodeJS.Platform = process.platform,
  homeRoot?: string,
  tempRoot?: string,
): boolean {
  return isDirectWorkerWorktreePath(repoRoot, worktreePath, platform, homeRoot, tempRoot);
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
    if (isDockerUnavailableDetail(detail)) {
      return {
        ok: true,
        detail: `docker unavailable; skipped WorkerPal warm-container cleanup: ${detail}`,
        removed: 0,
      };
    }
    if (isDockerCleanupTimeoutDetail(detail)) {
      return {
        ok: true,
        detail: `docker cleanup timed out; skipped WorkerPal warm-container cleanup: ${detail}`,
        removed: 0,
      };
    }
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
    if (isDockerUnavailableDetail(detail)) {
      return {
        ok: true,
        detail: `docker unavailable; skipped WorkerPal warm-container cleanup: ${detail}`,
        removed: 0,
      };
    }
    if (isDockerCleanupTimeoutDetail(detail)) {
      return {
        ok: true,
        detail: `docker cleanup timed out; skipped WorkerPal warm-container cleanup: ${detail}`,
        removed: 0,
      };
    }
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

export async function cleanupLocalWorkerpalSandboxImage(opts: {
  repoRoot: string;
  env: Record<string, string>;
  dockerImage: string | null | undefined;
  platform?: NodeJS.Platform;
  runCommandWithEnvFn?: typeof runCommandWithEnv;
  commandTimeoutMs?: number;
}): Promise<{ ok: boolean; detail: string; removed: boolean; imageName: string }> {
  const imageName = String(opts.dockerImage ?? "").trim();
  if (!imageName) {
    return {
      ok: true,
      detail: "no local WorkerPal sandbox image configured",
      removed: false,
      imageName: "",
    };
  }

  const runCommandWithEnvFn = opts.runCommandWithEnvFn ?? runCommandWithEnv;
  const commandTimeoutMs =
    typeof opts.commandTimeoutMs === "number" && Number.isFinite(opts.commandTimeoutMs)
      ? Math.max(1, Math.floor(opts.commandTimeoutMs))
      : WORKERPAL_IMAGE_INSPECT_TIMEOUT_MS;
  const dockerExecutable = resolveConfiguredDockerExecutable(
    opts.env,
    opts.platform ?? process.platform,
  );
  const remove = await runCommandWithEnvFn(
    [dockerExecutable, "image", "rm", "-f", imageName],
    opts.repoRoot,
    opts.env,
    commandTimeoutMs,
  );
  if (!remove.ok) {
    const detail = remove.stderr || remove.stdout || `exit ${remove.exitCode}`;
    if (isMissingDockerImageDetail(detail)) {
      return {
        ok: true,
        detail: `no local WorkerPal sandbox image found for ${imageName}`,
        removed: false,
        imageName,
      };
    }
    if (isDockerUnavailableDetail(detail)) {
      return {
        ok: true,
        detail: `docker unavailable; skipped WorkerPal sandbox image cleanup: ${detail}`,
        removed: false,
        imageName,
      };
    }
    if (isDockerCleanupTimeoutDetail(detail)) {
      return {
        ok: true,
        detail: `docker cleanup timed out; skipped WorkerPal sandbox image cleanup: ${detail}`,
        removed: false,
        imageName,
      };
    }
    return {
      ok: false,
      detail: `failed to remove local WorkerPal sandbox image ${imageName}: ${detail}`,
      removed: false,
      imageName,
    };
  }

  return {
    ok: true,
    detail: `removed local WorkerPal sandbox image ${imageName}`,
    removed: true,
    imageName,
  };
}

export async function cleanupLingeringPushPalsGitWorktrees(opts: {
  repoRoot: string;
  env: Record<string, string>;
  runCommandWithEnvFn?: typeof runCommandWithEnv;
  forceDeleteWorktreePathFn?: typeof forceDeleteWorktreePath;
  commandTimeoutMs?: number;
  platform?: NodeJS.Platform;
  homeRoot?: string;
  tempRoot?: string;
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
    return isWorkerpalEphemeralWorktreePath(
      opts.repoRoot,
      entry.path,
      opts.platform ?? process.platform,
      opts.homeRoot,
      opts.tempRoot,
    );
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

export function isDockerCleanupTimeoutDetail(detail: string): boolean {
  return /\btimed out after \d+ms\b/i.test(String(detail ?? ""));
}

export function isDockerUnavailableDetail(detail: string): boolean {
  const text = String(detail ?? "");
  return (
    /cannot connect to (the )?docker daemon/i.test(text) ||
    /docker daemon is not running/i.test(text) ||
    /failed to connect to the docker api/i.test(text) ||
    /docker_engine/i.test(text) ||
    /is the docker daemon running/i.test(text) ||
    /executable not found[^\r\n]*["']?docker(?:\.exe)?/i.test(text) ||
    /docker(?:\.exe)?: command not found/i.test(text) ||
    /spawn\s+docker(?:\.exe)?\s+ENOENT/i.test(text) ||
    /docker(?:\.exe)?'?\s+is not recognized as an internal or external command/i.test(text)
  );
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
  const inspectFailureDetail = inspection.status === "failed" ? inspection.detail : "";
  const existingRuntimeTag = inspection.status === "ok" ? inspection.runtimeTag : "";
  if (inspection.status === "ok" && existingRuntimeTag === runtimeTag) {
    return {
      ok: true,
      detail: `WorkerPal sandbox image is ready locally (${opts.dockerImage}, runtimeTag=${runtimeTag})`,
    };
  }
  if (inspectFailureDetail) {
    console.warn(`[pushpals] ${inspectFailureDetail}`);
  }

  console.log(
    inspectFailureDetail
      ? `[pushpals] WorkerPal sandbox image ${opts.dockerImage} could not be inspected; attempting local rebuild...`
      : existingRuntimeTag
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
      ...resolveWorkerpalDockerBuildCaSecretArgs(opts.env),
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
      detail: inspectFailureDetail
        ? `${inspectFailureDetail}; failed to build local WorkerPal sandbox image ${opts.dockerImage}: ${detail}`
        : `failed to build local WorkerPal sandbox image ${opts.dockerImage}: ${detail}`,
    };
  }

  return {
    ok: true,
    detail: inspectFailureDetail
      ? `rebuilt local WorkerPal sandbox image ${opts.dockerImage} for runtimeTag=${runtimeTag} after image inspection failed`
      : `built local WorkerPal sandbox image ${opts.dockerImage} for runtimeTag=${runtimeTag}`,
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

  const remoteTimeoutMs = resolveStartupGitRemoteTimeoutMs(env);
  const remoteStatus = await withStartupTimeout<GitRemoteCheckResult>(
    opts.gitRemoteCheckFn
      ? opts.gitRemoteCheckFn(opts.repoRoot, opts.remote, env)
      : opts.repoHasRemoteFn
        ? opts
            .repoHasRemoteFn(opts.repoRoot, opts.remote)
            .then((hasRemote) =>
              hasRemote
                ? ({ status: "ok", remote: opts.remote } as GitRemoteCheckResult)
                : ({ status: "missing_remote", remote: opts.remote } as GitRemoteCheckResult),
            )
        : checkGitRemoteConfigured(opts.repoRoot, opts.remote, env, remoteTimeoutMs),
    remoteTimeoutMs,
    () => ({
      status: "error",
      remote: opts.remote,
      detail: `timed out after ${remoteTimeoutMs}ms`,
    }),
  );
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

export function resolveWorkerpalStartupReadinessProbeMaxMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = parseCliIntEnv(WORKERPAL_STARTUP_READINESS_PROBE_MAX_MS_ENV, env);
  return Math.max(1_000, configured ?? DEFAULT_WORKERPAL_STARTUP_READINESS_PROBE_MAX_MS);
}

function resolveWorkerpalStartupReadinessProbeTimeoutMs(config: PushPalsConfig): number {
  return Math.max(
    1_000,
    Math.min(
      resolveWorkerpalCapacityTimeoutMs(config),
      resolveWorkerpalStartupReadinessProbeMaxMs(),
    ),
  );
}

export function resolveWindowsFreshRuntimeWorkerpalPrewarmDelayMs(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): number {
  if (platform !== "win32") return 0;
  const raw = String(env[WINDOWS_FRESH_RUNTIME_WORKERPAL_PREWARM_DELAY_MS_ENV] ?? "").trim();
  if (raw === "0") return 0;
  return clampPositiveInt(
    parsePositiveInt(raw, DEFAULT_WINDOWS_FRESH_RUNTIME_WORKERPAL_PREWARM_DELAY_MS),
    0,
    5 * 60_000,
  );
}

export function shouldPrepareEmbeddedWorkerpalDockerImageBlocking(
  opts: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
  } = {},
): boolean {
  const env = opts.env ?? process.env;
  const explicit = String(env[BLOCKING_WORKERPAL_IMAGE_BUILD_ENV] ?? "").trim();
  if (explicit) return isTruthyCliEnvValue(explicit);
  // Docker Desktop image builds are the highest-risk foreground startup step on Windows.
  // Let WorkerPal warmup/build handle the image after the CLI becomes responsive.
  return (opts.platform ?? process.platform) !== "win32";
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
  timeoutMs = resolveStartupGitRemoteTimeoutMs(env ?? process.env),
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
    timeoutMs,
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
  const result = await runGit(
    ["ls-remote", "--heads", normalizedRemote, ref],
    repoRoot,
    resolveStartupGitRemoteTimeoutMs(process.env),
  );
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
  console.warn(
    `[pushpals] Precheck warning: could not verify remote branch "${result.remote}/${result.branch}": ${result.detail}`,
  );
  console.warn(
    "[pushpals] Precheck warning: continuing startup without SourceControlManager branch verification because the remote check was inconclusive.",
  );
  return true;
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

function removeCliClearTargetOnce(
  target: CliClearTarget,
  removePath: (pathValue: string) => void = (pathValue) => {
    rmSync(pathValue, { recursive: true, force: true });
  },
): CliClearRemoveResult {
  if (!existsSync(target.path)) return "missing";
  try {
    removePath(target.path);
    return "removed";
  } catch (err) {
    return {
      ...target,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function isRetryableCliClearRemoveFailure(detail: string): boolean {
  return /\b(?:EBUSY|EPERM|ENOTEMPTY)\b/i.test(detail);
}

export async function removeCliClearTarget(
  target: CliClearTarget,
  options: CliClearRemoveOptions = {},
): Promise<CliClearRemoveResult> {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? CLI_CLEAR_REMOVE_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(
    0,
    Math.trunc(options.retryDelayMs ?? CLI_CLEAR_REMOVE_RETRY_DELAY_MS),
  );
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const removePath = options.removePath;
  let lastFailure: CliClearFailure | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = removeCliClearTargetOnce(target, removePath);
    if (result === "removed" || result === "missing") return result;

    lastFailure = result;
    const retryable = isRetryableCliClearRemoveFailure(result.detail);
    if (attempt >= maxAttempts || !retryable) {
      if (retryable && attempt > 1) {
        const totalDelayMs = retryDelayMs * ((attempt * (attempt - 1)) / 2);
        return {
          ...result,
          detail: `${result.detail}; still locked after ${attempt} attempts over ${totalDelayMs}ms`,
        };
      }
      return result;
    }

    await sleep(retryDelayMs * attempt);
  }

  return (
    lastFailure ?? {
      ...target,
      detail: "clear target removal failed before an attempt could be made",
    }
  );
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function decodeSyncSubprocessOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output instanceof Uint8Array) return Buffer.from(output).toString("utf8");
  return String(output ?? "");
}

export function resolveCliRuntimeHostShutdownCandidate(
  state: CliState,
  opts: {
    repoRoot: string;
    currentPid?: number;
    requireRuntimeOnly?: boolean;
  },
): CliRuntimeHostShutdownCandidate {
  if (!state.runtimeHostManagesRuntime) {
    return { ok: false, detail: "no saved runtime host manages embedded runtime services" };
  }
  if ((opts.requireRuntimeOnly ?? true) && !state.runtimeHostRuntimeOnly) {
    return { ok: false, detail: "saved runtime host is not runtime-only" };
  }
  if (
    !state.repoRoot ||
    normalizeRepoPathForComparison(state.repoRoot) !== normalizeRepoPathForComparison(opts.repoRoot)
  ) {
    return { ok: false, detail: "saved runtime host belongs to a different repo" };
  }
  const pid = parsePositiveInteger(state.runtimeHostPid);
  if (!pid) return { ok: false, detail: "saved runtime host PID is unavailable" };
  if (pid === (opts.currentPid ?? process.pid)) {
    return { ok: false, detail: "saved runtime host PID is the current process" };
  }
  return { ok: true, pid };
}

export function isLikelyCliRuntimeHostCommandLine(commandLine: string): boolean {
  const text = String(commandLine ?? "").trim();
  if (!text) return false;
  const normalized = text.replace(/\\/g, "/").toLowerCase();
  if (!normalized.includes("pushpals")) return false;
  return (
    normalized.includes("--runtime-only") ||
    normalized.includes("pushpals-cli") ||
    normalized.includes("@pushpalsdev") ||
    /(^|[\\/"'\s])pushpals(?:\.exe|\.cmd|\.ps1)?(?=$|["'\s])/i.test(text)
  );
}

function readCliRuntimeHostProcessCommandLine(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | null {
  try {
    if (platform === "win32") {
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
        "if ($p -and $p.CommandLine) { [Console]::Out.Write([string]$p.CommandLine) }",
      ].join("\n");
      const result = Bun.spawnSync(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          timeout: CLI_RUNTIME_HOST_COMMAND_PROBE_TIMEOUT_MS,
          killSignal: "SIGKILL",
        },
      );
      if (result.exitCode !== 0) return null;
      const text = decodeSyncSubprocessOutput(result.stdout).trim();
      return text || null;
    }

    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: CLI_RUNTIME_HOST_COMMAND_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0) return null;
    const text = decodeSyncSubprocessOutput(result.stdout).trim();
    return text || null;
  } catch {
    return null;
  }
}

function stopCliRuntimeHostProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    const stopCommand = buildServiceStopCommand(pid, platform);
    if (stopCommand) {
      const result = Bun.spawnSync(stopCommand, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      return result.exitCode === 0;
    }
    process.kill(pid, "SIGTERM");
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function stopCliRuntimeHostFromState(opts: {
  repoRoot: string;
  cliStatePath?: string | null;
  state?: CliState;
  currentPid?: number;
  requireRuntimeOnly?: boolean;
  platform?: NodeJS.Platform;
  readCommandLine?: (pid: number, platform: NodeJS.Platform) => string | null;
  stopProcessTree?: (pid: number, platform: NodeJS.Platform) => boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CliRuntimeHostStopResult> {
  const state =
    opts.state ??
    (opts.cliStatePath && existsSync(opts.cliStatePath) ? readCliState(opts.cliStatePath) : {});
  const candidate = resolveCliRuntimeHostShutdownCandidate(state, {
    repoRoot: opts.repoRoot,
    currentPid: opts.currentPid,
    requireRuntimeOnly: opts.requireRuntimeOnly,
  });
  if (!candidate.ok) {
    return { attempted: false, stopped: false, detail: candidate.detail };
  }

  const platform = opts.platform ?? process.platform;
  const readCommandLine = opts.readCommandLine ?? readCliRuntimeHostProcessCommandLine;
  const commandLine = readCommandLine(candidate.pid, platform);
  if (!commandLine) {
    return {
      attempted: false,
      stopped: false,
      pid: candidate.pid,
      detail: "saved runtime host process could not be inspected",
    };
  }
  if (!isLikelyCliRuntimeHostCommandLine(commandLine)) {
    return {
      attempted: false,
      stopped: false,
      pid: candidate.pid,
      detail: "saved runtime host PID no longer looks like a PushPals CLI process",
    };
  }

  const stopProcessTree = opts.stopProcessTree ?? stopCliRuntimeHostProcessTree;
  const stopped = stopProcessTree(candidate.pid, platform);
  if (stopped) {
    const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
    await sleep(CLI_CLEAR_RUNTIME_HOST_STOP_DELAY_MS);
  }
  return {
    attempted: true,
    stopped,
    pid: candidate.pid,
    detail: stopped ? undefined : "runtime host process stop command failed",
  };
}

function resolveLocalServerPort(serverUrl: string): number | null {
  try {
    const url = new URL(serverUrl);
    const host = url.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return null;
    const parsed = url.port
      ? Number.parseInt(url.port, 10)
      : url.protocol === "https:"
        ? 443
        : url.protocol === "http:"
          ? 80
          : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null;
  } catch {
    return null;
  }
}

function readRuntimeServerListenerPid(
  serverUrl: string,
  platform: NodeJS.Platform = process.platform,
): number | null {
  const port = resolveLocalServerPort(serverUrl);
  if (!port) return null;
  try {
    if (platform === "win32") {
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$listener = Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1`,
        "if ($listener -and $listener.OwningProcess) { [Console]::Out.Write([string]$listener.OwningProcess) }",
      ].join("\n");
      const result = Bun.spawnSync(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          timeout: CLI_RUNTIME_HOST_COMMAND_PROBE_TIMEOUT_MS,
          killSignal: "SIGKILL",
        },
      );
      if (result.exitCode !== 0) return null;
      return parsePositiveInteger(decodeSyncSubprocessOutput(result.stdout).trim()) ?? null;
    }

    const lsof = Bun.spawnSync(["lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: CLI_RUNTIME_HOST_COMMAND_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (lsof.exitCode === 0) {
      const firstPid = decodeSyncSubprocessOutput(lsof.stdout).trim().split(/\s+/)[0];
      const parsed = parsePositiveInteger(firstPid);
      if (parsed) return parsed;
    }
    if (platform !== "linux") return null;

    const ss = Bun.spawnSync(["ss", "-ltnp", `sport = :${port}`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: CLI_RUNTIME_HOST_COMMAND_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (ss.exitCode !== 0) return null;
    const match = decodeSyncSubprocessOutput(ss.stdout).match(/\bpid=(\d+)\b/);
    return parsePositiveInteger(match?.[1]) ?? null;
  } catch {
    return null;
  }
}

function readCliRuntimeProcessInfo(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): CliRuntimeProcessInfo | null {
  try {
    if (platform === "win32") {
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
        "if ($p) {",
        '  [Console]::Out.Write(([string]$p.ProcessId) + "`n" + ([string]$p.ParentProcessId) + "`n" + ([string]$p.CommandLine))',
        "}",
      ].join("\n");
      const result = Bun.spawnSync(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          timeout: CLI_RUNTIME_HOST_COMMAND_PROBE_TIMEOUT_MS,
          killSignal: "SIGKILL",
        },
      );
      if (result.exitCode !== 0) return null;
      const [rawPid, rawParentPid, ...commandLines] = decodeSyncSubprocessOutput(
        result.stdout,
      ).split(/\r?\n/);
      const processId = parsePositiveInteger(rawPid);
      const parentPid = parsePositiveInteger(rawParentPid);
      if (!processId || !parentPid) return null;
      return {
        pid: processId,
        parentPid,
        commandLine: commandLines.join("\n").trim(),
      };
    }

    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "ppid=", "-o", "command="], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: CLI_RUNTIME_HOST_COMMAND_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0) return null;
    const output = decodeSyncSubprocessOutput(result.stdout).trim();
    const match = output.match(/^(\d+)\s+([\s\S]+)$/);
    const parentPid = parsePositiveInteger(match?.[1]);
    if (!parentPid || !match?.[2]) return null;
    return { pid, parentPid, commandLine: match[2].trim() };
  } catch {
    return null;
  }
}

export function resolveCliRuntimeHostPidFromProcessTree(opts: {
  listenerPid: number;
  currentPid?: number;
  readProcessInfo: (pid: number) => CliRuntimeProcessInfo | null;
  maxAncestors?: number;
}): number | null {
  const currentPid = opts.currentPid ?? process.pid;
  const seen = new Set<number>();
  let cursor = opts.listenerPid;
  const maxAncestors = Math.max(1, opts.maxAncestors ?? CLI_RUNTIME_HOST_MAX_ANCESTORS);
  for (let depth = 0; depth < maxAncestors; depth += 1) {
    if (!Number.isSafeInteger(cursor) || cursor <= 0 || cursor === currentPid || seen.has(cursor)) {
      break;
    }
    seen.add(cursor);
    const info = opts.readProcessInfo(cursor);
    if (!info || info.pid !== cursor) break;
    if (isLikelyCliRuntimeHostCommandLine(info.commandLine)) {
      return info.pid;
    }
    cursor = info.parentPid;
  }
  return null;
}

export async function stopCliRuntimeHostFromServerListener(opts: {
  serverUrl: string;
  currentPid?: number;
  platform?: NodeJS.Platform;
  readListenerPid?: (serverUrl: string, platform: NodeJS.Platform) => number | null;
  readProcessInfo?: (pid: number, platform: NodeJS.Platform) => CliRuntimeProcessInfo | null;
  stopProcessTree?: (pid: number, platform: NodeJS.Platform) => boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CliRuntimeHostStopResult> {
  const platform = opts.platform ?? process.platform;
  const listenerPid = (opts.readListenerPid ?? readRuntimeServerListenerPid)(
    opts.serverUrl,
    platform,
  );
  if (!listenerPid) {
    return {
      attempted: false,
      stopped: false,
      detail: "local runtime server listener process could not be resolved",
    };
  }
  const readProcessInfo = opts.readProcessInfo ?? readCliRuntimeProcessInfo;
  const hostPid = resolveCliRuntimeHostPidFromProcessTree({
    listenerPid,
    currentPid: opts.currentPid,
    readProcessInfo: (pid) => readProcessInfo(pid, platform),
  });
  if (!hostPid) {
    return {
      attempted: false,
      stopped: false,
      pid: listenerPid,
      detail: "local runtime server ancestry did not contain a verified PushPals CLI host",
    };
  }
  const stopProcessTree = opts.stopProcessTree ?? stopCliRuntimeHostProcessTree;
  const stopped = stopProcessTree(hostPid, platform);
  if (stopped) {
    const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
    await sleep(CLI_CLEAR_RUNTIME_HOST_STOP_DELAY_MS);
  }
  return {
    attempted: true,
    stopped,
    pid: hostPid,
    detail: stopped ? undefined : "discovered runtime host process stop command failed",
  };
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

  const hostStop = await stopCliRuntimeHostFromState({
    repoRoot: opts.repoRoot,
    cliStatePath: opts.cliStatePath,
    requireRuntimeOnly: false,
  });
  let effectiveHostStop = hostStop;
  if (shutdown.accepted && !effectiveHostStop.stopped) {
    for (let attempt = 0; attempt < CLI_CLEAR_RUNTIME_HOST_DISCOVERY_ATTEMPTS; attempt += 1) {
      if (await probeServer(opts.serverUrl)) {
        try {
          await ensureServerRepoAffinity(opts.serverUrl, opts.repoRoot);
          const discoveredHostStop = await stopCliRuntimeHostFromServerListener({
            serverUrl: opts.serverUrl,
          });
          if (discoveredHostStop.attempted || discoveredHostStop.stopped) {
            effectiveHostStop = discoveredHostStop;
          }
          if (discoveredHostStop.stopped) break;
        } catch {
          // The listener changed repo or disappeared between probes. Never stop an unverified host.
        }
      }
      if (attempt + 1 < CLI_CLEAR_RUNTIME_HOST_DISCOVERY_ATTEMPTS) {
        await Bun.sleep(CLI_CLEAR_RUNTIME_HOST_DISCOVERY_POLL_MS);
      }
    }
  }
  if (effectiveHostStop.attempted && effectiveHostStop.stopped) {
    console.log(`[pushpals] Stopped runtime host process: pid=${effectiveHostStop.pid}`);
  } else if (effectiveHostStop.attempted) {
    console.warn(
      `[pushpals] Runtime host process stop did not complete${
        effectiveHostStop.detail ? `: ${effectiveHostStop.detail}` : "."
      }`,
    );
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

  if (opts.config.remotebuddy.workerpalDocker || opts.config.remotebuddy.workerpalRequireDocker) {
    const dockerEnv = normalizeChildProcessEnv(process.env as Record<string, string | undefined>);
    const warmCleanup = await cleanupLingeringWorkerpalWarmContainers({
      repoRoot: opts.repoRoot,
      env: dockerEnv,
    });
    if (warmCleanup.ok) {
      console.log(
        warmCleanup.removed > 0
          ? `[pushpals] Cleared WorkerPal warm containers: ${warmCleanup.detail}`
          : `[pushpals] Nothing to clear for WorkerPal warm containers: ${warmCleanup.detail}`,
      );
    } else {
      failed.push({
        label: "WorkerPal warm containers",
        path: opts.repoRoot,
        detail: warmCleanup.detail,
      });
    }

    const imageCleanup = await cleanupLocalWorkerpalSandboxImage({
      repoRoot: opts.repoRoot,
      env: dockerEnv,
      dockerImage: opts.config.remotebuddy.workerpalImage ?? opts.config.workerpals.dockerImage,
    });
    if (imageCleanup.ok) {
      console.log(
        imageCleanup.removed
          ? `[pushpals] Cleared WorkerPal sandbox image: ${imageCleanup.imageName}`
          : `[pushpals] Nothing to clear for WorkerPal sandbox image: ${imageCleanup.detail}`,
      );
    } else {
      failed.push({
        label: "WorkerPal sandbox image",
        path: imageCleanup.imageName || opts.repoRoot,
        detail: imageCleanup.detail,
      });
    }
  }

  for (const target of targets) {
    const result = await removeCliClearTarget(target);
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

export function shouldDeferRemoteBuddySessionConsumerReadiness(opts: {
  localBuddyEnabled: boolean;
  remoteBuddyReady: boolean;
  remoteBuddyServiceRunning: boolean;
  readinessElapsedMs: number;
  startupGraceMs?: number;
}): boolean {
  if (opts.localBuddyEnabled) return false;
  if (opts.remoteBuddyReady) return false;
  if (!opts.remoteBuddyServiceRunning) return false;
  const startupGraceMs = Math.max(
    0,
    opts.startupGraceMs ?? DEFAULT_REMOTEBUDDY_CONSUMER_STARTUP_GRACE_MS,
  );
  return opts.readinessElapsedMs >= startupGraceMs;
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

export async function waitForRemoteBuddySessionConsumer(opts: {
  serverUrl: string;
  sessionId: string;
  timeoutMs: number;
  pollMs?: number;
  probeFn?: typeof probeRemoteBuddySessionConsumer;
  sleepFn?: typeof Bun.sleep;
  nowFn?: () => number;
}): Promise<RemoteBuddySessionConsumerHealth> {
  const timeoutMs = Math.max(0, opts.timeoutMs);
  const pollMs = Math.max(50, opts.pollMs ?? DEFAULT_RUNTIME_BOOT_POLL_MS);
  const nowFn = opts.nowFn ?? Date.now;
  const deadline = nowFn() + timeoutMs;
  let lastHealth: RemoteBuddySessionConsumerHealth = {
    ok: false,
    detail: `No connected RemoteBuddy session consumer found for session ${opts.sessionId}`,
  };

  while (true) {
    lastHealth = await (opts.probeFn ?? probeRemoteBuddySessionConsumer)(
      opts.serverUrl,
      opts.sessionId,
    );
    if (lastHealth.ok) return lastHealth;

    const remainingMs = deadline - nowFn();
    if (remainingMs <= 0) return lastHealth;
    await (opts.sleepFn ?? Bun.sleep)(Math.min(pollMs, remainingMs));
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

async function fetchWorkerStatusRows(
  serverUrl: string,
  ttlMs: number,
  timeoutMs = 10_000,
): Promise<WorkerStatusRow[]> {
  const payload = await fetchJsonWithTimeout<{ ok?: boolean; workers?: WorkerStatusRow[] }>(
    `${serverUrl}/workers?ttlMs=${Math.max(1_000, Math.floor(ttlMs))}`,
    {},
    Math.max(250, Math.floor(timeoutMs)),
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
    const remainingMs = Math.max(250, deadline - Date.now());
    const workers = await (opts.fetchWorkersFn ?? fetchWorkerStatusRows)(
      opts.serverUrl,
      opts.ttlMs,
      Math.min(DEFAULT_WORKERPAL_STARTUP_STATUS_FETCH_TIMEOUT_MS, remainingMs),
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

export function resolveEmbeddedLocalAgentUrl(input: {
  requestedUrl?: string;
  configuredClientUrl: string;
  localBuddyPort: number;
  startLocalBuddy: boolean;
}): string {
  const requestedUrl = String(input.requestedUrl ?? "").trim();
  if (requestedUrl || !input.startLocalBuddy) {
    return normalizeLoopbackUrl(requestedUrl || undefined, input.configuredClientUrl);
  }
  const localBuddyPort = Math.max(
    1,
    Math.min(65_535, Math.floor(Number(input.localBuddyPort) || 3_003)),
  );
  return `http://127.0.0.1:${localBuddyPort}`;
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
  const runtimeBinaries =
    process.platform === "win32"
      ? resolveRuntimeBinaryPaths(runtimeRoot)
      : await ensureRuntimeBinaries(runtimeRoot, runtimeTag);
  const sandboxPaths = buildWorkerpalSandboxPaths(runtimeRoot);

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
  const embeddedBunExecutable = resolveEmbeddedBunExecutableFromEnv(
    runtimeEnv,
    process.platform,
    process.execPath,
  );
  const windowsRuntimeLaunchTimeoutMs = clampPositiveInt(
    parsePositiveInt(
      runtimeEnv[WINDOWS_RUNTIME_SERVICE_LAUNCH_TIMEOUT_MS_ENV],
      DEFAULT_WINDOWS_RUNTIME_SERVICE_LAUNCH_TIMEOUT_MS,
    ),
    1_000,
    60_000,
  );
  if (process.platform === "win32") {
    delete runtimeEnv.PUSHPALS_WORKERPALS_BIN;
    runtimeEnv.PUSHPALS_WORKERPALS_SOURCE_BUNDLE = sandboxPaths.workerpalsBundlePath;
    runtimeEnv.PUSHPALS_WORKERPALS_SOURCE_ROOT = join(sandboxPaths.workerpalsDir, "src");
    runtimeEnv.PUSHPALS_RUNTIME_LAUNCH_TRAMPOLINE = sandboxPaths.runtimeLaunchTrampolinePath;
    runtimeEnv.PUSHPALS_RUNTIME_LAUNCH_TIMEOUT_MS = String(windowsRuntimeLaunchTimeoutMs);
    if (embeddedBunExecutable) runtimeEnv.PUSHPALS_BUN_BIN = embeddedBunExecutable;
    console.log(
      "[pushpals] Windows safety mode: embedded services and WorkerPals will use isolated source-bundle launchers with bounded startup deadlines.",
    );
    console.log(
      "[pushpals] Windows safety mode: unused standalone runtime binary downloads are skipped.",
    );
  } else {
    runtimeEnv.PUSHPALS_WORKERPALS_BIN = runtimeBinaries.workerpals;
  }
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
  const pendingCrashEnvelopes = new Map<
    string,
    { envelope: EmbeddedRuntimeCrashEnvelope; observedAtMs: number }
  >();
  const serviceManager = new ServiceManager({
    degradedAction: `Inspect the embedded service log, upgrade to Bun ${MINIMUM_SUPPORTED_BUN_VERSION} or newer when a native crash is reported, then restart PushPals. Other healthy services remain available.`,
    repeatedExitFingerprintLimit: 2,
    repeatedExitFingerprintWindowMs: 15 * 60_000,
    resolveExitFingerprint: ({ logPath }) =>
      logPath ? buildEmbeddedRuntimeCrashFingerprint(readLogTail(logPath, 200)) : null,
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
    onLifecycleEvent: (event) => {
      if (event.type === "exit") {
        const logPath =
          serviceLogPaths[event.service as keyof RuntimeServiceLogPaths] ?? runtimeServicesLogPath;
        const envelope = buildEmbeddedRuntimeCrashEnvelope({
          service: event.service,
          logText: readLogTail(logPath, 200),
          uptimeMs: event.uptimeMs,
          exitCode: event.exitCode,
          rssBytes: event.rssBytes,
          recoveryPlanned: event.recoveryPlanned,
          observedAt: event.observedAt,
        });
        pendingCrashEnvelopes.set(event.service, {
          envelope,
          observedAtMs: Date.parse(event.observedAt),
        });
        const line = `[pushpals] embeddedRuntimeCrash=${JSON.stringify(envelope)}`;
        console.warn(line);
        appendRuntimeServicesLogLine(runtimeServicesLogPath, line);
        return;
      }
      const pending = pendingCrashEnvelopes.get(event.service);
      const recoveredAtMs = Date.parse(event.observedAt);
      const recoveryOutcome =
        event.type === "recovery_exhausted" ? "recovery_exhausted" : "recovered";
      const recovery = {
        event: "embedded_runtime_recovery",
        crashId: pending?.envelope.crashId ?? null,
        service: event.service,
        runtimeVersion: pending?.envelope.runtimeVersion ?? null,
        recoveryOutcome,
        recoveryDurationMs:
          pending && Number.isFinite(recoveredAtMs) && Number.isFinite(pending.observedAtMs)
            ? Math.max(0, recoveredAtMs - pending.observedAtMs)
            : null,
        restartAttempt: event.restartAttempt,
        recoveredAt: event.observedAt,
      };
      pendingCrashEnvelopes.delete(event.service);
      const line = `[pushpals] embeddedRuntimeRecovery=${JSON.stringify(recovery)}`;
      if (event.type === "recovery_exhausted") console.error(line);
      else console.log(line);
      appendRuntimeServicesLogLine(runtimeServicesLogPath, line);
    },
    onHealthChange: (health) => {
      for (const line of formatEmbeddedRuntimeHealthLines(health)) {
        console.error(line);
        appendRuntimeServicesLogLine(runtimeServicesLogPath, line);
      }
    },
  });
  const buildManagedServiceSpec = (
    name: RuntimeServiceName,
    command: string[],
    launchOpts: {
      cwd?: string;
      appendLog?: boolean;
    } = {},
  ): ManagedServiceSpec => {
    const sourceBundleByService: Record<RuntimeServiceName, string> = {
      server: sandboxPaths.serverBundlePath,
      localbuddy: sandboxPaths.localbuddyBundlePath,
      remotebuddy: sandboxPaths.remotebuddyFallbackBundlePath,
      source_control_manager: sandboxPaths.sourceControlManagerBundlePath,
    };
    const launchPlan = buildEmbeddedRuntimeServiceLaunchPlan({
      serviceName: name,
      standaloneCommand: command,
      sourceBundlePath: sourceBundleByService[name],
      launchTrampolinePath: sandboxPaths.runtimeLaunchTrampolinePath,
      bunExecutable: embeddedBunExecutable,
      cwd: launchOpts.cwd ?? opts.repoRoot,
      platform: process.platform,
      launchTimeoutMs: windowsRuntimeLaunchTimeoutMs,
    });
    const cwd = launchPlan.cwd;
    const logPath = serviceLogPaths[name];
    const header = `[pushpals] service=${name} command=${launchPlan.command.join(" ")} cwd=${cwd}`;
    if (launchOpts.appendLog && existsSync(logPath)) {
      appendFileSync(logPath, `${header}\n`, "utf8");
    } else {
      writeFileSync(logPath, `${header}\n`, "utf8");
    }
    appendRuntimeServicesLogLine(runtimeServicesLogPath, header);
    return {
      name,
      color: "",
      command: launchPlan.command,
      cwd,
      env: runtimeEnv,
      logPath,
      launchReadyLine: launchPlan.launchReadyLine,
      launchTimeoutMs: launchPlan.launchTimeoutMs,
      onLaunchTimeout: (timeoutMs) => {
        const warning =
          `[pushpals] Embedded ${name} isolated launcher did not confirm child startup within ${timeoutMs}ms; ` +
          "terminating only that launcher and retrying without blocking the other services.";
        console.warn(warning);
        appendRuntimeServicesLogLine(runtimeServicesLogPath, warning);
      },
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
    };
  };
  let latestServiceLaunchAtMs = 0;
  const launchService = async (
    name: RuntimeServiceName,
    command: string[],
    launchOpts?: {
      cwd?: string;
      appendLog?: boolean;
    },
  ): Promise<RuntimeServiceProcess> => {
    const launchStartedAt = Date.now();
    const service = await startManagedServiceWithRetry(
      serviceManager,
      buildManagedServiceSpec(name, command, launchOpts),
      {
        onRetry: (error, attempt, maxAttempts, backoffMs) => {
          const detail = error instanceof Error ? error.message : String(error);
          const warning =
            `[pushpals] Embedded ${name} process launch was blocked (${detail}); ` +
            `retrying attempt ${attempt + 1}/${maxAttempts} in ${backoffMs}ms.`;
          console.warn(warning);
          appendRuntimeServicesLogLine(runtimeServicesLogPath, warning);
        },
      },
    );
    latestServiceLaunchAtMs = Math.max(latestServiceLaunchAtMs, launchStartedAt);
    const launchDurationMs = Date.now() - launchStartedAt;
    if (launchDurationMs >= DEFAULT_EMBEDDED_SERVICE_LAUNCH_WARN_MS) {
      const warning = formatEmbeddedServiceLaunchDelayWarning({
        serviceName: name,
        durationMs: launchDurationMs,
        platform: process.platform,
      });
      console.warn(warning);
      appendRuntimeServicesLogLine(runtimeServicesLogPath, warning);
    }
    return service;
  };
  const serverHealthy = await probeServer(opts.serverUrl);
  if (!serverHealthy) {
    const serverPhaseStartedAt = Date.now();
    console.log("[pushpals] Starting embedded server...");
    const serverService = await launchService("server", [runtimeBinaries.server]);
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
    const localbuddyService = await launchService("localbuddy", [runtimeBinaries.localbuddy]);
    console.log(
      `[pushpals] localbuddy log: ${localbuddyService.logPath ?? serviceLogPaths.localbuddy}`,
    );
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
  const remotebuddyService = await launchService("remotebuddy", [
    runtimeBinaries.remotebuddy,
    "--server",
    opts.serverUrl,
    "--sessionId",
    opts.sessionId,
  ]);
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
  if (!scmHealthy) {
    const scmPhaseStartedAt = Date.now();
    console.log("[pushpals] Checking embedded SourceControlManager git/remote preflight...");
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      "[pushpals] checking embedded source_control_manager git/remote preflight.",
    );
    const scmGitProbe = await resolveSourceControlManagerGitProbe(
      opts.repoRoot,
      runtimeEnv,
      process.platform,
    );
    if (!scmGitProbe.ok) {
      console.warn(
        "[pushpals] Git is not available to embedded SourceControlManager; skipping SCM startup.",
      );
      appendRuntimeServicesLogLine(
        runtimeServicesLogPath,
        `[pushpals] source_control_manager skipped: git is unavailable in embedded runtime env (${scmGitProbe.detail}).`,
      );
      recordStartupPhase("source_control_manager", scmPhaseStartedAt, "skipped_no_git");
    } else {
      const scmRemoteStatus = await checkGitRemoteConfigured(
        opts.repoRoot,
        opts.sourceControlManagerRemote,
        runtimeEnv,
      );
      if (scmRemoteStatus.status === "error") {
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
        const sourceControlManagerService = await launchService("source_control_manager", [
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
  let lastReadinessWaitLogAt = 0;
  let lastReadinessWaitDetail = "";
  let deferredRemoteBuddyConsumerLogged = false;
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
    const remoteBuddyServiceRunning = serviceManager
      .getServices()
      .some((service) => service.name === "remotebuddy" && !service.exited);
    const deferRemoteBuddyConsumer = shouldDeferRemoteBuddySessionConsumerReadiness({
      localBuddyEnabled,
      remoteBuddyReady: remoteBuddyHealth.ok,
      remoteBuddyServiceRunning,
      readinessElapsedMs: Date.now() - readinessPhaseStartedAt,
    });
    const remoteBuddyReadyForCli = remoteBuddyHealth.ok || deferRemoteBuddyConsumer;
    if ((localBuddyEnabled && !health?.ok) || !remoteBuddyReadyForCli) {
      const localBuddyDetail = localBuddyEnabled
        ? health?.ok
          ? "LocalBuddy ready"
          : "LocalBuddy not ready"
        : "LocalBuddy skipped";
      const readinessDetail = `${localBuddyDetail}; ${remoteBuddyHealth.detail}`;
      const now = Date.now();
      if (readinessDetail !== lastReadinessWaitDetail || now - lastReadinessWaitLogAt >= 5_000) {
        console.log(`[pushpals] Waiting for embedded runtime readiness: ${readinessDetail}`);
        appendRuntimeServicesLogLine(
          runtimeServicesLogPath,
          `[pushpals] waiting for embedded runtime readiness: ${readinessDetail}`,
        );
        lastReadinessWaitDetail = readinessDetail;
        lastReadinessWaitLogAt = now;
      }
    }
    if ((!localBuddyEnabled || health?.ok) && remoteBuddyReadyForCli) {
      if (deferRemoteBuddyConsumer && !deferredRemoteBuddyConsumerLogged) {
        appendRuntimeServicesLogLine(
          runtimeServicesLogPath,
          `[pushpals] continuing startup after ${Date.now() - readinessPhaseStartedAt}ms without a connected RemoteBuddy session consumer; embedded RemoteBuddy is running and the CLI session will connect after startup (${remoteBuddyHealth.detail}).`,
        );
        deferredRemoteBuddyConsumerLogged = true;
      }
      reportRemoteBuddyAutonomousEngineState();
      const remainingStabilityGraceMs = remainingServiceStabilityGraceMs({
        latestServiceLaunchAtMs,
      });
      const stabilityDeadline = Date.now() + remainingStabilityGraceMs;
      if (remainingStabilityGraceMs > 0) {
        appendRuntimeServicesLogLine(
          runtimeServicesLogPath,
          `[pushpals] service stability grace has ${remainingStabilityGraceMs}ms remaining after overlapping with worker/scm readiness.`,
        );
      }
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
      runtimeHostPid: parsePositiveInteger(parsed.runtimeHostPid),
      runtimeHostManagesRuntime:
        typeof parsed.runtimeHostManagesRuntime === "boolean"
          ? parsed.runtimeHostManagesRuntime
          : undefined,
      runtimeHostRuntimeOnly:
        typeof parsed.runtimeHostRuntimeOnly === "boolean"
          ? parsed.runtimeHostRuntimeOnly
          : undefined,
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

function markCliBootstrapReadyFromEnv(env: Record<string, string | undefined> = process.env): void {
  const markerPath = String(env.PUSHPALS_CLI_READY_MARKER ?? "").trim();
  if (!markerPath) return;
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
  } catch {
    // Parent watchdog is best-effort. Startup must not fail because the marker cannot be written.
  }
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
  const showOperationalEvents = shouldShowCliSessionOperationalEvents();

  if (type === "job_enqueued") {
    if (!showOperationalEvents) return null;
    const jobId = String(payload.jobId ?? "").slice(0, 8);
    const kind = String(payload.kind ?? "").trim();
    const taskId = String(payload.taskId ?? "").slice(0, 8);
    const detail = kind || (taskId ? `task ${taskId}` : "queued");
    return `[job ${jobId}] queued: ${detail}`;
  }
  if (type === "job_claimed") {
    if (!showOperationalEvents) return null;
    const jobId = String(payload.jobId ?? "").slice(0, 8);
    const workerId = String(payload.workerId ?? "").trim();
    return `[job ${jobId}] claimed${workerId ? ` by ${workerId}` : ""}`;
  }
  if (type === "job_log") {
    if (!showOperationalEvents) return null;
    const jobId = String(payload.jobId ?? "").slice(0, 8);
    const stream = String(payload.stream ?? "").toLowerCase() === "stderr" ? " stderr" : "";
    const phase = compactCliSessionJobLogLine(String(payload.phase ?? "").trim());
    const phaseLabel = phase ? ` phase:${phase}` : "";
    const line = formatCliSessionJobLogLine(String(payload.line ?? "").trim());
    return line ? `[job ${jobId}${stream}${phaseLabel}] ${line}` : null;
  }
  if (type === "job_failed") {
    if (!showOperationalEvents) return null;
    const jobId = String(payload.jobId ?? "").slice(0, 8);
    const message = String(payload.message ?? "").trim();
    return `[job ${jobId}] failed: ${message || "unknown"}`;
  }

  if (!shouldDisplayInteractiveSessionEvent(event)) return null;
  if (type === "message") return null;
  if (type === "assistant_message") {
    const text = String(payload.text ?? "").trim();
    if (!text) return null;
    if (/^All systems online\b/i.test(text)) return null;
    return `assistant> ${text}`;
  }
  if (type === "task_progress") {
    if (!showOperationalEvents) return null;
    const taskId = String(payload.taskId ?? "").slice(0, 8);
    const message = String(payload.message ?? "").trim();
    return message ? `[task ${taskId}] ${message}` : null;
  }
  if (type === "task_failed") {
    if (!showOperationalEvents) return null;
    const taskId = String(payload.taskId ?? "").slice(0, 8);
    const message = String(payload.message ?? "").trim();
    return `[task ${taskId}] failed: ${message || "unknown"}`;
  }
  if (type === "task_completed") {
    if (!showOperationalEvents) return null;
    const taskId = String(payload.taskId ?? "").slice(0, 8);
    const summary = String(payload.summary ?? "").trim();
    return `[task ${taskId}] completed${summary ? `: ${summary}` : ""}`;
  }
  if (type === "job_completed") {
    if (!showOperationalEvents) return null;
    const jobId = String(payload.jobId ?? "").slice(0, 8);
    const summary = String(payload.summary ?? "").trim();
    return `[job ${jobId}] completed${summary ? `: ${summary}` : ""}`;
  }
  if (type === "error") {
    return null;
  }
  if (type === "status") {
    if (!showOperationalEvents) return null;
    const state = String(payload.state ?? "").trim();
    const detail = String(payload.detail ?? "").trim();
    const source = from || String(payload.agentId ?? "status");
    return detail
      ? `[status ${source}] ${state || "unknown"} - ${detail}`
      : `[status ${source}] ${state || "unknown"}`;
  }
  return null;
}

function compactCliSessionJobLogLine(line: string): string {
  const compacted = line.replace(/\s+/g, " ").trim();
  if (compacted.length <= CLI_SESSION_JOB_LOG_MAX_CHARS) return compacted;
  return `${compacted.slice(0, CLI_SESSION_JOB_LOG_MAX_CHARS - 3)}...`;
}

function formatCliSessionJobLogLine(line: string): string | null {
  const compacted = compactCliSessionJobLogLine(line);
  if (!compacted) return null;
  if (shouldSuppressCliSessionJobLogLine(compacted)) return null;

  const codexItem = compacted.match(
    /^\[OpenAICodexExecutor\]\s+\[codex\]\s+item\.(?:completed|updated)\s+\|\s+(.+)$/i,
  );
  if (codexItem?.[1]) {
    return `[codex] ${compactCliSessionJobLogLine(codexItem[1])}`;
  }

  return compacted;
}

function shouldSuppressCliSessionJobLogLine(line: string): boolean {
  const text = String(line ?? "").trim();
  if (!text) return true;

  if (/^(___RESULT___|__PUSHPALS_OH_RESULT__)\b/.test(text)) return true;
  if (
    /^\[DockerExecutor\]\s+(?:Linked worktree dependency artifact|Capped job timeout|Extended job timeout)/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/^\[JobRunner\]\s+Starting job\b/i.test(text)) return true;
  if (/^\[QualityGate\]\s+(?:Policy:|Gates:)/i.test(text)) return true;
  if (
    /^\[(?:Openai_codex|OpenHands|Miniswe)Executor\]\s+(?:Spawning\b|Timeout reached\b|Still running\b|Process did not exit after graceful timeout termination\b)/i.test(
      text,
    )
  ) {
    return true;
  }

  if (
    /^\[OpenAICodexExecutor\]\s+(?:Planner guidance|Codex auth mode|ChatGPT auth mode|Starting codex exec|codex exec finished|Codex JSON stream captured|Codex stdout captured|No reasoning-like|Reasoning-like event|Usage observed|Temporarily masked repo-local|Timeout reached after|Process did not exit after graceful timeout termination)/i.test(
      text,
    )
  ) {
    return true;
  }

  if (/^\[OpenAICodexExecutor\]\s+codex exec still running\b/i.test(text)) return true;
  if (
    /^\[OpenAICodexExecutor\]\s+\[codex\]\s+(?:No reasoning-like|Reasoning-like|turn\.failed|turn\.completed|error\s+\|)/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/^\[OpenAICodexExecutor\]\s+\[codex\]\s+(?:thread|turn)\.started\b/i.test(text)) {
    return true;
  }
  if (/^\[OpenAICodexExecutor\]\s+\[codex\]\s+item\.started\b/i.test(text)) return true;
  if (/^\[OpenAICodexExecutor\]\s+\[codex\]\s+item\.(?:completed|updated)\b/i.test(text)) {
    return true;
  }
  if (
    /^\[OpenAICodexExecutor\]\s+\[stderr\].*codex_core::tools::router: error=exec_command failed/i.test(
      text,
    )
  ) {
    return true;
  }

  return false;
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

export function buildOpenPathCommand(target: string, platform = process.platform): string[] {
  if (platform === "win32") {
    return ["cmd", "/c", "start", "", target];
  }
  if (platform === "darwin") {
    return ["open", target];
  }
  return ["xdg-open", target];
}

export function buildOpenMonitoringHubCommand(url: string, platform = process.platform): string[] {
  return buildOpenPathCommand(url, platform);
}

export function buildOpenConfigCommand(configPath: string, platform = process.platform): string[] {
  return buildOpenPathCommand(configPath, platform);
}

export function resolveCliLocalConfigPath(configDir: string): string {
  return resolve(configDir, "local.toml");
}

export function ensureCliLocalConfigFile(configDir: string): string {
  const localConfigPath = resolveCliLocalConfigPath(configDir);
  if (existsSync(localConfigPath)) {
    return localConfigPath;
  }

  mkdirSync(configDir, { recursive: true });
  const exampleConfigPath = resolve(configDir, "local.example.toml");
  const configBody = existsSync(exampleConfigPath)
    ? readFileSync(exampleConfigPath, "utf8")
    : "# Local PushPals runtime overrides\n";
  writeFileSync(localConfigPath, configBody, "utf8");
  return localConfigPath;
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

async function openConfigFile(configDir: string): Promise<{ ok: boolean; path: string }> {
  const configPath = ensureCliLocalConfigFile(configDir);
  console.log(`[pushpals] Opening config file: ${configPath}`);
  const cmd = buildOpenConfigCommand(configPath, process.platform);
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  return { ok: code === 0, path: configPath };
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
  if (parsed.createVisionMd) {
    const exitCode = createVisionMdFromTemplate({
      repoRoot,
      runtimeRoot: preparedRuntime.runtimeRoot,
    });
    process.exit(exitCode);
  }
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
  if (parsed.openConfig) {
    const result = await openConfigFile(config.configDir);
    if (result.ok) {
      console.log(`[pushpals] Opened config file: ${result.path}`);
      process.exit(0);
    }
    console.error(`[pushpals] Failed to open config file. Edit this file manually: ${result.path}`);
    process.exit(1);
  }
  if (!enforceSupportedBunRuntime()) {
    process.exit(1);
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
  const requestedLocalAgentUrl = parsed.localAgentUrl ?? process.env.EXPO_PUBLIC_LOCAL_AGENT_URL;
  let localAgentUrl = normalizeLoopbackUrl(requestedLocalAgentUrl, config.client.localAgentUrl);
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
      console.warn(
        `[pushpals] Embedded SourceControlManager precheck failed (${scmGitPrecheck.detail}); continuing startup without blocking on SCM.`,
      );
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
  if (
    runEmbeddedRuntimeStartupPrechecks &&
    workerpalDockerPrecheck.status !== "failed" &&
    shouldPrepareEmbeddedWorkerpalDockerImageBlocking({
      platform: process.platform,
      env: process.env as Record<string, string | undefined>,
    })
  ) {
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
  } else if (runEmbeddedRuntimeStartupPrechecks && workerpalDockerPrecheck.status !== "failed") {
    console.log(
      `[pushpals] Skipping blocking WorkerPal sandbox image build during CLI startup; WorkerPal warmup will prepare it in the background. Set ${BLOCKING_WORKERPAL_IMAGE_BUILD_ENV}=1 to force the old foreground behavior.`,
    );
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
        const startLocalBuddy = resolveCliLocalBuddyAutostart(
          parsed.runtimeOnly,
          Boolean(config.localbuddy.enabled),
        );
        localAgentUrl = resolveEmbeddedLocalAgentUrl({
          requestedUrl: requestedLocalAgentUrl,
          configuredClientUrl: config.client.localAgentUrl,
          localBuddyPort: config.localbuddy.port,
          startLocalBuddy,
        });
        const startedRuntime = await autoStartRuntimeServices({
          repoRoot,
          serverUrl,
          localAgentUrl,
          sessionId,
          sourceControlManagerPort: config.sourceControlManager.port,
          sourceControlManagerRemote: config.sourceControlManager.remote,
          preparedRuntime,
          requestedRuntimeTag: resolvedRuntimeTagForAutoStart || parsed.runtimeTag,
          startLocalBuddy,
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
  remoteBuddyConsumerHealth = autoStartedServiceManager
    ? await waitForRemoteBuddySessionConsumer({
        serverUrl,
        sessionId: activeSessionId,
        timeoutMs: DEFAULT_REMOTEBUDDY_CONSUMER_STARTUP_GRACE_MS,
      })
    : await probeRemoteBuddySessionConsumer(serverUrl, activeSessionId);
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
  const shouldProbeWorkerpalStartupCapacity = Boolean(config.remotebuddy.autoSpawnWorkerpals);
  const workerpalCapacity = shouldProbeWorkerpalStartupCapacity
    ? await waitForWorkerpalCapacity({
        serverUrl,
        timeoutMs: resolveWorkerpalStartupReadinessProbeTimeoutMs(config),
        ttlMs: config.remotebuddy.workerpalOnlineTtlMs,
      })
    : {
        ok: false,
        detail: "WorkerPal auto-spawn is disabled",
      };
  if (shouldProbeWorkerpalStartupCapacity && !workerpalCapacity.ok) {
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
    : !shouldProbeWorkerpalStartupCapacity
      ? describeWorkerExecutionReadiness({
          autoSpawnWorkerpals: false,
          requireDocker:
            Boolean(config.remotebuddy.workerpalDocker) &&
            Boolean(config.remotebuddy.workerpalRequireDocker),
          dockerPrecheck: workerpalDockerPrecheck,
          onlineWorkers: 0,
          idleWorkers: 0,
        })
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
  const savedRuntimeHostState =
    saved.repoRoot &&
    normalizeRepoPathForComparison(saved.repoRoot) === normalizeRepoPathForComparison(repoRoot) &&
    saved.runtimeHostManagesRuntime
      ? {
          runtimeHostPid: saved.runtimeHostPid,
          runtimeHostManagesRuntime: saved.runtimeHostManagesRuntime,
          runtimeHostRuntimeOnly: saved.runtimeHostRuntimeOnly,
        }
      : {};
  const runtimeHostState = autoStartedServiceManager
    ? {
        runtimeHostPid: process.pid,
        runtimeHostManagesRuntime: true,
        runtimeHostRuntimeOnly: parsed.runtimeOnly,
      }
    : savedRuntimeHostState;

  if (statePath) {
    writeCliState(statePath, {
      monitoringHubUrl: monitoringHubUrl || undefined,
      serverUrl,
      localAgentUrl,
      sessionId: activeSessionId,
      repoRoot,
      pushpalsLogPath,
      ...runtimeHostState,
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
  markCliBootstrapReadyFromEnv();
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
      let exitRequestedFromInput = false;
      const keepAlive = setInterval(() => {
        // Keep headless runtime-only sessions alive after stdin EOF.
      }, 60_000);
      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearInterval(keepAlive);
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
        exitRequestedFromInput = true;
        void requestStop();
        runtimeOnlyInput.close();
        finish();
      });
      runtimeOnlyInput.on("close", () => {
        if (exitRequestedFromInput || resolved) {
          finish();
          return;
        }
        console.log("[pushpals] Runtime-only stdin closed; continuing until terminated.");
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
