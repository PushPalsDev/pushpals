import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MEMORY_LIMITS, MemoryConflictError } from "shared";
import { SqliteMemoryStore } from "../apps/server/src/memory_store";

function fact(repositoryId: string, key = "route-owner") {
  return {
    scope: { namespace: "repository_fact", repositoryId },
    key,
    kind: "ownership",
    subjectKey: "route-shell",
    summary: "The route shell is owned by src/router.ts",
    value: { owner: "src/router.ts" },
    tags: ["routing", "ownership"],
    evidence: [{ path: "src/router.ts", blobOid: "blob-1" }],
    provenance: { service: "repository_agent", headSha: "head-1" },
    confidence: 0.7,
    usefulness: 0.6,
  } as const;
}

describe("SqliteMemoryStore", () => {
  test("persists typed repository memory across a server restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-shared-memory-"));
    const dbPath = join(root, "state.sqlite");
    try {
      const writer = new SqliteMemoryStore(dbPath);
      const saved = await writer.put(fact("repo-a"), { expectedRevision: 0 });
      expect(saved.revision).toBe(1);
      const reinforced = await writer.reinforce({
        scope: saved.scope,
        key: saved.key,
        outcome: "successful",
        observationId: "publication-job-1",
        weight: 2,
        evidence: [{ path: "src/router.test.ts", blobOid: "test-blob" }],
        provenance: { service: "source_control_manager", jobId: "job-1" },
      });
      expect(reinforced?.observations).toHaveLength(1);
      const revised = await writer.put(
        {
          ...fact("repo-a"),
          summary: "The route shell remains owned by src/router.ts after validation.",
          provenance: { service: "repository_agent", runId: "later-analysis" },
        },
        { expectedRevision: reinforced!.revision },
      );
      expect(revised.observations).toEqual(reinforced?.observations);
      expect(revised.provenance).toEqual({
        service: "repository_agent",
        headSha: "head-1",
      });
      await writer.close();

      const reader = new SqliteMemoryStore(dbPath);
      const recalled = await reader.get({ scope: fact("repo-a").scope, key: fact("repo-a").key });
      expect(recalled?.summary).toContain("src/router.ts");
      expect(recalled?.evidence).toEqual([{ path: "src/router.ts", blobOid: "blob-1" }]);
      expect(recalled?.provenance).toEqual({
        service: "repository_agent",
        headSha: "head-1",
      });
      expect(recalled?.observations).toHaveLength(1);
      expect(recalled?.observations[0]).toMatchObject({
        outcome: "successful",
        weight: 2,
        evidence: [{ path: "src/router.test.ts", blobOid: "test-blob" }],
        provenance: { service: "source_control_manager", jobId: "job-1" },
      });
      const identicalRetry = await reader.reinforce({
        scope: saved.scope,
        key: saved.key,
        outcome: "successful",
        observationId: "publication-job-1",
        weight: 2,
        evidence: [{ path: "src/router.test.ts", blobOid: "test-blob" }],
        provenance: { service: "source_control_manager", jobId: "job-1" },
      });
      expect(identicalRetry?.revision).toBe(recalled?.revision);
      await expect(
        reader.reinforce({
          scope: saved.scope,
          key: saved.key,
          outcome: "failed",
          observationId: "publication-job-1",
          weight: 2,
          evidence: [{ path: "src/router.test.ts", blobOid: "test-blob" }],
          provenance: { service: "source_control_manager", jobId: "job-1" },
        }),
      ).rejects.toBeInstanceOf(MemoryConflictError);
      await reader.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort on Windows while SQLite releases WAL handles.
      }
    }
  });

  test("enforces CAS and never crosses repository scopes", async () => {
    const store = new SqliteMemoryStore(":memory:");
    const a = await store.put(fact("repo-a"), { expectedRevision: 0 });
    await store.put(fact("repo-b"), { expectedRevision: 0 });
    await expect(
      store.put(fact("repo-a"), { expectedRevision: a.revision + 1 }),
    ).rejects.toBeInstanceOf(MemoryConflictError);
    const results = await store.search({
      scope: fact("repo-a").scope,
      text: "router ownership",
      maxItems: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.scope.repositoryId).toBe("repo-a");
    await store.close();
  });

  test("rejects expired commit-fenced writes atomically", async () => {
    const store = new SqliteMemoryStore(":memory:");
    await expect(
      store.put(fact("repo-fenced", "expired"), {
        validUntil: new Date(Date.now() - 1).toISOString(),
      }),
    ).rejects.toThrow("commit fence expired");
    expect(await store.get({ scope: fact("repo-fenced").scope, key: "expired" })).toBeNull();
    await store.close();
  });

  test("learns from outcomes and retains an observation-backed revision", async () => {
    const store = new SqliteMemoryStore(":memory:");
    const initial = await store.put(fact("repo-a"));
    const successful = await store.reinforce({
      scope: initial.scope,
      key: initial.key,
      outcome: "successful",
      weight: 2,
      provenance: { service: "source_control_manager", jobId: "job-1" },
    });
    expect(successful?.revision).toBe(2);
    expect(successful!.usefulness).toBeGreaterThan(initial.usefulness);

    const contradicted = await store.reinforce({
      scope: initial.scope,
      key: initial.key,
      outcome: "contradicted",
      provenance: { service: "workerpals", jobId: "job-2" },
    });
    expect(contradicted?.status).toBe("superseded");
    expect(await store.get({ scope: initial.scope, key: initial.key })).toBeNull();
    expect(
      await store.get({ scope: initial.scope, key: initial.key }, { statuses: ["superseded"] }),
    ).not.toBeNull();
    await store.close();
  });

  test("constrains observation outcomes in fresh and legacy SQLite databases", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-memory-outcome-schema-"));
    const freshPath = join(root, "fresh.sqlite");
    const legacyPath = join(root, "legacy.sqlite");
    try {
      const freshStore = new SqliteMemoryStore(freshPath);
      await freshStore.close();
      const freshDb = new Database(freshPath);
      const freshSchema = freshDb
        .query(
          `SELECT sql FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_observations'`,
        )
        .get() as { sql: string };
      expect(freshSchema.sql).toContain(
        "CHECK(outcome IN ('confirmed', 'successful', 'failed', 'contradicted'))",
      );
      freshDb.close();

      const legacyDb = new Database(legacyPath);
      legacyDb.exec(`
        CREATE TABLE memory_observations (
          id             TEXT PRIMARY KEY,
          memoryRecordId TEXT NOT NULL,
          outcome        TEXT NOT NULL,
          weight         REAL NOT NULL,
          evidenceJson   TEXT NOT NULL DEFAULT '[]',
          provenanceJson TEXT,
          createdAt      TEXT NOT NULL
        );
        INSERT INTO memory_observations (
          id, memoryRecordId, outcome, weight, evidenceJson, createdAt
        ) VALUES ('legacy-invalid', 'legacy-record', 'succeeded', 1, '[]',
          '2026-08-25T12:00:00.000Z');
      `);
      legacyDb.close();

      const migratedStore = new SqliteMemoryStore(legacyPath);
      await migratedStore.close();
      const migratedDb = new Database(legacyPath);
      expect(
        migratedDb
          .query(
            `SELECT COUNT(*) AS count FROM memory_observations
             WHERE id = 'legacy-invalid'`,
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        migratedDb
          .query(
            `SELECT name FROM sqlite_master
             WHERE type = 'trigger' AND name LIKE 'trg_memory_observations_valid_outcome_%'
             ORDER BY name`,
          )
          .all(),
      ).toHaveLength(2);
      expect(() =>
        migratedDb
          .query(
            `
          INSERT INTO memory_observations (
            id, memoryRecordId, outcome, weight, evidenceJson, createdAt
          ) VALUES ('new-invalid', 'legacy-record', 'succeeded', 1, '[]',
            '2026-08-25T12:00:01.000Z')
        `,
          )
          .run(),
      ).toThrow("invalid memory reinforcement outcome");
      expect(() =>
        migratedDb
          .query(
            `
          INSERT INTO memory_observations (
            id, memoryRecordId, outcome, weight, evidenceJson, createdAt
          ) VALUES ('new-valid', 'legacy-record', 'confirmed', 1, '[]',
            '2026-08-25T12:00:02.000Z')
        `,
          )
          .run(),
      ).not.toThrow();
      migratedDb.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort on Windows while SQLite releases WAL handles.
      }
    }
  });

  test("invalidates cited facts and prunes expired cache records", async () => {
    const store = new SqliteMemoryStore(":memory:");
    await store.put(fact("repo-a"));
    await store.put({
      ...fact("repo-a", "cache-key"),
      scope: { namespace: "repository_agent_cache", repositoryId: "repo-a" },
      kind: "exact_result",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(
      await store.invalidate({
        scope: fact("repo-a").scope,
        evidencePaths: ["src/router.ts"],
        reason: "blob hash changed",
      }),
    ).toBe(1);
    expect(await store.prune()).toBe(1);
    expect(
      await store.get(
        { scope: fact("repo-a").scope, key: fact("repo-a").key },
        { statuses: ["invalid"] },
      ),
    ).not.toBeNull();
    expect(
      await store.prune({
        updatedBefore: new Date(Date.now() + 1_000).toISOString(),
        statuses: ["invalid"],
      }),
    ).toBe(1);
    await store.close();
  });

  test("bounds the recency candidate window before application-level ranking", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-memory-candidates-"));
    const dbPath = join(root, "state.sqlite");
    try {
      const bootstrap = new SqliteMemoryStore(dbPath);
      await bootstrap.close();

      const db = new Database(dbPath);
      const insert = db.prepare(`
        INSERT INTO memory_records (
          id, namespace, repositoryId, sessionId, memoryKey, kind, subjectKey,
          summary, valueJson, tagsJson, evidenceJson, provenanceJson,
          confidence, usefulness, status, revision, createdAt, updatedAt
        ) VALUES (?, 'repository_fact', 'repo-window', '', ?, 'ownership', NULL,
          ?, NULL, '[]', '[]', '{"service":"repository_agent"}',
          0.5, 0.5, 'active', 1, ?, ?)
      `);
      const base = Date.parse("2026-01-01T00:00:00.000Z");
      const rowCount = MEMORY_LIMITS.searchCandidateRows + 4;
      db.transaction(() => {
        for (let index = 0; index < rowCount; index++) {
          const timestamp = new Date(base + index * 1_000).toISOString();
          const summary =
            index === 0
              ? "outside_candidate_window_token"
              : index === rowCount - 1
                ? "inside_candidate_window_token"
                : `ordinary row ${index}`;
          insert.run(`candidate-${index}`, `candidate-${index}`, summary, timestamp, timestamp);
        }
      })();
      db.close();

      const store = new SqliteMemoryStore(dbPath);
      expect(
        await store.search({
          scope: { namespace: "repository_fact", repositoryId: "repo-window" },
          text: "outside_candidate_window_token",
          maxItems: 10,
        }),
      ).toEqual([]);
      expect(
        (
          await store.search({
            scope: { namespace: "repository_fact", repositoryId: "repo-window" },
            text: "inside_candidate_window_token",
            maxItems: 10,
          })
        ).map((record) => record.key),
      ).toEqual([`candidate-${rowCount - 1}`]);
      await store.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort on Windows while SQLite releases WAL handles.
      }
    }
  });
});
