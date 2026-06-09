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
 *
 * Workerpals_main --> docker_executor (if Docker mode) --> job_runner (inside container if Docker mode)
 * job_runner -> job_runner::executeJob (executes the actual job command) -> job_runner (returns result) -> workerpals_main (handles completion)
 *
 * WorkerPals_main handles job claiming, heartbeats, and completion enqueuing.
 *
 * JobRunner executes a single job, streams logs, and outputs a final result with a sentinel line.
 */

import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { resolve } from "path";
import {
  detectRepoRoot,
  loadPromptTemplate,
  loadPushPalsConfig,
  resolveLocalServerConnection,
  resolveGitTokenForRemote,
  createToolRunRecordFromFailure,
} from "shared";
import { resolveExecutor } from "./common/executor_backend.js";
import { Logger } from "./common/logger.js";
import {
  executeJob,
  shouldCommit,
  createJobCommit,
  git,
  redactSensitiveText,
  resolveReviewNoChangeCompletionBranch,
  shouldEnqueueNoChangeReviewCompletion,
  type JobResult,
} from "./execute_job.js";
import { DockerExecutionExhaustedError, DockerExecutor } from "./docker_executor.js";
import { forceDeleteWorktreePath } from "./common/worktree_cleanup.js";
import { WorkerServerTransport, type WorkerHeartbeatPayload } from "./common/server_transport.js";
import { DEFAULT_DOCKER_TIMEOUT_MS, parseDockerTimeoutMs } from "./timeout_policy.js";
import { resolveFreshWorktreeBaseRef } from "./worktree_base_ref.js";
import type { JobDiagnostics, JobPhaseSpanDiagnostics } from "./common/types.js";

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

const DEFAULT_LLM_MODEL = "local-model";
const CODEX_UNAVAILABLE_WORKER_EXIT_CODE = 86;
const CODEX_UNAVAILABLE_DOCKER_SHUTDOWN_GRACE_MS = 5_000;
const CODEX_UNAVAILABLE_WORKER_FORCE_EXIT_MS = 4_000;
const DEFAULT_JOB_PROGRESS_LOG_EVERY_MS = 60_000;
const CONFIG = loadPushPalsConfig();
const LOG = new Logger("WorkerPals");

function workerLlmConfig(runtimeConfig: ReturnType<typeof loadPushPalsConfig>): {
  model: string;
  provider: string;
  baseUrl: string;
} {
  const normalizeProvider = (raw: string): string => {
    const value = raw.trim().toLowerCase();
    if (!value) return "auto";
    if (value === "lmstudio") return "openai";
    if (value === "openai_compatible") return "openai";
    if (value === "ollama_chat") return "ollama";
    return value;
  };

  const model = runtimeConfig.workerpals.llm.model.trim().replace(/\s+/g, " ");
  const provider = normalizeProvider(runtimeConfig.workerpals.llm.backend);
  const baseUrl = runtimeConfig.workerpals.llm.endpoint.trim();

  return {
    model: model || DEFAULT_LLM_MODEL,
    provider: provider || "auto",
    baseUrl,
  };
}

function estimateTokensFromText(text: string): number {
  return Math.max(0, Math.ceil(String(text ?? "").length / 3));
}

function compactWorkerError(error: unknown, maxLength = 220): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return "unknown error";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

async function postJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function inferFailureToolInvocation(result: JobResult): {
  tool?: string;
  argv?: string[];
  commandLine?: string;
  exitCode?: number | null;
} {
  const combined = [result.summary, result.stdout, result.stderr, result.publishBlocked?.detail]
    .map((part) => String(part ?? ""))
    .join("\n");
  if (/codex\s+--version/i.test(combined) || /openai_codex/i.test(combined)) {
    return {
      tool: "codex",
      argv: /codex\s+--version/i.test(combined) ? ["codex", "--version"] : [],
      commandLine: /codex\s+--version/i.test(combined) ? "codex --version" : undefined,
      exitCode: result.exitCode ?? (/exit\s+127/i.test(combined) ? 127 : null),
    };
  }
  if (/git\s+pull\s+--rebase/i.test(combined)) {
    return {
      tool: "git",
      argv: ["git", "pull", "--rebase"],
      commandLine: "git pull --rebase",
      exitCode: result.exitCode ?? null,
    };
  }
  if (/\bgit\b/i.test(combined) && /\b(rebase|cherry-pick|checkout|push)\b/i.test(combined)) {
    return { tool: "git", argv: [], exitCode: result.exitCode ?? null };
  }
  if (/\bdocker\b/i.test(combined) || /docker_engine/i.test(combined)) {
    return { tool: "docker", argv: [], exitCode: result.exitCode ?? null };
  }
  if (/\bbun\b/i.test(combined)) {
    return { tool: "bun", argv: [], exitCode: result.exitCode ?? null };
  }
  return { exitCode: result.exitCode ?? null };
}

async function reportToolRunForUnsuccessfulJob(args: {
  opts: ReturnType<typeof parseArgs>;
  headers: Record<string, string>;
  job: { id: string; kind: string; sessionId?: string | null };
  result: JobResult;
  durationMs: number;
  phase: string;
}): Promise<void> {
  const invocation = inferFailureToolInvocation(args.result);
  const record = createToolRunRecordFromFailure({
    id: randomUUID(),
    jobId: args.job.id,
    workerId: args.opts.workerId,
    sessionId: args.job.sessionId ?? null,
    phase: args.phase || args.job.kind,
    tool: invocation.tool,
    argv: invocation.argv,
    commandLine: invocation.commandLine,
    stdout: args.result.stdout,
    stderr: args.result.stderr ?? args.result.publishBlocked?.detail,
    summary: args.result.summary,
    detail: args.result.publishBlocked?.detail,
    exitCode: invocation.exitCode,
    durationMs: args.durationMs,
    finishedAt: new Date().toISOString(),
    envProfile: args.opts.docker ? "worker-container" : "worker-host",
    cwd: args.opts.repo,
    metadata: {
      publishBlocked: Boolean(args.result.publishBlocked),
      publishStage: args.result.publishBlocked?.stage ?? null,
    },
  });

  if (record.failureClass === "unknown" && record.tool === "shell") return;

  try {
    const response = await postJsonWithTimeout(
      `${args.opts.server}/tool-runs`,
      args.headers,
      record,
      5_000,
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[WorkerPals] Failed to record tool run telemetry for job ${args.job.id}: ${response.status} ${detail}`,
      );
    }
  } catch (error) {
    console.warn(
      `[WorkerPals] Failed to record tool run telemetry for job ${args.job.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function buildWorkerLlmUsageEvent(
  job: {
    kind: string;
    sessionId?: string | null;
    params?: Record<string, unknown> | null;
  },
  result: WorkerJobResult,
): Record<string, unknown> | null {
  const sessionId = String(job.sessionId ?? CONFIG.sessionId ?? "").trim();
  if (!sessionId) return null;
  const llmConfig = workerLlmConfig(CONFIG);
  const explicitUsage = result.usage;
  if (
    explicitUsage &&
    Number.isFinite(explicitUsage.promptTokens) &&
    explicitUsage.promptTokens >= 0 &&
    Number.isFinite(explicitUsage.completionTokens) &&
    explicitUsage.completionTokens >= 0
  ) {
    const promptTokens = Math.round(explicitUsage.promptTokens);
    const completionTokens = Math.round(explicitUsage.completionTokens);
    const totalTokens =
      Number.isFinite(explicitUsage.totalTokens) && (explicitUsage.totalTokens ?? 0) >= 0
        ? Math.round(explicitUsage.totalTokens ?? promptTokens + completionTokens)
        : promptTokens + completionTokens;
    return {
      service: "workerpals",
      sessionId,
      backend:
        String(explicitUsage.backend ?? resolveExecutor(CONFIG)).trim() || resolveExecutor(CONFIG),
      modelId: String(explicitUsage.modelId ?? llmConfig.model).trim() || llmConfig.model,
      promptTokens,
      completionTokens,
      totalTokens,
      estimated: explicitUsage.estimated === true,
    };
  }

  const promptSource = (() => {
    try {
      return JSON.stringify({
        kind: job.kind,
        params: job.params ?? {},
      });
    } catch {
      return `${job.kind}\n${String(job.params?.instruction ?? job.params?.prompt ?? "")}`.trim();
    }
  })();
  const completionSource = [result.summary, result.stdout ?? "", result.stderr ?? ""]
    .filter(Boolean)
    .join("\n\n");
  const promptTokens = estimateTokensFromText(promptSource);
  const completionTokens = estimateTokensFromText(completionSource);
  return {
    service: "workerpals",
    sessionId,
    backend: resolveExecutor(CONFIG),
    modelId: llmConfig.model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

async function reportWorkerLlmUsage(
  server: string,
  headers: Record<string, string>,
  job: {
    kind: string;
    sessionId?: string | null;
    params?: Record<string, unknown> | null;
  },
  result: WorkerJobResult,
): Promise<void> {
  const payload = buildWorkerLlmUsageEvent(job, result);
  if (!payload) return;
  const response = await postJsonWithTimeout(`${server}/telemetry/llm-usage`, headers, payload);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `usage telemetry rejected (${response.status})${detail ? `: ${detail.trim()}` : ""}`,
    );
  }
}

function integrationBranchName(): string {
  const configuredIntegrationBranch = CONFIG.sourceControlManager.mainBranch.trim();
  if (configuredIntegrationBranch) return configuredIntegrationBranch;
  const configuredBaseRef = CONFIG.workerpals.baseRef.trim();
  if (!configuredBaseRef) return "main_agents";
  return configuredBaseRef.replace(/^origin\//, "").trim() || "main_agents";
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

function resolveJobProgressLogEveryMs(): number {
  const raw = Number.parseInt(process.env.PUSHPALS_WORKERPAL_PROGRESS_LOG_MS ?? "", 10);
  if (Number.isFinite(raw) && raw === 0) return 0;
  if (Number.isFinite(raw) && raw >= 10_000) return raw;
  return DEFAULT_JOB_PROGRESS_LOG_EVERY_MS;
}

function sanitizeJobLogLine(line: string): string {
  // Strip ANSI escape/control sequences and collapse whitespace.
  const cleaned = line
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return redactSensitiveText(cleaned);
}

function isNoisyProgressLine(line: string): boolean {
  return /^(📦 Installing \[\d+\/\d+\]|🔍 Resolving\.\.\.|🔒 Saving lockfile\.\.\.)$/.test(line);
}

type WorkerJobPhase =
  | "discovering"
  | "editing"
  | "test harness repair"
  | "focused validation"
  | "full validation"
  | "final diff review"
  | "publishing"
  | "quality revision";

function inferWorkerJobPhaseFromLogLine(line: string): WorkerJobPhase | null {
  const text = String(line ?? "").trim();
  if (!text) return null;
  if (/Quality gate requested revision|Quality revision required|revision guidance/i.test(text)) {
    return "quality revision";
  }
  if (
    /test harness|React Native package|reactNativeMock|mock helper|mock was missing|expo-secure-store|import error|Cannot find module|does not provide an export|no exported member|Animated\.View|SettingsContext|skin validator/i.test(
      text,
    )
  ) {
    return "test harness repair";
  }
  if (
    /focused validation|focused checks|targeted test|focused test|new regression|focused regression|fast checks|rerunning .*regression|node --check/i.test(
      text,
    )
  ) {
    return "focused validation";
  }
  if (
    /ValidationGate|required validation|full .*test suite|whole Bun test|repo-level|bun test\b|bunx? tsc|typecheck|type check|bun run lint|web:e2e|browser smoke/i.test(
      text,
    )
  ) {
    return "full validation";
  }
  if (/creating commit|Publish blocked|publish-blocked|completion ref|enqueueCompletion/i.test(text)) {
    return "publishing";
  }
  if (
    /final diff|diff review|git diff|git status|whitespace|line-ending|line ending|pruning|remove unrelated|remaining diff|changed files/i.test(
      text,
    )
  ) {
    return "final diff review";
  }
  if (
    /editing|patch|implemented|adding|fixing|updating|wiring|in place|changes are in place|making .*change|tightening|restore|normalizing/i.test(
      text,
    )
  ) {
    return "editing";
  }
  if (
    /read|inspect|checking|locating|opening|artifact|screenshot|README|context|discover|search|rg |current checkout|worktree/i.test(
      text,
    )
  ) {
    return "discovering";
  }
  return null;
}

function mergeWorkerDiagnostics(
  base: JobDiagnostics | undefined,
  extra: JobDiagnostics,
): JobDiagnostics {
  return {
    ...(base ?? {}),
    ...extra,
    attempts: [...(base?.attempts ?? []), ...(extra.attempts ?? [])],
    phaseSpans: [...(base?.phaseSpans ?? []), ...(extra.phaseSpans ?? [])],
    validationRuns: [...(base?.validationRuns ?? []), ...(extra.validationRuns ?? [])],
    patchSnapshots: [...(base?.patchSnapshots ?? []), ...(extra.patchSnapshots ?? [])],
    terminal:
      base?.terminal || extra.terminal
        ? {
            ...(base?.terminal ?? {}),
            ...(extra.terminal ?? {}),
            metadata: {
              ...(base?.terminal?.metadata ?? {}),
              ...(extra.terminal?.metadata ?? {}),
            },
          }
        : undefined,
    metadata: {
      ...(extra.metadata ?? {}),
      ...(base?.metadata ?? {}),
    },
  };
}

function inferWorkerTerminalFailureClass(result: JobResult): string {
  if (result.ok) return "success";
  const text = `${result.summary ?? ""}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`.toLowerCase();
  if (/timed out|timeout|signal 15|terminated|exit 143|exit 137|stalled before first response|startup stall/.test(text)) return "timeout";
  if (/no publishable|non-publishable|node_modules/.test(text)) return "artifact_only_no_publishable_patch";
  if (/validationgate|validation/.test(text)) return "validation";
  if (/scopegate|scope/.test(text)) return "scope";
  if (/criticgate|critic/.test(text)) return "critic";
  if (/publish/.test(text)) return "publish";
  return "worker_failure";
}

function buildPhaseSpanDiagnostics(
  spans: Array<{ phase: WorkerJobPhase; startedAtMs: number; finishedAtMs?: number }>,
  attempt: number,
  fallbackFinishedAtMs: number,
  outcome: string,
): JobPhaseSpanDiagnostics[] {
  return spans.slice(0, 32).map((span) => {
    const startedAtMs = Math.max(0, span.startedAtMs);
    const finishedAtMs = Math.max(startedAtMs, span.finishedAtMs ?? fallbackFinishedAtMs);
    return {
      attempt,
      phase: span.phase,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      outcome,
    };
  });
}

export function shouldEmitDirectSessionJobEvent(options: {
  ok: boolean;
  statusPersistedToServer: boolean;
}): boolean {
  if (options.ok) return true;
  return !options.statusPersistedToServer;
}

export function shouldRecycleWorkerForHeartbeatDegradation(options: {
  heartbeatDelivered: boolean;
  allowHeartbeatRecycle: boolean;
  transportStale: boolean;
}): boolean {
  if (options.heartbeatDelivered) return false;
  if (!options.allowHeartbeatRecycle) return false;
  return options.transportStale;
}

function shouldRecycleWorkerForCodexUnavailableFailure(
  summary: string,
  stderr?: string | null,
): boolean {
  const text = `${summary}\n${stderr ?? ""}`.toLowerCase();
  return [
    "openai_codex cli is not installed",
    "openai_codex chatgpt auth is not ready",
    "openai_codex api_key auth requires openai_api_key",
    "openai_codex policy violation: codex cli workaround detected",
    "codex cli isn't available",
    "codex cli is mandatory in this backend",
  ].some((needle) => text.includes(needle));
}

async function shutdownDockerExecutorBeforeCodexRecycle(
  dockerExecutor: DockerExecutor | null,
): Promise<void> {
  if (!dockerExecutor) return;

  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  try {
    await Promise.race([
      dockerExecutor.shutdown(),
      new Promise<void>((resolvePromise) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolvePromise();
        }, CODEX_UNAVAILABLE_DOCKER_SHUTDOWN_GRACE_MS);
      }),
    ]);
  } catch (err) {
    console.error(`[WorkerPals] Docker shutdown cleanup failed: ${String(err)}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (timedOut) {
    console.warn(
      `[WorkerPals] Docker shutdown cleanup exceeded ${CODEX_UNAVAILABLE_DOCKER_SHUTDOWN_GRACE_MS}ms; exiting worker for Codex recycle anyway.`,
    );
  }
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
  let server = CONFIG.server.url;
  let pollMs = CONFIG.workerpals.pollMs;
  let heartbeatMs = CONFIG.workerpals.heartbeatMs;
  let repo = detectRepoRoot(process.cwd());
  let workerId = `workerpal-${randomUUID().substring(0, 8)}`;
  let authToken = CONFIG.authToken;
  let docker = false;
  let requireDocker = CONFIG.workerpals.requireDocker;
  let dockerImage = CONFIG.workerpals.dockerImage;
  let gitToken = CONFIG.gitToken;
  let dockerTimeout = CONFIG.workerpals.dockerTimeoutMs;
  let dockerIdleTimeout = CONFIG.workerpals.dockerIdleTimeoutMs;
  let dockerNetworkMode = CONFIG.workerpals.dockerNetworkMode;
  let worktreeBaseRef = CONFIG.workerpals.baseRef || `origin/${integrationBranchName()}`;
  let labels = [...CONFIG.workerpals.labels];
  let failureCooldownMs = CONFIG.workerpals.failureCooldownMs;

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

  const resolved = resolveLocalServerConnection({
    serverUrl: server,
    authToken,
    fallbackPort: CONFIG.server.port,
  });
  if (resolved.serverWasNormalized) {
    LOG.warn(`Coerced server URL to local-only endpoint: ${resolved.serverUrl}`);
  }
  if (resolved.authTokenWasIgnored) {
    LOG.warn("Ignoring auth token in local-only mode.");
  }

  return {
    server: resolved.serverUrl,
    pollMs,
    heartbeatMs: Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : pollMs,
    repo,
    workerId,
    authToken: resolved.authToken,
    docker,
    requireDocker,
    dockerImage,
    gitToken,
    dockerTimeout:
      Number.isFinite(dockerTimeout) && dockerTimeout > 0
        ? dockerTimeout
        : DEFAULT_DOCKER_TIMEOUT_MS,
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

async function resolveGitRemoteUrl(repo: string, remote = "origin"): Promise<string> {
  const result = await git(repo, ["remote", "get-url", remote]);
  if (!result.ok) return "";
  return String(result.stdout ?? "").trim();
}

async function resolveWorkerGitToken(
  repo: string,
  configuredToken: string | null,
): Promise<string> {
  const remoteUrl = await resolveGitRemoteUrl(repo, "origin");
  const resolved = await resolveGitTokenForRemote({
    remoteUrl,
    configuredToken: configuredToken ?? "",
    cwd: repo,
  });
  if (resolved.token) {
    console.log(
      `[WorkerPals] Git auth: backend=${resolved.backend} host=${resolved.host || "unknown"} source=${resolved.source}`,
    );
  } else {
    console.warn(
      `[WorkerPals] Git auth token not found (backend=${resolved.backend}, host=${resolved.host || "unknown"}). Push-required jobs may fail.`,
    );
  }
  return resolved.token;
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
  runtimeConfig: ReturnType<typeof loadPushPalsConfig>,
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
      publishBlocked: result.publishBlocked,
      commit: result.commit,
    };
  }
  return executeJob(job.kind, job.params, repo, onLog, runtimeConfig);
}

async function resolveWorktreeBaseRef(repo: string, requestedRef: string): Promise<string> {
  return resolveFreshWorktreeBaseRef({
    requestedRef,
    integrationBranch: integrationBranchName(),
    sourceBaseBranch: CONFIG.sourceControlManager.baseBranch,
    git: (args) => git(repo, args),
    log: (level, message) => {
      const line = `[WorkerPals] ${message}`;
      if (level === "warn") console.warn(line);
      else console.log(line);
    },
  });
}

async function createIsolatedWorktree(
  repo: string,
  jobId: string,
  baseRef: string,
): Promise<string> {
  const worktreeRoot = resolve(repo, ".worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const safeJobId = jobId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 8);
  const nonce = `${Date.now().toString(36).slice(-6)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;

  const worktreePath = resolve(
    worktreeRoot,
    `job-${safeJobId || "host"}-${nonce}`,
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
    console.warn(
      `[WorkerPals] Worktree cleanup warning (${worktreePath}): ${removeResult.stderr || removeResult.stdout}`,
    );
  }
  const pruneResult = await git(repo, ["worktree", "prune"]);
  if (!pruneResult.ok) {
    console.warn(
      `[WorkerPals] Worktree prune warning (${worktreePath}): ${pruneResult.stderr || pruneResult.stdout}`,
    );
  }

  const forced = await forceDeleteWorktreePath(worktreePath);
  if (!forced.removed) {
    throw new Error(
      `worktree path persisted after cleanup (${worktreePath})${forced.lastError ? `: ${forced.lastError}` : ""}`,
    );
  }
}

function sanitizePrText(value: unknown, max = 240): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function inferPrArea(kind: string, changedPaths: string[]): string {
  const looksLikeTests = (path: string): boolean => {
    const normalized = path.replace(/\\/g, "/").toLowerCase();
    return (
      normalized.startsWith("tests/") ||
      normalized.includes("/tests/") ||
      normalized.endsWith(".test.ts") ||
      normalized.endsWith(".test.tsx") ||
      normalized.endsWith(".spec.ts") ||
      normalized.endsWith(".spec.tsx") ||
      normalized.endsWith("_test.py") ||
      normalized.endsWith("_test.js") ||
      normalized.endsWith("_test.ts")
    );
  };
  if (changedPaths.some(looksLikeTests)) return "tests";
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
  if (params.planning && typeof params.planning === "object") {
    const planning = params.planning as Record<string, unknown>;
    if (Array.isArray(planning.targetPaths)) {
      for (const value of planning.targetPaths) add(value);
    }
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

function inferValidationSteps(params: Record<string, unknown> | undefined): string[] {
  if (!params || !params.planning || typeof params.planning !== "object") return [];
  const planning = params.planning as Record<string, unknown>;
  const out: string[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...(Array.isArray(planning.validationSteps) ? planning.validationSteps : []),
    ...(Array.isArray(planning.requiredValidationSteps)
      ? planning.requiredValidationSteps.map((step) => `${step} (required by vision.md)`)
      : []),
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const step = sanitizePrText(raw, 200);
    if (!step || seen.has(step)) continue;
    seen.add(step);
    out.push(step);
    if (out.length >= 10) break;
  }
  return out;
}

function inferTaskInstruction(params: Record<string, unknown> | undefined): string {
  if (!params || typeof params.instruction !== "string") return "";
  return sanitizePrText(params.instruction, 240);
}

function isLowSignalResultSummary(summary: string): boolean {
  const text = summary.trim().toLowerCase();
  if (!text) return true;
  return (
    text.includes("executed task and modified") ||
    text.includes("executed task via") ||
    text.includes("no file changes detected") ||
    text.includes("task summary")
  );
}

function derivePrSummary(
  kind: string,
  params: Record<string, unknown> | undefined,
  resultSummary: string,
): string {
  const workerSummary = sanitizePrText(resultSummary, 96);
  if (workerSummary && !isLowSignalResultSummary(workerSummary)) {
    return workerSummary;
  }

  const instruction = inferTaskInstruction(params);
  if (instruction) {
    let normalized = instruction
      .replace(/^(can you|could you|would you|please)\s+/i, "")
      .replace(/\?+$/, "")
      .trim();
    if (normalized.length > 0) {
      normalized = normalized[0].toUpperCase() + normalized.slice(1);
      return sanitizePrText(normalized, 96);
    }
  }

  return sanitizePrText(`${kind} update`, 96);
}

function inferPrTitleType(kind: string, area: string): "test" | "fix" | "chore" {
  if (area === "tests") return "test";
  if (kind.startsWith("task.") || kind.startsWith("file.")) return "fix";
  return "chore";
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
  taskInstruction: string;
  validationSteps: string[];
  risk: "low" | "medium";
}): CompletionPrMetadata {
  const changesSection =
    args.changedPaths.length > 0
      ? args.changedPaths.map((path) => `- Updated \`${sanitizePrText(path, 180)}\``)
      : [`- Updated worker completion for \`${sanitizePrText(args.job.kind, 80)}\``];
  const validationSection =
    args.validationSteps.length > 0
      ? args.validationSteps.map((step) => `- ${sanitizePrText(step, 200)}`)
      : ["- Not specified by planner"];

  const body = [
    "### Summary",
    `- Apply WorkerPal completion \`${sanitizePrText(args.job.id, 64)}\` to \`${sanitizePrText(args.integrationBranch, 64)}\`.`,
    `- Integrate commit \`${sanitizePrText(args.commit.sha, 64)}\` from \`${sanitizePrText(args.commit.branch, 120)}\`.`,
    `- Worker: \`${sanitizePrText(args.workerId, 64)}\`.`,
    `- Canonical task request: ${args.taskInstruction ? `\`${sanitizePrText(args.taskInstruction, 220)}\`` : "_(not provided)_"}`,
    "",
    "### Motivation / Context",
    "- Preserve and review autonomous worker output before final merge to base branch.",
    "- Keep integration branch current with queued worker completions.",
    "",
    "### Changes",
    ...changesSection,
    "",
    "### Testing / Validation",
    ...validationSection,
    "- Worker did not provide explicit per-command pass/fail logs in completion summary.",
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
  const changedPaths = inferChangedPaths(args.job.params);
  const validationSteps = inferValidationSteps(args.job.params);
  const taskInstruction = inferTaskInstruction(args.job.params);
  const area = inferPrArea(args.job.kind, changedPaths);
  const prType = inferPrTitleType(args.job.kind, area);
  const summary = derivePrSummary(args.job.kind, args.job.params, args.resultSummary);
  const title = `${prType}(${area}): ${summary}`;
  const risk =
    args.job.kind.startsWith("task.") || args.job.kind.startsWith("file.") ? "medium" : "low";
  const changesLines =
    changedPaths.length > 0
      ? changedPaths.map((path) => `Updated \`${sanitizePrText(path, 180)}\``)
      : [`Updated worker completion for \`${sanitizePrText(args.job.kind, 80)}\``];
  const validationLines =
    validationSteps.length > 0
      ? validationSteps.map((step) => `Planned: ${sanitizePrText(step, 200)}`)
      : ["No explicit planner validation steps were provided."];
  const motivationLines = [
    "Preserve and review autonomous worker output before final merge to base branch.",
    "Keep integration branch current with queued worker completions.",
  ];
  const testingLines = [
    ...validationLines,
    "Worker completion summary did not include explicit command pass/fail output.",
  ];
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
    task_instruction: taskInstruction || "(not provided)",
    motivation_lines: toBulletList(motivationLines),
    target_paths_lines: toBulletList(
      changedPaths.length > 0
        ? changedPaths.map((path) => `\`${sanitizePrText(path, 180)}\``)
        : ["None identified"],
    ),
    validation_plan_lines: toBulletList(validationLines),
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
    taskInstruction,
    validationSteps,
    risk,
  });
}

function parseLsRemoteSha(output: string): string | null {
  const firstLine =
    (output ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const match = firstLine.match(/^([0-9a-f]{40})\s+/i);
  return match ? match[1] : null;
}

async function resolveReReviewNoChangeCommit(
  repo: string,
  params: Record<string, unknown> | null | undefined,
): Promise<CommitRef | null> {
  const branch = resolveReviewNoChangeCompletionBranch(params);
  if (!branch) return null;

  const remoteRef = `refs/heads/${branch}`;
  const lsRemote = await git(repo, ["ls-remote", "origin", remoteRef]);
  if (lsRemote.ok) {
    const sha = parseLsRemoteSha(lsRemote.stdout);
    if (sha) return { branch, sha };
  }

  const localRefs = [branch, `refs/heads/${branch}`, `origin/${branch}`];
  for (const ref of localRefs) {
    const revParse = await git(repo, ["rev-parse", "--verify", ref]);
    if (revParse.ok) {
      const sha = revParse.stdout.trim();
      if (sha) return { branch, sha };
    }
  }

  return null;
}

function failNoChangeReviewFixJob(jobId: string, result: WorkerJobResult): WorkerJobResult {
  return {
    ...result,
    ok: false,
    summary: `Rejected review-fix job ${jobId} produced no code changes; refusing unchanged branch re-review.`,
    stderr: [
      result.stderr,
      "Review-fix jobs must make at least one concrete code/test/docs change before requesting another review.",
      "If the reviewer feedback is invalid, commit a narrow explanatory change that documents the decision; unchanged branch re-review is refused.",
    ]
      .filter(Boolean)
      .join("\n"),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 4,
  };
}

function taskExecuteOrigin(params: Record<string, unknown> | undefined): "user" | "autonomy" {
  if (!params) return "user";
  if (params.origin === "autonomy") return "autonomy";
  const autonomy = params.autonomy;
  return autonomy && typeof autonomy === "object" && !Array.isArray(autonomy) ? "autonomy" : "user";
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
    const reviewAgent =
      job.params?.reviewAgent && typeof job.params.reviewAgent === "object"
        ? (job.params.reviewAgent as Record<string, unknown>)
        : null;
    const prUrl =
      reviewAgent && typeof reviewAgent.prUrl === "string" && reviewAgent.prUrl.trim().length > 0
        ? reviewAgent.prUrl.trim()
        : null;
    const pr = buildCompletionPrMetadata({
      workerId,
      integrationBranch,
      job,
      commit,
      resultSummary,
    });

    const response = await postJsonWithTimeout(`${server}/completions/enqueue`, headers, {
      jobId: job.id,
      sessionId: job.sessionId,
      origin: taskExecuteOrigin(job.params),
      commitSha: commit.sha,
      branch: commit.branch,
      message: `${job.kind}: ${job.taskId} (worker PR metadata attached)`,
      prUrl,
      prTitle: pr.title,
      prBody: pr.body,
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

type WorkerRuntimeState = {
  currentJobId: string | null;
  currentSessionId: string | null;
  shutdownRequested: boolean;
};

function buildWorkerHeaders(authToken: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return headers;
}

async function failActiveJobOnShutdown(
  opts: ReturnType<typeof parseArgs>,
  headers: Record<string, string>,
  runtimeState: WorkerRuntimeState,
  transport: WorkerServerTransport,
  signalName: string,
): Promise<void> {
  const activeJobId = runtimeState.currentJobId;
  if (!activeJobId) return;

  const message = "Worker process shutting down during claimed job";
  const detail = `worker=${opts.workerId}; signal=${signalName}; action=fail-claimed-job-on-shutdown`;
  let statusPersistedToServer = false;

  try {
    const response = await postJsonWithTimeout(`${opts.server}/jobs/${activeJobId}/fail`, headers, {
      message,
      detail,
    });
    statusPersistedToServer = response.ok;
  } catch (err) {
    console.error(
      `[WorkerPals] Failed to mark active job ${activeJobId} as failed during shutdown:`,
      err,
    );
  }

  if (
    runtimeState.currentSessionId &&
    shouldEmitDirectSessionJobEvent({ ok: false, statusPersistedToServer })
  ) {
    await transport.queueSessionCommand(
      runtimeState.currentSessionId,
      {
        type: "job_failed",
        payload: {
          jobId: activeJobId,
          message,
          detail,
        },
        from: `worker:${opts.workerId}`,
      },
      { priority: "high" },
    );
  }
}

async function deferClaimedJobForMaintenance(
  opts: ReturnType<typeof parseArgs>,
  headers: Record<string, string>,
  jobId: string,
  deferMs: number,
): Promise<{ ok: boolean; availableAt?: string; message?: string }> {
  try {
    const response = await postJsonWithTimeout(`${opts.server}/jobs/${jobId}/defer`, headers, {
      workerId: opts.workerId,
      deferMs,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      availableAt?: string;
      message?: string;
    };
    if (!response.ok || !payload.ok) {
      return {
        ok: false,
        message: payload.message || `HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      availableAt: payload.availableAt,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function workerLoop(
  opts: ReturnType<typeof parseArgs>,
  dockerExecutor: DockerExecutor | null,
  runtimeState: WorkerRuntimeState,
  transport: WorkerServerTransport,
  requestWorkerRestart: (reason: string) => void,
): Promise<void> {
  const headers = buildWorkerHeaders(opts.authToken);

  console.log(`[WorkerPals ${opts.workerId}] Polling ${opts.server} every ${opts.pollMs}ms`);
  if (dockerExecutor) {
    console.log(
      `[WorkerPals ${opts.workerId}] Docker mode enabled (${opts.dockerImage}, network=${opts.dockerNetworkMode})`,
    );
  } else {
    console.log(`[WorkerPals ${opts.workerId}] Direct mode with isolated worktrees enabled`);
  }
  console.log(`[WorkerPals ${opts.workerId}] Executor backend: ${resolveExecutor(CONFIG)}`);
  const heartbeatEveryMs = Math.max(1000, opts.heartbeatMs);
  const claimTimeoutMs = Math.max(4_000, Math.min(15_000, opts.pollMs * 3));
  let lastHeartbeatAt = 0;
  const buildHeartbeatPayload = (
    status: WorkerHeartbeatPayload["status"],
    currentJobId: string | null,
  ): WorkerHeartbeatPayload => ({
    status,
    currentJobId,
    capabilities: {
      docker: opts.docker,
      labels: opts.labels,
      executor: resolveExecutor(CONFIG),
      requireDocker: opts.requireDocker,
    },
    details: {
      repo: opts.repo,
      baseRef: opts.worktreeBaseRef,
      dockerImage: opts.docker ? opts.dockerImage : null,
      dockerNetworkMode: opts.docker ? opts.dockerNetworkMode : null,
    },
  });

  const maybeHeartbeat = async (
    status: WorkerHeartbeatPayload["status"],
    currentJobId: string | null = null,
    force = false,
  ) => {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < heartbeatEveryMs) return;
    const ok = await transport.sendHeartbeat(buildHeartbeatPayload(status, currentJobId));
    if (ok) lastHeartbeatAt = now;
  };

  await maybeHeartbeat("idle", null, true);

  while (!runtimeState.shutdownRequested) {
    try {
      await maybeHeartbeat("idle");
      const claimRes = await postJsonWithTimeout(
        `${opts.server}/jobs/claim`,
        headers,
        { workerId: opts.workerId },
        claimTimeoutMs,
      );

      if (claimRes.ok) {
        const data = (await claimRes.json()) as any;
        const job = data.job;

        if (job) {
          if (dockerExecutor && dockerExecutor.shouldPrepareMergeConflictJobBeforeExecution(job)) {
            const deferMs = dockerExecutor.recommendedMergeConflictDeferMs();
            const deferred = await deferClaimedJobForMaintenance(opts, headers, job.id, deferMs);
            if (!deferred.ok) {
              console.warn(
                `[WorkerPals] Failed to defer merge-conflict job ${job.id} for image refresh; falling back to claimed execution path: ${
                  deferred.message || "unknown error"
                }`,
              );
            } else {
              console.log(
                `[WorkerPals] Deferred merge-conflict job ${job.id} until ${
                  deferred.availableAt ?? "maintenance complete"
                } while refreshing Docker image outside claimed-job lifetime.`,
              );
              const maintenanceHeartbeat = setInterval(() => {
                void transport.sendHeartbeat({
                  ...buildHeartbeatPayload("idle", null),
                  details: {
                    repo: opts.repo,
                    baseRef: opts.worktreeBaseRef,
                    dockerImage: opts.docker ? opts.dockerImage : null,
                    dockerNetworkMode: opts.docker ? opts.dockerNetworkMode : null,
                    maintenance: "merge_conflict_image_refresh",
                    deferredJobId: job.id,
                  },
                });
              }, heartbeatEveryMs);
              try {
                await maybeHeartbeat("idle", null, true);
                await dockerExecutor.prepareMergeConflictJobEnvironment(job);
              } catch (error) {
                const detail = redactSensitiveText(
                  error instanceof Error ? error.stack || error.message : String(error),
                );
                console.error(
                  `[WorkerPals] Merge-conflict environment preparation failed for ${job.id}: ${detail}`,
                );
                try {
                  const failResponse = await postJsonWithTimeout(
                    `${opts.server}/jobs/${job.id}/fail-deferred`,
                    headers,
                    {
                      workerId: opts.workerId,
                      message: "Merge-conflict environment preparation failed",
                      detail,
                    },
                  );
                  const failPayload = (await failResponse.json().catch(() => ({}))) as {
                    ok?: boolean;
                    message?: string;
                  };
                  if (!failResponse.ok || !failPayload.ok) {
                    console.error(
                      `[WorkerPals] Failed to mark deferred job ${job.id} as failed: ${
                        failPayload.message || `HTTP ${failResponse.status}`
                      }`,
                    );
                  }
                } catch (failErr) {
                  console.error(
                    `[WorkerPals] Failed to mark deferred job ${job.id} as failed: ${
                      failErr instanceof Error ? failErr.message : String(failErr)
                    }`,
                  );
                }
              } finally {
                clearInterval(maintenanceHeartbeat);
              }
              await maybeHeartbeat("idle", null, true);
              continue;
            }
          }

          runtimeState.currentJobId = job.id;
          runtimeState.currentSessionId = job.sessionId ?? null;
          console.log(`[WorkerPals] Claimed job ${job.id} (${job.kind})`);
          await maybeHeartbeat("busy", job.id, true);
          let allowHeartbeatRecycle = true;

          const busyHeartbeat = setInterval(() => {
            void transport.sendHeartbeat(buildHeartbeatPayload("busy", job.id)).then((ok) => {
              if (
                !shouldRecycleWorkerForHeartbeatDegradation({
                  heartbeatDelivered: ok,
                  allowHeartbeatRecycle,
                  transportStale: transport.shouldRecycleBusyWorker(),
                })
              ) {
                return;
              }
              requestWorkerRestart(
                `heartbeat transport stale while claimed job ${job.id} is still running`,
              );
            });
          }, heartbeatEveryMs);

          if (job.sessionId) {
            await transport.queueSessionCommand(
              job.sessionId,
              {
                type: "job_claimed",
                payload: { jobId: job.id, workerId: opts.workerId },
                from: `worker:${opts.workerId}`,
              },
              { priority: "high" },
            );
          }

          let stdoutSeq = 0;
          let stderrSeq = 0;
          let lastCleanLog = "";
          let lastCleanLogAt = 0;
          const jobClaimedAtMs = Date.now();
          let lastForwardedJobLogAt = jobClaimedAtMs;
          let currentJobPhase: WorkerJobPhase | null = null;
          const phaseSpans: Array<{
            phase: WorkerJobPhase;
            startedAtMs: number;
            finishedAtMs?: number;
          }> = [];
          const noteJobPhase = (phase: WorkerJobPhase | null, atMs = Date.now()): void => {
            if (!phase || phase === currentJobPhase) return;
            const previous = phaseSpans[phaseSpans.length - 1];
            if (previous && previous.finishedAtMs == null) previous.finishedAtMs = atMs;
            currentJobPhase = phase;
            phaseSpans.push({ phase, startedAtMs: atMs });
          };

          const emitJobLog = job.sessionId
            ? (stream: "stdout" | "stderr", line: string): boolean => {
                const cleaned = sanitizeJobLogLine(line);
                if (!cleaned) return false;

                // Drop high-frequency terminal progress redraw spam; keep meaningful lines.
                if (isNoisyProgressLine(cleaned)) return false;

                // Collapse very noisy duplicate lines emitted in tight loops.
                const now = Date.now();
                if (cleaned === lastCleanLog && now - lastCleanLogAt < 1_000) return false;
                lastCleanLog = cleaned;
                lastCleanLogAt = now;
                lastForwardedJobLogAt = now;
                noteJobPhase(inferWorkerJobPhaseFromLogLine(cleaned), now);
                const logTs = new Date(now).toISOString();

                const seq = stream === "stdout" ? ++stdoutSeq : ++stderrSeq;
                void transport.queueSessionCommand(
                  job.sessionId,
                  {
                    type: "job_log",
                    payload: {
                      jobId: job.id,
                      stream,
                      seq,
                      line: cleaned,
                      ts: logTs,
                      phase: currentJobPhase,
                    },
                    from: `worker:${opts.workerId}`,
                  },
                  { droppable: true },
                );
                void transport.queueJobLog(job.id, {
                  stream,
                  seq,
                  message: cleaned,
                  ts: logTs,
                });
                return true;
              }
            : undefined;

          const onLog = emitJobLog
            ? (stream: "stdout" | "stderr", line: string) => {
                const cleaned = sanitizeJobLogLine(line);
                if (LOG.isDebugEnabled() && cleaned) LOG.debug(`[${stream}] ${cleaned}`);
                emitJobLog(stream, line);
              }
            : undefined;

          const jobProgressLogEveryMs = resolveJobProgressLogEveryMs();
          const jobProgressTimer =
            emitJobLog && jobProgressLogEveryMs > 0
              ? setInterval(() => {
                  const now = Date.now();
                  const quietForMs = Math.max(0, now - lastForwardedJobLogAt);
                  if (quietForMs < jobProgressLogEveryMs) return;
                  emitJobLog(
                    "stdout",
                    `[WorkerPals] Job ${job.id} still running after ${formatDurationMs(
                      now - jobClaimedAtMs,
                    )} (kind=${job.kind}, worker=${opts.workerId}, phase=${
                      currentJobPhase ?? "unknown"
                    }, quiet_for=${formatDurationMs(quietForMs)}).`,
                  );
                }, jobProgressLogEveryMs)
              : null;

          let directWorktreePath: string | null = null;
          let executionRepo = opts.repo;
          let result: WorkerJobResult | null = null;
          let recycleWorkerAfterJob = false;

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
              result = await runJob(jobData, executionRepo, dockerExecutor, CONFIG, onLog);
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
              const errorSummary = compactWorkerError(err);
              result = {
                ok: false,
                summary: `Job execution failed before completion: ${errorSummary}`,
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

            allowHeartbeatRecycle = false;
            await transport.flush();
            try {
              await reportWorkerLlmUsage(opts.server, headers, jobData, result);
            } catch (err) {
              console.warn(
                `[WorkerPals] Failed to report LLM usage for job ${job.id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }

            let completionCommit: CommitRef | null = null;
            if (result.ok && shouldCommit(job.kind, CONFIG)) {
              if (result.commit) {
                if (result.commit.sha !== "no-changes") {
                  completionCommit = result.commit;
                } else if (!shouldEnqueueNoChangeReviewCompletion(parsedParams)) {
                  console.warn(
                    `[WorkerPals] Job ${job.id} produced no code changes for a rejected review-fix request; marking the job failed instead of enqueueing unchanged branch re-review.`,
                  );
                  result = failNoChangeReviewFixJob(job.id, result);
                } else {
                  const reReviewCommit = await resolveReReviewNoChangeCommit(
                    executionRepo,
                    parsedParams,
                  );
                  if (reReviewCommit) {
                    completionCommit = reReviewCommit;
                    console.log(
                      `[WorkerPals] Job ${job.id} produced no file changes; enqueuing re-review completion for ${reReviewCommit.branch} @ ${reReviewCommit.sha.slice(0, 8)}.`,
                    );
                  } else {
                    console.log(`[WorkerPals] Job ${job.id} produced no file changes to commit.`);
                  }
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
                const commitResult = await createJobCommit(
                  executionRepo,
                  opts.workerId,
                  {
                    id: job.id,
                    taskId: job.taskId,
                    kind: job.kind,
                    params: parsedParams,
                    sessionId: job.sessionId,
                    context: "host",
                  },
                  CONFIG,
                );

                if (commitResult.ok && commitResult.sha && commitResult.branch) {
                  if (commitResult.sha !== "no-changes") {
                    completionCommit = {
                      branch: commitResult.branch,
                      sha: commitResult.sha,
                    };
                  } else if (!shouldEnqueueNoChangeReviewCompletion(parsedParams)) {
                    console.warn(
                      `[WorkerPals] Job ${job.id} produced no staged review-fix changes; marking the job failed instead of enqueueing unchanged branch re-review.`,
                    );
                    result = failNoChangeReviewFixJob(job.id, result);
                  }
                } else if (commitResult.publishBlocked) {
                  result = {
                    ...result,
                    ok: false,
                    summary: commitResult.publishBlocked.summary,
                    stderr: [result.stderr, commitResult.error].filter(Boolean).join("\n"),
                    publishBlocked: commitResult.publishBlocked,
                  };
                  console.error(`[WorkerPals] Publish blocked: ${commitResult.error}`);
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

            const finalizedAtMs = Date.now();
            const jobAttemptRaw = Number((job as { attempt?: unknown }).attempt ?? 1);
            const jobAttempt =
              Number.isFinite(jobAttemptRaw) && jobAttemptRaw > 0 ? Math.floor(jobAttemptRaw) : 1;
            const llm = workerLlmConfig(CONFIG);
            result = {
              ...result,
              diagnostics: mergeWorkerDiagnostics(result.diagnostics, {
                attempts: [
                  {
                    attempt: jobAttempt,
                    workerId: opts.workerId,
                    backend: resolveExecutor(CONFIG),
                    model: llm.model,
                    startedAt: new Date(jobStartedAtMs).toISOString(),
                    finishedAt: new Date(finalizedAtMs).toISOString(),
                    durationMs: Math.max(0, finalizedAtMs - jobStartedAtMs),
                    terminalReason: result.summary,
                    exitCode: result.exitCode ?? (result.ok ? 0 : 1),
                    metadata: {
                      docker: Boolean(dockerExecutor),
                      jobKind: job.kind,
                      provider: llm.provider,
                      cooldownMs: result.cooldownMs ?? 0,
                    },
                  },
                ],
                phaseSpans: buildPhaseSpanDiagnostics(
                  phaseSpans,
                  jobAttempt,
                  finalizedAtMs,
                  result.ok ? "completed" : result.publishBlocked ? "publish_blocked" : "failed",
                ),
                terminal: {
                  failureClass: inferWorkerTerminalFailureClass(result),
                  terminalStage: currentJobPhase ?? (result.ok ? "completed" : "worker"),
                  executorBackend: resolveExecutor(CONFIG),
                  summary: result.summary,
                  watchdogFired:
                    /watchdog|rollout coach|timed out|timeout|signal 15|terminated|exit 143|exit 137/i.test(
                      `${result.summary}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`,
                    ),
                  metadata: {
                    workerId: opts.workerId,
                    docker: Boolean(dockerExecutor),
                    jobKind: job.kind,
                    phase: currentJobPhase,
                  },
                },
              }),
            };

            let statusPersistedToServer = false;
            if (result.publishBlocked) {
              await reportToolRunForUnsuccessfulJob({
                opts,
                headers,
                job,
                result,
                durationMs: jobDurationMs,
                phase: `publish:${result.publishBlocked.stage}`,
              });
              const response = await postJsonWithTimeout(
                `${opts.server}/jobs/${job.id}/publish-blocked`,
                headers,
                {
                  message: result.summary,
                  detail: redactSensitiveText(result.stderr ?? ""),
                  publishBlocked: result.publishBlocked,
                  durationMs: jobDurationMs,
                  diagnostics: result.diagnostics,
                },
              );
              statusPersistedToServer = response.ok;
              console.log(
                `[WorkerPals] Job ${job.id} publish-blocked in ${formatDurationMs(jobDurationMs)}: ${result.summary}`,
              );
            } else if (result.ok) {
              const reviewAgent =
                parsedParams.reviewAgent && typeof parsedParams.reviewAgent === "object"
                  ? (parsedParams.reviewAgent as Record<string, unknown>)
                  : null;
              const jobPrUrl =
                reviewAgent &&
                typeof reviewAgent.prUrl === "string" &&
                reviewAgent.prUrl.trim().length > 0
                  ? reviewAgent.prUrl.trim()
                  : null;
              const response = await postJsonWithTimeout(
                `${opts.server}/jobs/${job.id}/complete`,
                headers,
                {
                  summary: result.summary,
                  durationMs: jobDurationMs,
                  prUrl: jobPrUrl,
                  diagnostics: result.diagnostics,
                  artifacts: [
                    ...(result.stdout ? [{ kind: "stdout", text: result.stdout }] : []),
                    ...(result.stderr ? [{ kind: "stderr", text: result.stderr }] : []),
                  ],
                },
              );
              statusPersistedToServer = response.ok;
              console.log(
                `[WorkerPals] Job ${job.id} completed in ${formatDurationMs(jobDurationMs)}: ${result.summary}`,
              );
            } else {
              await reportToolRunForUnsuccessfulJob({
                opts,
                headers,
                job,
                result,
                durationMs: jobDurationMs,
                phase: job.kind,
              });
              const response = await postJsonWithTimeout(
                `${opts.server}/jobs/${job.id}/fail`,
                headers,
                {
                  message: result.summary,
                  detail: redactSensitiveText(result.stderr ?? ""),
                  durationMs: jobDurationMs,
                  diagnostics: result.diagnostics,
                },
              );
              statusPersistedToServer = response.ok;
              console.log(
                `[WorkerPals] Job ${job.id} failed in ${formatDurationMs(jobDurationMs)}: ${result.summary}`,
              );
              recycleWorkerAfterJob = shouldRecycleWorkerForCodexUnavailableFailure(
                result.summary,
                result.stderr,
              );
              if (recycleWorkerAfterJob) {
                console.error(
                  `[WorkerPals] Codex backend unavailable for job ${job.id}; terminating this worker for replacement.`,
                );
              }
            }

            if (job.sessionId) {
              const jobOrigin = taskExecuteOrigin(parsedParams);
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
                  await transport.queueSessionCommand(
                    job.sessionId,
                    {
                      type: "assistant_message",
                      payload: { text: assistantText },
                      from:
                        jobOrigin === "autonomy"
                          ? `worker:${opts.workerId}/autonomy`
                          : `worker:${opts.workerId}`,
                    },
                    { priority: "high" },
                  );
                }
              }

              if (shouldEmitDirectSessionJobEvent({ ok: result.ok, statusPersistedToServer })) {
                const eventCmd = result.ok
                  ? {
                      type: "job_completed" as const,
                      payload: {
                        jobId: job.id,
                        summary: result.summary,
                        origin: jobOrigin,
                        artifacts: result.stdout
                          ? [{ kind: "log" as const, text: result.stdout }]
                          : undefined,
                      },
                      from:
                        jobOrigin === "autonomy"
                          ? `worker:${opts.workerId}/autonomy`
                          : `worker:${opts.workerId}`,
                    }
                  : {
                      type: "job_failed" as const,
                      payload: {
                        jobId: job.id,
                        message: result.summary,
                        detail: redactSensitiveText(result.stderr ?? ""),
                        origin: jobOrigin,
                      },
                      from:
                        jobOrigin === "autonomy"
                          ? `worker:${opts.workerId}/autonomy`
                          : `worker:${opts.workerId}`,
                    };

                await transport.queueSessionCommand(job.sessionId, eventCmd, {
                  priority: "high",
                });
              }
            }
          } finally {
            clearInterval(busyHeartbeat);
            if (jobProgressTimer) clearInterval(jobProgressTimer);
            if (recycleWorkerAfterJob) {
              runtimeState.shutdownRequested = true;
              const forceExitTimer = setTimeout(() => {
                console.warn(
                  `[WorkerPals] Forcing worker recycle ${CODEX_UNAVAILABLE_WORKER_FORCE_EXIT_MS}ms after Codex backend failure.`,
                );
                process.exit(CODEX_UNAVAILABLE_WORKER_EXIT_CODE);
              }, CODEX_UNAVAILABLE_WORKER_FORCE_EXIT_MS);
              try {
                await maybeHeartbeat("offline", null, true);
                if (directWorktreePath) {
                  await removeIsolatedWorktree(opts.repo, directWorktreePath).catch((err) => {
                    console.error(
                      `[WorkerPals] Failed to remove isolated worktree before Codex recycle: ${String(
                        err,
                      )}`,
                    );
                  });
                  directWorktreePath = null;
                }
                await shutdownDockerExecutorBeforeCodexRecycle(dockerExecutor);
              } finally {
                clearTimeout(forceExitTimer);
                process.exit(CODEX_UNAVAILABLE_WORKER_EXIT_CODE);
              }
            }
            if (job.sessionId && result?.cooldownMs && result.cooldownMs > 0) {
              await transport.queueSessionCommand(
                job.sessionId,
                {
                  type: "assistant_message",
                  payload: {
                    text: `WorkerPal is cooling down for ${formatDurationMs(result.cooldownMs)} after transient infrastructure failures.`,
                  },
                  from: `worker:${opts.workerId}`,
                },
                { priority: "high" },
              );
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
            runtimeState.currentJobId = null;
            runtimeState.currentSessionId = null;
            if (directWorktreePath) {
              await removeIsolatedWorktree(opts.repo, directWorktreePath).catch((err) => {
                console.error(`[WorkerPals] Failed to remove isolated worktree: ${String(err)}`);
              });
            }
          }
        }
      }
    } catch (err) {
      if (runtimeState.shutdownRequested) break;
      console.error(`[WorkerPals] Poll error:`, err);
      await maybeHeartbeat("error", null, true);
    }

    if (runtimeState.shutdownRequested) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, opts.pollMs));
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const llmConfig = workerLlmConfig(CONFIG);
  opts.gitToken = await resolveWorkerGitToken(opts.repo, opts.gitToken);

  console.log(`[WorkerPals] PushPals WorkerPals Daemon (${opts.workerId})`);
  console.log(`[WorkerPals] Server: ${opts.server}`);
  console.log(`[WorkerPals] Repo: ${opts.repo}`);
  console.log(
    `[WorkerPals] Worker LLM: model=${llmConfig.model} provider=${llmConfig.provider} baseUrl=${llmConfig.baseUrl || "(unset)"}`,
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
        config: CONFIG,
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
      } else if (!CONFIG.workerpals.skipDockerSelfCheck) {
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

  const runtimeState: WorkerRuntimeState = {
    currentJobId: null,
    currentSessionId: null,
    shutdownRequested: false,
  };
  const headers = buildWorkerHeaders(opts.authToken);
  const transport = new WorkerServerTransport({
    server: opts.server,
    headers,
    workerId: opts.workerId,
    pollMs: opts.pollMs,
    heartbeatMs: opts.heartbeatMs,
    staleClaimTtlMs: CONFIG.server.staleClaimTtlMs,
  });
  let shutdownTriggered = false;
  const shutdownAndExit = (signalName: string, code: number) => {
    if (shutdownTriggered) return;
    shutdownTriggered = true;
    runtimeState.shutdownRequested = true;
    console.warn(`[WorkerPals] Shutdown signal received (${signalName}); draining active work...`);

    const withTimeout = async (promise: Promise<unknown>, timeoutMs = 3_000) => {
      await Promise.race([
        promise.catch(() => undefined),
        new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs)),
      ]);
    };

    void (async () => {
      await withTimeout(
        transport.sendHeartbeat({
          status: "offline",
          currentJobId: runtimeState.currentJobId ?? null,
          capabilities: {
            docker: opts.docker,
            labels: opts.labels,
            executor: resolveExecutor(CONFIG),
            requireDocker: opts.requireDocker,
          },
          details: {
            repo: opts.repo,
            baseRef: opts.worktreeBaseRef,
            dockerImage: opts.docker ? opts.dockerImage : null,
            dockerNetworkMode: opts.docker ? opts.dockerNetworkMode : null,
          },
        }),
      );
      await withTimeout(
        failActiveJobOnShutdown(opts, headers, runtimeState, transport, signalName),
      );
      await withTimeout(transport.flush());
      if (dockerExecutor) {
        await withTimeout(
          dockerExecutor.shutdown().catch((err) => {
            console.error(`[WorkerPals] Docker shutdown cleanup failed: ${String(err)}`);
          }),
          10_000,
        );
      }
      process.exit(code);
    })();
  };

  process.once("SIGINT", () => shutdownAndExit("SIGINT", 130));
  process.once("SIGTERM", () => shutdownAndExit("SIGTERM", 143));
  if (process.platform === "win32") {
    process.once("SIGBREAK", () => shutdownAndExit("SIGBREAK", 131));
  }
  process.once("exit", () => {
    runtimeState.shutdownRequested = true;
    if (shutdownTriggered) return;
    shutdownTriggered = true;
    if (dockerExecutor) {
      void dockerExecutor.shutdown().catch((err) => {
        console.error(`[WorkerPals] Docker shutdown cleanup failed: ${String(err)}`);
      });
    }
  });

  const requestWorkerRestart = (reason: string) => {
    if (shutdownTriggered) return;
    console.error(`[WorkerPals] Control plane unhealthy: ${reason}. Recycling worker.`);
    shutdownAndExit("CONTROL_PLANE_UNHEALTHY", 91);
  };

  workerLoop(opts, dockerExecutor, runtimeState, transport, requestWorkerRestart).catch((err) => {
    console.error("[WorkerPals] Fatal:", err);
    process.exit(1);
  });
}

main();
