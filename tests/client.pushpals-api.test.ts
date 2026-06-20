import { describe, expect, test } from "bun:test";
import {
  fetchAutonomyInspiration,
  fetchJobLogsSnapshot,
  buildSessionEventsUrl,
  buildSessionMessageUrl,
  buildSessionWebSocketUrl,
} from "../apps/client/src/lib/pushpalsApi";

describe("pushpals client session transport URLs", () => {
  test("encodes cursor into the SSE URL without leaking auth tokens", () => {
    const url = buildSessionEventsUrl("http://localhost:3001", "dev/session", 42, "secret token");
    expect(url).toBe("http://localhost:3001/sessions/dev%2Fsession/events?after=42");
  });

  test("omits query parameters when cursor is absent", () => {
    const url = buildSessionEventsUrl("http://localhost:3001", "dev");
    expect(url).toBe("http://localhost:3001/sessions/dev/events");
  });

  test("builds the WebSocket transport URL without auth query fallback", () => {
    const url = buildSessionWebSocketUrl("https://pushpals.dev", "dev", 7, "topsecret");
    expect(url).toBe("wss://pushpals.dev/sessions/dev/ws?after=7");
  });

  test("builds the session message URL against the local server session endpoint", () => {
    const url = buildSessionMessageUrl("http://127.0.0.1:3001", "dev/session");
    expect(url).toBe("http://127.0.0.1:3001/sessions/dev%2Fsession/message");
  });

  test("encodes client presence metadata into session transport URLs", () => {
    const client = {
      clientId: "web-123",
      kind: "web",
      label: "Web Client",
      version: "1.2.3",
      platform: "web",
      repoRoot: "C:/repo/demo",
    };

    expect(buildSessionEventsUrl("http://localhost:3001", "dev", 0, undefined, client)).toBe(
      "http://localhost:3001/sessions/dev/events?clientId=web-123&clientKind=web&clientLabel=Web+Client&clientVersion=1.2.3&clientPlatform=web&clientRepoRoot=C%3A%2Frepo%2Fdemo",
    );
    expect(buildSessionWebSocketUrl("http://localhost:3001", "dev", 2, undefined, client)).toBe(
      "ws://localhost:3001/sessions/dev/ws?after=2&clientId=web-123&clientKind=web&clientLabel=Web+Client&clientVersion=1.2.3&clientPlatform=web&clientRepoRoot=C%3A%2Frepo%2Fdemo",
    );
  });

  test("fetchJobLogsSnapshot fetches bounded persisted job logs", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return Response.json({
        ok: true,
        logs: [
          {
            id: 7,
            jobId: "job/abc",
            ts: "2026-05-16T09:00:00.000Z",
            message: "hello from durable logs",
          },
        ],
      });
    }) as typeof fetch;

    try {
      const logs = await fetchJobLogsSnapshot("http://localhost:3001", "job/abc", undefined, 100);

      expect(requestedUrl).toBe("http://localhost:3001/jobs/job%2Fabc/logs?limit=100");
      expect(logs).toEqual([
        {
          id: 7,
          jobId: "job/abc",
          ts: "2026-05-16T09:00:00.000Z",
          message: "hello from durable logs",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fetchJobLogsSnapshot returns empty logs on non-OK or malformed responses", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response("server error", { status: 500 }),
      Response.json({ ok: true, logs: "not an array" }),
    ];
    globalThis.fetch = (async () =>
      responses.shift() ?? Response.json({ ok: true, logs: [] })) as typeof fetch;

    try {
      await expect(fetchJobLogsSnapshot("http://localhost:3001", "job-1")).resolves.toEqual([]);
      await expect(fetchJobLogsSnapshot("http://localhost:3001", "job-1")).resolves.toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fetchAutonomyInspiration fetches fresh inspiration patterns", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return Response.json({
        ok: true,
        patterns: [
          {
            id: 11,
            fingerprint: "fresh-1",
            sourceType: "internal_doc",
            sourceLabel: "pushpals:commit-history",
            sourceRefs: ["pushpals:commit-history"],
            algorithm: "commit_history_startup_stability",
            summary: "Bias a small startup stability task from recent local history.",
            risks: ["Historical bias can overweight past patterns."],
            validationIdeas: ["Check dispatch success after a clear."],
            tags: ["startup", "autonomy"],
            qualityScore: 0.87,
            freshnessScore: 0.42,
            seenCount: 2,
            firstSeenAt: "2026-06-19T15:33:21.000Z",
            lastSeenAt: "2026-06-19T15:35:21.000Z",
            updatedAt: "2026-06-19T15:35:21.000Z",
            metadata: { origin: "autonomy_engine_commit_history" },
          },
        ],
      });
    }) as typeof fetch;

    try {
      const patterns = await fetchAutonomyInspiration("http://localhost:3001", undefined, 250);

      expect(requestedUrl).toBe("http://localhost:3001/autonomy/inspiration?limit=100");
      expect(patterns).toEqual([
        {
          id: 11,
          fingerprint: "fresh-1",
          sourceType: "internal_doc",
          sourceLabel: "pushpals:commit-history",
          sourceUrl: null,
          sourceRefs: ["pushpals:commit-history"],
          algorithm: "commit_history_startup_stability",
          whenToUse: null,
          summary: "Bias a small startup stability task from recent local history.",
          risks: ["Historical bias can overweight past patterns."],
          validationIdeas: ["Check dispatch success after a clear."],
          tags: ["startup", "autonomy"],
          qualityScore: 0.87,
          freshnessScore: 0.42,
          seenCount: 2,
          firstSeenAt: "2026-06-19T15:33:21.000Z",
          lastSeenAt: "2026-06-19T15:35:21.000Z",
          updatedAt: "2026-06-19T15:35:21.000Z",
          metadata: { origin: "autonomy_engine_commit_history" },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fetchAutonomyInspiration returns empty patterns on non-OK or malformed responses", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response("server error", { status: 500 }),
      Response.json({ ok: true, patterns: "not an array" }),
    ];
    globalThis.fetch = (async () =>
      responses.shift() ?? Response.json({ ok: true, patterns: [] })) as typeof fetch;

    try {
      await expect(fetchAutonomyInspiration("http://localhost:3001")).resolves.toEqual([]);
      await expect(fetchAutonomyInspiration("http://localhost:3001")).resolves.toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
