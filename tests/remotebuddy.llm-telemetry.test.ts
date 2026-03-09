import { afterEach, describe, expect, test } from "bun:test";
import { createLLMClient } from "../apps/remotebuddy/src/llm";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("remotebuddy llm telemetry", () => {
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

    const telemetryCall = calls.find((entry) => entry.url === "http://server.test/telemetry/llm-usage");
    expect(telemetryCall).toBeDefined();
    const payload = JSON.parse(String(telemetryCall?.init?.body ?? "{}")) as Record<string, unknown>;
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

  test("logs a warning when the telemetry endpoint returns a non-200 response", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "http://ollama.test/api/chat") {
          return new Response(JSON.stringify({ message: { content: "Queue depth steady." } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "http://server.test/telemetry/llm-usage") {
          return new Response("bad upstream", { status: 503 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const client = createLLMClient({
        service: "localbuddy",
        sessionId: "session-2",
        backend: "ollama",
        endpoint: "http://ollama.test/api/chat",
        model: "tiny-model",
        serverUrl: "http://server.test",
        authToken: "test-token",
      });
      const output = await client.generate({
        system: "Reply briefly.",
        messages: [{ role: "user", content: "Status update?" }],
        temperature: 0.1,
      });
      expect(output.text).toContain("Queue depth");
      expect(
        warnings.some((msg) =>
          msg.toLowerCase().includes("usage telemetry failed (localbuddy)"),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("logs a warning when telemetry reporting throws before reaching the server", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "http://ollama.test/api/chat") {
          return new Response(JSON.stringify({ message: { content: "Queue depth nominal." } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "http://server.test/telemetry/llm-usage") {
          throw new Error("network unavailable");
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const client = createLLMClient({
        service: "localbuddy",
        sessionId: "session-3",
        backend: "ollama",
        endpoint: "http://ollama.test/api/chat",
        model: "tiny-model",
        serverUrl: "http://server.test",
        authToken: "test-token",
      });
      const output = await client.generate({
        system: "Reply briefly.",
        messages: [{ role: "user", content: "Status update?" }],
        temperature: 0.1,
      });
      expect(output.text).toContain("Queue depth");
      expect(
        warnings.some((msg) =>
          msg.toLowerCase().includes("usage telemetry failed (localbuddy)"),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});
