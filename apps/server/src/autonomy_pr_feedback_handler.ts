import { AutonomyStore } from "./autonomy.js";

type CompactTextFn = (value: unknown, maxChars?: number) => string;

const defaultCompactText: CompactTextFn = (value, maxChars = 500) => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
};

export interface AutonomyPrFeedbackEvent {
  sessionId: string;
  objectiveId: string;
  patternKey: string;
  outcome: string;
  success: boolean;
}

export function handleAutonomyPrFeedbackRequest(opts: {
  body: Record<string, unknown>;
  autonomyStore: AutonomyStore;
  compactText?: CompactTextFn;
}): {
  status: number;
  response: Record<string, unknown>;
  event?: AutonomyPrFeedbackEvent;
} {
  const result = opts.autonomyStore.recordPrFeedback(opts.body);
  if (!result.ok) {
    return { status: 400, response: result };
  }

  const compact = opts.compactText ?? defaultCompactText;
  const pickField = (candidates: unknown[], maxChars: number, fallback: string): string => {
    for (const candidate of candidates) {
      const text = compact(candidate, maxChars);
      if (text) return text;
    }
    return fallback;
  };
  const sessionId = compact(opts.body.sessionId, 128);
  const objectiveId = pickField(
    [opts.body.objectiveId, opts.body.objective_id, result.objectiveId],
    128,
    "unknown",
  );
  const patternKey = pickField(
    [opts.body.patternKey, opts.body.pattern_key, result.patternKey],
    128,
    "unknown",
  );
  const outcome = pickField(
    [opts.body.verdict, opts.body.userAction, opts.body.user_action],
    120,
    "pr_feedback",
  );
  const success =
    typeof result.success === "boolean" ? result.success : Boolean(opts.body.success);

  return {
    status: 200,
    response: result,
    ...(sessionId
      ? {
          event: {
            sessionId,
            objectiveId,
            patternKey,
            outcome,
            success,
          },
        }
      : {}),
  };
}
