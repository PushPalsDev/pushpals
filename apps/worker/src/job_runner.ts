#!/usr/bin/env bun
/**
 * Docker Job Runner - Standalone job execution daemon inside Docker
 *
 * This script runs inside a Docker container and executes a single job.
 * It's designed to be the entrypoint for sandboxed job execution.
 *
 * Usage (inside container):
 *   bun run job_runner.ts <base64-encoded-job-spec>
 *
 * The job spec is base64-encoded JSON: { jobId, taskId, kind, params, workerId }
 *
 * Output:
 *   stderr → JSON log lines: {"stream":"stdout|stderr","line":"..."}
 *   stdout → Result with sentinel: ___RESULT___ {"ok":true,...,"commit":{...}}
 */

import { executeJob, shouldCommit, createJobCommit } from "./execute_job.js";

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
}

// ─── Logging helpers ────────────────────────────────────────────────────────

function log(stream: "stdout" | "stderr", line: string): void {
  const json = JSON.stringify({ stream, line });
  // eslint-disable-next-line no-console
  console.error(json);
}

// ─── Git credentials setup ──────────────────────────────────────────────────

function setupGitCredentials(): void {
  const token = process.env.GIT_TOKEN;
  if (!token) return;

  try {
    // Get the origin URL and rewrite it with the token
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // We need to do this synchronously-ish for setup
    // For now, we'll set up a credential helper
    const helperScript = `#!/bin/sh
echo "username=oauth2"
echo "password=${token}"
`;

    // Write credential helper
    const fs = require("fs");
    const path = require("path");
    const helperPath = "/tmp/git-credential-helper";
    fs.writeFileSync(helperPath, helperScript, { mode: 0o755 });

    // Configure git to use it
    Bun.spawnSync(["git", "config", "--global", "credential.helper", helperPath]);

    // Also set up the URL to use HTTPS with token
    Bun.spawnSync([
      "git",
      "config",
      "--global",
      "url." + `https://oauth2:${token}@github.com/`.replace(/:/g, "%3A") + ".insteadOf",
      "https://github.com/",
    ]);
  } catch (err) {
    log("stderr", `Failed to setup git credentials: ${err}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const base64Spec = args[0];

  if (!base64Spec) {
    // eslint-disable-next-line no-console
    console.error("Usage: bun run job_runner.ts <base64-encoded-job-spec>");
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

  // Execute the job
  const result = await executeJob(spec.kind, spec.params, "/workspace", (stream, line) => {
    log(stream, line);
  });

  // Build result object
  const jobResult: JobResult = {
    ok: result.ok,
    summary: result.summary,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };

  // Create commit for file-modifying jobs
  if (result.ok && shouldCommit(spec.kind)) {
    log("stdout", `[JobRunner] Job modified files, creating commit...`);
    const commitResult = await createJobCommit("/workspace", spec.workerId, {
      id: spec.jobId,
      taskId: spec.taskId,
      kind: spec.kind,
      params: spec.params,
      context: "docker",
    });

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
      jobResult.summary = `Failed to create commit for ${spec.kind}`;
      jobResult.stderr = [jobResult.stderr, commitError].filter(Boolean).join("\n");
      jobResult.exitCode = jobResult.exitCode && jobResult.exitCode !== 0 ? jobResult.exitCode : 1;
      log("stderr", `[JobRunner] Failed to create commit: ${commitError}`);
    }
  }

  // Output result with sentinel
  const resultJson = JSON.stringify(jobResult);
  // eslint-disable-next-line no-console
  console.log(`___RESULT___ ${resultJson}`);

  // Exit with appropriate code
  process.exit(jobResult.exitCode ?? (jobResult.ok ? 0 : 1));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[JobRunner] Fatal error: ${err}`);
  process.exit(1);
});
