import { afterEach, describe, expect, test } from "bun:test";
import { createLLMClient } from "../apps/remotebuddy/src/llm";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("remotebuddy llm telemetry", () => {
  test("an upstream abort cancels an Ollama response body and rejects with the caller reason", async () => {
    let requestSignal: AbortSignal | null = null;
    let bodyCancelled = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"message":'));
          },
          cancel() {
            bodyCancelled += 1;
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = createLLMClient({
      service: "repository_agent",
      backend: "ollama",
      endpoint: "http://ollama.test/api/chat",
      model: "tiny-model",
      httpTimeoutMs: 30_000,
    });
    const controller = new AbortController();
    const reason = new Error("repository request deadline expired");
    const operation = client.generate({
      system: "Answer briefly.",
      messages: [{ role: "user", content: "Status?" }],
      signal: controller.signal,
    });

    for (let attempt = 0; attempt < 20 && requestSignal == null; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(requestSignal).not.toBeNull();
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
    expect(bodyCancelled).toBe(1);
  });

  test("an upstream abort reaches OpenAI-compatible completion fetch and body work", async () => {
    let completionSignal: AbortSignal | null = null;
    let bodyCancelled = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({ data: [{ id: "gpt-test" }] });
      }
      completionSignal = init?.signal ?? null;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"choices":'));
          },
          cancel() {
            bodyCancelled += 1;
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = createLLMClient({
      service: "repository_agent",
      backend: "openai",
      endpoint: "http://openai.test/v1/chat/completions",
      apiKey: "test-key",
      model: "gpt-test",
      httpTimeoutMs: 30_000,
    });
    const controller = new AbortController();
    const reason = new Error("repository discovery timed out");
    const operation = client.generate({
      system: "Answer briefly.",
      messages: [{ role: "user", content: "Status?" }],
      signal: controller.signal,
    });

    for (let attempt = 0; attempt < 20 && completionSignal == null; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(completionSignal).not.toBeNull();
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(completionSignal?.aborted).toBe(true);
    expect(bodyCancelled).toBe(1);
  });

  test("reports the model identity returned by an OpenAI-compatible provider", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({ data: [{ id: "requested-model" }] });
      }
      return Response.json({
        model: "actual-provider-model",
        choices: [{ message: { content: "Ready." } }],
      });
    }) as typeof fetch;
    const client = createLLMClient({
      service: "repository_agent",
      backend: "openai",
      endpoint: "http://openai.test/v1/chat/completions",
      apiKey: "test-key",
      model: "requested-model",
    });

    const output = await client.generate({
      system: "Answer briefly.",
      messages: [{ role: "user", content: "Status?" }],
    });

    expect(output.provider).toBe("openai");
    expect(output.modelId).toBe("actual-provider-model");
  });

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
        return new Response(
          JSON.stringify({
            model: "actual-tiny-model",
            message: { content: "Queue depth is stable." },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
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
    expect(output.provider).toBe("ollama");
    expect(output.modelId).toBe("actual-tiny-model");
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
    expect(payload.modelId).toBe("actual-tiny-model");
    expect(payload.estimated).toBe(true);
    expect(payload.totalTokens).toBe(
      Number(payload.promptTokens ?? 0) + Number(payload.completionTokens ?? 0),
    );
    expect((telemetryCall?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-token",
    );
  });
});
