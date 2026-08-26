import { describe, expect, test } from "bun:test";
import {
  InMemoryMemoryStore,
  MEMORY_LIMITS,
  MemoryConflictError,
  MemoryStoreClosedError,
  MemoryValidationError,
  serializedMemoryRecordChars,
  type MemoryPutInput,
  type MemoryReinforceInput,
  type MemoryStatus,
  type MemoryStore,
} from "shared";
import { SqliteMemoryStore } from "../apps/server/src/memory_store";

const SCOPE = { namespace: "repository_fact", repositoryId: "repo-conformance" } as const;
const ALL_STATUSES: MemoryStatus[] = ["active", "stale", "superseded", "invalid"];

type StoreFactory = {
  name: string;
  create: () => MemoryStore;
};

const factories: StoreFactory[] = [
  { name: "in-memory", create: () => new InMemoryMemoryStore() },
  { name: "sqlite", create: () => new SqliteMemoryStore(":memory:") },
];

function fact(key: string, overrides: Partial<MemoryPutInput> = {}): MemoryPutInput {
  return {
    scope: SCOPE,
    key,
    kind: "ownership",
    subjectKey: "route-shell",
    summary: `Repository fact ${key}`,
    value: { owner: "src/router.ts" },
    tags: ["routing", "ownership"],
    evidence: [{ path: "src/router.ts", blobOid: "blob-1" }],
    provenance: { service: "repository_agent", headSha: "head-1" },
    confidence: 0.6,
    usefulness: 0.7,
    ...overrides,
  };
}

for (const factory of factories) {
  describe(`MemoryStore conformance: ${factory.name}`, () => {
    test("ordinary upserts preserve expiry, status, invalidation, and learned scores", async () => {
      const store = factory.create();
      try {
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        const created = await store.put({
          ...fact("preserved"),
          expiresAt,
        });
        expect(
          await store.invalidate({
            scope: SCOPE,
            keys: ["preserved"],
            reason: "source changed",
          }),
        ).toBe(1);
        const invalidated = await store.get(
          { scope: SCOPE, key: "preserved" },
          { statuses: ["invalid"] },
        );
        expect(invalidated?.invalidatedAt).not.toBeNull();

        const upserted = await store.put({
          ...fact("preserved"),
          summary: "New evidence describes the same fact.",
          confidence: 0.01,
          usefulness: 0.02,
        });
        expect(upserted.status).toBe("invalid");
        expect(upserted.expiresAt).toBe(expiresAt);
        expect(upserted.invalidatedAt).toBe(invalidated?.invalidatedAt);
        expect(upserted.invalidationReason).toBe("source changed");
        expect(upserted.confidence).toBe(created.confidence);
        expect(upserted.usefulness).toBe(created.usefulness);

        const replaced = await store.put(
          {
            ...fact("preserved"),
            status: "stale",
            expiresAt: null,
            confidence: 0.2,
            usefulness: 0.3,
          },
          { expectedRevision: upserted.revision },
        );
        expect(replaced.status).toBe("stale");
        expect(replaced.expiresAt).toBeNull();
        expect(replaced.invalidatedAt).toBeNull();
        expect(replaced.invalidationReason).toBeNull();
        expect(replaced.confidence).toBe(0.2);
        expect(replaced.usefulness).toBe(0.3);

        const learned = await store.reinforce({
          scope: SCOPE,
          key: "preserved",
          outcome: "successful",
          weight: 2,
        });
        expect(learned?.status).toBe("active");
        expect(learned?.observations).toHaveLength(1);

        const afterLearning = await store.put({
          ...fact("preserved"),
          confidence: 0.01,
          usefulness: 0.01,
        });
        expect(afterLearning.confidence).toBe(learned?.confidence);
        expect(afterLearning.usefulness).toBe(learned?.usefulness);
        expect(afterLearning.observations).toEqual(learned?.observations);
      } finally {
        await store.close();
      }
    });

    test("search requires all evidence paths while invalidation matches any path", async () => {
      const store = factory.create();
      try {
        await store.put({
          ...fact("both"),
          evidence: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        });
        await store.put({ ...fact("only-a"), evidence: [{ path: "src/a.ts" }] });
        await store.put({ ...fact("only-b"), evidence: [{ path: "src/b.ts" }] });
        await store.put({ ...fact("neither"), evidence: [{ path: "src/c.ts" }] });

        const matched = await store.search({
          scope: SCOPE,
          evidencePaths: ["src\\a.ts", "src/b.ts"],
          maxItems: 20,
        });
        expect(matched.map((record) => record.key)).toEqual(["both"]);

        const invalidated = await store.invalidate({
          scope: SCOPE,
          evidencePaths: ["src/a.ts", "src/b.ts"],
          reason: "one or more evidence blobs changed",
        });
        expect(invalidated).toBe(3);
        expect(
          await store.get({ scope: SCOPE, key: "neither" }, { statuses: ALL_STATUSES }),
        ).not.toBeNull();
      } finally {
        await store.close();
      }
    });

    test("search uses bounded learned quality after lexical relevance", async () => {
      const store = factory.create();
      try {
        await store.put({
          ...fact("older-high-quality"),
          summary: "Shared searchable topic",
          tags: ["topic_abcdef"],
          confidence: 4,
          usefulness: 2,
        });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
        await store.put({
          ...fact("newer-low-quality"),
          summary: "Shared searchable topic",
          tags: ["topic_abcdef"],
          confidence: -2,
          usefulness: -1,
        });

        const matched = await store.search({
          scope: SCOPE,
          text: "topic_abcdef",
          maxItems: 10,
        });
        expect(matched.map((record) => record.key)).toEqual([
          "older-high-quality",
          "newer-low-quality",
        ]);
        expect(matched[0]?.confidence).toBe(1);
        expect(matched[0]?.usefulness).toBe(1);
        expect(matched[1]?.confidence).toBe(0);
        expect(matched[1]?.usefulness).toBe(0);
      } finally {
        await store.close();
      }
    });

    test("search budgets the complete serialized records and skips oversized candidates", async () => {
      const store = factory.create();
      try {
        const small = await store.put({
          ...fact("small-result"),
          summary: "A small searchable result.",
          tags: ["serialized_budget_token"],
          value: { size: "small" },
        });
        for (let index = 0; index < 140; index++) {
          await store.put({
            ...fact(`oversized-${index.toString().padStart(3, "0")}`),
            summary: "A short summary must not hide the large serialized value.",
            tags: ["serialized_budget_token"],
            value: { payload: "x".repeat(8_000), index },
          });
        }

        const maxChars = serializedMemoryRecordChars(small);
        const matched = await store.search({
          scope: SCOPE,
          text: "serialized_budget_token",
          maxItems: MEMORY_LIMITS.searchMaxItems,
          maxChars,
        });
        expect(matched.map((record) => record.key)).toEqual(["small-result"]);
        expect(
          matched.reduce((total, record) => total + serializedMemoryRecordChars(record), 0),
        ).toBeLessThanOrEqual(maxChars);
      } finally {
        await store.close();
      }
    });

    test("address limits reject instead of truncating or collapsing distinct identifiers", async () => {
      const store = factory.create();
      try {
        const spaced = await store.put(fact("route  owner"));
        const compact = await store.put(fact("route owner"));
        expect(spaced.id).not.toBe(compact.id);
        expect((await store.get({ scope: SCOPE, key: "route  owner" }))?.id).toBe(spaced.id);
        expect((await store.get({ scope: SCOPE, key: "route owner" }))?.id).toBe(compact.id);

        const overlongInputs: MemoryPutInput[] = [
          {
            ...fact("namespace-limit"),
            scope: { ...SCOPE, namespace: "n".repeat(MEMORY_LIMITS.namespaceChars + 1) },
          },
          {
            ...fact("repository-limit"),
            scope: { ...SCOPE, repositoryId: "r".repeat(MEMORY_LIMITS.repositoryIdChars + 1) },
          },
          {
            ...fact("session-limit"),
            scope: { ...SCOPE, sessionId: "s".repeat(MEMORY_LIMITS.sessionIdChars + 1) },
          },
          { ...fact("k".repeat(MEMORY_LIMITS.keyChars + 1)) },
        ];
        for (const input of overlongInputs) {
          await expect(store.put(input)).rejects.toBeInstanceOf(TypeError);
        }
      } finally {
        await store.close();
      }
    });

    test("invalidation is not truncated by search result limits", async () => {
      const store = factory.create();
      try {
        for (let index = 0; index < 137; index++) {
          await store.put({
            ...fact(`bulk-${index}`),
            evidence: [{ path: "src/shared.ts", blobOid: `blob-${index}` }],
          });
        }
        expect(await store.invalidate({ scope: SCOPE, evidencePaths: ["src/shared.ts"] })).toBe(
          137,
        );
      } finally {
        await store.close();
      }
    });

    test("reinforcement uses one scoring and state-transition rule", async () => {
      const store = factory.create();
      try {
        await store.put({ ...fact("learning"), status: "stale" });
        const successful = await store.reinforce({
          scope: SCOPE,
          key: "learning",
          outcome: "successful",
          weight: 2,
        });
        expect(successful?.confidence).toBeCloseTo(0.72, 10);
        expect(successful?.usefulness).toBeCloseTo(0.772, 10);
        expect(successful?.status).toBe("active");

        const failed = await store.reinforce({
          scope: SCOPE,
          key: "learning",
          outcome: "failed",
          weight: 0.5,
        });
        expect(failed?.confidence).toBeCloseTo(0.63, 10);
        expect(failed?.usefulness).toBeCloseTo(0.6948, 10);

        const contradicted = await store.reinforce({
          scope: SCOPE,
          key: "learning",
          outcome: "contradicted",
          evidence: [{ path: "src/replacement.ts", blobOid: "replacement" }],
          provenance: { service: "source_control_manager", jobId: "job-1" },
        });
        expect(contradicted?.confidence).toBeCloseTo(0.4725, 10);
        expect(contradicted?.usefulness).toBeCloseTo(0.55584, 10);
        expect(contradicted?.status).toBe("superseded");
        expect(contradicted?.evidence.map((entry) => entry.path)).toContain("src/replacement.ts");
        expect(contradicted?.provenance).toEqual({
          service: "repository_agent",
          headSha: "head-1",
        });
        expect(contradicted?.observations).toHaveLength(3);
        expect(contradicted?.observations.map((observation) => observation.weight)).toEqual([
          2, 0.5, 1,
        ]);
        expect(contradicted?.observations.at(-1)?.provenance).toEqual({
          service: "source_control_manager",
          jobId: "job-1",
        });
        expect(contradicted?.observations.at(-1)?.evidence).toEqual([
          { path: "src/replacement.ts", blobOid: "replacement" },
        ]);
        expect(
          Number.isFinite(Date.parse(contradicted?.observations.at(-1)?.observedAt ?? "")),
        ).toBe(true);

        const duplicate = await store.reinforce({
          scope: SCOPE,
          key: "learning",
          outcome: "contradicted",
          evidence: [{ path: "src/replacement.ts", blobOid: "replacement" }],
          provenance: { service: "source_control_manager", jobId: "job-1" },
        });
        expect(duplicate?.revision).toBe(contradicted?.revision);
        expect(duplicate?.confidence).toBe(contradicted?.confidence);
        expect(duplicate?.observations).toEqual(contradicted?.observations);

        const explicitEvent = await store.reinforce({
          scope: SCOPE,
          key: "learning",
          outcome: "confirmed",
          observationId: "authoritative-event-1",
          weight: 1,
          evidence: [
            { path: "src/a.ts", blobOid: "a" },
            { path: "src/b.ts", blobOid: "b" },
          ],
          provenance: { service: "source_control_manager", jobId: "job-explicit" },
        });
        const identicalRetry = await store.reinforce({
          scope: SCOPE,
          key: "learning",
          outcome: "confirmed",
          observationId: "authoritative-event-1",
          weight: 1,
          evidence: [
            { path: "src/b.ts", blobOid: "b" },
            { path: "src/a.ts", blobOid: "a" },
          ],
          provenance: { service: "source_control_manager", jobId: "job-explicit" },
        });
        expect(identicalRetry?.revision).toBe(explicitEvent?.revision);
        expect(identicalRetry?.confidence).toBe(explicitEvent?.confidence);
        expect(identicalRetry?.observations).toEqual(explicitEvent?.observations);

        for (const conflicting of [
          { outcome: "failed" as const, weight: 1 },
          { outcome: "confirmed" as const, weight: 4 },
          {
            outcome: "confirmed" as const,
            weight: 1,
            evidence: [{ path: "src/different.ts", blobOid: "different" }],
          },
          {
            outcome: "confirmed" as const,
            weight: 1,
            evidence: [
              { path: "src/a.ts", blobOid: "a" },
              { path: "src/b.ts", blobOid: "b" },
            ],
            provenance: { service: "workerpals", jobId: "job-explicit" },
          },
        ]) {
          await expect(
            store.reinforce({
              scope: SCOPE,
              key: "learning",
              observationId: "authoritative-event-1",
              evidence: [
                { path: "src/a.ts", blobOid: "a" },
                { path: "src/b.ts", blobOid: "b" },
              ],
              provenance: { service: "source_control_manager", jobId: "job-explicit" },
              ...conflicting,
            }),
          ).rejects.toBeInstanceOf(MemoryConflictError);
        }
        const afterConflicts = await store.get(
          { scope: SCOPE, key: "learning" },
          { statuses: ALL_STATUSES },
        );
        expect(afterConflicts?.revision).toBe(explicitEvent?.revision);
        expect(afterConflicts?.observations).toEqual(explicitEvent?.observations);
      } finally {
        await store.close();
      }
    });

    test("malformed reinforcement outcomes never mutate records or observations", async () => {
      const store = factory.create();
      try {
        const original = await store.put(fact("invalid-outcome"));
        for (const outcome of [undefined, null, "succeeded", " confirmed ", 1, {}]) {
          await expect(
            store.reinforce({
              scope: SCOPE,
              key: original.key,
              outcome: outcome as MemoryReinforceInput["outcome"],
              observationId: "invalid-outcome-event",
            }),
          ).rejects.toBeInstanceOf(MemoryValidationError);
        }
        const unchanged = await store.get(
          { scope: SCOPE, key: original.key },
          { statuses: ALL_STATUSES },
        );
        expect(unchanged).toEqual(original);
      } finally {
        await store.close();
      }
    });

    test("reinforcement fences a reused address by immutable record id", async () => {
      const store = factory.create();
      try {
        const original = await store.put({
          ...fact("record-id-fence"),
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        });
        const matched = await store.reinforce({
          scope: SCOPE,
          key: "record-id-fence",
          expectedId: original.id,
          outcome: "successful",
          observationId: "matched-record-outcome",
        });
        expect(matched?.id).toBe(original.id);
        expect(matched?.revision).toBe(original.revision + 1);

        expect(await store.prune({ scope: SCOPE })).toBe(1);
        const replacement = await store.put(fact("record-id-fence"), {
          expectedRevision: 0,
        });
        expect(replacement.id).not.toBe(original.id);

        await expect(
          store.reinforce({
            scope: SCOPE,
            key: "record-id-fence",
            expectedId: original.id,
            outcome: "failed",
            observationId: "stale-record-outcome",
          }),
        ).rejects.toBeInstanceOf(MemoryConflictError);
        const unchanged = await store.get({ scope: SCOPE, key: "record-id-fence" });
        expect(unchanged?.id).toBe(replacement.id);
        expect(unchanged?.revision).toBe(replacement.revision);
        expect(unchanged?.observations).toEqual([]);
      } finally {
        await store.close();
      }
    });

    test("reinforcement history is deduplicated and bounded to the latest 256 events", async () => {
      const store = factory.create();
      try {
        await store.put(fact("bounded-learning"));
        for (let index = 0; index < 270; index++) {
          await store.reinforce({
            scope: SCOPE,
            key: "bounded-learning",
            outcome: "confirmed",
            observationId: `event-${index}`,
            weight: 0,
            provenance: { service: "source_control_manager", requestId: `request-${index}` },
          });
        }
        const recalled = await store.get({ scope: SCOPE, key: "bounded-learning" });
        expect(recalled?.observations).toHaveLength(256);
        expect(new Set(recalled?.observations.map((entry) => entry.id)).size).toBe(256);
        expect(recalled?.observations[0]?.provenance?.requestId).toBe("request-14");
        expect(recalled?.observations.at(-1)?.provenance?.requestId).toBe("request-269");
        expect(recalled?.provenance).toEqual({
          service: "repository_agent",
          headSha: "head-1",
        });
      } finally {
        await store.close();
      }
    });

    test("prune removes expired records and only age-prunes terminal records on request", async () => {
      const store = factory.create();
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      const ageCutoff = new Date(Date.now() + 120_000).toISOString();
      const otherScope = { ...SCOPE, repositoryId: "repo-other" };
      try {
        await store.put({ ...fact("expired-active"), expiresAt: past });
        await store.put({ ...fact("expired-stale"), status: "stale", expiresAt: past });
        await store.put({ ...fact("future-active"), expiresAt: future });
        await store.put({ ...fact("terminal-invalid"), status: "invalid" });
        await store.put({ ...fact("terminal-superseded"), status: "superseded" });
        await store.put({ ...fact("other-expired"), scope: otherScope, expiresAt: past });

        expect(await store.prune({ scope: SCOPE })).toBe(2);
        expect(
          await store.get({ scope: SCOPE, key: "terminal-invalid" }, { statuses: ALL_STATUSES }),
        ).not.toBeNull();
        expect(
          await store.get(
            { scope: otherScope, key: "other-expired" },
            { includeExpired: true, statuses: ALL_STATUSES },
          ),
        ).not.toBeNull();

        expect(
          await store.prune({ scope: SCOPE, statuses: ["invalid"], updatedBefore: ageCutoff }),
        ).toBe(1);
        expect(await store.prune({ scope: SCOPE, updatedBefore: ageCutoff })).toBe(1);
        expect(
          await store.get({ scope: SCOPE, key: "future-active" }, { statuses: ALL_STATUSES }),
        ).not.toBeNull();
      } finally {
        await store.close();
      }
    });

    test("closed stores reject subsequent operations with the shared error", async () => {
      const store = factory.create();
      await store.close();
      await expect(store.search({ scope: SCOPE })).rejects.toBeInstanceOf(MemoryStoreClosedError);
    });
  });
}
