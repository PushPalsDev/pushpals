import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";

type LogFn = (stream: "stdout" | "stderr", line: string) => void;

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

type MergeConflictReviewContext = {
  publicBranch: string;
  baseBranch: string;
  expectedHeadSha: string;
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

function normalizeBranchName(value: unknown): string {
  const trimmed = String(value ?? "").trim().replace(/^refs\/heads\//, "");
  const normalized = trimmed
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized.startsWith("agent/")) return "";
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
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    ok: exitCode === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
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
  const normalized = String(path ?? "").replace(/\\/g, "/").trim();
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
    "Merge-conflict sandbox state:",
    `- You are on local branch ${context.publicBranch} inside an isolated container-local clone. This branch exists only inside the worker sandbox and does not switch the user's active checkout.`,
    `- Remote push target: origin/${context.publicBranch}`,
    `- Rebase target: origin/${context.baseBranch}`,
  ];
  if (context.expectedHeadSha) {
    lines.push(
      `- Expected remote lease SHA for push-back: ${context.expectedHeadSha}. If origin/${context.publicBranch} moved, stop and report the mismatch instead of overwriting newer work.`,
    );
  }
  if (context.mergeError) {
    lines.push(`- GitHub mergeability error: ${context.mergeError}`);
  }
  if (rebasedCleanly) {
    lines.push(
      `- The branch already rebased cleanly onto origin/${context.baseBranch} in this sandbox. Validate the rebased result and leave the repo clean for finalization.`,
    );
  } else {
    lines.push(
      `- The sandbox branch is already paused mid-rebase onto origin/${context.baseBranch}. Resolve the conflicts in the current repo state instead of re-discovering branch topology.`,
    );
    if (conflictPaths.length > 0) {
      lines.push(`- Unresolved conflict files: ${conflictPaths.join(", ")}`);
    }
    lines.push(
      "- Use direct commands only while resolving this rebase. Prefer `git diff -- <path>`, `git add <path>`, and `git -c core.editor=true rebase --continue` instead of `/bin/bash -lc`, `sh -lc`, `awk`, or chained shell snippets.",
    );
    lines.push(
      "- Primary success condition: finish the git rebase and leave no active rebase/merge/cherry-pick state. Do not spend budget polishing, broadening, or refactoring tests beyond what is required to remove conflict markers and keep both sides' intended behavior.",
    );
    lines.push(
      "- Rebase convergence rule: after resolving each conflicted file, run `git diff --name-only --diff-filter=U`. If no unresolved paths remain, stage the resolved files and continue the rebase immediately before doing broader validation.",
    );
    lines.push(
      "- Budget rule: if conflict resolution is running long, choose the smallest side-preserving resolution, stage it, and continue the rebase. A clean rebased branch with focused follow-up validation is better than a richer partial patch left mid-rebase.",
    );
    lines.push(
      "- After editing, run `git add <files>` and `git -c core.editor=true rebase --continue` until the rebase completes.",
    );
  }
  lines.push("- Do not create a new PR or alternate branch. Update only the existing PR branch.");
  return lines.join("\n");
}

export function extractMergeConflictReviewContext(
  params: Record<string, unknown> | null | undefined,
): MergeConflictReviewContext | null {
  const reviewAgent = asRecord(params?.reviewAgent);
  if (!reviewAgent) return null;
  const resolutionType = String(reviewAgent.resolutionType ?? "").trim().toLowerCase();
  if (resolutionType !== "merge_conflict") return null;

  const publicBranch = normalizeBranchName(params?.completionBranch ?? reviewAgent.prHeadRef);
  const baseBranch = normalizeBaseBranch(reviewAgent.prBaseRef);
  if (!publicBranch || !baseBranch) return null;

  return {
    publicBranch,
    baseBranch,
    expectedHeadSha: String(reviewAgent.prHeadSha ?? "").trim(),
    mergeError: String(reviewAgent.mergeError ?? "").trim(),
  };
}

export function isMergeConflictResolutionParams(
  params: Record<string, unknown> | null | undefined,
): boolean {
  return extractMergeConflictReviewContext(params) !== null;
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
      preparedWorkspaceMode: "isolated_container_clone",
      preparedRebaseState: preparation.rebasedCleanly ? "clean" : "conflicted",
      preparedConflictPaths: preparation.conflictPaths,
      preparedHeadSha: preparation.currentHeadSha,
    };
  }
  return next;
}

export async function prepareMergeConflictTaskRepo(
  sourceRepo: string,
  jobId: string,
  params: Record<string, unknown>,
  onLog?: LogFn,
): Promise<MergeConflictSandboxPreparation> {
  const context = extractMergeConflictReviewContext(params);
  if (!context) {
    return {
      repoPath: sourceRepo,
      cleanup: () => {},
      conflictPaths: [],
      plannerGuidance: "",
      rebasedCleanly: false,
      currentHeadSha: "",
    };
  }

  const remoteUrl = await mustGit(sourceRepo, ["remote", "get-url", "origin"], "read origin URL");
  const sourceUserName = (await git(sourceRepo, ["config", "--get", "user.name"])).stdout.trim();
  const sourceUserEmail = (await git(sourceRepo, ["config", "--get", "user.email"])).stdout.trim();
  const sandboxRoot = mkdtempSync(join(tmpdir(), "pushpals-merge-conflict-"));
  const repoPath = join(sandboxRoot, "repo");
  mkdirSync(repoPath, { recursive: true });

  const cleanup = () => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  };

  try {
    await mustGit(repoPath, ["init", "--quiet"], "init sandbox repo");
    await mustGit(repoPath, ["remote", "add", "origin", remoteUrl], "add origin");
    await mustGit(
      repoPath,
      ["config", "user.name", sourceUserName || "PushPals WorkerPal"],
      "configure user.name",
    );
    await mustGit(
      repoPath,
      ["config", "user.email", sourceUserEmail || "pushpals-worker@local"],
      "configure user.email",
    );
    await mustGit(repoPath, ["config", "rerere.enabled", "true"], "enable rerere");
    await mustGit(repoPath, ["config", "rerere.autoupdate", "true"], "enable rerere autoupdate");

    const fetchArgs = [
      "fetch",
      "--quiet",
      "origin",
      `+refs/heads/${context.publicBranch}:refs/remotes/origin/${context.publicBranch}`,
      `+refs/heads/${context.baseBranch}:refs/remotes/origin/${context.baseBranch}`,
    ];
    await mustGit(repoPath, fetchArgs, "fetch merge-conflict refs");
    await mustGit(
      repoPath,
      ["checkout", "-B", context.publicBranch, `refs/remotes/origin/${context.publicBranch}`],
      "checkout PR branch in sandbox",
    );
    await mustGit(
      repoPath,
      ["branch", "--set-upstream-to", `origin/${context.publicBranch}`, context.publicBranch],
      "set sandbox upstream",
    );

    const baseRemoteRef = `refs/remotes/origin/${context.baseBranch}`;
    const rebase = await git(repoPath, ["-c", "core.editor=true", "rebase", baseRemoteRef]);
    let conflictPaths: string[] = [];
    let rebasedCleanly = false;
    if (rebase.ok) {
      rebasedCleanly = true;
      const note = `[MergeConflictSandbox] ${jobId}: ${context.publicBranch} rebased cleanly onto origin/${context.baseBranch}.`;
      onLog?.("stdout", note);
    } else if (isMergeConflictOutput(`${rebase.stderr}\n${rebase.stdout}`)) {
      const unresolved = await mustGit(
        repoPath,
        ["diff", "--name-only", "--diff-filter=U"],
        "list unresolved conflict paths",
      );
      conflictPaths = extractConflictPaths(unresolved);
      const note = `[MergeConflictSandbox] ${jobId}: prepared isolated sandbox for ${context.publicBranch} with ${conflictPaths.length} unresolved file(s).`;
      onLog?.("stdout", note);
    } else {
      throw new Error(rebase.stderr || rebase.stdout || "unknown rebase failure");
    }

    const currentHeadSha = await mustGit(repoPath, ["rev-parse", "HEAD"], "resolve sandbox HEAD");
    return {
      repoPath: resolve(repoPath),
      cleanup,
      conflictPaths,
      plannerGuidance: buildPlannerGuidance(context, conflictPaths, rebasedCleanly),
      rebasedCleanly,
      currentHeadSha,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
