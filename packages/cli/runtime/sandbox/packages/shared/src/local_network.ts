const DEFAULT_LOCAL_LOOPBACK_HOST = "127.0.0.1";

export function isLoopbackHost(hostname: string): boolean {
  const normalized = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function normalizeLoopbackHost(hostname: string | null | undefined): string {
  const normalized = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (isLoopbackHost(normalized)) return DEFAULT_LOCAL_LOOPBACK_HOST;
  return DEFAULT_LOCAL_LOOPBACK_HOST;
}

export function isLoopbackOrigin(origin: string | null | undefined): boolean {
  const text = String(origin ?? "").trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function buildLocalCorsHeaders(options: {
  origin: string | null | undefined;
  allowAuthorizationHeader?: boolean;
  additionalAllowedHeaders?: string[];
}): Record<string, string> {
  const allowedHeaders = [
    "content-type",
    ...(options.allowAuthorizationHeader ? ["authorization"] : []),
    ...(options.additionalAllowedHeaders ?? [])
      .map((header) =>
        String(header ?? "")
          .trim()
          .toLowerCase(),
      )
      .filter((header) => /^[a-z0-9-]+$/.test(header)),
  ];
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": [...new Set(allowedHeaders)].join(", "),
  };
  const origin = String(options.origin ?? "").trim();
  if (isLoopbackOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

export function normalizeLoopbackHttpUrl(
  value: string | null | undefined,
  fallbackPort: number,
): string {
  const fallback = `http://${DEFAULT_LOCAL_LOOPBACK_HOST}:${Math.max(1, fallbackPort)}`;
  const text = String(value ?? "").trim();
  if (!text) return fallback;

  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }
    parsed.protocol = "http:";
    parsed.username = "";
    parsed.password = "";
    parsed.hostname = normalizeLoopbackHost(parsed.hostname);
    // Force server endpoints to the local root path in local-only mode.
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    if (!parsed.port) {
      parsed.port = String(Math.max(1, fallbackPort));
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

export function resolveLocalServerConnection(options: {
  serverUrl: string | null | undefined;
  authToken: string | null | undefined;
  fallbackPort: number;
}): {
  serverUrl: string;
  authToken: null;
  serverWasNormalized: boolean;
  authTokenWasIgnored: boolean;
} {
  const rawServer = String(options.serverUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  const normalizedServer = normalizeLoopbackHttpUrl(rawServer, options.fallbackPort);
  const authToken = String(options.authToken ?? "").trim();
  return {
    serverUrl: normalizedServer,
    authToken: null,
    serverWasNormalized: !!rawServer && normalizedServer !== rawServer,
    authTokenWasIgnored: authToken.length > 0,
  };
}
