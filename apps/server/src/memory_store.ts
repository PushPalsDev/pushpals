import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import {
  MemoryConflictError,
  MEMORY_LIMITS,
  MemoryStoreClosedError,
  MAX_MEMORY_REINFORCEMENT_OBSERVATIONS,
  assertMemoryReinforcementObservationCompatible,
  assertMemoryReinforcementOutcome,
  createMemoryReinforcementObservation,
  memoryRecordRankingQuality,
  resolveMemoryReinforcement,
  serializedMemoryRecordChars,
  type MemoryAddress,
  type MemoryEvidence,
  type MemoryGetOptions,
  type MemoryInvalidateSelector,
  type MemoryJsonValue,
  type MemoryPruneOptions,
  type MemoryProvenance,
  type MemoryPutInput,
  type MemoryPutOptions,
  type MemoryRecord,
  type MemoryReinforcementObservation,
  type MemoryReinforceInput,
  type MemoryScope,
  type MemorySearchQuery,
  type MemoryStatus,
  type MemoryStore,
} from "shared";

type MemorySqlRow = {
  id: string;
  namespace: string;
  repositoryId: string;
  sessionId: string;
  memoryKey: string;
  kind: string;
  subjectKey: string | null;
  summary: string;
  valueJson: string | null;
  tagsJson: string;
  evidenceJson: string;
  provenanceJson: string;
  confidence: number;
  usefulness: number;
  status: MemoryStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
};

type MemoryObservationSqlRow = {
  id: string;
  outcome: MemoryReinforceInput["outcome"];
  weight: number;
  evidenceJson: string;
  provenanceJson: string | null;
  createdAt: string;
};

const MEMORY_SELECT_COLUMNS = `
  id, namespace, repositoryId, sessionId, memoryKey, kind, subjectKey, summary,
  valueJson, tagsJson, evidenceJson, provenanceJson, confidence, usefulness,
  status, revision, createdAt, updatedAt, expiresAt, invalidatedAt,
  invalidationReason
`;

const ALL_MEMORY_STATUSES: MemoryStatus[] = ["active", "stale", "superseded", "invalid"];

function compact(value: unknown, maxChars: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function required(value: unknown, name: string, maxChars: number): string {
  const text = compact(value, maxChars);
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function addressPart(
  value: unknown,
  name: string,
  maxChars: number,
  isRequired: boolean,
): string | null {
  const text = String(value ?? "").trim();
  if (!text) {
    if (isRequired) throw new TypeError(`${name} is required`);
    return null;
  }
  if (text.length > maxChars) {
    throw new TypeError(`${name} must be at most ${maxChars} characters`);
  }
  if (text.includes("\0")) throw new TypeError(`${name} must not contain NUL characters`);
  return text;
}

function clampUnit(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function normalizeTimestamp(value: unknown, name: string): string {
  const timestamp = compact(value, 64);
  const parsed = Date.parse(timestamp);
  if (!timestamp || !Number.isFinite(parsed)) {
    throw new TypeError(`${name} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function normalizeScope(scope: MemoryScope): Required<MemoryScope> {
  return {
    namespace: addressPart(
      scope?.namespace,
      "memory scope namespace",
      MEMORY_LIMITS.namespaceChars,
      true,
    )!,
    repositoryId: addressPart(
      scope?.repositoryId,
      "memory scope repositoryId",
      MEMORY_LIMITS.repositoryIdChars,
      false,
    ),
    sessionId: addressPart(
      scope?.sessionId,
      "memory scope sessionId",
      MEMORY_LIMITS.sessionIdChars,
      false,
    ),
  };
}

function normalizeList(
  values: unknown,
  maxItems: number = MEMORY_LIMITS.listItems,
  maxChars: number = MEMORY_LIMITS.listItemChars,
): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = compact(value, maxChars);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeEvidence(values: unknown): MemoryEvidence[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, MEMORY_LIMITS.evidenceItems).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = entry as MemoryEvidence;
    const path = compact(raw.path, MEMORY_LIMITS.evidencePathChars).replace(/\\/g, "/");
    if (
      path &&
      (path.startsWith("/") || /^[a-z]:\//i.test(path) || path.split("/").includes(".."))
    ) {
      throw new TypeError("memory evidence paths must be repository-relative and contained");
    }
    const observedAt = compact(raw.observedAt, 64);
    if (observedAt && !Number.isFinite(Date.parse(observedAt))) {
      throw new TypeError("memory evidence observedAt must be an ISO timestamp");
    }
    const normalized: MemoryEvidence = {
      ...(path ? { path } : {}),
      ...(compact(raw.blobOid, MEMORY_LIMITS.evidenceBlobOidChars)
        ? { blobOid: compact(raw.blobOid, MEMORY_LIMITS.evidenceBlobOidChars) }
        : {}),
      ...(compact(raw.sourceId, MEMORY_LIMITS.evidenceSourceIdChars)
        ? { sourceId: compact(raw.sourceId, MEMORY_LIMITS.evidenceSourceIdChars) }
        : {}),
      ...(compact(raw.detail, MEMORY_LIMITS.evidenceDetailChars)
        ? { detail: compact(raw.detail, MEMORY_LIMITS.evidenceDetailChars) }
        : {}),
      ...(observedAt ? { observedAt: new Date(observedAt).toISOString() } : {}),
    };
    return Object.keys(normalized).length > 0 ? [normalized] : [];
  });
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function hydrate<T extends MemoryJsonValue = MemoryJsonValue>(
  row: MemorySqlRow,
  observations: MemoryReinforcementObservation[] = [],
): MemoryRecord<T> {
  return {
    id: row.id,
    scope: {
      namespace: row.namespace,
      repositoryId: row.repositoryId || null,
      sessionId: row.sessionId || null,
    },
    key: row.memoryKey,
    kind: row.kind,
    subjectKey: row.subjectKey,
    summary: row.summary,
    value: parseJson<T | null>(row.valueJson, null),
    tags: parseJson<string[]>(row.tagsJson, []),
    evidence: parseJson<MemoryEvidence[]>(row.evidenceJson, []),
    observations,
    provenance: parseJson<MemoryProvenance>(row.provenanceJson, { service: "unknown" }),
    confidence: Number(row.confidence),
    usefulness: Number(row.usefulness),
    status: row.status,
    revision: Number(row.revision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    invalidatedAt: row.invalidatedAt,
    invalidationReason: row.invalidationReason,
  };
}

function evidencePathSet(evidence: MemoryEvidence[]): Set<string> {
  return new Set(
    evidence.map((entry) => compact(entry.path, 1_000).replace(/\\/g, "/")).filter(Boolean),
  );
}

function matchesAny(value: string | null, candidates: string[]): boolean {
  if (candidates.length === 0) return true;
  if (value == null) return false;
  const normalizedValue = value.toLowerCase();
  return candidates.some((candidate) => candidate.toLowerCase() === normalizedValue);
}

function includesAll(haystack: string[], needles: string[]): boolean {
  if (needles.length === 0) return true;
  const values = new Set(haystack.map((value) => value.toLowerCase()));
  return needles.every((needle) => values.has(needle.toLowerCase()));
}

function lexicalScore(record: MemoryRecord, text: string): number {
  const tokens = compact(text, MEMORY_LIMITS.searchTextChars)
    .toLowerCase()
    .split(/[^a-z0-9_.\/-]+/)
    .filter((token) => token.length > 1)
    .slice(0, 64);
  if (tokens.length === 0) return 0;
  const subject = (record.subjectKey ?? "").toLowerCase();
  const haystack = [record.key, record.kind, subject, record.summary, ...record.tags]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const token of new Set(tokens)) {
    if (record.key.toLowerCase() === token || subject === token) score += 6;
    else if (record.key.toLowerCase().includes(token) || subject.includes(token)) score += 3;
    else if (haystack.includes(token)) score += 1;
  }
  return score;
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: Database;
  private closed = false;

  constructor(dbPath = ":memory:") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private assertOpen(): void {
    if (this.closed) throw new MemoryStoreClosedError();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id                 TEXT PRIMARY KEY,
        namespace          TEXT NOT NULL,
        repositoryId       TEXT NOT NULL DEFAULT '',
        sessionId          TEXT NOT NULL DEFAULT '',
        memoryKey          TEXT NOT NULL,
        kind               TEXT NOT NULL,
        subjectKey         TEXT,
        summary            TEXT NOT NULL,
        valueJson          TEXT,
        tagsJson           TEXT NOT NULL DEFAULT '[]',
        evidenceJson       TEXT NOT NULL DEFAULT '[]',
        provenanceJson     TEXT NOT NULL,
        confidence         REAL NOT NULL DEFAULT 0.5,
        usefulness         REAL NOT NULL DEFAULT 0.5,
        status             TEXT NOT NULL DEFAULT 'active',
        revision           INTEGER NOT NULL DEFAULT 1,
        createdAt          TEXT NOT NULL,
        updatedAt          TEXT NOT NULL,
        expiresAt          TEXT,
        invalidatedAt      TEXT,
        invalidationReason TEXT,
        UNIQUE(namespace, repositoryId, sessionId, memoryKey)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_scope_status_updated
        ON memory_records(namespace, repositoryId, sessionId, status, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_expiry ON memory_records(expiresAt);

      CREATE TABLE IF NOT EXISTS memory_observations (
        id             TEXT PRIMARY KEY,
        memoryRecordId TEXT NOT NULL,
        outcome        TEXT NOT NULL
          CHECK(outcome IN ('confirmed', 'successful', 'failed', 'contradicted')),
        weight         REAL NOT NULL,
        evidenceJson   TEXT NOT NULL DEFAULT '[]',
        provenanceJson TEXT,
        createdAt      TEXT NOT NULL,
        FOREIGN KEY(memoryRecordId) REFERENCES memory_records(id)
      );

      CREATE TRIGGER IF NOT EXISTS trg_memory_observations_valid_outcome_insert
      BEFORE INSERT ON memory_observations
      FOR EACH ROW WHEN NEW.outcome NOT IN ('confirmed', 'successful', 'failed', 'contradicted')
      BEGIN
        SELECT RAISE(ABORT, 'invalid memory reinforcement outcome');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_memory_observations_valid_outcome_update
      BEFORE UPDATE OF outcome ON memory_observations
      FOR EACH ROW WHEN NEW.outcome NOT IN ('confirmed', 'successful', 'failed', 'contradicted')
      BEGIN
        SELECT RAISE(ABORT, 'invalid memory reinforcement outcome');
      END;

      CREATE INDEX IF NOT EXISTS idx_memory_observation_record
        ON memory_observations(memoryRecordId, createdAt DESC);
    `);
  }

  private rowForAddress(address: MemoryAddress): MemorySqlRow | null {
    const scope = normalizeScope(address.scope);
    const key = addressPart(address.key, "memory key", MEMORY_LIMITS.keyChars, true)!;
    return (
      (this.db
        .prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memory_records
           WHERE namespace = ? AND repositoryId = ? AND sessionId = ? AND memoryKey = ?
           LIMIT 1`,
        )
        .get(scope.namespace, scope.repositoryId ?? "", scope.sessionId ?? "", key) as
        | MemorySqlRow
        | undefined) ?? null
    );
  }

  private observationsForRecord(recordId: string): MemoryReinforcementObservation[] {
    const rows = this.db
      .prepare(
        `SELECT id, outcome, weight, evidenceJson, provenanceJson, createdAt
         FROM memory_observations WHERE memoryRecordId = ?
         ORDER BY createdAt DESC, rowid DESC LIMIT ?`,
      )
      .all(recordId, MAX_MEMORY_REINFORCEMENT_OBSERVATIONS) as MemoryObservationSqlRow[];
    const seen = new Set<string>();
    return rows
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return (
          row.outcome === "confirmed" ||
          row.outcome === "successful" ||
          row.outcome === "failed" ||
          row.outcome === "contradicted"
        );
      })
      .map((row) => {
        const evidence = parseJson<MemoryEvidence[]>(row.evidenceJson, []);
        const provenance = parseJson<MemoryProvenance | null>(row.provenanceJson, null);
        return {
          id: row.id,
          outcome: row.outcome,
          weight: Number(row.weight),
          observedAt: row.createdAt,
          ...(evidence.length > 0 ? { evidence } : {}),
          ...(provenance ? { provenance } : {}),
        } satisfies MemoryReinforcementObservation;
      })
      .reverse();
  }

  private hydrateRecord<T extends MemoryJsonValue = MemoryJsonValue>(
    row: MemorySqlRow,
  ): MemoryRecord<T> {
    return hydrate<T>(row, this.observationsForRecord(row.id));
  }

  async put<T extends MemoryJsonValue = MemoryJsonValue>(
    input: MemoryPutInput<T>,
    options: MemoryPutOptions = {},
  ): Promise<MemoryRecord<T>> {
    this.assertOpen();
    const scope = normalizeScope(input.scope);
    const key = addressPart(input.key, "memory key", MEMORY_LIMITS.keyChars, true)!;
    const kind = required(input.kind, "memory kind", MEMORY_LIMITS.kindChars);
    const summary = required(input.summary, "memory summary", MEMORY_LIMITS.summaryChars);
    const optionalProvenance = (value: unknown): string | undefined =>
      compact(value, MEMORY_LIMITS.provenanceFieldChars) || undefined;
    const provenance: MemoryProvenance = {
      service: required(
        input.provenance?.service,
        "memory provenance service",
        MEMORY_LIMITS.provenanceServiceChars,
      ),
      ...(optionalProvenance(input.provenance?.agentId)
        ? { agentId: optionalProvenance(input.provenance?.agentId) }
        : {}),
      ...(optionalProvenance(input.provenance?.runId)
        ? { runId: optionalProvenance(input.provenance?.runId) }
        : {}),
      ...(optionalProvenance(input.provenance?.requestId)
        ? { requestId: optionalProvenance(input.provenance?.requestId) }
        : {}),
      ...(optionalProvenance(input.provenance?.jobId)
        ? { jobId: optionalProvenance(input.provenance?.jobId) }
        : {}),
      ...(optionalProvenance(input.provenance?.modelId)
        ? { modelId: optionalProvenance(input.provenance?.modelId) }
        : {}),
      ...(optionalProvenance(input.provenance?.headSha)
        ? { headSha: optionalProvenance(input.provenance?.headSha) }
        : {}),
      ...(optionalProvenance(input.provenance?.promptVersion)
        ? { promptVersion: optionalProvenance(input.provenance?.promptVersion) }
        : {}),
    };
    const tags = normalizeList(input.tags, MEMORY_LIMITS.listItems, MEMORY_LIMITS.tagChars);
    const evidence = normalizeEvidence(input.evidence);
    const requestedStatus = ALL_MEMORY_STATUSES.includes(input.status as MemoryStatus)
      ? (input.status as MemoryStatus)
      : undefined;
    const assertCommitFence = () => {
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new DOMException("The memory write was aborted", "AbortError");
      }
      const commitNowMs = Date.now();
      if (options.validUntil !== undefined) {
        if (typeof options.validUntil !== "string") {
          throw new TypeError("validUntil must be an ISO timestamp");
        }
        const validUntilMs = Date.parse(options.validUntil);
        if (!Number.isFinite(validUntilMs)) {
          throw new TypeError("validUntil must be an ISO timestamp");
        }
        if (validUntilMs <= commitNowMs) {
          throw new Error("Memory write commit fence expired before mutation");
        }
      }
      return commitNowMs;
    };

    const tx = this.db.transaction(() => {
      const commitNowMs = assertCommitFence();
      const now = new Date(commitNowMs).toISOString();
      const existing = this.rowForAddress({ scope, key });
      const expected = options.expectedRevision;
      if (expected !== undefined) {
        const actual = existing?.revision ?? 0;
        if (actual !== expected) {
          throw new MemoryConflictError(
            `Memory revision conflict for ${scope.namespace}/${key}: expected ${expected}, actual ${actual}`,
          );
        }
      }
      let expiresAt: string | null;
      if (input.expiresAt !== undefined) {
        expiresAt =
          input.expiresAt === null ? null : normalizeTimestamp(input.expiresAt, "expiresAt");
      } else if (input.ttlMs !== undefined && input.ttlMs !== null) {
        const ttlMs = Number(input.ttlMs);
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be positive");
        expiresAt = new Date(Date.parse(now) + Math.floor(ttlMs)).toISOString();
      } else {
        expiresAt = existing?.expiresAt ?? null;
      }
      const status = requestedStatus ?? existing?.status ?? "active";
      const remainsInvalid = status === "invalid" && existing?.status === "invalid";
      const invalidatedAt =
        status === "invalid" ? (remainsInvalid ? existing?.invalidatedAt : now) : null;
      const invalidationReason =
        status === "invalid" && remainsInvalid ? (existing?.invalidationReason ?? null) : null;
      if (!existing) {
        const id = randomUUID();
        assertCommitFence();
        this.db
          .prepare(
            `INSERT INTO memory_records (
               id, namespace, repositoryId, sessionId, memoryKey, kind, subjectKey,
               summary, valueJson, tagsJson, evidenceJson, provenanceJson,
               confidence, usefulness, status, revision, createdAt, updatedAt,
               expiresAt, invalidatedAt, invalidationReason
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            scope.namespace,
            scope.repositoryId ?? "",
            scope.sessionId ?? "",
            key,
            kind,
            compact(input.subjectKey, MEMORY_LIMITS.subjectKeyChars) || null,
            summary,
            input.value === undefined ? null : JSON.stringify(input.value),
            JSON.stringify(tags),
            JSON.stringify(evidence),
            JSON.stringify(provenance),
            clampUnit(input.confidence, 0.5),
            clampUnit(input.usefulness, 0.5),
            status,
            now,
            now,
            expiresAt,
            invalidatedAt,
            invalidationReason,
          );
        // Throwing inside the transaction after SQLite returns rolls the
        // mutation back if the fence expired while preparing/applying it.
        assertCommitFence();
        return this.rowForAddress({ scope, key })!;
      }

      const preserveLearnedScores = options.expectedRevision === undefined;
      assertCommitFence();
      this.db
        .prepare(
          `UPDATE memory_records SET
             kind = ?, subjectKey = ?, summary = ?, valueJson = ?, tagsJson = ?,
             evidenceJson = ?, confidence = ?, usefulness = ?,
             status = ?, revision = revision + 1, updatedAt = ?, expiresAt = ?,
             invalidatedAt = ?, invalidationReason = ?
           WHERE id = ?`,
        )
        .run(
          kind,
          compact(input.subjectKey, MEMORY_LIMITS.subjectKeyChars) || null,
          summary,
          input.value === undefined ? null : JSON.stringify(input.value),
          JSON.stringify(tags),
          JSON.stringify(evidence),
          preserveLearnedScores
            ? existing.confidence
            : clampUnit(input.confidence, existing.confidence),
          preserveLearnedScores
            ? existing.usefulness
            : clampUnit(input.usefulness, existing.usefulness),
          status,
          now,
          expiresAt,
          invalidatedAt,
          invalidationReason,
          existing.id,
        );
      assertCommitFence();
      return this.rowForAddress({ scope, key })!;
    });
    return this.hydrateRecord<T>(tx());
  }

  async get<T extends MemoryJsonValue = MemoryJsonValue>(
    address: MemoryAddress,
    options: MemoryGetOptions = {},
  ): Promise<MemoryRecord<T> | null> {
    this.assertOpen();
    const row = this.rowForAddress(address);
    if (!row) return null;
    const now = Date.now();
    if (!options.includeExpired && row.expiresAt && Date.parse(row.expiresAt) <= now) return null;
    const statuses = options.statuses?.length ? options.statuses : ["active"];
    if (!statuses.includes(row.status)) return null;
    return this.hydrateRecord<T>(row);
  }

  async search<T extends MemoryJsonValue = MemoryJsonValue>(
    query: MemorySearchQuery,
  ): Promise<Array<MemoryRecord<T>>> {
    this.assertOpen();
    const scope = normalizeScope(query.scope);
    const requestedStatuses: MemoryStatus[] = query.statuses?.length ? query.statuses : ["active"];
    const statuses = [
      ...new Set(requestedStatuses.filter((status) => ALL_MEMORY_STATUSES.includes(status))),
    ];
    if (statuses.length === 0) return [];
    const now = new Date().toISOString();
    const statusPlaceholders = statuses.map(() => "?").join(", ");
    const expiryPredicate = query.includeExpired ? "" : " AND (expiresAt IS NULL OR expiresAt > ?)";
    const rows = this.db
      .prepare(
        `SELECT ${MEMORY_SELECT_COLUMNS} FROM memory_records
         WHERE namespace = ? AND repositoryId = ? AND sessionId = ?
           AND status IN (${statusPlaceholders})${expiryPredicate}
         ORDER BY updatedAt DESC, revision DESC, memoryKey ASC
         LIMIT ?`,
      )
      .all(
        scope.namespace,
        scope.repositoryId ?? "",
        scope.sessionId ?? "",
        ...statuses,
        ...(query.includeExpired ? [] : [now]),
        MEMORY_LIMITS.searchCandidateRows,
      ) as MemorySqlRow[];
    const kinds = normalizeList(query.kinds, MEMORY_LIMITS.listItems, MEMORY_LIMITS.kindChars);
    const subjects = normalizeList(
      query.subjectKeys,
      MEMORY_LIMITS.listItems,
      MEMORY_LIMITS.subjectKeyChars,
    );
    const tags = normalizeList(query.tags, MEMORY_LIMITS.listItems, MEMORY_LIMITS.tagChars);
    const paths = normalizeList(
      query.evidencePaths,
      MEMORY_LIMITS.listItems,
      MEMORY_LIMITS.evidencePathChars,
    ).map((path) => path.replace(/\\/g, "/"));
    const text = compact(query.text, MEMORY_LIMITS.searchTextChars);
    const requestedMaxItems = Number(query.maxItems ?? 12);
    const maxItems = Math.max(
      1,
      Math.min(
        MEMORY_LIMITS.searchMaxItems,
        Number.isFinite(requestedMaxItems) ? Math.floor(requestedMaxItems) : 12,
      ),
    );
    const requestedMaxChars = Number(query.maxChars ?? 16_000);
    const maxChars = Math.max(
      1,
      Math.min(
        MEMORY_LIMITS.searchMaxChars,
        Number.isFinite(requestedMaxChars) ? Math.floor(requestedMaxChars) : 16_000,
      ),
    );
    let usedChars = 0;

    const candidates = rows
      .map((row) => hydrate<T>(row))
      .filter((record) => matchesAny(record.kind, kinds))
      .filter((record) => matchesAny(record.subjectKey, subjects))
      .filter((record) => includesAll(record.tags, tags))
      .filter((record) => {
        if (paths.length === 0) return true;
        const evidencePaths = evidencePathSet(record.evidence);
        return paths.every((path) => evidencePaths.has(path));
      })
      .map((record) => ({
        record,
        lexical: lexicalScore(record, text),
      }))
      .filter((row) => !text || row.lexical > 0)
      .sort(
        (left, right) =>
          right.lexical - left.lexical ||
          memoryRecordRankingQuality(right.record) - memoryRecordRankingQuality(left.record) ||
          Date.parse(right.record.updatedAt) - Date.parse(left.record.updatedAt) ||
          right.record.revision - left.record.revision ||
          left.record.key.localeCompare(right.record.key),
      );
    const selected: Array<MemoryRecord<T>> = [];
    for (const { record } of candidates) {
      if (selected.length >= maxItems) break;
      // Avoid loading observation rows when the base record already cannot fit.
      if (usedChars + serializedMemoryRecordChars(record) > maxChars) continue;
      const hydratedRecord: MemoryRecord<T> = {
        ...record,
        observations: this.observationsForRecord(record.id),
      };
      const size = serializedMemoryRecordChars(hydratedRecord);
      if (usedChars + size > maxChars) continue;
      selected.push(hydratedRecord);
      usedChars += size;
    }
    return selected;
  }

  async invalidate(selector: MemoryInvalidateSelector): Promise<number> {
    this.assertOpen();
    const scope = normalizeScope(selector.scope);
    const keys = normalizeList(selector.keys, MEMORY_LIMITS.listItems, MEMORY_LIMITS.keyChars);
    const kinds = normalizeList(selector.kinds, MEMORY_LIMITS.listItems, MEMORY_LIMITS.kindChars);
    const subjects = normalizeList(
      selector.subjectKeys,
      MEMORY_LIMITS.listItems,
      MEMORY_LIMITS.subjectKeyChars,
    );
    const tags = normalizeList(selector.tags, MEMORY_LIMITS.listItems, MEMORY_LIMITS.tagChars);
    const paths = normalizeList(
      selector.evidencePaths,
      MEMORY_LIMITS.listItems,
      MEMORY_LIMITS.evidencePathChars,
    ).map((path) => path.replace(/\\/g, "/"));
    const statuses = selector.statuses?.length ? selector.statuses : ALL_MEMORY_STATUSES;
    const selected = (
      this.db
        .prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memory_records
           WHERE namespace = ? AND repositoryId = ? AND sessionId = ?`,
        )
        .all(scope.namespace, scope.repositoryId ?? "", scope.sessionId ?? "") as MemorySqlRow[]
    )
      .map((row) => hydrate(row))
      .filter((record) => record.status !== "invalid" && statuses.includes(record.status))
      .filter((record) => matchesAny(record.key, keys))
      .filter((record) => matchesAny(record.kind, kinds))
      .filter((record) => matchesAny(record.subjectKey, subjects))
      .filter((record) => includesAll(record.tags, tags))
      .filter((record) => {
        if (paths.length === 0) return true;
        const cited = evidencePathSet(record.evidence);
        return paths.some((path) => cited.has(path));
      });
    if (selected.length === 0) return 0;
    const now = new Date().toISOString();
    const reason = compact(selector.reason, MEMORY_LIMITS.selectorReasonChars) || "invalidated";
    const statement = this.db.prepare(
      `UPDATE memory_records SET status = 'invalid', revision = revision + 1,
       invalidatedAt = ?, invalidationReason = ?, updatedAt = ? WHERE id = ?`,
    );
    const tx = this.db.transaction(() => {
      let count = 0;
      for (const record of selected) count += statement.run(now, reason, now, record.id).changes;
      return count;
    });
    return tx();
  }

  async reinforce<T extends MemoryJsonValue = MemoryJsonValue>(
    input: MemoryReinforceInput,
  ): Promise<MemoryRecord<T> | null> {
    this.assertOpen();
    assertMemoryReinforcementOutcome(input?.outcome);
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const existing = this.rowForAddress(input);
      if (!existing) return null;
      if (input.expectedId !== undefined) {
        const expectedId = addressPart(
          input.expectedId,
          "memory expectedId",
          MEMORY_LIMITS.recordIdChars,
          true,
        )!;
        if (existing.id !== expectedId) {
          throw new MemoryConflictError(
            `Memory record conflict for ${existing.namespace}/${existing.memoryKey}: expected id ${expectedId}, got ${existing.id}`,
            "record_conflict",
          );
        }
      }
      const hydrated = hydrate(existing);
      const observation = createMemoryReinforcementObservation(existing.id, input, now);
      const priorObservation = this.db
        .prepare(
          `SELECT id, outcome, weight, evidenceJson, provenanceJson, createdAt
           FROM memory_observations WHERE id = ? LIMIT 1`,
        )
        .get(observation.id) as MemoryObservationSqlRow | undefined;
      if (priorObservation) {
        const priorEvidence = parseJson<MemoryEvidence[]>(priorObservation.evidenceJson, []);
        const priorProvenance = parseJson<MemoryProvenance | null>(
          priorObservation.provenanceJson,
          null,
        );
        assertMemoryReinforcementObservationCompatible(
          {
            id: priorObservation.id,
            outcome: priorObservation.outcome,
            weight: Number(priorObservation.weight),
            observedAt: priorObservation.createdAt,
            ...(priorEvidence.length > 0 ? { evidence: priorEvidence } : {}),
            ...(priorProvenance ? { provenance: priorProvenance } : {}),
          },
          observation,
        );
        return existing;
      }
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_observations (
             id, memoryRecordId, outcome, weight, evidenceJson, provenanceJson, createdAt
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          observation.id,
          existing.id,
          observation.outcome,
          observation.weight,
          JSON.stringify(observation.evidence ?? []),
          observation.provenance ? JSON.stringify(observation.provenance) : null,
          observation.observedAt,
        );
      if (inserted.changes === 0) {
        const collided = this.db
          .prepare(
            `SELECT id, outcome, weight, evidenceJson, provenanceJson, createdAt
             FROM memory_observations WHERE id = ? LIMIT 1`,
          )
          .get(observation.id) as MemoryObservationSqlRow | undefined;
        if (!collided) {
          throw new MemoryConflictError(
            `Memory observation conflict for ${observation.id}: insert was rejected`,
          );
        }
        const collidedEvidence = parseJson<MemoryEvidence[]>(collided.evidenceJson, []);
        const collidedProvenance = parseJson<MemoryProvenance | null>(
          collided.provenanceJson,
          null,
        );
        assertMemoryReinforcementObservationCompatible(
          {
            id: collided.id,
            outcome: collided.outcome,
            weight: Number(collided.weight),
            observedAt: collided.createdAt,
            ...(collidedEvidence.length > 0 ? { evidence: collidedEvidence } : {}),
            ...(collidedProvenance ? { provenance: collidedProvenance } : {}),
          },
          observation,
        );
        return existing;
      }
      const effect = resolveMemoryReinforcement(hydrated, input.outcome, input.weight);
      const evidence =
        observation.evidence && observation.evidence.length > 0
          ? normalizeEvidence([...hydrated.evidence, ...observation.evidence])
          : hydrated.evidence;
      this.db
        .prepare(
          `UPDATE memory_records SET confidence = ?, usefulness = ?, status = ?,
           evidenceJson = ?, revision = revision + 1, updatedAt = ?,
           invalidatedAt = ?, invalidationReason = ? WHERE id = ?`,
        )
        .run(
          effect.confidence,
          effect.usefulness,
          effect.status,
          JSON.stringify(evidence),
          now,
          effect.status === "invalid" ? existing.invalidatedAt : null,
          effect.status === "invalid" ? existing.invalidationReason : null,
          existing.id,
        );
      this.db
        .prepare(
          `DELETE FROM memory_observations WHERE memoryRecordId = ? AND id NOT IN (
             SELECT id FROM memory_observations WHERE memoryRecordId = ?
             ORDER BY createdAt DESC, rowid DESC LIMIT ?
           )`,
        )
        .run(existing.id, existing.id, MAX_MEMORY_REINFORCEMENT_OBSERVATIONS);
      return this.rowForAddress(input);
    });
    const row = tx();
    return row ? this.hydrateRecord<T>(row) : null;
  }

  async prune(options: MemoryPruneOptions = {}): Promise<number> {
    this.assertOpen();
    const expiredBefore = options.expiredBefore
      ? normalizeTimestamp(options.expiredBefore, "expiredBefore")
      : new Date().toISOString();
    const updatedBefore = options.updatedBefore
      ? normalizeTimestamp(options.updatedBefore, "updatedBefore")
      : null;
    const statuses = options.statuses?.length ? options.statuses : ["invalid", "superseded"];
    const scope = options.scope ? normalizeScope(options.scope) : null;
    const rows = this.db
      .prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memory_records`)
      .all() as MemorySqlRow[];
    const ids = rows
      .filter(
        (row) =>
          !scope ||
          (row.namespace === scope.namespace &&
            row.repositoryId === (scope.repositoryId ?? "") &&
            row.sessionId === (scope.sessionId ?? "")),
      )
      .filter(
        (row) =>
          (row.expiresAt != null && row.expiresAt <= expiredBefore) ||
          (updatedBefore != null &&
            statuses.includes(row.status) &&
            row.updatedAt <= updatedBefore),
      )
      .map((row) => row.id);
    if (ids.length === 0) return 0;
    const deleteObservations = this.db.prepare(
      `DELETE FROM memory_observations WHERE memoryRecordId = ?`,
    );
    const deleteRecord = this.db.prepare(`DELETE FROM memory_records WHERE id = ?`);
    const tx = this.db.transaction(() => {
      let count = 0;
      for (const id of ids) {
        deleteObservations.run(id);
        count += deleteRecord.run(id).changes;
      }
      return count;
    });
    return tx();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
