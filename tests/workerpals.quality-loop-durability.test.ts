import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildValidationExecutionDag,
  buildValidationExecutionPlan,
  checkpointJobCandidate,
  criticGateDisposition,
  enforceCriticEvidenceProvenance,
  runValidationCommandWithRepoLease,
  validationEvidenceId,
  withValidationExecutionPlanProvenance,
  type CriticOutcome,
} from "../apps/workerpals/src/execute_job";
import {
  JobDeadlineLedger,
  UsageAccumulator,
} from "../apps/workerpals/src/quality_loop_durability";
import {
  addHostScmReviewPassUsage,
  DockerExecutor,
  type DockerJobResult,
} from "../apps/workerpals/src/docker_executor";
import {
  buildDirectCommitFinalizationFailure,
  retainDirectFailureCandidate,
} from "../apps/workerpals/src/workerpals_main";

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function temporaryGitRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(repo);
  Bun.spawnSync(["git", "init"], { cwd: repo });
  Bun.spawnSync(["git", "config", "user.name", "PushPals Test"], { cwd: repo });
  Bun.spawnSync(["git", "config", "user.email", "pushpals-tests@example.com"], {
    cwd: repo,
  });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  Bun.spawnSync(["git", "add", "README.md"], { cwd: repo });
  Bun.spawnSync(["git", "commit", "-m", "chore: seed fixture"], { cwd: repo });
  return repo;
}

describe("WorkerPal absolute deadline and cumulative usage", () => {
  test("dedicated revisions and critics cannot mint time beyond finalization reserve", () => {
    let now = 1_000;
    const ledger = new JobDeadlineLedger({
      executionBudgetMs: 10_000,
      finalizationBudgetMs: 2_000,
      startedAtMs: now,
      now: () => now,
    });

    expect(ledger.deadlineAtMs).toBe(13_000);
    expect(ledger.executorBudgets(20_000, 10_000)).toEqual({
      executionBudgetMs: 10_000,
      finalizationBudgetMs: 2_000,
    });
    now = 11_000;
    expect(ledger.remainingWorkMs()).toBe(0);
    expect(ledger.capWorkTimeout(90_000)).toBe(0);
    expect(ledger.executorBudgets(420_000, 120_000)).toBeNull();
    expect(ledger.remainingTotalMs()).toBe(2_000);

    const zeroBudgetLedger = new JobDeadlineLedger({
      executionBudgetMs: 500,
      finalizationBudgetMs: 0,
      startedAtMs: now,
      now: () => now,
    });
    expect(zeroBudgetLedger.deadlineAtMs).toBe(11_500);
    expect(zeroBudgetLedger.capWorkTimeout(0)).toBe(0);
    expect(zeroBudgetLedger.executorBudgets(0, 0)).toBeNull();
  });

  test("preserves executor, recovery, and timed-out critic usage on a failed terminal path", () => {
    const usage = new UsageAccumulator();
    usage.add(
      { promptTokens: 100, completionTokens: 20, totalTokens: 120, backend: "codex" },
      { stage: "executor", attempt: 1, source: "codex" },
    );
    usage.add(
      { promptTokens: 70, completionTokens: 10, totalTokens: 80, backend: "codex" },
      { stage: "executor_recovery", attempt: 2, source: "codex" },
    );
    usage.add(
      {
        promptTokens: 30,
        completionTokens: 0,
        totalTokens: 30,
        backend: "quality_critic_codex",
        estimated: true,
      },
      { stage: "critic", attempt: 1, source: "quality_critic_codex", timedOut: true },
    );

    const terminal = usage.apply({ ok: false, summary: "critic timeout", exitCode: 124 });
    expect(terminal.usage).toMatchObject({
      promptTokens: 200,
      completionTokens: 30,
      totalTokens: 230,
      backend: "mixed",
      estimated: true,
    });
    expect(terminal.usageAttempts).toHaveLength(3);
    expect(terminal.usageAttempts?.map((attempt) => attempt.stage)).toEqual([
      "executor",
      "executor_recovery",
      "critic",
    ]);
    expect(terminal.usageAttempts?.[2]?.timedOut).toBe(true);
  });

  test("preserves attempt provenance across host-owned review passes", () => {
    const usage = new UsageAccumulator();
    addHostScmReviewPassUsage(
      usage,
      {
        usageAttempts: [
          {
            promptTokens: 12,
            completionTokens: 3,
            totalTokens: 15,
            stage: "executor",
            attempt: 1,
            source: "openai_codex",
          },
        ],
      },
      1,
    );
    addHostScmReviewPassUsage(
      usage,
      {
        usageAttempts: [
          {
            promptTokens: 8,
            completionTokens: 2,
            totalTokens: 10,
            stage: "executor_recovery",
            attempt: 1,
            source: "openai_codex",
          },
        ],
      },
      2,
    );

    const terminal = usage.apply({ ok: false, summary: "review repair exhausted" });
    expect(terminal.usage?.totalTokens).toBe(25);
    expect(terminal.usageAttempts?.map(({ attempt, source }) => ({ attempt, source }))).toEqual([
      { attempt: 1, source: "openai_codex:host_scm_pass_1" },
      { attempt: 2, source: "openai_codex:host_scm_pass_2" },
    ]);
  });

  test("repo validation lease wait consumes the same absolute work deadline", async () => {
    const repo = temporaryGitRepo("pushpals-validation-lease-deadline-");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { validate: "bun test && bun run typecheck" } }),
    );
    const leaseDir = join(repo, ".git", "pushpals", "validation-lease");
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(
      join(leaseDir, "owner.json"),
      JSON.stringify({
        owner: "another-worker",
        command: "bun run validate",
        heartbeatVersion: 1,
        heartbeatAt: new Date().toISOString(),
        pid: process.pid,
        host: String(process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? ""),
      }),
    );
    const ledger = new JobDeadlineLedger({
      executionBudgetMs: 40,
      finalizationBudgetMs: 20,
    });

    const startedAt = Date.now();
    const run = await runValidationCommandWithRepoLease(
      repo,
      "bun run validate",
      60_000,
      {},
      undefined,
      ledger,
    );

    expect(run.ok).toBe(false);
    expect(run.exitCode).toBe(124);
    expect(run.failureClass).toBe("deadline");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(ledger.remainingTotalMs()).toBeLessThanOrEqual(20);
  });
});

describe("typed critic outcomes", () => {
  const revisionBudgetSkip: CriticOutcome = {
    kind: "skipped",
    reason: "revision_budget",
    usageAttempts: [],
  };

  test("keeps the a592 deterministic skip on the revision path instead of calling it unavailable", () => {
    expect(
      criticGateDisposition({
        outcome: revisionBudgetSkip,
        criticGateEnabled: true,
        deterministicRequiresRevision: true,
        criticMinScore: 8.5,
      }),
    ).toBe("revise");
    expect(
      criticGateDisposition({
        outcome: revisionBudgetSkip,
        criticGateEnabled: true,
        deterministicRequiresRevision: false,
        criticMinScore: 8.5,
      }),
    ).toBe("hold_candidate");
  });

  test("does not let unsupported critic validation claims drive a revision", () => {
    const validationRun = {
      step: "bun test",
      command: "bun test",
      ok: true,
      exitCode: 0,
      stdout: "1548 pass",
      stderr: "",
      elapsedMs: 100,
    };
    const evidenceId = validationEvidenceId(validationRun);
    const review = enforceCriticEvidenceProvenance(
      {
        score: 6.8,
        findings: [
          "107 tests failed, so the patch is unsafe.",
          `Validation passed cleanly [evidence:${evidenceId}].`,
          "The public API name is unclear.",
        ],
        mustFix: ["Fix all failing tests before publication."],
        revisionGuidance: "Run the failing test command again.",
        raw: "{}",
      },
      { validationRuns: [validationRun] },
    );

    expect(review.findings).toEqual([
      `Validation passed cleanly [evidence:${evidenceId}].`,
      "The public API name is unclear.",
    ]);
    expect(review.mustFix).toEqual([]);
    expect(review.revisionGuidance).toBe("");
    expect(review.unsupportedFindings).toContain("107 tests failed, so the patch is unsafe.");
  });

  test("binds critic evidence IDs to the exact command outcome", () => {
    const passed = validationEvidenceId({
      command: "bun test tests/example.test.ts",
      ok: true,
      exitCode: 0,
      stdout: "12 pass",
      stderr: "",
    });
    const failed = validationEvidenceId({
      command: "bun test tests/example.test.ts",
      ok: false,
      exitCode: 1,
      stdout: "11 pass, 1 fail",
      stderr: "Expected true to be false",
    });

    expect(passed).not.toBe(failed);
  });
});

describe("validation capability DAG", () => {
  test("retains runnable children when a Docker-dependent aggregate is deferred", () => {
    const repo = temporaryGitRepo("pushpals-validation-dag-");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify(
        {
          scripts: {
            test: "bun test tests/unit.test.ts",
            validate: "bun run test && docker compose up --wait",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const previousCapability = process.env.PUSHPALS_WORKER_DOCKER_CAPABILITY;
    process.env.PUSHPALS_WORKER_DOCKER_CAPABILITY = "unavailable";
    try {
      expect(buildValidationExecutionDag(repo, ["bun run test", "bun run validate"])).toEqual([
        "bun run test",
        "bun run validate",
      ]);
      const plan = buildValidationExecutionPlan(repo, ["bun run test", "bun run validate"]);
      expect(plan.map(({ command, capability }) => ({ command, capability }))).toEqual([
        { command: "bun run test", capability: "worker" },
        { command: "bun run validate", capability: "trusted_host" },
      ]);
      expect(
        withValidationExecutionPlanProvenance(
          {
            step: "bun run validate",
            command: "bun run validate",
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "Docker daemon unavailable",
            elapsedMs: 0,
          },
          plan[1],
        ),
      ).toMatchObject({
        plannedEvidenceId: plan[1]?.evidenceId,
        capability: "trusted_host",
        subsumes: ["bun run test"],
      });
    } finally {
      if (previousCapability === undefined) delete process.env.PUSHPALS_WORKER_DOCKER_CAPABILITY;
      else process.env.PUSHPALS_WORKER_DOCKER_CAPABILITY = previousCapability;
    }
  });
});

describe("candidate retention", () => {
  test("checkpoints a held candidate under an exact durable Git ref", async () => {
    const repo = temporaryGitRepo("pushpals-candidate-checkpoint-");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "candidate.ts"), "export const retained = true;\n", "utf8");

    const retained = await checkpointJobCandidate(
      repo,
      "worker-test",
      { id: "job-timeout", kind: "task.execute" },
      {
        status: "partial",
        reason: "executor_timeout",
        changedPaths: ["src/candidate.ts"],
      },
    );

    expect(retained.checkpoint?.ref).toBe("refs/pushpals/candidates/worker-test/job-timeout");
    expect(retained.checkpoint?.sha).toMatch(/^[0-9a-f]{40}$/);
    const resolved = Bun.spawnSync(["git", "rev-parse", `${retained.checkpoint?.ref}^{commit}`], {
      cwd: repo,
    });
    expect(resolved.exitCode).toBe(0);
    expect(String(resolved.stdout).trim()).toBe(retained.checkpoint?.sha);
    const content = Bun.spawnSync(["git", "show", `${retained.checkpoint?.sha}:src/candidate.ts`], {
      cwd: repo,
    });
    expect(String(content.stdout)).toContain("retained = true");
  });

  test("retains an already-committed candidate when finalization failed after commit", async () => {
    const repo = temporaryGitRepo("pushpals-committed-candidate-checkpoint-");
    const baseline = String(
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout,
    ).trim();
    writeFileSync(join(repo, "committed.ts"), "export const committed = true;\n");
    Bun.spawnSync(["git", "add", "committed.ts"], { cwd: repo });
    Bun.spawnSync(["git", "commit", "-m", "candidate before ref failure"], { cwd: repo });

    const retained = await checkpointJobCandidate(
      repo,
      "worker-committed",
      { id: "job-committed", kind: "task.execute" },
      { status: "held", reason: "commit_finalization_failed", changedPaths: [] },
      undefined,
      baseline,
    );

    expect(retained.changedPaths).toEqual(["committed.ts"]);
    expect(retained.checkpoint?.sha).toBe(
      String(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout).trim(),
    );
  });

  test("turns an ordinary direct commit-finalization error into a truthful failure", () => {
    const failed = buildDirectCommitFinalizationFailure(
      { ok: true, summary: "executor completed", exitCode: 0 },
      "Failed to store worker commit ref",
    );
    expect(failed.ok).toBe(false);
    expect(failed.exitCode).toBe(4);
    expect(failed.candidateState?.reason).toBe("commit_finalization_failed");
    expect(failed.stderr).toContain("Failed to store worker commit ref");
  });

  test("retains a direct-mode timeout before its isolated worktree is removed", async () => {
    const repo = temporaryGitRepo("pushpals-direct-candidate-checkpoint-");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "direct-partial.ts"), "export const direct = true;\n");

    const retained = await retainDirectFailureCandidate(
      {
        ok: false,
        summary: "direct executor timed out",
        exitCode: 124,
        candidateState: {
          status: "partial",
          reason: "executor_timeout",
          changedPaths: ["src/direct-partial.ts"],
        },
      },
      repo,
      "worker-direct",
      { id: "job-direct-timeout", kind: "task.execute" },
    );

    expect(retained.candidateState?.checkpoint?.ref).toBe(
      "refs/pushpals/candidates/worker-direct/job-direct-timeout",
    );
    const content = Bun.spawnSync(
      ["git", "show", `${retained.candidateState?.checkpoint?.sha}:src/direct-partial.ts`],
      { cwd: repo },
    );
    expect(content.exitCode).toBe(0);
    expect(String(content.stdout)).toContain("direct = true");
  });

  test("Docker checkpoints a partial candidate before removing its disposable worktree", async () => {
    const repo = temporaryGitRepo("pushpals-docker-candidate-checkpoint-");
    const executor = new DockerExecutor({
      repo,
      workerId: "workerpal-test",
      imageName: "pushpals-worker-sandbox:test",
      timeoutMs: 30_000,
    }) as unknown as {
      execute: DockerExecutor["execute"];
      jobRetryMaxAttempts: number;
      resolveWorktreeBaseRefForJob: () => Promise<string>;
      logExecutionConfig: () => void;
      runInWarmContainer: (worktreePath: string) => Promise<DockerJobResult>;
      removeWorktree: (worktreePath: string) => Promise<void>;
      scheduleIdleShutdown: () => void;
    };
    executor.jobRetryMaxAttempts = 1;
    executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
    executor.logExecutionConfig = () => {};
    executor.runInWarmContainer = async (worktreePath) => {
      mkdirSync(join(worktreePath, "src"), { recursive: true });
      writeFileSync(join(worktreePath, "src", "partial.ts"), "export const partial = true;\n");
      return {
        ok: false,
        summary: "executor timed out with a partial candidate",
        exitCode: 124,
        candidateState: {
          status: "partial",
          reason: "executor_timeout",
          changedPaths: ["src/partial.ts"],
        },
      };
    };
    let checkpointExistedBeforeCleanup = false;
    executor.removeWorktree = async (worktreePath) => {
      const ref = "refs/pushpals/candidates/workerpal-test/job-partial";
      const resolved = Bun.spawnSync(["git", "rev-parse", `${ref}^{commit}`], { cwd: repo });
      checkpointExistedBeforeCleanup = resolved.exitCode === 0;
      Bun.spawnSync(["git", "worktree", "remove", "--force", "--force", worktreePath], {
        cwd: repo,
      });
      rmSync(worktreePath, { recursive: true, force: true });
    };
    executor.scheduleIdleShutdown = () => {};

    const result = await executor.execute({
      id: "job-partial",
      taskId: "task-partial",
      kind: "task.execute",
      params: {},
      sessionId: "dev",
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(checkpointExistedBeforeCleanup).toBe(true);
    expect(result.candidateState?.checkpoint?.ref).toBe(
      "refs/pushpals/candidates/workerpal-test/job-partial",
    );
    const retained = Bun.spawnSync(
      ["git", "show", `${result.candidateState?.checkpoint?.sha}:src/partial.ts`],
      { cwd: repo },
    );
    expect(retained.exitCode).toBe(0);
    expect(String(retained.stdout)).toContain("partial = true");
  });

  test("Docker attaches a retained candidate to an execution exception before cleanup", async () => {
    const repo = temporaryGitRepo("pushpals-docker-exception-checkpoint-");
    const executor = new DockerExecutor({
      repo,
      workerId: "workerpal-test",
      imageName: "pushpals-worker-sandbox:test",
      timeoutMs: 30_000,
    }) as unknown as {
      execute: DockerExecutor["execute"];
      jobRetryMaxAttempts: number;
      resolveWorktreeBaseRefForJob: () => Promise<string>;
      logExecutionConfig: () => void;
      runInWarmContainer: (worktreePath: string) => Promise<DockerJobResult>;
      removeWorktree: (worktreePath: string) => Promise<void>;
      scheduleIdleShutdown: () => void;
    };
    executor.jobRetryMaxAttempts = 1;
    executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
    executor.logExecutionConfig = () => {};
    executor.runInWarmContainer = async (worktreePath) => {
      mkdirSync(join(worktreePath, "src"), { recursive: true });
      writeFileSync(join(worktreePath, "src", "crashed.ts"), "export const survived = true;\n");
      throw new Error("executor transport crashed after editing");
    };
    let checkpointExistedBeforeCleanup = false;
    executor.removeWorktree = async (worktreePath) => {
      const ref = "refs/pushpals/candidates/workerpal-test/job-crashed";
      checkpointExistedBeforeCleanup =
        Bun.spawnSync(["git", "rev-parse", `${ref}^{commit}`], { cwd: repo }).exitCode === 0;
      Bun.spawnSync(["git", "worktree", "remove", "--force", "--force", worktreePath], {
        cwd: repo,
      });
      rmSync(worktreePath, { recursive: true, force: true });
    };
    executor.scheduleIdleShutdown = () => {};

    let thrown:
      | (Error & { candidateState?: { checkpoint?: { ref: string; sha: string } } })
      | null = null;
    try {
      await executor.execute({
        id: "job-crashed",
        taskId: "task-crashed",
        kind: "task.execute",
        params: {},
        sessionId: "dev",
      });
    } catch (error) {
      thrown = error as Error & { candidateState?: { checkpoint?: { ref: string; sha: string } } };
    }

    expect(thrown?.message).toContain("executor transport crashed after editing");
    expect(checkpointExistedBeforeCleanup).toBe(true);
    expect(thrown?.candidateState?.checkpoint?.ref).toBe(
      "refs/pushpals/candidates/workerpal-test/job-crashed",
    );
    const retained = Bun.spawnSync(
      ["git", "show", `${thrown?.candidateState?.checkpoint?.sha}:src/crashed.ts`],
      { cwd: repo },
    );
    expect(retained.exitCode).toBe(0);
    expect(String(retained.stdout)).toContain("survived = true");
  });

  test("Docker preserves the physical worktree when candidate checkpointing fails", async () => {
    const repo = temporaryGitRepo("pushpals-docker-checkpoint-failure-");
    const hookPath = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(hookPath, 0o755);
    const executor = new DockerExecutor({
      repo,
      workerId: "workerpal-test",
      imageName: "pushpals-worker-sandbox:test",
      timeoutMs: 30_000,
    }) as unknown as {
      execute: DockerExecutor["execute"];
      jobRetryMaxAttempts: number;
      resolveWorktreeBaseRefForJob: () => Promise<string>;
      logExecutionConfig: () => void;
      runInWarmContainer: (worktreePath: string) => Promise<DockerJobResult>;
      removeWorktree: (worktreePath: string) => Promise<void>;
      scheduleIdleShutdown: () => void;
    };
    executor.jobRetryMaxAttempts = 1;
    executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
    executor.logExecutionConfig = () => {};
    let worktreePath = "";
    executor.runInWarmContainer = async (path) => {
      worktreePath = path;
      writeFileSync(join(path, "candidate.ts"), "export const physical = true;\n");
      return {
        ok: false,
        summary: "candidate needs retention",
        candidateState: {
          status: "held",
          reason: "terminal_failure",
          changedPaths: ["candidate.ts"],
        },
      };
    };
    let cleanupCalled = false;
    executor.removeWorktree = async () => {
      cleanupCalled = true;
    };
    executor.scheduleIdleShutdown = () => {};

    const result = await executor.execute({
      id: "job-checkpoint-failure",
      taskId: "task-checkpoint-failure",
      kind: "task.execute",
      params: {},
      sessionId: "dev",
    });

    expect(result.ok).toBe(false);
    expect(cleanupCalled).toBe(false);
    expect(existsSync(worktreePath)).toBe(true);
    expect(result.stderr).toContain("preserving disposable worktree for recovery");
  });
});
