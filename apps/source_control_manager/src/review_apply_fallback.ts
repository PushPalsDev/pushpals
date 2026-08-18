export interface ReviewApplyFallbackInput {
  reviewAgentEnabled: boolean;
  mergeStrategy: string;
  applyStdout?: string | null;
  applyStderr?: string | null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function isCherryPickConflictOutput(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  return (
    normalized.includes("could not apply") ||
    normalized.includes("after resolving the conflicts") ||
    normalized.includes("cherry-pick --continue") ||
    normalized.includes("merge conflict") ||
    normalized.includes("conflict (content)")
  );
}

export function reviewApplyFailureBlocksPublication(input: ReviewApplyFallbackInput): true {
  const combined = [input.applyStderr ?? "", input.applyStdout ?? ""].filter(Boolean).join("\n");
  // A conflict is useful classification for repair dispatch, never permission
  // to bypass SourceControlManager validation and publish the worker branch.
  void isCherryPickConflictOutput(combined);
  return true;
}
