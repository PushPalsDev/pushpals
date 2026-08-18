import { afterEach, describe, expect, test } from "bun:test";
import { createLLMClient } from "../apps/remotebuddy/src/llm";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("remotebuddy llm telemetry", () => {
  test("bounds an Ollama completion body that never finishes", async () => {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Headers arrive, but the model server never completes the body.
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const client = createLLMClient({
      service: "remotebuddy",
      backend: "ollama",
      endpoint: "http://ollama.test/api/chat",
      model: "tiny-model",
      httpTimeoutMs: 20,
    });
    const startedAt = Date.now();

    await expect(
      client.generate({
        system: "Answer briefly.",
        messages: [{ role: "user", content: "Status?" }],
      }),
    ).rejects.toThrow("Ollama completion request timed out after 20ms");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("does not let a stalled telemetry body hold a completed model response", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://ollama.test/api/chat") {
        return Response.json({ message: { content: "Ready." } });
      }
      if (url === "http://server.test/telemetry/llm-usage") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Headers arrive, but the telemetry server never completes the body.
            },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = createLLMClient({
      service: "remotebuddy",
      backend: "ollama",
      endpoint: "http://ollama.test/api/chat",
      model: "tiny-model",
      serverUrl: "http://server.test",
      httpTimeoutMs: 20,
    });
    const startedAt = Date.now();

    const output = await client.generate({
      system: "Answer briefly.",
      messages: [{ role: "user", content: "Status?" }],
    });

    expect(output.text).toBe("Ready.");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("reports estimated ollama usage to the server telemetry endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });

      if (url === "http://ollama.test/api/chat") {
        return new Response(JSON.stringify({ message: { content: "Queue depth is stable." } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url === "http://server.test/telemetry/llm-usage") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = createLLMClient({
      service: "localbuddy",
      sessionId: "session-1",
      backend: "ollama",
      endpoint: "http://ollama.test/api/chat",
      model: "tiny-model",
      serverUrl: "http://server.test",
      authToken: "secret-token",
    });

    const output = await client.generate({
      system: "Answer in one sentence.",
      messages: [{ role: "user", content: "How is the queue doing?" }],
      temperature: 0.2,
    });

    expect(output.text).toContain("stable");
    expect(output.usage?.promptTokens).toBeGreaterThan(0);
    expect(output.usage?.completionTokens).toBeGreaterThan(0);

    const telemetryCall = calls.find(
      (entry) => entry.url === "http://server.test/telemetry/llm-usage",
    );
    expect(telemetryCall).toBeDefined();
    const payload = JSON.parse(String(telemetryCall?.init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(payload.service).toBe("localbuddy");
    expect(payload.backend).toBe("ollama");
    expect(payload.modelId).toBe("tiny-model");
    expect(payload.estimated).toBe(true);
    expect(payload.totalTokens).toBe(
      Number(payload.promptTokens ?? 0) + Number(payload.completionTokens ?? 0),
    );
    expect((telemetryCall?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-token",
    );
  });
});
