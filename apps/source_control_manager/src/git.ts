import { resolve, win32 as pathWin32 } from "path";
import {
  assertSupportedSourceControlProvider,
  explicitSourceControlCommitIdentityFromEnv,
  resolveSourceControlProvider,
  sanitizeSourceControlIdentityField,
  type SourceControlCommitIdentity,
  type SourceControlProvider,
} from "shared";
import type { SourceControlManagerConfig } from "./config";

/**
 * Result from a spawned git command.
 */
export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Discovered agent branch with its HEAD SHA.
 */
export interface DiscoveredBranch {
  branch: string;
  sha: string;
}

export interface TempBranchCleanupSummary {
  deletedBranches: string[];
  removedWorktrees: string[];
  failedBranches: string[];
  warnings: string[];
}

export type IntegrationBaseSyncResult =
  | {
      status: "up_to_date";
      integrationHeadSha: string;
      baseHeadSha: string;
      conflictPaths: [];
    }
  | {
      status: "updated";
      integrationHeadSha: string;
      baseHeadSha: string;
      mergedHeadSha: string;
      conflictPaths: [];
    }
  | {
      status: "conflicted";
      integrationHeadSha: string;
      baseHeadSha: string;
      conflictPaths: string[];
      detail: string;
    };

export interface SourceControlApi {
  readonly provider: SourceControlProvider;
  readonly repoPath: string;

  getCommitIdentity(): Promise<SourceControlCommitIdentity | null>;
  fetchPrune(): Promise<void>;
  bootstrapMainBranchFromBase(): Promise<void>;
  discoverAgentBranches(): Promise<DiscoveredBranch[]>;
  getMainHeadSha(): Promise<string>;
  checkoutMain(): Promise<void>;
  pullMainFF(): Promise<void>;
  syncMainWithBaseBranch(): Promise<IntegrationBaseSyncResult>;
  createTempBranch(name: string): Promise<void>;
  mergeNoFF(agentBranch: string, message: string): Promise<GitResult>;
  mergeFFOnly(agentBranch: string): Promise<GitResult>;
  mergeFFOnlyRef(ref: string): Promise<GitResult>;
  cherryPickRef(ref: string): Promise<GitResult>;
  pushMain(): Promise<GitResult>;
  deleteTempBranch(name: string): Promise<void>;
  cleanupLocalTempBranches(prefix?: string): Promise<TempBranchCleanupSummary>;
  deleteRemoteBranch(branch: string): Promise<void>;
  deleteLocalRef(ref: string): Promise<void>;
  resetToClean(): Promise<void>;
  isRepoClean(): Promise<boolean>;
  revParse(ref: string): Promise<string | null>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  shortLog(from: string, to: string): Promise<string>;
  isMerged(branch: string): Promise<boolean>;
}

type GitWorktreeEntry = {
  path: string;
  branch: string | null;
  detached: boolean;
};

type ResponseBody = ConstructorParameters<typeof Response>[0];

function readSubprocessOutput(output: ResponseBody | number | undefined): Promise<string> {
  if (!output || typeof output === "number") return Promise.resolve("");
  return new Response(output).text();
}

function normalizeFsPathForComparison(value: string): string {
  const resolved = resolve(String(value ?? "").trim())
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parseGitWorktreeListPorcelain(stdout: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  const blocks = String(stdout ?? "")
    .split(/\r?\n\r?\n/g)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/g);
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine) continue;
    const branchLine = lines.find((line) => line.startsWith("branch "));
    entries.push({
      path: pathLine.slice("worktree ".length).trim(),
      branch: branchLine ? branchLine.slice("branch ".length).trim() : null,
      detached: lines.includes("detached"),
    });
  }

  return entries;
}

export function resolveGitExecutableCandidatesFromEnv(): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (value: string): void => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return;
    const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(trimmed);
  };

  // Prefer the PATH-based command first because compiled Windows runtimes can
  // fail to spawn some absolute `git.exe` paths even when PATH lookup works.
  pushCandidate(process.env.PUSHPALS_GIT_BIN ?? "");
  pushCandidate(process.env.PUSHPALS_GIT_BIN_ABSOLUTE ?? "");
  pushCandidate("git");

  return candidates;
}

export function resolveGitExecutableFromEnv(): string {
  return resolveGitExecutableCandidatesFromEnv()[0] ?? "git";
}

function pushUniqueCandidate(
  candidates: string[],
  seen: Set<string>,
  value: string,
  platform = process.platform,
): void {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return;
  const key = platform === "win32" ? trimmed.toLowerCase() : trimmed;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(trimmed);
}

export function resolveWindowsShellExecutableCandidates(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  platform = process.platform,
): string[] {
  if (platform !== "win32") return [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  const comSpec = String(env.ComSpec ?? env.COMSPEC ?? "").trim();
  const systemRoot = String(env.SystemRoot ?? env.SYSTEMROOT ?? "").trim();

  pushUniqueCandidate(candidates, seen, comSpec, platform);
  if (systemRoot) {
    pushUniqueCandidate(
      candidates,
      seen,
      pathWin32.join(systemRoot, "System32", "cmd.exe"),
      platform,
    );
    pushUniqueCandidate(
      candidates,
      seen,
      pathWin32.join(systemRoot, "Sysnative", "cmd.exe"),
      platform,
    );
  }
  pushUniqueCandidate(candidates, seen, "cmd.exe", platform);
  return candidates;
}

export function resolveWindowsWhereExecutableCandidates(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  platform = process.platform,
): string[] {
  if (platform !== "win32") return [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  const systemRoot = String(env.SystemRoot ?? env.SYSTEMROOT ?? "").trim();

  if (systemRoot) {
    pushUniqueCandidate(
      candidates,
      seen,
      pathWin32.join(systemRoot, "System32", "where.exe"),
      platform,
    );
    pushUniqueCandidate(
      candidates,
      seen,
      pathWin32.join(systemRoot, "Sysnative", "where.exe"),
      platform,
    );
  }
  pushUniqueCandidate(candidates, seen, "where.exe", platform);
  pushUniqueCandidate(candidates, seen, "where", platform);
  return candidates;
}

function formatGitSpawnFailure(gitExecutable: string, err: unknown): string {
  return `spawn ${gitExecutable} failed: ${err instanceof Error ? err.message : String(err)}`;
}

function quoteWindowsCmdArg(value: string): string {
  const str = String(value ?? "");
  if (!str.length) return '""';
  if (!/[ \t"]/.test(str)) return str;
  const escaped = str.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

function isWindowsCommandNotFound(output: string, exitCode: number): boolean {
  if (exitCode === 9009) return true;
  return /is not recognized as an internal or external command/i.test(output);
}

async function runViaWindowsCmd(
  repoPath: string,
  commandArgs: string[],
  timeout?: number,
): Promise<GitResult> {
  const commandLine = commandArgs.map((arg) => quoteWindowsCmdArg(arg)).join(" ");
  const env = process.env as Record<string, string | undefined>;
  const shellCandidates = resolveWindowsShellExecutableCandidates(env);
  const spawnFailures: string[] = [];

  for (const shellExecutable of shellCandidates) {
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn([shellExecutable, "/d", "/s", "/c", commandLine], {
        cwd: repoPath,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      spawnFailures.push(formatGitSpawnFailure(shellExecutable, err));
      continue;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeout) {
      timer = setTimeout(() => proc.kill(), timeout);
    }

    const [stdout, stderr] = await Promise.all([
      readSubprocessOutput(proc.stdout),
      readSubprocessOutput(proc.stderr),
    ]);

    const exitCode = await proc.exited;
    if (timer) clearTimeout(timer);

    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  }

  throw new Error(
    spawnFailures.length > 0
      ? spawnFailures.join(" | ")
      : "spawn cmd.exe failed: no Windows shell candidates were available",
  );
}

async function expandWindowsGitExecutableCandidates(
  repoPath: string,
  candidates: string[],
): Promise<string[]> {
  if (process.platform !== "win32") return candidates;

  const expanded: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value: string): void => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    expanded.push(trimmed);
  };

  for (const candidate of candidates) {
    const hasPath = /[\\/]/.test(candidate) || /^[A-Za-z]:/.test(candidate);
    if (!hasPath) {
      const whereCandidates = resolveWindowsWhereExecutableCandidates(
        process.env as Record<string, string | undefined>,
      );
      for (const whereExecutable of whereCandidates) {
        try {
          const proc = Bun.spawn([whereExecutable, candidate], {
            cwd: repoPath,
            env: process.env as Record<string, string | undefined>,
            stdout: "pipe",
            stderr: "ignore",
          });
          const [stdout, exitCode] = await Promise.all([
            readSubprocessOutput(proc.stdout),
            proc.exited,
          ]);
          if (exitCode === 0) {
            for (const resolved of stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0)) {
              pushCandidate(resolved);
            }
          }
          break;
        } catch {
          // Try the next where.exe candidate.
        }
      }
    }
    pushCandidate(candidate);
  }

  return expanded.length > 0 ? expanded : candidates;
}

export async function runGitCommandCapture(
  repoPath: string,
  args: string[],
  opts?: { timeout?: number; githubToken?: string },
): Promise<GitResult> {
  const gitExecutables = await expandWindowsGitExecutableCandidates(
    repoPath,
    resolveGitExecutableCandidatesFromEnv(),
  );
  const spawnFailures: string[] = [];

  for (const gitExecutable of gitExecutables) {
    const gitArgs =
      opts?.githubToken && opts.githubToken.length > 0
        ? [
            gitExecutable,
            "-c",
            `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(
              `x-access-token:${opts.githubToken}`,
              "utf-8",
            ).toString("base64")}`,
            ...args,
          ]
        : [gitExecutable, ...args];

    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn(gitArgs, {
        cwd: repoPath,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      spawnFailures.push(formatGitSpawnFailure(gitExecutable, err));
      if (process.platform === "win32") {
        try {
          const shellResult = await runViaWindowsCmd(repoPath, gitArgs, opts?.timeout);
          const output = [shellResult.stdout, shellResult.stderr].filter(Boolean).join("\n");
          if (!isWindowsCommandNotFound(output, shellResult.exitCode)) {
            return shellResult;
          }
          spawnFailures.push(
            `spawn ${gitExecutable} via cmd.exe failed: ${shellResult.stderr || shellResult.stdout || `exit ${shellResult.exitCode}`}`,
          );
        } catch (shellErr) {
          spawnFailures.push(formatGitSpawnFailure("cmd.exe", shellErr));
        }
      }
      continue;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeout) {
      timer = setTimeout(() => proc.kill(), opts.timeout);
    }

    const [stdout, stderr] = await Promise.all([
      readSubprocessOutput(proc.stdout),
      readSubprocessOutput(proc.stderr),
    ]);

    const exitCode = await proc.exited;
    if (timer) clearTimeout(timer);

    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  }

  return {
    ok: false,
    stdout: "",
    stderr:
      spawnFailures.length > 0
        ? spawnFailures.join(" | ")
        : "spawn git failed: no executable candidates were available",
    exitCode: 127,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function git(
  repoPath: string,
  args: string[],
  opts?: { timeout?: number; githubToken?: string },
): Promise<GitResult> {
  return runGitCommandCapture(repoPath, args, opts);
}

function assertOk(result: GitResult, context: string): void {
  if (!result.ok) {
    throw new Error(
      `git ${context} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
}

function sanitizeBranchComponent(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return cleaned || "integration";
}

// ─── Source Control API ─────────────────────────────────────────────────────

export function createSourceControlApi(
  config: SourceControlManagerConfig,
  options: { provider?: unknown } = {},
): SourceControlApi {
  const provider = resolveSourceControlProvider(options.provider);
  assertSupportedSourceControlProvider(provider);
  return new GitSourceControlApi(config);
}

export class GitSourceControlApi implements SourceControlApi {
  readonly provider = "git" as const;
  readonly repoPath: string;
  private remote: string;
  private mainBranch: string;
  private localMainRef: string;
  private integrationBaseBranch: string;
  private branchPrefix: string;
  private githubToken: string | null;

  constructor(config: SourceControlManagerConfig) {
    this.repoPath = config.repoPath;
    this.remote = config.remote;
    this.mainBranch = config.mainBranch;
    this.localMainRef = `refs/pushpals/source_control_manager/local/${sanitizeBranchComponent(config.mainBranch)}`;
    this.integrationBaseBranch = config.integrationBaseBranch;
    this.branchPrefix = config.branchPrefix;
    this.githubToken = config.gitToken ?? null;
  }

  private async gitConfigValue(key: string): Promise<string> {
    const result = await git(this.repoPath, ["config", "--get", key]);
    return result.ok ? sanitizeSourceControlIdentityField(result.stdout) : "";
  }

  async getCommitIdentity(): Promise<SourceControlCommitIdentity | null> {
    const fallbackEmail = await this.gitConfigValue("user.email");
    const explicit = explicitSourceControlCommitIdentityFromEnv(process.env, fallbackEmail);
    if (explicit) return explicit;

    const name = await this.gitConfigValue("user.name");
    if (name && fallbackEmail) {
      return { name, email: fallbackEmail, source: "source-control-config" };
    }
    return null;
  }

  private remoteMainRef(): string {
    return `${this.remote}/${this.mainBranch}`;
  }

  private integrationBaseRef(): string {
    return `${this.remote}/${this.integrationBaseBranch}`;
  }

  /**
   * Resolve the best available base ref for main-branch operations.
   *
   * Preference order:
   * 1) remote integration branch (normal steady-state)
   * 2) local SourceControlManager integration branch
   * 3) remote/HEAD (bootstrap integration branch from remote default branch)
   * 4) HEAD (last-resort bootstrap)
   */
  private async resolveMainBaseRef(): Promise<string> {
    const remoteMain = this.remoteMainRef();
    if (await this.revParse(remoteMain)) return remoteMain;

    if (await this.revParse(this.localMainRef)) return this.localMainRef;

    const remoteHead = `${this.remote}/HEAD`;
    if (await this.revParse(remoteHead)) {
      console.warn(
        `[source_control_manager] ${remoteMain} not found; bootstrapping ${this.mainBranch} from ${remoteHead}.`,
      );
      return remoteHead;
    }

    console.warn(
      `[source_control_manager] ${remoteMain} and ${this.localMainRef} not found; bootstrapping from HEAD.`,
    );
    return "HEAD";
  }

  private async resolveAgentMergeRef(agentBranch: string): Promise<string> {
    if (agentBranch.startsWith("refs/")) {
      const exists = await this.revParse(agentBranch);
      if (exists) return agentBranch;
    }

    const hiddenRef = `refs/pushpals/${agentBranch.replace(/^\/+/, "")}`;
    if (await this.revParse(hiddenRef)) return hiddenRef;

    const localRef = `refs/heads/${agentBranch}`;
    const remoteRef = `refs/remotes/${this.remote}/${agentBranch}`;

    const localExists = await this.revParse(localRef);
    if (localExists) return agentBranch;

    const remoteExists = await this.revParse(remoteRef);
    if (remoteExists) return `${this.remote}/${agentBranch}`;

    throw new Error(
      `Branch not found locally or on ${this.remote}: ${agentBranch} (checked ${localRef} and ${remoteRef})`,
    );
  }

  // ── Fetch ─────────────────────────────────────────────────────────────

  /**
   * Fetch all refs from the remote, pruning deleted branches.
   */
  async fetchPrune(): Promise<void> {
    const result = await git(
      this.repoPath,
      ["fetch", this.remote, "--prune", "--quiet"],
      this.githubToken ? { githubToken: this.githubToken } : undefined,
    );
    assertOk(result, "fetch --prune");
  }

  /**
   * Bootstrap the integration branch when it doesn't yet exist on remote.
   *
   * Creates/resets local SourceControlManager branch from `origin/<integration-base-branch>`,
   * sets upstream to that base ref, then pushes it to remote `<mainBranch>`.
   */
  async bootstrapMainBranchFromBase(): Promise<void> {
    await this.fetchPrune();

    const baseRef = this.integrationBaseRef();
    const baseSha = await this.revParse(baseRef);
    if (!baseSha) {
      throw new Error(`Cannot bootstrap ${this.mainBranch}: base ref ${baseRef} not found.`);
    }

    const checkoutResult = await git(this.repoPath, ["checkout", "--detach", baseRef, "--quiet"]);
    assertOk(checkoutResult, `checkout --detach ${baseRef}`);
    const pinResult = await git(this.repoPath, ["update-ref", this.localMainRef, "HEAD"]);
    assertOk(pinResult, `update-ref ${this.localMainRef} HEAD`);

    const pushResult = await git(
      this.repoPath,
      ["push", this.remote, `HEAD:refs/heads/${this.mainBranch}`],
      this.githubToken ? { githubToken: this.githubToken } : undefined,
    );
    if (!pushResult.ok) {
      // Branch may have been created concurrently by another process.
      await this.fetchPrune();
      if (await this.revParse(this.remoteMainRef())) {
        console.warn(
          `[source_control_manager] Push failed while bootstrapping ${this.mainBranch}, but remote branch now exists.`,
        );
        return;
      }
      throw new Error(
        `Failed to push bootstrap branch ${this.mainBranch}: ${pushResult.stderr || pushResult.stdout}`,
      );
    }
  }

  // ── Branch discovery ──────────────────────────────────────────────────

  /**
   * Discover remote branches matching the agent prefix pattern.
   * Returns branch names (without `refs/remotes/<remote>/`) and their HEAD SHAs.
   *
   * Note: strip=3 removes 3 path components (refs/remotes/<remote>/) which
   * is correct for remote-tracking refs under the standard layout.
   */
  async discoverAgentBranches(): Promise<DiscoveredBranch[]> {
    const refPrefix = `refs/remotes/${this.remote}/${this.branchPrefix}`;
    const result = await git(this.repoPath, [
      "for-each-ref",
      "--format=%(refname:strip=3)\t%(objectname)",
      refPrefix,
    ]);

    if (!result.ok || !result.stdout) return [];

    return result.stdout.split("\n").map((line) => {
      const tabIdx = line.lastIndexOf("\t");
      return {
        branch: line.slice(0, tabIdx),
        sha: line.slice(tabIdx + 1),
      };
    });
  }

  // ── Main branch operations ────────────────────────────────────────────

  /**
   * Get the current HEAD SHA of the local main branch.
   */
  async getMainHeadSha(): Promise<string> {
    const result = await git(this.repoPath, ["rev-parse", this.localMainRef]);
    assertOk(result, "rev-parse main");
    return result.stdout;
  }

  /**
   * Checkout the main branch.
   */
  async checkoutMain(): Promise<void> {
    const localMainExists = await this.revParse(this.localMainRef);
    const result = localMainExists
      ? await git(this.repoPath, ["checkout", "--detach", this.localMainRef, "--quiet"])
      : await git(this.repoPath, [
          "checkout",
          "--detach",
          await this.resolveMainBaseRef(),
          "--quiet",
        ]);
    assertOk(result, "checkout main");
  }

  /**
   * Pull main with fast-forward only. Fails if main has diverged.
   */
  async pullMainFF(): Promise<void> {
    const remoteMain = this.remoteMainRef();
    if (!(await this.revParse(remoteMain))) {
      console.warn(
        `[source_control_manager] Skipping pull: remote branch ${remoteMain} does not exist yet.`,
      );
      return;
    }

    const result = await git(this.repoPath, ["merge", remoteMain, "--ff-only", "--quiet"]);
    assertOk(result, "merge --ff-only remote-main");
    const pinResult = await git(this.repoPath, ["update-ref", this.localMainRef, "HEAD"]);
    assertOk(pinResult, `update-ref ${this.localMainRef} HEAD`);
  }

  /**
   * Merge the configured integration base (e.g. origin/main) into the local
   * integration branch so integration stays aligned with source-of-truth.
   */
  async syncMainWithBaseBranch(): Promise<IntegrationBaseSyncResult> {
    const baseRef = this.integrationBaseRef();
    const baseHeadSha = await this.revParse(baseRef);
    if (!baseHeadSha) {
      console.warn(`[source_control_manager] Skipping base sync: ${baseRef} does not exist.`);
      throw new Error(`Cannot sync ${this.mainBranch}: base ref ${baseRef} does not exist.`);
    }

    const integrationHeadSha = await this.revParse(this.localMainRef);
    if (!integrationHeadSha) {
      console.warn(
        `[source_control_manager] Skipping base sync: local integration ref ${this.localMainRef} is missing.`,
      );
      throw new Error(
        `Cannot sync ${this.mainBranch}: local integration ref ${this.localMainRef} is missing.`,
      );
    }

    const alreadySynced = await this.isAncestor(baseRef, this.localMainRef);
    if (alreadySynced) {
      return {
        status: "up_to_date",
        integrationHeadSha,
        baseHeadSha,
        conflictPaths: [],
      };
    }

    const mergeResult = await git(this.repoPath, ["merge", baseRef, "--no-edit"]);
    if (!mergeResult.ok) {
      const conflicts = await git(this.repoPath, ["diff", "--name-only", "--diff-filter=U"]);
      const conflictPaths = conflicts.ok
        ? conflicts.stdout
            .split(/\r?\n/)
            .map((value) => value.trim().replace(/\\/g, "/"))
            .filter(Boolean)
        : [];
      const detail = mergeResult.stderr || mergeResult.stdout || "merge failed";
      await git(this.repoPath, ["merge", "--abort"]);
      const restore = await git(this.repoPath, [
        "checkout",
        "--detach",
        this.localMainRef,
        "--quiet",
      ]);
      assertOk(restore, `restore ${this.localMainRef} after base-sync conflict`);
      if (conflictPaths.length === 0) {
        throw new Error(`Failed to sync ${this.mainBranch} with ${baseRef}: ${detail}`);
      }
      return {
        status: "conflicted",
        integrationHeadSha,
        baseHeadSha,
        conflictPaths,
        detail,
      };
    }
    const pinResult = await git(this.repoPath, ["update-ref", this.localMainRef, "HEAD"]);
    assertOk(pinResult, `update-ref ${this.localMainRef} HEAD`);
    const mergedHeadSha = await this.revParse("HEAD");
    if (!mergedHeadSha) {
      throw new Error(`Failed to resolve merged ${this.mainBranch} head after syncing ${baseRef}.`);
    }
    return {
      status: "updated",
      integrationHeadSha,
      baseHeadSha,
      mergedHeadSha,
      conflictPaths: [],
    };
  }

  // ── Branch operations for merging ─────────────────────────────────────

  /**
   * Create a temporary integration branch from main's HEAD.
   * Used for the merge->check->ff workflow.
   */
  async createTempBranch(name: string): Promise<void> {
    const baseRef = (await this.revParse(this.localMainRef))
      ? this.localMainRef
      : await this.resolveMainBaseRef();
    const result = await git(this.repoPath, ["checkout", "-B", name, baseRef, "--quiet"]);
    assertOk(result, `checkout -B ${name}`);
  }

  /**
   * Merge agent branch into main using --no-ff (creates merge commit).
   * Returns the result for conflict detection.
   */
  async mergeNoFF(agentBranch: string, message: string): Promise<GitResult> {
    const mergeRef = await this.resolveAgentMergeRef(agentBranch);
    return git(this.repoPath, ["merge", mergeRef, "--no-ff", "-m", message]);
  }

  /**
   * Merge a remote agent branch with fast-forward only.
   */
  async mergeFFOnly(agentBranch: string): Promise<GitResult> {
    const mergeRef = await this.resolveAgentMergeRef(agentBranch);
    return git(this.repoPath, ["merge", mergeRef, "--ff-only"]);
  }

  /**
   * Merge a local ref (e.g. temp branch) with fast-forward only.
   * Unlike mergeFFOnly(), this does NOT prepend the remote prefix.
   */
  async mergeFFOnlyRef(ref: string): Promise<GitResult> {
    return git(this.repoPath, ["merge", ref, "--ff-only"]);
  }

  /**
   * Cherry-pick a specific commit/ref onto the current branch.
   * Keeps integration history linear and avoids merge commits.
   */
  async cherryPickRef(ref: string): Promise<GitResult> {
    return git(this.repoPath, ["cherry-pick", ref]);
  }

  // ── Push ──────────────────────────────────────────────────────────────

  /**
   * Push main to the remote. Uses --atomic for safety.
   */
  async pushMain(): Promise<GitResult> {
    return git(
      this.repoPath,
      ["push", this.remote, `HEAD:refs/heads/${this.mainBranch}`, "--atomic"],
      this.githubToken ? { githubToken: this.githubToken } : undefined,
    );
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Delete the temporary integration branch.
   */
  async deleteTempBranch(name: string): Promise<void> {
    await git(this.repoPath, ["branch", "-D", name]);
  }

  /**
   * Delete all local temp branches with the given prefix.
   * Intended for daemon shutdown cleanup after interrupted runs.
   */
  async cleanupLocalTempBranches(
    prefix = "_source_control_manager/",
  ): Promise<TempBranchCleanupSummary> {
    const normalizedPrefix = prefix.trim().replace(/^\/+/, "");
    const warnings: string[] = [];
    const deletedBranches: string[] = [];
    const removedWorktrees: string[] = [];
    const failedBranches: string[] = [];
    if (!normalizedPrefix) {
      return { deletedBranches, removedWorktrees, failedBranches, warnings };
    }

    // Move off temp branches first so deletion does not fail due to "branch checked out".
    try {
      await this.resetToClean();
    } catch (err: any) {
      warnings.push(`resetToClean failed before temp-branch cleanup: ${err?.message ?? err}`);
    }

    const listResult = await git(
      this.repoPath,
      ["for-each-ref", "--format=%(refname:short)", `refs/heads/${normalizedPrefix}`],
      { timeout: 15_000 },
    );
    if (!listResult.ok) {
      warnings.push(`for-each-ref failed: ${listResult.stderr || listResult.stdout}`);
      return { deletedBranches, removedWorktrees, failedBranches, warnings };
    }

    const worktreeList = await git(this.repoPath, ["worktree", "list", "--porcelain"], {
      timeout: 15_000,
    });
    if (!worktreeList.ok) {
      warnings.push(`worktree list failed: ${worktreeList.stderr || worktreeList.stdout}`);
    } else {
      const currentRepoPath = normalizeFsPathForComparison(this.repoPath);
      const linkedWorktrees = parseGitWorktreeListPorcelain(worktreeList.stdout).filter((entry) => {
        if (!entry.branch) return false;
        if (!entry.branch.startsWith(`refs/heads/${normalizedPrefix}`)) return false;
        return normalizeFsPathForComparison(entry.path) !== currentRepoPath;
      });

      for (const entry of linkedWorktrees) {
        const removeResult = await git(
          this.repoPath,
          ["worktree", "remove", "--force", "--force", entry.path],
          { timeout: 15_000 },
        );
        if (removeResult.ok) {
          removedWorktrees.push(entry.path);
          continue;
        }
        warnings.push(
          `failed to remove linked temp worktree ${entry.path}: ${removeResult.stderr || removeResult.stdout}`,
        );
      }
    }

    const branches = listResult.stdout
      .split(/\r?\n/g)
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.startsWith(normalizedPrefix));

    for (const branch of branches) {
      const deleteResult = await git(this.repoPath, ["branch", "-D", branch], { timeout: 15_000 });
      if (deleteResult.ok) {
        deletedBranches.push(branch);
      } else {
        failedBranches.push(`${branch}: ${deleteResult.stderr || deleteResult.stdout}`);
      }
    }

    const pruneResult = await git(this.repoPath, ["worktree", "prune"], { timeout: 15_000 });
    if (!pruneResult.ok) {
      warnings.push(`worktree prune failed: ${pruneResult.stderr || pruneResult.stdout}`);
    }

    return { deletedBranches, removedWorktrees, failedBranches, warnings };
  }

  /**
   * Delete a remote branch after successful merge.
   */
  async deleteRemoteBranch(branch: string): Promise<void> {
    await git(
      this.repoPath,
      ["push", this.remote, "--delete", branch],
      this.githubToken ? { githubToken: this.githubToken } : undefined,
    );
  }

  /**
   * Delete a local ref (used for internal worker refs in refs/pushpals/*).
   */
  async deleteLocalRef(ref: string): Promise<void> {
    await git(this.repoPath, ["update-ref", "-d", ref]);
  }

  /**
   * Reset any in-progress merge/rebase and return to main.
   * Does NOT run git clean (to avoid nuking untracked files in shared repos).
   * Throws a clear error if the remote-tracking ref does not exist.
   */
  async resetToClean(): Promise<void> {
    // Abort any in-progress operations (these may fail if nothing is in progress — that's fine)
    await git(this.repoPath, ["rebase", "--abort"]);
    await git(this.repoPath, ["merge", "--abort"]);
    await git(this.repoPath, ["cherry-pick", "--abort"]);
    const baseRef = await this.resolveMainBaseRef();
    const checkoutResult = await git(this.repoPath, ["checkout", "--detach", baseRef, "--quiet"]);
    assertOk(checkoutResult, `checkout --detach ${baseRef}`);

    // Prefer hard reset to remote/main when available.
    const remoteRef = this.remoteMainRef();
    const remoteSha = await this.revParse(remoteRef);
    const resetTarget = remoteSha ? remoteRef : "HEAD";
    if (!remoteSha) {
      console.warn(
        `[source_control_manager] Remote-tracking ref ${remoteRef} not found; using detached HEAD state.`,
      );
    }

    const resetResult = await git(this.repoPath, ["reset", "--hard", resetTarget, "--quiet"]);
    assertOk(resetResult, `reset --hard ${resetTarget}`);
    const pinResult = await git(this.repoPath, ["update-ref", this.localMainRef, "HEAD"]);
    assertOk(pinResult, `update-ref ${this.localMainRef} HEAD`);
  }

  /**
   * Check if the working tree is clean (no modified or untracked files).
   * Returns true if `git status --porcelain` produces no output.
   */
  async isRepoClean(): Promise<boolean> {
    const result = await git(this.repoPath, ["status", "--porcelain"]);
    return result.ok && result.stdout.length === 0;
  }

  /**
   * Resolve a ref to its SHA.
   */
  async revParse(ref: string): Promise<string | null> {
    const result = await git(this.repoPath, ["rev-parse", ref]);
    return result.ok ? result.stdout : null;
  }

  /**
   * Check if `ancestor` is an ancestor of `descendant`.
   */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await git(this.repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return result.ok;
  }

  /**
   * Get the short log for a commit range (for merge commit messages).
   */
  async shortLog(from: string, to: string): Promise<string> {
    const result = await git(this.repoPath, ["log", "--oneline", `${from}..${to}`]);
    return result.ok ? result.stdout : "";
  }

  /**
   * Check if a remote agent branch has already been merged into main.
   * Returns true when every commit on the branch is reachable from main,
   * i.e. the branch tip is an ancestor of (or equal to) the main tip.
   */
  async isMerged(branch: string): Promise<boolean> {
    const branchTip = `${this.remote}/${branch}`;
    const mainTip = `${this.remote}/${this.mainBranch}`;
    // ancestor=branchTip, descendant=mainTip  →  "is branch an ancestor of main?"
    return this.isAncestor(branchTip, mainTip);
  }
}

/**
 * Backward-compatible name while call sites migrate from Git-specific naming
 * to the source-control API abstraction.
 */
export class GitOps extends GitSourceControlApi {}
