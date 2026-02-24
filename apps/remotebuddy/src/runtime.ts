export type RuntimeCliDefaults = {
  server: string;
  sessionId: string | null;
  authToken: string | null;
};

export type RuntimeCliArgs = RuntimeCliDefaults;

const FLAG_SERVER = "--server";
const FLAG_SESSION = "--sessionId";
const FLAG_TOKEN = "--token";

export function parseCliArgs(
  argv: readonly string[],
  defaults: RuntimeCliDefaults,
): RuntimeCliArgs {
  const sanitizedDefaults: RuntimeCliArgs = {
    server: normalizeDefaultServer(defaults.server),
    sessionId: normalizeDefaultOptional(defaults.sessionId),
    authToken: normalizeDefaultOptional(defaults.authToken),
  };

  const result: RuntimeCliArgs = { ...sanitizedDefaults };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === "--") break;
    if (!raw || raw.length === 0) continue;

    if (!raw.startsWith("-")) continue;
    if (raw === "-") continue;

    if (!raw.startsWith("--")) {
      // Skip short flags and their optional values; runtime CLI only supports long flags.
      if (shouldSkipUnknownValue(argv[i + 1])) i++;
      continue;
    }

    let flag = raw;
    let inlineValue: string | undefined;
    const eqIndex = raw.indexOf("=");
    if (eqIndex > 2) {
      flag = raw.slice(0, eqIndex);
      inlineValue = raw.slice(eqIndex + 1);
    }

    const consumeValue = (flagName: string): string => {
      if (inlineValue !== undefined) {
        const value = inlineValue;
        inlineValue = undefined;
        return value;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Missing value for ${flagName}`);
      }
      i++;
      return next;
    };

    switch (flag) {
      case FLAG_SERVER: {
        const value = normalizeCliValue(consumeValue(FLAG_SERVER));
        if (value !== undefined) {
          result.server = value;
        }
        break;
      }
      case FLAG_SESSION: {
        const value = normalizeCliValue(consumeValue(FLAG_SESSION));
        if (value !== undefined) {
          result.sessionId = value;
        }
        break;
      }
      case FLAG_TOKEN: {
        const value = normalizeCliValue(consumeValue(FLAG_TOKEN));
        if (value !== undefined) {
          result.authToken = value;
        }
        break;
      }
      default: {
        if (inlineValue === undefined && shouldSkipUnknownValue(argv[i + 1])) {
          i++;
        }
        break;
      }
    }
  }

  return result;
}

function normalizeDefaultServer(server: string): string {
  if (!server) return "";
  const trimmed = server.trim();
  return trimmed || server;
}

function normalizeDefaultOptional(value: string | null | undefined): string | null {
  const normalized = normalizeCliValue(value);
  return normalized ?? null;
}

function normalizeCliValue(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function shouldSkipUnknownValue(next: string | undefined): boolean {
  if (next === undefined) return false;
  return !next.startsWith("--");
}
