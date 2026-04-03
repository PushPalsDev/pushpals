import { describe, expect, test } from "bun:test";
import {
  collectPrunableEphemeralWorktrees,
  DockerExecutor,
  isEphemeralWorkerWorktreePath,
  parseGitWorktreeListPorcelain,
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
        context: { timedOutByDocker: boolean; elapsedMs: number },
      ) => {
        ok: boolean;
        summary: string;
      };
    };

    const terminated = executor.parseResult(["partial logs"], [], 143, {
      timedOutByDocker: false,
      elapsedMs: 500_000,
    });
    expect(terminated.ok).toBe(false);
    expect(terminated.summary).toContain("terminated (exit 143)");
    expect(terminated.summary).not.toContain("timed out in Docker executor");

    const timedOut = executor.parseResult(["partial logs"], [], 143, {
      timedOutByDocker: true,
      elapsedMs: 1_234_567,
    });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.summary).toContain("timed out in Docker executor");
    expect(timedOut.summary).toContain("1234567ms");
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

  test("rebuilds Docker image only for merge-conflict jobs", async () => {
    const executor = createExecutor() as unknown as {
      execute: (job: {
        id: string;
        taskId: string;
        kind: string;
        params: Record<string, unknown>;
        sessionId: string;
      }) => Promise<{ ok: boolean; summary: string }>;
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

    const mergeConflictResult = await executor.execute({
      id: "job-merge",
      taskId: "task-merge",
      kind: "task.execute",
      params: {
        reviewAgent: {
          resolutionType: "merge_conflict",
        },
      },
      sessionId: "dev",
    });
    expect(mergeConflictResult.ok).toBe(true);
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
  });
});
