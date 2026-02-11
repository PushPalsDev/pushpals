/**
 * DockerExecutor - Runs jobs inside Docker containers with git worktree isolation
 *
 * This executor:
 * 1. Creates isolated git worktrees for each job
 * 2. Runs ephemeral Docker containers mounting the worktree
 * 3. Parses structured output from the container
 * 4. Cleans up worktrees after execution
 *
 * Architecture:
 *   HOST: Worker daemon → git worktree add → docker run → git worktree remove
 *   CONTAINER: job_runner.ts → executeJob → git commit/push → ___RESULT___
 */

import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, relative, resolve } from "path";

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
  /** Git ref used as the base for per-job worktrees */
  baseRef?: string;
}

export interface DockerJobResult {
  ok: boolean;
  summary: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
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

  constructor(options: DockerExecutorOptions) {
    this.options = {
      gitToken: "",
      timeoutMs: 60000,
      baseRef: "HEAD",
      ...options,
    };
    this.worktreeDir = resolve(this.options.repo, ".worktrees");

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
      const result = await this.runContainer(worktreePath, base64Spec, onLog);

      return result;
    } finally {
      // Step 4: Clean up worktree (always cleanup)
      await this.removeWorktree(worktreePath).catch((err) => {
        console.error(`[DockerExecutor] Failed to remove worktree: ${err}`);
      });
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
  private async runContainer(
    worktreePath: string,
    base64Spec: string,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<DockerJobResult> {
    const containerName = `pushpals-${this.options.workerId}-${Date.now()}`;

    // Mount repo root (not just the worktree path) so gitdir indirections
    // from worktrees can resolve to .git/worktrees/... inside the container.
    const dockerRepoPath = this.toDockerPath(this.options.repo);
    const worktreeRelPath = relative(this.options.repo, worktreePath).replace(/\\/g, "/");
    const containerWorktreePath = `/repo/${worktreeRelPath}`;

    const args: string[] = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--network",
      "none",
      "-v",
      `${dockerRepoPath}:/repo`,
      "-w",
      containerWorktreePath,
      "--stop-timeout",
      String(Math.floor(this.options.timeoutMs / 1000)),
    ];

    // Add git token if provided
    if (this.options.gitToken) {
      args.push("-e", `GIT_TOKEN=${this.options.gitToken}`);
    }

    // Add the image and base64 spec
    args.push(this.options.imageName, base64Spec);

    console.log(`[DockerExecutor] Starting container: ${containerName}`);

    const proc = Bun.spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Set up timeout
    const timer = setTimeout(() => {
      console.log(`[DockerExecutor] Job timeout, killing container: ${containerName}`);
      try {
        proc.kill();
        // Also try to kill the container directly
        Bun.spawn(["docker", "kill", containerName]);
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

    clearTimeout(timer);
    const exitCode = await proc.exited;

    // Parse result from stdout (look for ___RESULT___ sentinel)
    const result = this.parseResult(stdoutLines, stderrLines, exitCode);

    return result;
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
    return {
      ok: exitCode === 0,
      summary: exitCode === 0 ? "Job completed" : `Job failed (exit ${exitCode})`,
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
      exitCode,
    };
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
