import { readFileSync } from "fs";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function collectDotEnvKeys(raw: string): Set<string> {
  const keys = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) continue;
    const key = match[1]?.trim();
    if (key) keys.add(key);
  }
  return keys;
}

function collectTomlLeafKeysFromNode(node: unknown, prefix: string, out: Set<string>): void {
  if (!isObject(node)) return;
  for (const [rawKey, value] of Object.entries(node)) {
    const key = rawKey.trim();
    if (!key) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObject(value)) {
      collectTomlLeafKeysFromNode(value, path, out);
    } else {
      out.add(path);
    }
  }
}

export function collectTomlLeafKeys(raw: string): Set<string> {
  const parsed = Bun.TOML.parse(raw) as unknown;
  const keys = new Set<string>();
  collectTomlLeafKeysFromNode(parsed, "", keys);
  return keys;
}

export function missingTemplateKeys(
  templateKeys: Iterable<string>,
  localKeys: Set<string>,
): string[] {
  const templateSet = new Set(templateKeys);
  const missing: string[] = [];
  for (const key of templateSet) {
    if (!localKeys.has(key)) missing.push(key);
  }
  return missing.sort((a, b) => a.localeCompare(b));
}

export function extraLocalKeys(templateKeys: Iterable<string>, localKeys: Set<string>): string[] {
  const templateSet = new Set(templateKeys);
  const extras: string[] = [];
  for (const key of localKeys) {
    if (!templateSet.has(key)) extras.push(key);
  }
  return extras.sort((a, b) => a.localeCompare(b));
}

export function readDotEnvKeys(filePath: string): Set<string> {
  return collectDotEnvKeys(readFileSync(filePath, "utf8"));
}

export function readTomlLeafKeys(filePath: string): Set<string> {
  return collectTomlLeafKeys(readFileSync(filePath, "utf8"));
}
