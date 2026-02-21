export interface SessionMemoryWriteInput {
  repoRoot: string;
  sessionId: string;
  requestId?: string | null;
  kind: string;
  summary: string;
}

export interface SessionMemoryWriteOptions {
  maxSummaryChars?: number;
  retentionDays?: number;
}

export interface SessionMemoryRecallOptions {
  repoRoot: string;
  sessionId: string;
  includeCurrentSession?: boolean;
  includeCrossSession?: boolean;
  maxItems: number;
  maxChars: number;
}

export interface SessionMemoryBackend {
  remember(input: SessionMemoryWriteInput, options?: SessionMemoryWriteOptions): void;
  recallForPlanning(options: SessionMemoryRecallOptions): string[];
  purgeExpired(retentionDays: number, repoRoot?: string): number;
  close(): void;
}

export type SessionMemoryBackendFactory = () => SessionMemoryBackend;

export function createSessionMemoryBackend(
  enabled: boolean,
  backendFactories: SessionMemoryBackendFactory[],
): SessionMemoryBackend {
  if (!enabled) return new NoopSessionMemory();
  const usable: SessionMemoryBackend[] = [];
  for (const factory of backendFactories) {
    try {
      const backend = factory();
      if (backend) usable.push(backend);
    } catch (err) {
      console.warn("[RemoteBuddy] Memory backend factory failed:", err);
    }
  }
  if (usable.length === 0) return new NoopSessionMemory();
  if (usable.length === 1) return usable[0]!;
  return new CompositeSessionMemory(usable);
}

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function mergeMemoryLines(
  lines: string[],
  limits: { maxItems: number; maxChars: number },
): string[] {
  const maxItems = clampPositiveInt(limits.maxItems, 8, 1, 128);
  const maxChars = clampPositiveInt(limits.maxChars, 2400, 120, 64_000);
  const out: string[] = [];
  const seen = new Set<string>();
  let usedChars = 0;
  for (const raw of lines) {
    const line = normalizeLine(raw);
    if (!line || seen.has(line)) continue;
    const separatorCost = out.length > 0 ? 1 : 0;
    if (out.length > 0 && usedChars + separatorCost + line.length > maxChars) break;
    if (out.length === 0 && line.length > maxChars) {
      out.push(`${line.slice(0, Math.max(0, maxChars - 14))} ...[truncated]`);
      return out;
    }
    out.push(line);
    seen.add(line);
    usedChars += separatorCost + line.length;
    if (out.length >= maxItems) break;
  }
  return out;
}

export class NoopSessionMemory implements SessionMemoryBackend {
  remember(_input: SessionMemoryWriteInput, _options: SessionMemoryWriteOptions = {}): void {}

  recallForPlanning(_options: SessionMemoryRecallOptions): string[] {
    return [];
  }

  purgeExpired(_retentionDays: number, _repoRoot?: string): number {
    return 0;
  }

  close(): void {}
}

export class CompositeSessionMemory implements SessionMemoryBackend {
  private backends: SessionMemoryBackend[];

  constructor(backends: SessionMemoryBackend[]) {
    this.backends = [...backends];
  }

  remember(input: SessionMemoryWriteInput, options: SessionMemoryWriteOptions = {}): void {
    for (const backend of this.backends) {
      try {
        backend.remember(input, options);
      } catch (err) {
        console.warn("[RemoteBuddy] Memory backend remember failed:", err);
      }
    }
  }

  recallForPlanning(options: SessionMemoryRecallOptions): string[] {
    const collected: string[] = [];
    for (const backend of this.backends) {
      try {
        const rows = backend.recallForPlanning(options);
        if (Array.isArray(rows) && rows.length > 0) {
          collected.push(...rows);
        }
      } catch (err) {
        console.warn("[RemoteBuddy] Memory backend recall failed:", err);
      }
    }
    return mergeMemoryLines(collected, {
      maxItems: options.maxItems,
      maxChars: options.maxChars,
    });
  }

  purgeExpired(retentionDays: number, repoRoot?: string): number {
    let total = 0;
    for (const backend of this.backends) {
      try {
        total += backend.purgeExpired(retentionDays, repoRoot);
      } catch (err) {
        console.warn("[RemoteBuddy] Memory backend purge failed:", err);
      }
    }
    return total;
  }

  close(): void {
    for (const backend of this.backends) {
      try {
        backend.close();
      } catch (err) {
        console.warn("[RemoteBuddy] Memory backend close failed:", err);
      }
    }
  }
}

type InMemoryRecord = {
  repoRoot: string;
  sessionId: string;
  requestId: string | null;
  kind: string;
  summary: string;
  createdAt: string;
};

export class InMemorySessionMemory implements SessionMemoryBackend {
  private rows: InMemoryRecord[] = [];

  remember(input: SessionMemoryWriteInput, options: SessionMemoryWriteOptions = {}): void {
    const repoRoot = normalizeLine(input.repoRoot);
    const sessionId = normalizeLine(input.sessionId);
    const summaryRaw = normalizeLine(input.summary);
    if (!repoRoot || !sessionId || !summaryRaw) return;
    const kind = normalizeLine(input.kind) || "note";
    const requestId = normalizeLine(input.requestId ?? "") || null;
    const maxSummaryChars = clampPositiveInt(options.maxSummaryChars, 420, 32, 8_000);
    const summary =
      summaryRaw.length <= maxSummaryChars
        ? summaryRaw
        : `${summaryRaw.slice(0, maxSummaryChars - 14)} ...[truncated]`;
    this.rows.push({
      repoRoot,
      sessionId,
      requestId,
      kind,
      summary,
      createdAt: new Date().toISOString(),
    });
    this.purgeExpired(options.retentionDays ?? 30, repoRoot);
  }

  recallForPlanning(options: SessionMemoryRecallOptions): string[] {
    const repoRoot = normalizeLine(options.repoRoot);
    const sessionId = normalizeLine(options.sessionId);
    if (!repoRoot || !sessionId) return [];
    const includeCurrentSession = options.includeCurrentSession !== false;
    const includeCrossSession = options.includeCrossSession !== false;
    if (!includeCurrentSession && !includeCrossSession) return [];
    const scanLimit = Math.max(1, Math.min(400, clampPositiveInt(options.maxItems, 8, 1, 64) * 8));
    const lines: string[] = [];
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (lines.length >= scanLimit) break;
      const row = this.rows[i]!;
      if (row.repoRoot !== repoRoot) continue;
      if (includeCurrentSession && !includeCrossSession && row.sessionId !== sessionId) continue;
      if (!includeCurrentSession && includeCrossSession && row.sessionId === sessionId) continue;
      const source = row.sessionId === sessionId ? "this-session" : "repo-history";
      lines.push(`[memory ${source} ${row.kind}] ${row.summary}`);
    }
    return mergeMemoryLines(lines, {
      maxItems: options.maxItems,
      maxChars: options.maxChars,
    });
  }

  purgeExpired(retentionDays: number, repoRoot?: string): number {
    const days = clampPositiveInt(retentionDays, 30, 1, 3650);
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const scopedRepo = normalizeLine(repoRoot ?? "");
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => {
      if (scopedRepo && row.repoRoot !== scopedRepo) return true;
      const createdMs = Date.parse(row.createdAt);
      if (!Number.isFinite(createdMs)) return true;
      return createdMs >= cutoffMs;
    });
    return before - this.rows.length;
  }

  close(): void {
    this.rows = [];
  }
}
