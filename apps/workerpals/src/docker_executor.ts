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
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { loadPushPalsConfig } from "shared";
import { computeTimeoutWarningWindow, DEFAULT_DOCKER_TIMEOUT_MS } from "./timeout_policy.js";

const DEFAULT_OPENHANDS_MODEL = "local-model";
const CONFIG = loadPushPalsConfig();

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
  private options: Required<DockerExecutorOptions>;
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

  constructor(options: DockerExecutorOptions) {
    const startupTimeoutMs = parseClampedInt(
      CONFIG.workerpals.dockerAgentStartupTimeoutMs,
      45_000,
      10_000,
      180_000,
    );

    this.options = {
      gitToken: "",
      // Keep a little headroom above OpenHands inner timeout so wrapper can
      // emit a structured timeout failure before docker hard-kills the job.
      timeoutMs: DEFAULT_DOCKER_TIMEOUT_MS,
      idleTimeoutMs: 10 * 60 * 1000,
      baseRef: "HEAD",
      networkMode: "bridge",
      ...options,
    };
    this.worktreeDir = resolve(this.options.repo, ".worktrees");
    this.warmContainerName = `pushpals-${this.options.workerId}-warm`;
    this.warmAgentStartupTimeoutMs = startupTimeoutMs;
    this.warmSetupMaxAttempts = parseClampedInt(CONFIG.workerpals.dockerWarmMaxAttempts, 3, 1, 5);
    this.warmSetupBackoffMs = parseClampedInt(
      CONFIG.workerpals.dockerWarmRetryBackoffMs,
      2_000,
      250,
      60_000,
    );
    this.jobRetryMaxAttempts = parseClampedInt(CONFIG.workerpals.dockerJobMaxAttempts, 2, 1, 3);
    this.jobRetryBackoffMs = parseClampedInt(
      CONFIG.workerpals.dockerJobRetryBackoffMs,
      3_000,
      250,
      60_000,
    );
    this.failureCooldownMs = parseClampedIntAllowZero(
      CONFIG.workerpals.failureCooldownMs,
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
          this.logExecutionConfig(job);
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

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`[DockerExecutor] Worktree removal warning: ${stderr}`);
    }

    // Also prune worktree list
    Bun.spawn(["git", "worktree", "prune"], { cwd: this.options.repo });

    console.log(`[DockerExecutor] Removed worktree: ${worktreePath}`);
  }

  /**
   * Run the Docker container and parse output
   */
  private collectContainerEnv(): string[] {
    const fixedEnv: Record<string, string> = {
      WORKERPALS_EXECUTOR: CONFIG.workerpals.executor,
      WORKERPALS_LLM_MODEL: CONFIG.workerpals.llm.model,
      WORKERPALS_LLM_ENDPOINT: CONFIG.workerpals.llm.endpoint,
      WORKERPALS_LLM_BACKEND: CONFIG.workerpals.llm.backend,
      WORKERPALS_LLM_SESSION_ID: CONFIG.workerpals.llm.sessionId,
      WORKERPALS_OPENHANDS_TIMEOUT_MS: String(CONFIG.workerpals.openhandsTimeoutMs),
      WORKERPALS_OPENHANDS_PYTHON: CONFIG.workerpals.openhandsPython,
    };
    if (CONFIG.workerpals.llm.apiKey.trim()) {
      fixedEnv.WORKERPALS_LLM_API_KEY = CONFIG.workerpals.llm.apiKey;
    }

    const allowlist = [
      "WORKERPALS_OPENHANDS_PROMPT_PROFILE",
      "WORKERPALS_OPENHANDS_AGENT_MAX_STEPS",
      "WORKERPALS_OPENHANDS_WORKSPACE_PYTHON",
      "WORKERPALS_OPENHANDS_LLM_NUM_RETRIES",
      "WORKERPALS_OPENHANDS_LLM_RETRY_MULTIPLIER",
      "WORKERPALS_OPENHANDS_LLM_RETRY_MIN_WAIT",
      "WORKERPALS_OPENHANDS_LLM_RETRY_MAX_WAIT",
      "WORKERPALS_OPENHANDS_LLM_TIMEOUT_SEC",
      "WORKERPALS_OPENHANDS_MODEL_PROBE_TIMEOUT_SEC",
      "WORKERPALS_OPENHANDS_TASK_PROMPT_MODE",
      "WORKERPALS_OPENHANDS_LARGE_INSTRUCTION_CHARS",
      "WORKERPALS_OPENHANDS_ENABLE_BROWSER_TOOL",
      "WORKERPALS_OPENHANDS_ENABLE_WEB_MCP",
      "WORKERPALS_OPENHANDS_MCP_CONFIG_JSON",
      "WORKERPALS_OPENHANDS_WEB_MCP_URL",
      "WORKERPALS_OPENHANDS_WEB_MCP_NAME",
      "WORKERPALS_OPENHANDS_WEB_MCP_TRANSPORT",
      "WORKERPALS_OPENHANDS_WEB_MCP_AUTH_TOKEN",
      "WORKERPALS_OPENHANDS_WEB_MCP_HEADERS_JSON",
      "WORKERPALS_OPENHANDS_WEB_MCP_TIMEOUT_SEC",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "all_proxy",
      "PUSHPALS_GIT_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GIT_TOKEN",
      "PUSHPALS_REPO_PATH",
    ];

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
    const dockerRepoPath = this.toDockerPath(this.options.repo);
    const envArgs = this.collectContainerEnv();
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
      "512m",
      "--cpus",
      "1",
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
    ];

    if (this.options.gitToken) {
      args.push("-e", `GIT_TOKEN=${this.options.gitToken}`);
    }
    args.push("-e", `WORKERPALS_OPENHANDS_AGENT_SERVER_URL=http://127.0.0.1:${this.warmAgentPort}`);

    const healthCmd = `curl -fsS http://127.0.0.1:${this.warmAgentPort}/health >/dev/null 2>&1`;
    const { attempts: startupAttempts, sleepSeconds } = this.warmAgentStartupLoop();
    const resolvePythonCmd =
      'PY="${WORKERPALS_OPENHANDS_PYTHON:-/opt/openhands-venv/bin/python}"; ' +
      'if [ ! -x "$PY" ]; then PY="$(command -v python3 || command -v python || true)"; fi; ' +
      '[ -n "$PY" ] || { echo "python runtime not found" >&2; exit 1; }';

    args.push(
      "--entrypoint",
      "/bin/sh",
      this.options.imageName,
      "-lc",
      `${resolvePythonCmd}; ` +
        ": >/tmp/openhands-agent.log; " +
        `"$PY" -m openhands.agent_server --host 127.0.0.1 --port ${this.warmAgentPort} >/tmp/openhands-agent.log 2>&1 & ` +
        `for i in $(seq 1 ${startupAttempts}); do ${healthCmd} && break; sleep ${sleepSeconds}; done; ` +
        `${healthCmd} || { ` +
        'echo "agent server health check failed"; ' +
        'ps -ef | grep -i "openhands.agent_server" | grep -v grep || true; ' +
        "ls -l /tmp/openhands-agent.log 2>/dev/null || true; " +
        "tail -n 160 /tmp/openhands-agent.log 2>/dev/null; " +
        "exit 1; }; " +
        "tail -f /dev/null",
    );

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

  private async collectWarmAgentDiagnostics(): Promise<string> {
    const sections: string[] = [];
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

    const checks: Array<{ label: string; command: string }> = [
      {
        label: "processes",
        command: 'ps -ef | grep -i "openhands.agent_server" | grep -v grep || true',
      },
      {
        label: "python",
        command:
          'PY="${WORKERPALS_OPENHANDS_PYTHON:-/opt/openhands-venv/bin/python}"; ' +
          'echo "configured=$PY"; ' +
          'if [ -x "$PY" ]; then "$PY" -V 2>&1; else echo "configured python missing"; fi; ' +
          "(command -v python3 && python3 -V) 2>/dev/null || true",
      },
      {
        label: "agent-log-meta",
        command: "ls -l /tmp/openhands-agent.log 2>/dev/null || true",
      },
      {
        label: "agent-log-tail",
        command: "tail -n 160 /tmp/openhands-agent.log 2>/dev/null || true",
      },
    ];

    for (const check of checks) {
      const result = await this.runWarmShell(check.command);
      const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
      sections.push(
        `[${check.label}] exit=${result.exitCode}${text ? `\n${text}` : "\n(no output)"}`,
      );
    }
    return sections.join("\n");
  }

  private async ensureWarmAgentServer(): Promise<void> {
    const healthCmd = `curl -fsS http://127.0.0.1:${this.warmAgentPort}/health >/dev/null 2>&1`;
    const healthy = await this.runWarmShell(healthCmd);
    if (healthy.ok) return;

    console.warn(
      `[DockerExecutor] Warm agent server is unhealthy in ${this.warmContainerName}; restarting it...`,
    );

    const { attempts: startupAttempts, sleepSeconds } = this.warmAgentStartupLoop();
    const resolvePythonCmd =
      'PY="${WORKERPALS_OPENHANDS_PYTHON:-/opt/openhands-venv/bin/python}"; ' +
      'if [ ! -x "$PY" ]; then PY="$(command -v python3 || command -v python || true)"; fi; ' +
      '[ -n "$PY" ] || { echo "python runtime not found" >&2; exit 1; }';
    const restartCmd =
      "OLD_PIDS=\"$(ps -eo pid,args | awk '/[o]penhands\\.agent_server/ {print $1}' | tr '\\n' ' ')\"; " +
      'if [ -n "$OLD_PIDS" ]; then kill $OLD_PIDS >/dev/null 2>&1 || true; fi; ' +
      "sleep 0.2; " +
      `${resolvePythonCmd}; ` +
      ": >/tmp/openhands-agent.log; " +
      `"$PY" -m openhands.agent_server --host 127.0.0.1 --port ${this.warmAgentPort} >/tmp/openhands-agent.log 2>&1 & ` +
      `for i in $(seq 1 ${startupAttempts}); do ${healthCmd} && break; sleep ${sleepSeconds}; done; ` +
      healthCmd;
    const restarted = await this.runWarmShell(restartCmd);
    if (restarted.ok) {
      return;
    }

    let recreateError = "";
    try {
      console.warn(
        `[DockerExecutor] Warm agent restart failed in ${this.warmContainerName}; recreating warm container once...`,
      );
      await this.startWarmContainer();
      const postRecreateHealth = await this.runWarmShell(
        `for i in $(seq 1 ${startupAttempts}); do ${healthCmd} && exit 0; sleep ${sleepSeconds}; done; exit 1`,
      );
      if (postRecreateHealth.ok) {
        return;
      }
      const postRecreateOutput = [postRecreateHealth.stderr, postRecreateHealth.stdout]
        .filter(Boolean)
        .join("\n")
        .trim();
      recreateError = `post-recreate health check failed (exit ${postRecreateHealth.exitCode})${
        postRecreateOutput ? `: ${postRecreateOutput}` : "."
      }`;
    } catch (error) {
      recreateError = `recreate warm container failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }

    const restartOutput = [restarted.stderr, restarted.stdout].filter(Boolean).join("\n").trim();
    const diagnostics = await this.collectWarmAgentDiagnostics();
    throw new Error(
      `Warm OpenHands agent server could not be started (exit ${restarted.exitCode})${
        restartOutput ? `: ${restartOutput}` : "."
      }${recreateError ? `\n${recreateError}` : ""}\n${diagnostics}`,
    );
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
    await this.ensureWarmRuntimeReady(onLog);

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
      `[DockerExecutor] Running job in warm container: ${this.warmContainerName} (${this.executionConfigSummary(
        job,
      )})`,
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

    // Set up timeout
    const timer = setTimeout(() => {
      const timeoutMsg = `[DockerExecutor] Job timeout in warm container: ${this.warmContainerName}`;
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

    const [stdoutResult, stderrResult] = await Promise.all([
      this.readStream(proc.stdout, "stdout", onLog, stdoutLines),
      this.readStream(proc.stderr, "stderr", onLog, stderrLines),
    ]);

    clearTimeout(warningTimer);
    clearTimeout(timer);
    const exitCode = await proc.exited;

    // Parse result from stdout (look for ___RESULT___ sentinel)
    const result = this.parseResult(stdoutLines, stderrLines, exitCode);

    return result;
  }

  private normalizeProvider(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!value) return "auto";
    if (value === "lmstudio" || value === "openai_compatible") return "openai";
    if (value === "ollama_chat") return "ollama";
    return value;
  }

  private executionConfigSummary(job?: Job): string {
    const backend = CONFIG.workerpals.executor.trim().toLowerCase() || "openhands";
    const model = CONFIG.workerpals.llm.model.trim() || DEFAULT_OPENHANDS_MODEL;
    const provider = this.normalizeProvider(CONFIG.workerpals.llm.backend);
    const laneRaw =
      job?.kind === "task.execute" && typeof job.params?.lane === "string" ? job.params.lane : "";
    const lane = laneRaw.trim().toLowerCase();
    return lane
      ? `backend=${backend} model=${model} provider=${provider} lane=${lane}`
      : `backend=${backend} model=${model} provider=${provider}`;
  }

  private logExecutionConfig(job: Job): void {
    const summary = this.executionConfigSummary(job);
    if (summary === this.lastLoggedExecutionConfig) return;
    this.lastLoggedExecutionConfig = summary;
    console.log(`[DockerExecutor] Execution config: ${summary}`);
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const chunkLines = chunk.split("\n");

      for (const line of chunkLines) {
        const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (cleanLine) {
          lines.push(cleanLine);

          // For stderr, try to parse as JSON log line
          if (streamName === "stderr") {
            try {
              const logEntry = JSON.parse(cleanLine);
              if (logEntry.stream && logEntry.line) {
                onLog?.(logEntry.stream, logEntry.line);
              }
            } catch {
              // Not JSON, forward as-is
              onLog?.(streamName, cleanLine);
            }
          } else {
            onLog?.(streamName, cleanLine);
          }
        }
      }
    }
  }

  /**
   * Parse the result from stdout lines looking for ___RESULT___ sentinel
   */
  private parseResult(
    stdoutLines: string[],
    stderrLines: string[],
    exitCode: number,
  ): DockerJobResult {
    // Look for ___RESULT___ sentinel
    for (const line of stdoutLines) {
      const match = line.match(/^___RESULT___ (.+)$/);
      if (match) {
        try {
          const result = JSON.parse(match[1]) as DockerJobResult;
          return result;
        } catch (err) {
          console.error(`[DockerExecutor] Failed to parse result JSON: ${err}`);
        }
      }
    }

    // No sentinel found, return generic result
    if (exitCode === 143 || exitCode === 137) {
      return {
        ok: false,
        summary: `Job timed out in Docker executor after ${this.options.timeoutMs}ms (terminated before structured result).`,
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
        exitCode,
      };
    }

    return {
      ok: exitCode === 0,
      summary: exitCode === 0 ? "Job completed" : `Job failed (exit ${exitCode})`,
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
      exitCode,
    };
  }

  private async ensureWarmRuntimeReady(
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.warmSetupMaxAttempts; attempt++) {
      try {
        await this.ensureWarmContainer();
        await this.ensureWarmAgentServer();
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
    const transientPatterns = [
      "warm openhands agent server",
      "failed to start warm container",
      "docker execution error",
      "cannot connect to the docker daemon",
      "docker daemon",
      "agent server health check failed",
      "connection error",
      "connection refused",
      "connection reset",
      "network is unreachable",
      "timed out",
      "timeout",
      "litellm.timeout",
      "api timeout",
      "model preflight failed",
      "temporary failure",
      "econnrefused",
      "econnreset",
      "eai_again",
      "tls handshake timeout",
    ];
    return transientPatterns.some((pattern) => text.includes(pattern));
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
