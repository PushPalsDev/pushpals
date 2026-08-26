import { describe, expect, test } from "bun:test";
import {
  InMemoryMemoryStore,
  MemoryConflictError,
  MemoryHttpClient,
  MemoryHttpError,
  MemoryStoreClosedError,
  MemoryValidationError,
  resolveMemoryReinforcement,
  type MemoryRecord,
} from "shared";

const SCOPE = { namespace: "repository.semantic", repositoryId: "repo_123" } as const;

function input(key: string, summary: string) {
  return {
    scope: SCOPE,
    key,
    kind: "architecture",
    subjectKey: "apps/api",
    summary,
    value: { owner: "api", stable: true },
    tags: ["API", "architecture", "API"],
    evidence: [{ path: "apps/api/package.json", blobOid: "abc1234" }],
    provenance: { service: "repository-agent", runId: "run-1", headSha: "deadbeef" },
    confidence: 0.6,
    usefulness: 0.7,
  };
}

describe("shared memory contract", () => {
  test("stores defensive copies and supports compare-and-set revisions", async () => {
    const store = new InMemoryMemoryStore();
    const created = await store.put(input("api-owner", "The API package owns HTTP routing."), {
      expectedRevision: 0,
    });

    expect(created.revision).toBe(1);
    expect(created.tags).toEqual(["API", "architecture"]);
    created.tags.push("caller-mutation");
    if (created.value && !Array.isArray(created.value)) created.value.owner = "mutated";

    const recalled = await store.get({ scope: SCOPE, key: "api-owner" });
    expect(recalled?.tags).toEqual(["API", "architecture"]);
    expect(recalled?.value).toEqual({ owner: "api", stable: true });

    await expect(
      store.put(input("api-owner", "A stale writer should lose."), { expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(MemoryConflictError);

    const updated = await store.put(input("api-owner", "The API owns public HTTP routes."), {
      expectedRevision: 1,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.revision).toBe(2);
    expect(updated.summary).toContain("public HTTP routes");
  });

  test("search is repository-scoped, relevant, filtered, and bounded", async () => {
    const store = new InMemoryMemoryStore();
    await store.put(input("api-owner", "HTTP routing and API request ownership."));
    await store.put({
      ...input("database-owner", "SQLite schema and durable persistence ownership."),
      subjectKey: "apps/server",
      tags: ["database"],
    });
    await store.put({
      ...input("other-repo", "HTTP routing in another checkout."),
      scope: { ...SCOPE, repositoryId: "repo_other" },
    });

    const records = await store.search({
      scope: SCOPE,
      text: "API HTTP",
      tags: ["architecture"],
      maxItems: 1,
      maxChars: 1_000,
    });
    expect(records.map((record) => record.key)).toEqual(["api-owner"]);
  });

  test("invalidates by evidence and reinforcement adjusts durable confidence", async () => {
    const store = new InMemoryMemoryStore();
    const original = await store.put(input("api-owner", "API ownership."));
    const confirmed = await store.reinforce({
      scope: SCOPE,
      key: "api-owner",
      outcome: "successful",
      evidence: [{ path: "apps/api/routes.ts", blobOid: "def5678" }],
      provenance: { service: "workerpals", jobId: "job-1" },
    });
    expect(confirmed?.confidence).toBeGreaterThan(original.confidence);
    expect(confirmed?.usefulness).toBeGreaterThan(original.usefulness);
    expect(confirmed?.revision).toBe(2);
    expect(confirmed?.evidence.map((entry) => entry.path)).toContain("apps/api/routes.ts");

    const invalidated = await store.invalidate({
      scope: SCOPE,
      evidencePaths: ["apps/api/package.json"],
      reason: "evidence blob changed",
    });
    expect(invalidated).toBe(1);
    expect(await store.get({ scope: SCOPE, key: "api-owner" })).toBeNull();
    const inactive = await store.get({ scope: SCOPE, key: "api-owner" }, { statuses: ["invalid"] });
    expect(inactive?.status).toBe("invalid");
    expect(inactive?.invalidationReason).toBe("evidence blob changed");
  });

  test("rejects unknown reinforcement outcomes before applying the learning rule", () => {
    expect(() =>
      resolveMemoryReinforcement(
        { confidence: 0.6, usefulness: 0.7, status: "active" },
        "succeeded" as never,
      ),
    ).toThrow(MemoryValidationError);
  });

  test("expires, prunes, rejects unsafe evidence, and closes deterministically", async () => {
    let nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const store = new InMemoryMemoryStore({ now: () => new Date(nowMs) });
    await store.put({ ...input("temporary", "Short-lived analysis."), ttlMs: 1_000 });
    nowMs += 1_001;
    expect(await store.get({ scope: SCOPE, key: "temporary" })).toBeNull();
    expect(
      await store.get({ scope: SCOPE, key: "temporary" }, { includeExpired: true }),
    ).not.toBeNull();
    expect(await store.prune()).toBe(1);

    await expect(
      store.put({
        ...input("unsafe", "Unsafe evidence."),
        evidence: [{ path: "../outside.txt" }],
      }),
    ).rejects.toBeInstanceOf(TypeError);

    await store.close();
    await expect(store.search({ scope: SCOPE })).rejects.toBeInstanceOf(MemoryStoreClosedError);
  });
});

describe("MemoryHttpClient", () => {
  test("uses bounded authenticated endpoint envelopes for every operation", async () => {
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      callerService: string | null;
      authority: string | null;
      body: unknown;
    }> = [];
    const record: MemoryRecord = {
      id: "memory-1",
      scope: SCOPE,
      key: "api-owner",
      kind: "architecture",
      subjectKey: "apps/api",
      summary: "API ownership.",
      value: null,
      tags: [],
      evidence: [],
      observations: [],
      provenance: { service: "repository-agent" },
      confidence: 0.5,
      usefulness: 0.5,
      status: "active",
      revision: 1,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
      expiresAt: null,
      invalidatedAt: null,
      invalidationReason: null,
    };
    const fetchImpl = async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      calls.push({
        url,
        method: String(init?.method ?? "GET"),
        authorization: new Headers(init?.headers).get("authorization"),
        callerService: new Headers(init?.headers).get("x-pushpals-memory-caller"),
        authority: new Headers(init?.headers).get("x-pushpals-memory-authority"),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      const path = new URL(url).pathname;
      const payload =
        path === "/memory/search"
          ? { ok: true, records: [record] }
          : path === "/memory/invalidate" || path === "/memory/prune"
            ? { ok: true, count: 1 }
            : { ok: true, record };
      return Response.json(payload);
    };
    const client = new MemoryHttpClient({
      serverUrl: "http://127.0.0.1:3001/",
      authToken: "local-token",
      callerService: "repository_agent",
      authority: "repository_agent",
      fetchImpl,
      timeoutMs: 500,
    });

    await client.put(input("api-owner", "API ownership."));
    await client.get({ scope: SCOPE, key: "api-owner" });
    await client.search({ scope: SCOPE });
    await client.invalidate({ scope: SCOPE });
    await client.reinforce({
      scope: SCOPE,
      key: "api-owner",
      expectedId: "memory-1",
      outcome: "confirmed",
    });
    await client.prune();

    expect(calls.map((call) => [new URL(call.url).pathname, call.method])).toEqual([
      ["/memory/records", "PUT"],
      ["/memory/get", "POST"],
      ["/memory/search", "POST"],
      ["/memory/invalidate", "POST"],
      ["/memory/reinforce", "POST"],
      ["/memory/prune", "POST"],
    ]);
    expect(calls.every((call) => call.authorization === "Bearer local-token")).toBe(true);
    expect(calls.every((call) => call.callerService === "repository_agent")).toBe(true);
    expect(calls.every((call) => call.authority === "repository_agent")).toBe(true);
    expect(calls.find((call) => new URL(call.url).pathname === "/memory/reinforce")?.body).toEqual({
      input: {
        scope: SCOPE,
        key: "api-owner",
        expectedId: "memory-1",
        outcome: "confirmed",
      },
    });
  });

  test("maps HTTP conflicts and enforces a hard deadline", async () => {
    const conflict = new MemoryHttpClient({
      serverUrl: "http://127.0.0.1:3001",
      fetchImpl: async () =>
        Response.json({ ok: false, message: "revision conflict" }, { status: 409 }),
    });
    await expect(conflict.put(input("api-owner", "API ownership."))).rejects.toBeInstanceOf(
      MemoryConflictError,
    );

    const staleRecord = new MemoryHttpClient({
      serverUrl: "http://127.0.0.1:3001",
      fetchImpl: async () =>
        Response.json(
          { ok: false, code: "record_conflict", message: "record identity changed" },
          { status: 409 },
        ),
    });
    try {
      await staleRecord.reinforce({
        scope: SCOPE,
        key: "api-owner",
        expectedId: "stale-memory-id",
        outcome: "confirmed",
      });
      throw new Error("expected stale record conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).code).toBe("record_conflict");
    }

    const invalidOutcome = new MemoryHttpClient({
      serverUrl: "http://127.0.0.1:3001",
      fetchImpl: async () =>
        Response.json(
          {
            ok: false,
            code: "invalid_reinforcement_outcome",
            message: "invalid outcome",
          },
          { status: 400 },
        ),
    });
    try {
      await invalidOutcome.reinforce({
        scope: SCOPE,
        key: "api-owner",
        outcome: "confirmed",
      });
      throw new Error("expected invalid reinforcement outcome");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryHttpError);
      expect((error as MemoryHttpError).status).toBe(400);
      expect((error as MemoryHttpError).code).toBe("invalid_reinforcement_outcome");
    }

    const hanging = new MemoryHttpClient({
      serverUrl: "http://127.0.0.1:3001",
      timeoutMs: 10,
      fetchImpl: () => new Promise<Response>(() => undefined),
    });
    await expect(hanging.search({ scope: SCOPE })).rejects.toThrow("timed out");
  });
});
