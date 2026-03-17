export function restoreComposerDraft(currentInput: string, attemptedText: string): string {
  const current = String(currentInput ?? "");
  if (current.trim()) return current;
  return String(attemptedText ?? "");
}

export function buildSendFailureMessage(target: "session" | "remote"): string {
  if (target === "remote") {
    return "Remote request was not accepted. Your draft was restored.";
  }
  return "Message was not accepted. Your draft was restored.";
}
