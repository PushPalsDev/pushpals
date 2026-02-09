import type { SerialPusherConfig } from "./config";

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

// ─── Helpers ────────────────────────────────────────────────────────────────

async function git(
  repoPath: string,
  args: string[],
  opts?: { timeout?: number },
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts?.timeout) {
    timer = setTimeout(() => proc.kill(), opts.timeout);
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
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

function assertOk(result: GitResult, context: string): void {
  if (!result.ok) {
    throw new Error(
      `git ${context} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
}

// ─── Git Operations ─────────────────────────────────────────────────────────

export class GitOps {
  private repoPath: string;
  private remote: string;
  private mainBranch: string;
  private branchPrefix: string;

  constructor(config: SerialPusherConfig) {
    this.repoPath = config.repoPath;
    this.remote = config.remote;
    this.mainBranch = config.mainBranch;
    this.branchPrefix = config.branchPrefix;
  }

  // ── Fetch ─────────────────────────────────────────────────────────────

  /**
   * Fetch all refs from the remote, pruning deleted branches.
   */
  async fetchPrune(): Promise<void> {
    const result = await git(this.repoPath, ["fetch", this.remote, "--prune", "--quiet"]);
    assertOk(result, "fetch --prune");
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
    const result = await git(this.repoPath, ["rev-parse", this.mainBranch]);
    assertOk(result, "rev-parse main");
    return result.stdout;
  }

  /**
   * Checkout the main branch.
   */
  async checkoutMain(): Promise<void> {
    const result = await git(this.repoPath, ["checkout", this.mainBranch, "--quiet"]);
    assertOk(result, "checkout main");
  }

  /**
   * Pull main with fast-forward only. Fails if main has diverged.
   */
  async pullMainFF(): Promise<void> {
    const result = await git(this.repoPath, [
      "pull",
      this.remote,
      this.mainBranch,
      "--ff-only",
      "--quiet",
    ]);
    assertOk(result, "pull --ff-only main");
  }

  // ── Branch operations for merging ─────────────────────────────────────

  /**
   * Create a temporary integration branch from main's HEAD.
   * Used for the merge->check->ff workflow.
   */
  async createTempBranch(name: string): Promise<void> {
    const result = await git(this.repoPath, [
      "checkout",
      "-B",
      name,
      `${this.remote}/${this.mainBranch}`,
      "--quiet",
    ]);
    assertOk(result, `checkout -B ${name}`);
  }

  /**
   * Merge agent branch into main using --no-ff (creates merge commit).
   * Returns the result for conflict detection.
   */
  async mergeNoFF(agentBranch: string, message: string): Promise<GitResult> {
    const remoteBranch = `${this.remote}/${agentBranch}`;
    return git(this.repoPath, ["merge", remoteBranch, "--no-ff", "-m", message]);
  }

  /**
   * Merge a remote agent branch with fast-forward only.
   */
  async mergeFFOnly(agentBranch: string): Promise<GitResult> {
    const remoteBranch = `${this.remote}/${agentBranch}`;
    return git(this.repoPath, ["merge", remoteBranch, "--ff-only"]);
  }

  /**
   * Merge a local ref (e.g. temp branch) with fast-forward only.
   * Unlike mergeFFOnly(), this does NOT prepend the remote prefix.
   */
  async mergeFFOnlyRef(ref: string): Promise<GitResult> {
    return git(this.repoPath, ["merge", ref, "--ff-only"]);
  }

  // ── Push ──────────────────────────────────────────────────────────────

  /**
   * Push main to the remote. Uses --atomic for safety.
   */
  async pushMain(): Promise<GitResult> {
    return git(this.repoPath, ["push", this.remote, this.mainBranch, "--atomic"]);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Delete the temporary integration branch.
   */
  async deleteTempBranch(name: string): Promise<void> {
    await git(this.repoPath, ["branch", "-D", name]);
  }

  /**
   * Delete a remote branch after successful merge.
   */
  async deleteRemoteBranch(branch: string): Promise<void> {
    await git(this.repoPath, ["push", this.remote, "--delete", branch]);
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
    await git(this.repoPath, ["checkout", this.mainBranch, "--force", "--quiet"]);

    // Verify remote-tracking ref exists before hard reset
    const remoteRef = `${this.remote}/${this.mainBranch}`;
    const remoteSha = await this.revParse(remoteRef);
    if (!remoteSha) {
      throw new Error(
        `Remote-tracking ref ${remoteRef} not found. Run: git fetch ${this.remote} ${this.mainBranch}`,
      );
    }

    await git(this.repoPath, ["reset", "--hard", remoteRef, "--quiet"]);
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
