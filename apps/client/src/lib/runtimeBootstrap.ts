type RuntimeBootstrapPayload = {
  serverUrl?: string;
  sessionId?: string;
  clientId?: string;
  clientKind?: string;
  clientLabel?: string;
};

export type PushPalsWebRuntimeConfig = {
  serverUrl: string;
  sessionId: string;
  clientId: string | null;
  clientKind: string;
  clientLabel: string;
};

declare global {
  var __PUSHPALS_WEB_BOOTSTRAP__: RuntimeBootstrapPayload | undefined;
}

function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeLocalUrl(value: unknown, fallback: string): string {
  const text = normalizeString(value) || fallback;
  try {
    const parsed = new URL(text);
    parsed.protocol = "http:";
    parsed.username = "";
    parsed.password = "";
    parsed.hostname = "127.0.0.1";
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return fallback.replace(/\/+$/, "");
  }
}

function readBootstrapPayload(): RuntimeBootstrapPayload {
  const payload = globalThis.__PUSHPALS_WEB_BOOTSTRAP__;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload;
}

export function resolvePushPalsWebRuntimeConfig(): PushPalsWebRuntimeConfig {
  const payload = readBootstrapPayload();
  const env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {};
  const sessionId =
    normalizeString(payload.sessionId) ||
    normalizeString(env.EXPO_PUBLIC_PUSHPALS_SESSION_ID) ||
    "dev";
  const clientId = normalizeString(payload.clientId) || "";

  return {
    serverUrl: normalizeLocalUrl(
      payload.serverUrl || env.EXPO_PUBLIC_PUSHPALS_URL,
      "http://127.0.0.1:3001",
    ),
    sessionId,
    clientId: clientId || null,
    clientKind: normalizeString(payload.clientKind) || "web",
    clientLabel: normalizeString(payload.clientLabel) || "Web Client",
  };
}
