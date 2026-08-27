import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DockerExecutor,
  addHostScmFinalizationUsage,
  bindDockerJobToDeadline,
  createDockerJobDeadlineLedger,
  dockerAbsoluteDeadlineResult,
  type DockerJobResult,
  type Job,
} from "../apps/workerpals/src/docker_executor";
import { UsageAccumulator } from "../apps/workerpals/src/quality_loop_durability";

const temporaryPaths: string[] = [];

function mustGit(repo: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.stdout));
  }
}

function temporaryGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pushpals-docker-deadline-"));
  temporaryPaths.push(repo);
  mustGit(repo, ["init"]);
  mustGit(repo, ["config", "user.name", "PushPals Test"]);
  mustGit(repo, ["config", "user.email", "pushpals@example.test"]);
  writeFileSync(join(repo, "README.md"), "deadline fixture\n");
  mustGit(repo, ["add", "README.md"]);
  mustGit(repo, ["commit", "-m", "test: initialize deadline fixture"]);
  return repo;
}

function deadlineJob(executionBudgetMs: number, finalizationBudgetMs: number): Job {
  return {
    id: "job-deadline",
    taskId: "task-deadline",
    kind: "task.execute",
    sessionId: "dev",
    params: {
      planning: {
        executionBudgetMs,
        finalizationBudgetMs,
      },
    },
  };
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Docker absolute job deadline", () => {
  test("caps every invocation against one ledger while preserving finalization reserve", () => {
    let now = 1_000;
    const job = deadlineJob(8_000, 2_000);
    const ledger = createDockerJobDeadlineLedger(30_000, job, {
      startedAtMs: now,
      now: () => now,
    });

    const first = bindDockerJobToDeadline(job, ledger);
    expect((first?.params.planning as Record<string, unknown>).executionBudgetMs).toBe(8_000);
    expect((first?.params.planning as Record<string, unknown>).finalizationBudgetMs).toBe(2_000);

    now += 3_250;
    const second = bindDockerJobToDeadline(job, ledger);
    expect((second?.params.planning as Record<string, unknown>).executionBudgetMs).toBe(4_750);
    expect((second?.params.planning as Record<string, unknown>).finalizationBudgetMs).toBe(2_000);

    now += 4_750;
    expect(bindDockerJobToDeadline(job, ledger)).toBeNull();
    expect(ledger.remainingTotalMs()).toBe(2_000);
  });

  test("outer retries receive only remaining work instead of minting a new planning budget", async () => {
    const repo = temporaryGitRepo();
    let now = 10_000;
    const originalDateNow = Date.now;
    Date.now = () => now;
    try {
      const executor = new DockerExecutor({
        repo,
        workerId: "workerpal-deadline",
        imageName: "pushpals-worker-sandbox:test",
        timeoutMs: 30_000,
      }) as unknown as {
        execute: DockerExecutor["execute"];
        jobRetryMaxAttempts: number;
        jobRetryBackoffMs: number;
        resolveWorktreeBaseRefForJob: () => Promise<string>;
        logExecutionConfig: () => void;
        runInWarmContainer: (worktreePath: string, job: Job) => Promise<DockerJobResult>;
        stopWarmContainer: () => Promise<void>;
        sleep: (ms: number) => Promise<void>;
        scheduleIdleShutdown: () => void;
      };
      executor.jobRetryMaxAttempts = 2;
      executor.jobRetryBackoffMs = 10;
      executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
      executor.logExecutionConfig = () => {};
      executor.stopWarmContainer = async () => {};
      executor.sleep = async (ms) => {
        now += ms;
      };
      executor.scheduleIdleShutdown = () => {};

      const observedExecutionBudgets: number[] = [];
      executor.runInWarmContainer = async (_worktreePath, boundedJob) => {
        observedExecutionBudgets.push(
          Number((boundedJob.params.planning as Record<string, unknown>).executionBudgetMs),
        );
        if (observedExecutionBudgets.length === 1) {
          now += 3_000;
          return {
            ok: false,
            summary: "connection reset while contacting warm runtime",
            stderr: "ECONNRESET",
          };
        }
        return {
          ok: false,
          summary: "candidate assertion failed",
          stderr: "expected true to be false",
          exitCode: 1,
        };
      };

      const result = await executor.execute(deadlineJob(8_000, 2_000));

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(observedExecutionBudgets).toEqual([8_000, 4_750]);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("exhausted work budget returns a typed timeout and does not start a retry", async () => {
    const repo = temporaryGitRepo();
    let now = 20_000;
    const originalDateNow = Date.now;
    Date.now = () => now;
    try {
      const executor = new DockerExecutor({
        repo,
        workerId: "workerpal-deadline",
        imageName: "pushpals-worker-sandbox:test",
        timeoutMs: 30_000,
      }) as unknown as {
        execute: DockerExecutor["execute"];
        jobRetryMaxAttempts: number;
        resolveWorktreeBaseRefForJob: () => Promise<string>;
        logExecutionConfig: () => void;
        runInWarmContainer: () => Promise<DockerJobResult>;
        scheduleIdleShutdown: () => void;
      };
      executor.jobRetryMaxAttempts = 2;
      executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
      executor.logExecutionConfig = () => {};
      executor.scheduleIdleShutdown = () => {};
      let attempts = 0;
      executor.runInWarmContainer = async () => {
        attempts += 1;
        now += 100;
        return {
          ok: false,
          summary: "connection reset while contacting warm runtime",
          stderr: "ECONNRESET",
        };
      };

      const result = await executor.execute(deadlineJob(100, 50));

      expect(attempts).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(124);
      expect(result.candidateState?.reason).toBe("absolute_job_deadline");
      expect(result.diagnostics?.terminal?.failureClass).toBe("timeout");
      expect(result.diagnostics?.metadata?.jobDeadline).toBeTruthy();
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("deadline outcome cannot be represented as ordinary success", () => {
    let now = 0;
    const job = deadlineJob(10, 5);
    const ledger = createDockerJobDeadlineLedger(30_000, job, {
      startedAtMs: now,
      now: () => now,
    });
    now = 15;

    const result = dockerAbsoluteDeadlineResult(job, ledger, "host finalization", {
      ok: true,
      summary: "late success",
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.summary).toContain("absolute deadline");
  });

  test("host finalization usage joins the cumulative attempt ledger", () => {
    const accumulator = new UsageAccumulator();
    addHostScmFinalizationUsage(
      accumulator,
      {
        usageAttempts: [
          {
            promptTokens: 7,
            completionTokens: 3,
            totalTokens: 10,
            stage: "finalization",
            attempt: 1,
            source: "commit_message",
          },
        ],
      },
      2,
    );

    expect(accumulator.total()?.totalTokens).toBe(10);
    expect(accumulator.attempts()).toMatchObject([
      {
        stage: "finalization",
        attempt: 1,
        source: "commit_message:host_scm_finalization_pass_2",
      },
    ]);
  });
});
