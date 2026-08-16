import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionQueue } from "../apps/server/src/completions";
import { JobQueue } from "../apps/server/src/jobs";

const tempDirs: string[] = [];

afterEach(async () => {
  Bun.gc(true);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await Bun.sleep(25 * attempt);
      }
    }
    if (lastError && existsSync(dir)) {
      console.warn(`[test cleanup] deferred locked completion fixture cleanup: ${dir}`);
    }
  }
});

function createSharedQueues(): {
  jobs: JobQueue;
  completions: CompletionQueue;
  jobId: string;
  dbPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-completion-lifecycle-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "pushpals.db");
  const jobs = new JobQueue(dbPath);
  const completions = new CompletionQueue(dbPath);
  const enqueued = jobs.enqueue({
    taskId: "task-publication",
    sessionId: "dev",
    kind: "task.execute",
    params: {},
    dedupeKey: "publication:test",
  });
  const jobId = String(enqueued.jobId ?? "");
  expect(jobId).not.toBe("");
  expect(jobs.claim("worker-publication").job?.id).toBe(jobId);
  return { jobs, completions, jobId, dbPath };
}

function enqueueClaimedJob(jobs: JobQueue, suffix: string): string {
  const enqueued = jobs.enqueue({
    taskId: `task-${suffix}`,
    sessionId: "dev",
    kind: "task.execute",
    params: {},
    dedupeKey: `publication:${suffix}`,
  });
  const jobId = String(enqueued.jobId ?? "");
  expect(jobId).not.toBe("");
  expect(jobs.claim(`worker-${suffix}`).job?.id).toBe(jobId);
  return jobId;
}

function trustedValidationReport(options: {
  ok: boolean;
  command?: string;
  candidateSha: string;
  baselineSha?: string;
  output?: string;
  exitCode?: number;
  failureClass?:
    | "dependency_setup_failed"
    | "test_failure"
    | "timeout"
    | "trusted_validation_failed";
  failedTests?: string[];
  targetPathHints?: string[];
}): Record<string, unknown> {
  const command = options.command ?? "bun run validate:publish";
  const failedTests = options.failedTests ?? ["mandatory account state machine"];
  const targetPathHints = options.targetPathHints ?? ["tests/account.test.ts"];
  return {
    version: 1,
    baselineSha: options.baselineSha ?? "baseline-sha",
    candidateSha: options.candidateSha,
    results: [
      {
        ok: options.ok,
        command,
        output:
          options.output ??
          (options.ok
            ? "1141 pass, 0 fail"
            : "tests/account.test.ts:\n(fail) mandatory account state machine"),
        exitCode: options.ok ? 0 : (options.exitCode ?? 1),
        durationMs: 1_000,
        phase: "validation",
        ...(options.ok
          ? {}
          : {
              failureClass: options.failureClass ?? "test_failure",
              failedTests,
              targetPathHints,
            }),
      },
    ],
  };
}

describe("server CompletionQueue PR URL persistence", () => {
  test("keeps a handed-off candidate nonterminal until publication succeeds", () => {
    const { jobs, completions, jobId } = createSharedQueues();
    const handoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        commitSha: "abc123",
        branch: "refs/pushpals/agent/worker/job-publication",
        message: "candidate retained",
        jobResultSummary: "implemented the requested change",
      },
      { beginJobFinalization: true },
    );

    expect(handoff).toMatchObject({ ok: true, jobStatus: "finalizing" });
    expect(
      completions.enqueue(
        {
          jobId,
          sessionId: "dev",
          commitSha: "abc123",
          branch: "refs/pushpals/agent/worker/job-publication",
          message: "candidate retained",
        },
        { beginJobFinalization: true },
      ),
    ).toMatchObject({
      ok: true,
      completionId: handoff.completionId,
      deduped: true,
      jobStatus: "finalizing",
    });
    expect(jobs.getJob(jobId)?.status).toBe("finalizing");
    expect(jobs.countByStatus()).toMatchObject({ finalizing: 1, completed: 0 });
    expect(jobs.countByPriority()).toMatchObject({ normal: 1 });
    expect(
      jobs.enqueue({
        taskId: "task-publication-duplicate",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
        dedupeKey: "publication:test",
      }),
    ).toMatchObject({ ok: true, deduped: true, jobId });
    expect(jobs.claim("worker-next").ok).toBe(false);

    const claimed = completions.claim("scm-publication");
    const completed = completions.markProcessedAndFinalizeJob(
      claimed.completion?.id ?? "",
      "https://github.com/org/repo/pull/42",
      {
        installDurationMs: 12_345,
        validationDurationMs: 54_321,
        installCacheHit: true,
      },
    );
    expect(completed).toMatchObject({ ok: true, jobId, jobTransitioned: true });
    expect(jobs.getJob(jobId)).toMatchObject({
      status: "completed",
      prUrl: "https://github.com/org/repo/pull/42",
      error: null,
    });
    expect(jobs.getJobDiagnostics(jobId).terminal).toMatchObject({
      status: "completed",
      failureClass: "success",
      terminalStage: "publication",
    });
    expect(completions.getCompletion(claimed.completion?.id ?? "")).toMatchObject({
      trustedInstallDurationMs: 12_345,
      trustedValidationDurationMs: 54_321,
      trustedValidationCacheHit: 1,
    });
    expect(
      completions.markProcessedAndFinalizeJob(
        claimed.completion?.id ?? "",
        "https://github.com/org/repo/pull/42",
      ),
    ).toMatchObject({ ok: true, jobTransitioned: false });

    completions.close();
    jobs.close();
  });

  test("turns trusted-environment validation failure into publish_blocked, never completed", () => {
    const { jobs, completions, jobId } = createSharedQueues();
    const handoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        commitSha: "def456",
        branch: "refs/pushpals/agent/worker/job-validation",
        message: "candidate retained",
        trustedValidationCommands: ["bun run validate:publish"],
        jobResultSummary: "host validation required",
      },
      { beginJobFinalization: true },
    );
    const completionId = handoff.completionId ?? "";
    expect(jobs.getJob(jobId)?.status).toBe("finalizing");
    expect(completions.claim("scm-validation").completion?.id).toBe(completionId);

    const failed = completions.markFailedAndBlockJob(
      completionId,
      "bun run validate:publish exited with code 1",
      {
        installDurationMs: 7_654,
        validationDurationMs: 32_100,
        installCacheHit: false,
      },
      {
        version: 1,
        baselineSha: "base123",
        candidateSha: "spoofed-candidate",
        results: [
          {
            ok: false,
            command: "bun run validate:publish",
            output:
              "account/__tests__/AccountContext.test.tsx:\n(fail) mandatory AccountProvider state machine > fails account deletion locally when the account API is not configured [7ms]",
            exitCode: 1,
            durationMs: 32_100,
            phase: "validation",
            failureClass: "test_failure",
            failedTests: [
              "mandatory AccountProvider state machine > fails account deletion locally when the account API is not configured",
            ],
            targetPathHints: ["account/__tests__/AccountContext.test.tsx"],
          },
          {
            ok: false,
            command: "bun run unrelated",
            output: "(fail) unrelated callback command",
            exitCode: 1,
            durationMs: 100,
            phase: "validation",
          },
        ],
      },
    );
    expect(failed).toMatchObject({ ok: true, jobId, jobTransitioned: true });
    expect(jobs.getJob(jobId)).toMatchObject({
      status: "publish_blocked",
      completedAt: null,
    });
    expect(jobs.countByStatus()).toMatchObject({ completed: 0, publish_blocked: 1 });
    expect(jobs.getJobDiagnostics(jobId).terminal).toMatchObject({
      status: "publish_blocked",
      failureClass: "trusted_validation_failed",
      terminalStage: "trusted_environment_validation",
    });
    expect(completions.markFailedAndBlockJob(completionId, "duplicate callback")).toMatchObject({
      ok: true,
      jobTransitioned: false,
    });
    const validationRuns = jobs.getJobDiagnostics(jobId).validationRuns as Array<
      Record<string, unknown>
    >;
    expect(validationRuns).toHaveLength(1);
    expect(validationRuns[0]).toMatchObject({
      command: "bun run validate:publish",
      passed: false,
      failureClass: "test_failure",
      metadata: {
        source: "trusted_host",
        completionId,
        baselineSha: "base123",
        candidateSha: "def456",
        failureFingerprint: expect.any(String),
        failedTests: [
          "mandatory AccountProvider state machine > fails account deletion locally when the account API is not configured",
        ],
        targetPathHints: ["account/__tests__/AccountContext.test.tsx"],
      },
    });
    expect(completions.getCompletion(completionId)).toMatchObject({
      trustedInstallDurationMs: 7_654,
      trustedValidationDurationMs: 32_100,
      trustedValidationCacheHit: 0,
    });

    completions.close();
    jobs.close();
  });

  test("requeues a retained transient same-baseline failure after a later trusted-host pass", () => {
    const { jobs, completions, jobId } = createSharedQueues();
    const blockedHandoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        commitSha: "blocked-candidate",
        branch: "refs/pushpals/agent/worker/blocked-candidate",
        message: "candidate retained",
        trustedValidationCommands: ["bun run validate:publish"],
        jobResultSummary: "host validation required",
      },
      { beginJobFinalization: true },
    );
    const blockedCompletionId = blockedHandoff.completionId ?? "";
    expect(completions.claim("scm-blocked").completion?.id).toBe(blockedCompletionId);
    expect(
      completions.markFailedAndBlockJob(
        blockedCompletionId,
        "bun run validate:publish exited with code 1",
        undefined,
        trustedValidationReport({
          ok: false,
          candidateSha: "blocked-candidate",
          output: "Command timed out after 480000ms; terminated process tree.",
          exitCode: 124,
          failureClass: "timeout",
          failedTests: [],
          targetPathHints: [],
        }),
      ),
    ).toMatchObject({ ok: true, jobId, jobTransitioned: true });
    expect(jobs.getJob(jobId)?.status).toBe("publish_blocked");

    const repairJobId = enqueueClaimedJob(jobs, "baseline-repair");
    const repairHandoff = completions.enqueue(
      {
        jobId: repairJobId,
        sessionId: "dev",
        commitSha: "repair-candidate",
        branch: "refs/pushpals/agent/worker/repair-candidate",
        message: "baseline repaired",
        trustedValidationCommands: ["bun run validate:publish"],
      },
      { beginJobFinalization: true },
    );
    const repairCompletionId = repairHandoff.completionId ?? "";
    expect(completions.claim("scm-repair").completion?.id).toBe(repairCompletionId);
    const repaired = completions.markProcessedAndFinalizeJob(
      repairCompletionId,
      "https://github.com/org/repo/pull/repair",
      undefined,
      trustedValidationReport({ ok: true, candidateSha: "repair-candidate" }),
    );

    expect(repaired).toMatchObject({
      ok: true,
      jobId: repairJobId,
      jobTransitioned: true,
      requeuedCompletionIds: [blockedCompletionId],
      requeuedJobIds: [jobId],
    });
    expect(jobs.getJob(repairJobId)?.status).toBe("completed");
    expect(jobs.getJob(jobId)).toMatchObject({
      status: "finalizing",
      error: null,
      publishBlockedAt: null,
      durationMs: null,
    });
    expect(jobs.getJobDiagnostics(jobId).terminal).toBeNull();
    expect(completions.getCompletion(blockedCompletionId)).toMatchObject({
      status: "pending",
      pusherId: null,
      error: null,
      trustedValidationRecoveryAttempts: 1,
    });
    expect(completions.claim("scm-recovered").completion).toMatchObject({
      id: blockedCompletionId,
      jobId,
      commitSha: "blocked-candidate",
      trustedValidationRecoveryAttempts: 1,
    });

    completions.close();
    jobs.close();
  });

  test("startup reconciliation recovers blockers when the trusted pass was already persisted", () => {
    const { jobs, completions: initialCompletions, jobId, dbPath } = createSharedQueues();
    let completions = initialCompletions;
    const blockedHandoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        commitSha: "blocked-before-restart",
        branch: "refs/pushpals/agent/worker/blocked-before-restart",
        message: "candidate retained",
        trustedValidationCommands: ["bun run validate:publish"],
      },
      { beginJobFinalization: true },
    );
    const blockedCompletionId = blockedHandoff.completionId ?? "";
    expect(completions.claim("scm-blocked").completion?.id).toBe(blockedCompletionId);
    expect(
      completions.markFailedAndBlockJob(
        blockedCompletionId,
        "validate failed",
        undefined,
        trustedValidationReport({
          ok: false,
          candidateSha: "blocked-before-restart",
          output: "Command timed out after 480000ms; terminated process tree.",
          exitCode: 124,
          failureClass: "timeout",
          failedTests: [],
          targetPathHints: [],
        }),
      ).ok,
    ).toBe(true);

    const passedJobId = enqueueClaimedJob(jobs, "persisted-host-pass");
    expect(jobs.complete(passedJobId, { summary: "trusted host validation passed" }).ok).toBe(true);
    const db = new Database(dbPath);
    const failedAt = db
      .prepare(`SELECT MAX(createdAt) AS createdAt FROM job_validation_runs WHERE jobId = ?`)
      .get(jobId) as { createdAt: string };
    const passedAt = new Date(Date.parse(failedAt.createdAt) + 1_000).toISOString();
    db.prepare(
      `INSERT INTO job_validation_runs (
         jobId, attempt, command, exitCode, durationMs, passed, failureClass,
         stdoutTail, stderrTail, metadataJson, createdAt
       ) VALUES (?, NULL, ?, 0, 1000, 1, NULL, ?, NULL, ?, ?)`,
    ).run(
      passedJobId,
      "bun run validate:publish",
      "1141 pass, 0 fail",
      JSON.stringify({
        source: "trusted_host",
        completionId: "persisted-pass",
        baselineSha: "baseline-sha",
        failedTests: [],
      }),
      passedAt,
    );
    db.close();
    completions.close();

    completions = new CompletionQueue(dbPath);
    expect(jobs.getJob(jobId)).toMatchObject({
      status: "finalizing",
      error: null,
      publishBlockedAt: null,
    });
    expect(completions.getCompletion(blockedCompletionId)).toMatchObject({
      status: "pending",
      trustedValidationRecoveryAttempts: 1,
    });
    expect(completions.claim("scm-after-restart").completion?.id).toBe(blockedCompletionId);

    completions.close();
    jobs.close();
  });

  test("does not recover a blocker from an unrelated or unrequested passing command", () => {
    const { jobs, completions, jobId } = createSharedQueues();
    const blockedHandoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        commitSha: "blocked-validate",
        branch: "refs/pushpals/agent/worker/blocked-validate",
        message: "candidate retained",
        trustedValidationCommands: ["bun run validate:publish"],
      },
      { beginJobFinalization: true },
    );
    const blockedCompletionId = blockedHandoff.completionId ?? "";
    expect(completions.claim("scm-blocked").completion?.id).toBe(blockedCompletionId);
    expect(
      completions.markFailedAndBlockJob(
        blockedCompletionId,
        "validate failed",
        undefined,
        trustedValidationReport({ ok: false, candidateSha: "blocked-validate" }),
      ).ok,
    ).toBe(true);

    const unrelatedJobId = enqueueClaimedJob(jobs, "unrelated-pass");
    const unrelatedHandoff = completions.enqueue(
      {
        jobId: unrelatedJobId,
        sessionId: "dev",
        commitSha: "unrelated-candidate",
        branch: "refs/pushpals/agent/worker/unrelated-candidate",
        message: "typecheck passed",
        trustedValidationCommands: ["bun run typecheck"],
      },
      { beginJobFinalization: true },
    );
    const unrelatedCompletionId = unrelatedHandoff.completionId ?? "";
    expect(completions.claim("scm-unrelated").completion?.id).toBe(unrelatedCompletionId);
    const processed = completions.markProcessedAndFinalizeJob(
      unrelatedCompletionId,
      null,
      undefined,
      {
        version: 1,
        baselineSha: "baseline-sha",
        candidateSha: "unrelated-candidate",
        results: [
          {
            ok: true,
            command: "bun run typecheck",
            output: "typecheck passed",
            exitCode: 0,
            durationMs: 500,
            phase: "validation",
          },
          {
            ok: true,
            command: "bun run validate:publish",
            output: "unrequested callback result",
            exitCode: 0,
            durationMs: 500,
            phase: "validation",
          },
        ],
      },
    );

    expect(processed.requeuedCompletionIds).toBeUndefined();
    expect(jobs.getJob(jobId)?.status).toBe("publish_blocked");
    expect(completions.getCompletion(blockedCompletionId)).toMatchObject({
      status: "failed",
      trustedValidationRecoveryAttempts: 0,
    });

    completions.close();
    jobs.close();
  });

  test("does not recover a candidate-specific test failure after the same command passes elsewhere", () => {
    const { jobs, completions, jobId } = createSharedQueues();
    const blockedHandoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        commitSha: "candidate-test-failure",
        branch: "refs/pushpals/agent/worker/candidate-test-failure",
        message: "candidate retained",
        trustedValidationCommands: ["bun run validate:publish"],
      },
      { beginJobFinalization: true },
    );
    const blockedCompletionId = blockedHandoff.completionId ?? "";
    expect(completions.claim("scm-blocked").completion?.id).toBe(blockedCompletionId);
    expect(
      completions.markFailedAndBlockJob(
        blockedCompletionId,
        "named test failed",
        undefined,
        trustedValidationReport({ ok: false, candidateSha: "candidate-test-failure" }),
      ).ok,
    ).toBe(true);

    const passingJobId = enqueueClaimedJob(jobs, "unrelated-same-command-pass");
    const passingHandoff = completions.enqueue(
      {
        jobId: passingJobId,
        sessionId: "dev",
        commitSha: "unrelated-passing-candidate",
        branch: "refs/pushpals/agent/worker/unrelated-passing-candidate",
        message: "unrelated candidate passed",
        trustedValidationCommands: ["bun run validate:publish"],
      },
      { beginJobFinalization: true },
    );
    const passingCompletionId = passingHandoff.completionId ?? "";
    expect(completions.claim("scm-passing").completion?.id).toBe(passingCompletionId);
    const processed = completions.markProcessedAndFinalizeJob(
      passingCompletionId,
      null,
      undefined,
      trustedValidationReport({ ok: true, candidateSha: "unrelated-passing-candidate" }),
    );

    expect(processed.requeuedCompletionIds).toBeUndefined();
    expect(jobs.getJob(jobId)?.status).toBe("publish_blocked");
    expect(completions.getCompletion(blockedCompletionId)).toMatchObject({
      status: "failed",
      trustedValidationRecoveryAttempts: 0,
    });

    completions.close();
    jobs.close();
  });

  test("does not recover a transient failure when the passing baseline differs", () => {
    const { jobs, completions, jobId } = createSharedQueues();
    const blockedHandoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        commitSha: "old-baseline-timeout",
        branch: "refs/pushpals/agent/worker/old-baseline-timeout",
        message: "candidate retained",
        trustedValidationCommands: ["bun run validate:publish"],
      },
      { beginJobFinalization: true },
    );
    const blockedCompletionId = blockedHandoff.completionId ?? "";
    expect(completions.claim("scm-blocked").completion?.id).toBe(blockedCompletionId);
    expect(
      completions.markFailedAndBlockJob(
        blockedCompletionId,
        "validation timed out",
        undefined,
        trustedValidationReport({
          ok: false,
          candidateSha: "old-baseline-timeout",
          baselineSha: "old-baseline",
          output: "Command timed out after 480000ms; terminated process tree.",
          exitCode: 124,
          failureClass: "timeout",
          failedTests: [],
          targetPathHints: [],
        }),
      ).ok,
    ).toBe(true);

    const passingJobId = enqueueClaimedJob(jobs, "new-baseline-pass");
    const passingHandoff = completions.enqueue(
      {
        jobId: passingJobId,
        sessionId: "dev",
        commitSha: "new-baseline-candidate",
        branch: "refs/pushpals/agent/worker/new-baseline-candidate",
        message: "new baseline passed",
        trustedValidationCommands: ["bun run validate:publish"],
      },
      { beginJobFinalization: true },
    );
    const passingCompletionId = passingHandoff.completionId ?? "";
    expect(completions.claim("scm-passing").completion?.id).toBe(passingCompletionId);
    const processed = completions.markProcessedAndFinalizeJob(
      passingCompletionId,
      null,
      undefined,
      trustedValidationReport({
        ok: true,
        candidateSha: "new-baseline-candidate",
        baselineSha: "new-baseline",
      }),
    );

    expect(processed.requeuedCompletionIds).toBeUndefined();
    expect(jobs.getJob(jobId)?.status).toBe("publish_blocked");
    expect(completions.getCompletion(blockedCompletionId)).toMatchObject({
      status: "failed",
      trustedValidationRecoveryAttempts: 0,
    });

    completions.close();
    jobs.close();
  });

  test("caps automatic trusted-validation recovery attempts", () => {
    const { jobs, completions, jobId, dbPath } = createSharedQueues();
    const blockedHandoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        commitSha: "retry-exhausted",
        branch: "refs/pushpals/agent/worker/retry-exhausted",
        message: "candidate retained",
        trustedValidationCommands: ["bun run validate:publish"],
      },
      { beginJobFinalization: true },
    );
    const blockedCompletionId = blockedHandoff.completionId ?? "";
    expect(completions.claim("scm-blocked").completion?.id).toBe(blockedCompletionId);
    expect(
      completions.markFailedAndBlockJob(
        blockedCompletionId,
        "validate failed",
        undefined,
        trustedValidationReport({
          ok: false,
          candidateSha: "retry-exhausted",
          output: "Command timed out after 480000ms; terminated process tree.",
          exitCode: 124,
          failureClass: "timeout",
          failedTests: [],
          targetPathHints: [],
        }),
      ).ok,
    ).toBe(true);
    const db = new Database(dbPath);
    db.prepare(`UPDATE completions SET trustedValidationRecoveryAttempts = 1 WHERE id = ?`).run(
      blockedCompletionId,
    );
    db.close();

    const repairJobId = enqueueClaimedJob(jobs, "repair-after-cap");
    const repairHandoff = completions.enqueue(
      {
        jobId: repairJobId,
        sessionId: "dev",
        commitSha: "repair-after-cap",
        branch: "refs/pushpals/agent/worker/repair-after-cap",
        message: "baseline repaired",
        trustedValidationCommands: ["bun run validate:publish"],
      },
      { beginJobFinalization: true },
    );
    const repairCompletionId = repairHandoff.completionId ?? "";
    expect(completions.claim("scm-repair").completion?.id).toBe(repairCompletionId);
    const repaired = completions.markProcessedAndFinalizeJob(
      repairCompletionId,
      null,
      undefined,
      trustedValidationReport({ ok: true, candidateSha: "repair-after-cap" }),
    );

    expect(repaired.requeuedCompletionIds).toBeUndefined();
    expect(jobs.getJob(jobId)?.status).toBe("publish_blocked");
    expect(completions.getCompletion(blockedCompletionId)).toMatchObject({
      status: "failed",
      trustedValidationRecoveryAttempts: 1,
    });

    completions.close();
    jobs.close();
  });

  test("rejects an invalid handoff without moving the claimed job", () => {
    const { jobs, completions, jobId } = createSharedQueues();
    const handoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        message: "candidate retained",
        trustedValidationCommands: ["bun test && powershell -Command Remove-Item"],
      },
      { beginJobFinalization: true },
    );

    expect(handoff.ok).toBe(false);
    expect(jobs.getJob(jobId)?.status).toBe("claimed");
    expect(completions.getPendingCompletions()).toHaveLength(0);
    completions.close();
    jobs.close();
  });

  test("repairs legacy completed jobs whose persisted completion already failed", () => {
    const dir = mkdtempSync(join(tmpdir(), "pushpals-completion-legacy-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "pushpals.db");
    const jobs = new JobQueue(dbPath);
    let completions = new CompletionQueue(dbPath);
    const enqueued = jobs.enqueue({
      taskId: "task-legacy",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    const jobId = String(enqueued.jobId ?? "");
    expect(jobs.claim("worker-legacy").job?.id).toBe(jobId);
    const handoff = completions.enqueue({
      jobId,
      sessionId: "dev",
      message: "legacy candidate",
    });
    expect(jobs.complete(jobId, { summary: "premature success" }).ok).toBe(true);
    expect(completions.claim("scm-legacy").completion?.id).toBe(handoff.completionId);
    expect(completions.markFailed(handoff.completionId ?? "", "merge failed").ok).toBe(true);
    expect(jobs.getJob(jobId)?.status).toBe("completed");

    completions.close();
    completions = new CompletionQueue(dbPath);
    expect(jobs.getJob(jobId)).toMatchObject({
      status: "publish_blocked",
      completedAt: null,
    });
    expect(jobs.getJobDiagnostics(jobId).terminal).toMatchObject({
      status: "publish_blocked",
      failureClass: "publication_failed",
    });
    completions.close();
    jobs.close();
  });

  test("persists trusted-validation handoff metadata for SourceControlManager", () => {
    const queue = new CompletionQueue(":memory:");
    const enqueued = queue.enqueue({
      jobId: "job-trusted",
      sessionId: "dev",
      commitSha: "fed123",
      branch: "refs/pushpals/agent/worker/job-trusted",
      message: "candidate retained",
      trustedValidationCommands: ["bun run validate:publish", "bun run validate:publish"],
      trustedValidationSummary: "Host validation required",
      trustedValidationDetail: "Docker is unavailable in the worker sandbox.",
    });

    expect(enqueued.ok).toBe(true);
    const claimed = queue.claim("scm-trusted");
    expect(claimed.completion?.trustedValidationCommandsJson).toBe(
      JSON.stringify(["bun run validate:publish"]),
    );
    expect(claimed.completion?.trustedValidationSummary).toBe("Host validation required");
    expect(claimed.completion?.trustedValidationDetail).toContain("Docker is unavailable");
    queue.close();
  });

  test("rejects unsafe trusted-validation handoffs", () => {
    const queue = new CompletionQueue(":memory:");
    const enqueued = queue.enqueue({
      jobId: "job-unsafe",
      sessionId: "dev",
      commitSha: "bad123",
      branch: "refs/pushpals/agent/worker/job-unsafe",
      message: "candidate retained",
      trustedValidationCommands: ["bun test && powershell -Command Remove-Item"],
    });

    expect(enqueued.ok).toBe(false);
    expect(enqueued.message).toContain("unsafe or unsupported");
    expect(queue.getPendingCompletions()).toHaveLength(0);
    queue.close();
  });

  test("migrates an existing completion database before accepting trusted validation", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE completions (
        id TEXT PRIMARY KEY,
        jobId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'user',
        commitSha TEXT,
        branch TEXT,
        message TEXT NOT NULL,
        prUrl TEXT,
        prTitle TEXT,
        prBody TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        pusherId TEXT,
        error TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);

    const queue = new CompletionQueue(legacy);
    expect(
      queue.enqueue({
        jobId: "job-migrated",
        sessionId: "dev",
        message: "candidate retained",
        trustedValidationCommands: ["bun run validate:publish"],
      }).ok,
    ).toBe(true);
    expect(queue.claim("scm-migrated").completion).toMatchObject({
      trustedValidationCommandsJson: JSON.stringify(["bun run validate:publish"]),
      trustedInstallDurationMs: null,
      trustedValidationDurationMs: null,
      trustedValidationCacheHit: null,
      trustedValidationRecoveryAttempts: 0,
    });
    queue.close();
  });

  test("startup migration requeues legacy claimed completions that had no lease", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE completions (
        id TEXT PRIMARY KEY,
        jobId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'user',
        commitSha TEXT,
        branch TEXT,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        pusherId TEXT,
        error TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO completions (
        id, jobId, sessionId, message, status, pusherId, createdAt, updatedAt
      ) VALUES (
        'legacy-claimed', 'job-legacy-claimed', 'dev', 'candidate', 'claimed', 'dead-scm',
        '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
      );
    `);

    const queue = new CompletionQueue(legacy);
    expect(queue.getCompletion("legacy-claimed")).toMatchObject({
      status: "pending",
      pusherId: null,
      claimedAt: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      claimAttempts: 0,
    });
    expect(queue.claim("replacement-scm").completion).toMatchObject({
      id: "legacy-claimed",
      status: "claimed",
      pusherId: "replacement-scm",
      claimAttempts: 1,
    });
    queue.close();
  });

  test("stores prUrl on enqueue and returns it when claimed", () => {
    const queue = new CompletionQueue(":memory:");
    const enqueued = queue.enqueue({
      jobId: "job-1",
      sessionId: "dev",
      commitSha: "abc123",
      branch: "agent/feature",
      message: "done",
      prUrl: "https://github.com/org/repo/pull/12",
    });
    expect(enqueued.ok).toBe(true);

    const claimed = queue.claim("scm-1");
    expect(claimed.ok).toBe(true);
    expect(claimed.completion?.prUrl).toBe("https://github.com/org/repo/pull/12");
    expect(claimed.completion?.origin).toBe("user");

    queue.close();
  });

  test("markProcessed persists prUrl when provided by SCM", () => {
    const queue = new CompletionQueue(":memory:");
    const enqueued = queue.enqueue({
      jobId: "job-2",
      sessionId: "dev",
      commitSha: "def456",
      branch: "agent/feature-2",
      message: "done",
    });
    expect(enqueued.ok).toBe(true);

    const claimed = queue.claim("scm-2");
    expect(claimed.ok).toBe(true);
    const completionId = claimed.completion?.id ?? "";
    expect(completionId.length).toBeGreaterThan(0);

    const processed = queue.markProcessed(completionId, "https://github.com/org/repo/pull/34");
    expect(processed.ok).toBe(true);

    const saved = queue.getCompletion(completionId);
    expect(saved?.status).toBe("processed");
    expect(saved?.prUrl).toBe("https://github.com/org/repo/pull/34");

    queue.close();
  });

  test("stores autonomy origin for SourceControlManager event filtering", () => {
    const queue = new CompletionQueue(":memory:");
    const enqueued = queue.enqueue({
      jobId: "job-3",
      sessionId: "dev",
      origin: "autonomy",
      commitSha: "abc789",
      branch: "refs/pushpals/agent/worker/job",
      message: "done",
    });
    expect(enqueued.ok).toBe(true);

    const claimed = queue.claim("scm-3");
    expect(claimed.ok).toBe(true);
    expect(claimed.completion?.origin).toBe("autonomy");

    queue.close();
  });

  test("leases claimed completions and renews only for the owning pusher", () => {
    const db = new Database(":memory:");
    const queue = new CompletionQueue(db);
    const enqueued = queue.enqueue({
      jobId: "job-lease",
      sessionId: "dev",
      message: "candidate retained",
    });

    const claimed = queue.claim("scm-owner", { leaseMs: 60_000 });
    expect(claimed.completion).toMatchObject({
      id: enqueued.completionId,
      pusherId: "scm-owner",
      claimAttempts: 1,
    });
    expect(claimed.completion?.claimedAt).toBeTruthy();
    expect(claimed.completion?.lastHeartbeatAt).toBeTruthy();
    expect(claimed.completion?.leaseExpiresAt).toBeTruthy();
    expect(queue.renewLease(enqueued.completionId ?? "", "scm-other").ok).toBe(false);
    expect(queue.renewLease(enqueued.completionId ?? "", "scm-owner").ok).toBe(true);
    queue.close();
  });

  test("recovers expired claims and prevents a stale owner from finalizing", () => {
    const db = new Database(":memory:");
    const queue = new CompletionQueue(db);
    const enqueued = queue.enqueue({
      jobId: "job-expired",
      sessionId: "dev",
      message: "candidate retained",
    });
    expect(queue.claim("scm-old").ok).toBe(true);
    db.prepare(`UPDATE completions SET leaseExpiresAt = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      enqueued.completionId,
    );

    const recovered = queue.recoverExpiredClaims();
    expect(recovered).toMatchObject({ recovered: 1 });
    const reclaimed = queue.claim("scm-new");
    expect(reclaimed.completion).toMatchObject({
      id: enqueued.completionId,
      pusherId: "scm-new",
      claimAttempts: 2,
    });
    expect(queue.markProcessed(enqueued.completionId ?? "", null, "scm-old").ok).toBe(false);
    expect(queue.markProcessed(enqueued.completionId ?? "", null, "scm-new").ok).toBe(true);
    queue.close();
  });

  test("rejects an expired owner's callbacks before a recovery sweep runs", () => {
    const db = new Database(":memory:");
    const queue = new CompletionQueue(db);
    const processedCandidate = queue.enqueue({
      jobId: "job-expired-processed-callback",
      sessionId: "dev",
      message: "candidate retained",
    });
    expect(queue.claim("scm-expired").ok).toBe(true);
    db.prepare(`UPDATE completions SET leaseExpiresAt = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      processedCandidate.completionId,
    );
    expect(queue.markProcessed(processedCandidate.completionId ?? "", null, "scm-expired").ok).toBe(
      false,
    );

    const failedCandidate = queue.enqueue({
      jobId: "job-expired-failed-callback",
      sessionId: "dev",
      message: "candidate retained",
    });
    expect(queue.claim("scm-expired").ok).toBe(true);
    db.prepare(`UPDATE completions SET leaseExpiresAt = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      failedCandidate.completionId,
    );
    expect(
      queue.markFailed(failedCandidate.completionId ?? "", "stale callback", "scm-expired").ok,
    ).toBe(false);
    queue.close();
  });

  test("rejects atomic publication finalization after the owner lease expires", () => {
    const { jobs, completions, jobId, dbPath } = createSharedQueues();
    const handoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        commitSha: "expired-finalization-sha",
        branch: "refs/pushpals/agent/worker/expired-finalization",
        message: "candidate retained",
      },
      { beginJobFinalization: true },
    );
    const completionId = handoff.completionId ?? "";
    expect(completions.claim("scm-expired-finalizer").ok).toBe(true);
    const row = completions.getCompletion(completionId);
    expect(row?.leaseExpiresAt).toBeTruthy();
    const db = new Database(dbPath);
    db.prepare(`UPDATE completions SET leaseExpiresAt = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      completionId,
    );
    db.close();

    expect(
      completions.markProcessedAndFinalizeJob(
        completionId,
        "https://github.com/org/repo/pull/expired",
        undefined,
        undefined,
        "scm-expired-finalizer",
      ),
    ).toMatchObject({ ok: false });
    expect(jobs.getJob(jobId)?.status).toBe("finalizing");
    completions.close();
    jobs.close();
  });

  test("startup reconciliation requeues claims from the stable pusher identity", () => {
    const queue = new CompletionQueue(":memory:");
    const first = queue.enqueue({ jobId: "job-reconcile-1", sessionId: "dev", message: "one" });
    const second = queue.enqueue({ jobId: "job-reconcile-2", sessionId: "dev", message: "two" });
    expect(queue.claim("scm-stable").completion?.id).toBe(first.completionId);

    const reconciled = queue.claim("scm-stable", { reconcilePusher: true });
    expect(reconciled.completion?.id).toBe(first.completionId);
    expect(reconciled.completion?.claimAttempts).toBe(2);
    expect(queue.getPendingCompletions().map((row) => row.id)).toEqual([second.completionId]);
    queue.close();
  });

  test("reports publication backlog age for autonomy and watchdog backpressure", () => {
    const db = new Database(":memory:");
    const queue = new CompletionQueue(db);
    queue.enqueue({ jobId: "job-backlog", sessionId: "dev", message: "candidate" });
    db.exec(`UPDATE completions SET createdAt = '2000-01-01T00:00:00.000Z';`);

    expect(
      queue.publicationBacklogSummary({
        now: new Date("2000-01-01T00:20:00.000Z"),
        unhealthyAfterMs: 10 * 60_000,
      }),
    ).toMatchObject({
      pending: 1,
      claimed: 0,
      backlog: 1,
      unhealthy: true,
      oldestPendingAgeMs: 20 * 60_000,
    });
    queue.close();
  });
});
