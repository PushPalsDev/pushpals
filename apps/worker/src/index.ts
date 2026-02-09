#!/usr/bin/env bun
/**
 * PushPals Worker Daemon
 *
 * Usage:
 *   bun run worker --server http://localhost:3001 [--poll 2000] [--repo <path>]
 *
 * Polls the server job queue, claims jobs, executes them, and reports results.
 * Streams stdout/stderr as `job_log` events with seq numbers.
 * Job kinds: bun.test, bun.lint, git.status
 */

import type { CommandRequest } from "protocol";
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
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
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
    case "git.status": {
      cmd = ["git", "status", "--porcelain"];
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
      onLog ? streamLines(proc.stdout, "stdout", onLog) : new Response(proc.stdout).text(),
      onLog ? streamLines(proc.stderr, "stderr", onLog) : new Response(proc.stderr).text(),
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

// ─── Streaming utilities ────────────────────────────────────────────────────

/**
 * Read a process stream line-by-line, calling onLine for each.
 * Returns the full concatenated output.
 */
async function streamLines(
  readable: ReadableStream<Uint8Array>,
  streamName: "stdout" | "stderr",
  onLine: (stream: "stdout" | "stderr", line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = readable.getReader();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    buffer += chunk;

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      onLine(streamName, clean);
    }
  }

  // Flush remaining buffer
  if (buffer.length > 0) {
    const clean = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    onLine(streamName, clean);
  }

  return full;
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

          const params = typeof job.params === "string" ? JSON.parse(job.params) : job.params;
          const result = await executeJob(job.kind, params, opts.repo, onLog);

          // 3. Wait for chained log sends to complete
          await logChain;

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

const opts = parseArgs();
console.log(`[Worker] PushPals Worker Daemon (${opts.workerId})`);
console.log(`[Worker] Server: ${opts.server}`);
console.log(`[Worker] Repo: ${opts.repo}`);

workerLoop(opts).catch((err) => {
  console.error("[Worker] Fatal:", err);
  process.exit(1);
});
