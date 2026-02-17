import {
  EXECUTOR_RESULT_PREFIX,
  MAX_OUTPUT,
  MAX_OUTPUT_HEAD_LINES,
  MAX_OUTPUT_LINES,
} from "./constants.js";

// ---- Output truncation -------------------------------------------------------

export function compactJobOutput(text: string): string {
  if (!text) return "";
  let compact = text;
  const lines = compact.split(/\r?\n/);
  if (lines.length > MAX_OUTPUT_LINES) {
    const headCount = Math.min(MAX_OUTPUT_HEAD_LINES, MAX_OUTPUT_LINES, lines.length);
    const tailBudget = Math.max(0, MAX_OUTPUT_LINES - headCount);
    const tailCount = Math.max(0, Math.min(lines.length - headCount, tailBudget));
    const omitted = Math.max(0, lines.length - headCount - tailCount);
    const marker = omitted > 0 ? [`... (${omitted} lines omitted) ...`] : [];
    const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : [];
    compact = [...lines.slice(0, headCount), ...marker, ...tail].join("\n");
  }
  if (compact.length > MAX_OUTPUT) {
    const markerPrefix = "... (";
    const markerSuffix = " chars omitted) ...\n";
    const markerBudget = markerPrefix.length + markerSuffix.length + 20;
    if (markerBudget >= MAX_OUTPUT) {
      compact = compact.slice(-MAX_OUTPUT);
    } else {
      const keepChars = Math.max(0, MAX_OUTPUT - markerBudget);
      const omittedChars = Math.max(0, compact.length - keepChars);
      const marker = `${markerPrefix}${omittedChars}${markerSuffix}`;
      const tail = keepChars > 0 ? compact.slice(-keepChars) : "";
      compact = `${marker}${tail}`;
    }
  }
  return compact;
}

export function truncate(s: string): string {
  return compactJobOutput(s);
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

export function parseStructuredResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith(EXECUTOR_RESULT_PREFIX)) continue;
    const raw = line.slice(EXECUTOR_RESULT_PREFIX.length).trim();
    if (!raw) continue;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

export function filterResultLines(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(EXECUTOR_RESULT_PREFIX))
    .join("\n")
    .trim();
}
