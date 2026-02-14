/**
 * LLM client abstraction with two supported backends:
 * - LM Studio
 * - Ollama
 */

import { loadPushPalsConfig, type PushPalsLmStudioConfig } from "shared";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMGenerateInput {
  system: string;
  messages: LLMMessage[];
  // Request JSON output when provider supports it.
  json?: boolean;
  // Optional JSON schema for strict structured responses.
  // If omitted and json=true, client requests generic JSON object mode.
  jsonSchema?: Record<string, unknown>;
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
type LlmService = "localbuddy" | "remotebuddy" | "workerpals";

export interface LLMClientOptions {
  service?: LlmService;
  sessionId?: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  backend?: string;
}

interface ResolvedServiceLlmConfig {
  backend: LlmBackend;
  endpoint: string;
  model: string;
  apiKey: string;
  sessionId: string;
  lmStudio: PushPalsLmStudioConfig;
}

const DEFAULT_LMSTUDIO_ENDPOINT = "http://127.0.0.1:1234";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/chat";
const DEFAULT_MODEL = "local-model";
const DEFAULT_LMSTUDIO_CONTEXT_WINDOW = 4096;
const DEFAULT_LMSTUDIO_MIN_OUTPUT_TOKENS = 256;
const DEFAULT_LMSTUDIO_TOKEN_SAFETY_MARGIN = 64;
const DEFAULT_LMSTUDIO_BATCH_TAIL_MESSAGES = 3;
const KNOWN_PROVIDER_PREFIXES = new Set([
  "openai",
  "azure",
  "ollama",
  "openrouter",
  "anthropic",
  "google",
  "gemini",
  "vertex_ai",
  "bedrock",
  "cohere",
  "groq",
  "mistral",
  "huggingface",
  "replicate",
  "deepseek",
  "xai",
  "together_ai",
  "fireworks_ai",
]);
function normalizeBackend(value: string | null | undefined): LlmBackend | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "lmstudio") return "lmstudio";
  if (normalized === "ollama") return "ollama";
  return null;
}

function configuredBackend(
  endpoint: string,
  explicitBackend?: string | null | undefined,
): LlmBackend {
  const explicit = normalizeBackend(explicitBackend);
  if (explicit) return explicit;
  return endpoint.includes("/api/chat") ? "ollama" : "lmstudio";
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function resolveServiceLlmConfig(opts: LLMClientOptions = {}): ResolvedServiceLlmConfig {
  const service = opts.service ?? "remotebuddy";
  const config = loadPushPalsConfig();
  const serviceLlmConfig =
    service === "localbuddy"
      ? config.localbuddy.llm
      : service === "workerpals"
        ? config.workerpals.llm
        : config.remotebuddy.llm;

  const explicitBackend = normalizeBackend(firstNonEmpty(opts.backend, serviceLlmConfig.backend));
  const endpoint = firstNonEmpty(
    opts.endpoint,
    serviceLlmConfig.endpoint,
    explicitBackend === "ollama" ? DEFAULT_OLLAMA_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT,
  );
  const backend = configuredBackend(endpoint ?? "", explicitBackend);
  const normalizedEndpoint =
    backend === "ollama"
      ? normalizeOllamaEndpoint(endpoint ?? DEFAULT_OLLAMA_ENDPOINT)
      : normalizeLmStudioEndpoint(endpoint ?? DEFAULT_LMSTUDIO_ENDPOINT);

  const model = firstNonEmpty(opts.model, serviceLlmConfig.model, DEFAULT_MODEL) ?? DEFAULT_MODEL;
  const apiKey =
    firstNonEmpty(opts.apiKey, serviceLlmConfig.apiKey, backend === "lmstudio" ? "lmstudio" : "") ??
    "";
  const sessionId =
    firstNonEmpty(opts.sessionId, serviceLlmConfig.sessionId, config.sessionId, "default") ?? "default";

  return {
    backend,
    endpoint: normalizedEndpoint,
    model,
    apiKey,
    sessionId,
    lmStudio: config.llm.lmstudio,
  };
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

function providerlessModelName(raw: string): string {
  const normalized = raw.trim();
  if (!normalized.includes("/")) return normalized;
  const [provider, rest] = normalized.split("/", 2);
  if (KNOWN_PROVIDER_PREFIXES.has(provider.trim().toLowerCase())) {
    return (rest ?? "").trim();
  }
  return normalized;
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeSessionTag(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-");
  const collapsed = normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!collapsed) return "default";
  return collapsed.length <= 96 ? collapsed : collapsed.slice(0, 96);
}

function stableConversationTag(service: LlmService, sessionId?: string): string {
  const source = firstNonEmpty(sessionId, "default") ?? "default";
  return `pushpals-${service}-${normalizeSessionTag(source)}`;
}

function pickConfiguredOrAvailableModel(
  configuredModel: string,
  availableModels: string[],
): {
  model: string;
  source:
    | "configured"
    | "available_fallback"
    | "available_default"
    | "configured_unverified"
    | "default_local_model";
} {
  const configured = configuredModel.trim();
  if (availableModels.length > 0) {
    if (configured) {
      const configuredLower = configured.toLowerCase();
      const configuredBare = providerlessModelName(configured).toLowerCase();
      const matched = availableModels.find((candidate) => {
        const lower = candidate.toLowerCase();
        return (
          lower === configuredLower ||
          providerlessModelName(candidate).toLowerCase() === configuredBare
        );
      });
      if (matched) return { model: matched, source: "configured" };
      return { model: availableModels[0], source: "available_fallback" };
    }
    return { model: availableModels[0], source: "available_default" };
  }

  if (configured) return { model: configured, source: "configured_unverified" };
  return { model: DEFAULT_MODEL, source: "default_local_model" };
}

function chunkByCharBudget(text: string, charBudget: number): string[] {
  if (!text) return [];
  const safeBudget = Math.max(256, charBudget);
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + safeBudget);
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

function serializeMessagesForBatch(messages: Array<{ role: string; content: string }>): string {
  return messages
    .map(
      (message, index) =>
        `[#${index + 1}] role=${message.role}\n<<<BEGIN_CONTENT>>>\n${message.content}\n<<<END_CONTENT>>>`,
    )
    .join("\n\n====\n\n");
}

function trimLmStudioMessagesToBudget(
  system: string,
  inputMessages: LLMMessage[],
  promptTokenBudget: number,
  systemTokenBudget: number,
): {
  messages: Array<{ role: string; content: string }>;
  promptTokensEstimate: number;
  trimmed: boolean;
  latestUserOverflow: boolean;
} {
  let trimmed = false;
  let latestUserOverflow = false;
  let remainingPromptTokens = promptTokenBudget;
  let systemContent = system;
  if (estimateTokensFromText(systemContent) > systemTokenBudget) {
    systemContent = truncateKeepingStart(systemContent, systemTokenBudget * 3);
    trimmed = true;
  }
  remainingPromptTokens = Math.max(64, promptTokenBudget - estimateTokensFromText(systemContent));

  const selectedMessages: Array<{ role: string; content: string }> = [];
  const lastUserIndex = (() => {
    for (let i = inputMessages.length - 1; i >= 0; i--) {
      if (inputMessages[i]?.role === "user") return i;
    }
    return -1;
  })();

  for (let i = inputMessages.length - 1; i >= 0; i--) {
    const source = inputMessages[i];
    let content = source.content ?? "";
    const estimated = estimateTokensFromText(content);
    if (estimated <= remainingPromptTokens) {
      selectedMessages.push({ role: source.role, content });
      remainingPromptTokens -= estimated;
      continue;
    }

    // Never silently trim the most recent user instruction.
    if (i === lastUserIndex) {
      selectedMessages.push({ role: source.role, content });
      latestUserOverflow = true;
      break;
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
  return { messages, promptTokensEstimate, trimmed, latestUserOverflow };
}

export class LmStudioClient implements LLMClient {
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private sessionTag: string;
  private contextWindow: number;
  private minOutputTokens: number;
  private tokenSafetyMargin: number;
  private batchTailMessages: number;
  private batchChunkTokens: number;
  private batchMemoryChars: number;
  private resolvedModel: string | null = null;
  private resolveModelPromise: Promise<string> | null = null;

  constructor(opts?: {
    endpoint?: string;
    apiKey?: string;
    model?: string;
    service?: LlmService;
    sessionId?: string;
    lmStudio?: PushPalsLmStudioConfig;
  }) {
    const rawEndpoint = opts?.endpoint ?? DEFAULT_LMSTUDIO_ENDPOINT;
    this.endpoint = normalizeLmStudioEndpoint(rawEndpoint);
    this.apiKey = opts?.apiKey ?? "lmstudio";
    this.model = opts?.model ?? DEFAULT_MODEL;
    this.sessionTag = stableConversationTag(opts?.service ?? "remotebuddy", opts?.sessionId);
    const lmStudio = opts?.lmStudio;
    this.contextWindow = Math.max(512, lmStudio?.contextWindow ?? DEFAULT_LMSTUDIO_CONTEXT_WINDOW);
    this.minOutputTokens = Math.max(64, lmStudio?.minOutputTokens ?? DEFAULT_LMSTUDIO_MIN_OUTPUT_TOKENS);
    this.tokenSafetyMargin = Math.max(
      16,
      lmStudio?.tokenSafetyMargin ?? DEFAULT_LMSTUDIO_TOKEN_SAFETY_MARGIN,
    );
    this.batchTailMessages = Math.max(
      1,
      lmStudio?.batchTailMessages ?? DEFAULT_LMSTUDIO_BATCH_TAIL_MESSAGES,
    );
    this.batchChunkTokens = Math.max(0, lmStudio?.batchChunkTokens ?? 0);
    this.batchMemoryChars = Math.max(0, lmStudio?.batchMemoryChars ?? 0);
  }

  private lmStudioModelProbeUrls(): string[] {
    const trimmed = this.endpoint.replace(/\/+$/, "");
    if (trimmed.endsWith("/v1/chat/completions")) {
      const root = trimmed.slice(0, -"/v1/chat/completions".length);
      return uniqueNonEmptyStrings([`${root}/v1/models`, `${root}/models`]);
    }
    if (trimmed.endsWith("/chat/completions")) {
      const root = trimmed.slice(0, -"/chat/completions".length);
      if (root.endsWith("/v1")) {
        const parent = root.slice(0, -"/v1".length).replace(/\/+$/, "");
        return uniqueNonEmptyStrings([`${root}/models`, `${parent}/models`]);
      }
      return uniqueNonEmptyStrings([`${root}/v1/models`, `${root}/models`]);
    }
    if (trimmed.endsWith("/v1")) {
      const parent = trimmed.slice(0, -"/v1".length).replace(/\/+$/, "");
      return uniqueNonEmptyStrings([`${trimmed}/models`, `${parent}/models`]);
    }
    return uniqueNonEmptyStrings([`${trimmed}/v1/models`, `${trimmed}/models`]);
  }

  private async discoverAvailableModels(): Promise<{ models: string[]; detail: string }> {
    const probes = this.lmStudioModelProbeUrls();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey.trim()) {
      headers.Authorization = `Bearer ${this.apiKey.trim()}`;
    }

    let lastDetail = "model-list probe failed";
    for (const url of probes) {
      try {
        const res = await fetch(url, { method: "GET", headers });
        if (!res.ok) {
          const body = await res.text();
          const hint = body.trim().slice(0, 120);
          lastDetail = `${url} -> HTTP ${res.status}${hint ? ` (${hint})` : ""}`;
          continue;
        }

        const payload = (await res.json()) as { data?: Array<{ id?: unknown }> };
        const models = Array.isArray(payload?.data)
          ? payload.data
              .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
              .filter((id) => id.length > 0)
          : [];

        if (models.length > 0) {
          return { models: uniqueNonEmptyStrings(models), detail: `${url} -> ${res.status}` };
        }
        lastDetail = `${url} -> no models in payload`;
      } catch (err) {
        lastDetail = `${url}: ${String(err)}`;
      }
    }

    return { models: [], detail: lastDetail };
  }

  private async resolveModelForRequest(): Promise<string> {
    if (this.resolvedModel) return this.resolvedModel;
    if (this.resolveModelPromise) return this.resolveModelPromise;

    this.resolveModelPromise = (async () => {
      const configuredModel = this.model.trim();
      const discovered = await this.discoverAvailableModels();
      const selected = pickConfiguredOrAvailableModel(configuredModel, discovered.models);

      if (selected.source === "available_fallback") {
        console.warn(
          `[LLM] Configured model "${configuredModel || "(empty)"}" not present in LM Studio model list; using discovered fallback "${selected.model}".`,
        );
      } else if (selected.source === "available_default") {
        console.warn(
          `[LLM] No model configured; using discovered LM Studio model "${selected.model}".`,
        );
      } else if (selected.source === "default_local_model") {
        console.warn(
          `[LLM] No configured/discovered LM Studio model available; falling back to default "${DEFAULT_MODEL}".`,
        );
      } else if (selected.source === "configured_unverified") {
        console.warn(
          `[LLM] Could not verify configured model "${configuredModel}" via model list (${discovered.detail}); continuing with configured model.`,
        );
      }

      console.log(`[LLM] LM Studio resolved model "${selected.model}" (${selected.source}).`);

      return selected.model;
    })();

    try {
      this.resolvedModel = await this.resolveModelPromise;
      return this.resolvedModel;
    } finally {
      this.resolveModelPromise = null;
    }
  }

  private async runLmStudioCompletion(
    messages: Array<{ role: string; content: string }>,
    opts: {
      json?: boolean;
      jsonSchema?: Record<string, unknown>;
      maxTokens: number;
      temperature: number;
    },
  ): Promise<LLMGenerateOutput> {
    const model = await this.resolveModelForRequest();
    const coreBody: Record<string, unknown> = {
      model,
      messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
    };

    const sessionAwareBodyBases: Array<Record<string, unknown>> = this.sessionTag
      ? [
          {
            ...coreBody,
            user: this.sessionTag,
            session_id: this.sessionTag,
            conversation_id: this.sessionTag,
          },
          {
            ...coreBody,
            user: this.sessionTag,
          },
          {
            ...coreBody,
          },
        ]
      : [coreBody];

    const bodyVariants: Array<Record<string, unknown>> = [];
    for (const baseBody of sessionAwareBodyBases) {
      if (!opts.json) {
        bodyVariants.push(baseBody);
        continue;
      }
      if (opts.jsonSchema) {
        bodyVariants.push({
          ...baseBody,
          response_format: {
            type: "json_schema",
            json_schema: opts.jsonSchema,
          },
        });
      } else {
        bodyVariants.push({
          ...baseBody,
          response_format: { type: "json_object" },
        });
      }
      bodyVariants.push({
        ...baseBody,
        response_format: { type: "text" },
      });
    }

    let lastStatus = 0;
    let lastError = "unknown error";
    let loggedSessionFallback = false;
    let loggedResponseFormatFallback = false;
    for (let i = 0; i < bodyVariants.length; i++) {
      const body = bodyVariants[i];
      const headers: Record<string, string> = {
        ...lmStudioHeaders(this.apiKey),
      };
      if (this.sessionTag) {
        headers["X-PushPals-Session-Id"] = this.sessionTag;
        headers["X-Session-Id"] = this.sessionTag;
        headers["X-Conversation-Id"] = this.sessionTag;
      }
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        lastStatus = res.status;
        lastError = await res.text();
        const hasFallback = i < bodyVariants.length - 1;
        if (hasFallback && res.status === 400) {
          const lowered = lastError.toLowerCase();
          const sessionFieldRejected =
            lowered.includes("session_id") ||
            lowered.includes("conversation_id") ||
            lowered.includes("unknown field") ||
            lowered.includes("unknown property") ||
            lowered.includes("additional properties");
          const responseFormatRejected = lowered.includes("response_format");
          if (sessionFieldRejected && !loggedSessionFallback) {
            loggedSessionFallback = true;
            console.warn(
              `[LLM] LM Studio rejected session hint fields, retrying compatibility payload (${lastStatus}).`,
            );
          } else if (responseFormatRejected && !loggedResponseFormatFallback) {
            loggedResponseFormatFallback = true;
            console.warn(
              `[LLM] LM Studio rejected response_format payload, retrying with fallback (${lastStatus}).`,
            );
          }
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

  private async packContextInBatches(
    fullMessages: Array<{ role: string; content: string }>,
    promptTokenBudget: number,
  ): Promise<{ messages: Array<{ role: string; content: string }>; chunkCount: number }> {
    const tailCount = this.batchTailMessages;
    const tailMessages = fullMessages.slice(-tailCount);
    // Reserve budget for tail messages and packed-context wrapper system messages.
    const reservedTailTokens = sumEstimatedTokens(tailMessages) + 220;
    const adaptiveMemoryTokenBudget = Math.max(
      256,
      Math.min(Math.floor(promptTokenBudget * 0.6), promptTokenBudget - reservedTailTokens),
    );

    const chunkTokenBudget =
      this.batchChunkTokens > 0
        ? this.batchChunkTokens
        : Math.max(256, Math.floor(promptTokenBudget * 0.55));
    const chunkCharBudget = chunkTokenBudget * 3;
    const memoryCharBudget =
      this.batchMemoryChars > 0
        ? this.batchMemoryChars
        : Math.max(900, adaptiveMemoryTokenBudget * 3);
    const packMaxTokens = Math.max(128, Math.min(1024, Math.floor(this.contextWindow * 0.25)));
    const serialized = serializeMessagesForBatch(fullMessages);
    const chunks = chunkByCharBudget(serialized, chunkCharBudget);
    if (chunks.length <= 1) {
      return { messages: fullMessages, chunkCount: chunks.length };
    }

    let memory = "";
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const packPrompt = [
        `New batch ${i + 1}/${chunks.length}:`,
        chunk,
        "",
        "Current packed memory:",
        memory || "(empty)",
        "",
        `Update the packed memory with maximal fidelity. Requirements:`,
        "- Preserve concrete instructions, constraints, IDs, file paths, env vars, and error text.",
        "- Keep conflicting details if present; do not silently discard.",
        `- Keep output under ${memoryCharBudget} characters.`,
        "- Output only packed memory plain text.",
      ].join("\n");

      const packed = await this.runLmStudioCompletion(
        [
          {
            role: "system",
            content:
              "You are a high-fidelity context packer. Merge incoming batch context into compact memory without losing critical implementation detail.",
          },
          { role: "user", content: packPrompt },
        ],
        { json: false, maxTokens: packMaxTokens, temperature: 0.0 },
      );
      memory = packed.text.trim() || memory;
    }

    const packedMessages: Array<{ role: string; content: string }> = [
      {
        role: "system",
        content:
          "Prior context was streamed in multiple batches and condensed below. Treat PACKED_CONTEXT as authoritative history for this request.",
      },
      {
        role: "system",
        content: `PACKED_CONTEXT\n${memory}`,
      },
      ...tailMessages,
    ];
    return { messages: packedMessages, chunkCount: chunks.length };
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    const contextWindow = this.contextWindow;
    const minOutputTokens = this.minOutputTokens;
    const desiredMaxTokens = input.maxTokens ?? 2048;
    const clampedMinOutput = Math.max(64, Math.min(minOutputTokens, Math.floor(contextWindow / 2)));
    const promptTokenBudget = Math.max(
      384,
      contextWindow - clampedMinOutput - this.tokenSafetyMargin,
    );
    const systemTokenBudget = Math.max(
      128,
      Math.min(Math.floor(promptTokenBudget * 0.45), promptTokenBudget - 128),
    );

    const fullMessages: Array<{ role: string; content: string }> = [
      { role: "system", content: input.system },
      ...input.messages.map((message) => ({ role: message.role, content: message.content ?? "" })),
    ];

    let messages = fullMessages;
    let promptTokensEstimate = sumEstimatedTokens(messages);
    let trimmed = false;
    let packedChunkCount = 0;
    let latestUserOverflow = false;

    if (promptTokensEstimate > promptTokenBudget) {
      try {
        const packed = await this.packContextInBatches(
          fullMessages,
          promptTokenBudget,
        );
        messages = packed.messages;
        packedChunkCount = packed.chunkCount;
        promptTokensEstimate = sumEstimatedTokens(messages);
        if (promptTokensEstimate > promptTokenBudget && messages.length > 0) {
          const packedSystem = messages[0]?.content ?? "";
          const packedInput = messages
            .slice(1)
            .map((message) => ({
              role: message.role as LLMMessage["role"],
              content: message.content,
            }));
          const packedTrimmed = trimLmStudioMessagesToBudget(
            packedSystem,
            packedInput,
            promptTokenBudget,
            systemTokenBudget,
          );
          messages = packedTrimmed.messages;
          promptTokensEstimate = packedTrimmed.promptTokensEstimate;
          trimmed = trimmed || packedTrimmed.trimmed;
          latestUserOverflow = latestUserOverflow || packedTrimmed.latestUserOverflow;
        }
      } catch (err) {
        throw new Error(`LM Studio batch context packing failed: ${String(err)}`);
      }
    }

    if (latestUserOverflow) {
      throw new Error(
        "Latest user request exceeds LM Studio context window and cannot be safely truncated. Increase model context window or split the request into smaller messages.",
      );
    }

    const safeMaxTokens = Math.max(
      64,
      Math.min(
        desiredMaxTokens,
        contextWindow - promptTokensEstimate - this.tokenSafetyMargin,
      ),
    );

    if (packedChunkCount > 1) {
      console.warn(
        `[LLM] Packed oversized prompt context across ${packedChunkCount} batches (window ~${contextWindow}, est prompt ${promptTokensEstimate}).`,
      );
    } else if (trimmed) {
      console.warn(
        `[LLM] Trimmed LM Studio prompt context to fit window (~${contextWindow} tokens, est prompt ${promptTokensEstimate}).`,
      );
    }

    return this.runLmStudioCompletion(messages, {
      json: input.json,
      jsonSchema: input.jsonSchema,
      maxTokens: safeMaxTokens,
      temperature: input.temperature ?? 0.3,
    });
  }
}

export class OllamaClient implements LLMClient {
  private endpoint: string;
  private model: string;

  constructor(opts?: { endpoint?: string; model?: string }) {
    const rawEndpoint = opts?.endpoint ?? DEFAULT_OLLAMA_ENDPOINT;
    this.endpoint = normalizeOllamaEndpoint(rawEndpoint);
    this.model = opts?.model ?? DEFAULT_MODEL;
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

export function createLLMClient(opts: LLMClientOptions = {}): LLMClient {
  const resolved = resolveServiceLlmConfig(opts);
  const service = opts.service ?? "remotebuddy";

  if (resolved.backend === "ollama") {
    console.log(
      `[LLM] Using Ollama backend (model: ${resolved.model}, endpoint: ${resolved.endpoint})`,
    );
    return new OllamaClient({
      endpoint: resolved.endpoint,
      model: resolved.model,
    });
  }

  console.log(
    `[LLM] Using LM Studio backend (model: ${resolved.model}, endpoint: ${resolved.endpoint})`,
  );
  return new LmStudioClient({
    endpoint: resolved.endpoint,
    apiKey: resolved.apiKey,
    model: resolved.model,
    service,
    sessionId: resolved.sessionId,
    lmStudio: resolved.lmStudio,
  });
}
