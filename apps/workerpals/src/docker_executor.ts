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
import type { ExecutorBackend } from "./common/types.js";
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

const DEFAULT_OPENHANDS_MODEL = "local-model";
const DEFAULT_CONFIG = loadPushPalsConfig();
const SHARED_CONTAINER_VENV_PYTHON = "/workspace/.venv/bin/python";

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
  commit?: {
    branch: string;
    sha: string;
  };
}

export interface Job {
  id: string;
  taskId: string;
  kind: string;
  params: Record<string, unknown>;
  sessionId: string;
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
  private lastLoggedExecutionConfig = "";
  private lastLoggedEndpointRewrite = "";
  private warmedBackends = new Set<string>();
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
    const worktreeName = `job-${job.id}`;
    const worktreePath = resolve(this.worktreeDir, worktreeName);

    try {
      // Step 1: Create isolated git worktree
      await this.createWorktree(worktreePath);

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
        try {
          this.logExecutionConfig();
          const result = await this.runInWarmContainer(worktreePath, base64Spec, job, onLog);
          if (result.ok) return result;

          const retryableFailure = this.isRetryableJobFailure(result);
          if (attempt >= this.jobRetryMaxAttempts || !retryableFailure) {
            if (
              retryableFailure &&
              attempt >= this.jobRetryMaxAttempts &&
              this.failureCooldownMs > 0
            ) {
              return {
                ...result,
                cooldownMs: this.failureCooldownMs,
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
          if (attempt >= this.jobRetryMaxAttempts || !retryableError) {
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
    const worktreeName = `selfcheck-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const worktreePath = resolve(this.worktreeDir, worktreeName);

    try {
      await this.createWorktree(worktreePath);
      await this.runGitSelfCheckContainer(worktreePath);
      console.log(`[DockerExecutor] Startup self-check passed (git/worktree in container).`);
    } finally {
      await this.removeWorktree(worktreePath).catch(() => {
        // Ignore cleanup failures for startup self-check artifacts.
      });
    }
  }

  /**
   * Create a git worktree for isolated job execution
   */
  private async createWorktree(worktreePath: string): Promise<void> {
    // Create worktree from configured base ref (detached)
    const proc = Bun.spawn(
      ["git", "worktree", "add", "--detach", worktreePath, this.options.baseRef],
      {
        cwd: this.options.repo,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to create worktree from ${this.options.baseRef}: ${stderr}`);
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
    const proc = Bun.spawn(["git", "worktree", "remove", "--force", worktreePath], {
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

    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
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
    const hostCodexHome = (
      hostCodexHomeRaw
        ? isAbsolute(hostCodexHomeRaw)
          ? hostCodexHomeRaw
          : resolve(this.options.repo, hostCodexHomeRaw)
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
        "docker",
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
    const proc = Bun.spawn(["docker", "exec", this.warmContainerName, "/bin/sh", "-lc", command], {
      stdout: "pipe",
      stderr: "pipe",
    });
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
        "docker",
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
    const proc = Bun.spawn(["docker", "logs", "--tail", String(tail), this.warmContainerName], {
      stdout: "pipe",
      stderr: "pipe",
    });
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
    const stopProc = Bun.spawn(["docker", "rm", "-f", this.warmContainerName], {
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

    const worktreeRelPath = relative(this.options.repo, worktreePath).replace(/\\/g, "/");
    const containerWorktreePath = `/repo/${worktreeRelPath}`;

    const args: string[] = [
      "exec",
      "-w",
      containerWorktreePath,
      this.warmContainerName,
      "bun",
      "run",
      "/workspace/apps/workerpals/src/job_runner.ts",
      base64Spec,
    ];

    console.log(
      `[DockerExecutor] Running job in warm container: ${this.warmContainerName} (${this.executionConfigSummary()})`,
    );

    const proc = Bun.spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const { leadMs: warningLeadMs, delayMs: warningDelayMs } = computeTimeoutWarningWindow(
      this.options.timeoutMs,
    );
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
      const timeoutMsg = `[DockerExecutor] Job timeout in warm container after ${elapsedMs}ms (limit ${this.options.timeoutMs}ms): ${this.warmContainerName}`;
      console.log(timeoutMsg);
      onLog?.("stderr", timeoutMsg);
      try {
        proc.kill();
        // Reset the warm container to clear any stuck in-container process.
        Bun.spawn(["docker", "restart", "-t", "1", this.warmContainerName]);
      } catch {
        // Ignore kill errors
      }
    }, this.options.timeoutMs);

    // Process streams
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    await Promise.all([
      this.readStream(proc.stdout, "stdout", onLog, stdoutLines),
      this.readStream(proc.stderr, "stderr", onLog, stderrLines),
    ]);

    clearTimeout(warningTimer);
    clearTimeout(timer);
    const exitCode = await proc.exited;
    const elapsedMs = Math.max(1, Date.now() - startedAtMs);

    // Parse result from stdout (look for ___RESULT___ sentinel)
    const result = this.parseResult(stdoutLines, stderrLines, exitCode, {
      timedOutByDocker,
      elapsedMs,
    });

    return result;
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
        "docker",
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
    context: { timedOutByDocker: boolean; elapsedMs: number },
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
      return {
        ok: false,
        summary: `Worker returned malformed structured result after ${context.elapsedMs}ms`,
        stdout,
        stderr: details.join("\n"),
        exitCode,
      };
    }

    // No sentinel found, return generic result.
    if (context.timedOutByDocker) {
      return {
        ok: false,
        summary: `Job timed out in Docker executor after ${context.elapsedMs}ms (limit ${this.options.timeoutMs}ms; terminated before structured result).`,
        stdout,
        stderr,
        exitCode,
      };
    }
    if (exitCode === 143 || exitCode === 137) {
      return {
        ok: false,
        summary: `Job process was terminated (exit ${exitCode}) after ${context.elapsedMs}ms before structured result was produced.`,
        stdout,
        stderr,
        exitCode,
      };
    }

    return {
      ok: exitCode === 0,
      summary:
        exitCode === 0
          ? `Job completed in ${context.elapsedMs}ms`
          : `Job failed (exit ${exitCode}, elapsed ${context.elapsedMs}ms)`,
      stdout,
      stderr,
      exitCode,
    };
  }

  private async ensureWarmRuntimeReady(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<void> {
    const backend = resolveExecutor(this.config);
    for (let attempt = 1; attempt <= this.warmSetupMaxAttempts; attempt++) {
      try {
        await this.ensureWarmContainer();
        await this.ensureBackendWarmup(backend);
        return;
      } catch (err) {
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

  private isRetryableJobFailure(result: DockerJobResult): boolean {
    const text = `${result.summary ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
    return this.matchesRetryablePattern(text);
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
    ];
    return transientPatterns.some((pattern) => pattern.test(text));
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
      // List all worktrees
      const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
        cwd: this.options.repo,
        stdout: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) return;

      // Parse worktree list
      const worktrees = output.trim().split("\n\n");
      for (const wt of worktrees) {
        const lines = wt.split("\n");
        const worktreeLine = lines.find((l) => l.startsWith("worktree "));
        const detachedLine = lines.find((l) => l === "detached");

        if (worktreeLine && detachedLine) {
          const path = worktreeLine.replace("worktree ", "").trim();
          // Check if it's one of our job worktrees
          if (path.includes("/job-") || path.includes("\\job-")) {
            console.log(`[DockerExecutor] Cleaning up orphaned worktree: ${path}`);
            await this.removeWorktree(path).catch(() => {
              // Ignore errors during cleanup
            });
          }
        }
      }
    } catch (err) {
      console.error(`[DockerExecutor] Cleanup error: ${err}`);
    }
  }

  /**
   * Pull the Docker image
   */
  async pullImage(): Promise<boolean> {
    if (await this.imageExists()) {
      console.log(`[DockerExecutor] Using local image: ${this.options.imageName}`);
      return true;
    }

    console.log(`[DockerExecutor] Local image not found. Pulling: ${this.options.imageName}`);
    const proc = Bun.spawn(["docker", "pull", this.options.imageName], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log(`[DockerExecutor] Image pulled successfully`);
      return true;
    }

    const stderr = (await new Response(proc.stderr).text()).trim();
    console.error(`[DockerExecutor] Failed to pull image: ${stderr}`);

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
    const proc = Bun.spawn(["docker", "image", "inspect", this.options.imageName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  }

  /**
   * Check if Docker is available
   */
  static async isDockerAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["docker", "version"], {
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
