export const ASK_REMOTE_BUDDY_COMMAND = "/ask_remote_buddy";

export type RequestPriority = "interactive" | "normal" | "background";

export function parseStatusHeartbeatMs(fallbackMs: number): number {
  const parsed = Math.floor(fallbackMs);
  if (!Number.isFinite(parsed)) return 120_000;
  if (parsed <= 0) return 0;
  return Math.max(30_000, parsed);
}

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

  const remainder = trimmed.slice(command.length);
  const rest = remainder
    .replace(/^\s*[:\-]\s*/, "")
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
