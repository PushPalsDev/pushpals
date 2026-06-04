import { describe, expect, test } from "bun:test";
import {
  collectPrunableEphemeralWorktrees,
  DockerExecutor,
  isEphemeralWorkerWorktreePath,
  parseGitWorktreeListPorcelain,
  resolveDockerJobTimeoutMs,
} from "../apps/workerpals/src/docker_executor";

function createExecutor() {
  return new DockerExecutor({
    repo: process.cwd(),
    workerId: "workerpal-test",
    imageName: "pushpals-worker-sandbox:latest",
    timeoutMs: 1_800_000,
  });
}

describe("workerpals docker executor internals", () => {
  test("readStream reassembles chunk-split lines", async () => {
    const executor = createExecutor() as unknown as {
      readStream: (
        readable: ReadableStream<Uint8Array>,
        streamName: "stdout" | "stderr",
        onLog: ((stream: "stdout" | "stderr", line: string) => void) | undefined,
        lines: string[],
      ) => Promise<void>;
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('___RESULT___ {"ok":true'));
        controller.enqueue(encoder.encode(',"summary":"ok"}\n'));
        controller.close();
      },
    });
    const lines: string[] = [];
    await executor.readStream(stream, "stdout", undefined, lines);
    expect(lines).toEqual(['___RESULT___ {"ok":true,"summary":"ok"}']);
  });

  test("parseResult only reports docker-timeout summary when docker timeout fired", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: { timedOutByDocker: boolean; elapsedMs: number; timeoutMs: number },
      ) => {
        ok: boolean;
        summary: string;
      };
    };

    const terminated = executor.parseResult(["partial logs"], [], 143, {
      timedOutByDocker: false,
      elapsedMs: 500_000,
      timeoutMs: 1_800_000,
    });
    expect(terminated.ok).toBe(false);
    expect(terminated.summary).toContain("terminated (exit 143)");
    expect(terminated.summary).not.toContain("timed out in Docker executor");

    const timedOut = executor.parseResult(["partial logs"], [], 143, {
      timedOutByDocker: true,
      elapsedMs: 1_234_567,
      timeoutMs: 14_400_000,
    });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.summary).toContain("timed out in Docker executor");
    expect(timedOut.summary).toContain("1234567ms");
    expect(timedOut.summary).toContain("14400000ms");
  });

  test("caps Docker timeout for browser-validation repair jobs", () => {
    const regularTimeout = resolveDockerJobTimeoutMs(1_860_000, {
      kind: "task.execute",
      params: {
        planning: {
          validationSteps: ["bun test", "bun x tsc --noEmit"],
          executionBudgetMs: 1_800_000,
          finalizationBudgetMs: 120_000,
        },
      },
    });
    expect(regularTimeout).toBe(1_860_000);

    const browserTimeout = resolveDockerJobTimeoutMs(7_260_000, {
      kind: "task.execute",
      params: {
        planning: {
          validationSteps: ["bun test", "bun run web:e2e"],
          executionBudgetMs: 1_800_000,
          finalizationBudgetMs: 120_000,
        },
      },
    });
    expect(browserTimeout).toBe(45 * 60_000);
  });

  test("retry matching no longer treats generic timeout words as transient", () => {
    const executor = createExecutor() as unknown as {
      matchesRetryablePattern: (text: string) => boolean;
    };

    expect(executor.matchesRetryablePattern("opened timeout_policy.ts for review")).toBe(false);
    expect(executor.matchesRetryablePattern("APITimeoutError: Request timed out")).toBe(true);
    expect(executor.matchesRetryablePattern("OpenHands wrapper timed out after 900000ms")).toBe(
      true,
    );
  });

  test("retry matching treats docker cwd races as transient", () => {
    const executor = createExecutor() as unknown as {
      matchesRetryablePattern: (text: string) => boolean;
    };

    expect(
      executor.matchesRetryablePattern(
        'OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd ("/repo/.worktrees/job-123") set in config.json failed: no such file or directory: unknown',
      ),
    ).toBe(true);
    expect(
      executor.matchesRetryablePattern(
        "worktree path not visible inside warm container after 5000ms: /repo/.worktrees/job-123",
      ),
    ).toBe(true);
  });

  test("worktree names stay short enough for Windows cleanup", () => {
    const executor = createExecutor() as unknown as {
      buildEphemeralWorktreeName: (prefix: "job" | "selfcheck", token: string) => string;
    };

    const jobName = executor.buildEphemeralWorktreeName(
      "job",
      "70a6e51e-485e-457c-9c76-07b1ca2b3246",
    );
    const selfcheckName = executor.buildEphemeralWorktreeName("selfcheck", "startup");

    expect(jobName).toMatch(/^job-70a6e51e-[a-z0-9]+-[a-z0-9]+$/);
    expect(jobName.length).toBeLessThanOrEqual(28);
    expect(selfcheckName).toMatch(/^selfcheck-startup-[a-z0-9]+-[a-z0-9]+$/);
    expect(selfcheckName.length).toBeLessThanOrEqual(32);
  });

  test("retry budget guard skips a second attempt after near-timeout execution", () => {
    const executor = createExecutor() as unknown as {
      hasBudgetForJobRetry: (
        attempt: number,
        attemptElapsedMs: number,
        timeoutMs: number,
        onLog?: (stream: "stdout" | "stderr", line: string) => void,
      ) => boolean;
    };
    const logs: string[] = [];

    expect(executor.hasBudgetForJobRetry(1, 2_690_000, 2_700_000, (stream, line) => {
      logs.push(`${stream}:${line}`);
    })).toBe(false);
    expect(logs.join("\n")).toContain("Skipping retry attempt 2");
    expect(executor.hasBudgetForJobRetry(1, 120_000, 2_700_000)).toBe(true);
  });

  test("writeJobSpecToStdin supports Web WritableStream stdin", async () => {
    const executor = createExecutor() as unknown as {
      writeJobSpecToStdin: (proc: { stdin?: WritableStream<Uint8Array> }, spec: string) => Promise<void>;
    };
    const chunks: string[] = [];
    let closed = false;
    const decoder = new TextDecoder();
    const stdin = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(decoder.decode(chunk));
      },
      close() {
        closed = true;
      },
    });

    await executor.writeJobSpecToStdin({ stdin }, "encoded-spec");

    expect(chunks).toEqual(["encoded-spec"]);
    expect(closed).toBe(true);
  });

  test("writeJobSpecToStdin supports Bun FileSink-style stdin", async () => {
    const executor = createExecutor() as unknown as {
      writeJobSpecToStdin: (
        proc: {
          stdin?: {
            write: (chunk: Uint8Array | string) => void;
            flush: () => void;
            end: () => void;
          };
        },
        spec: string,
      ) => Promise<void>;
    };
    const calls: string[] = [];
    const decoder = new TextDecoder();
    const stdin = {
      write(chunk: Uint8Array | string) {
        calls.push(`write:${typeof chunk === "string" ? chunk : decoder.decode(chunk)}`);
      },
      flush() {
        calls.push("flush");
      },
      end() {
        calls.push("end");
      },
    };

    await executor.writeJobSpecToStdin({ stdin }, "encoded-spec");

    expect(calls).toEqual(["write:encoded-spec", "flush", "end"]);
  });

  test("warm-container docker exec keeps stdin attached for spec streaming", () => {
    const executor = createExecutor() as unknown as {
      warmContainerName: string;
      buildWarmContainerExecArgs: (containerWorktreePath: string) => string[];
    };
    executor.warmContainerName = "pushpals-workerpal-test-warm";

    const args = executor.buildWarmContainerExecArgs("/repo/.worktrees/job-abc");

    expect(args.slice(0, 4)).toEqual(["exec", "-i", "-w", "/repo/.worktrees/job-abc"]);
    expect(args).toContain("--spec-stdin");
  });

  test("imageExists treats inspection timeouts as unavailable instead of hanging", async () => {
    const executor = createExecutor() as unknown as {
      imageExists: () => Promise<boolean>;
      runDockerCommandCapture: () => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut: boolean;
      }>;
    };

    executor.runDockerCommandCapture = async () => ({
      stdout: "",
      stderr: "",
      exitCode: -1,
      timedOut: true,
    });

    await expect(executor.imageExists()).resolves.toBe(false);
  });

  test("inspectImageRuntimeTag treats inspection timeouts as stale so rebuild can proceed", async () => {
    const executor = createExecutor() as unknown as {
      inspectImageRuntimeTag: () => Promise<string>;
      runDockerCommandCapture: () => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut: boolean;
      }>;
    };

    executor.runDockerCommandCapture = async () => ({
      stdout: "",
      stderr: "",
      exitCode: -1,
      timedOut: true,
    });

    await expect(executor.inspectImageRuntimeTag()).resolves.toBe("");
  });

  test("ensureWorktreeAccessibleInWarmContainer recycles the warm container after a visibility race", async () => {
    const executor = createExecutor() as unknown as {
      ensureWorktreeAccessibleInWarmContainer: (
        worktreePath: string,
        onLog?: (stream: "stdout" | "stderr", line: string) => void,
      ) => Promise<string>;
      ensureWarmContainer: () => Promise<void>;
      waitForWorktreePathInWarmContainer: (
        containerWorktreePath: string,
        timeoutMs?: number,
      ) => Promise<void>;
      runWarmWorktreeProbe: (containerWorktreePath: string) => Promise<{
        ok: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
      stopWarmContainer: (reason: string, quiet?: boolean) => Promise<void>;
      inspectWarmContainerState: () => Promise<string>;
    };

    let visibilityAttempts = 0;
    let stopCalls = 0;
    executor.ensureWarmContainer = async () => {};
    executor.waitForWorktreePathInWarmContainer = async () => {
      visibilityAttempts += 1;
      if (visibilityAttempts === 1) {
        throw new Error(
          "worktree path not visible inside warm container after 15000ms: /repo/.worktrees/job-123",
        );
      }
    };
    executor.runWarmWorktreeProbe = async () => ({
      ok: true,
      stdout: "true\n.git",
      stderr: "",
      exitCode: 0,
    });
    executor.stopWarmContainer = async () => {
      stopCalls += 1;
    };
    executor.inspectWarmContainerState = async () => "running=true";

    const result = await executor.ensureWorktreeAccessibleInWarmContainer(
      `${process.cwd()}\\.worktrees\\job-123`,
    );

    expect(result).toContain("/repo/.worktrees/job-123");
    expect(visibilityAttempts).toBe(2);
    expect(stopCalls).toBe(1);
  });

  test("ensureWarmRuntimeReady rebuilds when the warm image vanished locally", async () => {
    const executor = createExecutor() as unknown as {
      ensureWarmRuntimeReady: (
        job: {
          id: string;
          taskId: string;
          kind: string;
          params: Record<string, unknown>;
          sessionId: string;
        },
        onLog?: (stream: "stdout" | "stderr", line: string) => void,
      ) => Promise<void>;
      ensureWarmContainer: () => Promise<void>;
      ensureBackendWarmup: () => Promise<void>;
      pullImage: () => Promise<boolean>;
      stopWarmContainer: (reason: string, quiet?: boolean) => Promise<void>;
      sleep: (ms: number) => Promise<void>;
    };

    let warmContainerAttempts = 0;
    let pullCalls = 0;
    let stopCalls = 0;
    const logs: string[] = [];

    executor.ensureWarmContainer = async () => {
      warmContainerAttempts += 1;
      if (warmContainerAttempts === 1) {
        throw new Error(
          "Failed to start warm container (exit 125): Unable to find image 'pushpals-worker-sandbox:latest' locally docker: Error response from daemon: pull access denied for pushpals-worker-sandbox, repository does not exist or may require 'docker login': denied",
        );
      }
    };
    executor.ensureBackendWarmup = async () => {};
    executor.pullImage = async () => {
      pullCalls += 1;
      return true;
    };
    executor.stopWarmContainer = async () => {
      stopCalls += 1;
    };
    executor.sleep = async () => {};

    await executor.ensureWarmRuntimeReady(
      {
        id: "job-missing-image",
        taskId: "task-missing-image",
        kind: "task.execute",
        params: {},
        sessionId: "dev",
      },
      (stream, line) => logs.push(`${stream}:${line}`),
    );

    expect(warmContainerAttempts).toBe(2);
    expect(pullCalls).toBe(1);
    expect(stopCalls).toBe(1);
    expect(logs.join("\n")).toContain("is missing locally");
    expect(logs.join("\n")).toContain("retrying warm container startup");
  });

  test("openaiCodexAuthMountArgs ignores relative CODEX_HOME overrides that point into the repo", () => {
    const original = process.env.PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME;
    process.env.PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME = ".codex";
    try {
      const executor = createExecutor() as unknown as {
        openaiCodexAuthMountArgs: (backend: string) => string[];
      };
      const args = executor.openaiCodexAuthMountArgs("openai_codex");
      expect(args).toContain("-e");
      expect(args).toContain("CODEX_HOME=/root/.codex");
      const mountArg = args[1] ?? "";
      expect(mountArg.includes(`${process.cwd()}\\.codex`)).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME;
      } else {
        process.env.PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME = original;
      }
    }
  });

  test("validateWorktreeGitInterop validates warm-container accessibility too", async () => {
    const executor = createExecutor() as unknown as {
      validateWorktreeGitInterop: () => Promise<void>;
      createWorktree: (worktreePath: string, baseRef: string) => Promise<void>;
      runGitSelfCheckContainer: (worktreePath: string) => Promise<void>;
      ensureWorktreeAccessibleInWarmContainer: (worktreePath: string) => Promise<string>;
      removeWorktree: (worktreePath: string) => Promise<void>;
      options: { baseRef: string };
    };

    const calls: string[] = [];
    executor.createWorktree = async () => {
      calls.push("create");
    };
    executor.runGitSelfCheckContainer = async () => {
      calls.push("fresh");
    };
    executor.ensureWorktreeAccessibleInWarmContainer = async () => {
      calls.push("warm");
      return "/repo/.worktrees/selfcheck-startup";
    };
    executor.removeWorktree = async () => {
      calls.push("cleanup");
    };

    await executor.validateWorktreeGitInterop();

    expect(calls).toEqual(["create", "fresh", "warm", "cleanup"]);
  });

  test("links root dependency artifacts into ephemeral worktrees for browser hydration", async () => {
    const executor = createExecutor() as unknown as {
      ensureWorktreeDependencyArtifacts: (
        containerWorktreePath: string,
        onLog?: (stream: "stdout" | "stderr", line: string) => void,
      ) => Promise<void>;
      runWarmShell: (command: string) => Promise<{
        ok: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
    };

    let capturedCommand = "";
    const logs: string[] = [];
    executor.runWarmShell = async (command: string) => {
      capturedCommand = command;
      return {
        ok: true,
        stdout: " node_modules",
        stderr: "",
        exitCode: 0,
      };
    };

    await executor.ensureWorktreeDependencyArtifacts(
      "/repo/.worktrees/job-browser-smoke",
      (stream, line) => logs.push(`${stream}:${line}`),
    );

    expect(capturedCommand).toContain('src="/repo/$name"');
    expect(capturedCommand).toContain("node_modules");
    expect(capturedCommand).toContain("ln -s");
    expect(capturedCommand).toContain("/repo/.worktrees/job-browser-smoke/");
    expect(logs.join("\n")).toContain("Linked worktree dependency artifact(s): node_modules");
  });

  test("parseGitWorktreeListPorcelain extracts detached and prunable flags", () => {
    const parsed = parseGitWorktreeListPorcelain(
      [
        "worktree /repo",
        "HEAD 0123456789abcdef",
        "branch refs/heads/main",
        "",
        "worktree /repo/.worktrees/job-123",
        "HEAD fedcba9876543210",
        "detached",
        "prunable gitdir file points to non-existent location",
      ].join("\n"),
    );

    expect(parsed).toEqual([
      { path: "/repo", detached: false, prunable: false },
      { path: "/repo/.worktrees/job-123", detached: true, prunable: true },
    ]);
  });

  test("collectPrunableEphemeralWorktrees limits cleanup to stale managed entries", () => {
    const output = [
      "worktree /repo",
      "HEAD 1111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/job-active",
      "HEAD 2222222222222222",
      "detached",
      "",
      "worktree /repo/.worktrees/job-stale",
      "HEAD 3333333333333333",
      "detached",
      "prunable missing",
      "",
      "worktree /repo/.worktrees/selfcheck-stale",
      "HEAD 4444444444444444",
      "detached",
      "prunable missing",
      "",
      "worktree /repo/.worktrees/feature-scratch",
      "HEAD 5555555555555555",
      "detached",
      "prunable missing",
    ].join("\n");

    expect(isEphemeralWorkerWorktreePath("/repo/.worktrees/job-123")).toBe(true);
    expect(isEphemeralWorkerWorktreePath("/repo/.worktrees/selfcheck-abc")).toBe(true);
    expect(isEphemeralWorkerWorktreePath("/repo/.worktrees/feature-scratch")).toBe(false);

    expect(collectPrunableEphemeralWorktrees(output)).toEqual([
      "/repo/.worktrees/job-stale",
      "/repo/.worktrees/selfcheck-stale",
    ]);
  });

  test("execute decrements activeJobs when base ref resolution fails", async () => {
    const executor = createExecutor() as unknown as {
      execute: (job: {
        id: string;
        taskId: string;
        kind: string;
        params: Record<string, unknown>;
        sessionId: string;
      }) => Promise<unknown>;
      activeJobs: number;
      resolveWorktreeBaseRefForJob: () => Promise<string>;
      removeWorktree: () => Promise<void>;
    };

    executor.resolveWorktreeBaseRefForJob = async () => {
      throw new Error("boom");
    };
    executor.removeWorktree = async () => {};

    await expect(
      executor.execute({
        id: "job-1",
        taskId: "task-1",
        kind: "task.execute",
        params: {},
        sessionId: "dev",
      }),
    ).rejects.toThrow("boom");
    expect(executor.activeJobs).toBe(0);
  });

  test("prepares Docker image only for merge-conflict jobs and not inside execute", async () => {
    const executor = createExecutor() as unknown as {
      execute: (job: {
        id: string;
        taskId: string;
        kind: string;
        params: Record<string, unknown>;
        sessionId: string;
      }) => Promise<{ ok: boolean; summary: string }>;
      shouldPrepareMergeConflictJobBeforeExecution: (job: {
        id: string;
        taskId: string;
        kind: string;
        params: Record<string, unknown>;
        sessionId: string;
      }) => boolean;
      prepareMergeConflictJobEnvironment: (job: {
        id: string;
        taskId: string;
        kind: string;
        params: Record<string, unknown>;
        sessionId: string;
      }) => Promise<void>;
      rebuildImageForMergeConflictJob: () => Promise<void>;
      resolveWorktreeBaseRefForJob: () => Promise<string>;
      createWorktree: () => Promise<void>;
      logExecutionConfig: () => void;
      runInWarmContainer: () => Promise<{ ok: boolean; summary: string }>;
      removeWorktree: () => Promise<void>;
      scheduleIdleShutdown: () => void;
    };

    let rebuildCalls = 0;
    executor.rebuildImageForMergeConflictJob = async () => {
      rebuildCalls += 1;
    };
    executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
    executor.createWorktree = async () => {};
    executor.logExecutionConfig = () => {};
    executor.runInWarmContainer = async () => ({ ok: true, summary: "ok" });
    executor.removeWorktree = async () => {};
    executor.scheduleIdleShutdown = () => {};

    const mergeConflictJob = {
      id: "job-merge",
      taskId: "task-merge",
      kind: "task.execute",
      params: {
        reviewAgent: {
          resolutionType: "merge_conflict",
        },
      },
      sessionId: "dev",
    };
    expect(executor.shouldPrepareMergeConflictJobBeforeExecution(mergeConflictJob)).toBe(true);
    await executor.prepareMergeConflictJobEnvironment(mergeConflictJob);
    expect(executor.shouldPrepareMergeConflictJobBeforeExecution(mergeConflictJob)).toBe(false);
    expect(rebuildCalls).toBe(1);

    const regularResult = await executor.execute({
      id: "job-regular",
      taskId: "task-regular",
      kind: "task.execute",
      params: {},
      sessionId: "dev",
    });
    expect(regularResult.ok).toBe(true);
    expect(rebuildCalls).toBe(1);

    const mergeConflictExecuteResult = await executor.execute(mergeConflictJob);
    expect(mergeConflictExecuteResult.ok).toBe(true);
    expect(rebuildCalls).toBe(1);
    expect(executor.shouldPrepareMergeConflictJobBeforeExecution(mergeConflictJob)).toBe(true);
  });
});
