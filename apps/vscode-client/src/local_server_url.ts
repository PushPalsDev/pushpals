function normalizeLoopbackUrl(value: string, fallbackPort = 3001): string {
  const fallback = `http://127.0.0.1:${Math.max(1, fallbackPort)}`;
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
    parsed.hostname = "127.0.0.1";
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

export function normalizeVscodeServerUrl(value: string | null | undefined): string {
  return normalizeLoopbackUrl(String(value ?? "").trim(), 3001);
}
