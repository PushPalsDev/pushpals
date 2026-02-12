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

// ─── Helpers ────────────────────────────────────────────────────────────────

async function git(
  repoPath: string,
  args: string[],
  opts?: { timeout?: number; githubToken?: string },
): Promise<GitResult> {
  const gitArgs =
    opts?.githubToken && opts.githubToken.length > 0
      ? [
          "git",
          "-c",
          `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(
            `x-access-token:${opts.githubToken}`,
            "utf-8",
          ).toString("base64")}`,
          ...args,
        ]
      : ["git", ...args];

  const proc = Bun.spawn(gitArgs, {
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

function sanitizeBranchComponent(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return cleaned || "integration";
}

// ─── Git Operations ─────────────────────────────────────────────────────────

export class GitOps {
  private repoPath: string;
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
    this.integrationBaseBranch =
      (process.env.PUSHPALS_INTEGRATION_BASE_BRANCH ?? "").trim() || "main";
    this.branchPrefix = config.branchPrefix;
    this.githubToken =
      process.env.PUSHPALS_GIT_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
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
  async syncMainWithBaseBranch(): Promise<void> {
    const baseRef = this.integrationBaseRef();
    if (!(await this.revParse(baseRef))) {
      console.warn(`[source_control_manager] Skipping base sync: ${baseRef} does not exist.`);
      return;
    }

    if (!(await this.revParse(this.localMainRef))) {
      console.warn(
        `[source_control_manager] Skipping base sync: local integration ref ${this.localMainRef} is missing.`,
      );
      return;
    }

    const alreadySynced = await this.isAncestor(baseRef, this.localMainRef);
    if (alreadySynced) return;

    const mergeResult = await git(this.repoPath, ["merge", baseRef, "--no-edit"]);
    if (!mergeResult.ok) {
      throw new Error(
        `Failed to sync ${this.mainBranch} with ${baseRef}: ${mergeResult.stderr || mergeResult.stdout}`,
      );
    }
    const pinResult = await git(this.repoPath, ["update-ref", this.localMainRef, "HEAD"]);
    assertOk(pinResult, `update-ref ${this.localMainRef} HEAD`);
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
