import { afterEach, describe, expect, test } from "bun:test";
import { answerLocalReadonlyQuery } from "./local_readonly";
import { RemotePlanner } from "./planner";
import { ToolRegistry } from "./tools";

const originalFetch = globalThis.fetch;
const originalWebFetchTimeout = process.env.PUSHPALS_LOCALBUDDY_WEB_FETCH_TIMEOUT_MS;
const originalWebSearchTimeout = process.env.PUSHPALS_LOCALBUDDY_WEB_SEARCH_TIMEOUT_MS;

function responseWithStalledBody(contentType = "application/json"): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {
        // Headers arrive, but a faulty peer never closes the response body.
      },
    }),
    { status: 200, headers: { "content-type": contentType } },
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWebFetchTimeout === undefined) {
    delete process.env.PUSHPALS_LOCALBUDDY_WEB_FETCH_TIMEOUT_MS;
  } else {
    process.env.PUSHPALS_LOCALBUDDY_WEB_FETCH_TIMEOUT_MS = originalWebFetchTimeout;
  }
  if (originalWebSearchTimeout === undefined) {
    delete process.env.PUSHPALS_LOCALBUDDY_WEB_SEARCH_TIMEOUT_MS;
  } else {
    process.env.PUSHPALS_LOCALBUDDY_WEB_SEARCH_TIMEOUT_MS = originalWebSearchTimeout;
  }
});

describe("LocalBuddy complete-response HTTP deadlines", () => {
  test("remote planning falls back when response headers never arrive", async () => {
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const planner = new RemotePlanner({
      endpoint: "http://127.0.0.1:1/v1/chat/completions",
      model: "test-model",
      timeoutMs: 20,
    });
    const startedAt = Date.now();

    const result = await planner.plan({ userText: "inspect this repository", history: [] });

    expect(result.tasks.length).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("system status returns a bounded diagnostic when the body stalls", async () => {
    globalThis.fetch = (async () => responseWithStalledBody()) as unknown as typeof fetch;
    const startedAt = Date.now();

    const result = await answerLocalReadonlyQuery("check system status", {
      repoRoot: process.cwd(),
      serverUrl: "http://127.0.0.1:1",
      authHeaders: {},
      httpTimeoutMs: 20,
    });

    expect(result).toContain("couldn't check system/database status");
    expect(result).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test.each([
    ["web.fetch", { url: "https://example.invalid/stalled" }, "WEB_FETCH"],
    ["web.search", { query: "stalled search" }, "WEB_SEARCH"],
  ] as const)("%s bounds response-body consumption", async (name, args, envSuffix) => {
    process.env[`PUSHPALS_LOCALBUDDY_${envSuffix}_TIMEOUT_MS`] = "20";
    globalThis.fetch = (async () =>
      responseWithStalledBody("text/html; charset=utf-8")) as unknown as typeof fetch;
    const tool = new ToolRegistry().get(name);
    expect(tool).toBeDefined();
    const startedAt = Date.now();

    const result = await tool!.execute(args, { repoRoot: process.cwd() });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
