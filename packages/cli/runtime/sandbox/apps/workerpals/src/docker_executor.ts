/**
 * DockerExecutor - Runs jobs inside Docker containers with git worktree isolation
 *
 * This executor:
 * 1. Creates isolated git worktrees for each job
 * 2. Runs jobs in a warm Docker container mounting the repo root
 * 3. Parses structured output from the container
 * 4. Cleans up worktrees after execution
 *
 * Architecture:
 *   HOST: Worker daemon → git worktree add → docker exec (warm container) → git worktree remove
 *   CONTAINER: job_runner.ts → executeJob → git commit/push → ___RESULT___
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, relative, resolve } from "path";
import { loadPushPalsConfig } from "shared";
import { resolveExecutor, type WorkerpalsRuntimeConfig } from "./common/executor_backend.js";
import type { ExecutorBackend, JobDiagnostics } from "./common/types.js";
import { computeTimeoutWarningWindow, DEFAULT_DOCKER_TIMEOUT_MS } from "./timeout_policy.js";
import {
  BACKEND_DOCKER_PASSTHROUGH_ENV,
  BACKEND_RUNTIME_CONFIG_KEYS,
  DOCKER_BACKENDS,
  SHARED_DOCKER_PASSTHROUGH_ENV,
  getDockerBackendSpec,
} from "./backends/backend_config.js";
import { forceDeleteWorktreePath } from "./common/worktree_cleanup.js";
import type {
  DockerBackendRuntimeConfig,
  DockerBackendSpec,
  DockerWarmShellResult,
  DockerWarmStartupContext,
} from "./backends/types.js";
import { resolveFreshWorktreeBaseRef } from "./worktree_base_ref.js";

const DEFAULT_OPENHANDS_MODEL = "local-model";
const DEFAULT_CONFIG = loadPushPalsConfig();
const SHARED_CONTAINER_VENV_PYTHON = "/workspace/.venv/bin/python";
const WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL = "pushpals.runtime_tag";
const WORKERPAL_SANDBOX_COMPONENT_LABEL = "pushpals.component=workerpals-sandbox";
const DOCKER_IMAGE_INSPECT_TIMEOUT_MS = 15_000;
const DOCKER_IMAGE_BUILD_TIMEOUT_MS = 10 * 60_000;
const DOCKER_IMAGE_PULL_TIMEOUT_MS = 10 * 60_000;
const BROWSER_VALIDATION_JOB_REPAIR_ATTEMPTS = 3;
const BROWSER_VALIDATION_JOB_OVERHEAD_MS = 5 * 60_000;
const BROWSER_VALIDATION_JOB_MIN_TIMEOUT_MS = 20 * 60_000;
const BROWSER_VALIDATION_JOB_MAX_TIMEOUT_MS = 45 * 60_000;

function parseClampedInt(value: unknown, defaultValue: number, min: number, max: number): number {
  const parsed =
    typeof value === "number"
      ? Math.floor(value)
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

function parseClampedIntAllowZero(value: unknown, defaultValue: number, max: number): number {
  const parsed =
    typeof value === "number"
      ? Math.floor(value)
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return Math.max(0, Math.min(max, parsed));
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function resolveDockerExecutable(): string {
  const absolute = String(process.env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? "").trim();
  if (absolute) return absolute;
  const configured = String(process.env.PUSHPALS_DOCKER_BIN ?? "").trim();
  if (configured) return configured;
  return process.platform === "win32" ? "docker.exe" : "docker";
}

function resolveWorkerpalSandboxBuildContext(repoRoot: string): {
  root: string;
  dockerfilePath: string;
} {
  const configuredRoot = String(process.env.PUSHPALS_WORKERPALS_SANDBOX_ROOT ?? "").trim();
  const sandboxRoot = configuredRoot || repoRoot;
  const dockerfilePath = configuredRoot
    ? resolve(sandboxRoot, "apps", "workerpals", "Dockerfile.sandbox")
    : resolve(repoRoot, "apps", "workerpals", "Dockerfile.sandbox");
  return {
    root: sandboxRoot,
    dockerfilePath,
  };
}

function resolveWorkerpalRuntimeTag(): string {
  return String(process.env.PUSHPALS_RUNTIME_TAG ?? "").trim();
}

function dockerBuildFileArg(root: string, dockerfilePath: string): string {
  const relativePath = relative(root, dockerfilePath).replace(/\\/g, "/").trim();
  return relativePath || "apps/workerpals/Dockerfile.sandbox";
}

function isMissingDockerImageDetail(detail: string): boolean {
  const text = String(detail ?? "");
  return (
    /\b(no such object|no such image|not found)\b/i.test(text) ||
    /\bunable to find image\b.*\blocally\b/i.test(text) ||
    /\bpull access denied\b.*\brepository does not exist\b/i.test(text)
  );
}

type ParsedWorktreeRecord = {
  path: string;
  detached: boolean;
  prunable: boolean;
};

function normalizePathForMatching(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function isEphemeralWorkerWorktreePath(path: string): boolean {
  const normalized = normalizePathForMatching(path);
  const marker = "/.worktrees/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return false;
  const leaf = normalized.slice(markerIndex + marker.length);
  return leaf.startsWith("job-") || leaf.startsWith("selfcheck-");
}

export function parseGitWorktreeListPorcelain(output: string): ParsedWorktreeRecord[] {
  const blocks = output
    .split(/\r?\n\r?\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
  const records: ParsedWorktreeRecord[] = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/g).map((line) => line.trim());
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine) continue;
    records.push({
      path: pathLine.slice("worktree ".length).trim(),
      detached: lines.includes("detached"),
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
    });
  }

  return records;
}

export function collectPrunableEphemeralWorktrees(output: string): string[] {
  return parseGitWorktreeListPorcelain(output)
    .filter((entry) => entry.prunable && isEphemeralWorkerWorktreePath(entry.path))
    .map((entry) => entry.path);
}

function normalizeMergeConflictHeadRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withoutRefs = trimmed.replace(/^refs\/heads\//, "");
  const withoutOrigin = withoutRefs.replace(/^origin\//, "");
  const normalized = withoutOrigin
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized) return null;
  if (
    normalized.includes("..") ||
    normalized.includes("@{") ||
    normalized.endsWith(".") ||
    normalized.endsWith(".lock")
  ) {
    return null;
  }
  if (/[~^:?*\[\]\s]/.test(normalized)) return null;
  return normalized;
}

export class DockerExecutionExhaustedError extends Error {
  readonly cooldownMs: number;
  readonly category: "warm_setup" | "job_execution";

  constructor(category: "warm_setup" | "job_execution", message: string, cooldownMs: number) {
    super(message);
    this.name = "DockerExecutionExhaustedError";
    this.category = category;
    this.cooldownMs = Math.max(0, Math.floor(cooldownMs));
  }
}

export interface DockerExecutorOptions {
  /** Path to the git repository on the host */
  repo: string;
  /** Worker ID for naming */
  workerId: string;
  /** Docker image to use */
  imageName: string;
  /** Git token for pushing from container */
  gitToken?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Idle shutdown timeout for the warm container in milliseconds */
  idleTimeoutMs?: number;
  /** Git ref used as the base for per-job worktrees */
  baseRef?: string;
  /** Docker network mode for warm container (e.g. bridge, none) */
  networkMode?: string;
  /** Shared runtime config loaded by worker entrypoint */
  config?: WorkerpalsRuntimeConfig;
}

export interface DockerJobResult {
  ok: boolean;
  summary: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  cooldownMs?: number;
  publishBlocked?: {
    summary: string;
    detail: string;
    publicBranch: string;
    localRef: string;
    sha: string;
    stage: "sync" | "push";
  };
  commit?: {
    branch: string;
    sha: string;
  };
  diagnostics?: JobDiagnostics;
}

export interface Job {
  id: string;
  taskId: string;
  kind: string;
  params: Record<string, unknown>;
  sessionId: string;
}

function compactDockerDiagnosticText(value: unknown, maxChars = 1000): string | null {
  const text = String(value ?? "")
    .replace(/\s+$/g, "")
    .trim();
  if (!text) return null;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function dockerFallbackDiagnostics(
  summary: string,
  context: { timedOutByDocker: boolean; elapsedMs: number; timeoutMs: number },
  exitCode: number,
  failureClass: string,
  metadata: Record<string, unknown> = {},
): JobDiagnostics {
  return {
    terminal: {
      failureClass,
      terminalStage: "docker",
      summary: compactDockerDiagnosticText(summary),
      watchdogFired: context.timedOutByDocker,
      timeoutMs: context.timeoutMs,
      metadata: {
        structuredResult: false,
        elapsedMs: context.elapsedMs,
        exitCode,
        timedOutByDocker: context.timedOutByDocker,
        ...metadata,
      },
    },
  };
}

function readPositiveNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function maybeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isReadableByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return value instanceof ReadableStream;
}

function collectValidationCommandHints(params: Record<string, unknown>): string[] {
  const planning = maybeRecord(params.planning);
  const values: unknown[] = [
    params.instruction,
    params.plannerWorkerInstruction,
    params.validationSteps,
    params.requiredValidationSteps,
    planning?.validationSteps,
    planning?.requiredValidationSteps,
  ];
  const commands: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      commands.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      commands.push(...value.filter((entry): entry is string => typeof entry === "string"));
    }
  }
  return commands;
}

function hasBrowserValidationCommand(job: Pick<Job, "kind" | "params">): boolean {
  if (job.kind !== "task.execute") return false;
  return collectValidationCommandHints(job.params).some((command) =>
    /\b(web:e2e|e2e:web|browser:e2e|smoke:web|web:smoke|browser:smoke|playwright|cypress)\b/i.test(
      command,
    ),
  );
}

export function resolveDockerJobTimeoutMs(
  configuredTimeoutMs: number,
  job: Pick<Job, "kind" | "params">,
): number {
  const baseTimeoutMs = Math.max(10_000, Math.floor(configuredTimeoutMs));
  if (!hasBrowserValidationCommand(job)) return baseTimeoutMs;

  const planning = maybeRecord(job.params.planning);
  const executionBudgetMs = readPositiveNumber(planning?.executionBudgetMs) ?? 1_200_000;
  const finalizationBudgetMs = readPositiveNumber(planning?.finalizationBudgetMs) ?? 120_000;
  const attempts = BROWSER_VALIDATION_JOB_REPAIR_ATTEMPTS + 1; // initial attempt plus repairs
  const estimatedTimeoutMs =
    attempts * (executionBudgetMs + finalizationBudgetMs + BROWSER_VALIDATION_JOB_OVERHEAD_MS);
  const boundedTimeoutMs = Math.min(
    BROWSER_VALIDATION_JOB_MAX_TIMEOUT_MS,
    Math.max(BROWSER_VALIDATION_JOB_MIN_TIMEOUT_MS, estimatedTimeoutMs),
  );
  return Math.max(Math.min(baseTimeoutMs, boundedTimeoutMs), BROWSER_VALIDATION_JOB_MIN_TIMEOUT_MS);
}

export class DockerExecutor {
  private options: Required<Omit<DockerExecutorOptions, "config">>;
  private worktreeDir: string;
  private warmContainerName: string;
  private warmAgentPort = 39231;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeJobs = 0;
  private readonly warmAgentStartupTimeoutMs: number;
  private readonly warmAgentStartupPollMs: number = 200;
  private readonly warmSetupMaxAttempts: number;
  private readonly warmSetupBackoffMs: number;
  private readonly jobRetryMaxAttempts: number;
  private readonly jobRetryBackoffMs: number;
  private readonly failureCooldownMs: number;
  private readonly worktreeVisibilityTimeoutMs: number;
  private lastLoggedExecutionConfig = "";
  private lastLoggedEndpointRewrite = "";
  private warmedBackends = new Set<string>();
  private preparedMergeConflictJobs = new Set<string>();
  private mergeConflictRefreshPromise: Promise<void> | null = null;
  private readonly config: WorkerpalsRuntimeConfig;

  constructor(options: DockerExecutorOptions) {
    const { config, ...optionValues } = options;
    this.config = config ?? DEFAULT_CONFIG;
    const startupTimeoutMs = parseClampedInt(
      this.config.workerpals.dockerAgentStartupTimeoutMs,
      45_000,
      10_000,
      180_000,
    );

    this.options = {
      gitToken: "",
      // Keep headroom above backend wrapper timeout so the wrapper can emit
      // a structured timeout failure before Docker hard-kills the job.
      timeoutMs: DEFAULT_DOCKER_TIMEOUT_MS,
      idleTimeoutMs: 10 * 60 * 1000,
      baseRef: "HEAD",
      networkMode: "bridge",
      ...optionValues,
    };
    this.worktreeDir = resolve(this.options.repo, ".worktrees");
    this.warmContainerName = `pushpals-${this.options.workerId}-warm`;
    this.warmAgentStartupTimeoutMs = startupTimeoutMs;
    this.warmSetupMaxAttempts = parseClampedInt(
      this.config.workerpals.dockerWarmMaxAttempts,
      3,
      1,
      5,
    );
    this.warmSetupBackoffMs = parseClampedInt(
      this.config.workerpals.dockerWarmRetryBackoffMs,
      2_000,
      250,
      60_000,
    );
    this.jobRetryMaxAttempts = parseClampedInt(
      this.config.workerpals.dockerJobMaxAttempts,
      2,
      1,
      3,
    );
    this.jobRetryBackoffMs = parseClampedInt(
      this.config.workerpals.dockerJobRetryBackoffMs,
      3_000,
      250,
      60_000,
    );
    this.failureCooldownMs = parseClampedIntAllowZero(
      this.config.workerpals.failureCooldownMs,
      20_000,
      300_000,
    );
    this.worktreeVisibilityTimeoutMs = process.platform === "win32" ? 15_000 : 5_000;

    // Ensure worktrees directory exists
    try {
      mkdirSync(this.worktreeDir, { recursive: true });
    } catch {
      // Directory may already exist
    }
  }

  /**
   * Execute a job in a Docker container with an isolated git worktree
   */
  async execute(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<DockerJobResult> {
    this.activeJobs += 1;
    this.clearIdleTimer();
    const worktreeName = this.buildEphemeralWorktreeName("job", job.id);
    const worktreePath = resolve(this.worktreeDir, worktreeName);

    try {
      const worktreeBaseRef = await this.resolveWorktreeBaseRefForJob(job, onLog);
      // Step 1: Create isolated git worktree
      await this.createWorktree(worktreePath, worktreeBaseRef);

      // Step 2: Prepare job spec as base64
      const jobSpec = {
        jobId: job.id,
        taskId: job.taskId,
        kind: job.kind,
        params: job.params,
        workerId: this.options.workerId,
      };
      const base64Spec = Buffer.from(JSON.stringify(jobSpec)).toString("base64");

      // Step 3: Run Docker container with the worktree mounted
      for (let attempt = 1; attempt <= this.jobRetryMaxAttempts; attempt++) {
        const attemptStartedAtMs = Date.now();
        try {
          this.logExecutionConfig();
          const result = await this.runInWarmContainer(worktreePath, base64Spec, job, onLog);
          if (result.ok) return result;

          const retryableFailure = this.isRetryableJobFailure(result);
          const attemptElapsedMs = Math.max(1, Date.now() - attemptStartedAtMs);
          const timeoutMs = resolveDockerJobTimeoutMs(this.options.timeoutMs, job);
          const hasBudgetForRetry =
            retryableFailure &&
            attempt < this.jobRetryMaxAttempts &&
            this.hasBudgetForJobRetry(attempt, attemptElapsedMs, timeoutMs, onLog);
          if (attempt >= this.jobRetryMaxAttempts || !retryableFailure || !hasBudgetForRetry) {
            if (
              retryableFailure &&
              attempt >= this.jobRetryMaxAttempts &&
              this.retryExhaustionCooldownMs(result) > 0
            ) {
              return {
                ...result,
                cooldownMs: this.retryExhaustionCooldownMs(result),
              };
            }
            return result;
          }

          const retryInMs = this.backoffDelayMs(this.jobRetryBackoffMs, attempt);
          const note = `[DockerExecutor] Transient job failure detected for ${job.id}; retrying attempt ${
            attempt + 1
          }/${this.jobRetryMaxAttempts} in ${retryInMs}ms.`;
          console.warn(note);
          onLog?.("stderr", note);
          await this.stopWarmContainer("job retry after transient failure", true);
          await this.sleep(retryInMs);
        } catch (err) {
          const retryableError = this.isRetryableError(err);
          const attemptElapsedMs = Math.max(1, Date.now() - attemptStartedAtMs);
          const timeoutMs = resolveDockerJobTimeoutMs(this.options.timeoutMs, job);
          const hasBudgetForRetry =
            retryableError &&
            attempt < this.jobRetryMaxAttempts &&
            this.hasBudgetForJobRetry(attempt, attemptElapsedMs, timeoutMs, onLog);
          if (attempt >= this.jobRetryMaxAttempts || !retryableError || !hasBudgetForRetry) {
            if (
              retryableError &&
              attempt >= this.jobRetryMaxAttempts &&
              !(err instanceof DockerExecutionExhaustedError)
            ) {
              throw new DockerExecutionExhaustedError(
                "job_execution",
                `Docker execution retries exhausted after ${this.jobRetryMaxAttempts} attempts: ${this.compactError(
                  err,
                )}`,
                this.failureCooldownMs,
              );
            }
            throw err;
          }
          const retryInMs = this.backoffDelayMs(this.jobRetryBackoffMs, attempt);
          const note = `[DockerExecutor] Transient Docker execution error for ${job.id}: ${this.compactError(
            err,
          )}. Retrying attempt ${attempt + 1}/${this.jobRetryMaxAttempts} in ${retryInMs}ms.`;
          console.warn(note);
          onLog?.("stderr", note);
          await this.stopWarmContainer("job retry after execution error", true);
          await this.sleep(retryInMs);
        }
      }

      return {
        ok: false,
        summary: "Docker job retries exhausted",
        stderr: `Retries exhausted after ${this.jobRetryMaxAttempts} attempts`,
      };
    } finally {
      this.preparedMergeConflictJobs.delete(job.id);
      this.activeJobs = Math.max(0, this.activeJobs - 1);
      // Step 4: Clean up worktree (always cleanup)
      await this.removeWorktree(worktreePath).catch((err) => {
        console.error(`[DockerExecutor] Failed to remove worktree: ${err}`);
      });
      this.scheduleIdleShutdown();
    }
  }

  /**
   * Validate that a host-created worktree is usable by git inside the Linux
   * worker container. This catches host/container path mapping issues early.
   */
  async validateWorktreeGitInterop(): Promise<void> {
    const worktreeName = this.buildEphemeralWorktreeName("selfcheck", "startup");
    const worktreePath = resolve(this.worktreeDir, worktreeName);

    try {
      await this.createWorktree(worktreePath, this.options.baseRef);
      await this.runGitSelfCheckContainer(worktreePath);
      await this.ensureWorktreeAccessibleInWarmContainer(worktreePath);
      console.log(
        `[DockerExecutor] Startup self-check passed (git/worktree in container and warm container).`,
      );
    } finally {
      await this.removeWorktree(worktreePath).catch(() => {
        // Ignore cleanup failures for startup self-check artifacts.
      });
    }
  }

  /**
   * Create a git worktree for isolated job execution
   */
  private async createWorktree(worktreePath: string, baseRef: string): Promise<void> {
    await this.ensureFreshWorktreePath(worktreePath);

    // Create worktree from configured base ref (detached)
    let proc = Bun.spawn(["git", "worktree", "add", "--detach", worktreePath, baseRef], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    let exitCode = await proc.exited;
    let stdout = await new Response(proc.stdout).text();
    let stderr = await new Response(proc.stderr).text();
    let detail = [stderr, stdout].filter(Boolean).join("\n").trim();

    if (exitCode !== 0 && /already registered worktree/i.test(detail)) {
      const prune = Bun.spawn(["git", "worktree", "prune"], {
        cwd: this.options.repo,
        stdout: "pipe",
        stderr: "pipe",
      });
      await prune.exited;

      proc = Bun.spawn(["git", "worktree", "add", "--force", "--detach", worktreePath, baseRef], {
        cwd: this.options.repo,
        stdout: "pipe",
        stderr: "pipe",
      });
      exitCode = await proc.exited;
      stdout = await new Response(proc.stdout).text();
      stderr = await new Response(proc.stderr).text();
      detail = [stderr, stdout].filter(Boolean).join("\n").trim();
    }

    if (exitCode !== 0) {
      throw new Error(`Failed to create worktree from ${baseRef}: ${detail}`);
    }

    this.rewriteWorktreeGitdirToRelative(worktreePath);

    console.log(`[DockerExecutor] Created worktree: ${worktreePath}`);
  }

  /**
   * On Windows hosts, git worktree writes an absolute Windows path into
   * `<worktree>/.git` (e.g. `C:/.../.git/worktrees/...`). That path is not
   * valid inside Linux containers. Rewrite to a relative gitdir so both host
   * and container can resolve it.
   */
  private rewriteWorktreeGitdirToRelative(worktreePath: string): void {
    try {
      const gitFilePath = resolve(worktreePath, ".git");
      const raw = readFileSync(gitFilePath, "utf-8").trim();
      const match = raw.match(/^gitdir:\s*(.+)$/i);
      if (!match) return;

      const gitdirRaw = match[1].trim();
      const hasWindowsDrive = /^[a-zA-Z]:[\\/]/.test(gitdirRaw);
      if (!hasWindowsDrive && !isAbsolute(gitdirRaw)) {
        return;
      }

      const rel = relative(worktreePath, gitdirRaw).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..") === false) {
        return;
      }

      writeFileSync(gitFilePath, `gitdir: ${rel}\n`, "utf-8");
    } catch {
      // Best-effort normalization; if this fails, git commands will surface
      // a concrete error during execution.
    }
  }

  /**
   * Remove a git worktree
   */
  private async removeWorktree(worktreePath: string): Promise<void> {
    // Remove worktree
    const proc = Bun.spawn(["git", "worktree", "remove", "--force", "--force", worktreePath], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    if (exitCode !== 0) {
      console.warn(`[DockerExecutor] Worktree removal warning: ${stderr || stdout}`);
    }

    // Also prune worktree list
    const prune = Bun.spawn(["git", "worktree", "prune"], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    const pruneExit = await prune.exited;
    if (pruneExit !== 0) {
      const pruneStderr = await new Response(prune.stderr).text();
      console.warn(`[DockerExecutor] Worktree prune warning: ${pruneStderr}`);
    }

    const forced = await forceDeleteWorktreePath(worktreePath, {
      sleepFn: (ms) => this.sleep(ms),
    });
    if (!forced.removed) {
      throw new Error(
        `worktree path persisted after cleanup (${worktreePath})${forced.lastError ? `: ${forced.lastError}` : ""}`,
      );
    }

    console.log(`[DockerExecutor] Removed worktree: ${worktreePath}`);
  }

  /**
   * Run the Docker container and parse output
   */
  private containerBackendPython(
    backend: ExecutorBackend,
    runtimeConfig: DockerBackendRuntimeConfig = this.backendRuntimeConfig(),
  ): string {
    const spec = getDockerBackendSpec(backend);
    const configured = spec.configuredPython(runtimeConfig);
    return spec.normalizeContainerPython(configured, SHARED_CONTAINER_VENV_PYTHON);
  }

  private backendRuntimeConfig(): DockerBackendRuntimeConfig {
    const workerCfg = this.config.workerpals as Record<string, unknown>;
    const runtimeConfig: DockerBackendRuntimeConfig = {};
    for (const backend of DOCKER_BACKENDS) {
      const keys = BACKEND_RUNTIME_CONFIG_KEYS[backend.name] ?? {
        pythonKey: `${backend.name}Python`,
        timeoutKey: `${backend.name}TimeoutMs`,
      };
      const python = String(workerCfg[keys.pythonKey] ?? "python").trim() || "python";
      const timeoutRaw = Number(workerCfg[keys.timeoutKey]);
      const timeoutMs = Number.isFinite(timeoutRaw)
        ? Math.max(10_000, Math.floor(timeoutRaw))
        : 300_000;
      runtimeConfig[backend.name] = { python, timeoutMs };
    }
    return runtimeConfig;
  }

  private currentBackend(): ExecutorBackend {
    return resolveExecutor(this.config);
  }

  private currentBackendSpec(): DockerBackendSpec {
    return getDockerBackendSpec(this.currentBackend());
  }

  private warmStartupContext(): DockerWarmStartupContext {
    const { attempts, sleepSeconds } = this.warmAgentStartupLoop();
    return {
      sharedVenvPython: SHARED_CONTAINER_VENV_PYTHON,
      warmAgentPort: this.warmAgentPort,
      startupAttempts: attempts,
      sleepSeconds,
    };
  }

  private collectContainerEnv(): string[] {
    const containerLlmEndpoint = this.workerLlmEndpointForContainer();
    const runtimeConfig = this.backendRuntimeConfig();
    const fixedEnv: Record<string, string> = {
      WORKERPALS_EXECUTOR: this.config.workerpals.executor,
      WORKERPALS_LLM_MODEL: this.config.workerpals.llm.model,
      WORKERPALS_LLM_ENDPOINT: containerLlmEndpoint,
      WORKERPALS_LLM_BACKEND: this.config.workerpals.llm.backend,
      WORKERPALS_LLM_SESSION_ID: this.config.workerpals.llm.sessionId,
      PUSHPALS_PROJECT_ROOT_OVERRIDE: "/repo",
      PUSHPALS_REPO_ROOT_OVERRIDE: "/repo",
      PUSHPALS_CONFIG_DIR_OVERRIDE: "/workspace/configs",
      PUSHPALS_PROMPTS_ROOT_OVERRIDE: "/workspace",
      PUSHPALS_PROTOCOL_SCHEMAS_DIR: "/workspace/protocol/schemas",
    };
    for (const backend of DOCKER_BACKENDS) {
      const name = backend.name.toUpperCase();
      fixedEnv[`WORKERPALS_${name}_PYTHON`] = this.containerBackendPython(
        backend.name,
        runtimeConfig,
      );
      fixedEnv[`WORKERPALS_${name}_TIMEOUT_MS`] = String(backend.timeoutMs(runtimeConfig));
    }
    if (this.config.workerpals.llm.apiKey.trim()) {
      fixedEnv.WORKERPALS_LLM_API_KEY = this.config.workerpals.llm.apiKey;
    }

    const allowlist = new Set<string>(SHARED_DOCKER_PASSTHROUGH_ENV);
    for (const backend of DOCKER_BACKENDS) {
      const names = BACKEND_DOCKER_PASSTHROUGH_ENV[backend.name] ?? [];
      for (const name of names) allowlist.add(name);
    }

    const pairs: string[] = [];
    for (const [key, value] of Object.entries(fixedEnv)) {
      if (!value) continue;
      pairs.push("-e", `${key}=${value}`);
    }
    for (const key of allowlist) {
      const value = process.env[key];
      if (!value) continue;
      pairs.push("-e", `${key}=${value}`);
    }
    return pairs;
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private warmAgentStartupLoop(): { attempts: number; sleepSeconds: string } {
    const attempts = Math.max(
      1,
      Math.ceil(this.warmAgentStartupTimeoutMs / this.warmAgentStartupPollMs),
    );
    const sleepSeconds = String(this.warmAgentStartupPollMs / 1000);
    return { attempts, sleepSeconds };
  }

  private scheduleIdleShutdown(): void {
    if (this.options.idleTimeoutMs <= 0) return;
    if (this.activeJobs > 0) return;

    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.activeJobs > 0) return;
      void this.stopWarmContainer("idle timeout");
    }, this.options.idleTimeoutMs);
  }

  private async startWarmContainer(): Promise<void> {
    await this.stopWarmContainer("pre-start cleanup", true);
    const backend = this.currentBackend();
    const backendSpec = getDockerBackendSpec(backend);
    const warmContext = this.warmStartupContext();
    const dockerRepoPath = this.toDockerPath(this.options.repo);
    const envArgs = this.collectContainerEnv();
    const authMountArgs = this.openaiCodexAuthMountArgs(backend);
    const args: string[] = [
      "run",
      "-d",
      "--name",
      this.warmContainerName,
      "--label",
      "pushpals.component=workerpals-warm",
      "--label",
      `pushpals.repo=${this.options.repo}`,
      "--label",
      `pushpals.worker_id=${this.options.workerId}`,
      "--memory",
      `${this.config.workerpals.dockerWarmMemoryMb}m`,
      "--cpus",
      String(this.config.workerpals.dockerWarmCpus),
      "--network",
      this.options.networkMode,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      `${dockerRepoPath}:/repo`,
      "-w",
      // Keep agent-server runtime artifacts off the host-mounted repo path.
      "/workspace",
      ...envArgs,
      ...authMountArgs,
    ];

    if (this.options.gitToken) {
      args.push("-e", `GIT_TOKEN=${this.options.gitToken}`);
    }
    const backendEnv = backendSpec.warmContainerEnv?.(warmContext) ?? {};
    for (const [key, value] of Object.entries(backendEnv)) {
      if (!value) continue;
      args.push("-e", `${key}=${value}`);
    }

    const startupCmd = backendSpec.warmContainerStartupCommand(warmContext);

    args.push("--entrypoint", "/bin/sh", this.options.imageName, "-lc", startupCmd);

    const proc = Bun.spawn([resolveDockerExecutable(), ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `Failed to start warm container (exit ${exitCode}): ${
          stderr.trim() || stdout.trim() || "no docker output"
        }`,
      );
    }
    console.log(`[DockerExecutor] Warm container started: ${this.warmContainerName}`);
  }

  private openaiCodexAuthMountArgs(backend: ExecutorBackend): string[] {
    if (backend !== "openai_codex") return [];

    const hostCodexHomeRaw = (process.env.PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME || "").trim();
    if (hostCodexHomeRaw && !isAbsolute(hostCodexHomeRaw)) {
      console.warn(
        `[DockerExecutor] Ignoring relative PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME=${hostCodexHomeRaw}; using ${resolve(
          homedir(),
          ".codex",
        )} so Codex state stays outside the repo worktree.`,
      );
    }
    const hostCodexHome = (
      hostCodexHomeRaw && isAbsolute(hostCodexHomeRaw)
        ? hostCodexHomeRaw
        : resolve(homedir(), ".codex")
    ).trim();
    if (!hostCodexHome) return [];

    if (!existsSync(hostCodexHome)) {
      try {
        mkdirSync(hostCodexHome, { recursive: true });
      } catch (err) {
        console.warn(
          `[DockerExecutor] Failed to create Codex auth directory (${hostCodexHome}); skipping mount: ${this.compactError(
            err,
          )}`,
        );
        return [];
      }
    }

    let containerCodexHome = (
      process.env.PUSHPALS_OPENAI_CODEX_CONTAINER_CODEX_HOME || "/root/.codex"
    ).trim();
    if (!containerCodexHome.startsWith("/")) {
      console.warn(
        `[DockerExecutor] Invalid PUSHPALS_OPENAI_CODEX_CONTAINER_CODEX_HOME=${containerCodexHome}; expected absolute path. Using /root/.codex.`,
      );
      containerCodexHome = "/root/.codex";
    }

    const dockerHostPath = this.toDockerPath(hostCodexHome);
    console.log(
      `[DockerExecutor] Mounting Codex auth directory for openai_codex: ${hostCodexHome} -> ${containerCodexHome}`,
    );
    return [
      "-v",
      `${dockerHostPath}:${containerCodexHome}`,
      "-e",
      `CODEX_HOME=${containerCodexHome}`,
    ];
  }

  private async ensureWarmContainer(): Promise<void> {
    const inspect = Bun.spawn(
      [
        resolveDockerExecutable(),
        "inspect",
        "-f",
        "{{.State.Running}}|{{.HostConfig.NetworkMode}}",
        this.warmContainerName,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([
      inspect.exited,
      new Response(inspect.stdout).text(),
    ]);
    if (exitCode === 0) {
      const [runningRaw, networkModeRaw] = stdout.trim().split("|");
      const running = runningRaw?.trim() === "true";
      const networkMode = (networkModeRaw ?? "").trim();
      if (running && networkMode === this.options.networkMode) {
        return;
      }
      if (running && networkMode && networkMode !== this.options.networkMode) {
        console.warn(
          `[DockerExecutor] Warm container network mismatch (${networkMode} != ${this.options.networkMode}); recreating...`,
        );
      }
    }
    await this.startWarmContainer();
  }

  private async runWarmShell(command: string): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const proc = Bun.spawn(
      [resolveDockerExecutable(), "exec", this.warmContainerName, "/bin/sh", "-lc", command],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  }

  private async runWarmWorktreeProbe(containerWorktreePath: string): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const proc = Bun.spawn(
      [
        resolveDockerExecutable(),
        "exec",
        "-w",
        containerWorktreePath,
        this.warmContainerName,
        "/bin/sh",
        "-lc",
        "git rev-parse --is-inside-work-tree && git rev-parse --git-dir",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  }

  private async inspectWarmContainerState(): Promise<string> {
    const proc = Bun.spawn(
      [
        resolveDockerExecutable(),
        "inspect",
        "-f",
        "running={{.State.Running}} status={{.State.Status}} exit={{.State.ExitCode}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} oom={{.State.OOMKilled}}",
        this.warmContainerName,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return exitCode === 0
      ? out || "no inspect output"
      : `docker inspect failed (exit ${exitCode})${out ? `\n${out}` : ""}`;
  }

  private async readWarmContainerLogs(tail = 160): Promise<string> {
    const proc = Bun.spawn(
      [resolveDockerExecutable(), "logs", "--tail", String(tail), this.warmContainerName],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return exitCode === 0
      ? out || "(no docker logs)"
      : `docker logs failed (exit ${exitCode})${out ? `\n${out}` : ""}`;
  }

  private workerLlmProbeUrls(endpoint: string): string[] {
    const normalized = endpoint.trim().replace(/\/+$/, "");
    if (!normalized) return [];
    const probes: string[] = [];
    if (normalized.includes("/v1/chat/completions")) {
      probes.push(normalized.replace(/\/v1\/chat\/completions$/, "/v1/models"));
    } else if (normalized.endsWith("/api/chat")) {
      probes.push(normalized.replace(/\/api\/chat$/, "/api/tags"));
    } else if (normalized.includes("/chat/completions")) {
      probes.push(normalized.replace(/\/chat\/completions$/, "/models"));
    } else if (normalized.endsWith("/v1")) {
      probes.push(`${normalized}/models`);
    } else if (/^https?:\/\/[^/]+$/i.test(normalized)) {
      probes.push(`${normalized}/v1/models`);
      probes.push(`${normalized}/models`);
    }
    if (probes.length === 0) {
      probes.push(normalized);
    }
    try {
      const parsed = new URL(normalized);
      probes.push(`${parsed.origin}/health`);
    } catch {
      // leave parsed probes empty
    }
    return Array.from(new Set(probes));
  }

  private async probeWorkerLlmEndpoint(): Promise<string> {
    const endpoint = (this.config.workerpals.llm.endpoint ?? "").trim();
    if (!endpoint) return "endpoint not configured";
    const probes = this.workerLlmProbeUrls(endpoint);
    if (probes.length === 0) return `endpoint malformed: ${endpoint}`;

    let lastError = "unreachable";
    for (const probe of probes) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("timeout"), 2_500);
      try {
        const response = await fetch(probe, {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "application/json, text/plain, */*" },
        });
        if (response.status >= 200 && response.status < 500) {
          return `reachable via ${probe} (HTTP ${response.status})`;
        }
        lastError = `${probe}: HTTP ${response.status}`;
      } catch (err) {
        lastError = `${probe}: ${String(err)}`;
      } finally {
        clearTimeout(timeout);
      }
    }
    return `UNREACHABLE (${lastError})`;
  }

  private workerLlmEndpointForContainer(): string {
    const raw = (this.config.workerpals.llm.endpoint ?? "").trim();
    if (!raw) return raw;
    try {
      const parsed = new URL(raw);
      const host = (parsed.hostname ?? "").trim().toLowerCase();
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
        return raw;
      }
      parsed.hostname = "host.docker.internal";
      return parsed.toString();
    } catch {
      return raw;
    }
  }

  private async probeWorkerLlmEndpointFromContainer(): Promise<string> {
    const endpoint = this.workerLlmEndpointForContainer();
    if (!endpoint) return "endpoint not configured";
    const probes = this.workerLlmProbeUrls(endpoint);
    if (probes.length === 0) return `endpoint malformed: ${endpoint}`;

    let lastError = "unreachable";
    for (const probe of probes) {
      const cmd =
        `status="$(curl -sS -m 3 -o /dev/null -w "%{http_code}" ${shellSingleQuote(probe)} || true)"; ` +
        'echo "$status"';
      const result = await this.runWarmShell(cmd);
      const status = Number.parseInt(result.stdout.trim(), 10);
      if (Number.isFinite(status) && status >= 200 && status < 500) {
        return `reachable via ${probe} (HTTP ${status})`;
      }
      if (Number.isFinite(status) && status > 0) {
        lastError = `${probe}: HTTP ${status}`;
      } else {
        const detail = result.stderr ? ` (${result.stderr})` : "";
        lastError = `${probe}: exit ${result.exitCode}${detail}`;
      }
    }
    return `UNREACHABLE (${lastError})`;
  }

  private async collectWarmRuntimeDiagnostics(backend: ExecutorBackend): Promise<string> {
    const spec = getDockerBackendSpec(backend);
    const runtimeConfig = this.backendRuntimeConfig();
    const sections: string[] = [];
    const model = this.config.workerpals.llm.model.trim() || DEFAULT_OPENHANDS_MODEL;
    const provider = this.normalizeProvider(this.config.workerpals.llm.backend);
    const endpoint = this.config.workerpals.llm.endpoint.trim() || "(unset)";
    const configuredPython = spec.configuredPython(runtimeConfig).trim() || "(unset)";
    const containerPython = this.containerBackendPython(backend, runtimeConfig);
    const containerEndpoint = this.workerLlmEndpointForContainer();
    sections.push(`[backend] ${backend}`);
    sections.push(`[llm-config] model=${model} provider=${provider} endpoint=${endpoint}`);
    sections.push(
      `[python-config] configured=${configuredPython} resolved_container_python=${containerPython}`,
    );
    if (endpoint && containerEndpoint && endpoint !== containerEndpoint) {
      sections.push(`[llm-endpoint-rewrite] ${endpoint} -> ${containerEndpoint}`);
    }
    sections.push(`[llm-probe-host] ${await this.probeWorkerLlmEndpoint()}`);
    sections.push(`[llm-probe-container] ${await this.probeWorkerLlmEndpointFromContainer()}`);
    sections.push(`[container] ${await this.inspectWarmContainerState()}`);
    sections.push(`[container-logs]\n${await this.readWarmContainerLogs(160)}`);

    const shellProbe = await this.runWarmShell("true");
    if (!shellProbe.ok) {
      const probeOut = [shellProbe.stdout, shellProbe.stderr].filter(Boolean).join("\n");
      sections.push(
        `[container-exec] exit=${shellProbe.exitCode}${probeOut ? `\n${probeOut}` : "\n(no output)"}`,
      );
      return sections.join("\n");
    }

    const checks = spec.diagnosticChecks?.(SHARED_CONTAINER_VENV_PYTHON) ?? [];

    for (const check of checks) {
      const result = await this.runWarmShell(check.command);
      const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
      sections.push(
        `[${check.label}] exit=${result.exitCode}${text ? `\n${text}` : "\n(no output)"}`,
      );
    }
    return sections.join("\n");
  }

  private async stopWarmContainer(reason: string, quiet = false): Promise<void> {
    this.clearIdleTimer();
    const stopProc = Bun.spawn([resolveDockerExecutable(), "rm", "-f", this.warmContainerName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await stopProc.exited;
    if (exitCode === 0) {
      if (!quiet)
        console.log(
          `[DockerExecutor] Warm container stopped (${reason}): ${this.warmContainerName}`,
        );
      return;
    }
    const stderr = (await new Response(stopProc.stderr).text()).trim();
    const notFound = /No such container/i.test(stderr);
    if (!quiet && !notFound) {
      console.error(`[DockerExecutor] Failed to stop warm container: ${stderr}`);
    }
  }

  async shutdown(): Promise<void> {
    await this.stopWarmContainer("worker shutdown", true);
  }

  private async runInWarmContainer(
    worktreePath: string,
    base64Spec: string,
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<DockerJobResult> {
    await this.ensureWarmRuntimeReady(job, onLog);
    const startedAtMs = Date.now();
    const containerWorktreePath = await this.ensureWorktreeAccessibleInWarmContainer(
      worktreePath,
      onLog,
    );
    await this.ensureWorktreeDependencyArtifacts(containerWorktreePath, onLog);

    const args = this.buildWarmContainerExecArgs(containerWorktreePath);

    console.log(
      `[DockerExecutor] Running job in warm container: ${this.warmContainerName} (${this.executionConfigSummary()})`,
    );

    const dockerArgv = [resolveDockerExecutable(), ...args];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(dockerArgv, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      throw new Error(
        `failed to spawn warm-container docker exec (${this.warmContainerName}, cwd=${containerWorktreePath}, argv_chars=${dockerArgv.join("\u0000").length}, spec_chars=${base64Spec.length}): ${this.compactError(
          err,
        )}`,
      );
    }
    const timeoutMs = resolveDockerJobTimeoutMs(this.options.timeoutMs, job);
    if (timeoutMs !== this.options.timeoutMs) {
      const verb = timeoutMs > this.options.timeoutMs ? "Extended" : "Capped";
      const note = `[DockerExecutor] ${verb} job timeout for browser validation convergence: ${timeoutMs}ms (configured ${this.options.timeoutMs}ms).`;
      console.log(note);
      onLog?.("stdout", note);
    }

    const { leadMs: warningLeadMs, delayMs: warningDelayMs } =
      computeTimeoutWarningWindow(timeoutMs);
    const warningTimer = setTimeout(() => {
      const warning = `[DockerExecutor] Job nearing timeout in warm container (${Math.round(
        warningLeadMs / 1000,
      )}s remaining): ${this.warmContainerName}`;
      console.warn(warning);
      onLog?.("stderr", warning);
      onLog?.(
        "stderr",
        "[DockerExecutor] Worker should finish quickly and return a concise failure/update if task cannot complete in time.",
      );
    }, warningDelayMs);

    let timedOutByDocker = false;
    // Set up timeout
    const timer = setTimeout(() => {
      timedOutByDocker = true;
      const elapsedMs = Math.max(1, Date.now() - startedAtMs);
      const timeoutMsg = `[DockerExecutor] Job timeout in warm container after ${elapsedMs}ms (limit ${timeoutMs}ms): ${this.warmContainerName}`;
      console.log(timeoutMsg);
      onLog?.("stderr", timeoutMsg);
      try {
        proc.kill();
        // Reset the warm container to clear any stuck in-container process.
        Bun.spawn([resolveDockerExecutable(), "restart", "-t", "1", this.warmContainerName]);
      } catch {
        // Ignore kill errors
      }
    }, timeoutMs);

    // Process streams
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    try {
      const stdout = proc.stdout;
      const stderr = proc.stderr;
      if (!isReadableByteStream(stdout) || !isReadableByteStream(stderr)) {
        throw new Error("docker exec stdout/stderr pipes were not available");
      }
      await Promise.all([
        this.writeJobSpecToStdin(proc, base64Spec),
        this.readStream(stdout, "stdout", onLog, stdoutLines),
        this.readStream(stderr, "stderr", onLog, stderrLines),
      ]);
    } catch (err) {
      try {
        proc.kill();
      } catch {
        // Ignore cleanup errors after stream setup failures.
      }
      throw new Error(
        `failed while streaming warm-container job execution (${this.warmContainerName}, spec_chars=${base64Spec.length}): ${this.compactError(
          err,
        )}`,
      );
    }

    clearTimeout(warningTimer);
    clearTimeout(timer);
    const exitCode = await proc.exited;
    const elapsedMs = Math.max(1, Date.now() - startedAtMs);

    // Parse result from stdout (look for ___RESULT___ sentinel)
    const result = this.parseResult(stdoutLines, stderrLines, exitCode, {
      timedOutByDocker,
      elapsedMs,
      timeoutMs,
    });

    return result;
  }

  private buildWarmContainerExecArgs(containerWorktreePath: string): string[] {
    return [
      "exec",
      "-i",
      "-w",
      containerWorktreePath,
      this.warmContainerName,
      "bun",
      "run",
      "/workspace/apps/workerpals/src/job_runner.ts",
      "--spec-stdin",
    ];
  }

  private async writeJobSpecToStdin(
    proc: ReturnType<typeof Bun.spawn>,
    base64Spec: string,
  ): Promise<void> {
    const stdin = proc.stdin as
      | WritableStream<Uint8Array>
      | {
          write?: (chunk: Uint8Array | string) => unknown;
          end?: () => unknown;
          flush?: () => unknown;
        }
      | undefined;
    if (!stdin) {
      throw new Error("docker exec stdin pipe was not available");
    }
    const bytes = new TextEncoder().encode(base64Spec);
    if (stdin instanceof WritableStream) {
      const writer = stdin.getWriter();
      try {
        await writer.write(bytes);
        await writer.close();
      } catch (err) {
        try {
          await writer.abort(err);
        } catch {
          // Ignore abort failures; the original write error is more useful.
        }
        throw err;
      }
      return;
    }

    const nodeStdin = stdin as {
      write?: (chunk: Uint8Array | string) => unknown;
      end?: () => unknown;
      flush?: () => unknown;
    };
    if (typeof nodeStdin.write === "function" && typeof nodeStdin.end === "function") {
      await nodeStdin.write(bytes);
      if (typeof nodeStdin.flush === "function") {
        await nodeStdin.flush();
      }
      await nodeStdin.end();
      return;
    }

    throw new Error("docker exec stdin pipe does not support write/end or getWriter");
  }

  private async ensureWorktreeDependencyArtifacts(
    containerWorktreePath: string,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<void> {
    const worktreePrefix = shellSingleQuote(`${containerWorktreePath}/`);
    const command = [
      "set -eu",
      'linked=""',
      "for name in node_modules; do",
      '  src="/repo/$name"',
      `  dest=${worktreePrefix}$name`,
      '  if { [ -e "$src" ] || [ -L "$src" ]; } && [ ! -e "$dest" ] && [ ! -L "$dest" ]; then',
      '    ln -s "$src" "$dest"',
      '    linked="$linked $name"',
      "  fi",
      "done",
      "printf '%s' \"$linked\"",
    ].join("\n");

    const result = await this.runWarmShell(command);
    if (!result.ok) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      const warning = `[DockerExecutor] Worktree dependency artifact linking skipped: ${
        detail || `exit ${result.exitCode}`
      }`;
      console.warn(warning);
      onLog?.("stderr", warning);
      return;
    }

    const linked = result.stdout
      .trim()
      .split(/\s+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (linked.length === 0) return;

    const note = `[DockerExecutor] Linked worktree dependency artifact(s): ${linked.join(", ")}`;
    console.log(note);
    onLog?.("stdout", note);
  }

  private async waitForWorktreePathInWarmContainer(
    containerWorktreePath: string,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastDetail = "";
    const command = `test -d ${shellSingleQuote(containerWorktreePath)}`;
    while (Date.now() < deadline) {
      const result = await this.runWarmShell(command);
      if (result.ok) return;
      lastDetail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      await this.sleep(100);
    }
    throw new Error(
      `worktree path not visible inside warm container after ${timeoutMs}ms: ${containerWorktreePath}${
        lastDetail ? ` (${lastDetail})` : ""
      }`,
    );
  }

  private async ensureWorktreeAccessibleInWarmContainer(
    worktreePath: string,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<string> {
    const worktreeRelPath = relative(this.options.repo, worktreePath).replace(/\\/g, "/");
    const containerWorktreePath = `/repo/${worktreeRelPath}`;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.ensureWarmContainer();
        await this.waitForWorktreePathInWarmContainer(
          containerWorktreePath,
          this.worktreeVisibilityTimeoutMs,
        );
        const probe = await this.runWarmWorktreeProbe(containerWorktreePath);
        if (probe.ok) {
          return containerWorktreePath;
        }
        const detail = [probe.stderr, probe.stdout].filter(Boolean).join("\n").trim();
        throw new Error(
          `warm container git probe failed (exit ${probe.exitCode})${detail ? `: ${detail}` : ""}`,
        );
      } catch (err) {
        lastError = err;
        if (attempt >= 2) {
          const diagnostics = await this.inspectWarmContainerState().catch(() => "");
          throw new Error(
            `worktree not accessible inside warm container after ${attempt} attempts: ${containerWorktreePath}${
              lastError ? ` (${this.compactError(lastError)})` : ""
            }${diagnostics ? ` | container=${diagnostics}` : ""}`,
          );
        }
        const note =
          `[DockerExecutor] Warm container could not access worktree ${containerWorktreePath}; ` +
          `recycling container and retrying once (${this.compactError(err)}).`;
        console.warn(note);
        onLog?.("stderr", note);
        await this.stopWarmContainer("worktree visibility retry", true);
      }
    }

    return containerWorktreePath;
  }

  private normalizeProvider(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!value) return "auto";
    if (value === "lmstudio" || value === "openai_compatible") return "openai";
    if (value === "ollama_chat") return "ollama";
    return value;
  }

  private executionConfigSummary(): string {
    const backend = resolveExecutor(this.config);
    const model = this.config.workerpals.llm.model.trim() || DEFAULT_OPENHANDS_MODEL;
    const provider = this.normalizeProvider(this.config.workerpals.llm.backend);
    const warmMemoryMb = this.config.workerpals.dockerWarmMemoryMb;
    const warmCpus = this.config.workerpals.dockerWarmCpus;
    const warmPython = this.containerBackendPython(backend);
    return `backend=${backend} model=${model} provider=${provider} warm_memory_mb=${warmMemoryMb} warm_cpus=${warmCpus} warm_python=${warmPython}`;
  }

  private logExecutionConfig(): void {
    const summary = this.executionConfigSummary();
    if (summary === this.lastLoggedExecutionConfig) return;
    this.lastLoggedExecutionConfig = summary;
    console.log(`[DockerExecutor] Execution config: ${summary}`);
    const configuredEndpoint = this.config.workerpals.llm.endpoint.trim();
    const containerEndpoint = this.workerLlmEndpointForContainer();
    if (configuredEndpoint && configuredEndpoint !== containerEndpoint) {
      const rewriteSummary = `${configuredEndpoint} -> ${containerEndpoint}`;
      if (rewriteSummary !== this.lastLoggedEndpointRewrite) {
        this.lastLoggedEndpointRewrite = rewriteSummary;
        console.log(
          `[DockerExecutor] Rewriting worker LLM endpoint for container networking: ${rewriteSummary}`,
        );
      }
    }
  }

  private async runGitSelfCheckContainer(worktreePath: string): Promise<void> {
    const containerName = `pushpals-${this.options.workerId}-selfcheck-${Date.now()}`;
    const dockerRepoPath = this.toDockerPath(this.options.repo);
    const worktreeRelPath = relative(this.options.repo, worktreePath).replace(/\\/g, "/");
    const containerWorktreePath = `/repo/${worktreeRelPath}`;

    const proc = Bun.spawn(
      [
        resolveDockerExecutable(),
        "run",
        "--rm",
        "--name",
        containerName,
        "--network",
        "none",
        "-v",
        `${dockerRepoPath}:/repo`,
        "-w",
        containerWorktreePath,
        "--entrypoint",
        "/bin/sh",
        this.options.imageName,
        "-lc",
        "git rev-parse --is-inside-work-tree && git rev-parse --git-dir && git status --porcelain",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      throw new Error(`Docker git/worktree startup self-check failed: ${detail}`);
    }
  }

  /**
   * Read a stream, forwarding lines to onLog callback and collecting to array
   */
  private async readStream(
    readable: ReadableStream<Uint8Array>,
    streamName: "stdout" | "stderr",
    onLog: ((stream: "stdout" | "stderr", line: string) => void) | undefined,
    lines: string[],
  ): Promise<void> {
    const decoder = new TextDecoder();
    const reader = readable.getReader();
    let pending = "";

    const forwardLine = (line: string) => {
      const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!cleanLine) return;
      lines.push(cleanLine);

      // For stderr, try to parse as JSON log line
      if (streamName === "stderr") {
        try {
          const logEntry = JSON.parse(cleanLine);
          if (logEntry.stream && logEntry.line) {
            onLog?.(logEntry.stream, logEntry.line);
            return;
          }
        } catch {
          // Not JSON, forward as-is below.
        }
      }
      onLog?.(streamName, cleanLine);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      pending += decoder.decode(value, { stream: true });
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        forwardLine(line);
        newlineIndex = pending.indexOf("\n");
      }
    }

    pending += decoder.decode();
    if (pending) {
      forwardLine(pending);
    }
  }

  /**
   * Parse the result from stdout lines looking for ___RESULT___ sentinel
   */
  private parseResult(
    stdoutLines: string[],
    stderrLines: string[],
    exitCode: number,
    context: { timedOutByDocker: boolean; elapsedMs: number; timeoutMs: number },
  ): DockerJobResult {
    let sawSentinel = false;
    let sentinelParseError = "";
    // Look for ___RESULT___ sentinel
    for (let i = stdoutLines.length - 1; i >= 0; i--) {
      const line = stdoutLines[i];
      const match = line.match(/^___RESULT___ (.+)$/);
      if (match) {
        sawSentinel = true;
        try {
          const result = JSON.parse(match[1]) as DockerJobResult;
          return result;
        } catch (err) {
          sentinelParseError = String(err);
          console.error(
            `[DockerExecutor] Failed to parse result JSON (line length=${line.length}): ${sentinelParseError}`,
          );
        }
      }
    }

    const stdout = stdoutLines.join("\n");
    const stderr = stderrLines.join("\n");
    if (sawSentinel) {
      const details = [
        `Malformed ___RESULT___ payload: ${sentinelParseError || "unknown parse error"}`,
      ];
      if (stderr) details.push(stderr);
      const summary = `Worker returned malformed structured result after ${context.elapsedMs}ms`;
      return {
        ok: false,
        summary,
        stdout,
        stderr: details.join("\n"),
        exitCode,
        diagnostics: dockerFallbackDiagnostics(
          summary,
          context,
          exitCode,
          "malformed_structured_result",
          {
            sentinelParseError,
          },
        ),
      };
    }

    // No sentinel found, return generic result.
    if (context.timedOutByDocker) {
      const summary = `Job timed out in Docker executor after ${context.elapsedMs}ms (limit ${context.timeoutMs}ms; terminated before structured result).`;
      return {
        ok: false,
        summary,
        stdout,
        stderr,
        exitCode,
        diagnostics: dockerFallbackDiagnostics(summary, context, exitCode, "timeout"),
      };
    }
    if (exitCode === 143 || exitCode === 137) {
      const summary = `Job process was terminated (exit ${exitCode}) after ${context.elapsedMs}ms before structured result was produced.`;
      return {
        ok: false,
        summary,
        stdout,
        stderr,
        exitCode,
        diagnostics: dockerFallbackDiagnostics(summary, context, exitCode, "terminated"),
      };
    }

    const summary =
      exitCode === 0
        ? `Job completed in ${context.elapsedMs}ms`
        : `Job failed (exit ${exitCode}, elapsed ${context.elapsedMs}ms)`;
    return {
      ok: exitCode === 0,
      summary,
      stdout,
      stderr,
      exitCode,
      diagnostics:
        exitCode === 0
          ? undefined
          : dockerFallbackDiagnostics(summary, context, exitCode, "no_structured_result"),
    };
  }

  private async ensureWarmRuntimeReady(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<void> {
    const backend = resolveExecutor(this.config);
    let attempt = 1;
    let recoveredMissingImage = false;
    while (attempt <= this.warmSetupMaxAttempts) {
      try {
        await this.ensureWarmContainer();
        await this.ensureBackendWarmup(backend);
        return;
      } catch (err) {
        if (this.isMissingDockerImageError(err) && !recoveredMissingImage) {
          recoveredMissingImage = true;
          const rebuildNote = `[DockerExecutor] Warm runtime image ${this.options.imageName} is missing locally; rebuilding before retrying warm container startup.`;
          console.warn(rebuildNote);
          onLog?.("stderr", rebuildNote);
          await this.stopWarmContainer("missing image recovery", true);
          this.warmedBackends.clear();
          if (await this.pullImage()) {
            const retryNote = `[DockerExecutor] Warm runtime image ${this.options.imageName} is available again; retrying warm container startup.`;
            console.log(retryNote);
            onLog?.("stdout", retryNote);
            continue;
          }
        }
        const retryable = this.isRetryableError(err);
        if (attempt >= this.warmSetupMaxAttempts || !retryable) {
          if (
            retryable &&
            attempt >= this.warmSetupMaxAttempts &&
            !(err instanceof DockerExecutionExhaustedError)
          ) {
            throw new DockerExecutionExhaustedError(
              "warm_setup",
              `Warm runtime setup retries exhausted after ${this.warmSetupMaxAttempts} attempts: ${this.compactError(
                err,
              )}`,
              this.failureCooldownMs,
            );
          }
          throw err;
        }
        const retryInMs = this.backoffDelayMs(this.warmSetupBackoffMs, attempt);
        const note = `[DockerExecutor] Warm runtime setup failed (attempt ${attempt}/${this.warmSetupMaxAttempts}): ${this.compactError(
          err,
        )}. Retrying in ${retryInMs}ms.`;
        console.warn(note);
        onLog?.("stderr", note);
        await this.stopWarmContainer("warm setup retry", true);
        await this.sleep(retryInMs);
        attempt += 1;
      }
    }
  }

  private async ensureBackendWarmup(backend: ExecutorBackend): Promise<void> {
    if (this.warmedBackends.has(backend)) return;
    const spec = getDockerBackendSpec(backend);
    const warmContext = this.warmStartupContext();
    if (spec.ensureWarmRuntime) {
      await spec.ensureWarmRuntime({
        ...warmContext,
        warmContainerName: this.warmContainerName,
        runWarmShell: (command: string): Promise<DockerWarmShellResult> =>
          this.runWarmShell(command),
        restartWarmContainer: async () => {
          await this.startWarmContainer();
        },
        collectWarmDiagnostics: async () => this.collectWarmRuntimeDiagnostics(backend),
      });
      this.warmedBackends.add(backend);
      return;
    }
    const cmd = spec.warmupProbeCommand?.(SHARED_CONTAINER_VENV_PYTHON);
    if (cmd) {
      const result = await this.runWarmShell(cmd);
      if (!result.ok) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        throw new Error(
          `${backend} runtime warmup failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
        );
      }
    }
    this.warmedBackends.add(backend);
  }

  private backoffDelayMs(baseMs: number, attempt: number): number {
    const factor = Math.max(0, attempt - 1);
    const exponential = baseMs * Math.pow(2, factor);
    return Math.max(250, Math.min(60_000, Math.floor(exponential)));
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  private async runDockerCommandCapture(
    command: string[],
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    const proc = Bun.spawn(command, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (
      typeof opts.timeoutMs === "number" &&
      Number.isFinite(opts.timeoutMs) &&
      opts.timeoutMs > 0
    ) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {
          // best-effort timeout termination only
        }
      }, opts.timeoutMs);
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timer) clearTimeout(timer);
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
      timedOut,
    };
  }

  private compactError(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= 280) return normalized;
    return `${normalized.slice(0, 277)}...`;
  }

  private isRetryableError(err: unknown): boolean {
    const text = this.compactError(err).toLowerCase();
    return this.matchesRetryablePattern(text);
  }

  private isMissingDockerImageError(err: unknown): boolean {
    return isMissingDockerImageDetail(this.compactError(err));
  }

  private isRetryableJobFailure(result: DockerJobResult): boolean {
    const text = `${result.summary ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
    return this.matchesRetryablePattern(text);
  }

  private retryExhaustionCooldownMs(result: DockerJobResult): number {
    const resultCooldownMs = readPositiveNumber(result.cooldownMs) ?? 0;
    return Math.max(this.failureCooldownMs, resultCooldownMs);
  }

  private matchesRetryablePattern(text: string): boolean {
    const transientPatterns: RegExp[] = [
      /warm .*runtime/i,
      /failed to start warm container/i,
      /docker execution error/i,
      /cannot connect to the docker daemon/i,
      /agent server health check failed/i,
      /\bconnection (?:error|refused|reset|aborted|closed)\b/i,
      /\bnetwork is unreachable\b/i,
      /\b(?:econnrefused|econnreset|eai_again)\b/i,
      /\blitellm\.timeout\b/i,
      /\bapitimeouterror\b/i,
      /\b(?:api|request|connection|health check|startup|model preflight|llm)\s+timed out\b/i,
      /\bdeadline exceeded\b/i,
      /\bcontext deadline exceeded\b/i,
      /\btls handshake timeout\b/i,
      /\btemporary failure\b/i,
      /\bopenhands wrapper timed out\b/i,
      /\bjob timed out in docker executor\b/i,
      /\bworktree path not visible inside warm container\b/i,
      /\bchdir to cwd\b/i,
      /\bunable to start container process\b/i,
    ];
    return transientPatterns.some((pattern) => pattern.test(text));
  }

  private hasBudgetForJobRetry(
    attempt: number,
    attemptElapsedMs: number,
    timeoutMs: number,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): boolean {
    if (attempt >= this.jobRetryMaxAttempts) return false;
    const consumedRatio = timeoutMs > 0 ? attemptElapsedMs / timeoutMs : 1;
    if (attemptElapsedMs < Math.max(300_000, timeoutMs * 0.8) && consumedRatio < 0.8) return true;
    const note = `[DockerExecutor] Skipping retry attempt ${
      attempt + 1
    }/${this.jobRetryMaxAttempts}: prior attempt consumed ${attemptElapsedMs}ms of ${timeoutMs}ms budget.`;
    console.warn(note);
    onLog?.("stderr", note);
    return false;
  }

  /**
   * Convert Windows path to Docker-compatible path
   * C:\foo\bar → /c/foo/bar
   */
  private toDockerPath(hostPath: string): string {
    // Check if Windows path (contains :\ or starts with drive letter)
    const winMatch = hostPath.match(/^([a-zA-Z]):([\\/])(.*)$/);
    if (winMatch) {
      const drive = winMatch[1].toLowerCase();
      const rest = winMatch[3].replace(/\\/g, "/");
      return `/${drive}/${rest}`;
    }
    return hostPath;
  }

  /**
   * Clean up orphaned worktrees at startup
   */
  async cleanupOrphanedWorktrees(): Promise<void> {
    try {
      // List all worktrees and only prune stale metadata entries.
      const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
        cwd: this.options.repo,
        stdout: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) return;

      const prunablePaths = collectPrunableEphemeralWorktrees(output);
      if (prunablePaths.length > 0) {
        for (const path of prunablePaths) {
          console.log(`[DockerExecutor] Pruning stale worktree metadata: ${path}`);
        }
      }

      const prune = Bun.spawn(["git", "worktree", "prune"], {
        cwd: this.options.repo,
        stdout: "pipe",
        stderr: "pipe",
      });
      const pruneExit = await prune.exited;
      if (pruneExit !== 0) {
        const pruneStderr = await new Response(prune.stderr).text();
        console.warn(`[DockerExecutor] Worktree prune warning: ${pruneStderr}`);
      }
    } catch (err) {
      console.error(`[DockerExecutor] Cleanup error: ${err}`);
    }
  }

  private buildEphemeralWorktreeName(prefix: "job" | "selfcheck", token: string): string {
    const safeToken = this.sanitizeWorktreeToken(token, prefix === "job" ? 8 : 12);
    const nonce = `${Date.now().toString(36).slice(-6)}-${randomUUID().slice(0, 6).toLowerCase()}`;
    return `${prefix}-${safeToken}-${nonce}`;
  }

  private sanitizeWorktreeToken(value: string, maxLength: number): string {
    const normalized = String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!normalized) return "work";
    return normalized.slice(0, maxLength);
  }

  private async ensureFreshWorktreePath(worktreePath: string): Promise<void> {
    if (!existsSync(worktreePath)) return;

    console.warn(
      `[DockerExecutor] Worktree path already exists; forcing cleanup before create: ${worktreePath}`,
    );

    const unregister = Bun.spawn(
      ["git", "worktree", "remove", "--force", "--force", worktreePath],
      {
        cwd: this.options.repo,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await unregister.exited;

    const prune = Bun.spawn(["git", "worktree", "prune"], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    await prune.exited;

    const forced = await forceDeleteWorktreePath(worktreePath, {
      sleepFn: (ms) => this.sleep(ms),
    });
    if (!forced.removed) {
      throw new Error(
        `Failed to remove stale worktree path before create (${worktreePath})${
          forced.lastError ? `: ${forced.lastError}` : ""
        }`,
      );
    }
  }

  private isMergeConflictResolutionJob(job: Job): boolean {
    const reviewAgent =
      job.params?.reviewAgent && typeof job.params.reviewAgent === "object"
        ? (job.params.reviewAgent as Record<string, unknown>)
        : null;
    const resolutionType =
      reviewAgent && typeof reviewAgent.resolutionType === "string"
        ? reviewAgent.resolutionType.trim().toLowerCase()
        : "";
    return resolutionType === "merge_conflict";
  }

  shouldPrepareMergeConflictJobBeforeExecution(job: Job): boolean {
    return this.isMergeConflictResolutionJob(job) && !this.preparedMergeConflictJobs.has(job.id);
  }

  async prepareMergeConflictJobEnvironment(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<void> {
    await this.ensureFreshImageForMergeConflictJob(job, onLog);
    this.preparedMergeConflictJobs.add(job.id);
  }

  recommendedMergeConflictDeferMs(): number {
    return Math.max(60_000, Math.min(this.options.timeoutMs, 5 * 60_000));
  }

  private async ensureFreshImageForMergeConflictJob(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<void> {
    if (!this.isMergeConflictResolutionJob(job)) return;

    if (this.mergeConflictRefreshPromise) {
      await this.mergeConflictRefreshPromise;
      return;
    }

    this.mergeConflictRefreshPromise = this.rebuildImageForMergeConflictJob(job, onLog);
    try {
      await this.mergeConflictRefreshPromise;
    } finally {
      this.mergeConflictRefreshPromise = null;
    }
  }

  private async rebuildImageForMergeConflictJob(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<void> {
    const sandboxContext = resolveWorkerpalSandboxBuildContext(this.options.repo);
    const dockerfilePath = sandboxContext.dockerfilePath;
    if (!existsSync(dockerfilePath)) {
      throw new Error(
        `Merge-conflict job ${job.id} requires Docker image refresh, but Dockerfile is missing at ${dockerfilePath}.`,
      );
    }

    const startMsg = `[DockerExecutor] Merge-conflict job ${job.id}: rebuilding ${this.options.imageName} with --no-cache and restarting warm runtime.`;
    console.log(startMsg);
    onLog?.("stdout", startMsg);

    await this.stopWarmContainer("merge-conflict image refresh", true);
    this.warmedBackends.clear();

    const build = Bun.spawn(
      [
        resolveDockerExecutable(),
        "build",
        "--no-cache",
        "-f",
        dockerfilePath,
        "-t",
        this.options.imageName,
        ".",
      ],
      {
        cwd: sandboxContext.root,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    if (exitCode !== 0) {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      throw new Error(
        `Failed to rebuild Docker image for merge-conflict job ${job.id}: ${detail || `exit ${exitCode}`}`,
      );
    }

    const doneMsg = `[DockerExecutor] Merge-conflict job ${job.id}: Docker image refresh complete (${this.options.imageName}).`;
    console.log(doneMsg);
    onLog?.("stdout", doneMsg);
  }

  private async resolveWorktreeBaseRefForJob(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<string> {
    const reviewAgent =
      job.params?.reviewAgent && typeof job.params.reviewAgent === "object"
        ? (job.params.reviewAgent as Record<string, unknown>)
        : null;
    const resolutionType =
      reviewAgent && typeof reviewAgent.resolutionType === "string"
        ? reviewAgent.resolutionType.trim().toLowerCase()
        : "";
    if (resolutionType !== "merge_conflict") {
      return resolveFreshWorktreeBaseRef({
        requestedRef: this.options.baseRef,
        integrationBranch:
          this.config.sourceControlManager.mainBranch ||
          this.config.workerpals.baseRef ||
          this.options.baseRef,
        sourceBaseBranch: this.config.sourceControlManager.baseBranch,
        git: (args) => this.runGitBaseRefCommand(args),
        log: (level, message) => {
          const line = `[DockerExecutor] ${message}`;
          if (level === "warn") {
            console.warn(line);
            onLog?.("stderr", line);
          } else {
            console.log(line);
            onLog?.("stdout", line);
          }
        },
      });
    }

    const normalizedHeadRef = normalizeMergeConflictHeadRef(reviewAgent?.prHeadRef);
    if (!normalizedHeadRef) {
      const note = `[DockerExecutor] Merge-conflict job ${job.id} has no usable prHeadRef; falling back to ${this.options.baseRef}.`;
      console.warn(note);
      onLog?.("stderr", note);
      return this.options.baseRef;
    }

    const remoteRef = `origin/${normalizedHeadRef}`;
    const fetch = Bun.spawn(["git", "fetch", "origin", normalizedHeadRef, "--quiet"], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    const fetchExit = await fetch.exited;
    if (fetchExit !== 0) {
      const fetchErr = (await new Response(fetch.stderr).text()).trim();
      const note = `[DockerExecutor] Merge-conflict job ${job.id} could not refresh ${remoteRef}; falling back to ${this.options.baseRef}${fetchErr ? ` (${fetchErr})` : ""}.`;
      console.warn(note);
      onLog?.("stderr", note);
      return this.options.baseRef;
    }

    const verify = Bun.spawn(["git", "rev-parse", "--verify", "--quiet", remoteRef], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    const verifyExit = await verify.exited;
    if (verifyExit !== 0) {
      const note = `[DockerExecutor] Merge-conflict job ${job.id} could not verify ${remoteRef}; falling back to ${this.options.baseRef}.`;
      console.warn(note);
      onLog?.("stderr", note);
      return this.options.baseRef;
    }

    const info = `[DockerExecutor] Merge-conflict job ${job.id}: using fresh worktree base ${remoteRef}.`;
    console.log(info);
    onLog?.("stdout", info);
    return remoteRef;
  }

  private async runGitBaseRefCommand(
    args: string[],
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return {
      ok: exitCode === 0,
      stdout,
      stderr,
    };
  }

  /**
   * Pull the Docker image
   */
  async pullImage(): Promise<boolean> {
    const runtimeTag = resolveWorkerpalRuntimeTag();
    const existingRuntimeTag = runtimeTag ? await this.inspectImageRuntimeTag() : "";
    if (await this.imageExists()) {
      if (!runtimeTag || existingRuntimeTag === runtimeTag) {
        console.log(`[DockerExecutor] Using local image: ${this.options.imageName}`);
        return true;
      }
      console.warn(
        `[DockerExecutor] Local image ${this.options.imageName} is stale or unlabeled (runtimeTag=${existingRuntimeTag || "missing"}, expected=${runtimeTag}).`,
      );
    }

    if (await this.buildLocalImage(runtimeTag)) {
      const rebuiltRuntimeTag = runtimeTag ? await this.inspectImageRuntimeTag() : "";
      if (!runtimeTag || rebuiltRuntimeTag === runtimeTag) {
        console.log(`[DockerExecutor] Using locally built image: ${this.options.imageName}`);
        return true;
      }
    }

    console.log(
      `[DockerExecutor] Local image is unavailable or unsuitable. Pulling: ${this.options.imageName}`,
    );
    const pull = await this.runDockerCommandCapture(
      [resolveDockerExecutable(), "pull", this.options.imageName],
      { timeoutMs: DOCKER_IMAGE_PULL_TIMEOUT_MS },
    );
    if (!pull.timedOut && pull.exitCode === 0) {
      console.log(`[DockerExecutor] Image pulled successfully`);
      return true;
    }

    const detail = pull.stderr || pull.stdout || `docker pull exited ${pull.exitCode}`;
    console.error(
      `[DockerExecutor] Failed to pull image: ${
        pull.timedOut ? `timed out after ${DOCKER_IMAGE_PULL_TIMEOUT_MS}ms` : detail
      }`,
    );

    // Another process may have built/pulled the image while this pull was running.
    if (await this.imageExists()) {
      console.warn(
        `[DockerExecutor] Pull failed but local image is now available: ${this.options.imageName}`,
      );
      return true;
    }

    return false;
  }

  /**
   * Check if the Docker image exists locally
   */
  private async imageExists(): Promise<boolean> {
    const result = await this.runDockerCommandCapture(
      [resolveDockerExecutable(), "image", "inspect", this.options.imageName],
      { timeoutMs: DOCKER_IMAGE_INSPECT_TIMEOUT_MS },
    );
    if (result.timedOut) {
      console.warn(
        `[DockerExecutor] Timed out checking local image ${this.options.imageName}; treating it as unavailable and attempting rebuild.`,
      );
      return false;
    }
    return result.exitCode === 0;
  }

  private async inspectImageRuntimeTag(): Promise<string> {
    const result = await this.runDockerCommandCapture(
      [
        resolveDockerExecutable(),
        "image",
        "inspect",
        "--format",
        `{{ index .Config.Labels "${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}" }}`,
        this.options.imageName,
      ],
      { timeoutMs: DOCKER_IMAGE_INSPECT_TIMEOUT_MS },
    );
    if (result.timedOut) {
      console.warn(
        `[DockerExecutor] Timed out inspecting runtime tag for ${this.options.imageName}; treating the local image as stale and attempting rebuild.`,
      );
      return "";
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
      if (!isMissingDockerImageDetail(detail)) {
        console.warn(
          `[DockerExecutor] Failed to inspect runtime tag for ${this.options.imageName}: ${detail}`,
        );
      }
      return "";
    }
    const value = result.stdout.trim();
    return value === "<no value>" ? "" : value;
  }

  private async buildLocalImage(runtimeTag: string): Promise<boolean> {
    const sandboxContext = resolveWorkerpalSandboxBuildContext(this.options.repo);
    if (!existsSync(sandboxContext.dockerfilePath)) {
      return false;
    }

    const dockerfileArg = dockerBuildFileArg(sandboxContext.root, sandboxContext.dockerfilePath);
    console.log(
      runtimeTag
        ? `[DockerExecutor] Building local WorkerPal sandbox image ${this.options.imageName} for runtimeTag=${runtimeTag}`
        : `[DockerExecutor] Building local WorkerPal sandbox image ${this.options.imageName}`,
    );
    const args = [
      resolveDockerExecutable(),
      "build",
      "-f",
      dockerfileArg,
      "--label",
      WORKERPAL_SANDBOX_COMPONENT_LABEL,
      ...(runtimeTag ? ["--label", `${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}=${runtimeTag}`] : []),
      "-t",
      this.options.imageName,
      ".",
    ];
    const build = await this.runDockerCommandCapture(args, {
      cwd: sandboxContext.root,
      timeoutMs: DOCKER_IMAGE_BUILD_TIMEOUT_MS,
    });
    if (!build.timedOut && build.exitCode === 0) {
      return true;
    }
    const detail = build.stderr || build.stdout || `docker build exited ${build.exitCode}`;
    console.error(
      `[DockerExecutor] Failed to build local image: ${
        build.timedOut ? `timed out after ${DOCKER_IMAGE_BUILD_TIMEOUT_MS}ms` : detail
      }`,
    );
    return false;
  }

  /**
   * Check if Docker is available
   */
  static async isDockerAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn([resolveDockerExecutable(), "version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }
}
