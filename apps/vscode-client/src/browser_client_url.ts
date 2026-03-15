import { existsSync, readFileSync } from "node:fs";
import { resolveWorkspaceGitStateFilePath } from "./repo";

const DEFAULT_CLIENT_PORT = 8081;
const DEFAULT_MAX_SCAN = 200;
const PROBE_TIMEOUT_MS = 200;
const PROBE_CHUNK_SIZE = 20;
const STATE_FILE_NAME = "pushpals-client-state.json";

function parsePositiveInt(value: string | null | undefined): number | null {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function resolveBrowserClientPortBase(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    parsePositiveInt(env.EXPO_DEV_SERVER_PORT) ??
    parsePositiveInt(env.PUSHPALS_CLIENT_PORT) ??
    DEFAULT_CLIENT_PORT
  );
}

export function buildBrowserClientPortCandidates(
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  const basePort = resolveBrowserClientPortBase(env);
  const maxScan = parsePositiveInt(env.PUSHPALS_CLIENT_PORT_SCAN_MAX) ?? DEFAULT_MAX_SCAN;
  const candidates: number[] = [];
  for (let port = basePort; port < basePort + maxScan; port++) {
    candidates.push(port);
  }
  return candidates;
}

export function buildBrowserClientUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function looksLikePushPalsWebClient(body: string): boolean {
  const text = String(body ?? "").toLowerCase();
  return (
    text.includes("pushpals") ||
    text.includes("_expo/") ||
    text.includes("expo-router") ||
    text.includes("react-native-web")
  );
}

export async function resolveBrowserClientUrl(
  env: NodeJS.ProcessEnv = process.env,
  workspaceRoot?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const candidates = buildBrowserClientPortCandidates(env);
  const fallback = buildBrowserClientUrl(resolveBrowserClientPortBase(env));
  const stateUrl = readBrowserClientStateUrl(workspaceRoot);
  if (stateUrl && (await probePushPalsClientUrl(stateUrl, fetchImpl))) {
    return stateUrl;
  }
  if (candidates.length === 0) return fallback;

  for (let i = 0; i < candidates.length; i += PROBE_CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + PROBE_CHUNK_SIZE);
    const checks = await Promise.all(
      chunk.map(async (port) => ({
        port,
        ok: await probePushPalsClientUrl(buildBrowserClientUrl(port), fetchImpl),
      })),
    );
    const match = checks.find((entry) => entry.ok);
    if (match) return buildBrowserClientUrl(match.port);
  }

  return fallback;
}

function readBrowserClientStateUrl(workspaceRoot?: string): string | null {
  const root = String(workspaceRoot ?? "").trim();
  if (!root) return null;
  const statePath = resolveWorkspaceGitStateFilePath(root, STATE_FILE_NAME);
  if (!statePath || !existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
      port?: unknown;
      url?: unknown;
    };
    const normalizedUrl = normalizeLoopbackUrl(parsed.url);
    if (normalizedUrl) return normalizedUrl;
    const fallbackPort = parsePositiveInt(String(parsed.port ?? ""));
    if (!fallbackPort) return null;
    return buildBrowserClientUrl(fallbackPort);
  } catch {
    return null;
  }
}

function normalizeLoopbackUrl(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
      return null;
    }
    const port = parsePositiveInt(parsed.port) ?? DEFAULT_CLIENT_PORT;
    return buildBrowserClientUrl(port);
  } catch {
    return null;
  }
}

async function probePushPalsClientUrl(
  url: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/html")) return false;
    const body = await response.text();
    return looksLikePushPalsWebClient(body);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
