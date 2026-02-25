import { describe, expect, test } from "bun:test";
import {
  ensureSessionExists,
  connectSessionWithRetry,
  SessionConnectionAbortedError,
} from "../packages/shared/src/session";

describe("ensureSessionExists", () => {
  test("returns server-provided session id", async () => {
    const sessionId = await ensureSessionExists({
      serverUrl: "http://example",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return { sessionId: "abc123" };
        },
      }) as Response,
    });
    expect(sessionId).toBe("abc123");
  });

  test("retries until success up to max attempts", async () => {
    let fetchCalls = 0;
    let retryNotices = 0;
    const sessionId = await ensureSessionExists({
      serverUrl: "http://example",
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      onRetry: () => {
        retryNotices += 1;
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        if (fetchCalls < 3) {
          throw new Error("boom");
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          async json() {
            return { sessionId: "xyz789" };
          },
        } as Response;
      },
    });
    expect(sessionId).toBe("xyz789");
    expect(fetchCalls).toBe(3);
    expect(retryNotices).toBe(2);
  });

  test("includes auth header and session payload when provided", async () => {
    let capturedHeaders: Record<string, string> | null = null;
    let capturedBody: string | null = null;
    await ensureSessionExists({
      serverUrl: "http://example",
      sessionId: "dev-session",
      authToken: "secret-token",
      fetchImpl: async (_url, init) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? null;
        capturedBody = typeof init?.body === "string" ? init.body : null;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          async json() {
            return { sessionId: "dev-session" };
          },
        } as Response;
      },
    });
    expect(capturedHeaders?.Authorization).toBe("Bearer secret-token");
    expect(capturedBody).toBe(JSON.stringify({ sessionId: "dev-session" }));
  });

  test("throws after exhausting retries", async () => {
    await expect(
      ensureSessionExists({
        serverUrl: "http://example",
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          statusText: "error",
          async json() {
            return {};
          },
        }) as Response,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("connectSessionWithRetry surface notices and aborts on shutdown signal", async () => {
    let fetchCalls = 0;
    let abort = false;
    const notices: number[] = [];
    await expect(
      connectSessionWithRetry({
        serverUrl: "http://example",
        baseDelayMs: 0,
        maxDelayMs: 0,
        fetchImpl: async () => {
          fetchCalls += 1;
          if (fetchCalls === 2) {
            abort = true;
          }
          throw new Error("boom");
        },
        shouldAbort: () => abort,
        onRetryNotice: ({ attempt }) => {
          notices.push(attempt);
        },
      }),
    ).rejects.toBeInstanceOf(SessionConnectionAbortedError);
    expect(fetchCalls).toBe(2);
    expect(notices).toEqual([1]);
  });
});
