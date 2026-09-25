export type EvidenceLineRange = { startLine: number; endLine: number };

export type RepositoryTextExcerpt = {
  content: string;
  truncated: boolean;
  scanTruncated: boolean;
  lineRanges: EvidenceLineRange[];
};

/** Do not split a UTF-8 code point when charging evidence against byte budgets. */
function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, Math.floor(maxBytes));
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** Share a fixed packet budget without allowing early large files to starve later ones. */
export function allocateEvidenceBytes(
  sizes: number[],
  totalBytes: number,
  perFileBytes: number,
): number[] {
  const allocations = sizes.map(() => 0);
  let remaining = Math.max(0, Math.floor(totalBytes));
  let pending = sizes.map((size, index) => ({ index, size: Math.min(size, perFileBytes) }));
  while (pending.length && remaining > 0) {
    const share = Math.floor(remaining / pending.length);
    const small = pending.filter((entry) => entry.size <= share);
    if (small.length) {
      for (const entry of small) {
        allocations[entry.index] = entry.size;
        remaining -= entry.size;
      }
      const filled = new Set(small.map((entry) => entry.index));
      pending = pending.filter((entry) => !filled.has(entry.index));
    } else {
      let extra = remaining % pending.length;
      for (const entry of pending) {
        const granted = share + (extra-- > 0 ? 1 : 0);
        allocations[entry.index] = granted;
        remaining -= granted;
      }
      break;
    }
  }
  return allocations;
}

/**
 * Select original-line windows from an already bounded scan. Always retain
 * orientation at the start and coverage later in the scan, then rank remaining
 * windows by distinct, uncommon request terms. Repeated header matches cannot
 * consume every window. This is retrieval, never a claim that omitted code is
 * absent or defective.
 */
export function excerptRepositoryText(
  text: string,
  scanTruncated: boolean,
  maxBytes: number,
  retrievalTerms: string[],
): RepositoryTextExcerpt {
  const limit = Math.max(0, Math.floor(maxBytes));
  const lines = text.split(/\r?\n/);
  const completeLineCount = scanTruncated ? lines.length - 1 : lines.length;
  if (Buffer.byteLength(text, "utf8") <= limit) {
    return {
      content: text,
      truncated: scanTruncated,
      scanTruncated,
      lineRanges: completeLineCount > 0 ? [{ startLine: 1, endLine: completeLineCount }] : [],
    };
  }
  type Chunk = EvidenceLineRange & { text: string; partial: boolean; bytes: number };
  const chunks: Chunk[] = [];
  // Leave room for window labels, including the degenerate one-long-line case.
  const chunkBytes = Math.max(1, Math.min(1_024, Math.floor(limit / 4) - 64));
  let pending: Chunk | null = null;
  const flush = () => {
    if (pending) chunks.push(pending);
    pending = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const bytes = Buffer.byteLength(line, "utf8");
    const partial = bytes > chunkBytes || index >= completeLineCount;
    if (partial) {
      flush();
      const prefix = utf8Prefix(line, chunkBytes);
      chunks.push({
        startLine: index + 1,
        endLine: index + 1,
        text: prefix,
        partial: true,
        bytes: Buffer.byteLength(prefix, "utf8"),
      });
    } else {
      if (pending && pending.bytes + bytes + 1 > chunkBytes) flush();
      if (!pending)
        pending = { startLine: index + 1, endLine: index + 1, text: line, partial: false, bytes };
      else {
        pending.text += `\n${line}`;
        pending.endLine = index + 1;
        pending.bytes += bytes + 1;
      }
    }
  }
  flush();
  const terms = [
    ...new Set(retrievalTerms.map((term) => term.normalize("NFKC").toLocaleLowerCase("und"))),
  ]
    .filter(
      (term) =>
        term.length <= 80 &&
        (term.length >= 4 ||
          (term.length >= 2 &&
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term))),
    )
    .slice(0, 128);
  const matches = chunks.map((chunk) => {
    const normalized = chunk.text.normalize("NFKC").toLocaleLowerCase("und");
    return terms.filter((term) => normalized.includes(term));
  });
  const frequency = new Map(
    terms.map((term) => [term, matches.filter((set) => set.includes(term)).length]),
  );
  const ranked = chunks
    .map((_chunk, index) => ({
      index,
      score: matches[index]!.reduce((sum, term) => sum + 1 / frequency.get(term)!, 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = new Set<number>();
  let usedBytes = 0;
  const render = (chunk: Chunk) =>
    `[${chunk.partial ? "partial " : ""}lines ${chunk.startLine}-${chunk.endLine}]\n${chunk.text}`;
  const add = (index: number) => {
    if (selected.has(index) || !chunks[index]) return;
    const bytes = Buffer.byteLength(render(chunks[index]!), "utf8") + (selected.size ? 2 : 0);
    if (usedBytes + bytes > limit) return;
    selected.add(index);
    usedBytes += bytes;
  };
  add(0);
  add(chunks.length - 1);
  // A middle window also guarantees body coverage when terms occur only in a
  // header, or when the file has no lexical matches at all.
  add(Math.floor(chunks.length / 2));
  for (const entry of ranked) add(entry.index);
  const ordered = [...selected].sort((left, right) => left - right).map((index) => chunks[index]!);
  const lineRanges: EvidenceLineRange[] = [];
  for (const chunk of ordered) {
    if (chunk.partial) continue;
    const previous = lineRanges.at(-1);
    if (previous && previous.endLine + 1 === chunk.startLine) previous.endLine = chunk.endLine;
    else lineRanges.push({ startLine: chunk.startLine, endLine: chunk.endLine });
  }
  return {
    content: ordered.length ? ordered.map(render).join("\n\n") : utf8Prefix(text, limit),
    truncated: true,
    scanTruncated,
    lineRanges,
  };
}
