type RuntimeBootstrapPayload = {
  serverUrl?: string;
  localAgentUrl?: string;
  sessionId?: string;
  authToken?: string | null;
};

export type PushPalsWebRuntimeConfig = {
  serverUrl: string;
  localAgentUrl: string;
  sessionId: string;
  authToken: string | null;
};

declare global {
  var __PUSHPALS_WEB_BOOTSTRAP__: RuntimeBootstrapPayload | undefined;
}

function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeUrl(value: unknown, fallback: string): string {
  const text = normalizeString(value) || fallback;
  return text.replace(/\/+$/, "");
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
  const env = typeof process !== "undefined" ? process.env : {};
  const sessionId =
    normalizeString(payload.sessionId) ||
    normalizeString(env.EXPO_PUBLIC_PUSHPALS_SESSION_ID) ||
    "dev";
  const authToken =
    normalizeString(payload.authToken) ||
    normalizeString(env.EXPO_PUBLIC_PUSHPALS_AUTH_TOKEN) ||
    "";

  return {
    serverUrl: normalizeUrl(
      payload.serverUrl || env.EXPO_PUBLIC_PUSHPALS_URL,
      "http://localhost:3001",
    ),
    localAgentUrl: normalizeUrl(
      payload.localAgentUrl || env.EXPO_PUBLIC_LOCAL_AGENT_URL,
      "http://localhost:3003",
    ),
    sessionId,
    authToken: authToken || null,
  };
}
