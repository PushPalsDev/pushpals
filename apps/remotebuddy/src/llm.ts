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
const DEFAULT_LMSTUDIO_CONTEXT_WINDOW = 4096;
const DEFAULT_LMSTUDIO_MIN_OUTPUT_TOKENS = 256;
const DEFAULT_LMSTUDIO_TOKEN_SAFETY_MARGIN = 64;
const REMOTEBUDDY_JSON_RESPONSE_SCHEMA: Record<string, unknown> = {
  name: "remotebuddy_response",
  strict: false,
  schema: {
    type: "object",
    properties: {
      assistant_message: { type: "string" },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            jobs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string" },
                  params: { type: "object" },
                },
                required: ["kind"],
                additionalProperties: true,
              },
            },
          },
          required: ["taskId", "title"],
          additionalProperties: true,
        },
      },
    },
    required: ["assistant_message"],
    additionalProperties: true,
  },
};

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

function parsePositiveInt(value: string | null | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Conservative estimate to stay safely under provider context limits.
function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 3);
}

function truncateKeepingStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 12) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 12)}\n...[truncated]`;
}

function truncateKeepingEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 12) return text.slice(text.length - maxChars);
  return `...[truncated]\n${text.slice(text.length - (maxChars - 12))}`;
}

function sumEstimatedTokens(messages: Array<{ role: string; content: string }>): number {
  return messages.reduce((acc, msg) => acc + estimateTokensFromText(msg.content), 0);
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
    const contextWindow = parsePositiveInt(
      process.env.PUSHPALS_LMSTUDIO_CONTEXT_WINDOW ?? process.env.LLM_CONTEXT_WINDOW,
      DEFAULT_LMSTUDIO_CONTEXT_WINDOW,
    );
    const minOutputTokens = parsePositiveInt(
      process.env.PUSHPALS_LMSTUDIO_MIN_OUTPUT_TOKENS,
      DEFAULT_LMSTUDIO_MIN_OUTPUT_TOKENS,
    );
    const desiredMaxTokens = input.maxTokens ?? 2048;
    const clampedMinOutput = Math.max(64, Math.min(minOutputTokens, Math.floor(contextWindow / 2)));
    const promptTokenBudget = Math.max(
      384,
      contextWindow - clampedMinOutput - DEFAULT_LMSTUDIO_TOKEN_SAFETY_MARGIN,
    );
    const systemTokenBudget = Math.max(
      128,
      Math.min(Math.floor(promptTokenBudget * 0.45), promptTokenBudget - 128),
    );

    let trimmed = false;
    let remainingPromptTokens = promptTokenBudget;
    let systemContent = input.system;
    if (estimateTokensFromText(systemContent) > systemTokenBudget) {
      systemContent = truncateKeepingStart(systemContent, systemTokenBudget * 3);
      trimmed = true;
    }
    remainingPromptTokens = Math.max(
      64,
      promptTokenBudget - estimateTokensFromText(systemContent),
    );

    const selectedMessages: Array<{ role: string; content: string }> = [];
    for (let i = input.messages.length - 1; i >= 0; i--) {
      const source = input.messages[i];
      let content = source.content ?? "";
      const estimated = estimateTokensFromText(content);
      if (estimated <= remainingPromptTokens) {
        selectedMessages.push({ role: source.role, content });
        remainingPromptTokens -= estimated;
        continue;
      }
      const charBudget = Math.max(192, remainingPromptTokens * 3);
      content = truncateKeepingEnd(content, charBudget);
      selectedMessages.push({ role: source.role, content });
      trimmed = true;
      break;
    }

    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemContent },
      ...selectedMessages.reverse(),
    ];

    const promptTokensEstimate = sumEstimatedTokens(messages);
    const safeMaxTokens = Math.max(
      64,
      Math.min(
        desiredMaxTokens,
        contextWindow - promptTokensEstimate - DEFAULT_LMSTUDIO_TOKEN_SAFETY_MARGIN,
      ),
    );
    if (trimmed) {
      console.warn(
        `[LLM] Trimmed LM Studio prompt context to fit window (~${contextWindow} tokens, est prompt ${promptTokensEstimate}).`,
      );
    }

    const baseBody: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: safeMaxTokens,
      temperature: input.temperature ?? 0.3,
    };

    const bodyVariants: Array<Record<string, unknown>> = [];
    if (!input.json) {
      bodyVariants.push(baseBody);
    } else {
      // LM Studio validates response_format.type and expects json_schema or text.
      bodyVariants.push({
        ...baseBody,
        response_format: {
          type: "json_schema",
          json_schema: REMOTEBUDDY_JSON_RESPONSE_SCHEMA,
        },
      });
      // Fallback for providers/configs that reject the schema payload.
      bodyVariants.push({
        ...baseBody,
        response_format: { type: "text" },
      });
    }

    let lastStatus = 0;
    let lastError = "unknown error";
    for (let i = 0; i < bodyVariants.length; i++) {
      const body = bodyVariants[i];
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: lmStudioHeaders(this.apiKey),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        lastStatus = res.status;
        lastError = await res.text();
        const hasFallback = i < bodyVariants.length - 1;
        if (hasFallback && res.status === 400) {
          console.warn(
            `[LLM] LM Studio rejected response_format payload, retrying with fallback (${lastStatus}).`,
          );
          continue;
        }
        throw new Error(`LM Studio API error ${res.status}: ${lastError}`);
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

    throw new Error(`LM Studio API error ${lastStatus}: ${lastError}`);
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
