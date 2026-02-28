import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import type { PushPalsConfig } from "shared";

export type RuntimeConfigScope = "env" | "toml";

export interface RuntimeConfigMutation {
  scope: RuntimeConfigScope;
  key: string;
  value: unknown;
}

export interface RuntimeConfigFiles {
  envPath: string;
  localTomlPath: string;
  projectRoot: string;
}

export interface RuntimeConfigApplyResult {
  applied: RuntimeConfigMutation[];
  warnings: string[];
  touchedFiles: string[];
}

export function getRuntimeConfigFiles(config: PushPalsConfig): RuntimeConfigFiles {
  return {
    envPath: join(config.projectRoot, ".env"),
    localTomlPath: join(config.configDir, "local.toml"),
    projectRoot: config.projectRoot,
  };
}

export function applyRuntimeConfigMutations(
  files: RuntimeConfigFiles,
  inputMutations: RuntimeConfigMutation[],
): RuntimeConfigApplyResult {
  const warnings: string[] = [];
  const applied: RuntimeConfigMutation[] = [];
  const touchedFiles = new Set<string>();

  const envChanges: Array<{ key: string; value: unknown }> = [];
  const tomlChanges: Array<{ path: string[]; value: unknown; rawKey: string }> = [];

  for (const mutation of inputMutations) {
    const scope = String(mutation.scope ?? "").trim().toLowerCase();
    if (scope !== "env" && scope !== "toml") {
      warnings.push(`Skipped unknown scope "${mutation.scope}"`);
      continue;
    }
    const rawKey = String(mutation.key ?? "").trim();
    if (!rawKey) {
      warnings.push(`Skipped empty key in ${scope} mutation`);
      continue;
    }

    if (scope === "env") {
      const envKey = normalizeEnvKey(rawKey);
      if (!envKey) {
        warnings.push(`Skipped invalid env key "${rawKey}"`);
        continue;
      }
      envChanges.push({ key: envKey, value: mutation.value });
      applied.push({ scope: "env", key: envKey, value: mutation.value });
      continue;
    }

    const path = normalizeTomlPath(rawKey);
    if (path.length === 0) {
      warnings.push(`Skipped invalid TOML key "${rawKey}"`);
      continue;
    }
    tomlChanges.push({ path, value: mutation.value, rawKey });
    applied.push({ scope: "toml", key: path.join("."), value: mutation.value });
  }

  if (envChanges.length > 0) {
    patchEnvFile(files.envPath, envChanges);
    for (const change of envChanges) {
      process.env[change.key] = String(change.value ?? "");
    }
    touchedFiles.add(files.envPath);
  }

  if (tomlChanges.length > 0) {
    patchTomlFile(files.localTomlPath, tomlChanges.map((entry) => ({ path: entry.path, value: entry.value })));
    touchedFiles.add(files.localTomlPath);
  }

  return {
    applied,
    warnings,
    touchedFiles: Array.from(touchedFiles),
  };
}

export function describeRuntimeConfigFiles(files: RuntimeConfigFiles): {
  envPath: string;
  localTomlPath: string;
} {
  return {
    envPath: normalizePathForDisplay(files.projectRoot, files.envPath),
    localTomlPath: normalizePathForDisplay(files.projectRoot, files.localTomlPath),
  };
}

function normalizePathForDisplay(projectRoot: string, absolutePath: string): string {
  const rel = relative(projectRoot, absolutePath);
  if (!rel || rel.startsWith("..")) return absolutePath;
  return rel.replace(/\\/g, "/");
}

function normalizeEnvKey(rawKey: string): string {
  const key = rawKey.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return "";
  return key;
}

function normalizeTomlPath(rawKey: string): string[] {
  const pieces = rawKey
    .split(".")
    .map((part) => normalizeTomlKey(part))
    .filter(Boolean);
  return pieces;
}

function normalizeTomlKey(rawKey: string): string {
  const trimmed = String(rawKey ?? "").trim();
  if (!trimmed) return "";
  if (/^[a-z0-9_]+$/.test(trimmed)) return trimmed;
  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function patchEnvFile(path: string, changes: Array<{ key: string; value: unknown }>): void {
  ensureParentDir(path);
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const eol = detectEol(original);
  const lines = original.length > 0 ? original.split(/\r?\n/) : [];
  const indexByKey = new Map<string, number>();

  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseEnvAssignment(lines[i] ?? "");
    if (parsed) indexByKey.set(parsed.key, i);
  }

  for (const change of changes) {
    const nextLine = `${change.key}=${serializeEnvValue(change.value)}`;
    const index = indexByKey.get(change.key);
    if (index === undefined) {
      lines.push(nextLine);
      indexByKey.set(change.key, lines.length - 1);
    } else {
      lines[index] = nextLine;
    }
  }

  const nextText = lines.join(eol).replace(/\s+$/g, "");
  writeFileSync(path, `${nextText}${eol}`, "utf8");
}

function parseEnvAssignment(line: string): { key: string; value: string } | null {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) return null;
  return { key: match[1], value: match[2] ?? "" };
}

function serializeEnvValue(value: unknown): string {
  const text = String(value ?? "");
  if (text.length === 0) return "";
  if (/^[^\s"'`#=\\]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function patchTomlFile(
  path: string,
  changes: Array<{ path: string[]; value: unknown }>,
): void {
  ensureParentDir(path);
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const eol = detectEol(original);
  const lines = original.length > 0 ? original.split(/\r?\n/) : [];

  for (const change of changes) {
    setTomlValue(lines, change.path, change.value);
  }

  const nextText = lines.join(eol).replace(/\s+$/g, "");
  writeFileSync(path, `${nextText}${eol}`, "utf8");
}

function setTomlValue(lines: string[], path: string[], value: unknown): void {
  const key = path[path.length - 1];
  if (!key) return;
  const sectionParts = path.slice(0, -1);
  const sectionName = sectionParts.join(".");
  const serialized = `${key} = ${serializeTomlValue(value)}`;

  if (!sectionName) {
    const sectionStart = findFirstSectionLine(lines);
    const existing = findKeyInRange(lines, key, 0, sectionStart);
    if (existing >= 0) {
      lines[existing] = serialized;
      return;
    }
    if (sectionStart >= 0) {
      lines.splice(sectionStart, 0, serialized);
    } else {
      lines.push(serialized);
    }
    return;
  }

  const range = findSectionRange(lines, sectionName);
  if (range) {
    const existing = findKeyInRange(lines, key, range.start + 1, range.end);
    if (existing >= 0) {
      lines[existing] = serialized;
      return;
    }
    lines.splice(range.end, 0, serialized);
    return;
  }

  if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") {
    lines.push("");
  }
  lines.push(`[${sectionName}]`);
  lines.push(serialized);
}

function findFirstSectionLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i] ?? "")) return i;
  }
  return -1;
}

function findSectionRange(
  lines: string[],
  sectionName: string,
): { start: number; end: number } | null {
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(/^\s*\[([^\]]+)\]\s*$/);
    if (!match) continue;
    const current = String(match[1] ?? "").trim();
    if (start < 0) {
      if (current === sectionName) start = i;
      continue;
    }
    end = i;
    break;
  }
  if (start < 0) return null;
  return { start, end };
}

function findKeyInRange(lines: string[], key: string, start: number, end: number): number {
  for (let i = start; i < Math.min(end, lines.length); i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (match && match[1] === key) return i;
  }
  return -1;
}

function serializeTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value == null) return JSON.stringify("");

  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeTomlValue(entry)).join(", ")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${normalizeTomlKey(key)} = ${serializeTomlValue(entry)}`)
      .join(", ");
    return `{ ${entries} }`;
  }

  return JSON.stringify(String(value));
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}
