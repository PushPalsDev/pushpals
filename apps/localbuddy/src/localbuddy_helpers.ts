import { isLocalReadonlyQueryPrompt } from "./local_readonly.js";

export type RequestPriority = "interactive" | "normal" | "background";

export const ASK_REMOTE_BUDDY_COMMAND = "/ask_remote_buddy";

export function parseStatusHeartbeatMs(fallbackMs: number): number {
  const parsed = Math.floor(fallbackMs);
  if (!Number.isFinite(parsed)) return 120_000;
  if (parsed <= 0) return 0;
  return Math.max(30_000, parsed);
}

export function classifyRemoteRequestPriority(input: string): RequestPriority {
  const text = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!text) return "normal";

  if (
    /\b(status|progress|queue|queued|eta|where|hows my job|what'?s my status|check on)\b/.test(
      text,
    )
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
    /\b(fix|implement|write|create|add|remove|delete|rename|refactor|rewrite|run|test|lint|build|debug|search|find|edit|update|change)\b/.test(
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
