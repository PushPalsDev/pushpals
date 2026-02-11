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
import { mkdirSync, rmSync } from "fs";
import { resolve } from "path";

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
   * Create a git worktree for isolated job execution
   */
  private async createWorktree(worktreePath: string): Promise<void> {
    // Create worktree from HEAD (detached)
    const proc = Bun.spawn(["git", "worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to create worktree: ${stderr}`);
    }

    console.log(`[DockerExecutor] Created worktree: ${worktreePath}`);
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

    // Convert Windows path to Docker path if needed
    const dockerWorktreePath = this.toDockerPath(worktreePath);

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
      `${dockerWorktreePath}:/workspace`,
      "-w",
      "/workspace",
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
    console.log(`[DockerExecutor] Pulling image: ${this.options.imageName}`);
    const proc = Bun.spawn(["docker", "pull", this.options.imageName], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`[DockerExecutor] Failed to pull image: ${stderr}`);
      return false;
    }

    console.log(`[DockerExecutor] Image pulled successfully`);
    return true;
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
