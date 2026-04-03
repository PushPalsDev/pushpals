import { loadPushPalsConfig } from "shared";

const DEFAULT_CONFIG = loadPushPalsConfig();

export interface OutputCompactionPolicy {
  maxOutputChars: number;
  maxOutputLines: number;
  maxOutputHeadLines: number;
  executorResultPrefix: string;
}

export function resolveOutputCompactionPolicy(
  overrides: Partial<OutputCompactionPolicy> = {},
): OutputCompactionPolicy {
  const worker = DEFAULT_CONFIG.workerpals;
  const maxOutputChars = Number(overrides.maxOutputChars ?? worker.outputMaxChars);
  const maxOutputLines = Number(overrides.maxOutputLines ?? worker.outputMaxLines);
  const maxOutputHeadLines = Number(overrides.maxOutputHeadLines ?? worker.outputMaxHeadLines);
  const executorResultPrefixRaw = overrides.executorResultPrefix ?? worker.executorResultPrefix;
  const executorResultPrefix =
    typeof executorResultPrefixRaw === "string" && executorResultPrefixRaw.length > 0
      ? executorResultPrefixRaw
      : "__PUSHPALS_OH_RESULT__ ";

  return {
    maxOutputChars:
      Number.isFinite(maxOutputChars) && maxOutputChars >= 8_192
        ? Math.min(Math.floor(maxOutputChars), 4_194_304)
        : 192 * 1024,
    maxOutputLines:
      Number.isFinite(maxOutputLines) && maxOutputLines >= 50
        ? Math.min(Math.floor(maxOutputLines), 20_000)
        : 600,
    maxOutputHeadLines:
      Number.isFinite(maxOutputHeadLines) && maxOutputHeadLines >= 1
        ? Math.max(1, Math.min(Math.floor(maxOutputHeadLines), Math.floor(maxOutputLines) || 600))
        : 120,
    executorResultPrefix,
  };
}

// ---- Output truncation -------------------------------------------------------

export function compactJobOutput(
  text: string,
  policyOverrides: Partial<OutputCompactionPolicy> = {},
): string {
  if (!text) return "";
  const policy = resolveOutputCompactionPolicy(policyOverrides);
  const maxOutputChars = policy.maxOutputChars;
  const maxOutputLines = policy.maxOutputLines;
  const maxOutputHeadLines = Math.min(policy.maxOutputHeadLines, maxOutputLines);
  let compact = text;
  const lines = compact.split(/\r?\n/);
  if (lines.length > maxOutputLines) {
    const headCount = Math.min(maxOutputHeadLines, maxOutputLines, lines.length);
    const tailBudget = Math.max(0, maxOutputLines - headCount);
    const tailCount = Math.max(0, Math.min(lines.length - headCount, tailBudget));
    const omitted = Math.max(0, lines.length - headCount - tailCount);
    const marker = omitted > 0 ? [`... (${omitted} lines omitted) ...`] : [];
    const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : [];
    compact = [...lines.slice(0, headCount), ...marker, ...tail].join("\n");
  }
  if (compact.length > maxOutputChars) {
    const markerPrefix = "... (";
    const markerSuffix = " chars omitted) ...\n";
    const markerBudget = markerPrefix.length + markerSuffix.length + 20;
    if (markerBudget >= maxOutputChars) {
      compact = compact.slice(-maxOutputChars);
    } else {
      const keepChars = Math.max(0, maxOutputChars - markerBudget);
      const omittedChars = Math.max(0, compact.length - keepChars);
      const marker = `${markerPrefix}${omittedChars}${markerSuffix}`;
      const tail = keepChars > 0 ? compact.slice(-keepChars) : "";
      compact = `${marker}${tail}`;
    }
  }
  return compact;
}

export function truncate(s: string, policyOverrides: Partial<OutputCompactionPolicy> = {}): string {
  return compactJobOutput(s, policyOverrides);
}

// ---- Stream helper -----------------------------------------------------------

export async function streamLines(
  readable: ReadableStream<Uint8Array>,
  streamName: "stdout" | "stderr",
  onLine: (stream: "stdout" | "stderr", line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = readable.getReader();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    buffer += chunk;

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      onLine(streamName, clean);
    }
  }

  if (buffer.length > 0) {
    const clean = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    onLine(streamName, clean);
  }

  return full;
}

// ---- Structured result parsing -----------------------------------------------

export function parseStructuredResult(
  stdout: string,
  executorResultPrefix = resolveOutputCompactionPolicy().executorResultPrefix,
): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith(executorResultPrefix)) continue;
    const raw = line.slice(executorResultPrefix.length).trim();
    if (!raw) continue;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

export function filterResultLines(
  stdout: string,
  executorResultPrefix = resolveOutputCompactionPolicy().executorResultPrefix,
): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(executorResultPrefix))
    .join("\n")
    .trim();
}
