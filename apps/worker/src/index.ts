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
 *   - Direct mode (default): jobs run on host in isolated git worktrees
 *   - Docker mode (--docker): jobs run in isolated Docker containers
 */

import type { CommandRequest } from "protocol";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { detectRepoRoot } from "shared";
import { executeJob, shouldCommit, createJobCommit, git, type JobResult } from "./execute_job.js";
import { DockerExecutor } from "./docker_executor.js";

type CommitRef = {
  branch: string;
  sha: string;
};

type WorkerJobResult = JobResult & {
  commit?: CommitRef;
};

function parseArgs(): {
  server: string;
  pollMs: number;
  repo: string;
  workerId: string;
  authToken: string | null;
  docker: boolean;
  requireDocker: boolean;
  dockerImage: string;
  gitToken: string | null;
  dockerTimeout: number;
} {
  const truthy = new Set(["1", "true", "yes", "on"]);
  const args = process.argv.slice(2);
  let server = "http://localhost:3001";
  let pollMs = parseInt(process.env.WORKER_POLL_MS ?? "2000", 10);
  let repo = detectRepoRoot(process.cwd());
  let workerId = `worker-${randomUUID().substring(0, 8)}`;
  let authToken = process.env.PUSHPALS_AUTH_TOKEN ?? null;
  let docker = false;
  let requireDocker = truthy.has((process.env.WORKER_REQUIRE_DOCKER ?? "").toLowerCase());
  let dockerImage = process.env.WORKER_DOCKER_IMAGE ?? "pushpals-worker-sandbox:latest";
  let gitToken = process.env.PUSHPALS_GIT_TOKEN ?? null;
  let dockerTimeout = parseInt(process.env.WORKER_DOCKER_TIMEOUT_MS ?? "60000", 10);

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        server = args[++i];
        break;
      case "--poll":
        pollMs = parseInt(args[++i], 10);
        break;
      case "--repo":
        repo = detectRepoRoot(args[++i]);
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
      case "--require-docker":
        requireDocker = true;
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

  return {
    server,
    pollMs,
    repo,
    workerId,
    authToken,
    docker,
    requireDocker,
    dockerImage,
    gitToken,
    dockerTimeout,
  };
}

async function runJob(
  job: {
    id: string;
    taskId: string;
    kind: string;
    params: Record<string, unknown>;
    sessionId: string;
  },
  repo: string,
  dockerExecutor: DockerExecutor | null,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<WorkerJobResult> {
  if (dockerExecutor) {
    const result = await dockerExecutor.execute(job, onLog);
    return {
      ok: result.ok,
      summary: result.summary,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      commit: result.commit,
    };
  }
  return executeJob(job.kind, job.params, repo, onLog);
}

async function createIsolatedWorktree(repo: string, jobId: string): Promise<string> {
  const worktreeRoot = resolve(repo, ".worktrees");
  mkdirSync(worktreeRoot, { recursive: true });

  const worktreePath = resolve(
    worktreeRoot,
    `host-job-${jobId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const addResult = await git(repo, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
  if (!addResult.ok) {
    throw new Error(`Failed to create isolated worktree: ${addResult.stderr}`);
  }

  return worktreePath;
}

async function removeIsolatedWorktree(repo: string, worktreePath: string): Promise<void> {
  const removeResult = await git(repo, ["worktree", "remove", "--force", worktreePath]);
  if (!removeResult.ok) {
    console.error(
      `[Worker] Worktree cleanup warning (${worktreePath}): ${removeResult.stderr || removeResult.stdout}`,
    );
  }
  await git(repo, ["worktree", "prune"]);
}

async function enqueueCompletion(
  server: string,
  headers: Record<string, string>,
  job: { id: string; taskId: string; kind: string; sessionId: string },
  commit: CommitRef,
): Promise<void> {
  try {
    const response = await fetch(`${server}/completions/enqueue`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jobId: job.id,
        sessionId: job.sessionId,
        commitSha: commit.sha,
        branch: commit.branch,
        message: `${job.kind}: ${job.taskId}`,
      }),
    });

    if (response.ok) {
      console.log(`[Worker] Enqueued completion for job ${job.id} (commit ${commit.sha})`);
    } else {
      console.error(
        `[Worker] Failed to enqueue completion: ${response.status} ${await response.text()}`,
      );
    }
  } catch (err) {
    console.error(`[Worker] Failed to enqueue completion:`, err);
  }
}

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

async function workerLoop(
  opts: ReturnType<typeof parseArgs>,
  dockerExecutor: DockerExecutor | null,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authToken) headers["Authorization"] = `Bearer ${opts.authToken}`;

  console.log(`[Worker ${opts.workerId}] Polling ${opts.server} every ${opts.pollMs}ms`);
  if (dockerExecutor) {
    console.log(`[Worker ${opts.workerId}] Docker mode enabled (${opts.dockerImage})`);
  } else {
    console.log(`[Worker ${opts.workerId}] Direct mode with isolated worktrees enabled`);
  }
  console.log(
    `[Worker ${opts.workerId}] Executor backend: ${(process.env.WORKER_EXECUTOR ?? "openhands").toLowerCase()}`,
  );

  while (true) {
    try {
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

          if (job.sessionId) {
            await sendCommand(opts.server, job.sessionId, headers, {
              type: "job_claimed",
              payload: { jobId: job.id, workerId: opts.workerId },
              from: `worker:${opts.workerId}`,
            });
          }

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

          let directWorktreePath: string | null = null;
          let executionRepo = opts.repo;

          try {
            if (!dockerExecutor) {
              directWorktreePath = await createIsolatedWorktree(opts.repo, job.id);
              executionRepo = directWorktreePath;
            }

            const parsedParams =
              typeof job.params === "string"
                ? (JSON.parse(job.params) as Record<string, unknown>)
                : job.params;

            const jobData = {
              id: job.id,
              taskId: job.taskId,
              kind: job.kind,
              params: parsedParams,
              sessionId: job.sessionId,
            };

            let result: WorkerJobResult;
            try {
              result = await runJob(jobData, executionRepo, dockerExecutor, onLog);
            } catch (err) {
              result = {
                ok: false,
                summary: "Job execution failed before completion",
                stderr: String(err),
              };
            }

            await logChain;

            let completionCommit: CommitRef | null = null;
            if (result.ok && shouldCommit(job.kind)) {
              if (result.commit) {
                completionCommit = result.commit;
              } else if (dockerExecutor) {
                result = {
                  ok: false,
                  summary: `Docker job ${job.id} completed without commit metadata for ${job.kind}`,
                  stderr: [
                    result.stderr,
                    "Refusing unsafe host-side commit fallback while Docker mode is active.",
                  ]
                    .filter(Boolean)
                    .join("\n"),
                };
              } else {
                console.log(`[Worker] Job ${job.id} modified files, creating commit...`);
                const commitResult = await createJobCommit(executionRepo, opts.workerId, {
                  id: job.id,
                  taskId: job.taskId,
                  kind: job.kind,
                });

                if (commitResult.ok && commitResult.sha && commitResult.branch) {
                  if (commitResult.sha !== "no-changes") {
                    completionCommit = {
                      branch: commitResult.branch,
                      sha: commitResult.sha,
                    };
                  }
                } else if (commitResult.error) {
                  console.error(`[Worker] Failed to create commit: ${commitResult.error}`);
                }
              }
            }

            if (completionCommit) {
              await enqueueCompletion(opts.server, headers, job, completionCommit);
            }

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
          } finally {
            if (directWorktreePath) {
              await removeIsolatedWorktree(opts.repo, directWorktreePath).catch((err) => {
                console.error(`[Worker] Failed to remove isolated worktree: ${String(err)}`);
              });
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Worker] Poll error:`, err);
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, opts.pollMs));
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log(`[Worker] PushPals Worker Daemon (${opts.workerId})`);
  console.log(`[Worker] Server: ${opts.server}`);
  console.log(`[Worker] Repo: ${opts.repo}`);

  let dockerExecutor: DockerExecutor | null = null;

  if (opts.docker) {
    const dockerAvailable = await DockerExecutor.isDockerAvailable();
    if (!dockerAvailable) {
      const message =
        "[Worker] Docker is not available. Make sure Docker is installed and running.";
      if (opts.requireDocker) {
        console.error(message);
        console.error("[Worker] Exiting because --require-docker is enabled.");
        process.exit(1);
      }
      console.error(message);
      console.error("[Worker] Falling back to direct mode (isolated worktrees)...");
    } else {
      dockerExecutor = new DockerExecutor({
        imageName: opts.dockerImage,
        repo: opts.repo,
        workerId: opts.workerId,
        gitToken: opts.gitToken ?? undefined,
        timeoutMs: opts.dockerTimeout,
      });

      await dockerExecutor.cleanupOrphanedWorktrees();

      const imageReady = await dockerExecutor.pullImage();
      if (!imageReady) {
        console.error(`[Worker] Failed to prepare Docker image: ${opts.dockerImage}`);
        if (opts.requireDocker) {
          console.error("[Worker] Exiting because --require-docker is enabled.");
          process.exit(1);
        }
        console.error("[Worker] Falling back to direct mode (isolated worktrees)...");
        dockerExecutor = null;
      }
    }
  } else if (opts.requireDocker) {
    console.error("[Worker] --require-docker was provided without --docker.");
    process.exit(1);
  }

  workerLoop(opts, dockerExecutor).catch((err) => {
    console.error("[Worker] Fatal:", err);
    process.exit(1);
  });
}

main();
