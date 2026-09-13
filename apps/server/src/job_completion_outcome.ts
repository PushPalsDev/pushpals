import {
  classifyJobTerminalSemantics,
  collectJobTerminalEvidence,
} from "./job_terminal_semantics.js";

export type JobCompletionOutcome = {
  success: boolean;
  userAction: "applied" | "no_change" | "needs_clarification";
  reopenedWithin24h: boolean;
  regressionFlag: boolean;
};

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/** Only current terminal declarations are evidence, not task subjects or artifacts. */
export function classifyAutonomyJobCompletion(body: Record<string, unknown>): JobCompletionOutcome {
  const evidence = collectJobTerminalEvidence(body);
  const needsClarification =
    evidence.typed.some((value) =>
      /^(?:needs?|requires?|awaiting)[_ -]clarification$/.test(normalized(value)),
    ) ||
    evidence.prose.some((value) => {
      const text = normalized(value);
      // Existing OpenHands handoffs predate typed clarification outcomes.
      // Preserve that exact backend contract without scanning arbitrary mentions.
      if (/^openhands needs clarification:\s*\S/.test(text)) return true;
      // Require an actual terminal declaration boundary. For example, neither
      // "No clarification needed" nor "Fixed needs_clarification reporting" is one.
      return /^(?:(?:needs?|requires?|awaiting|requested|requesting)[_ -]clarification|clarification (?:is )?(?:needed|required|requested)|waiting for (?:user )?clarification)(?:\s*[.:;!?\n]|$)/.test(
        text,
      );
    });
  if (needsClarification)
    return {
      success: false,
      userAction: "needs_clarification",
      reopenedWithin24h: true,
      regressionFlag: false,
    };
  if (classifyJobTerminalSemantics({ status: "completed", result: body }).noChange)
    return {
      success: false,
      userAction: "no_change",
      reopenedWithin24h: true,
      regressionFlag: false,
    };
  return { success: true, userAction: "applied", reopenedWithin24h: false, regressionFlag: false };
}
