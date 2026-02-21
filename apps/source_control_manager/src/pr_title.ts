export interface ResolveReviewAgentPrTitleArgs {
  commitSubject: string;
  completionPrTitle?: string | null;
  prHeadBranch: string;
  integrationBaseBranch: string;
}

function firstNonEmptyLine(value: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  const line = raw.split(/\r?\n/, 1)[0] ?? "";
  return line.trim();
}

/**
 * Title-only normalization hack:
 * - keep only the first line
 * - if the first line contains " - " segments, keep only the leading segment
 */
export function normalizePrTitleCandidate(value: string): string {
  const firstLine = firstNonEmptyLine(value);
  if (!firstLine) return "";
  const dashIndex = firstLine.indexOf(" - ");
  if (dashIndex < 0) return firstLine;
  return firstLine.slice(0, dashIndex).trim();
}

export function resolveReviewAgentPrTitle(args: ResolveReviewAgentPrTitleArgs): string {
  const commitSubject = normalizePrTitleCandidate(args.commitSubject);
  if (commitSubject) return commitSubject;

  const completionPrTitle = normalizePrTitleCandidate(args.completionPrTitle ?? "");
  if (completionPrTitle) return completionPrTitle;

  return `PushPals: ${args.prHeadBranch.replace(/^agent\//, "")} -> ${args.integrationBaseBranch}`;
}
