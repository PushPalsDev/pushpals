import { isLocalReadonlyQueryPrompt } from "./local_readonly.js";

export type RequestPriority = "interactive" | "normal" | "background";

export function summarizeFailureForPrompt(value: unknown): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  const lowered = text.toLowerCase();
  if (
    lowered.includes("cannot truncate prompt with n_keep") ||
    lowered.includes("context size has been exceeded") ||
    (lowered.includes("prompt exceeded") && lowered.includes("context"))
  ) {
    return "Prompt/context exceeded the model window.";
  }
  if (
    lowered.includes("connection refused") ||
    lowered.includes("connection error") ||
    lowered.includes("econnrefused")
  ) {
    return "LLM endpoint connection error.";
  }
  if (lowered.includes("timed out") || lowered.includes("job timeout")) {
    return "Worker job timed out.";
  }
  if (lowered.includes("response did not contain parseable json")) {
    return "Model returned non-JSON output when structured output was expected.";
  }

  const stackLikeIndex = text.search(/\b(traceback|stack trace| at [A-Za-z0-9_.]+[:(])/i);
  const compact = stackLikeIndex > 0 ? text.slice(0, stackLikeIndex).trim() : text;
  if (compact.length <= 220) return compact;
  return `${compact.slice(0, 217)}...`;
}

const ASK_REMOTE_BUDDY_COMMAND = "/ask_remote_buddy";

export function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const parseAtDepth = (input: string, depth: number): Record<string, unknown> | null => {
    if (depth > 2) return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      if (typeof parsed === "string" && parsed.trim()) {
        return parseAtDepth(parsed, depth + 1);
      }
    } catch {
      // fall through
    }
    return null;
  };

  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = parseAtDepth(trimmed, 0);
  if (direct) return direct;

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = trimmed.slice(firstBrace, lastBrace + 1);
    const nested = parseAtDepth(sliced, 0);
    if (nested) return nested;
  }
  return null;
}

export function extractLocalReplyFromObject(value: Record<string, unknown> | null): string {
  if (!value) return "";
  const candidates = [
    value.reply,
    value.assistant_message,
    value.message,
    value.text,
    value.content,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

export function extractLocalReplyFromJsonLikeText(value: string): string {
  const keyPattern = "(reply|assistant_message|message|text|content)";
  const directMatch = value.match(
    new RegExp(`"${keyPattern}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i"),
  );
  if (!directMatch?.[2]) return "";
  const encoded = directMatch[2];
  try {
    const decoded = JSON.parse(`"${encoded}"`);
    return typeof decoded === "string" ? decoded.trim() : "";
  } catch {
    return encoded.trim();
  }
}

export function fallbackLocalReply(userPrompt: string): string {
  const text = userPrompt.trim().toLowerCase();
  if (/^(hi|hello|hey)\b/.test(text)) {
    return "Hello. I can answer lightweight questions directly, or route execution work with /ask_remote_buddy <request>.";
  }
  if (/status|what'?s the status|whats the status/.test(text)) {
    return "I’m online and ready. For full job/repo status, use /ask_remote_buddy <request>.";
  }
  return "I can answer lightweight questions directly. For execution or coding work, use /ask_remote_buddy <request>.";
}

export function sanitizeLocalReply(raw: string, userPrompt: string): string {
  let text = String(raw ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```/g, "")
    .trim();
  if (!text) return fallbackLocalReply(userPrompt);

  // Some providers ignore/relax JSON schema and return alternate keys.
  const parsed = tryParseJsonObject(text);
  const extracted = extractLocalReplyFromObject(parsed);
  if (extracted) {
    text = extracted;
  } else {
    const extractedFromJsonLike = extractLocalReplyFromJsonLikeText(text);
    if (extractedFromJsonLike) {
      text = extractedFromJsonLike;
    }
  }

  const lowered = text.toLowerCase();
  const reasoningSignals = [
    "analyze the user's request",
    "identify the constraints",
    "self-correction",
    "step-by-step",
    "my reasoning",
    "chain-of-thought",
  ];
  if (reasoningSignals.some((signal) => lowered.includes(signal))) {
    return fallbackLocalReply(userPrompt);
  }

  // Keep only the first short paragraph/sentence if model rambles.
  const firstParagraph = text.split(/\n\s*\n/)[0]?.trim() ?? text;
  text = firstParagraph.length > 320 ? `${firstParagraph.slice(0, 317)}...` : firstParagraph;

  if (/^\d+\.\s+\*\*/.test(text) || /^analysis[:\s]/i.test(text)) {
    return fallbackLocalReply(userPrompt);
  }

  const stillJsonLike =
    /^\s*\{[\s\S]*\}\s*$/.test(text) &&
    /"(reply|assistant_message|message|text|content)"\s*:/.test(text);
  if (stillJsonLike) {
    return fallbackLocalReply(userPrompt);
  }

  return text || fallbackLocalReply(userPrompt);
}

export function classifyRemoteRequestPriority(input: string): RequestPriority {
  const text = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!text) return "normal";

  if (
    /\b(status|progress|queue|queued|eta|where|hows my job|what'?s my status|check on)\b/.test(text)
  ) {
    return "interactive";
  }

  if (
    /\b(comprehensive|deep dive|full pass|phase\s+\d|architecture|migration|refactor|rewrite|all components|everything)\b/.test(
      text,
    ) ||
    text.length > 1200
  ) {
    return "background";
  }

  return "normal";
}

export function queueWaitBudgetForPriority(priority: RequestPriority): number {
  switch (priority) {
    case "interactive":
      return 20_000;
    case "background":
      return 240_000;
    default:
      return 90_000;
  }
}

export function formatEtaFromMs(ms: number | undefined): string {
  if (!Number.isFinite(ms as number) || (ms as number) <= 0) return "now";
  const value = Math.max(0, Math.floor(ms as number));
  if (value < 1_000) return `${value}ms`;
  const secs = Math.ceil(value / 1_000);
  if (secs < 60) return `${secs}s`;
  const minutes = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${minutes}m ${remSecs}s` : `${minutes}m`;
}

export function parseRemoteBuddyCommand(input: string): {
  forceRemote: boolean;
  prompt: string;
  usageMessage?: string;
} {
  const trimmed = String(input ?? "").trim();
  const command = ASK_REMOTE_BUDDY_COMMAND.toLowerCase();
  if (!trimmed.toLowerCase().startsWith(command)) {
    return { forceRemote: false, prompt: trimmed };
  }

  const rest = trimmed
    .slice(command.length)
    .replace(/^[:\-]\s*/, "")
    .trim();
  if (!rest) {
    return {
      forceRemote: true,
      prompt: "",
      usageMessage:
        "Usage: /ask_remote_buddy <request>. Example: /ask_remote_buddy fix the failing job status in the dashboard.",
    };
  }
  return { forceRemote: true, prompt: rest };
}

export function isLikelyLocalOnlyPrompt(input: string): boolean {
  const text = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!text) return true;

  if (isLocalReadonlyQueryPrompt(text)) {
    return true;
  }

  if (
    /^(hi|hello|hey|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|good morning|good afternoon|good evening)[!. ]*$/.test(
      text,
    )
  ) {
    return true;
  }

  if (/^(how are you|what can you do|who are you|are you there|status\??)\b/.test(text)) {
    return true;
  }

  const executionCue =
    /\b(fix|implement|write|create|add|remove|delete|rename|refactor|run|test|lint|build|debug|search|find|edit|update|change)\b/.test(
      text,
    );
  if (executionCue) return false;

  if (
    /^(yes|confirm|confirmed|proceed|go ahead|go|do it|let'?s?(?: do it| go)?|sure|yep|yup|absolutely|approved?)[!. ]*$/.test(
      text,
    )
  ) {
    return false;
  }

  return text.length <= 120;
}
