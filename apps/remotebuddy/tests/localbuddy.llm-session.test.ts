import { describe, expect, test } from "bun:test";
import { createLLMClient, type LLMClientDependencies } from "../src/llm";
import {
  loadPushPalsConfig,
  type PushPalsConfig,
} from "../../../packages/shared/src/config";

type ServiceId = "localbuddy" | "remotebuddy" | "workerpals";

type FetchCallRecord = {
  url: string;
  init?: RequestInit;
  body?: Record<string, unknown>;
};

type EnvSnapshot = Record<string, string | undefined>;

const BASE_CONFIG = loadPushPalsConfig({ reload: true });

function cloneConfig(config: PushPalsConfig): PushPalsConfig {
  return JSON.parse(JSON.stringify(config)) as PushPalsConfig;
}

function depsWithConfig(
  patch?: (cfg: PushPalsConfig) => void,
): LLMClientDependencies {
  return {
    loadConfig: () => {
      const copy = cloneConfig(BASE_CONFIG);
      patch?.(copy);
      return copy;
    },
  };
}

function createFetchRecorder() {
  const calls: FetchCallRecord[] = [];
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
        status: 200,
      });
    }

    const bodyText = typeof init?.body === "string" ? init.body : "";
    const parsedBody = bodyText ? JSON.parse(bodyText) : undefined;
    calls.push({ url, init, body: parsedBody });

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200 },
    );
  };
  return { calls, stub };
}

function swapFetch(mock: typeof fetch): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  return () => {
    globalThis.fetch = previous;
  };
}

function normalizeSessionTagValue(raw: string | undefined): string {
  const normalized = (raw ?? "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-");
  const collapsed = normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!collapsed) return "default";
  return collapsed.length <= 96 ? collapsed : collapsed.slice(0, 96);
}

function expectedSessionTag(service: ServiceId, sessionId?: string): string {
  return `pushpals-${service}-${normalizeSessionTagValue(sessionId)}`;
}

function captureEnv(keys: string[]): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of keys) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("localbuddy LLM session propagation", () => {
  test("attaches normalized session tag to LM Studio request payloads", async () => {
    const { stub, calls } = createFetchRecorder();
    const restore = swapFetch(stub);
    try {
      const deps = depsWithConfig((cfg) => {
        cfg.localbuddy.llm.backend = "lmstudio";
        cfg.localbuddy.llm.endpoint = "http://127.0.0.1:1234";
        cfg.localbuddy.llm.model = "local-model";
      });

      const client = createLLMClient(
        {
          service: "localbuddy",
          backend: "lmstudio",
          endpoint: "http://127.0.0.1:1234/v1/chat/completions",
          sessionId: "Session ABC",
          model: "local-model",
        },
        deps,
      );

      const output = await client.generate({
        system: "test system",
        messages: [{ role: "user", content: "ping" }],
      });
      expect(output.text).toBe("ok");

      const completionCall = calls.find(
        (call) => (call.init?.method ?? "GET").toUpperCase() === "POST",
      );
      expect(completionCall).toBeDefined();
      const headers = new Headers(
        (completionCall?.init?.headers as HeadersInit | undefined) ?? {},
      );
      const expectedTag = expectedSessionTag("localbuddy", "Session ABC");
      expect(headers.get("X-PushPals-Session-Id")).toBe(expectedTag);
      expect(headers.get("X-Session-Id")).toBe(expectedTag);
      expect(headers.get("X-Conversation-Id")).toBe(expectedTag);
      expect(completionCall?.body?.user).toBe(expectedTag);
      expect(completionCall?.body?.session_id).toBe(expectedTag);
      expect(completionCall?.body?.conversation_id).toBe(expectedTag);
    } finally {
      restore();
    }
  });

  test("defaults to config-backed session when dependencies are omitted", async () => {
    const { stub, calls } = createFetchRecorder();
    const restore = swapFetch(stub);
    const envKeys = [
      "LOCALBUDDY_LLM_BACKEND",
      "LOCALBUDDY_LLM_ENDPOINT",
      "LOCALBUDDY_LLM_MODEL",
      "LOCALBUDDY_LLM_SESSION_ID",
    ];
    const envSnapshot = captureEnv(envKeys);
    const overrideSession = "localbuddy-env-default";
    try {
      process.env.LOCALBUDDY_LLM_BACKEND = "lmstudio";
      process.env.LOCALBUDDY_LLM_ENDPOINT = "http://127.0.0.1:1234";
      process.env.LOCALBUDDY_LLM_MODEL = "local-model";
      process.env.LOCALBUDDY_LLM_SESSION_ID = overrideSession;
      loadPushPalsConfig({ reload: true });

      const client = createLLMClient({ service: "localbuddy" });
      const output = await client.generate({
        system: "system",
        messages: [{ role: "user", content: "ping" }],
      });
      expect(output.text).toBe("ok");

      const completionCall = calls.find(
        (call) => (call.init?.method ?? "GET").toUpperCase() === "POST",
      );
      expect(completionCall).toBeDefined();
      const headers = new Headers(
        (completionCall?.init?.headers as HeadersInit | undefined) ?? {},
      );
      const expectedTag = expectedSessionTag("localbuddy", overrideSession);
      expect(headers.get("X-PushPals-Session-Id")).toBe(expectedTag);
      expect(completionCall?.body?.user).toBe(expectedTag);
    } finally {
      restore();
      restoreEnv(envSnapshot);
      loadPushPalsConfig({ reload: true });
    }
  });

  test("throws when injected config omits the target service llm block", () => {
    const deps = depsWithConfig((cfg) => {
      Object.assign(cfg, {
        localbuddy: undefined as unknown as typeof cfg.localbuddy,
      });
    });
    expect(() => createLLMClient({ service: "localbuddy" }, deps)).toThrow(
      /missing localbuddy llm configuration/i,
    );
  });
});
