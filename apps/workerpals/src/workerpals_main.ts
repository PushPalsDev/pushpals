#!/usr/bin/env bun
/**
 * PushPals WorkerPals Daemon
 *
 * Usage:
 *   bun run workerpals --server http://localhost:3001 [--poll 2000] [--repo <path>] [--docker]
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
import { detectRepoRoot, loadPromptTemplate } from "shared";
import { executeJob, shouldCommit, createJobCommit, git, type JobResult } from "./execute_job.js";
import { DockerExecutionExhaustedError, DockerExecutor } from "./docker_executor.js";
import { DEFAULT_DOCKER_TIMEOUT_MS, parseDockerTimeoutMs } from "./timeout_policy.js";

type CommitRef = {
  branch: string;
  sha: string;
};

type CompletionPrMetadata = {
  title: string;
  body: string;
};

type WorkerJobResult = JobResult & {
  commit?: CommitRef;
  cooldownMs?: number;
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const DEFAULT_OPENHANDS_MODEL = "local-model";

function envTruthy(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? "").toLowerCase());
}

function workerOpenHandsLlmConfig(): { model: string; provider: string; baseUrl: string } {
  const normalizeProvider = (raw: string): string => {
    const value = raw.trim().toLowerCase();
    if (!value) return "auto";
    if (value === "lmstudio") return "openai";
    if (value === "openai_compatible") return "openai";
    if (value === "ollama_chat") return "ollama";
    return value;
  };

  const model = (
    process.env.WORKERPALS_LLM_MODEL ?? DEFAULT_OPENHANDS_MODEL
  )
    .trim()
    .replace(/\s+/g, " ");
  const provider = normalizeProvider(
    process.env.WORKERPALS_LLM_BACKEND ?? "auto",
  );
  const baseUrl = (
    process.env.WORKERPALS_LLM_ENDPOINT ?? ""
  ).trim();

  return {
    model: model || DEFAULT_OPENHANDS_MODEL,
    provider: provider || "auto",
    baseUrl,
  };
}

function integrationBranchName(): string {
  const configured = (process.env.PUSHPALS_INTEGRATION_BRANCH ?? "").trim();
  return configured || "main_agents";
}

function formatDurationMs(durationMs: number): string {
  const ms = Math.max(0, Math.floor(durationMs));
  if (ms < 1_000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${totalSeconds}s`;
  return `${minutes}m ${seconds}s`;
}

function sanitizeJobLogLine(line: string): string {
  // Strip ANSI escape/control sequences and collapse whitespace.
  return line
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoisyProgressLine(line: string): boolean {
  return /^(📦 Installing \[\d+\/\d+\]|🔍 Resolving\.\.\.|🔒 Saving lockfile\.\.\.)$/.test(line);
}

function parseArgs(): {
  server: string;
  pollMs: number;
  heartbeatMs: number;
  repo: string;
  workerId: string;
  authToken: string | null;
  docker: boolean;
  requireDocker: boolean;
  dockerImage: string;
  gitToken: string | null;
  dockerTimeout: number;
  dockerIdleTimeout: number;
  dockerNetworkMode: string;
  worktreeBaseRef: string;
  labels: string[];
  failureCooldownMs: number;
} {
  const args = process.argv.slice(2);
  let server = "http://localhost:3001";
  let pollMs = parseInt(process.env.WORKERPALS_POLL_MS ?? "2000", 10);
  let heartbeatMs = parseInt(process.env.WORKERPALS_HEARTBEAT_MS ?? "5000", 10);
  let repo = detectRepoRoot(process.cwd());
  let workerId = `workerpal-${randomUUID().substring(0, 8)}`;
  let authToken = process.env.PUSHPALS_AUTH_TOKEN ?? null;
  let docker = false;
  let requireDocker = envTruthy("WORKERPALS_REQUIRE_DOCKER");
  let dockerImage = process.env.WORKERPALS_DOCKER_IMAGE ?? "pushpals-worker-sandbox:latest";
  let gitToken =
    process.env.PUSHPALS_GIT_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
  let dockerTimeout = parseDockerTimeoutMs(process.env.WORKERPALS_DOCKER_TIMEOUT_MS);
  let dockerIdleTimeout = parseInt(process.env.WORKERPALS_DOCKER_IDLE_TIMEOUT_MS ?? "600000", 10);
  let dockerNetworkMode = (process.env.WORKERPALS_DOCKER_NETWORK_MODE ?? "bridge").trim() || "bridge";
  let worktreeBaseRef = process.env.WORKERPALS_BASE_REF ?? `origin/${integrationBranchName()}`;
  let labels = (process.env.WORKERPALS_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  let failureCooldownMs = parseInt(
    process.env.WORKERPALS_FAILURE_COOLDOWN_MS ??
      process.env.WORKERPALS_DOCKER_FAILURE_COOLDOWN_MS ??
      "20000",
    10,
  );

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        server = args[++i];
        break;
      case "--poll":
        pollMs = parseInt(args[++i], 10);
        break;
      case "--heartbeat":
        heartbeatMs = parseInt(args[++i], 10);
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
        dockerTimeout = parseDockerTimeoutMs(args[++i]);
        break;
      case "--docker-idle-timeout":
        dockerIdleTimeout = parseInt(args[++i], 10);
        break;
      case "--docker-network":
        dockerNetworkMode = (args[++i] ?? "").trim() || dockerNetworkMode;
        break;
      case "--base-ref":
        worktreeBaseRef = args[++i];
        break;
      case "--labels":
        labels = args[++i]
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean);
        break;
      case "--failure-cooldown-ms":
        failureCooldownMs = parseInt(args[++i], 10);
        break;
    }
  }

  return {
    server,
    pollMs,
    heartbeatMs: Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : pollMs,
    repo,
    workerId,
    authToken,
    docker,
    requireDocker,
    dockerImage,
    gitToken,
    dockerTimeout: Number.isFinite(dockerTimeout) && dockerTimeout > 0 ? dockerTimeout : DEFAULT_DOCKER_TIMEOUT_MS,
    dockerIdleTimeout:
      Number.isFinite(dockerIdleTimeout) && dockerIdleTimeout >= 0 ? dockerIdleTimeout : 600000,
    dockerNetworkMode,
    worktreeBaseRef,
    labels,
    failureCooldownMs:
      Number.isFinite(failureCooldownMs) && failureCooldownMs >= 0
        ? Math.min(failureCooldownMs, 300_000)
        : 20_000,
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

async function resolveWorktreeBaseRef(repo: string, requestedRef: string): Promise<string> {
  const integrationBranch = integrationBranchName();
  const integrationRemoteRef = `origin/${integrationBranch}`;
  const candidates = new Set<string>([
    requestedRef,
    integrationRemoteRef,
    integrationBranch,
    "HEAD",
  ]);
  if (requestedRef.startsWith("origin/")) {
    const branch = requestedRef.slice("origin/".length);
    const fetchResult = await git(repo, ["fetch", "origin", branch, "--quiet"]);
    if (!fetchResult.ok) {
      console.warn(
        `[WorkerPals] Could not refresh ${requestedRef}; continuing with local refs (${fetchResult.stderr || fetchResult.stdout})`,
      );
    }
    candidates.add(branch);
  } else if (requestedRef !== "HEAD") {
    candidates.add(`origin/${requestedRef}`);
  }

  for (const ref of candidates) {
    const parsed = await git(repo, ["rev-parse", "--verify", "--quiet", ref]);
    if (parsed.ok) return ref;
  }

  return "HEAD";
}

async function createIsolatedWorktree(
  repo: string,
  jobId: string,
  baseRef: string,
): Promise<string> {
  const worktreeRoot = resolve(repo, ".worktrees");
  mkdirSync(worktreeRoot, { recursive: true });

  const worktreePath = resolve(
    worktreeRoot,
    `host-job-${jobId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const addResult = await git(repo, ["worktree", "add", "--detach", worktreePath, baseRef]);
  if (!addResult.ok) {
    throw new Error(`Failed to create isolated worktree: ${addResult.stderr}`);
  }

  return worktreePath;
}

async function removeIsolatedWorktree(repo: string, worktreePath: string): Promise<void> {
  const removeResult = await git(repo, ["worktree", "remove", "--force", worktreePath]);
  if (!removeResult.ok) {
    console.error(
      `[WorkerPals] Worktree cleanup warning (${worktreePath}): ${removeResult.stderr || removeResult.stdout}`,
    );
  }
  await git(repo, ["worktree", "prune"]);
}

function sanitizePrText(value: unknown, max = 240): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function inferPrArea(kind: string): string {
  if (kind.startsWith("task.")) return "repo";
  if (kind.startsWith("file.")) return "repo";
  if (kind.startsWith("bun.test") || kind.startsWith("test.")) return "tests";
  if (kind.startsWith("bun.lint")) return "repo";
  if (kind.startsWith("git.")) return "repo";
  return "infra";
}

function inferChangedPaths(params: Record<string, unknown> | undefined): string[] {
  if (!params) return [];
  const candidates: string[] = [];

  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    candidates.push(trimmed);
  };

  add(params.path);
  add(params.targetPath);
  add(params.from);
  add(params.to);

  if (Array.isArray(params.paths)) {
    for (const value of params.paths) add(value);
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of candidates) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    deduped.push(entry);
    if (deduped.length >= 8) break;
  }
  return deduped;
}

function toBulletList(lines: string[]): string {
  if (lines.length === 0) return "- None";
  return lines.map((line) => (line.startsWith("- ") ? line : `- ${line}`)).join("\n");
}

function buildCompletionPrMetadataFallback(args: {
  workerId: string;
  integrationBranch: string;
  job: { id: string; taskId: string; kind: string; params?: Record<string, unknown> };
  commit: CommitRef;
  resultSummary: string;
  title: string;
  changedPaths: string[];
  risk: "low" | "medium";
}): CompletionPrMetadata {
  const changesSection =
    args.changedPaths.length > 0
      ? args.changedPaths.map((path) => `- Updated \`${sanitizePrText(path, 180)}\``)
      : [`- Updated worker completion for \`${sanitizePrText(args.job.kind, 80)}\``];

  const body = [
    "### Summary",
    `- Apply WorkerPal completion \`${sanitizePrText(args.job.id, 64)}\` to \`${sanitizePrText(args.integrationBranch, 64)}\`.`,
    `- Integrate commit \`${sanitizePrText(args.commit.sha, 64)}\` from \`${sanitizePrText(args.commit.branch, 120)}\`.`,
    `- Worker: \`${sanitizePrText(args.workerId, 64)}\`.`,
    "",
    "### Motivation / Context",
    "- Preserve and review autonomous worker output before final merge to base branch.",
    "- Keep integration branch current with queued worker completions.",
    "",
    "### Changes",
    ...changesSection,
    "",
    "### Testing / Validation",
    "- Not run (not provided)",
    "",
    "### Impact / Risk",
    `- Risk level: ${args.risk} (automated worker-generated change; maintainer review required).`,
    "- No secrets or credentials are expected in this PR body.",
    "",
    "### SourceControlManager Note",
    "- Use this worker-provided PR title/body when creating the integration PR.",
    "",
    "### Checklist",
    "- [ ] Tests added/updated where appropriate",
    "- [ ] Validation commands run (or noted as not run)",
    "- [ ] Docs/comments updated if needed",
    "- [ ] No sensitive data (secrets/tokens) committed",
  ].join("\n");
  return { title: args.title, body };
}

function buildCompletionPrMetadata(args: {
  workerId: string;
  integrationBranch: string;
  job: { id: string; taskId: string; kind: string; params?: Record<string, unknown> };
  commit: CommitRef;
  resultSummary: string;
}): CompletionPrMetadata {
  const area = inferPrArea(args.job.kind);
  const summary = sanitizePrText(args.resultSummary, 84) || `${args.job.kind} update`;
  const title = `chore(${area}): ${summary}`;
  const changedPaths = inferChangedPaths(args.job.params);
  const risk =
    args.job.kind.startsWith("task.") || args.job.kind.startsWith("file.") ? "medium" : "low";
  const changesLines =
    changedPaths.length > 0
      ? changedPaths.map((path) => `Updated \`${sanitizePrText(path, 180)}\``)
      : [`Updated worker completion for \`${sanitizePrText(args.job.kind, 80)}\``];
  const motivationLines = [
    "Preserve and review autonomous worker output before final merge to base branch.",
    "Keep integration branch current with queued worker completions.",
  ];
  const testingLines = ["Not run (not provided)"];
  const impactLines = [
    `Risk level: ${risk} (automated worker-generated change; maintainer review required).`,
    "No secrets or credentials are expected in this PR body.",
  ];

  const replacements: Record<string, string> = {
    title,
    area: sanitizePrText(area, 48),
    summary: sanitizePrText(summary, 120),
    completion_id: sanitizePrText(args.job.id, 64),
    task_id: sanitizePrText(args.job.taskId, 64),
    job_kind: sanitizePrText(args.job.kind, 64),
    worker_id: sanitizePrText(args.workerId, 64),
    integration_branch: sanitizePrText(args.integrationBranch, 64),
    commit_sha: sanitizePrText(args.commit.sha, 64),
    commit_branch: sanitizePrText(args.commit.branch, 140),
    result_summary: sanitizePrText(args.resultSummary, 240),
    motivation_lines: toBulletList(motivationLines),
    changes_lines: toBulletList(changesLines),
    testing_lines: toBulletList(testingLines),
    impact_lines: toBulletList(impactLines),
    risk_level: risk,
  };

  const isInstructionalTemplateOutput = (value: string): boolean => {
    const text = value.trim().toLowerCase();
    if (!text) return true;
    if (text.includes("pr description writer")) return true;
    if (text.includes("absolute prohibitions")) return true;
    if (text.includes("required structure")) return true;
    if (text.includes("{{")) return true;
    return false;
  };

  try {
    const body = loadPromptTemplate("workerpals/pr_description.md", replacements).trim();
    if (!isInstructionalTemplateOutput(body)) {
      return { title, body };
    }
    console.warn(
      `[WorkerPals] PR description template appears instructional/unrendered; using deterministic fallback metadata.`,
    );
  } catch (err) {
    console.warn(`[WorkerPals] Failed to load PR description template: ${String(err)}`);
  }

  return buildCompletionPrMetadataFallback({
    ...args,
    title,
    changedPaths,
    risk,
  });
}

async function enqueueCompletion(
  server: string,
  headers: Record<string, string>,
  workerId: string,
  integrationBranch: string,
  job: {
    id: string;
    taskId: string;
    kind: string;
    sessionId: string;
    params?: Record<string, unknown>;
  },
  commit: CommitRef,
  resultSummary: string,
): Promise<boolean> {
  try {
    const pr = buildCompletionPrMetadata({
      workerId,
      integrationBranch,
      job,
      commit,
      resultSummary,
    });

    const response = await fetch(`${server}/completions/enqueue`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jobId: job.id,
        sessionId: job.sessionId,
        commitSha: commit.sha,
        branch: commit.branch,
        message: `${job.kind}: ${job.taskId} (worker PR metadata attached)`,
        prTitle: pr.title,
        prBody: pr.body,
      }),
    });

    if (response.ok) {
      console.log(`[WorkerPals] Enqueued completion for job ${job.id} (commit ${commit.sha})`);
      return true;
    } else {
      console.error(
        `[WorkerPals] Failed to enqueue completion: ${response.status} ${await response.text()}`,
      );
      return false;
    }
  } catch (err) {
    console.error(`[WorkerPals] Failed to enqueue completion:`, err);
    return false;
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
      if (!res.ok) console.error(`[WorkerPals] Command ${cmd.type} failed: ${res.status}`);
    })
    .catch((err) => console.error(`[WorkerPals] Command ${cmd.type} error:`, err));
}

type WorkerHeartbeatStatus = "idle" | "busy" | "error" | "offline";

async function sendWorkerHeartbeat(
  opts: ReturnType<typeof parseArgs>,
  headers: Record<string, string>,
  status: WorkerHeartbeatStatus,
  currentJobId: string | null = null,
): Promise<void> {
  try {
    await fetch(`${opts.server}/workers/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workerId: opts.workerId,
        status,
        currentJobId,
        pollMs: opts.pollMs,
        capabilities: {
          docker: opts.docker,
          labels: opts.labels,
          executor: "openhands",
          requireDocker: opts.requireDocker,
        },
        details: {
          repo: opts.repo,
          baseRef: opts.worktreeBaseRef,
          dockerImage: opts.docker ? opts.dockerImage : null,
          dockerNetworkMode: opts.docker ? opts.dockerNetworkMode : null,
        },
      }),
    });
  } catch (err) {
    console.error(`[WorkerPals] Heartbeat error:`, err);
  }
}

async function workerLoop(
  opts: ReturnType<typeof parseArgs>,
  dockerExecutor: DockerExecutor | null,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authToken) headers["Authorization"] = `Bearer ${opts.authToken}`;

  console.log(`[WorkerPals ${opts.workerId}] Polling ${opts.server} every ${opts.pollMs}ms`);
  if (dockerExecutor) {
    console.log(
      `[WorkerPals ${opts.workerId}] Docker mode enabled (${opts.dockerImage}, network=${opts.dockerNetworkMode})`,
    );
  } else {
    console.log(`[WorkerPals ${opts.workerId}] Direct mode with isolated worktrees enabled`);
  }
  console.log(`[WorkerPals ${opts.workerId}] Executor backend: openhands`);
  const heartbeatEveryMs = Math.max(1000, opts.heartbeatMs);
  let lastHeartbeatAt = 0;

  const maybeHeartbeat = async (
    status: WorkerHeartbeatStatus,
    currentJobId: string | null = null,
    force = false,
  ) => {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < heartbeatEveryMs) return;
    await sendWorkerHeartbeat(opts, headers, status, currentJobId);
    lastHeartbeatAt = now;
  };

  await maybeHeartbeat("idle", null, true);

  while (true) {
    try {
      await maybeHeartbeat("idle");
      const claimRes = await fetch(`${opts.server}/jobs/claim`, {
        method: "POST",
        headers,
        body: JSON.stringify({ workerId: opts.workerId }),
      });

      if (claimRes.ok) {
        const data = (await claimRes.json()) as any;
        const job = data.job;

        if (job) {
          console.log(`[WorkerPals] Claimed job ${job.id} (${job.kind})`);
          await maybeHeartbeat("busy", job.id, true);

          const busyHeartbeat = setInterval(() => {
            void sendWorkerHeartbeat(opts, headers, "busy", job.id);
          }, heartbeatEveryMs);

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
          let lastCleanLog = "";
          let lastCleanLogAt = 0;

          const onLog = job.sessionId
            ? (stream: "stdout" | "stderr", line: string) => {
                const cleaned = sanitizeJobLogLine(line);
                if (!cleaned) return;

                // Drop high-frequency terminal progress redraw spam; keep meaningful lines.
                if (isNoisyProgressLine(cleaned)) return;

                // Collapse very noisy duplicate lines emitted in tight loops.
                const now = Date.now();
                if (cleaned === lastCleanLog && now - lastCleanLogAt < 1_000) return;
                lastCleanLog = cleaned;
                lastCleanLogAt = now;

                const seq = stream === "stdout" ? ++stdoutSeq : ++stderrSeq;
                logChain = logChain.then(() =>
                  Promise.allSettled([
                    sendCommand(opts.server, job.sessionId, headers, {
                      type: "job_log",
                      payload: { jobId: job.id, stream, seq, line: cleaned },
                      from: `worker:${opts.workerId}`,
                    }),
                    fetch(`${opts.server}/jobs/${job.id}/log`, {
                      method: "POST",
                      headers,
                      body: JSON.stringify({ stream, seq, message: cleaned }),
                    }),
                  ]).then(() => undefined),
                );
              }
            : undefined;

          let directWorktreePath: string | null = null;
          let executionRepo = opts.repo;
          let result: WorkerJobResult | null = null;

          try {
            if (!dockerExecutor) {
              directWorktreePath = await createIsolatedWorktree(
                opts.repo,
                job.id,
                opts.worktreeBaseRef,
              );
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

            let cooldownAfterJobMs = 0;
            const jobStartedAtMs = Date.now();
            try {
              result = await runJob(jobData, executionRepo, dockerExecutor, onLog);
              cooldownAfterJobMs =
                Number.isFinite(result.cooldownMs) && (result.cooldownMs ?? 0) > 0
                  ? Math.floor(result.cooldownMs ?? 0)
                  : 0;
            } catch (err) {
              if (err instanceof DockerExecutionExhaustedError) {
                cooldownAfterJobMs = Math.max(
                  opts.failureCooldownMs,
                  Number.isFinite(err.cooldownMs) ? err.cooldownMs : 0,
                );
              }
              result = {
                ok: false,
                summary: "Job execution failed before completion",
                stderr: String(err),
                ...(cooldownAfterJobMs > 0 ? { cooldownMs: cooldownAfterJobMs } : {}),
              };
            }
            if (!result) {
              result = {
                ok: false,
                summary: "Job execution failed before completion",
                stderr: "Worker result was not produced",
              };
            }
            const jobDurationMs = Math.max(0, Date.now() - jobStartedAtMs);

            await logChain;

            let completionCommit: CommitRef | null = null;
            if (result.ok && shouldCommit(job.kind)) {
              if (result.commit) {
                if (result.commit.sha !== "no-changes") {
                  completionCommit = result.commit;
                } else {
                  console.log(`[WorkerPals] Job ${job.id} produced no file changes to commit.`);
                }
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
                console.log(`[WorkerPals] Job ${job.id} modified files, creating commit...`);
                const commitResult = await createJobCommit(executionRepo, opts.workerId, {
                  id: job.id,
                  taskId: job.taskId,
                  kind: job.kind,
                  params: parsedParams,
                  sessionId: job.sessionId,
                  context: "host",
                });

                if (commitResult.ok && commitResult.sha && commitResult.branch) {
                  if (commitResult.sha !== "no-changes") {
                    completionCommit = {
                      branch: commitResult.branch,
                      sha: commitResult.sha,
                    };
                  }
                } else if (commitResult.error) {
                  console.error(`[WorkerPals] Failed to create commit: ${commitResult.error}`);
                }
              }
            }

            if (completionCommit) {
              const enqueued = await enqueueCompletion(
                opts.server,
                headers,
                opts.workerId,
                integrationBranchName(),
                {
                  id: job.id,
                  taskId: job.taskId,
                  kind: job.kind,
                  sessionId: job.sessionId,
                  params: parsedParams,
                },
                completionCommit,
                result.summary,
              );
              if (!enqueued && completionCommit.branch.startsWith("refs/pushpals/")) {
                const cleanupRef = await git(executionRepo, [
                  "update-ref",
                  "-d",
                  completionCommit.branch,
                ]);
                if (!cleanupRef.ok) {
                  console.warn(
                    `[WorkerPals] Failed to clean local completion ref ${completionCommit.branch}: ${
                      cleanupRef.stderr || cleanupRef.stdout
                    }`,
                  );
                }
              }
            }

            if (result.ok) {
              await fetch(`${opts.server}/jobs/${job.id}/complete`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  summary: result.summary,
                  durationMs: jobDurationMs,
                  artifacts: [
                    ...(result.stdout ? [{ kind: "stdout", text: result.stdout }] : []),
                    ...(result.stderr ? [{ kind: "stderr", text: result.stderr }] : []),
                  ],
                }),
              });
              console.log(
                `[WorkerPals] Job ${job.id} completed in ${formatDurationMs(jobDurationMs)}: ${result.summary}`,
              );
            } else {
              await fetch(`${opts.server}/jobs/${job.id}/fail`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  message: result.summary,
                  detail: result.stderr,
                  durationMs: jobDurationMs,
                }),
              });
              console.log(
                `[WorkerPals] Job ${job.id} failed in ${formatDurationMs(jobDurationMs)}: ${result.summary}`,
              );
            }

            if (job.sessionId) {
              const responseMode = String(parsedParams.responseMode ?? "")
                .trim()
                .toLowerCase();
              if (responseMode === "assistant_message") {
                const maxResponseCharsRaw = Number(parsedParams.maxResponseChars ?? 8000);
                const maxResponseChars =
                  Number.isFinite(maxResponseCharsRaw) && maxResponseCharsRaw >= 256
                    ? Math.min(maxResponseCharsRaw, 20_000)
                    : 8000;
                const rawText = result.ok
                  ? String(result.stdout ?? result.summary ?? "").trim()
                  : `Worker failed to complete request: ${String(result.summary ?? "unknown error").trim()}`;
                const assistantText =
                  rawText.length > maxResponseChars
                    ? `${rawText.slice(0, maxResponseChars - 3)}...`
                    : rawText;
                if (assistantText) {
                  await sendCommand(opts.server, job.sessionId, headers, {
                    type: "assistant_message",
                    payload: { text: assistantText },
                    from: `worker:${opts.workerId}`,
                  });
                }
              }

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
            clearInterval(busyHeartbeat);
            if (job.sessionId && result?.cooldownMs && result.cooldownMs > 0) {
              await sendCommand(opts.server, job.sessionId, headers, {
                type: "assistant_message",
                payload: {
                  text: `WorkerPal is cooling down for ${formatDurationMs(result.cooldownMs)} after transient infrastructure failures.`,
                },
                from: `worker:${opts.workerId}`,
              });
            }
            if (result?.cooldownMs && result.cooldownMs > 0) {
              const cooldownMs = Math.max(0, Math.floor(result.cooldownMs));
              console.warn(
                `[WorkerPals] Entering cooldown for ${formatDurationMs(cooldownMs)} after retry exhaustion.`,
              );
              await maybeHeartbeat("offline", job.id, true);
              await new Promise((resolvePromise) => setTimeout(resolvePromise, cooldownMs));
            }
            await maybeHeartbeat("idle", null, true);
            if (directWorktreePath) {
              await removeIsolatedWorktree(opts.repo, directWorktreePath).catch((err) => {
                console.error(`[WorkerPals] Failed to remove isolated worktree: ${String(err)}`);
              });
            }
          }
        }
      }
    } catch (err) {
      console.error(`[WorkerPals] Poll error:`, err);
      await maybeHeartbeat("error", null, true);
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, opts.pollMs));
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const llmConfig = workerOpenHandsLlmConfig();

  console.log(`[WorkerPals] PushPals WorkerPals Daemon (${opts.workerId})`);
  console.log(`[WorkerPals] Server: ${opts.server}`);
  console.log(`[WorkerPals] Repo: ${opts.repo}`);
  console.log(
    `[WorkerPals] OpenHands LLM: model=${llmConfig.model} provider=${llmConfig.provider} baseUrl=${llmConfig.baseUrl || "(unset)"}`,
  );
  opts.worktreeBaseRef = await resolveWorktreeBaseRef(opts.repo, opts.worktreeBaseRef);
  console.log(`[WorkerPals] Worktree base ref: ${opts.worktreeBaseRef}`);

  let dockerExecutor: DockerExecutor | null = null;

  if (opts.docker) {
    const dockerAvailable = await DockerExecutor.isDockerAvailable();
    if (!dockerAvailable) {
      const message =
        "[WorkerPals] Docker is not available. Make sure Docker is installed and running.";
      if (opts.requireDocker) {
        console.error(message);
        console.error("[WorkerPals] Exiting because --require-docker is enabled.");
        process.exit(1);
      }
      console.error(message);
      console.error("[WorkerPals] Falling back to direct mode (isolated worktrees)...");
    } else {
      dockerExecutor = new DockerExecutor({
        imageName: opts.dockerImage,
        repo: opts.repo,
        workerId: opts.workerId,
        gitToken: opts.gitToken ?? undefined,
        timeoutMs: opts.dockerTimeout,
        idleTimeoutMs: opts.dockerIdleTimeout,
        networkMode: opts.dockerNetworkMode,
        baseRef: opts.worktreeBaseRef,
      });

      await dockerExecutor.cleanupOrphanedWorktrees();

      const imageReady = await dockerExecutor.pullImage();
      if (!imageReady) {
        console.error(`[WorkerPals] Failed to prepare Docker image: ${opts.dockerImage}`);
        if (opts.requireDocker) {
          console.error("[WorkerPals] Exiting because --require-docker is enabled.");
          process.exit(1);
        }
        console.error("[WorkerPals] Falling back to direct mode (isolated worktrees)...");
        dockerExecutor = null;
      } else if (!envTruthy("WORKERPALS_SKIP_DOCKER_SELF_CHECK")) {
        console.log(
          "[WorkerPals] Running Docker startup self-check (git/worktree in container)...",
        );
        try {
          await dockerExecutor.validateWorktreeGitInterop();
        } catch (err) {
          console.error(
            `[WorkerPals] Docker startup self-check failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          if (opts.requireDocker) {
            console.error("[WorkerPals] Exiting because --require-docker is enabled.");
            process.exit(1);
          }
          console.error("[WorkerPals] Falling back to direct mode (isolated worktrees)...");
          dockerExecutor = null;
        }
      }
    }
  } else if (opts.requireDocker) {
    console.error("[WorkerPals] --require-docker was provided without --docker.");
    process.exit(1);
  }

  if (dockerExecutor) {
    let cleanupTriggered = false;
    const cleanup = async () => {
      await dockerExecutor.shutdown().catch((err) => {
        console.error(`[WorkerPals] Docker shutdown cleanup failed: ${String(err)}`);
      });
    };
    const cleanupAndExit = (code: number) => {
      if (cleanupTriggered) return;
      cleanupTriggered = true;
      void cleanup().finally(() => process.exit(code));
    };
    process.once("SIGINT", () => cleanupAndExit(130));
    process.once("SIGTERM", () => cleanupAndExit(143));
    if (process.platform === "win32") {
      process.once("SIGBREAK", () => cleanupAndExit(131));
    }
    process.once("exit", () => {
      if (cleanupTriggered) return;
      cleanupTriggered = true;
      void cleanup();
    });
  }

  workerLoop(opts, dockerExecutor).catch((err) => {
    console.error("[WorkerPals] Fatal:", err);
    process.exit(1);
  });
}

main();
