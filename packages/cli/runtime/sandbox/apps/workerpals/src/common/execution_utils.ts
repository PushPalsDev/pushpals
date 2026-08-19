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
    if (!isStructuredResultLine(line, executorResultPrefix)) continue;
    const barePrefix = executorResultPrefix.trimEnd();
    const raw = line.slice(barePrefix.length).trim();
    // The newest sentinel is authoritative even when its payload is empty.
    // Never fall back to an older success after a truncated terminal write.
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

export function hasStructuredResultSentinel(
  stdout: string,
  executorResultPrefix = resolveOutputCompactionPolicy().executorResultPrefix,
): boolean {
  return stdout
    .split(/\r?\n/)
    .some((line) => isStructuredResultLine(line.trim(), executorResultPrefix));
}

function isStructuredResultLine(line: string, executorResultPrefix: string): boolean {
  const barePrefix = executorResultPrefix.trimEnd();
  return line === barePrefix || line.startsWith(executorResultPrefix);
}

export type StructuredJobResultEnvelopeValidation =
  | {
      valid: true;
      ok: boolean;
      exitCode?: number;
    }
  | {
      valid: false;
      detail: string;
    };

/**
 * Validate the process-boundary fields before treating wrapper JSON as a job
 * result. TypeScript types do not protect this boundary: the payload was
 * produced by another process and may be stale, truncated, or malformed.
 */
export function validateStructuredJobResultEnvelope(
  value: unknown,
): StructuredJobResultEnvelopeValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      valid: false,
      detail: "structured result must be a JSON object",
    };
  }

  const record = value as Record<string, unknown>;
  if (typeof record.ok !== "boolean") {
    return {
      valid: false,
      detail: `structured result field ok must be boolean, received ${describeStructuredFieldType(
        record.ok,
      )}`,
    };
  }

  if (Object.prototype.hasOwnProperty.call(record, "exitCode")) {
    if (
      typeof record.exitCode !== "number" ||
      !Number.isFinite(record.exitCode) ||
      !Number.isInteger(record.exitCode)
    ) {
      return {
        valid: false,
        detail: `structured result field exitCode must be a finite integer when present, received ${describeStructuredFieldType(
          record.exitCode,
        )}`,
      };
    }
    return { valid: true, ok: record.ok, exitCode: record.exitCode };
  }

  return { valid: true, ok: record.ok };
}

function describeStructuredFieldType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return typeof value;
}

export function filterResultLines(
  stdout: string,
  executorResultPrefix = resolveOutputCompactionPolicy().executorResultPrefix,
): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => !isStructuredResultLine(line.trim(), executorResultPrefix))
    .join("\n")
    .trim();
}
