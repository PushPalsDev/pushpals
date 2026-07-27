export type ReviewPublicationLease = {
  targetBranch: string;
  baseBranch: string | null;
  expectedHeadSha: string;
  expectedBaseSha: string | null;
};

function metadataValue(body: string, key: string): string {
  const matches = [...body.matchAll(new RegExp(`<!--\\s*${key}:\\s*([^>]+?)\\s*-->`, "gi"))];
  return matches.at(-1)?.[1]?.trim() ?? "";
}

function normalizeBranch(value: string): string {
  const branch = value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (
    !branch ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    /[~^:?*\[\]\s]/.test(branch)
  ) {
    return "";
  }
  return branch;
}

function normalizeSha(value: string): string {
  const sha = value.trim().toLowerCase();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : "";
}

export function parseReviewPublicationLease(
  prBody: string | null | undefined,
): ReviewPublicationLease | null {
  const body = String(prBody ?? "");
  const targetBranch = normalizeBranch(metadataValue(body, "pushpals-reviewTargetBranch"));
  const baseBranch = normalizeBranch(metadataValue(body, "pushpals-reviewBaseBranch"));
  const expectedHeadSha = normalizeSha(metadataValue(body, "pushpals-reviewExpectedHeadSha"));
  const expectedBaseSha = normalizeSha(metadataValue(body, "pushpals-reviewExpectedBaseSha"));
  if (!targetBranch || !expectedHeadSha) return null;
  return {
    targetBranch,
    baseBranch: baseBranch || null,
    expectedHeadSha,
    expectedBaseSha: expectedBaseSha || null,
  };
}

export function buildReviewPublicationPushArgs(args: {
  remote: string;
  commitSha: string;
  lease: ReviewPublicationLease;
}): string[] {
  return [
    "push",
    `--force-with-lease=refs/heads/${args.lease.targetBranch}:${args.lease.expectedHeadSha}`,
    args.remote,
    `${args.commitSha}:refs/heads/${args.lease.targetBranch}`,
  ];
}

export function buildReviewCompletionValidationCheckoutArgs(
  tempBranch: string,
  commitSha: string,
): string[] {
  return ["checkout", "-B", tempBranch, commitSha];
}

export function reviewCompletionHandoffMatches(
  resolvedSha: string | null | undefined,
  expectedSha: string,
): boolean {
  return normalizeSha(String(resolvedSha ?? "")) === normalizeSha(expectedSha);
}

export function shouldCleanupCompletionHandoff(processedConfirmed: boolean): boolean {
  return processedConfirmed;
}

export function shouldUseReviewPublicationFlow(
  reviewAgentEnabled: boolean,
  lease: ReviewPublicationLease | null,
): boolean {
  return reviewAgentEnabled || lease !== null;
}
