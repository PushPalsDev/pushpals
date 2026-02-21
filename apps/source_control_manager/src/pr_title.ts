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

export function resolveReviewAgentPrTitle(args: ResolveReviewAgentPrTitleArgs): string {
  const commitSubject = firstNonEmptyLine(args.commitSubject);
  if (commitSubject) return commitSubject;

  const completionPrTitle = firstNonEmptyLine(args.completionPrTitle ?? "");
  if (completionPrTitle) return completionPrTitle;

  return `PushPals: ${args.prHeadBranch.replace(/^agent\//, "")} -> ${args.integrationBaseBranch}`;
}
