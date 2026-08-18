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
import type { JobDiagnostics, JobTokenUsage } from "./common/types.js";
import { isHostScmOwnedReviewParams } from "./merge_conflict_job.js";

const CONFIG = loadPushPalsConfig();
const GIT_CONFIG_TIMEOUT_MS = 10_000;

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
  cooldownMs?: number;
  usage?: JobTokenUsage;
  commit?: {
    branch: string;
    sha: string;
    publicBranch?: string;
  };
  publishBlocked?: {
    summary: string;
    detail: string;
    publicBranch: string;
    localRef: string;
    sha: string;
    stage: "sync" | "push" | "validation";
  };
  validationBlocked?: {
    category: "environment";
    summary: string;
    detail: string;
    commands: string[];
  };
  diagnostics?: JobDiagnostics;
}

export function buildFatalJobResult(error: unknown): JobResult {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const missingRuntimeAsset =
    /(?:ENOENT|no such file or directory)/i.test(detail) &&
    /(?:\/workspace\/prompts|[\\/]prompts[\\/]|\[prompts\])/i.test(detail);
  return {
    ok: false,
    summary: missingRuntimeAsset
      ? "WorkerPal could not load a required runtime prompt asset"
      : "WorkerPal encountered an unexpected runtime failure",
    stderr: detail,
    exitCode: 1,
    diagnostics: {
      terminal: {
        failureClass: missingRuntimeAsset ? "missing_runtime_asset" : "worker_runtime_failure",
        terminalStage: "worker_runtime",
        summary: detail,
        watchdogFired: false,
      },
    },
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
        timeout: GIT_CONFIG_TIMEOUT_MS,
        killSignal: "SIGKILL",
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
          timeout: GIT_CONFIG_TIMEOUT_MS,
          killSignal: "SIGKILL",
        });
      }
    }

    Bun.spawnSync(["git", "config", "--global", "credential.helper", helperPath], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: GIT_CONFIG_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    log("stderr", `Failed to setup git credentials: ${err}`);
  }
}

export function buildJobRunnerResult(
  result: Pick<
    Awaited<ReturnType<typeof executeJob>>,
    | "ok"
    | "summary"
    | "stdout"
    | "stderr"
    | "exitCode"
    | "cooldownMs"
    | "usage"
    | "diagnostics"
    | "validationBlocked"
  >,
): JobResult {
  return {
    ok: result.ok,
    summary: result.summary,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    cooldownMs: result.cooldownMs,
    usage: result.usage,
    diagnostics: result.diagnostics,
    validationBlocked: result.validationBlocked,
  };
}

export function containerOwnsGitFinalization(params: Record<string, unknown>): boolean {
  return !isHostScmOwnedReviewParams(params);
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

  const base64Spec = rawSpecArg === "--spec-stdin" ? (await Bun.stdin.text()).trim() : rawSpecArg;
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
  const hostScmOwnsGit = !containerOwnsGitFinalization(spec.params);
  // Review/repair containers never receive push credentials. Their host-side
  // source-control orchestrator owns rebase continuation and finalization.
  if (!hostScmOwnsGit) setupGitCredentials();
  // Execute inside the mounted job worktree (docker -w), not the baked image copy.
  const jobRepo = process.cwd();
  const effectiveParams = spec.params;
  try {
    if (hostScmOwnsGit) {
      log(
        "stdout",
        `[JobRunner] Host-side SCM owns Git finalization for review job ${spec.jobId}; container is edit/validate-only.`,
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
    const jobResult = buildJobRunnerResult(result);
    // Create commit for file-modifying jobs
    if (result.ok && shouldCommit(spec.kind, CONFIG) && !hostScmOwnsGit) {
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
          deferPublication: Boolean(result.validationBlocked),
        },
        CONFIG,
      );

      if (commitResult.ok && commitResult.sha && commitResult.branch) {
        jobResult.commit = {
          branch: commitResult.branch!,
          sha: commitResult.sha,
          publicBranch: commitResult.publicBranch,
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
        jobResult.exitCode =
          jobResult.exitCode && jobResult.exitCode !== 0 ? jobResult.exitCode : 1;
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
    // Host-owned review worktrees are finalized and removed by DockerExecutor.
  }
}

if (import.meta.main) {
  main().catch((err) => {
    const result = buildFatalJobResult(err);
    // eslint-disable-next-line no-console
    console.error(`[JobRunner] Fatal error: ${err}`);
    // Preserve a structured terminal result even for unexpected runtime faults
    // so the host does not have to infer timeout state from arbitrary job logs.
    // eslint-disable-next-line no-console
    console.log(`___RESULT___ ${JSON.stringify(result)}`);
    process.exit(1);
  });
}
