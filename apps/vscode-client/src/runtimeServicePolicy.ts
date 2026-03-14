import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type LocalBuddyRuntimeAction = "start" | "stop" | "noop";
export type LocalBuddyStartGateReason = "ready" | "backoff" | "retry_exhausted";

export type RuntimeConfigSnapshot = {
  localbuddy: {
    enabled: boolean;
    port: number;
  };
};

export const DEFAULT_LOCALBUDDY_PORT = 3003;

const DEFAULT_CONFIG_DIR = "configs";
const LEGACY_CONFIG_DIR = "config";
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

type LocalBuddyTomlSlice = {
  profile?: string;
  localbuddy?: {
    enabled?: boolean;
    port?: number;
  };
};

export function parseRuntimeConfigSnapshot(raw: string): RuntimeConfigSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("runtime config snapshot was not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("runtime config snapshot must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  const localbuddyValue = record.localbuddy;
  if (!localbuddyValue || typeof localbuddyValue !== "object" || Array.isArray(localbuddyValue)) {
    throw new Error("runtime config snapshot must include localbuddy");
  }

  const localbuddy = localbuddyValue as Record<string, unknown>;
  const enabled = Boolean(localbuddy.enabled);
  const port = Number.parseInt(String(localbuddy.port ?? DEFAULT_LOCALBUDDY_PORT), 10);

  return {
    localbuddy: {
      enabled,
      port:
        Number.isFinite(port) && port >= 1 && port <= 65_535
          ? port
          : DEFAULT_LOCALBUDDY_PORT,
    },
  };
}

export function loadRuntimeConfigSnapshotFromFiles(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
): RuntimeConfigSnapshot {
  const envFileValues = readEnvFile(resolve(workspaceRoot, ".env"));
  const mergedEnv: Record<string, string | undefined> = {
    ...env,
    ...envFileValues,
  };

  const configDirOverride = firstNonEmpty(mergedEnv.PUSHPALS_CONFIG_DIR_OVERRIDE);
  const configDir = resolveRuntimeConfigDir(workspaceRoot, configDirOverride);
  const legacyConfigDir = resolvePathFromRoot(workspaceRoot, LEGACY_CONFIG_DIR);
  const fallbackConfigDir =
    !configDirOverride && configDir !== legacyConfigDir ? legacyConfigDir : "";

  const defaultToml = readTomlSliceWithFallback(
    join(configDir, "default.toml"),
    fallbackConfigDir ? join(fallbackConfigDir, "default.toml") : undefined,
  );
  const preferredProfile = firstNonEmpty(mergedEnv.PUSHPALS_PROFILE, defaultToml.profile, "dev");
  const profileToml = readTomlSliceWithFallback(
    join(configDir, `${preferredProfile}.toml`),
    fallbackConfigDir ? join(fallbackConfigDir, `${preferredProfile}.toml`) : undefined,
  );
  const localExampleToml = readTomlSliceWithFallback(
    join(configDir, "local.example.toml"),
    fallbackConfigDir ? join(fallbackConfigDir, "local.example.toml") : undefined,
  );
  const localToml = readTomlSliceWithFallback(
    join(configDir, "local.toml"),
    fallbackConfigDir ? join(fallbackConfigDir, "local.toml") : undefined,
  );

  const mergedLocalbuddy = {
    ...defaultToml.localbuddy,
    ...profileToml.localbuddy,
    ...localExampleToml.localbuddy,
    ...localToml.localbuddy,
  };

  const enabled = parseBoolEnv(mergedEnv.LOCALBUDDY_ENABLED) ?? mergedLocalbuddy.enabled ?? false;
  const port =
    parseIntEnv(mergedEnv.LOCAL_AGENT_PORT) ?? mergedLocalbuddy.port ?? DEFAULT_LOCALBUDDY_PORT;

  return {
    localbuddy: {
      enabled,
      port:
        Number.isFinite(port) && port >= 1 && port <= 65_535
          ? Math.floor(port)
          : DEFAULT_LOCALBUDDY_PORT,
    },
  };
}

export function resolveLocalBuddyRuntimeAction(
  running: boolean,
  enabled: boolean,
): LocalBuddyRuntimeAction {
  if (enabled && !running) return "start";
  if (!enabled && running) return "stop";
  return "noop";
}

export function computeLocalBuddyRestartBackoffMs(
  consecutiveFailures: number,
  baseMs = 5_000,
  maxMs = 60_000,
): number {
  const safeFailures = Math.max(1, Math.floor(consecutiveFailures));
  const multiplier = 2 ** Math.max(0, safeFailures - 1);
  return Math.min(maxMs, baseMs * multiplier);
}

export function resolveLocalBuddyStartGate(args: {
  nowMs: number;
  retryAfterMs: number;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
}): LocalBuddyStartGateReason {
  if (args.consecutiveFailures >= args.maxConsecutiveFailures) {
    return "retry_exhausted";
  }
  if (args.retryAfterMs > args.nowMs) {
    return "backoff";
  }
  return "ready";
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function resolvePathFromRoot(workspaceRoot: string, value: string): string {
  if (!value) return workspaceRoot;
  if (isAbsolute(value)) return resolve(value);
  return resolve(workspaceRoot, value);
}

function resolveRuntimeConfigDir(workspaceRoot: string, configuredDir?: string): string {
  if (configuredDir && configuredDir.trim()) {
    return resolvePathFromRoot(workspaceRoot, configuredDir);
  }

  const canonicalDir = resolvePathFromRoot(workspaceRoot, DEFAULT_CONFIG_DIR);
  const legacyDir = resolvePathFromRoot(workspaceRoot, LEGACY_CONFIG_DIR);
  if (existsSync(join(canonicalDir, "default.toml"))) return canonicalDir;
  if (existsSync(join(legacyDir, "default.toml"))) return legacyDir;
  return canonicalDir;
}

function parseBoolEnv(value: string | undefined): boolean | undefined {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return undefined;
  if (TRUTHY.has(text)) return true;
  if (FALSY.has(text)) return false;
  return undefined;
}

function parseIntEnv(value: string | undefined): number | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readTomlSliceWithFallback(primaryPath: string, fallbackPath?: string): LocalBuddyTomlSlice {
  if (existsSync(primaryPath)) return parseTomlSlice(primaryPath);
  if (fallbackPath && existsSync(fallbackPath)) return parseTomlSlice(fallbackPath);
  return {};
}

function parseTomlSlice(path: string): LocalBuddyTomlSlice {
  const text = readFileSync(path, "utf8");
  const result: LocalBuddyTomlSlice = {};
  let currentSection = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = String(sectionMatch[1] ?? "").trim();
      continue;
    }

    const entryMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!entryMatch) continue;

    const key = String(entryMatch[1] ?? "").trim();
    const value = parseTomlScalar(String(entryMatch[2] ?? "").trim());

    if (!currentSection && key === "profile" && typeof value === "string") {
      result.profile = value;
      continue;
    }

    if (currentSection !== "localbuddy") continue;
    if (key === "enabled" && typeof value === "boolean") {
      result.localbuddy = { ...(result.localbuddy ?? {}), enabled: value };
    } else if (key === "port" && typeof value === "number") {
      result.localbuddy = { ...(result.localbuddy ?? {}), port: value };
    }
  }

  return result;
}

function stripTomlComment(line: string): string {
  let inQuote = false;
  let quoteChar = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if ((char === '"' || char === "'") && (i === 0 || line[i - 1] !== "\\")) {
      if (!inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (quoteChar === char) {
        inQuote = false;
        quoteChar = "";
      }
      continue;
    }
    if (char === "#" && !inQuote) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlScalar(value: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const quoted = trimmed.match(/^"(.*)"$/) ?? trimmed.match(/^'(.*)'$/);
  if (quoted) {
    return quoted[1] ?? "";
  }
  return trimmed;
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const parsed = parseEnvAssignment(rawLine);
    if (!parsed) continue;
    values[parsed.key] = parsed.value;
  }
  return values;
}

function parseEnvAssignment(line: string): { key: string; value: string } | null {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match) return null;
  return {
    key: match[1],
    value: parseEnvValue(match[2] ?? ""),
  };
}

function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("#")) return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  let inQuote = false;
  let quoteChar = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if ((char === '"' || char === "'") && (i === 0 || trimmed[i - 1] !== "\\")) {
      if (!inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (quoteChar === char) {
        inQuote = false;
        quoteChar = "";
      }
      continue;
    }
    if (char === "#" && !inQuote) {
      return trimmed.slice(0, i).trimEnd();
    }
  }
  return trimmed;
}
