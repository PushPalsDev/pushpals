import type { RepositoryTextExcerpt } from "./repository_evidence.js";

export const FOLLOWUP_LIMITS = Object.freeze({
  windows: 4,
  queries: 2,
  bytes: 16_384,
  scanPaths: 128,
  timeoutMs: 5_000,
  synthesisReserveMs: 20_000,
});
export type EvidenceFollowupRequest = {
  windows: Array<{ path: string; startLine: number; endLine: number }>;
  literalQueries: string[];
};

/** A proposal is data, never a shell command, revision, regular expression, or pathspec. */
export function safeFollowupPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 1_000 ||
    !value ||
    /[\\\u0000-\u001f:*?\[\]]/.test(value)
  )
    return false;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("-")))
    return false;
  return !parts.some((part) =>
    /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(
      part,
    ),
  );
}

export function parseEvidenceFollowup(value: unknown): EvidenceFollowupRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "windows" && key !== "literalQueries")) return null;
  if (
    !Array.isArray(raw.windows) ||
    !Array.isArray(raw.literalQueries) ||
    raw.windows.length > FOLLOWUP_LIMITS.windows ||
    raw.literalQueries.length > FOLLOWUP_LIMITS.queries
  )
    return null;
  const windows: EvidenceFollowupRequest["windows"] = [];
  for (const item of raw.windows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (
      Object.keys(row).some((key) => !["path", "startLine", "endLine"].includes(key)) ||
      !safeFollowupPath(row.path) ||
      !Number.isInteger(row.startLine) ||
      !Number.isInteger(row.endLine)
    )
      return null;
    const startLine = row.startLine as number;
    const endLine = row.endLine as number;
    if (startLine < 1 || endLine < startLine || endLine > 20_000 || endLine - startLine >= 200)
      return null;
    windows.push({ path: row.path, startLine, endLine });
  }
  const literalQueries: string[] = [];
  for (const query of raw.literalQueries) {
    if (
      typeof query !== "string" ||
      query.length < 3 ||
      query.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(query) ||
      !query.trim()
    )
      return null;
    literalQueries.push(query);
  }
  return windows.length || literalQueries.length ? { windows, literalQueries } : null;
}

/** Keep only complete original lines; never invent coordinates for clipped UTF-8. */
export function followupWindow(
  text: string,
  scanTruncated: boolean,
  startLine: number,
  endLine: number,
  maxBytes: number,
): RepositoryTextExcerpt {
  const lines = text.split(/\r?\n/);
  const complete = scanTruncated ? lines.length - 1 : lines.length;
  const accepted: string[] = [];
  let bytes = 0;
  for (let line = startLine; line <= Math.min(endLine, complete); line++) {
    const next = lines[line - 1]!;
    const cost = Buffer.byteLength(next, "utf8") + (accepted.length ? 1 : 0);
    if (bytes + cost > maxBytes) break;
    accepted.push(next);
    bytes += cost;
  }
  return {
    content: accepted.join("\n"),
    truncated: scanTruncated || startLine > 1 || startLine + accepted.length - 1 < complete,
    scanTruncated,
    lineRanges: accepted.length ? [{ startLine, endLine: startLine + accepted.length - 1 }] : [],
  };
}
