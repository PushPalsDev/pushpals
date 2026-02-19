export interface PlannerPathHints {
  scope: {
    write_globs?: string[];
  };
  discovery?: {
    likely_dirs?: string[];
  };
}

const MAX_TARGET_PATH_HINTS = 8;

function collapseGlobToPathHint(value: string): string {
  let normalized = value.trim().replace(/\\/g, "/");
  const wildcardIndex = normalized.search(/[*?\[]/);
  if (wildcardIndex >= 0) {
    normalized = normalized.slice(0, wildcardIndex);
  }
  return normalized.replace(/\/+$/, "");
}

export function normalizeRepoPathHint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (!path) return null;
  path = path.replace(/\\/g, "/");

  if (path === "/repo" || path === "/workspace") return ".";
  if (path.startsWith("/repo/")) path = path.slice("/repo/".length);
  else if (path.startsWith("/workspace/")) path = path.slice("/workspace/".length);
  else if (path.startsWith("/")) return null;

  if (/^[A-Za-z]:[\\/]/.test(path)) return null;

  path = path
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
  if (!path || path === ".") return ".";
  if (path.startsWith(":(")) return null;

  const segments = path.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return null;
  }

  return path;
}

export function extractExplicitTargetPath(text: string): string | null {
  const stopWords = new Set(["a", "an", "the", "it", "this", "that", "there", "here", "file"]);
  const patterns = [
    /file\s+(?:called|named)\s+["'`]?([^"'`\s]+)["'`]?/i,
    /create\s+(?:a\s+)?file\s+["'`]?([^"'`\s]+)["'`]?/i,
    /write\s+(?:to|into)\s+["'`]?([^"'`\s]+)["'`]?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = (match[1] ?? "").trim().replace(/[.,!?;:]+$/, "");
    if (!value) continue;
    if (!/^[A-Za-z0-9._/\-\\]+$/.test(value)) continue;
    if (stopWords.has(value.toLowerCase())) continue;
    const normalized = normalizeRepoPathHint(value);
    if (normalized) return normalized;
  }
  return null;
}

function extractQuotedPathHints(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/["'`]([^"'`\r\n]+)["'`]/g)) {
    const candidate = (match[1] ?? "").trim().replace(/[.,!?;:]+$/, "");
    if (!candidate || candidate.length > 220) continue;
    if (candidate.includes("://")) continue;
    if (!(candidate.includes("/") || candidate.includes("\\") || candidate.includes("."))) continue;
    out.push(candidate);
    if (out.length >= MAX_TARGET_PATH_HINTS) break;
  }
  return out;
}

function extractTokenPathHints(text: string): string[] {
  const out: string[] = [];
  const tokenRegex = /\b([A-Za-z0-9._/\-\\]+\.[A-Za-z0-9._-]+)\b/g;
  for (const match of text.matchAll(tokenRegex)) {
    const candidate = (match[1] ?? "").trim().replace(/[.,!?;:]+$/, "");
    if (!candidate) continue;
    if (candidate.includes("://")) continue;
    out.push(candidate);
    if (out.length >= MAX_TARGET_PATH_HINTS) break;
  }
  return out;
}

export function normalizePathHints(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const collapsed = collapseGlobToPathHint(String(raw ?? ""));
    const value = normalizeRepoPathHint(collapsed);
    if (!value) continue;
    if (value === ".") return ["."];
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_TARGET_PATH_HINTS) break;
  }
  return out;
}

export function plannerTargetPaths(plan: PlannerPathHints, prompt: string): string[] {
  const explicit = extractExplicitTargetPath(prompt);
  const pathHints = normalizePathHints([
    ...(explicit ? [explicit] : []),
    ...extractTokenPathHints(prompt),
    ...extractQuotedPathHints(prompt),
    ...(plan.scope.write_globs ?? []),
    ...(plan.discovery?.likely_dirs ?? []),
  ]);
  return pathHints.length > 0 ? pathHints : ["."];
}
