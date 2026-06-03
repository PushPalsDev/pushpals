#!/usr/bin/env bun
/**
 * Docker Job Runner - Standalone job execution daemon inside Docker
 *
 * This script runs inside a Docker container and executes a single job.
 * It's designed to be the entrypoint for sandboxed job execution.
 *
 * Usage (inside container):
 *   bun run job_runner.ts <base64-encoded-job-spec>
 *   bun run job_runner.ts --spec-stdin
 *
 * The job spec is base64-encoded JSON: { jobId, taskId, kind, params, workerId }
 *
 * Output:
 *   stderr → JSON log lines: {"stream":"stdout|stderr","line":"..."}
 *   stdout → Result with sentinel: ___RESULT___ {"ok":true,...,"commit":{...}}
 */

import { executeJob, shouldCommit, createJobCommit } from "./execute_job.js";
import { loadPushPalsConfig } from "shared";
import { writeFileSync } from "fs";
import {
  applyMergeConflictExecutionHints,
  isMergeConflictResolutionParams,
  prepareMergeConflictTaskRepo,
} from "./merge_conflict_job.js";

const CONFIG = loadPushPalsConfig();

// ─── Types ──────────────────────────────────────────────────────────────────

interface JobSpec {
  jobId: string;
  taskId: string;
  kind: string;
  params: Record<string, unknown>;
  workerId: string;
}

interface JobResult {
  ok: boolean;
  summary: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  commit?: {
    branch: string;
    sha: string;
  };
  publishBlocked?: {
    summary: string;
    detail: string;
    publicBranch: string;
    localRef: string;
    sha: string;
    stage: "sync" | "push";
  };
}

// ─── Logging helpers ────────────────────────────────────────────────────────

function log(stream: "stdout" | "stderr", line: string): void {
  const json = JSON.stringify({ stream, line });
  // eslint-disable-next-line no-console
  console.error(json);
}

// ─── Git credentials setup ──────────────────────────────────────────────────

function setupGitCredentials(): void {
  const token = CONFIG.gitToken ?? process.env.GIT_TOKEN ?? null;
  if (!token) return;
  try {
    // Use a credential helper script and avoid remote URL rewriting with embedded secrets.
    // This keeps push auth stable and prevents token leakage in git stderr output.
    const helperScript = `#!/bin/sh
echo "username=x-access-token"
echo "password=${token}"
`;
    const helperPath = "/tmp/git-credential-helper";
    writeFileSync(helperPath, helperScript, { mode: 0o755 });

    // Remove any legacy URL rewrite rules that may have embedded token credentials.
    const urlRules = Bun.spawnSync(
      ["git", "config", "--global", "--get-regexp", "^url\\..*\\.insteadOf$"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (urlRules.exitCode === 0) {
      const lines = String(urlRules.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        const key = line.split(/\s+/, 1)[0] ?? "";
        if (!key) continue;
        const lower = key.toLowerCase();
        if (!lower.startsWith("url.")) continue;
        if (!lower.endsWith(".insteadof")) continue;
        if (!lower.includes("oauth2") && !lower.includes("%3a//")) continue;
        Bun.spawnSync(["git", "config", "--global", "--unset-all", key], {
          stdout: "pipe",
          stderr: "pipe",
        });
      }
    }

    Bun.spawnSync(["git", "config", "--global", "credential.helper", helperPath]);
  } catch (err) {
    log("stderr", `Failed to setup git credentials: ${err}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rawSpecArg = args[0];

  if (!rawSpecArg) {
    // eslint-disable-next-line no-console
    console.error("Usage: bun run job_runner.ts <base64-encoded-job-spec>|--spec-stdin");
    process.exit(1);
  }

  const base64Spec =
    rawSpecArg === "--spec-stdin" ? (await Bun.stdin.text()).trim() : rawSpecArg;
  if (!base64Spec) {
    // eslint-disable-next-line no-console
    console.error("Job spec was empty");
    process.exit(1);
  }

  // Decode base64 job spec
  let spec: JobSpec;
  try {
    const json = Buffer.from(base64Spec, "base64").toString("utf-8");
    spec = JSON.parse(json);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Failed to decode job spec: ${err}`);
    process.exit(1);
  }
  log("stdout", `[JobRunner] Starting job ${spec.jobId} (${spec.kind})`);
  // Setup git credentials for pushing
  setupGitCredentials();
  // Execute inside the mounted job worktree (docker -w), not the baked image copy.
  const mountedJobRepo = process.cwd();
  let jobRepo = mountedJobRepo;
  let cleanupJobRepo: (() => void) | null = null;
  let effectiveParams = spec.params;
  try {
    if (isMergeConflictResolutionParams(spec.params)) {
      const prepared = await prepareMergeConflictTaskRepo(
        mountedJobRepo,
        spec.jobId,
        spec.params,
        log,
      );
      jobRepo = prepared.repoPath;
      cleanupJobRepo = prepared.cleanup;
      effectiveParams = applyMergeConflictExecutionHints(spec.params, prepared);
      log(
        "stdout",
        `[JobRunner] Merge-conflict job ${spec.jobId} is running in isolated sandbox repo ${jobRepo}`,
      );
    }
    const result = await executeJob(
      spec.kind,
      effectiveParams,
      jobRepo,
      (stream, line) => {
        log(stream, line);
      },
      CONFIG,
    );
    // Build result object
    const jobResult: JobResult = {
      ok: result.ok,
      summary: result.summary,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
    // Create commit for file-modifying jobs
    if (result.ok && shouldCommit(spec.kind, CONFIG)) {
      log("stdout", `[JobRunner] Job modified files, creating commit...`);
      const commitResult = await createJobCommit(
        jobRepo,
        spec.workerId,
        {
          id: spec.jobId,
          taskId: spec.taskId,
          kind: spec.kind,
          params: effectiveParams,
          context: "docker",
        },
        CONFIG,
      );

      if (commitResult.ok && commitResult.sha && commitResult.branch) {
        jobResult.commit = {
          branch: commitResult.branch!,
          sha: commitResult.sha,
        };
        if (commitResult.sha === "no-changes") {
          log("stdout", `[JobRunner] No changes to commit for ${spec.jobId}`);
        } else {
          log("stdout", `[JobRunner] Created commit ${commitResult.sha} on ${commitResult.branch}`);
        }
      } else {
        const commitError =
          commitResult.error ??
          `Commit metadata missing for ${spec.kind} (${spec.jobId}) while running in Docker mode`;
        jobResult.ok = false;
        jobResult.summary =
          commitResult.publishBlocked?.summary ?? `Failed to create commit for ${spec.kind}`;
        jobResult.stderr = [jobResult.stderr, commitError].filter(Boolean).join("\n");
        if (commitResult.publishBlocked) {
          jobResult.publishBlocked = commitResult.publishBlocked;
        }
        jobResult.exitCode = jobResult.exitCode && jobResult.exitCode !== 0 ? jobResult.exitCode : 1;
        log(
          "stderr",
          commitResult.publishBlocked
            ? `[JobRunner] Publish blocked: ${commitError}`
            : `[JobRunner] Failed to create commit: ${commitError}`,
        );
      }
    }

    // Output result with sentinel
    const resultJson = JSON.stringify(jobResult);
    // eslint-disable-next-line no-console
    console.log(`___RESULT___ ${resultJson}`);

    // Exit with appropriate code
    process.exit(jobResult.exitCode ?? (jobResult.ok ? 0 : 1));
  } finally {
    cleanupJobRepo?.();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[JobRunner] Fatal error: ${err}`);
  process.exit(1);
});
