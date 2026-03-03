import { execFileSync } from "child_process";
import { readFileSync, realpathSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

import {
  type RepoStatus,
  type StartupChecklistContext,
  type StartupChecklistFailure,
  type StartupChecklistOptions,
  type StartupChecklistResult,
  type StartupCheckRecord,
  type SyntheticStartupTestOptions,
  type SyntheticStartupTestResult,
  type SyntheticStartupTester,
  runStartupPreflight,
} from "./startup/checklist.js";

export type RepoSequencerFlags = {
  isMergeInProgress: boolean;
  isRebaseInProgress: boolean;
  isCherryPickInProgress: boolean;
  isRevertInProgress: boolean;
  indicators: string[];
};

export type RepoHealthStatus = RepoStatus & {
  gitDir: string | null;
  dirtyFileCount: number;
  sequencer: RepoSequencerFlags;
};

export interface RemoteBuddyPreflightFailure extends StartupChecklistFailure {
  sanitizedDetail: string;
  rawDetail?: string;
}

export interface RemoteBuddyPreflightResult {
  ok: boolean;
  history: StartupCheckRecord[];
  repoStatus: RepoHealthStatus;
  failure?: RemoteBuddyPreflightFailure;
}

export interface RemoteBuddyPreflightOptions {
  repoRoot: string;
  allowDirtyWorktree?: boolean;
  syntheticMaxLatencyMs?: number;
  syntheticProbeName?: string;
  listFiringAlerts?: () => Promise<string[]>;
  syntheticTester?: SyntheticStartupTester;
  now?: () => number;
  log?: (record: StartupCheckRecord) => void;
}

type GitRunResult = {
  stdout: string;
  exitCode: number;
};

type ReplacementPattern = {
  regex: RegExp;
  replacement: string;
};

const DEFAULT_SYNTHETIC_TESTER: SyntheticStartupTester = {
  async runSyntheticJob(options: SyntheticStartupTestOptions): Promise<SyntheticStartupTestResult> {
    return { ok: true, latencyMs: options.maxLatencyMs ?? 0 };
  },
};

const DEFAULT_ALERTS_LIST = async (): Promise<string[]> => [];

async function git(args: string[], cwd: string): Promise<GitRunResult> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), exitCode };
}

function ensureRealPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectPathVariants(pathValue: string): string[] {
  const variants = new Set<string>();
  const record = (candidate: string | undefined | null) => {
    const trimmed = candidate?.trim();
    if (!trimmed) return;
    variants.add(trimmed);
    variants.add(trimmed.replace(/\\/g, "/"));
    variants.add(trimmed.replace(/\//g, "\\"));
  };
  record(pathValue);
  const real = ensureRealPath(pathValue);
  if (real !== pathValue) {
    record(real);
  }
  return Array.from(variants).filter(Boolean);
}

function buildPathReplacementPatterns(pathValue: string, replacement: string): ReplacementPattern[] {
  return collectPathVariants(pathValue).map((variant) => ({
    regex: new RegExp(escapeRegex(variant), "gi"),
    replacement,
  }));
}

function resolveGitDirViaGit(repoRoot: string): string | null {
  try {
    const output = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const dir = output.toString("utf8").trim();
    if (!dir) return null;
    return ensureRealPath(resolve(repoRoot, dir));
  } catch {
    return null;
  }
}

export function resolveGitDirPath(repoRoot: string): string | null {
  const gitPath = join(repoRoot, ".git");
  try {
    const stats = statSync(gitPath);
    if (stats.isDirectory()) return ensureRealPath(gitPath);
    if (!stats.isFile()) return null;
    const contents = readFileSync(gitPath, "utf8");
    const match = contents.match(/gitdir:\s*(.+)\s*/i);
    if (!match) return null;
    const pointer = match[1].trim();
    if (!pointer) return null;
    return ensureRealPath(resolve(dirname(gitPath), pointer));
  } catch {
    // fall through to git-based discovery
  }
  return resolveGitDirViaGit(repoRoot);
}

function pathExists(path: string, expectDirectory = false): boolean {
  try {
    const stats = statSync(path);
    if (expectDirectory) return stats.isDirectory();
    return stats.isFile() || stats.isFIFO() || stats.isCharacterDevice();
  } catch {
    return false;
  }
}

export function detectSequencerFlags(gitDir: string | null): RepoSequencerFlags {
  if (!gitDir) {
    return {
      isMergeInProgress: false,
      isRebaseInProgress: false,
      isCherryPickInProgress: false,
      isRevertInProgress: false,
      indicators: [],
    };
  }

  const indicators: string[] = [];
  const mergeHead = pathExists(join(gitDir, "MERGE_HEAD"));
  if (mergeHead) indicators.push("MERGE_HEAD");
  const rebaseApply = pathExists(join(gitDir, "rebase-apply"), true);
  if (rebaseApply) indicators.push("rebase-apply");
  const rebaseMerge = pathExists(join(gitDir, "rebase-merge"), true);
  if (rebaseMerge) indicators.push("rebase-merge");
  const cherryPick = pathExists(join(gitDir, "CHERRY_PICK_HEAD"));
  if (cherryPick) indicators.push("CHERRY_PICK_HEAD");
  const revert = pathExists(join(gitDir, "REVERT_HEAD"));
  if (revert) indicators.push("REVERT_HEAD");

  return {
    isMergeInProgress: mergeHead,
    isRebaseInProgress: rebaseApply || rebaseMerge,
    isCherryPickInProgress: cherryPick,
    isRevertInProgress: revert,
    indicators,
  };
}

function buildRepoDetail(status: RepoHealthStatus): string {
  const notes: string[] = [];
  if (status.dirtyFileCount > 0) {
    notes.push(`${status.dirtyFileCount} dirty path${status.dirtyFileCount === 1 ? "" : "s"}`);
  }
  if (status.sequencer.indicators.length > 0) {
    notes.push(`sequencer active (${status.sequencer.indicators.join(", ")})`);
  }
  return notes.length > 0 ? notes.join("; ") : "Repo clean.";
}

export async function describeRepo(
  repoRoot: string,
  gitDirOverride?: string | null,
): Promise<RepoHealthStatus> {
  const gitDirCandidate = gitDirOverride ?? resolveGitDirPath(repoRoot);
  const gitDir = gitDirCandidate ? ensureRealPath(gitDirCandidate) : null;
  const sequencer = detectSequencerFlags(gitDir);
  const [statusResult, branchResult] = await Promise.all([
    git(["status", "--porcelain"], repoRoot),
    git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot),
  ]);
  const dirtyLines = statusResult.stdout
    ? statusResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  const dirtyFileCount = dirtyLines.length;
  const repoStatus: RepoHealthStatus = {
    isDirty: dirtyFileCount > 0,
    isMergeInProgress:
      sequencer.isMergeInProgress ||
      sequencer.isRebaseInProgress ||
      sequencer.isCherryPickInProgress ||
      sequencer.isRevertInProgress,
    branch: branchResult.stdout || undefined,
    detail: "",
    gitDir,
    dirtyFileCount,
    sequencer,
  };
  return { ...repoStatus, detail: buildRepoDetail(repoStatus) };
}

export function sanitizePreflightDetail(detail: string | undefined, repoRoot?: string): string {
  const replacementPatterns: ReplacementPattern[] = [];
  if (repoRoot) {
    replacementPatterns.push(...buildPathReplacementPatterns(repoRoot, "<repo>"));
  }
  const home = process.env.HOME;
  if (home) {
    replacementPatterns.push(...buildPathReplacementPatterns(home, "~"));
  }
  const normalized = String(detail ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Preflight failed (no detail provided).";
  let redacted = normalized;
  for (const { regex, replacement } of replacementPatterns) {
    redacted = redacted.replace(regex, replacement);
  }
  return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
}

export function formatStartupCheckLog(
  record: StartupCheckRecord,
  options: { repoRoot?: string; source: string },
): { level: "info" | "error"; message: string; detail: string } {
  const detail = sanitizePreflightDetail(record.detail, options.repoRoot);
  const prefix = `[RemoteBuddy][preflight][${options.source}] step=${record.step} code=${record.code}`;
  const suffix = record.status === "pass" ? `: ${detail}` : ` FAILED: ${detail}`;
  return {
    level: record.status === "pass" ? "info" : "error",
    detail,
    message: `${prefix}${suffix}`,
  };
}

export class RemoteBuddyPreflightCache {
  private entry: { result: RemoteBuddyPreflightResult; expiresAt: number } | null = null;

  constructor(private readonly ttlMs = 500, private readonly now: () => number = () => Date.now()) {}

  get(): RemoteBuddyPreflightResult | null {
    if (!this.entry) return null;
    if (this.now() >= this.entry.expiresAt) {
      this.entry = null;
      return null;
    }
    return this.entry.result;
  }

  set(result: RemoteBuddyPreflightResult): void {
    this.entry = { result, expiresAt: this.now() + Math.max(150, this.ttlMs) };
  }

  invalidate(): void {
    this.entry = null;
  }
}

export async function runRemoteBuddyPreflight(
  options: RemoteBuddyPreflightOptions,
): Promise<RemoteBuddyPreflightResult> {
  const gitDir = resolveGitDirPath(options.repoRoot);
  const repoStatusPromise = describeRepo(options.repoRoot, gitDir);
  const context: StartupChecklistContext = {
    describeRepo: () => repoStatusPromise,
    listFiringAlerts: options.listFiringAlerts ?? DEFAULT_ALERTS_LIST,
    syntheticTester: options.syntheticTester ?? DEFAULT_SYNTHETIC_TESTER,
    now: options.now,
    log: options.log,
  };
  const checklistOptions: StartupChecklistOptions = {
    allowDirtyWorktree: options.allowDirtyWorktree,
    syntheticMaxLatencyMs: options.syntheticMaxLatencyMs,
    syntheticProbeName: options.syntheticProbeName,
  };
  const checklistResult: StartupChecklistResult = await runStartupPreflight(context, checklistOptions);
  const repoStatus = await repoStatusPromise;
  const failure = checklistResult.failure
    ? (() => {
        const rawDetail = checklistResult.failure.detail;
        const sanitizedDetail = sanitizePreflightDetail(rawDetail, options.repoRoot);
        return {
          ...checklistResult.failure,
          detail: sanitizedDetail,
          sanitizedDetail,
          rawDetail,
        } satisfies RemoteBuddyPreflightFailure;
      })()
    : undefined;
  return {
    ok: checklistResult.ok,
    history: checklistResult.history,
    repoStatus,
    failure,
  };
}

export type { StartupCheckRecord } from "./startup/checklist.js";
