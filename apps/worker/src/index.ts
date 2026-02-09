#!/usr/bin/env bun
/**
 * PushPals Worker Daemon
 *
 * Usage:
 *   bun run worker --server http://localhost:3001 [--poll 2000] [--repo <path>]
 *
 * Polls the server job queue, claims jobs, executes them, and reports results.
 * Initial job kinds: bun.test, bun.lint
 */

import { randomUUID } from "crypto";

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(): {
  server: string;
  pollMs: number;
  repo: string;
  workerId: string;
  authToken: string | null;
} {
  const args = process.argv.slice(2);
  let server = "http://localhost:3001";
  let pollMs = 2000;
  let repo = process.cwd();
  let workerId = `worker-${randomUUID().substring(0, 8)}`;
  let authToken = process.env.PUSHPALS_AUTH_TOKEN ?? null;

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
    }
  }

  return { server, pollMs, repo, workerId, authToken };
}

// ─── Job execution ──────────────────────────────────────────────────────────

const MAX_OUTPUT = 256 * 1024;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.substring(0, MAX_OUTPUT) + "\n… (truncated)" : s;
}

interface JobResult {
  ok: boolean;
  summary: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

async function executeJob(
  kind: string,
  params: Record<string, unknown>,
  repo: string,
): Promise<JobResult> {
  let cmd: string[];

  switch (kind) {
    case "bun.test": {
      cmd = ["bun", "test"];
      if (params.filter) cmd.push("--filter", params.filter as string);
      break;
    }
    case "bun.lint": {
      cmd = ["bun", "run", "lint"];
      break;
    }
    default:
      return { ok: false, summary: `Unknown job kind: ${kind}` };
  }

  try {
    const proc = Bun.spawn(cmd, {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch (_e) {}
    }, 60_000); // 60s timeout

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    clearTimeout(timer);
    const exitCode = await proc.exited;

    return {
      ok: exitCode === 0,
      summary: exitCode === 0 ? `${kind} passed` : `${kind} failed (exit ${exitCode})`,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      exitCode,
    };
  } catch (err) {
    return { ok: false, summary: `Error executing ${kind}: ${err}` };
  }
}

// ─── Worker loop ────────────────────────────────────────────────────────────

async function workerLoop(opts: ReturnType<typeof parseArgs>): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authToken) headers["Authorization"] = `Bearer ${opts.authToken}`;

  console.log(`[Worker ${opts.workerId}] Polling ${opts.server} every ${opts.pollMs}ms`);

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

          // Execute the job
          const params = typeof job.params === "string" ? JSON.parse(job.params) : job.params;
          const result = await executeJob(job.kind, params, opts.repo);

          if (result.ok) {
            // Report completion
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
            // Report failure
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

          // Also emit events to the session if we have sessionId
          if (job.sessionId) {
            const eventPayload = result.ok
              ? {
                  type: "job_completed",
                  payload: {
                    jobId: job.id,
                    summary: result.summary,
                    artifacts: result.stdout
                      ? [{ kind: "log", text: result.stdout }]
                      : undefined,
                  },
                  from: `worker:${opts.workerId}`,
                }
              : {
                  type: "job_failed",
                  payload: {
                    jobId: job.id,
                    message: result.summary,
                    detail: result.stderr,
                  },
                  from: `worker:${opts.workerId}`,
                };

            await fetch(
              `${opts.server}/sessions/${job.sessionId}/command`,
              {
                method: "POST",
                headers,
                body: JSON.stringify(eventPayload),
              },
            ).catch(() => {}); // Best-effort event emission
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

const opts = parseArgs();
console.log(`[Worker] PushPals Worker Daemon (${opts.workerId})`);
console.log(`[Worker] Server: ${opts.server}`);
console.log(`[Worker] Repo: ${opts.repo}`);

workerLoop(opts).catch((err) => {
  console.error("[Worker] Fatal:", err);
  process.exit(1);
});
