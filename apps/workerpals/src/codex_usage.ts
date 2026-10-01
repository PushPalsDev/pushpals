import type { JobTokenUsage, JobUsageAttempt } from "./common/types.js";

const tokenCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Only structured terminal usage is accounting evidence; tool output and
 * stderr often contain echoed prompts and must never be counted as tokens. */
export function parseCodexTerminalUsage(jsonl: string): JobTokenUsage | null {
  let result: JobTokenUsage | null = null;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.includes('"turn.completed"') || line.length > 64_000) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type !== "turn.completed") continue;
      const input = tokenCount(event.usage?.input_tokens);
      const output = tokenCount(event.usage?.output_tokens);
      if (input === null || output === null) continue;
      const cached = tokenCount(event.usage?.cached_input_tokens);
      const reasoning = tokenCount(event.usage?.reasoning_output_tokens);
      // A single exec turn emits one terminal event; tolerate duplicated
      // replay records without charging the same cumulative counters twice.
      result = {
        promptTokens: input,
        completionTokens: output,
        totalTokens: input + output,
        estimated: false,
        ...(cached !== null ? { cachedInputTokens: Math.min(cached, input) } : {}),
        ...(reasoning !== null ? { reasoningOutputTokens: Math.min(reasoning, output) } : {}),
      };
    } catch {
      /* An incomplete final line cannot establish usage. */
    }
  }
  return result;
}

export function codexUsageAttempt(options: {
  jsonl: string;
  promptChars: number;
  finalMessage: string;
  stage: "critic" | "finalization";
  source: string;
  modelId: string;
  attempt: number;
  timedOut?: boolean;
}): JobUsageAttempt {
  const exact = parseCodexTerminalUsage(options.jsonl);
  const promptTokens = Math.ceil(Math.max(0, options.promptChars) / 3);
  // This fallback is explicitly an estimate of supplied/final text only,
  // not a provider total or an estimate of hidden reasoning/tool execution.
  const completionTokens = Math.ceil(options.finalMessage.length / 3);
  return {
    ...(exact ?? {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimated: true,
    }),
    stage: options.stage,
    source: options.source,
    backend: options.source,
    modelId: options.modelId,
    attempt: options.attempt,
    ...(options.timedOut ? { timedOut: true } : {}),
  };
}
