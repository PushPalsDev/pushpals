import { afterEach, describe, expect, test } from "bun:test";
import { preflightServiceLlm } from "../apps/remotebuddy/src/llm";

const servers: Array<{ stop: (closeAll?: boolean) => void }> = [];

afterEach(() => {
  while (servers.length > 0) {
    const server = servers.pop();
    try {
      server?.stop(true);
    } catch {
      // best effort
    }
  }
});

describe("LLM preflight", () => {
  test("bounds a model-list response body that never finishes", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Headers arrive, but the provider never completes the body.
            },
          }),
          { status: 200 },
        );
      },
    });
    servers.push(server);
    const startedAt = Date.now();

    await expect(
      preflightServiceLlm({
        service: "localbuddy",
        backend: "openai",
        endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions`,
        apiKey: "test-key",
        model: "gpt-4.1-mini",
        httpTimeoutMs: 20,
      }),
    ).rejects.toThrow("model-list probe timed out after 20ms");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("passes when an OpenAI-compatible endpoint exposes the configured model", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "gpt-4.1-mini" }],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    await expect(
      preflightServiceLlm({
        service: "localbuddy",
        backend: "openai",
        endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions`,
        apiKey: "test-key",
        model: "gpt-4.1-mini",
      }),
    ).resolves.toBeUndefined();
  });

  test("fails fast when the configured model is missing from the endpoint", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "gpt-4.1-mini" }],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    await expect(
      preflightServiceLlm({
        service: "localbuddy",
        backend: "openai",
        endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions`,
        apiKey: "test-key",
        codexAuthMode: "api_key",
        model: "gpt-5-codex",
      }),
    ).rejects.toThrow('Configured OpenAI model "gpt-5-codex" is unavailable');
  });

  test("fails fast when openai_codex api-key mode has no API key configured", async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      await expect(
        preflightServiceLlm({
          service: "localbuddy",
          backend: "openai_codex",
          codexAuthMode: "api_key",
          apiKey: "",
          model: "gpt-5-codex",
        }),
      ).rejects.toThrow("openai_codex API-key auth requires OPENAI_API_KEY");
    } finally {
      if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });
});
