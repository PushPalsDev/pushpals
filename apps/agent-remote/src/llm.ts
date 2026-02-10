/**
 * LLM Client abstraction — swappable provider interface.
 *
 * Supported backends (pick via env):
 *   OPENAI_API_KEY   → OpenAI (gpt-4o, gpt-4o-mini, etc.)
 *   ANTHROPIC_API_KEY → Anthropic (claude-sonnet-4-20250514, etc.)
 *   LLM_ENDPOINT     → Generic OpenAI-compatible (Ollama, vLLM, LM Studio)
 */

// ─── Interface ──────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMGenerateInput {
  system: string;
  messages: LLMMessage[];
  /** Request JSON output (best-effort — provider must support it) */
  json?: boolean;
  /** Max tokens to generate */
  maxTokens?: number;
  temperature?: number;
}

export interface LLMGenerateOutput {
  text: string;
  /** Usage stats if available */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMClient {
  generate(input: LLMGenerateInput): Promise<LLMGenerateOutput>;
}

// ─── OpenAI-compatible client ───────────────────────────────────────────────

export class OpenAIClient implements LLMClient {
  private endpoint: string;
  private apiKey: string;
  private model: string;

  constructor(opts?: { endpoint?: string; apiKey?: string; model?: string }) {
    this.endpoint = opts?.endpoint ?? process.env.OPENAI_API_ENDPOINT ?? "https://api.openai.com";
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = opts?.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
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

    const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${err}`);
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

// ─── Anthropic client ───────────────────────────────────────────────────────

export class AnthropicClient implements LLMClient {
  private endpoint: string;
  private apiKey: string;
  private model: string;

  constructor(opts?: { endpoint?: string; apiKey?: string; model?: string }) {
    this.endpoint =
      opts?.endpoint ?? process.env.ANTHROPIC_API_ENDPOINT ?? "https://api.anthropic.com";
    this.apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.model = opts?.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    const messages = input.messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    const res = await fetch(`${this.endpoint}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        system: input.system,
        messages,
        max_tokens: input.maxTokens ?? 2048,
        temperature: input.temperature ?? 0.3,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as any;
    const text =
      data.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("") ?? "";

    return {
      text,
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
          }
        : undefined,
    };
  }
}

// ─── Generic OpenAI-compatible client (Ollama, vLLM, LM Studio) ────────────

export class GenericOpenAIClient extends OpenAIClient {
  constructor(opts?: { endpoint?: string; apiKey?: string; model?: string }) {
    super({
      endpoint: opts?.endpoint ?? process.env.LLM_ENDPOINT ?? "http://localhost:11434",
      apiKey: opts?.apiKey ?? process.env.LLM_API_KEY ?? "ollama",
      model: opts?.model ?? process.env.LLM_MODEL ?? "llama3",
    });
  }
}

// ─── Auto-detect provider ───────────────────────────────────────────────────

export function createLLMClient(): LLMClient {
  if (process.env.OPENAI_API_KEY) {
    console.log("[LLM] Using OpenAI provider");
    return new OpenAIClient();
  }
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("[LLM] Using Anthropic provider");
    return new AnthropicClient();
  }
  if (process.env.LLM_ENDPOINT) {
    console.log("[LLM] Using generic OpenAI-compatible provider");
    return new GenericOpenAIClient();
  }
  // Default: try Ollama at localhost
  console.log("[LLM] No API key found — defaulting to Ollama at localhost:11434");
  return new GenericOpenAIClient();
}
