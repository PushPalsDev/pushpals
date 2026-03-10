#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { createInterface, type Interface } from "readline";
import { loadPushPalsConfig } from "../packages/shared/src/config.js";

type CliOptions = {
  serverUrl?: string;
  localAgentUrl?: string;
  sessionId?: string;
  monitoringHubUrl?: string;
  noStream: boolean;
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

const DEFAULT_MONITOR_PORT = 8081;
const MONITOR_SCAN_PORTS = 32;
const HTTP_TIMEOUT_MS = 2_500;
const LOCALBUDDY_TIMEOUT_MS = 4_000;
const SSE_RECONNECT_MS = 1_500;
const stateVersion = 1;

function printUsage(): void {
  console.log("PushPals CLI");
  console.log("");
  console.log("Usage:");
  console.log("  pushpals [options]");
  console.log("");
  console.log("Options:");
  console.log("  --server-url <url>     Override PushPals server URL");
  console.log("  --local-agent-url <url> Override LocalBuddy URL");
  console.log("  --session-id <id>      Override session ID");
  console.log("  --hub-url <url>        Override monitoring hub URL");
  console.log("  --no-stream            Disable live session event stream");
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
  console.log("  - LocalBuddy must be running and attached to the same repo root.");
}

function parseArgs(argv: string[]): CliOptions | null {
  const options: CliOptions = { noStream: false };

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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizePath(value: string): string {
  const normalized = resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") return normalized.toLowerCase();
  return normalized;
}

async function runGit(args: string[], cwd: string): Promise<{
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

function authHeaders(authToken: string | null): Record<string, string> {
  if (!authToken) return {};
  return { Authorization: `Bearer ${authToken}` };
}

async function probeLocalBuddy(
  localAgentUrl: string,
  authToken: string | null,
): Promise<LocalBuddyHealth | null> {
  return await fetchJsonWithTimeout<LocalBuddyHealth>(
    `${localAgentUrl}/healthz`,
    { headers: authHeaders(authToken) },
    LOCALBUDDY_TIMEOUT_MS,
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

async function resolveMonitoringHubUrl(
  preferredUrl: string,
  fallbackPort: number,
): Promise<string> {
  const explicit = normalizeUrl(preferredUrl);
  if (explicit) return explicit;

  const basePort = fallbackPort;
  for (let port = basePort; port < basePort + MONITOR_SCAN_PORTS; port++) {
    const candidate = `http://localhost:${port}`;
    if (await looksLikeMonitoringHub(candidate)) return candidate;
  }
  return `http://localhost:${basePort}`;
}

async function sendMessageToLocalBuddy(localAgentUrl: string, text: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${localAgentUrl}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
      30_000,
    );
  } catch (err) {
    console.error(`[pushpals] Failed to reach LocalBuddy: ${String(err)}`);
    return false;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`[pushpals] LocalBuddy rejected message: HTTP ${response.status} ${detail}`);
    return false;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    console.error("[pushpals] LocalBuddy response stream missing.");
    return false;
  }

  let buffer = "";
  const decoder = new TextDecoder();
  let complete = false;
  let ok = true;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const dataLine = chunk
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      try {
        const payload = JSON.parse(dataLine.slice(6)) as {
          type?: string;
          message?: string;
          data?: Record<string, unknown>;
        };
        const type = String(payload.type ?? "").trim().toLowerCase();
        const message = String(payload.message ?? "").trim();
        if (type === "status" && message) {
          console.log(`[localbuddy] ${message}`);
        } else if (type === "error") {
          ok = false;
          console.log(`[localbuddy] ERROR: ${message || "Unknown failure"}`);
        } else if (type === "complete") {
          complete = true;
          const requestId =
            payload.data && typeof payload.data.requestId === "string"
              ? payload.data.requestId
              : "";
          if (requestId) {
            console.log(`[localbuddy] requestId=${requestId}`);
          } else if (message) {
            console.log(`[localbuddy] ${message}`);
          }
        }
      } catch {
        // Ignore malformed stream chunks.
      }
    }
  }

  return ok && complete;
}

function formatSessionEventLine(event: NonNullable<SessionStreamPayload["envelope"]>): string | null {
  const type = String(event.type ?? "").toLowerCase();
  const from = String(event.from ?? "");
  const payload = event.payload ?? {};

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
  authToken: string | null,
  print: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  let cursor = 0;

  while (!signal.aborted) {
    const headers = authHeaders(authToken);
    try {
      const response = await fetchWithTimeout(
        `${serverUrl}/sessions/${encodeURIComponent(sessionId)}/events${cursor > 0 ? `?after=${cursor}` : ""}`,
        { headers },
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

async function openMonitoringHub(url: string): Promise<boolean> {
  let cmd: string[] | null = null;
  if (process.platform === "win32") {
    const escaped = url.replace(/'/g, "''");
    cmd = ["powershell", "-NoProfile", "-Command", `Start-Process '${escaped}'`];
  } else if (process.platform === "darwin") {
    cmd = ["open", url];
  } else {
    cmd = ["xdg-open", url];
  }

  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  return code === 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) return;

  const config = loadPushPalsConfig();
  const cwd = process.cwd();
  const repoRoot = await resolveCurrentGitRepoRoot(cwd);
  if (!repoRoot) {
    console.error("[pushpals] Refusing to start: current directory is not a git repository.");
    console.error(`[pushpals] cwd=${cwd}`);
    console.error("[pushpals] Run from a repo directory, or initialize one with `git init`.");
    process.exit(1);
  }

  const serverUrl = normalizeUrl(parsed.serverUrl ?? process.env.PUSHPALS_SERVER_URL, config.server.url);
  const localAgentUrl = normalizeUrl(
    parsed.localAgentUrl ?? process.env.EXPO_PUBLIC_LOCAL_AGENT_URL,
    config.client.localAgentUrl,
  );
  const sessionId = String(parsed.sessionId ?? process.env.PUSHPALS_SESSION_ID ?? config.sessionId).trim();
  const authToken = config.authToken;

  const health = await probeLocalBuddy(localAgentUrl, authToken);
  if (!health?.ok) {
    console.error(`[pushpals] LocalBuddy is unavailable at ${localAgentUrl}.`);
    console.error("[pushpals] Start the stack first, then rerun `pushpals`.");
    process.exit(1);
  }

  const localBuddyRepo = health.repo ? resolve(health.repo) : "";
  if (!localBuddyRepo) {
    console.error("[pushpals] LocalBuddy health response did not include repo path.");
    process.exit(1);
  }

  if (normalizePath(localBuddyRepo) !== normalizePath(repoRoot)) {
    console.error("[pushpals] Repo mismatch detected.");
    console.error(`[pushpals] currentRepo=${repoRoot}`);
    console.error(`[pushpals] localBuddyRepo=${localBuddyRepo}`);
    console.error(
      "[pushpals] LocalBuddy must run against the same repo. Start PushPals from this repo and retry.",
    );
    process.exit(1);
  }

  const localBuddySessionId =
    health.sessionId && String(health.sessionId).trim() ? String(health.sessionId).trim() : sessionId;
  if (sessionId && sessionId !== localBuddySessionId) {
    console.warn(
      `[pushpals] Requested sessionId=${sessionId}, but LocalBuddy is currently attached to sessionId=${localBuddySessionId}.`,
    );
  }

  const statePath = resolve(repoRoot, ".git", "pushpals-cli-state.json");
  const saved = readCliState(statePath);
  const preferredHubUrl = normalizeUrl(
    parsed.monitoringHubUrl ??
      process.env.PUSHPALS_MONITOR_URL ??
      saved.monitoringHubUrl ??
      "",
  );
  const monitorPort = parsePositiveInt(process.env.PUSHPALS_CLIENT_PORT, DEFAULT_MONITOR_PORT);
  const monitoringHubUrl = await resolveMonitoringHubUrl(preferredHubUrl, monitorPort);

  writeCliState(statePath, {
    monitoringHubUrl,
    serverUrl,
    localAgentUrl,
    sessionId: localBuddySessionId,
    repoRoot,
  });

  console.log("[pushpals] Connected.");
  console.log(`monitoringHubUrl=${monitoringHubUrl}`);
  console.log(`serverUrl=${serverUrl}`);
  console.log(`localAgentUrl=${localAgentUrl}`);
  console.log(`sessionId=${localBuddySessionId}`);
  console.log(`repoRoot=${repoRoot}`);
  console.log(`cliStateFile=${statePath}`);
  console.log("[pushpals] Type a message and press Enter. Use /exit to quit.");

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
    : runSessionStream(
        serverUrl,
        localBuddySessionId,
        authToken,
        printIncoming,
        streamAbort.signal,
      );

  let shuttingDown = false;
  const requestStop = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    streamAbort.abort();
    if (rl) rl.close();
  };

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

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
    if (text === "/exit" || text === "/quit") {
      requestStop();
      break;
    }
    if (text === "/hub") {
      console.log(`monitoringHubUrl=${monitoringHubUrl}`);
      rl.prompt();
      continue;
    }
    if (text === "/status") {
      console.log(`serverUrl=${serverUrl}`);
      console.log(`localAgentUrl=${localAgentUrl}`);
      console.log(`sessionId=${sessionId}`);
      console.log(`repoRoot=${repoRoot}`);
      console.log(`monitoringHubUrl=${monitoringHubUrl}`);
      rl.prompt();
      continue;
    }
    if (text === "/open") {
      const opened = await openMonitoringHub(monitoringHubUrl);
      console.log(
        opened
          ? `[pushpals] Opened ${monitoringHubUrl}`
          : `[pushpals] Failed to open browser. Use this link: ${monitoringHubUrl}`,
      );
      rl.prompt();
      continue;
    }

    const ok = await sendMessageToLocalBuddy(localAgentUrl, text);
    if (!ok) {
      console.log("[pushpals] Message failed.");
    }
    rl.prompt();
  }

  requestStop();
  await Promise.race([streamTask, Bun.sleep(2_000)]);
}

main().catch((err) => {
  console.error(`[pushpals] Fatal: ${String(err)}`);
  process.exit(1);
});
