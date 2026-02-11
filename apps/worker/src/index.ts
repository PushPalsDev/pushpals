#!/usr/bin/env bun
/**
 * PushPals Worker Daemon
 *
 * Usage:
 *   bun run worker --server http://localhost:3001 [--poll 2000] [--repo <path>] [--docker]
 *
 * Polls the server job queue, claims jobs, executes them, and reports results.
 * Streams stdout/stderr as `job_log` events with seq numbers.
 * 
 * Job execution modes:
 *   - Direct mode (default): Jobs run directly on the host
 *   - Docker mode (--docker): Jobs run in isolated Docker containers
 *
 * Job kinds: bun.test, bun.lint, git.status, file.write, shell.exec, etc.
 */

import type { CommandRequest } from "protocol";
import { randomUUID } from "crypto";
import {
  executeJob,
  shouldCommit,
  createJobCommit,
  streamLines,
  truncate,
  type JobResult,
} from "./execute_job.js";
import { DockerExecutor } from "./docker_executor.js";

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(): {
  server: string;
  pollMs: number;
  repo: string;
  workerId: string;
  authToken: string | null;
  docker: boolean;
  dockerImage: string;
  gitToken: string | null;
  dockerTimeout: number;
} {
  const args = process.argv.slice(2);
  let server = "http://localhost:3001";
  let pollMs = 2000;
  let repo = process.cwd();
  let workerId = `worker-${randomUUID().substring(0, 8)}`;
  let authToken = process.env.PUSHPALS_AUTH_TOKEN ?? null;
  let docker = false;
  let dockerImage = "pushpals-worker-sandbox:latest";
  let gitToken = process.env.PUSHPALS_GIT_TOKEN ?? null;
  let dockerTimeout = 60000;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        server = args[++i];
        break;
      case "--poll":
        pollMs = parseInt(args[++i], 10);
        break;
      case "--repo":
        repo = args[++i];
        break;
      case "--workerId":
        workerId = args[++i];
        break;
      case "--token":
        authToken = args[++i];
        break;
      case "--docker":
        docker = true;
        break;
      case "--docker-image":
        dockerImage = args[++i];
        break;
      case "--git-token":
        gitToken = args[++i];
        break;
      case "--docker-timeout":
        dockerTimeout = parseInt(args[++i], 10);
        break;
    }
  }

  return { server, pollMs, repo, workerId, authToken, docker, dockerImage, gitToken, dockerTimeout };
}

// ─── Job execution wrapper ──────────────────────────────────────────────────

async function runJob(
  job: { id: string; taskId: string; kind: string; params: Record<string, unknown>; sessionId: string },
  repo: string,
  dockerExecutor: DockerExecutor | null,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<JobResult> {
  if (dockerExecutor) {
    const result = await dockerExecutor.execute(job, onLog);
    return {
      ok: result.ok,
      summary: result.summary,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
  return executeJob(job.kind, job.params, repo, onLog);
}

// ─── Command helper ─────────────────────────────────────────────────────────

function sendCommand(
  server: string,
  sessionId: string,
  headers: Record<string, string>,
  cmd: CommandRequest,
): Promise<void> {
  return fetch(`${server}/sessions/${sessionId}/command`, {
    method: "POST",
    headers,
    body: JSON.stringify(cmd),
  })
    .then((res) => {
      if (!res.ok) console.error(`[Worker] Command ${cmd.type} failed: ${res.status}`);
    })
    .catch((err) => console.error(`[Worker] Command ${cmd.type} error:`, err));
}

// ─── Worker loop ────────────────────────────────────────────────────────────

async function workerLoop(
  opts: ReturnType<typeof parseArgs>,
  dockerExecutor: DockerExecutor | null,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authToken) headers["Authorization"] = `Bearer ${opts.authToken}`;

  console.log(`[Worker ${opts.workerId}] Polling ${opts.server} every ${opts.pollMs}ms`);
  if (dockerExecutor) {
    console.log(`[Worker ${opts.workerId}] Docker mode enabled (${opts.dockerImage})`);
  }

  while (true) {
    try {
      // Try to claim a job
      const claimRes = await fetch(`${opts.server}/jobs/claim`, {
        method: "POST",
        headers,
        body: JSON.stringify({ workerId: opts.workerId }),
      });

      if (claimRes.ok) {
        const data = (await claimRes.json()) as any;
        const job = data.job;

        if (job) {
          console.log(`[Worker] Claimed job ${job.id} (${job.kind})`);

          // 1. Emit job_claimed event
          if (job.sessionId) {
            await sendCommand(opts.server, job.sessionId, headers, {
              type: "job_claimed",
              payload: { jobId: job.id, workerId: opts.workerId },
              from: `worker:${opts.workerId}`,
            });
          }

          // 2. Execute with streaming logs
          let stdoutSeq = 0;
          let stderrSeq = 0;
          let logChain: Promise<void> = Promise.resolve();

          const onLog = job.sessionId
            ? (stream: "stdout" | "stderr", line: string) => {
                const seq = stream === "stdout" ? ++stdoutSeq : ++stderrSeq;
                logChain = logChain.then(() =>
                  sendCommand(opts.server, job.sessionId, headers, {
                    type: "job_log",
                    payload: { jobId: job.id, stream, seq, line },
                    from: `worker:${opts.workerId}`,
                  }),
                );
              }
            : undefined;

          const jobData = {
            id: job.id,
            taskId: job.taskId,
            kind: job.kind,
            params: typeof job.params === "string" ? JSON.parse(job.params) : job.params,
            sessionId: job.sessionId,
          };
          const result = await runJob(jobData, opts.repo, dockerExecutor, onLog);

          // 3. Wait for chained log sends to complete
          await logChain;

          // 3.5. Create git commit for file-modifying jobs (only in direct mode)
          if (result.ok && shouldCommit(job.kind) && !dockerExecutor) {
            console.log(`[Worker] Job ${job.id} modified files, creating commit...`);
            const commitResult = await createJobCommit(opts.repo, opts.workerId, {
              id: job.id,
              taskId: job.taskId,
              kind: job.kind,
            });

            if (commitResult.ok && commitResult.sha && commitResult.sha !== "no-changes") {
              // Enqueue to Completion Queue
              try {
                const response = await fetch(`${opts.server}/completions/enqueue`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    jobId: job.id,
                    sessionId: job.sessionId,
                    commitSha: commitResult.sha,
                    branch: commitResult.branch,
                    message: `${job.kind}: ${job.taskId}`,
                  }),
                });

                if (response.ok) {
                  console.log(
                    `[Worker] Enqueued completion for job ${job.id} (commit ${commitResult.sha})`,
                  );
                } else {
                  console.error(
                    `[Worker] Failed to enqueue completion: ${response.status} ${await response.text()}`,
                  );
                }
              } catch (err) {
                console.error(`[Worker] Failed to enqueue completion:`, err);
              }
            } else if (commitResult.error) {
              console.error(`[Worker] Failed to create commit: ${commitResult.error}`);
            }
          }

          // 4. Report job result to queue
          if (result.ok) {
            await fetch(`${opts.server}/jobs/${job.id}/complete`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                summary: result.summary,
                artifacts: [
                  ...(result.stdout ? [{ kind: "stdout", text: result.stdout }] : []),
                  ...(result.stderr ? [{ kind: "stderr", text: result.stderr }] : []),
                ],
              }),
            });
            console.log(`[Worker] Job ${job.id} completed: ${result.summary}`);
          } else {
            await fetch(`${opts.server}/jobs/${job.id}/fail`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                message: result.summary,
                detail: result.stderr,
              }),
            });
            console.log(`[Worker] Job ${job.id} failed: ${result.summary}`);
          }

          // 5. Emit job_completed / job_failed event to session
          if (job.sessionId) {
            const eventCmd = result.ok
              ? {
                  type: "job_completed" as const,
                  payload: {
                    jobId: job.id,
                    summary: result.summary,
                    artifacts: result.stdout
                      ? [{ kind: "log" as const, text: result.stdout }]
                      : undefined,
                  },
                  from: `worker:${opts.workerId}`,
                }
              : {
                  type: "job_failed" as const,
                  payload: {
                    jobId: job.id,
                    message: result.summary,
                    detail: result.stderr,
                  },
                  from: `worker:${opts.workerId}`,
                };

            await sendCommand(opts.server, job.sessionId, headers, eventCmd);
          }
        }
      }
    } catch (err) {
      console.error(`[Worker] Poll error:`, err);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log(`[Worker] PushPals Worker Daemon (${opts.workerId})`);
  console.log(`[Worker] Server: ${opts.server}`);
  console.log(`[Worker] Repo: ${opts.repo}`);

  let dockerExecutor: DockerExecutor | null = null;

  if (opts.docker) {
    // Check if Docker is available
    const dockerAvailable = await DockerExecutor.isDockerAvailable();
    if (!dockerAvailable) {
      console.error("[Worker] Docker is not available. Make sure Docker is installed and running.");
      console.error("[Worker] Falling back to direct mode...");
    } else {
      dockerExecutor = new DockerExecutor({
        imageName: opts.dockerImage,
        repo: opts.repo,
        workerId: opts.workerId,
        gitToken: opts.gitToken ?? undefined,
        timeoutMs: opts.dockerTimeout,
      });

      // Clean up orphaned worktrees from previous runs
      await dockerExecutor.cleanupOrphanedWorktrees();

      // Pull the image
      const pulled = await dockerExecutor.pullImage();
      if (!pulled) {
        console.error(`[Worker] Failed to pull Docker image: ${opts.dockerImage}`);
        console.error("[Worker] Falling back to direct mode...");
        dockerExecutor = null;
      }
    }
  }

  workerLoop(opts, dockerExecutor).catch((err) => {
    console.error("[Worker] Fatal:", err);
    process.exit(1);
  });
}

main();
