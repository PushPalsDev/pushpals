/**
 * LLM client abstraction with two supported backends:
 * - LM Studio
 * - Ollama
 */

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMGenerateInput {
  system: string;
  messages: LLMMessage[];
  // Request JSON output when provider supports it.
  json?: boolean;
  // Max tokens to generate.
  maxTokens?: number;
  temperature?: number;
}

export interface LLMGenerateOutput {
  text: string;
  // Usage stats if available.
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMClient {
  generate(input: LLMGenerateInput): Promise<LLMGenerateOutput>;
}

type LlmBackend = "lmstudio" | "ollama";

const DEFAULT_LMSTUDIO_ENDPOINT = "http://127.0.0.1:1234";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/chat";
const DEFAULT_MODEL = "local-model";

function normalizeBackend(value: string | null | undefined): LlmBackend | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "lmstudio") return "lmstudio";
  if (normalized === "ollama") return "ollama";
  return null;
}

function configuredBackend(endpoint: string): LlmBackend {
  const explicit = normalizeBackend(process.env.PUSHPALS_LLM_BACKEND);
  if (explicit) return explicit;
  return endpoint.includes("/api/chat") ? "ollama" : "lmstudio";
}

function normalizeLmStudioEndpoint(endpoint: string): string {
  const source = (endpoint.trim() || DEFAULT_LMSTUDIO_ENDPOINT).replace(/\/+$/, "");
  if (source.includes("/chat/completions")) return source;
  if (source.endsWith("/v1")) return `${source}/chat/completions`;
  return `${source}/v1/chat/completions`;
}

function normalizeOllamaEndpoint(endpoint: string): string {
  const source = (endpoint.trim() || DEFAULT_OLLAMA_ENDPOINT).replace(/\/+$/, "");
  if (source.endsWith("/api/chat")) return source;
  return `${source}/api/chat`;
}

function lmStudioHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}

export class LmStudioClient implements LLMClient {
  private endpoint: string;
  private apiKey: string;
  private model: string;

  constructor(opts?: { endpoint?: string; apiKey?: string; model?: string }) {
    const rawEndpoint = opts?.endpoint ?? process.env.LLM_ENDPOINT ?? DEFAULT_LMSTUDIO_ENDPOINT;
    this.endpoint = normalizeLmStudioEndpoint(rawEndpoint);
    this.apiKey = opts?.apiKey ?? process.env.LLM_API_KEY ?? "lmstudio";
    this.model = opts?.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: input.system },
      ...input.messages,
    ];

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: input.maxTokens ?? 2048,
      temperature: input.temperature ?? 0.3,
    };

    if (input.json) {
      body.response_format = { type: "json_object" };
    }

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: lmStudioHeaders(this.apiKey),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LM Studio API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];

    return {
      text: choice?.message?.content ?? "",
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }
}

export class OllamaClient implements LLMClient {
  private endpoint: string;
  private model: string;

  constructor(opts?: { endpoint?: string; model?: string }) {
    const rawEndpoint = opts?.endpoint ?? process.env.LLM_ENDPOINT ?? DEFAULT_OLLAMA_ENDPOINT;
    this.endpoint = normalizeOllamaEndpoint(rawEndpoint);
    this.model = opts?.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: input.system },
        ...input.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      stream: false,
      options: {
        temperature: input.temperature ?? 0.3,
      },
    };

    if (typeof input.maxTokens === "number") {
      (body.options as Record<string, unknown>).num_predict = input.maxTokens;
    }

    if (input.json) {
      body.format = "json";
    }

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as any;
    return { text: data.message?.content ?? "" };
  }
}

export function createLLMClient(): LLMClient {
  const endpoint = process.env.LLM_ENDPOINT ?? "";
  const backend = configuredBackend(endpoint);

  if (backend === "ollama") {
    console.log("[LLM] Using Ollama backend");
    return new OllamaClient();
  }

  console.log("[LLM] Using LM Studio backend");
  return new LmStudioClient();
}
