export const DEFAULT_MAX_PENDING_LINE_CHARS = 64 * 1024;
export const OUTPUT_LINE_TRUNCATED_MARKER = "[pushpals: process output line truncated]";

export type BoundedLineChunk = {
  lines: string[];
  pending: string;
};

/** Split streaming text into lines without retaining an unbounded partial line. */
export function appendBoundedLineChunk(
  pending: string,
  chunk: string,
  maxChars = DEFAULT_MAX_PENDING_LINE_CHARS,
): BoundedLineChunk {
  const boundedMax = Math.max(1, Math.floor(maxChars));
  let buffer = `${pending}${chunk}`;
  const lines: string[] = [];
  while (true) {
    const match = /\r?\n/.exec(buffer);
    if (!match || match.index == null) break;
    const rawLine = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    if (rawLine.length > boundedMax) {
      lines.push(rawLine.slice(0, boundedMax), OUTPUT_LINE_TRUNCATED_MARKER);
    } else {
      lines.push(rawLine);
    }
  }
  if (buffer.length > boundedMax) {
    lines.push(buffer.slice(0, boundedMax), OUTPUT_LINE_TRUNCATED_MARKER);
    buffer = "";
  }
  return { lines, pending: buffer };
}

export function finishBoundedLineBuffer(
  pending: string,
  decoderTail = "",
  maxChars = DEFAULT_MAX_PENDING_LINE_CHARS,
): string[] {
  const result = appendBoundedLineChunk(pending, `${decoderTail}\n`, maxChars);
  return result.lines;
}
