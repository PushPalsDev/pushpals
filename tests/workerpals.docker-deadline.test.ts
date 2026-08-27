import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DockerExecutor,
  addDockerTransportAttemptUsage,
  addHostScmFinalizationUsage,
  addHostScmReviewPassUsage,
  attachHostScmUsageToError,
  bindDockerJobToDeadline,
  createDockerJobDeadlineLedger,
  dockerAbsoluteDeadlineResult,
  resolveDockerContainerTransportTimeoutMs,
  resolveDockerJobDeadlineBudgets,
  type DockerJobResult,
  type Job,
} from "../apps/workerpals/src/docker_executor";
import { createJobCommit } from "../apps/workerpals/src/execute_job";
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
  test("reserves bounded cleanup time for planning-less legacy and warmup jobs", () => {
    const legacyTask = {
      id: "legacy-task",
      taskId: "legacy-task",
      kind: "task.execute",
      sessionId: "dev",
      params: {},
    } satisfies Job;
    const warmup = {
      id: "warmup",
      taskId: "warmup",
      kind: "warmup.execute",
      sessionId: "dev",
      params: {},
    } satisfies Job;

    expect(resolveDockerJobDeadlineBudgets(10_000, legacyTask)).toEqual({
      executionBudgetMs: 8_000,
      finalizationBudgetMs: 2_000,
    });
    expect(resolveDockerJobDeadlineBudgets(10_000, warmup)).toEqual({
      executionBudgetMs: 8_000,
      finalizationBudgetMs: 2_000,
    });
    expect(resolveDockerJobDeadlineBudgets(1_000_000, legacyTask)).toEqual({
      executionBudgetMs: 880_000,
      finalizationBudgetMs: 120_000,
    });

    let now = 0;
    const legacyLedger = createDockerJobDeadlineLedger(10_000, legacyTask, {
      startedAtMs: now,
      now: () => now,
      monotonicNow: () => now,
    });
    expect(resolveDockerContainerTransportTimeoutMs(10_000, legacyTask, legacyLedger)).toBe(8_000);
    const plannedLedger = createDockerJobDeadlineLedger(10_000, deadlineJob(8_000, 2_000), {
      startedAtMs: now,
      now: () => now,
      monotonicNow: () => now,
    });
    expect(
      resolveDockerContainerTransportTimeoutMs(10_000, deadlineJob(8_000, 2_000), plannedLedger),
    ).toBe(10_000);
  });

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
      stopWarmContainer: (reason: string, quiet: boolean, timeoutMs?: number) => Promise<void>;
      sleep: (ms: number) => Promise<void>;
      scheduleIdleShutdown: () => void;
      deadlineWallNow: () => number;
      deadlineMonotonicNow: () => number;
    };
    executor.deadlineWallNow = () => now;
    executor.deadlineMonotonicNow = () => now;
    executor.jobRetryMaxAttempts = 2;
    executor.jobRetryBackoffMs = 10;
    executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
    executor.logExecutionConfig = () => {};
    const observedRecoveryBudgets: number[] = [];
    executor.stopWarmContainer = async (_reason, _quiet, timeoutMs) => {
      observedRecoveryBudgets.push(Number(timeoutMs));
    };
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
          usageAttempts: [
            {
              promptTokens: 7,
              completionTokens: 3,
              totalTokens: 10,
              stage: "executor",
              attempt: 1,
              source: "codex:first",
            },
          ],
        };
      }
      return {
        ok: false,
        summary: "candidate assertion failed",
        stderr: "expected true to be false",
        exitCode: 1,
        usageAttempts: [
          {
            promptTokens: 11,
            completionTokens: 9,
            totalTokens: 20,
            stage: "executor_recovery",
            attempt: 1,
            source: "codex:second",
          },
        ],
      };
    };

    const result = await executor.execute(deadlineJob(8_000, 2_000));

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(observedExecutionBudgets).toEqual([8_000, 4_750]);
    expect(observedRecoveryBudgets).toEqual([4_750]);
    expect(result.usage?.totalTokens).toBe(30);
    expect(result.usageAttempts).toMatchObject([
      { attempt: 1, source: "codex:first:docker_transport_attempt_1" },
      { attempt: 2, source: "codex:second:docker_transport_attempt_2" },
    ]);
  });

  test("host worktree preparation consumes the same outer work budget", async () => {
    const repo = temporaryGitRepo();
    let now = 15_000;
    const executor = new DockerExecutor({
      repo,
      workerId: "workerpal-preparation-deadline",
      imageName: "pushpals-worker-sandbox:test",
      timeoutMs: 30_000,
    }) as unknown as {
      execute: DockerExecutor["execute"];
      resolveWorktreeBaseRefForJob: () => Promise<string>;
      createWorktree: () => Promise<void>;
      runInWarmContainer: () => Promise<DockerJobResult>;
      cleanupContainerDependencyProjection: () => Promise<void>;
      removeWorktree: () => Promise<void>;
      scheduleIdleShutdown: () => void;
      deadlineWallNow: () => number;
      deadlineMonotonicNow: () => number;
    };
    executor.deadlineWallNow = () => now;
    executor.deadlineMonotonicNow = () => now;
    executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
    executor.createWorktree = async () => {
      now += 100;
      throw new Error("synthetic host worktree setup timeout");
    };
    let containerAttempts = 0;
    executor.runInWarmContainer = async () => {
      containerAttempts += 1;
      return { ok: true, summary: "must not run" };
    };
    executor.cleanupContainerDependencyProjection = async () => {};
    executor.removeWorktree = async () => {};
    executor.scheduleIdleShutdown = () => {};

    const result = await executor.execute(deadlineJob(100, 50));

    expect(containerAttempts).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.diagnostics?.terminal?.metadata?.absoluteDeadlineStage).toBe(
      "host/Docker preparation",
    );
  });

  test("planning-less setup timeout reconciles an already registered worktree", async () => {
    const repo = temporaryGitRepo();
    let now = 18_000;
    const executor = new DockerExecutor({
      repo,
      workerId: "workerpal-legacy-setup-timeout",
      imageName: "pushpals-worker-sandbox:test",
      timeoutMs: 10_000,
    }) as unknown as {
      execute: DockerExecutor["execute"];
      resolveWorktreeBaseRefForJob: () => Promise<string>;
      createWorktree: (worktreePath: string) => Promise<void>;
      cleanupContainerDependencyProjection: () => Promise<void>;
      scheduleIdleShutdown: () => void;
      deadlineWallNow: () => number;
      deadlineMonotonicNow: () => number;
    };
    executor.deadlineWallNow = () => now;
    executor.deadlineMonotonicNow = () => now;
    executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
    let registeredWorktreePath = "";
    executor.createWorktree = async (worktreePath) => {
      registeredWorktreePath = worktreePath;
      mustGit(repo, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
      expect(readFileSync(join(worktreePath, "README.md"), "utf8")).toContain("deadline fixture");
      // Exhaust both the unplanned work allowance and its reserve. The
      // cleanup path must still perform one bounded reconciliation turn.
      now += 10_000;
      throw new Error("synthetic setup timeout after git registered the worktree");
    };
    executor.cleanupContainerDependencyProjection = async () => {};
    executor.scheduleIdleShutdown = () => {};

    const result = await executor.execute({
      id: "legacy-setup-timeout",
      taskId: "legacy-setup-timeout",
      kind: "task.execute",
      params: {},
      sessionId: "dev",
    });

    expect(result).toMatchObject({ ok: false, exitCode: 124 });
    expect(registeredWorktreePath).not.toBe("");
    expect(existsSync(registeredWorktreePath)).toBe(false);
    const listed = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: repo });
    expect(listed.exitCode).toBe(0);
    expect(String(listed.stdout).replace(/\\/g, "/")).not.toContain(
      registeredWorktreePath.replace(/\\/g, "/"),
    );
  });

  test("planning-less container timeout leaves its reserve for ordinary worktree cleanup", async () => {
    const repo = temporaryGitRepo();
    let now = 24_000;
    const executor = new DockerExecutor({
      repo,
      workerId: "workerpal-legacy-container-timeout",
      imageName: "pushpals-worker-sandbox:test",
      timeoutMs: 10_000,
    }) as unknown as {
      execute: DockerExecutor["execute"];
      jobRetryMaxAttempts: number;
      resolveWorktreeBaseRefForJob: () => Promise<string>;
      createWorktree: (
        worktreePath: string,
        baseRef: string,
        deadline: ReturnType<typeof createDockerJobDeadlineLedger>,
      ) => Promise<void>;
      runInWarmContainer: (
        worktreePath: string,
        job: Job,
        onLog: undefined,
        deadline: ReturnType<typeof createDockerJobDeadlineLedger>,
      ) => Promise<DockerJobResult>;
      removeWorktree: (
        worktreePath: string,
        deadline: ReturnType<typeof createDockerJobDeadlineLedger>,
        options?: { ensureReconciliation?: boolean },
      ) => Promise<void>;
      cleanupContainerDependencyProjection: () => Promise<void>;
      scheduleIdleShutdown: () => void;
      logExecutionConfig: () => void;
      deadlineWallNow: () => number;
      deadlineMonotonicNow: () => number;
    };
    executor.deadlineWallNow = () => now;
    executor.deadlineMonotonicNow = () => now;
    executor.jobRetryMaxAttempts = 1;
    executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
    executor.logExecutionConfig = () => {};
    executor.cleanupContainerDependencyProjection = async () => {};
    executor.scheduleIdleShutdown = () => {};

    let worktreePath = "";
    const createWorktree = executor.createWorktree.bind(executor);
    executor.createWorktree = async (path, baseRef, deadline) => {
      worktreePath = path;
      await createWorktree(path, baseRef, deadline);
    };

    let transportBudgetMs = 0;
    executor.runInWarmContainer = async (_path, boundedJob, _onLog, deadline) => {
      transportBudgetMs = resolveDockerContainerTransportTimeoutMs(10_000, boundedJob, deadline);
      now += transportBudgetMs;
      return {
        ok: false,
        summary: "synthetic legacy container timeout",
        stderr: "container transport reached the work deadline",
        exitCode: 124,
      };
    };

    let cleanupReserveMs = 0;
    const removeWorktree = executor.removeWorktree.bind(executor);
    executor.removeWorktree = async (path, deadline, options) => {
      cleanupReserveMs = deadline.remainingTotalMs();
      await removeWorktree(path, deadline, options);
    };

    const result = await executor.execute({
      id: "legacy-container-timeout",
      taskId: "legacy-container-timeout",
      kind: "task.execute",
      params: {},
      sessionId: "dev",
    });

    expect(result).toMatchObject({ ok: false, exitCode: 124 });
    expect(transportBudgetMs).toBe(8_000);
    expect(cleanupReserveMs).toBe(2_000);
    expect(worktreePath).not.toBe("");
    expect(existsSync(worktreePath)).toBe(false);
    const listed = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: repo });
    expect(String(listed.stdout).replace(/\\/g, "/")).not.toContain(
      worktreePath.replace(/\\/g, "/"),
    );
  });

  test("preserves prior model usage when a later Docker recovery throws", async () => {
    const repo = temporaryGitRepo();
    const executor = new DockerExecutor({
      repo,
      workerId: "workerpal-thrown-usage",
      imageName: "pushpals-worker-sandbox:test",
      timeoutMs: 30_000,
    }) as unknown as {
      execute: DockerExecutor["execute"];
      jobRetryMaxAttempts: number;
      resolveWorktreeBaseRefForJob: () => Promise<string>;
      logExecutionConfig: () => void;
      runInWarmContainer: () => Promise<DockerJobResult>;
      stopWarmContainer: () => Promise<void>;
      sleep: () => Promise<void>;
      scheduleIdleShutdown: () => void;
    };
    executor.jobRetryMaxAttempts = 2;
    executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
    executor.logExecutionConfig = () => {};
    executor.stopWarmContainer = async () => {};
    executor.sleep = async () => {};
    executor.scheduleIdleShutdown = () => {};
    let attempts = 0;
    executor.runInWarmContainer = async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          summary: "connection reset while contacting warm runtime",
          stderr: "ECONNRESET",
          usageAttempts: [
            {
              promptTokens: 13,
              completionTokens: 7,
              totalTokens: 20,
              stage: "executor",
              attempt: 1,
              source: "codex:before_recovery",
            },
          ],
        };
      }
      throw new Error("non-retryable recovery failure");
    };

    let thrown: (Error & { usage?: { totalTokens: number }; usageAttempts?: unknown[] }) | null =
      null;
    try {
      await executor.execute(deadlineJob(8_000, 2_000));
    } catch (error) {
      thrown = error as Error & { usage?: { totalTokens: number }; usageAttempts?: unknown[] };
    }

    expect(attempts).toBe(2);
    expect(thrown?.message).toContain("non-retryable recovery failure");
    expect(thrown?.usage?.totalTokens).toBe(20);
    expect(thrown?.usageAttempts).toHaveLength(1);
  });

  test("warm-runtime setup cannot continue into visibility or dependency work after expiry", async () => {
    const repo = temporaryGitRepo();
    let now = 30_000;
    const job = deadlineJob(100, 50);
    const ledger = createDockerJobDeadlineLedger(30_000, job, {
      startedAtMs: now,
      now: () => now,
    });
    const executor = new DockerExecutor({
      repo,
      workerId: "workerpal-warm-deadline",
      imageName: "pushpals-worker-sandbox:test",
      timeoutMs: 30_000,
    }) as unknown as {
      runInWarmContainer: (
        worktreePath: string,
        boundedJob: Job,
        onLog: undefined,
        deadline: ReturnType<typeof createDockerJobDeadlineLedger>,
      ) => Promise<DockerJobResult>;
      ensureWarmRuntimeReady: () => Promise<void>;
      ensureWorktreeAccessibleInWarmContainer: () => Promise<string>;
      ensureWorktreeDependencyArtifacts: () => Promise<never>;
    };
    executor.ensureWarmRuntimeReady = async () => {
      now += 100;
    };
    let visibilityProbes = 0;
    executor.ensureWorktreeAccessibleInWarmContainer = async () => {
      visibilityProbes += 1;
      return "/repo/.worktrees/job";
    };
    executor.ensureWorktreeDependencyArtifacts = async () => {
      throw new Error("dependency preparation must not start");
    };

    const result = await executor.runInWarmContainer(repo, job, undefined, ledger);

    expect(visibilityProbes).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.diagnostics?.terminal?.metadata?.absoluteDeadlineStage).toBe(
      "warm-runtime setup",
    );
  });

  test("exhausted work budget returns a typed timeout and does not start a retry", async () => {
    const repo = temporaryGitRepo();
    let now = 20_000;
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
      deadlineWallNow: () => number;
      deadlineMonotonicNow: () => number;
    };
    executor.deadlineWallNow = () => now;
    executor.deadlineMonotonicNow = () => now;
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

  test("host finalization refuses to mutate Git after the shared total deadline", async () => {
    const repo = temporaryGitRepo();
    writeFileSync(join(repo, "README.md"), "late candidate\n");
    let now = 0;
    const job = deadlineJob(10, 5);
    const ledger = createDockerJobDeadlineLedger(30_000, job, {
      startedAtMs: now,
      now: () => now,
    });
    now = 15;

    const result = await createJobCommit(
      repo,
      "workerpal-deadline",
      {
        id: job.id,
        taskId: job.taskId,
        kind: "task.execute",
        params: { path: "README.md" },
        sessionId: job.sessionId,
        context: "host",
      },
      undefined,
      ledger,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("absolute job finalization deadline expired");
    const staged = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: repo });
    expect(staged.exitCode).toBe(0);
    const unstaged = Bun.spawnSync(["git", "diff", "--quiet"], { cwd: repo });
    expect(unstaged.exitCode).toBe(1);
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

  test("a thrown later host-SCM pass retains every earlier usage attempt", () => {
    const hostAccumulator = new UsageAccumulator();
    addHostScmReviewPassUsage(
      hostAccumulator,
      {
        usageAttempts: [
          {
            promptTokens: 11,
            completionTokens: 4,
            totalTokens: 15,
            stage: "executor",
            attempt: 1,
            source: "codex:first_pass",
          },
        ],
      },
      1,
    );
    const laterError = Object.assign(new Error("second pass transport failed"), {
      usageAttempts: [
        {
          promptTokens: 7,
          completionTokens: 3,
          totalTokens: 10,
          stage: "executor_recovery" as const,
          attempt: 1,
          source: "codex:second_pass",
        },
      ],
    });

    const propagated = attachHostScmUsageToError(hostAccumulator, laterError, 2);
    const outerAccumulator = new UsageAccumulator();
    addDockerTransportAttemptUsage(outerAccumulator, propagated, 1);

    expect(propagated).toBe(laterError);
    expect(propagated.usage?.totalTokens).toBe(25);
    expect(propagated.usageAttempts).toHaveLength(2);
    expect(outerAccumulator.total()?.totalTokens).toBe(25);
    expect(outerAccumulator.attempts()).toHaveLength(2);
  });

  test("captures preparation baselines and retains failures before disposable cleanup", () => {
    const dockerSource = readFileSync(
      join(process.cwd(), "apps", "workerpals", "src", "docker_executor.ts"),
      "utf8",
    );
    const executeStart = dockerSource.indexOf("async execute(");
    const baselineCapture = dockerSource.indexOf(
      "worktreeBaselineSha = baseline.stdout.trim()",
      executeStart,
    );
    const hostPreparation = dockerSource.indexOf(
      "const prepared = await prepareMergeConflictWorktreeOnHost(",
      executeStart,
    );
    expect(baselineCapture).toBeGreaterThan(executeStart);
    expect(hostPreparation).toBeGreaterThan(baselineCapture);

    const directSource = readFileSync(
      join(process.cwd(), "apps", "workerpals", "src", "workerpals_main.ts"),
      "utf8",
    );
    const preparationCatch = directSource.indexOf("catch (preparationError)");
    const candidateRetention = directSource.indexOf(
      "result = await retainDirectFailureCandidate(",
      preparationCatch,
    );
    const terminalPersistence = directSource.indexOf(
      "const persistence = await persistWorkerTerminalStatus(",
      candidateRetention,
    );
    const preparationContinue = directSource.indexOf("continue;", terminalPersistence);
    expect(candidateRetention).toBeGreaterThan(preparationCatch);
    expect(terminalPersistence).toBeGreaterThan(candidateRetention);
    expect(preparationContinue).toBeGreaterThan(terminalPersistence);
  });

  test("direct telemetry is emitted only after host finalization usage and duration are complete", () => {
    const source = readFileSync(
      join(process.cwd(), "apps", "workerpals", "src", "workerpals_main.ts"),
      "utf8",
    );
    const directCommit = source.indexOf("const commitResult = await createJobCommit(");
    const finalizationUsage = source.indexOf(
      "usageAccumulator.addAttempts(commitResult.usageAttempts)",
      directCommit,
    );
    const duration = source.indexOf("const jobDurationMs =", directCommit);
    const usageReport = source.indexOf("await reportWorkerLlmUsage(", directCommit);

    expect(directCommit).toBeGreaterThan(-1);
    expect(finalizationUsage).toBeGreaterThan(directCommit);
    expect(duration).toBeGreaterThan(finalizationUsage);
    expect(usageReport).toBeGreaterThan(duration);
  });
});
