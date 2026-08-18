import { basename, dirname, resolve } from "path";
import { runBoundedProcess as runBoundedWorkerProcess } from "shared";

type LogFn = (stream: "stdout" | "stderr", line: string) => void;

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

type MergeConflictReviewContext = {
  resolutionType: "merge_conflict" | "integration_reconcile";
  publicBranch: string;
  baseBranch: string;
  expectedHeadSha: string;
  expectedBaseSha: string;
  mergeError: string;
};

export type MergeConflictSandboxPreparation = {
  repoPath: string;
  cleanup: () => void;
  conflictPaths: string[];
  plannerGuidance: string;
  rebasedCleanly: boolean;
  currentHeadSha: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeBranchName(
  value: unknown,
  resolutionType: "merge_conflict" | "integration_reconcile",
): string {
  const trimmed = String(value ?? "")
    .trim()
    .replace(/^refs\/heads\//, "");
  const normalized = trimmed
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (resolutionType === "merge_conflict" && !normalized.startsWith("agent/")) return "";
  if (
    normalized.includes("..") ||
    normalized.includes("@{") ||
    normalized.endsWith(".") ||
    normalized.endsWith(".lock")
  ) {
    return "";
  }
  if (/[~^:?*\[\]\s]/.test(normalized)) return "";
  return normalized;
}

function normalizeBaseBranch(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function isMergeConflictOutput(text: string): boolean {
  const normalized = String(text ?? "").toLowerCase();
  return (
    normalized.includes("could not apply") ||
    normalized.includes("resolve all conflicts manually") ||
    normalized.includes("merge conflict") ||
    normalized.includes("fix conflicts and then run")
  );
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  const configuredTimeoutMs = Number(Bun.env.PUSHPALS_WORKERPAL_GIT_COMMAND_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.max(1_000, Math.min(30 * 60_000, Math.floor(configuredTimeoutMs)))
      : 120_000;
  const result = await runBoundedWorkerProcess(["git", ...args], {
    cwd,
    timeoutMs,
    outputLimitBytes: 4 * 1024 * 1024,
  });
  return {
    ok: !result.timedOut && !result.drainTimedOut && result.exitCode === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function mustGit(cwd: string, args: string[], label: string): Promise<string> {
  const result = await git(cwd, args);
  if (!result.ok) {
    throw new Error(`${label} failed: git ${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function dedupeStrings(values: string[], maxItems = 16): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of values) {
    const trimmed = String(entry ?? "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

function deriveLikelyDirs(paths: string[]): string[] {
  return dedupeStrings(
    paths
      .map((entry) => dirname(entry).replace(/\\/g, "/"))
      .filter((entry) => entry && entry !== "."),
    12,
  );
}

function deriveRipgrepQueries(paths: string[]): string[] {
  return dedupeStrings(paths.map((entry) => basename(entry)).filter(Boolean), 8);
}

function isTestPath(path: string): boolean {
  return /(^tests\/|__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$)/i.test(path);
}

function formatBunTestPathArg(path: string): string {
  const normalized = String(path ?? "")
    .replace(/\\/g, "/")
    .trim();
  if (!normalized) return normalized;
  const pathArg =
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
      ? normalized
      : `./${normalized}`;
  return quoteValidationCommandArg(pathArg);
}

function quoteValidationCommandArg(arg: string): string {
  if (!/[\s"\\]/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function deriveValidationSteps(existing: unknown, conflictPaths: string[]): string[] {
  const preserved = Array.isArray(existing)
    ? existing.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const targeted = conflictPaths
    .filter(isTestPath)
    .map((entry) => `bun test ${formatBunTestPathArg(entry)}`);
  const merged = dedupeStrings([...targeted, ...preserved], 8);
  return merged.length > 0 ? merged : ["bun test"];
}

function extractConflictPaths(stdout: string): string[] {
  return dedupeStrings(
    String(stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    32,
  );
}

function buildPlannerGuidance(
  context: MergeConflictReviewContext,
  conflictPaths: string[],
  rebasedCleanly: boolean,
): string {
  const lines = [
    "Merge-conflict host-prepared worktree state:",
    `- The host prepared an isolated detached worktree at the exact leased head for ${context.publicBranch}.`,
    `- SourceControlManager publication target: origin/${context.publicBranch}.`,
    `- Host-side source-control orchestration owns rebase continuation onto origin/${context.baseBranch}.`,
  ];
  if (context.expectedHeadSha) {
    lines.push(
      `- Expected remote lease SHA for SourceControlManager publication: ${context.expectedHeadSha}. If origin/${context.publicBranch} moved, stop and report the mismatch instead of overwriting newer work.`,
    );
  }
  if (context.mergeError) {
    lines.push(`- GitHub mergeability error: ${context.mergeError}`);
  }
  if (rebasedCleanly) {
    lines.push(
      `- The branch is already rebased cleanly onto origin/${context.baseBranch}. Edit only if validation identifies a content defect, then leave publication to SourceControlManager.`,
    );
  } else {
    lines.push(
      `- The host-prepared worktree is already paused mid-rebase onto origin/${context.baseBranch}. Resolve the conflicts in the current repo state instead of re-discovering branch topology.`,
    );
    if (conflictPaths.length > 0) {
      lines.push(`- Unresolved conflict files: ${conflictPaths.join(", ")}`);
    }
    lines.push(
      "- Edit the conflicted files, remove conflict markers, preserve both sides' intended behavior, and run focused validation. Read-only Git inspection such as `git diff -- <path>` is allowed.",
    );
    lines.push(
      "- Do not run checkout, switch, reset, merge, rebase, add, commit, or push commands. Host-side source-control orchestration will stage resolved files and continue the prepared rebase after you return.",
    );
    lines.push(
      "- Budget rule: choose the smallest side-preserving file resolution and focused checks. Do not broaden or refactor beyond what is required to remove conflict markers and retain intended behavior.",
    );
  }
  lines.push(
    "- Do not create a new PR or alternate branch. SourceControlManager owns publication and is the sole process allowed to update the existing PR branch.",
  );
  return lines.join("\n");
}

export function extractMergeConflictReviewContext(
  params: Record<string, unknown> | null | undefined,
): MergeConflictReviewContext | null {
  const reviewAgent = asRecord(params?.reviewAgent);
  if (!reviewAgent) return null;
  const resolutionType = String(reviewAgent.resolutionType ?? "")
    .trim()
    .toLowerCase();
  if (resolutionType !== "merge_conflict" && resolutionType !== "integration_reconcile") {
    return null;
  }

  const publicBranch = normalizeBranchName(
    params?.completionBranch ?? reviewAgent.prHeadRef,
    resolutionType,
  );
  const baseBranch = normalizeBaseBranch(reviewAgent.prBaseRef);
  if (!publicBranch || !baseBranch || publicBranch === baseBranch) return null;

  return {
    resolutionType,
    publicBranch,
    baseBranch,
    expectedHeadSha: String(reviewAgent.prHeadSha ?? "").trim(),
    expectedBaseSha: String(reviewAgent.prBaseSha ?? "").trim(),
    mergeError: String(reviewAgent.mergeError ?? "").trim(),
  };
}

export function isMergeConflictResolutionParams(
  params: Record<string, unknown> | null | undefined,
): boolean {
  return extractMergeConflictReviewContext(params) !== null;
}

export function isReviewResolutionParams(
  params: Record<string, unknown> | null | undefined,
): boolean {
  const reviewAgent = asRecord(params?.reviewAgent);
  const resolutionType = String(reviewAgent?.resolutionType ?? "")
    .trim()
    .toLowerCase();
  return (
    resolutionType === "review_fix" ||
    resolutionType === "merge_conflict" ||
    resolutionType === "integration_reconcile"
  );
}

export function isHostScmOwnedReviewParams(
  params: Record<string, unknown> | null | undefined,
): boolean {
  const reviewAgent = asRecord(params?.reviewAgent);
  return isReviewResolutionParams(params) && reviewAgent?.hostScmGitOwner === true;
}

export function markHostScmGitOwnership(params: Record<string, unknown>): Record<string, unknown> {
  const reviewAgent = asRecord(params.reviewAgent);
  if (!reviewAgent || !isReviewResolutionParams(params)) return params;
  return {
    ...params,
    reviewAgent: {
      ...reviewAgent,
      hostScmGitOwner: true,
    },
  };
}

export function applyMergeConflictExecutionHints(
  params: Record<string, unknown>,
  preparation: MergeConflictSandboxPreparation,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  const planning = asRecord(next.planning) ? { ...(next.planning as Record<string, unknown>) } : {};
  const existingGuidance = String(next.plannerWorkerInstruction ?? "").trim();
  next.plannerWorkerInstruction = [existingGuidance, preparation.plannerGuidance]
    .filter(Boolean)
    .join("\n\n");

  const hintedPaths = preparation.conflictPaths;
  if (hintedPaths.length > 0) {
    const currentTargetPaths = Array.isArray(planning.targetPaths)
      ? planning.targetPaths.map((entry) => String(entry ?? "")).filter(Boolean)
      : [];
    planning.targetPaths = dedupeStrings([...hintedPaths, ...currentTargetPaths], 24);

    const discovery = asRecord(planning.discovery)
      ? { ...(planning.discovery as Record<string, unknown>) }
      : {};
    const likelyDirs = Array.isArray(discovery.likelyDirs)
      ? discovery.likelyDirs.map((entry) => String(entry ?? "")).filter(Boolean)
      : [];
    const ripgrepQueries = Array.isArray(discovery.ripgrepQueries)
      ? discovery.ripgrepQueries.map((entry) => String(entry ?? "")).filter(Boolean)
      : [];
    discovery.likelyDirs = dedupeStrings([...deriveLikelyDirs(hintedPaths), ...likelyDirs], 16);
    discovery.ripgrepQueries = dedupeStrings(
      [...deriveRipgrepQueries(hintedPaths), ...ripgrepQueries],
      16,
    );
    planning.discovery = discovery;
    planning.validationSteps = deriveValidationSteps(planning.validationSteps, hintedPaths);
  }

  next.planning = planning;
  const reviewAgent = asRecord(next.reviewAgent);
  if (reviewAgent) {
    next.reviewAgent = {
      ...reviewAgent,
      preparedWorkspaceMode: "host_prepared_linked_worktree",
      preparedRebaseState: preparation.rebasedCleanly ? "clean" : "conflicted",
      preparedConflictPaths: preparation.conflictPaths,
      preparedHeadSha: preparation.currentHeadSha,
    };
  }
  return next;
}

/**
 * Prepare the already-isolated linked worktree on the host before a worker
 * container starts. The worktree remains detached, so this never switches the
 * user's checkout or creates a disposable public/local branch.
 */
export async function prepareMergeConflictWorktreeOnHost(
  worktreePath: string,
  jobId: string,
  params: Record<string, unknown>,
  onLog?: LogFn,
): Promise<MergeConflictSandboxPreparation> {
  const context = extractMergeConflictReviewContext(params);
  if (!context) {
    return {
      repoPath: worktreePath,
      cleanup: () => {},
      conflictPaths: [],
      plannerGuidance: "",
      rebasedCleanly: false,
      currentHeadSha: "",
    };
  }

  const currentHeadSha = (
    await mustGit(worktreePath, ["rev-parse", "HEAD"], "resolve host worktree HEAD")
  )
    .trim()
    .toLowerCase();
  if (context.expectedHeadSha && currentHeadSha !== context.expectedHeadSha.trim().toLowerCase()) {
    throw new Error(
      `Stale merge-conflict worktree lease for ${jobId}: expected PR head ${context.expectedHeadSha}, but host worktree is ${currentHeadSha}.`,
    );
  }

  const baseRef = context.expectedBaseSha || `refs/remotes/origin/${context.baseBranch}`;
  const resolvedBaseSha = (
    await mustGit(worktreePath, ["rev-parse", `${baseRef}^{commit}`], "resolve leased PR base")
  )
    .trim()
    .toLowerCase();
  if (context.expectedBaseSha && resolvedBaseSha !== context.expectedBaseSha.trim().toLowerCase()) {
    throw new Error(
      `Stale merge-conflict base lease for ${jobId}: expected ${context.expectedBaseSha}, but host resolved ${resolvedBaseSha}.`,
    );
  }

  await mustGit(worktreePath, ["config", "rerere.enabled", "true"], "enable rerere");
  await mustGit(worktreePath, ["config", "rerere.autoupdate", "true"], "enable rerere autoupdate");

  const rebase = await git(worktreePath, ["-c", "core.editor=true", "rebase", resolvedBaseSha]);
  let rebasedCleanly = false;
  let conflictPaths: string[] = [];
  if (rebase.ok) {
    rebasedCleanly = true;
    onLog?.(
      "stdout",
      `[MergeConflictHost] ${jobId}: detached PR head rebased cleanly onto ${resolvedBaseSha.slice(0, 12)} before container execution.`,
    );
  } else if (isMergeConflictOutput(`${rebase.stderr}\n${rebase.stdout}`)) {
    const unresolved = await mustGit(
      worktreePath,
      ["diff", "--name-only", "--diff-filter=U"],
      "list host-prepared unresolved conflict paths",
    );
    conflictPaths = extractConflictPaths(unresolved);
    onLog?.(
      "stdout",
      `[MergeConflictHost] ${jobId}: host paused the detached worktree rebase with ${conflictPaths.length} unresolved file(s) before container execution.`,
    );
  } else {
    throw new Error(rebase.stderr || rebase.stdout || "unknown host-side rebase failure");
  }

  const preparedHeadSha = (
    await mustGit(worktreePath, ["rev-parse", "HEAD"], "resolve prepared host worktree HEAD")
  ).trim();
  return {
    repoPath: resolve(worktreePath),
    cleanup: () => {},
    conflictPaths,
    plannerGuidance: buildPlannerGuidance(context, conflictPaths, rebasedCleanly),
    rebasedCleanly,
    currentHeadSha: preparedHeadSha,
  };
}

export async function refreshMergeConflictWorktreeHints(
  worktreePath: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const context = extractMergeConflictReviewContext(params);
  if (!context) return params;
  const unresolved = await mustGit(
    worktreePath,
    ["diff", "--name-only", "--diff-filter=U"],
    "refresh host-prepared unresolved conflict paths",
  );
  const conflictPaths = extractConflictPaths(unresolved);
  const currentHeadSha = (
    await mustGit(worktreePath, ["rev-parse", "HEAD"], "refresh host-prepared worktree HEAD")
  ).trim();
  return applyMergeConflictExecutionHints(params, {
    repoPath: resolve(worktreePath),
    cleanup: () => {},
    conflictPaths,
    plannerGuidance: buildPlannerGuidance(context, conflictPaths, false),
    rebasedCleanly: false,
    currentHeadSha,
  });
}
