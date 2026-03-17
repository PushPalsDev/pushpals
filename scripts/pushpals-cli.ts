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
  writeFileSync,
} from "fs";
import { basename, delimiter, dirname, extname, join, resolve } from "path";
import { createInterface, type Interface } from "readline";
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
  updatedAt?: string;
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

type SystemStatusClientRow = {
  clientId?: unknown;
  kind?: unknown;
  label?: unknown;
  sessionId?: unknown;
  status?: unknown;
  connectedTransports?: unknown;
};

type RemoteBuddySessionConsumerHealth = {
  ok: boolean;
  detail: string;
  clientId?: string;
  sessionId?: string;
};

type RemoteBuddyAutonomousEngineState = "unknown" | "enabled" | "disabled";

type RuntimeServiceName = "server" | "localbuddy" | "remotebuddy" | "source_control_manager";

type RuntimeServiceLogPaths = Record<RuntimeServiceName, string>;

type RuntimeServiceProcess = {
  name: RuntimeServiceName;
  proc: Bun.Subprocess;
  logPath: string;
  exited: boolean;
  exitCode: number | null;
};

type RuntimeBinarySet = {
  server: string;
  localbuddy: string;
  remotebuddy: string;
  sourceControlManager: string;
};

type RuntimeAssetSource = {
  root: string;
  envExamplePath: string;
  visionExamplePath: string;
  configsDir: string;
  promptsDir: string;
  protocolSchemasDir: string;
};

type PreparedCliRuntime = {
  runtimeRoot: string;
  runtimeTag: string;
  runtimePreflight: ClientRuntimePreflightResult;
  preflightUsesEmbeddedRuntime: boolean;
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

const DEFAULT_MONITOR_PORT = 8081;
const MONITOR_SCAN_PORTS = 32;
const MONITOR_POLL_MS = 2_000;
const HTTP_TIMEOUT_MS = 2_500;
const LOCALBUDDY_TIMEOUT_MS = 4_000;
const SSE_RECONNECT_MS = 1_500;
const DEFAULT_RUNTIME_BOOT_TIMEOUT_MS = 90_000;
const DEFAULT_RUNTIME_BOOT_POLL_MS = 1_000;
const DEFAULT_SERVER_BOOT_TIMEOUT_MS = 20_000;
const DEFAULT_SERVICE_STABILITY_GRACE_MS = 4_000;
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

  const patch =
    <T extends (...args: any[]) => unknown>(original: T): T =>
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
  console.log("  --runtime-only         Start the local runtime and wait for shutdown without opening the interactive chat");
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
  const options: CliOptions = { noAutoStart: false, noStream: false, runtimeOnly: false };

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
    const hostname = String(parsed.hostname ?? "").trim().toLowerCase();
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

async function runGit(
  args: string[],
  cwd: string,
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
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

export function bundledMonitoringHubNeedsRefresh(existingRoot: string, sourceRoot: string): boolean {
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
    console.log("[pushpals] Packaged monitor UI is stale; refreshing the exported client monitor...");
  }

  exportBundledMonitoringHubFromSourceCheckout(sourceRoot);
  return resolveBundledMonitoringHubRoot();
}

function repoLooksLikePushPalsSourceCheckout(repoRoot: string): boolean {
  return (
    existsSync(join(repoRoot, "configs", "default.toml")) ||
    existsSync(join(repoRoot, "config", "default.toml"))
  );
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

async function resolveRuntimeReleaseTag(explicitTag?: string): Promise<string> {
  const fromArg = String(explicitTag ?? "").trim();
  if (fromArg) return fromArg;

  const fromEnv = String(process.env.PUSHPALS_RUNTIME_TAG ?? "").trim();
  if (fromEnv) return fromEnv;

  const packageVersion = parseSemverFromPackageVersion(process.env.PUSHPALS_CLI_PACKAGE_VERSION);
  console.log("[pushpals] Resolving embedded runtime release tag from GitHub...");
  try {
    return await fetchLatestReleaseTag();
  } catch (err) {
    if (packageVersion) {
      const fallbackTag = `v${packageVersion}`;
      console.warn(
        `[pushpals] Could not resolve latest runtime tag; falling back to package version tag ${fallbackTag}: ${String(err)}`,
      );
      return fallbackTag;
    }
    throw err;
  }
}

function writeTextFileIfMissing(pathValue: string, text: string): void {
  if (existsSync(pathValue)) return;
  mkdirSync(dirname(pathValue), { recursive: true });
  writeFileSync(pathValue, text, "utf8");
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
}

function copyBundledRuntimeAssets(runtimeRoot: string, force = true): boolean {
  const bundledSource = resolveBundledRuntimeAssetSource();
  if (!bundledSource) return false;
  copyRuntimeAssetBundle(bundledSource, runtimeRoot, force);
  return true;
}

function seedRuntimePreflightAssets(runtimeRoot: string): void {
  copyBundledRuntimeAssets(runtimeRoot, false);
  writeTextFileIfMissing(join(runtimeRoot, ".env"), "# Local PushPals runtime environment\n");
  const localExamplePath = join(runtimeRoot, "configs", "local.example.toml");
  if (existsSync(localExamplePath)) {
    writeTextFileIfMissing(
      join(runtimeRoot, "configs", "local.toml"),
      readFileSync(localExamplePath, "utf8"),
    );
  } else {
    writeTextFileIfMissing(
      join(runtimeRoot, "configs", "local.toml"),
      "# Local PushPals runtime overrides\n",
    );
  }
}

async function fetchTextFromUrl(url: string, timeoutMs = 20_000): Promise<string> {
  const response = await fetchWithTimeout(url, { headers: GITHUB_HEADERS }, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return await response.text();
}

async function downloadRuntimeAssetsFromSourceTag(runtimeRoot: string, tag: string): Promise<void> {
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
        pathValue.startsWith("configs/") ||
        pathValue.startsWith("prompts/") ||
        pathValue.startsWith("packages/protocol/src/schemas/"),
    );

  if (paths.length === 0) {
    throw new Error(`Runtime source tree for ${tag} did not include prompts/config assets`);
  }

  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  for (const pathValue of sorted) {
    const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${encodeURIComponent(tag)}/${pathValue}`;
    const body = await fetchTextFromUrl(rawUrl, 20_000);
    const outPath = pathValue.startsWith("packages/protocol/src/schemas/")
      ? join(
          runtimeRoot,
          "protocol",
          "schemas",
          pathValue.slice("packages/protocol/src/schemas/".length),
        )
      : join(runtimeRoot, pathValue);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, body, "utf8");
  }
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
    hasProtocolSchemas;
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
      hasProtocolSchemasAfterCopy;
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
  if (existsSync(localExamplePath)) {
    writeTextFileIfMissing(
      join(runtimeRoot, "configs", "local.toml"),
      readFileSync(localExamplePath, "utf8"),
    );
  } else {
    writeTextFileIfMissing(
      join(runtimeRoot, "configs", "local.toml"),
      "# Local PushPals runtime overrides\n",
    );
  }
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

function runtimeBinaryFilename(serviceName: RuntimeServiceName, platformKey: string): string {
  const serviceToken =
    serviceName === "source_control_manager" ? "source-control-manager" : serviceName;
  const extension = platformKey.startsWith("windows-") ? ".exe" : "";
  return `pushpals-runtime-${serviceToken}-${platformKey}${extension}`;
}

export function buildEmbeddedRuntimeEnv(
  baseEnv: Record<string, string | undefined>,
  opts: {
    repoRoot: string;
    runtimeRoot: string;
    useRuntimeConfig?: boolean;
    sessionId?: string;
  },
): Record<string, string> {
  const env = normalizeChildProcessEnv(baseEnv);
  const useRuntimeConfig = opts.useRuntimeConfig !== false;
  return {
    ...env,
    PUSHPALS_REPO_ROOT_OVERRIDE: opts.repoRoot,
    PUSHPALS_PROJECT_ROOT_OVERRIDE: opts.repoRoot,
    ...(useRuntimeConfig
      ? {
          PUSHPALS_CONFIG_DIR_OVERRIDE: join(opts.runtimeRoot, "configs"),
          PUSHPALS_PROMPTS_ROOT_OVERRIDE: opts.runtimeRoot,
        }
      : {
          PUSHPALS_PROMPTS_ROOT_OVERRIDE: opts.repoRoot,
        }),
    PUSHPALS_PROTOCOL_SCHEMAS_DIR: join(opts.runtimeRoot, "protocol", "schemas"),
    ...(typeof opts.sessionId === "string" && opts.sessionId.trim()
      ? { PUSHPALS_SESSION_ID: opts.sessionId.trim() }
      : {}),
    ...(typeof env.PUSHPALS_GIT_BIN === "string" && env.PUSHPALS_GIT_BIN.trim()
      ? { PUSHPALS_GIT_BIN: env.PUSHPALS_GIT_BIN.trim() }
      : {}),
    ...(typeof env.PUSHPALS_GIT_BIN_ABSOLUTE === "string" && env.PUSHPALS_GIT_BIN_ABSOLUTE.trim()
      ? { PUSHPALS_GIT_BIN_ABSOLUTE: env.PUSHPALS_GIT_BIN_ABSOLUTE.trim() }
      : {}),
  };
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
      ? [
          ["where.exe", command],
          ["where", command],
        ]
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

function readRemoteBuddyAutonomousEngineState(
  logPath: string,
): RemoteBuddyAutonomousEngineState {
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

async function ensureRuntimeBinaries(
  runtimeRoot: string,
  runtimeTag: string,
): Promise<RuntimeBinarySet> {
  const platformKey = resolveRuntimePlatformKey();
  console.log(
    `[pushpals] Preparing embedded runtime binaries for ${runtimeTag} (${platformKey})...`,
  );
  const binDir = join(runtimeRoot, "bin", `${runtimeTag}-${platformKey}`);
  mkdirSync(binDir, { recursive: true });

  const runtimeBinaries: RuntimeBinarySet = {
    server: join(binDir, runtimeBinaryFilename("server", platformKey)),
    localbuddy: join(binDir, runtimeBinaryFilename("localbuddy", platformKey)),
    remotebuddy: join(binDir, runtimeBinaryFilename("remotebuddy", platformKey)),
    sourceControlManager: join(
      binDir,
      runtimeBinaryFilename("source_control_manager", platformKey),
    ),
  };

  const requiredAssets = [
    runtimeBinaries.server,
    runtimeBinaries.localbuddy,
    runtimeBinaries.remotebuddy,
    runtimeBinaries.sourceControlManager,
  ];
  let downloadedCount = 0;
  for (const binaryPath of requiredAssets) {
    if (existsSync(binaryPath)) continue;
    const assetName = binaryPath.split(/[\\/]/).pop() || "";
    await downloadBinaryAsset(runtimeTag, assetName, binaryPath);
    downloadedCount++;
  }

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

function spawnRuntimeService(
  name: RuntimeServiceName,
  command: string[],
  cwd: string,
  env: Record<string, string>,
  logPath: string,
  runtimeServicesLogPath?: string,
): RuntimeServiceProcess {
  const header = `[pushpals] service=${name} command=${command.join(" ")} cwd=${cwd}`;
  writeFileSync(logPath, `${header}\n`, "utf8");
  if (runtimeServicesLogPath) {
    appendRuntimeServicesLogLine(runtimeServicesLogPath, header);
  }

  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const pipeToLog = async (
    stream: ReadableStream<Uint8Array> | null,
    channel: "stdout" | "stderr",
  ): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const serviceLine = `[${channel}] ${line}`;
        appendFileSync(logPath, `${serviceLine}\n`, "utf8");
        if (runtimeServicesLogPath) {
          appendRuntimeServicesLogLine(runtimeServicesLogPath, `[${name}] ${serviceLine}`);
        }
      }
    }
    const rest = decoder.decode();
    if (rest) pending += rest;
    if (pending.trim().length > 0) {
      const serviceLine = `[${channel}] ${pending.trimEnd()}`;
      appendFileSync(logPath, `${serviceLine}\n`, "utf8");
      if (runtimeServicesLogPath) {
        appendRuntimeServicesLogLine(runtimeServicesLogPath, `[${name}] ${serviceLine}`);
      }
    }
  };

  void pipeToLog(proc.stdout, "stdout");
  void pipeToLog(proc.stderr, "stderr");

  const service: RuntimeServiceProcess = {
    name,
    proc,
    logPath,
    exited: false,
    exitCode: null,
  };
  void proc.exited.then((code) => {
    service.exited = true;
    service.exitCode = code;
  });
  return service;
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
        service.proc.kill();
      }
    } catch {
      // ignore
    }
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
    platform === "win32"
      ? String(env.Path ?? env.PATH ?? "")
      : String(env.PATH ?? "");
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

function isOptionalEmbeddedService(name: RuntimeServiceName): boolean {
  return name === "source_control_manager";
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

async function repoHasRemote(repoRoot: string, remote: string): Promise<boolean> {
  const normalizedRemote = remote.trim();
  if (!normalizedRemote) return false;
  const result = await runGit(["remote", "get-url", normalizedRemote], repoRoot);
  return result.ok && Boolean(result.stdout);
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
    (row) => String(row.status ?? "").trim().toLowerCase() === "connected",
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
    return String(row.status ?? "").trim().toLowerCase() === "connected";
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
    const knownSessions = [...new Set(anyRemoteBuddyRows.map((row) => String(row.sessionId ?? "").trim()))]
      .filter(Boolean)
      .sort();
    const suffix =
      knownSessions.length > 0 ? ` Known RemoteBuddy sessions: ${knownSessions.join(", ")}.` : "";
    return {
      ok: false,
      detail: `No connected RemoteBuddy session consumer found for session ${sessionId}.${suffix}`.trim(),
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

function buildClientTransportQuery(
  cursor: number,
  client: ClientStreamIdentity,
): string {
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

async function probeLocalBuddy(
  localAgentUrl: string,
): Promise<LocalBuddyHealth | null> {
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
}): Promise<RuntimeServiceProcess[]> {
  const { runtimePreflight } = opts.preparedRuntime;
  const runtimeRoot = opts.preparedRuntime.runtimeRoot;
  const runtimeTag =
    opts.preparedRuntime.runtimeTag || (await resolveRuntimeReleaseTag(opts.requestedRuntimeTag));
  const startLocalBuddy = opts.startLocalBuddy ?? Boolean(runtimePreflight.config.localbuddy.enabled);
  const localBuddyEnabled = startLocalBuddy;

  console.log(`[pushpals] Runtime unavailable. Auto-starting runtime for repo: ${opts.repoRoot}`);
  console.log(`[pushpals] runtimeRoot=${runtimeRoot}`);
  console.log(`[pushpals] runtimeTag=${runtimeTag}`);
  if (!runtimePreflight.ok) {
    throw new Error("Embedded runtime preflight failed.");
  }

  await ensureRuntimeAssets(runtimeRoot, runtimeTag);
  const runtimeBinaries = await ensureRuntimeBinaries(runtimeRoot, runtimeTag);

  const runtimeEnv = buildEmbeddedRuntimeEnv(process.env as Record<string, string | undefined>, {
    repoRoot: opts.repoRoot,
    runtimeRoot,
    useRuntimeConfig: opts.preparedRuntime.preflightUsesEmbeddedRuntime,
    sessionId: opts.sessionId,
  });
  if (runtimeEnv.PUSHPALS_GIT_BIN) {
    applyResolvedGitBinaryToRuntimeEnv(runtimeEnv, runtimeEnv.PUSHPALS_GIT_BIN);
  }
  const gitLookupCommand =
    typeof runtimeEnv.PUSHPALS_GIT_BIN === "string" && runtimeEnv.PUSHPALS_GIT_BIN.trim()
      ? runtimeEnv.PUSHPALS_GIT_BIN.trim()
      : "git";
  const resolvedGitBinary = await resolveCommandPath(
    gitLookupCommand,
    opts.repoRoot,
    runtimeEnv,
  );
  if (resolvedGitBinary) {
    applyResolvedGitBinaryToRuntimeEnv(runtimeEnv, resolvedGitBinary);
  }

  const services: RuntimeServiceProcess[] = [];
  const runToken = timestampFileToken();
  const logDir = join(runtimeRoot, "logs", "bootstrap");
  mkdirSync(logDir, { recursive: true });
  const serviceLogPaths = buildRuntimeServiceLogPaths(logDir, runToken);
  const runtimeServicesLogPath = join(logDir, `${runToken}-runtime-services.log`);
  writeFileSync(runtimeServicesLogPath, "", "utf8");
  appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] runtimeRoot=${runtimeRoot}`);
  appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] runtimeTag=${runtimeTag}`);
  appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] repoRoot=${opts.repoRoot}`);
  console.log(`[pushpals] runtime services log: ${runtimeServicesLogPath}`);
  console.log(`[pushpals] service log (server)=${serviceLogPaths.server}`);
  console.log(`[pushpals] service log (localbuddy)=${serviceLogPaths.localbuddy}`);
  console.log(`[pushpals] service log (remotebuddy)=${serviceLogPaths.remotebuddy}`);
  console.log(
    `[pushpals] service log (source_control_manager)=${serviceLogPaths.source_control_manager}`,
  );

  const serverHealthy = await probeServer(opts.serverUrl);
  if (!serverHealthy) {
    console.log("[pushpals] Starting embedded server...");
    const serverService = spawnRuntimeService(
      "server",
      [runtimeBinaries.server],
      opts.repoRoot,
      runtimeEnv,
      serviceLogPaths.server,
      runtimeServicesLogPath,
    );
    services.push(serverService);
    console.log(`[pushpals] server log: ${serverService.logPath}`);

    const serverDeadline = Date.now() + DEFAULT_SERVER_BOOT_TIMEOUT_MS;
    let serverIsReady = false;
    while (Date.now() < serverDeadline) {
      if (serverService.exited) {
        const tail = readLogTail(serverService.logPath);
        appendRuntimeServicesLogLine(
          runtimeServicesLogPath,
          `[pushpals] embedded server exited during bootstrap (code=${serverService.exitCode ?? "unknown"}).`,
        );
        stopRuntimeServices(services);
        throw new Error(
          `Embedded server exited during bootstrap (code=${serverService.exitCode ?? "unknown"}). ` +
            `See ${serverService.logPath}${tail ? `\n--- server log tail ---\n${tail}` : ""}`,
        );
      }
      if (await probeServer(opts.serverUrl)) {
        serverIsReady = true;
        break;
      }
      await Bun.sleep(DEFAULT_RUNTIME_BOOT_POLL_MS);
    }
    if (!serverIsReady) {
      const tail = readLogTail(serverService.logPath);
      appendRuntimeServicesLogLine(
        runtimeServicesLogPath,
        `[pushpals] embedded server did not become healthy within ${DEFAULT_SERVER_BOOT_TIMEOUT_MS}ms.`,
      );
      stopRuntimeServices(services);
      throw new Error(
        `Embedded server did not become healthy within ${DEFAULT_SERVER_BOOT_TIMEOUT_MS}ms. ` +
          `See ${serverService.logPath}${tail ? `\n--- server log tail ---\n${tail}` : ""}`,
      );
    }
    console.log("[pushpals] Embedded server is healthy.");
  } else {
    console.log("[pushpals] Server already healthy; skipping embedded server start.");
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      "[pushpals] server already healthy; embedded server start skipped.",
    );
  }

  if (localBuddyEnabled) {
    console.log("[pushpals] Starting embedded LocalBuddy...");
    const localbuddyService = spawnRuntimeService(
      "localbuddy",
      [runtimeBinaries.localbuddy],
      opts.repoRoot,
      runtimeEnv,
      serviceLogPaths.localbuddy,
      runtimeServicesLogPath,
    );
    services.push(localbuddyService);
    console.log(`[pushpals] localbuddy log: ${localbuddyService.logPath}`);
  } else {
    console.log("[pushpals] Embedded LocalBuddy disabled for this CLI session; skipping start.");
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      "[pushpals] localbuddy disabled for this CLI session; embedded localbuddy start skipped.",
    );
  }

  console.log("[pushpals] Starting embedded RemoteBuddy...");
  const remotebuddyService = spawnRuntimeService(
    "remotebuddy",
    [runtimeBinaries.remotebuddy],
    opts.repoRoot,
    runtimeEnv,
    serviceLogPaths.remotebuddy,
    runtimeServicesLogPath,
  );
  services.push(remotebuddyService);
  console.log(`[pushpals] remotebuddy log: ${remotebuddyService.logPath}`);
  let lastReportedRemoteBuddyAutonomyState: RemoteBuddyAutonomousEngineState = "unknown";
  const reportRemoteBuddyAutonomousEngineState = (): void => {
    const autonomyState = readRemoteBuddyAutonomousEngineState(remotebuddyService.logPath);
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

  const scmHealthy = await probeSourceControlManager(opts.sourceControlManagerPort);
  const scmRemoteAvailable = await repoHasRemote(opts.repoRoot, opts.sourceControlManagerRemote);
  const gitForScm =
    typeof runtimeEnv.PUSHPALS_GIT_BIN_ABSOLUTE === "string" &&
    runtimeEnv.PUSHPALS_GIT_BIN_ABSOLUTE.trim()
      ? runtimeEnv.PUSHPALS_GIT_BIN_ABSOLUTE.trim()
      : typeof runtimeEnv.PUSHPALS_GIT_BIN === "string" && runtimeEnv.PUSHPALS_GIT_BIN.trim()
        ? runtimeEnv.PUSHPALS_GIT_BIN.trim()
        : "git";
  const gitProbeCommand = [gitForScm, "--version"];
  const gitAvailableForScm = await canSpawnCommand(gitProbeCommand, opts.repoRoot, runtimeEnv);
  if (!scmHealthy && scmRemoteAvailable) {
    if (!gitAvailableForScm) {
      console.warn(
        "[pushpals] Git is not available to embedded SourceControlManager; skipping SCM startup.",
      );
      appendRuntimeServicesLogLine(
        runtimeServicesLogPath,
        "[pushpals] source_control_manager skipped: git is unavailable in embedded runtime env.",
      );
    } else {
      console.log(`[pushpals] Embedded SourceControlManager git=${gitForScm}`);
      console.log("[pushpals] Starting embedded SourceControlManager...");
      const sourceControlManagerService = spawnRuntimeService(
        "source_control_manager",
        [runtimeBinaries.sourceControlManager, "--skip-clean-check"],
        opts.repoRoot,
        runtimeEnv,
        serviceLogPaths.source_control_manager,
        runtimeServicesLogPath,
      );
      services.push(sourceControlManagerService);
      console.log(`[pushpals] source_control_manager log: ${sourceControlManagerService.logPath}`);
    }
  } else if (!scmRemoteAvailable) {
    console.log(
      `[pushpals] Repo has no git remote "${opts.sourceControlManagerRemote}"; skipping embedded SourceControlManager.`,
    );
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      `[pushpals] source_control_manager skipped: repo has no remote "${opts.sourceControlManagerRemote}".`,
    );
  } else if (!gitAvailableForScm) {
    console.warn(
      "[pushpals] Git is not available to embedded SourceControlManager; skipping SCM startup.",
    );
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      "[pushpals] source_control_manager skipped: git is unavailable in embedded runtime env.",
    );
  } else {
    console.log("[pushpals] SourceControlManager already healthy; skipping embedded start.");
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      "[pushpals] source_control_manager already healthy; embedded start skipped.",
    );
  }

  const deadline = Date.now() + DEFAULT_RUNTIME_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    reportRemoteBuddyAutonomousEngineState();
    for (let i = services.length - 1; i >= 0; i--) {
      const service = services[i];
      if (service.exited) {
        if (isOptionalEmbeddedService(service.name)) {
          console.warn(
            `[pushpals] Embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}); continuing without SCM.`,
          );
          appendRuntimeServicesLogLine(
            runtimeServicesLogPath,
            `[pushpals] embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}); continuing.`,
          );
          const tail = readLogTail(service.logPath);
          if (tail) {
            console.warn(`[pushpals] ${service.name} log tail:\n${tail}`);
            appendRuntimeServicesLogLine(
              runtimeServicesLogPath,
              `[pushpals] ${service.name} log tail:\n${tail}`,
            );
          }
          services.splice(i, 1);
          continue;
        }
        const tail = readLogTail(service.logPath);
        appendRuntimeServicesLogLine(
          runtimeServicesLogPath,
          `[pushpals] embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}).`,
        );
        stopRuntimeServices(services);
        throw new Error(
          `Embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}). ` +
            `See ${service.logPath}${tail ? `\n--- ${service.name} log tail ---\n${tail}` : ""}`,
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
        for (let i = services.length - 1; i >= 0; i--) {
          const service = services[i];
          if (!service.exited) continue;
          if (isOptionalEmbeddedService(service.name)) {
            const tail = readLogTail(service.logPath);
            console.warn(
              `[pushpals] Embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}); continuing without SCM.`,
            );
            appendRuntimeServicesLogLine(
              runtimeServicesLogPath,
              `[pushpals] embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}); continuing.`,
            );
            if (tail) {
              console.warn(`[pushpals] ${service.name} log tail:\n${tail}`);
              appendRuntimeServicesLogLine(
                runtimeServicesLogPath,
                `[pushpals] ${service.name} log tail:\n${tail}`,
              );
            }
            services.splice(i, 1);
            continue;
          }
          const tail = readLogTail(service.logPath);
          appendRuntimeServicesLogLine(
            runtimeServicesLogPath,
            `[pushpals] embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}).`,
          );
          stopRuntimeServices(services);
          throw new Error(
            `Embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}). ` +
              `See ${service.logPath}${tail ? `\n--- ${service.name} log tail ---\n${tail}` : ""}`,
          );
        }
        await Bun.sleep(250);
      }
      console.log("[pushpals] Embedded runtime is ready.");
      appendRuntimeServicesLogLine(
        runtimeServicesLogPath,
        "[pushpals] embedded runtime is ready.",
      );
      return services;
    }
    await Bun.sleep(DEFAULT_RUNTIME_BOOT_POLL_MS);
  }

  stopRuntimeServices(services);
  const remoteBuddyHealth = await probeRemoteBuddySessionConsumer(opts.serverUrl, opts.sessionId);
  if (!localBuddyEnabled && !remoteBuddyHealth.ok) {
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      `[pushpals] timed out waiting for RemoteBuddy session consumer readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms (${remoteBuddyHealth.detail}).`,
    );
    throw new Error(
      `Timed out waiting for RemoteBuddy session consumer readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms (${remoteBuddyHealth.detail})`,
    );
  }
  if (!localBuddyEnabled) {
    appendRuntimeServicesLogLine(
      runtimeServicesLogPath,
      `[pushpals] timed out waiting for embedded runtime readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms.`,
    );
    throw new Error(
      `Timed out waiting for embedded runtime readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms`,
    );
  }
  appendRuntimeServicesLogLine(
    runtimeServicesLogPath,
    `[pushpals] timed out waiting for LocalBuddy at ${opts.localAgentUrl} and RemoteBuddy session consumer after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms.`,
  );
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

async function proxyMonitoringHubRequest(
  serverUrl: string,
  pathValue: string,
): Promise<Response> {
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

async function runSessionStream(
  serverUrl: string,
  sessionId: string,
  client: ClientStreamIdentity,
  print: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  let cursor = 0;

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
  const normalized = String(text ?? "").trim().toLowerCase();
  return normalized === "/exit" || normalized === "/quit" || normalized === "exit" || normalized === "quit";
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

  const config = preparedRuntime.runtimePreflight.config;
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
  const cliVersion = String(process.env.PUSHPALS_CLI_PACKAGE_VERSION ?? "").trim() || "unknown";
  const cliClient: ClientStreamIdentity = {
    clientId: createRuntimeClientId("cli"),
    kind: "cli",
    label: "CLI",
    version: cliVersion,
    platform: `${process.platform}/${process.arch}`,
    repoRoot,
  };
  let autoStartedServices: RuntimeServiceProcess[] = [];
  const stopAutoStartedServices = (): void => {
    if (autoStartedServices.length === 0) return;
    stopRuntimeServices(autoStartedServices);
    autoStartedServices = [];
  };

  let serverHealthy = await probeServer(serverUrl);
  const serverWasAlreadyHealthy = serverHealthy;
  let remoteBuddyConsumerHealth: RemoteBuddySessionConsumerHealth = {
    ok: false,
    detail: `No connected RemoteBuddy session consumer found for session ${sessionId}`,
  };
  if (!serverHealthy) {
    if (!parsed.noAutoStart) {
      try {
        autoStartedServices = await autoStartRuntimeServices({
          repoRoot,
          serverUrl,
          localAgentUrl,
          sessionId,
          sourceControlManagerPort: config.sourceControlManager.port,
          sourceControlManagerRemote: config.sourceControlManager.remote,
          preparedRuntime,
          requestedRuntimeTag: parsed.runtimeTag,
          startLocalBuddy: resolveCliLocalBuddyAutostart(
            parsed.runtimeOnly,
            Boolean(config.localbuddy.enabled),
          ),
        });
        serverHealthy = await probeServer(serverUrl);
      } catch (err) {
        console.error(`[pushpals] Auto-start failed: ${String(err)}`);
        stopAutoStartedServices();
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
      console.error("[pushpals] Auto-start could not bring the embedded runtime into a usable state.");
    }
    process.exit(1);
  }

  const statePath = resolveCliStatePath(repoRoot);
  const saved = statePath ? readCliState(statePath) : {};
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
  console.log(`[pushpals] cliStateFile=${statePath ?? "unavailable"}`);
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
    : parsed.runtimeOnly
    ? Promise.resolve()
    : runSessionStream(
        serverUrl,
        activeSessionId,
        cliClient,
        printIncoming,
        streamAbort.signal,
      );

  let shuttingDown = false;
  const requestStop = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[pushpals] Shutting down CLI session...");
    streamAbort.abort();
    if (rl) rl.close();
    try {
      monitoringHub?.stop();
    } catch {
      // ignore
    }
    if (autoStartedServices.length > 0) {
      console.log("[pushpals] Stopping embedded runtime services...");
    }
    stopAutoStartedServices();
  };

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  process.once("exit", requestStop);

  if (parsed.runtimeOnly) {
    console.log("[pushpals] Runtime-only mode is active. Send `exit` on stdin or terminate the process to stop.");

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
        requestStop();
        runtimeOnlyInput.close();
        finish();
      });
      runtimeOnlyInput.on("close", () => {
        requestStop();
        finish();
      });
    });

    requestStop();
    await Promise.race([streamTask, Bun.sleep(2_000)]);
    return;
  }

  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
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
      requestStop();
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
      console.log(`[pushpals] serverUrl=${serverUrl}`);
      console.log(`[pushpals] sessionId=${activeSessionId}`);
      console.log(`[pushpals] repoRoot=${repoRoot}`);
      console.log(
        monitoringHubUrl
          ? `[pushpals] monitoringHubUrl=${monitoringHubUrl}`
          : "[pushpals] monitoringHubUrl=unavailable",
      );
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

  requestStop();
  await Promise.race([streamTask, Bun.sleep(2_000)]);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[pushpals] Fatal: ${String(err)}`);
    process.exit(1);
  });
}
