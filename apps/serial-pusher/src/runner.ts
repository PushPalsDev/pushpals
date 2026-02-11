import type { MergeJob, MergeQueueDB } from "./db";
import type { CheckConfig, SerialPusherConfig } from "./config";
import { GitOps } from "./git";

/**
 * Result of processing a single merge job.
 */
export interface RunResult {
  status: "success" | "failed" | "skipped" | "requeued";
  message: string;
}

// ─── Logger ─────────────────────────────────────────────────────────────────

function log(jobId: number, msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [job:${jobId}] ${msg}`);
}

function logErr(jobId: number, msg: string): void {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [job:${jobId}] ${msg}`);
}

// ─── Check runner ───────────────────────────────────────────────────────────

async function runCheck(
  repoPath: string,
  check: CheckConfig,
): Promise<{ ok: boolean; output: string }> {
  const timeoutMs = check.timeoutMs ?? 300_000;
  const isWindows = process.platform === "win32";
  const shell = isWindows ? ["cmd", "/c"] : ["sh", "-c"];

  const proc = Bun.spawn([...shell, check.command], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return { ok: exitCode === 0, output };
}

// ─── Job runner ─────────────────────────────────────────────────────────────

export class JobRunner {
  private gitOps: GitOps;
  private config: SerialPusherConfig;

  constructor(config: SerialPusherConfig) {
    this.config = config;
    this.gitOps = new GitOps(config);
  }

  /**
   * Process a single merge job through the full pipeline:
   *   1. Reset to clean state
   *   2. Update integration branch (fetch + checkout + pull ff-only)
   *   3. Check if already merged (skip if so)
   *   4. Create temp branch from remote integration-branch HEAD
   *   5. Merge remote agent branch into temp (no-ff or ff-only)
   *   6. Run configured checks on temp branch
   *   7. Checkout integration branch, ff-only merge local temp branch
   *   8. Push integration branch to remote (--atomic)
   *   9. Optionally delete remote agent branch
   *  10. Clean up temp branch
   *
   * Failure modes:
   *   - Merge conflict: markFailed if deterministic (integration branch unchanged);
   *                      requeue if integration branch advanced (may resolve on new base);
   *                      markSkipped if maxAttempts exceeded
   *   - Check failure:  requeue if under maxAttempts, skip otherwise
   *   - Push rejected:  requeue (integration branch advanced mid-run)
   */
  async processJob(job: MergeJob, db: MergeQueueDB): Promise<RunResult> {
    const tempBranch = `_serial-pusher/${job.id}`;
    const mainBefore = await this._safeGetMainSha();

    try {
      // ── Step 1: Clean state ───────────────────────────────────────────
      log(job.id, `Processing branch: ${job.branch}`);
      db.addLog(job.id, `Starting processing of ${job.branch}`);
      await this.gitOps.resetToClean();

      // ── Step 2: Update main ───────────────────────────────────────────
      log(job.id, "Updating main branch");
      await this.gitOps.fetchPrune();
      await this.gitOps.checkoutMain();
      await this.gitOps.pullMainFF();

      // Log SHAs for debugging
      const originMainSha = await this.gitOps.revParse(
        `${this.config.remote}/${this.config.mainBranch}`,
      );
      const originBranchSha = await this.gitOps.revParse(`${this.config.remote}/${job.branch}`);
      log(
        job.id,
        `SHAs: ${this.config.remote}/${this.config.mainBranch}=${originMainSha?.slice(0, 8)}, ${this.config.remote}/${job.branch}=${originBranchSha?.slice(0, 8)}, job.head_sha=${job.head_sha.slice(0, 8)}`,
      );
      db.addLog(
        job.id,
        `${this.config.remote}/${this.config.mainBranch}=${originMainSha?.slice(0, 8)} ${this.config.remote}/${job.branch}=${originBranchSha?.slice(0, 8)} job.head_sha=${job.head_sha.slice(0, 8)}`,
      );

      // ── Step 2.5: Validate job SHA matches current branch HEAD ────────
      // If the remote branch was deleted, skip immediately.
      if (!originBranchSha) {
        const msg = `Remote branch ${this.config.remote}/${job.branch} no longer exists, skipping`;
        log(job.id, msg);
        db.addLog(job.id, msg, "warn");
        db.markSkipped(job.id, msg);
        return { status: "skipped", message: msg };
      }

      // If the branch has advanced since we enqueued, skip this job —
      // a new job for the current SHA will be (or already was) enqueued.
      if (originBranchSha !== job.head_sha) {
        const msg = `Branch advanced: job pinned to ${job.head_sha.slice(0, 8)} but origin is now ${originBranchSha.slice(0, 8)}, skipping (new job will be enqueued)`;
        log(job.id, msg);
        db.addLog(job.id, msg, "warn");
        db.markSkipped(job.id, msg);
        return { status: "skipped", message: msg };
      }

      // ── Step 3: Already merged? ───────────────────────────────────────
      const alreadyMerged = await this.gitOps.isMerged(job.branch);
      if (alreadyMerged) {
        log(job.id, "Branch already merged into main, skipping");
        db.addLog(job.id, "Branch already merged into main");
        db.markSkipped(job.id, "Already merged into main");
        return { status: "skipped", message: "Already merged into main" };
      }

      // ── Step 4: Create temp branch ────────────────────────────────────
      log(job.id, `Creating temp branch: ${tempBranch}`);
      await this.gitOps.createTempBranch(tempBranch);

      // ── Step 5: Merge agent branch ────────────────────────────────────
      log(job.id, "Merging agent branch into temp");
      db.addLog(job.id, "Merging agent branch");

      // Build merge commit message — include shortlog for readability
      let mergeMsg = `merge: ${job.branch}\n\nSerial-pusher job #${job.id}`;
      if (this.config.mergeStrategy !== "ff-only") {
        try {
          const shortlog = await this.gitOps.shortLog(
            `${this.config.remote}/${this.config.mainBranch}`,
            `${this.config.remote}/${job.branch}`,
          );
          if (shortlog.trim()) {
            const lines = shortlog.trim().split("\n").slice(0, 15);
            const suffix = shortlog.trim().split("\n").length > 15 ? "\n  ..." : "";
            mergeMsg += `\n\nCommits:\n  ${lines.join("\n  ")}${suffix}`;
          }
        } catch {
          // shortlog is best-effort; merge still proceeds
        }
      }

      const mergeResult =
        this.config.mergeStrategy === "ff-only"
          ? await this.gitOps.mergeFFOnly(job.branch)
          : await this.gitOps.mergeNoFF(job.branch, mergeMsg);

      if (!mergeResult.ok) {
        const msg = `Merge conflict: ${mergeResult.stderr}`;
        logErr(job.id, msg);
        db.addLog(job.id, msg, "error");

        // Clean up before requeue/skip
        await this.gitOps.resetToClean();
        await this._cleanupTempBranch(tempBranch);

        // Only requeue merge conflicts if main advanced since step 2
        // (the new base might resolve the conflict). Otherwise the conflict
        // is deterministic and retrying just burns cycles.
        const currentMainSha = await this.gitOps.revParse(
          `${this.config.remote}/${this.config.mainBranch}`,
        );
        const mainAdvanced = currentMainSha !== originMainSha;

        if (job.attempts >= this.config.maxAttempts) {
          const skipMsg = `Max attempts (${job.attempts}/${this.config.maxAttempts}) reached: ${msg}`;
          log(job.id, skipMsg);
          db.markSkipped(job.id, skipMsg);
          return { status: "skipped", message: skipMsg };
        }
        if (mainAdvanced) {
          log(
            job.id,
            `Main advanced since step 2; requeuing (attempt ${job.attempts}/${this.config.maxAttempts}, conflict may resolve)`,
          );
          db.requeue(job.id);
          return { status: "requeued", message: msg };
        }
        // Deterministic conflict (main unchanged) — mark failed, no point retrying
        log(
          job.id,
          `Deterministic merge conflict (attempt ${job.attempts}/${this.config.maxAttempts}), marking failed`,
        );
        db.markFailed(job.id, msg);
        return { status: "failed", message: msg };
      }

      // ── Step 6: Run checks ────────────────────────────────────────────
      for (const check of this.config.checks) {
        log(job.id, `Running check: ${check.name}`);
        db.addLog(job.id, `Running check: ${check.name}`);

        const checkResult = await runCheck(this.config.repoPath, check);

        if (!checkResult.ok) {
          const msg = `Check "${check.name}" failed: ${truncate(checkResult.output, 500)}`;
          logErr(job.id, msg);
          db.addLog(job.id, msg, "error");

          // Clean up
          await this.gitOps.resetToClean();
          await this._cleanupTempBranch(tempBranch);

          if (job.attempts >= this.config.maxAttempts) {
            const skipMsg = `Max attempts (${job.attempts}/${this.config.maxAttempts}) reached: ${msg}`;
            log(job.id, skipMsg);
            db.markSkipped(job.id, skipMsg);
            return { status: "skipped", message: skipMsg };
          }
          log(
            job.id,
            `Check failed (attempt ${job.attempts}/${this.config.maxAttempts}), requeuing`,
          );
          db.requeue(job.id);
          return { status: "requeued", message: msg };
        }

        db.addLog(job.id, `Check "${check.name}" passed`);
      }

      // ── Step 7: Move merge to main ────────────────────────────────────
      log(job.id, "Updating main with merged result");
      await this.gitOps.checkoutMain();

      // Log temp branch head for debugging
      const tempSha = await this.gitOps.revParse(tempBranch);
      log(job.id, `Temp branch head: ${tempSha?.slice(0, 8)}`);

      // Fast-forward main to the local temp branch head (which contains the merge).
      // This should always succeed because temp was created from main HEAD.
      const ffResult = await this.gitOps.mergeFFOnlyRef(tempBranch);
      if (!ffResult.ok) {
        // FF failed — this is unexpected. Instead of hard-resetting (which could
        // clobber state), re-sync from remote and retry once.
        logErr(job.id, `FF merge failed: ${ffResult.stderr}`);
        db.addLog(
          job.id,
          `FF merge failed (stderr: ${truncate(ffResult.stderr, 300)}), re-syncing and retrying`,
          "warn",
        );

        // Re-sync: reset main to remote/main and try FF again
        await this.gitOps.resetToClean();
        await this.gitOps.checkoutMain();
        await this.gitOps.pullMainFF();

        // Verify main is an ancestor of temp (required for FF to succeed).
        // Resolve both to SHAs for unambiguous comparison.
        const mainSha = await this.gitOps.revParse(this.config.mainBranch);
        const tempSha2 = await this.gitOps.revParse(tempBranch);
        const mainIsAncestorOfTemp =
          mainSha && tempSha2 ? await this.gitOps.isAncestor(mainSha, tempSha2) : false;

        if (!mainIsAncestorOfTemp) {
          const msg = `Invariant violation: main (${mainSha?.slice(0, 8)}) is not an ancestor of temp (${tempSha2?.slice(0, 8)}). Cannot FF.`;
          logErr(job.id, msg);
          db.addLog(job.id, msg, "error");
          db.markFailed(job.id, msg);
          await this.gitOps.resetToClean();
          await this._cleanupTempBranch(tempBranch);
          return { status: "failed", message: msg };
        }

        const retryResult = await this.gitOps.mergeFFOnlyRef(tempBranch);
        if (!retryResult.ok) {
          const msg = `FF merge failed even after re-sync: ${retryResult.stderr}`;
          logErr(job.id, msg);
          db.addLog(job.id, msg, "error");
          db.markFailed(job.id, msg);
          await this.gitOps.resetToClean();
          await this._cleanupTempBranch(tempBranch);
          return { status: "failed", message: msg };
        }
      }

      // ── Step 8: Push main ─────────────────────────────────────────────
      log(job.id, "Pushing main to remote");
      db.addLog(job.id, "Pushing main");

      const pushResult = await this.gitOps.pushMain();
      if (!pushResult.ok) {
        const pushOutput = [pushResult.stdout, pushResult.stderr].filter(Boolean).join("\n");

        // Determine if this is a non-fast-forward rejection (remote advanced)
        // vs a true push failure (auth, network, permissions).
        // After fetching, use ancestry to disambiguate:
        //   - Remote NOT behind/equal to local → remote has new commits → requeue
        //   - Remote behind/equal → push failed for other reasons → mark failed
        let remoteAdvanced = false;
        try {
          await this.gitOps.fetchPrune();
          const localMain = await this.gitOps.revParse(this.config.mainBranch);
          const remoteMain = await this.gitOps.revParse(
            `${this.config.remote}/${this.config.mainBranch}`,
          );
          if (localMain && remoteMain && localMain !== remoteMain) {
            // Check: is remoteMain an ancestor-or-equal of localMain?
            // If yes, the remote is simply behind us (push failed for non-advancing reasons).
            // If no, remote has commits we don't have → someone else pushed.
            const remoteIsAncestorOfLocal = await this.gitOps.isAncestor(remoteMain, localMain);
            remoteAdvanced = !remoteIsAncestorOfLocal;
          }
        } catch {
          // If fetch fails too, treat as true failure
        }

        if (remoteAdvanced) {
          const msg = `Push rejected: main advanced during processing, requeuing (attempt ${job.attempts}/${this.config.maxAttempts})`;
          log(job.id, msg);
          db.addLog(job.id, `${msg} (output: ${truncate(pushOutput, 200)})`, "warn");
          db.requeue(job.id);
          await this.gitOps.resetToClean();
          await this._cleanupTempBranch(tempBranch);
          return { status: "requeued", message: msg };
        }

        const msg = `Push failed: ${truncate(pushOutput, 500)}`;
        logErr(job.id, msg);
        db.addLog(job.id, msg, "error");
        db.markFailed(job.id, msg);
        await this.gitOps.resetToClean();
        await this._cleanupTempBranch(tempBranch);
        return { status: "failed", message: msg };
      }

      // ── Step 9: Optional cleanup of remote branch ─────────────────────
      if (this.config.deleteAfterMerge) {
        log(job.id, `Deleting remote branch: ${job.branch}`);
        try {
          await this.gitOps.deleteRemoteBranch(job.branch);
          db.addLog(job.id, `Deleted remote branch: ${job.branch}`);
        } catch (err: any) {
          db.addLog(job.id, `Failed to delete remote branch: ${err.message}`, "warn");
        }
      }

      // ── Step 10: Clean up temp branch ─────────────────────────────────
      await this._cleanupTempBranch(tempBranch);

      // ── Done ──────────────────────────────────────────────────────────
      const mainAfter = await this._safeGetMainSha();
      log(job.id, `Success: main ${mainBefore?.slice(0, 8)}..${mainAfter?.slice(0, 8)}`);
      db.addLog(job.id, `Merged successfully. main: ${mainAfter?.slice(0, 8)}`);
      db.markSuccess(job.id);

      return { status: "success", message: `Merged ${job.branch} into ${this.config.mainBranch}` };
    } catch (err: any) {
      const msg = `Unexpected error: ${err.message}`;
      logErr(job.id, msg);
      db.addLog(job.id, msg, "error");
      db.markFailed(job.id, msg);

      // Always try to restore clean state
      try {
        await this.gitOps.resetToClean();
        await this._cleanupTempBranch(tempBranch);
      } catch {
        // ignore — best-effort cleanup
      }

      return { status: "failed", message: msg };
    }
  }

  private async _safeGetMainSha(): Promise<string | null> {
    try {
      return await this.gitOps.getMainHeadSha();
    } catch {
      return null;
    }
  }

  private async _cleanupTempBranch(name: string): Promise<void> {
    try {
      await this.gitOps.deleteTempBranch(name);
    } catch {
      // ignore
    }
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "... (truncated)";
}
