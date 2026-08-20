import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPLETION_HANDOFF_CONFLICT_CODE,
  CompletionQueue,
  type CompletionEnqueueOptions,
} from "../apps/server/src/completions";
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

function finalizationOptions(jobs: JobQueue, jobId: string): CompletionEnqueueOptions {
  const job = jobs.getJob(jobId);
  expect(typeof job?.workerId).toBe("string");
  expect(String(job?.workerId ?? "")).not.toBe("");
  expect(job?.claimGeneration).toBeGreaterThanOrEqual(1);
  return {
    beginJobFinalization: true,
    jobClaimAuthority: {
      workerId: String(job?.workerId ?? ""),
      claimGeneration: Number(job?.claimGeneration ?? 0),
    },
  };
}

function currentCompletionClaim(
  completions: CompletionQueue,
  completionId: string,
): [pusherId: string, claimToken: string] {
  const row = completions.getCompletion(completionId);
  const pusherId = String(row?.pusherId ?? "");
  const claimToken = String(row?.claimToken ?? "");
  expect(pusherId).not.toBe("");
  expect(claimToken).not.toBe("");
  return [pusherId, claimToken];
}

function trustedValidationReport(options: {
  ok: boolean;
  command?: string;
  candidateSha: string;
  candidateRef?: string;
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
    candidateRef: options.candidateRef ?? `refs/pushpals/validation/${"a".repeat(32)}/1/candidate`,
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

function enqueueTransientBlockedPublication(options: {
  jobs: JobQueue;
  completions: CompletionQueue;
  suffix: string;
  dedupeKey: string;
}): { jobId: string; completionId: string } {
  const { jobs, completions, suffix, dedupeKey } = options;
  const enqueued = jobs.enqueue({
    taskId: `task-transient-blocker-${suffix}`,
    sessionId: "dev",
    kind: "task.execute",
    params: {},
    dedupeKey,
  });
  const jobId = String(enqueued.jobId ?? "");
  const workerId = `worker-transient-blocker-${suffix}`;
  expect(jobs.claim(workerId).job).toMatchObject({ id: jobId, workerId });
  const handoff = completions.enqueue(
    {
      jobId,
      sessionId: "dev",
      commitSha: `transient-blocker-${suffix}`,
      branch: `refs/pushpals/agent/worker/transient-blocker-${suffix}`,
      message: `transient blocker ${suffix}`,
      trustedValidationCommands: ["bun run validate:publish"],
    },
    finalizationOptions(jobs, jobId),
  );
  const completionId = String(handoff.completionId ?? "");
  const pusherId = `scm-transient-blocker-${suffix}`;
  expect(completions.claim(pusherId).completion?.id).toBe(completionId);
  expect(
    completions.markFailedAndBlockJob(
      completionId,
      "trusted validation timed out",
      undefined,
      trustedValidationReport({
        ok: false,
        candidateSha: `transient-blocker-${suffix}`,
        output: "Command timed out after 480000ms; terminated process tree.",
        exitCode: 124,
        failureClass: "timeout",
        failedTests: [],
        targetPathHints: [],
      }),
      ...currentCompletionClaim(completions, completionId),
    ),
  ).toMatchObject({ ok: true, jobId, jobTransitioned: true });
  expect(jobs.getJob(jobId)?.status).toBe("publish_blocked");
  return { jobId, completionId };
}

function terminalizeTwoPublicationCandidates(options: {
  jobs: JobQueue;
  completions: CompletionQueue;
  completionIds: [string, string];
}): void {
  const { jobs, completions, completionIds } = options;
  const processedClaim = completions.claim("scm-migration-processed").completion;
  const processedCompletionId = String(processedClaim?.id ?? "");
  expect(completionIds).toContain(processedCompletionId);
  expect(
    completions.markProcessedAndFinalizeJob(
      processedCompletionId,
      "https://github.com/org/repo/pull/migration-processed",
      undefined,
      undefined,
      "scm-migration-processed",
      processedClaim?.claimToken,
    ),
  ).toMatchObject({ ok: true, jobId: processedClaim?.jobId, jobTransitioned: true });

  const failedClaim = completions.claim("scm-migration-failed").completion;
  const failedCompletionId = String(failedClaim?.id ?? "");
  expect(completionIds).toContain(failedCompletionId);
  expect(failedCompletionId).not.toBe(processedCompletionId);
  expect(
    completions.markFailedAndBlockJob(
      failedCompletionId,
      "publication rejected after startup recovery",
      undefined,
      undefined,
      "scm-migration-failed",
      failedClaim?.claimToken,
    ),
  ).toMatchObject({ ok: true, jobId: failedClaim?.jobId, jobTransitioned: true });

  expect([processedCompletionId, failedCompletionId].sort()).toEqual([...completionIds].sort());
  expect(completions.getCompletion(processedCompletionId)?.status).toBe("processed");
  expect(completions.getCompletion(failedCompletionId)?.status).toBe("failed");
  expect(jobs.getJob(String(processedClaim?.jobId))?.status).toBe("completed");
  expect(jobs.getJob(String(failedClaim?.jobId))?.status).toBe("publish_blocked");
}

function seedLegacyDurableOwners(
  dbPath: string,
  suffix: string,
  jobId: string,
): { requestId: string; objectiveId: string } {
  const requestId = `request-${suffix}`;
  const objectiveId = `objective-${suffix}`;
  const seededAt = new Date().toISOString();
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        handoffJobId TEXT,
        workerRequired INTEGER NOT NULL DEFAULT 1,
        updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS autonomy_objectives (
        id TEXT PRIMARY KEY,
        job_id TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO requests (id, handoffJobId, workerRequired, updatedAt)
       VALUES (?, ?, 1, ?)`,
    ).run(requestId, jobId, seededAt);
    db.prepare(
      `INSERT INTO autonomy_objectives (id, job_id, status, updated_at)
       VALUES (?, ?, 'running', ?)`,
    ).run(objectiveId, jobId, seededAt);
  } finally {
    db.close();
  }
  return { requestId, objectiveId };
}

function expectLegacyDurableOwners(
  dbPath: string,
  owners: { requestId: string; objectiveId: string },
  expectedJobId: string,
): void {
  const db = new Database(dbPath, { readonly: true });
  try {
    expect(
      db.prepare(`SELECT handoffJobId FROM requests WHERE id = ?`).get(owners.requestId),
    ).toEqual({ handoffJobId: expectedJobId });
    expect(
      db
        .prepare(`SELECT job_id AS jobId FROM autonomy_objectives WHERE id = ?`)
        .get(owners.objectiveId),
    ).toEqual({ jobId: expectedJobId });
  } finally {
    db.close();
  }
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
      finalizationOptions(jobs, jobId),
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
          jobResultSummary: "implemented the requested change",
        },
        finalizationOptions(jobs, jobId),
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
      undefined,
      "scm-publication",
      claimed.completion?.claimToken,
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
    expect(completions.getCompletionProcessingAuthority(claimed.completion?.id ?? "")).toEqual({
      id: claimed.completion?.id,
      status: "processed",
      commitSha: "abc123",
      branch: "refs/pushpals/agent/worker/job-publication",
      claimGeneration: 1,
    });
    expect(completions.getCompletionProcessingAuthority("missing-completion")).toBeNull();
    expect(
      completions.markProcessedAndFinalizeJob(
        claimed.completion?.id ?? "",
        "https://github.com/org/repo/pull/42",
        undefined,
        undefined,
        "scm-publication",
        claimed.completion?.claimToken,
      ),
    ).toMatchObject({ ok: true, jobTransitioned: false });
    expect(
      completions.enqueue(
        {
          jobId,
          sessionId: "dev",
          commitSha: "abc123",
          branch: "refs/pushpals/agent/worker/job-publication",
          message: "candidate retained",
          jobResultSummary: "implemented the requested change",
        },
        finalizationOptions(jobs, jobId),
      ),
    ).toMatchObject({
      ok: true,
      completionId: handoff.completionId,
      deduped: true,
    });
    expect(
      completions.enqueue(
        {
          jobId,
          sessionId: "dev",
          commitSha: "different-candidate",
          branch: "refs/pushpals/agent/worker/job-publication",
          message: "candidate retained",
        },
        finalizationOptions(jobs, jobId),
      ),
    ).toMatchObject({ ok: false });

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
      finalizationOptions(jobs, jobId),
    );
    const completionId = handoff.completionId ?? "";
    expect(jobs.getJob(jobId)?.status).toBe("finalizing");
    const claimed = completions.claim("scm-validation");
    expect(claimed.completion?.id).toBe(completionId);

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
        candidateRef: `refs/pushpals/validation/${"b".repeat(32)}/3/candidate`,
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
      "scm-validation",
      claimed.completion?.claimToken,
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
    expect(
      completions.markFailedAndBlockJob(
        completionId,
        "duplicate callback",
        undefined,
        undefined,
        "scm-validation",
        claimed.completion?.claimToken,
      ),
    ).toMatchObject({ ok: true, jobTransitioned: false });
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
        candidateSha: "spoofed-candidate",
        candidateRef: `refs/pushpals/validation/${"b".repeat(32)}/3/candidate`,
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

  test("does not invent exact tested provenance from the worker handoff", () => {
    const { jobs, completions, jobId } = createSharedQueues();
    const handoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        commitSha: "original-worker-sha",
        branch: "refs/pushpals/agent/worker/original-worker-sha",
        message: "candidate retained",
        trustedValidationCommands: ["bun test"],
      },
      finalizationOptions(jobs, jobId),
    );
    const completionId = handoff.completionId ?? "";
    const claimed = completions.claim("scm-no-provenance");
    expect(claimed.completion?.id).toBe(completionId);
    expect(
      completions.markFailedAndBlockJob(
        completionId,
        "trusted validation failed",
        undefined,
        {
          version: 1,
          baselineSha: "known-baseline",
          candidateSha: null,
          candidateRef: null,
          results: [
            {
              ok: false,
              command: "bun test",
              output: "tests/example.test.ts:\n(fail) exact provenance is unavailable",
              exitCode: 1,
              durationMs: 100,
              phase: "validation",
            },
          ],
        },
        "scm-no-provenance",
        claimed.completion?.claimToken,
      ).ok,
    ).toBe(true);

    const run = jobs.getJobDiagnostics(jobId).validationRuns[0] as Record<string, any>;
    expect(run.metadata).toMatchObject({
      source: "trusted_host",
      completionId,
      baselineSha: "known-baseline",
      candidateSha: null,
      candidateRef: null,
    });
    expect(run.metadata.candidateSha).not.toBe("original-worker-sha");
    expect(run.metadata.candidateRef).not.toBe("refs/pushpals/agent/worker/original-worker-sha");

    completions.close();
    jobs.close();
  });

  test("does not collide fingerprints for different assertions in the same test target", () => {
    const { jobs, completions, jobId: firstJobId } = createSharedQueues();
    const secondJobId = enqueueClaimedJob(jobs, "fingerprint-second");
    const persistFailure = (jobId: string, candidateSha: string, assertion: string): string => {
      const handoff = completions.enqueue(
        {
          jobId,
          sessionId: "dev",
          commitSha: candidateSha,
          branch: `refs/pushpals/agent/worker/${candidateSha}`,
          message: "candidate retained",
          trustedValidationCommands: ["bun test"],
        },
        finalizationOptions(jobs, jobId),
      );
      const completionId = handoff.completionId ?? "";
      const pusherId = `scm-${candidateSha}`;
      const claimed = completions.claim(pusherId);
      expect(claimed.completion?.id).toBe(completionId);
      expect(
        completions.markFailedAndBlockJob(
          completionId,
          "bun test failed",
          undefined,
          {
            version: 1,
            baselineSha: "same-baseline",
            candidateSha,
            results: [
              {
                ok: false,
                command: "bun test",
                output: [
                  "tests/account.test.ts:",
                  "(fail) account boundary > rejects invalid state",
                  assertion,
                ].join("\n"),
                exitCode: 1,
                durationMs: 100,
                phase: "validation",
              },
            ],
          },
          pusherId,
          claimed.completion?.claimToken,
        ).ok,
      ).toBe(true);
      const run = jobs.getJobDiagnostics(jobId).validationRuns[0] as Record<string, any>;
      return String(run.metadata.failureFingerprint ?? "");
    };

    const first = persistFailure(firstJobId, "a".repeat(40), "Expected: 401\nReceived: 503");
    const second = persistFailure(secondJobId, "b".repeat(40), "Error: teardown process timed out");

    expect(first).toHaveLength(24);
    expect(second).toHaveLength(24);
    expect(first).not.toBe(second);
    completions.close();
    jobs.close();
  });

  test("normalizes volatile runtime identity out of trusted-validation fingerprints", () => {
    const { jobs, completions, jobId: firstJobId } = createSharedQueues();
    const secondJobId = enqueueClaimedJob(jobs, "fingerprint-volatile-second");
    const persist = (jobId: string, candidateSha: string, output: string): string => {
      const handoff = completions.enqueue(
        {
          jobId,
          sessionId: "dev",
          commitSha: candidateSha,
          branch: `refs/pushpals/agent/worker/${candidateSha}`,
          message: "candidate retained",
          trustedValidationCommands: ["bun test tests/account.test.ts"],
        },
        finalizationOptions(jobs, jobId),
      );
      const completionId = handoff.completionId ?? "";
      const pusherId = `scm-${candidateSha}`;
      const claimed = completions.claim(pusherId);
      expect(claimed.completion?.id).toBe(completionId);
      expect(
        completions.markFailedAndBlockJob(
          completionId,
          "bun test failed",
          undefined,
          {
            version: 1,
            baselineSha: "same-baseline",
            candidateSha,
            results: [
              {
                ok: false,
                command: "bun test tests/account.test.ts",
                output,
                exitCode: 1,
                durationMs: 100,
                phase: "validation",
              },
            ],
          },
          pusherId,
          claimed.completion?.claimToken,
        ).ok,
      ).toBe(true);
      return String(
        (jobs.getJobDiagnostics(jobId).validationRuns[0] as Record<string, any>).metadata
          .failureFingerprint ?? "",
      );
    };

    const first = persist(
      firstJobId,
      "a".repeat(40),
      "tests/account.test.ts:\n(fail) account boundary > rejects invalid state\nError: worker job_abcdef12 pid 4012 could not reach 127.0.0.1:53111 at C:\\Users\\one\\AppData\\Local\\Temp\\pushpals-a\\runner.ts:12:4",
    );
    const second = persist(
      secondJobId,
      "b".repeat(40),
      "tests/account.test.ts:\n(fail) account boundary > rejects invalid state\nError: worker job_fedcba98 pid 9931 could not reach 127.0.0.1:64222 at C:\\Users\\two\\AppData\\Local\\Temp\\pushpals-b\\runner.ts:98:7",
    );
    expect(first).toHaveLength(24);
    expect(second).toBe(first);
    completions.close();
    jobs.close();
  });

  test("merges full supplied evidence with evidence re-extracted from bounded output", () => {
    const { jobs, completions, jobId } = createSharedQueues();
    const handoff = completions.enqueue(
      {
        jobId,
        sessionId: "dev",
        commitSha: "evidence-candidate",
        branch: "refs/pushpals/agent/worker/evidence-candidate",
        message: "candidate retained",
        trustedValidationCommands: ["bun test"],
      },
      finalizationOptions(jobs, jobId),
    );
    const completionId = handoff.completionId ?? "";
    const claimed = completions.claim("scm-evidence-merge");
    expect(claimed.completion?.id).toBe(completionId);
    expect(
      completions.markFailedAndBlockJob(
        completionId,
        "bun test failed",
        undefined,
        {
          version: 1,
          baselineSha: "evidence-baseline",
          candidateSha: "evidence-candidate",
          results: [
            {
              ok: false,
              command: "bun test",
              output: "tests/visible.test.ts:\n(fail) visible suite > visible assertion",
              exitCode: 1,
              durationMs: 100,
              phase: "validation",
              failedTests: ["visible suite > visible assertion", "hidden suite > hidden assertion"],
              targetPathHints: ["tests/visible.test.ts", "tests/hidden.test.ts"],
              failureLines: ["(fail) hidden suite > hidden assertion"],
            },
          ],
        },
        "scm-evidence-merge",
        claimed.completion?.claimToken,
      ).ok,
    ).toBe(true);
    const metadata = (jobs.getJobDiagnostics(jobId).validationRuns[0] as Record<string, any>)
      .metadata;
    expect(metadata.failedTests).toEqual([
      "hidden suite > hidden assertion",
      "visible suite > visible assertion",
    ]);
    expect(metadata.targetPathHints).toEqual(["tests/hidden.test.ts", "tests/visible.test.ts"]);
    expect(metadata.failureLines).toContain("(fail) hidden suite > hidden assertion");
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
      finalizationOptions(jobs, jobId),
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
        ...currentCompletionClaim(completions, blockedCompletionId),
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
      finalizationOptions(jobs, repairJobId),
    );
    const repairCompletionId = repairHandoff.completionId ?? "";
    expect(completions.claim("scm-repair").completion?.id).toBe(repairCompletionId);
    const repaired = completions.markProcessedAndFinalizeJob(
      repairCompletionId,
      "https://github.com/org/repo/pull/repair",
      undefined,
      trustedValidationReport({ ok: true, candidateSha: "repair-candidate" }),
      ...currentCompletionClaim(completions, repairCompletionId),
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
      claimToken: null,
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
      finalizationOptions(jobs, jobId),
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
        ...currentCompletionClaim(completions, blockedCompletionId),
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

  test("startup trusted-validation recovery preserves two same-key blocked publications", () => {
    const dir = mkdtempSync(join(tmpdir(), "pushpals-completion-startup-recovery-dedupe-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "pushpals.db");
    let jobs: JobQueue | null = new JobQueue(dbPath);
    let completions: CompletionQueue | null = new CompletionQueue(dbPath);

    try {
      const dedupeKey = "trusted-recovery:two-blockers";
      const first = enqueueTransientBlockedPublication({
        jobs,
        completions,
        suffix: "startup-first",
        dedupeKey,
      });
      const second = enqueueTransientBlockedPublication({
        jobs,
        completions,
        suffix: "startup-second",
        dedupeKey,
      });

      const passingJobId = enqueueClaimedJob(jobs, "startup-collision-pass");
      expect(jobs.complete(passingJobId, { summary: "trusted host validation passed" }).ok).toBe(
        true,
      );
      const db = new Database(dbPath);
      try {
        const failedAt = db
          .prepare(
            `SELECT MAX(createdAt) AS createdAt
             FROM job_validation_runs
             WHERE jobId IN (?, ?)`,
          )
          .get(first.jobId, second.jobId) as { createdAt: string };
        const passedAt = new Date(Date.parse(failedAt.createdAt) + 1_000).toISOString();
        db.prepare(
          `INSERT INTO job_validation_runs (
             jobId, attempt, command, exitCode, durationMs, passed, failureClass,
             stdoutTail, stderrTail, metadataJson, createdAt
           ) VALUES (?, NULL, ?, 0, 1000, 1, NULL, ?, NULL, ?, ?)`,
        ).run(
          passingJobId,
          "bun run validate:publish",
          "trusted validation passed",
          JSON.stringify({
            source: "trusted_host",
            completionId: "persisted-startup-collision-pass",
            baselineSha: "baseline-sha",
            failedTests: [],
          }),
          passedAt,
        );
      } finally {
        db.close();
      }

      completions.close();
      completions = null;
      jobs.close();
      jobs = null;

      jobs = new JobQueue(dbPath);
      completions = new CompletionQueue(dbPath);

      const restoredParents = [jobs.getJob(first.jobId), jobs.getJob(second.jobId)];
      expect(restoredParents.map((row) => row?.status)).toEqual(["finalizing", "finalizing"]);
      expect(restoredParents.filter((row) => row?.dedupeKey === dedupeKey)).toHaveLength(1);
      expect(restoredParents.filter((row) => row?.dedupeKey === null)).toHaveLength(1);
      for (const candidate of [first, second]) {
        expect(completions.getCompletion(candidate.completionId)).toMatchObject({
          jobId: candidate.jobId,
          status: "pending",
          trustedValidationRecoveryAttempts: 1,
        });
        expect(jobs.getJobDiagnostics(candidate.jobId).terminal).toBeNull();
      }
      const releasedParent = restoredParents.find((row) => row?.dedupeKey === null);
      expect(
        jobs
          .listJobLogs(String(releasedParent?.id))
          .some(
            (log) =>
              log.message.includes("startup trusted-validation recovery") &&
              log.message.includes("publication remains active"),
          ),
      ).toBe(true);
      terminalizeTwoPublicationCandidates({
        jobs,
        completions,
        completionIds: [first.completionId, second.completionId],
      });
    } finally {
      completions?.close();
      jobs?.close();
    }
  });

  test("runtime trusted-validation recovery preserves a same-key finalizing publication", () => {
    const { jobs, completions, jobId: bootstrapJobId, dbPath } = createSharedQueues();
    const bootstrapJob = jobs.getJob(bootstrapJobId);
    expect(
      jobs.complete(
        bootstrapJobId,
        { summary: "bootstrap complete" },
        {
          workerId: String(bootstrapJob?.workerId ?? "worker-publication"),
          claimGeneration: Number(bootstrapJob?.claimGeneration ?? 1),
        },
      ).ok,
    ).toBe(true);

    const dedupeKey = "trusted-recovery:blocked-and-finalizing";
    const blocked = enqueueTransientBlockedPublication({
      jobs,
      completions,
      suffix: "runtime-blocked",
      dedupeKey,
    });

    const activeEnqueued = jobs.enqueue({
      taskId: "task-runtime-existing-finalizing",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey,
    });
    const activeJobId = String(activeEnqueued.jobId ?? "");
    expect(jobs.claim("worker-runtime-existing-finalizing").job?.id).toBe(activeJobId);
    const activeHandoff = completions.enqueue(
      {
        jobId: activeJobId,
        sessionId: "dev",
        commitSha: "runtime-existing-finalizing",
        branch: "refs/pushpals/agent/worker/runtime-existing-finalizing",
        message: "existing finalizing candidate",
      },
      finalizationOptions(jobs, activeJobId),
    );
    const activeCompletionId = String(activeHandoff.completionId ?? "");
    expect(completions.claim("scm-runtime-existing-finalizing").completion?.id).toBe(
      activeCompletionId,
    );

    const passingJobId = enqueueClaimedJob(jobs, "runtime-collision-pass");
    const passingHandoff = completions.enqueue(
      {
        jobId: passingJobId,
        sessionId: "dev",
        commitSha: "runtime-collision-pass",
        branch: "refs/pushpals/agent/worker/runtime-collision-pass",
        message: "same-baseline trusted validation passed",
        trustedValidationCommands: ["bun run validate:publish"],
      },
      finalizationOptions(jobs, passingJobId),
    );
    const passingCompletionId = String(passingHandoff.completionId ?? "");
    expect(completions.claim("scm-runtime-collision-pass").completion?.id).toBe(
      passingCompletionId,
    );
    const recovered = completions.markProcessedAndFinalizeJob(
      passingCompletionId,
      "https://github.com/org/repo/pull/runtime-collision-pass",
      undefined,
      trustedValidationReport({ ok: true, candidateSha: "runtime-collision-pass" }),
      ...currentCompletionClaim(completions, passingCompletionId),
    );

    expect(recovered).toMatchObject({
      ok: true,
      requeuedCompletionIds: [blocked.completionId],
      requeuedJobIds: [blocked.jobId],
    });
    const publicationParents = [jobs.getJob(blocked.jobId), jobs.getJob(activeJobId)];
    expect(publicationParents.map((row) => row?.status)).toEqual(["finalizing", "finalizing"]);
    expect(publicationParents.filter((row) => row?.dedupeKey === dedupeKey)).toHaveLength(1);
    expect(publicationParents.filter((row) => row?.dedupeKey === null)).toHaveLength(1);
    expect(completions.getCompletion(blocked.completionId)).toMatchObject({
      status: "pending",
      trustedValidationRecoveryAttempts: 1,
    });
    expect(completions.getCompletion(activeCompletionId)).toMatchObject({
      status: "claimed",
      pusherId: "scm-runtime-existing-finalizing",
    });
    const releasedParent = publicationParents.find((row) => row?.dedupeKey === null);
    expect(
      jobs
        .listJobLogs(String(releasedParent?.id))
        .some(
          (log) =>
            log.message.includes("runtime trusted-validation recovery") &&
            log.message.includes("publication remains active"),
        ),
    ).toBe(true);

    const db = new Database(dbPath);
    const activeCompletionCount = db
      .prepare(
        `SELECT COUNT(*) AS count FROM completions
         WHERE id IN (?, ?) AND status IN ('pending', 'claimed')`,
      )
      .get(blocked.completionId, activeCompletionId) as { count: number };
    db.close();
    expect(activeCompletionCount.count).toBe(2);

    completions.close();
    jobs.close();
  });

  test("repoints durable owners when runtime recovery abandons an ordinary duplicate", () => {
    const dir = mkdtempSync(join(tmpdir(), "pushpals-completion-owner-runtime-recovery-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "pushpals.db");
    const jobs = new JobQueue(dbPath);
    const completions = new CompletionQueue(dbPath);

    try {
      const dedupeKey = "trusted-recovery:runtime-publication-owner";
      const blocked = enqueueTransientBlockedPublication({
        jobs,
        completions,
        suffix: "runtime-publication-owner",
        dedupeKey,
      });
      const duplicateEnqueued = jobs.enqueue({
        taskId: "task-runtime-ordinary-duplicate",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
        dedupeKey,
      });
      const duplicateJobId = String(duplicateEnqueued.jobId ?? "");
      expect(jobs.getJob(duplicateJobId)?.status).toBe("pending");
      const owners = seedLegacyDurableOwners(dbPath, "runtime-ordinary-duplicate", duplicateJobId);
      const deferredDuplicateDb = new Database(dbPath);
      try {
        deferredDuplicateDb
          .prepare(`UPDATE jobs SET availableAt = ? WHERE id = ?`)
          .run(new Date(Date.now() + 60_000).toISOString(), duplicateJobId);
      } finally {
        deferredDuplicateDb.close();
      }

      const passingJobId = enqueueClaimedJob(jobs, "runtime-owner-recovery-pass");
      const passingHandoff = completions.enqueue(
        {
          jobId: passingJobId,
          sessionId: "dev",
          commitSha: "runtime-owner-recovery-pass",
          branch: "refs/pushpals/agent/worker/runtime-owner-recovery-pass",
          message: "same-baseline trusted validation passed",
          trustedValidationCommands: ["bun run validate:publish"],
        },
        finalizationOptions(jobs, passingJobId),
      );
      const passingCompletionId = String(passingHandoff.completionId ?? "");
      expect(completions.claim("scm-runtime-owner-recovery-pass").completion?.id).toBe(
        passingCompletionId,
      );
      expect(
        completions.markProcessedAndFinalizeJob(
          passingCompletionId,
          "https://github.com/org/repo/pull/runtime-owner-recovery-pass",
          undefined,
          trustedValidationReport({ ok: true, candidateSha: "runtime-owner-recovery-pass" }),
          ...currentCompletionClaim(completions, passingCompletionId),
        ),
      ).toMatchObject({
        ok: true,
        requeuedCompletionIds: [blocked.completionId],
        requeuedJobIds: [blocked.jobId],
      });

      expect(jobs.getJob(blocked.jobId)).toMatchObject({ status: "finalizing", dedupeKey });
      expect(jobs.getJob(duplicateJobId)).toMatchObject({ status: "abandoned", dedupeKey });
      expectLegacyDurableOwners(dbPath, owners, blocked.jobId);

      const restoredClaim = completions.claim("scm-runtime-publication-owner").completion;
      expect(restoredClaim?.id).toBe(blocked.completionId);
      expect(
        completions.markFailedAndBlockJob(
          blocked.completionId,
          "publication rejected after owner recovery",
          undefined,
          undefined,
          "scm-runtime-publication-owner",
          restoredClaim?.claimToken,
        ),
      ).toMatchObject({ ok: true, jobId: blocked.jobId, jobTransitioned: true });
    } finally {
      completions.close();
      jobs.close();
    }
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
      finalizationOptions(jobs, jobId),
    );
    const blockedCompletionId = blockedHandoff.completionId ?? "";
    expect(completions.claim("scm-blocked").completion?.id).toBe(blockedCompletionId);
    expect(
      completions.markFailedAndBlockJob(
        blockedCompletionId,
        "validate failed",
        undefined,
        trustedValidationReport({ ok: false, candidateSha: "blocked-validate" }),
        ...currentCompletionClaim(completions, blockedCompletionId),
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
      finalizationOptions(jobs, unrelatedJobId),
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
      ...currentCompletionClaim(completions, unrelatedCompletionId),
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
      finalizationOptions(jobs, jobId),
    );
    const blockedCompletionId = blockedHandoff.completionId ?? "";
    expect(completions.claim("scm-blocked").completion?.id).toBe(blockedCompletionId);
    expect(
      completions.markFailedAndBlockJob(
        blockedCompletionId,
        "named test failed",
        undefined,
        trustedValidationReport({ ok: false, candidateSha: "candidate-test-failure" }),
        ...currentCompletionClaim(completions, blockedCompletionId),
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
      finalizationOptions(jobs, passingJobId),
    );
    const passingCompletionId = passingHandoff.completionId ?? "";
    expect(completions.claim("scm-passing").completion?.id).toBe(passingCompletionId);
    const processed = completions.markProcessedAndFinalizeJob(
      passingCompletionId,
      null,
      undefined,
      trustedValidationReport({ ok: true, candidateSha: "unrelated-passing-candidate" }),
      ...currentCompletionClaim(completions, passingCompletionId),
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
      finalizationOptions(jobs, jobId),
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
        ...currentCompletionClaim(completions, blockedCompletionId),
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
      finalizationOptions(jobs, passingJobId),
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
      ...currentCompletionClaim(completions, passingCompletionId),
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
      finalizationOptions(jobs, jobId),
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
        ...currentCompletionClaim(completions, blockedCompletionId),
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
      finalizationOptions(jobs, repairJobId),
    );
    const repairCompletionId = repairHandoff.completionId ?? "";
    expect(completions.claim("scm-repair").completion?.id).toBe(repairCompletionId);
    const repaired = completions.markProcessedAndFinalizeJob(
      repairCompletionId,
      null,
      undefined,
      trustedValidationReport({ ok: true, candidateSha: "repair-after-cap" }),
      ...currentCompletionClaim(completions, repairCompletionId),
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
      finalizationOptions(jobs, jobId),
    );

    expect(handoff.ok).toBe(false);
    expect(jobs.getJob(jobId)?.status).toBe("claimed");
    expect(completions.getPendingCompletions()).toHaveLength(0);
    completions.close();
    jobs.close();
  });

  test("requires complete publication identity and the parent job session", () => {
    const { jobs, completions, jobId, dbPath } = createSharedQueues();
    const authority = finalizationOptions(jobs, jobId);
    const baseHandoff = {
      jobId,
      sessionId: "dev",
      commitSha: "candidate-publication-identity",
      branch: "refs/pushpals/agent/worker/candidate-publication-identity",
      message: "candidate retained",
    };

    expect(completions.enqueue({ ...baseHandoff, commitSha: "" }, authority)).toMatchObject({
      ok: false,
      message: expect.stringContaining("commitSha and branch are required"),
    });
    expect(completions.enqueue({ ...baseHandoff, commitSha: "" }, authority).code).toBeUndefined();
    expect(completions.enqueue({ ...baseHandoff, branch: "   " }, authority)).toMatchObject({
      ok: false,
      message: expect.stringContaining("commitSha and branch are required"),
    });
    expect(
      completions.enqueue(baseHandoff, {
        beginJobFinalization: true,
      } as CompletionEnqueueOptions),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("valid jobClaimAuthority"),
    });
    expect(
      completions.enqueue({ ...baseHandoff, sessionId: "different-session" }, authority),
    ).toMatchObject({
      ok: false,
      code: COMPLETION_HANDOFF_CONFLICT_CODE,
      message: expect.stringContaining("does not match parent job session"),
    });
    expect(
      completions.enqueue(baseHandoff, {
        beginJobFinalization: true,
        jobClaimAuthority: { workerId: "worker-other", claimGeneration: 1 },
      }),
    ).toMatchObject({
      ok: false,
      code: COMPLETION_HANDOFF_CONFLICT_CODE,
      message: expect.stringContaining("stale or owned by another worker"),
    });

    expect(jobs.getJob(jobId)).toMatchObject({
      status: "claimed",
      workerId: "worker-publication",
      claimGeneration: 1,
    });
    expect(completions.getPendingCompletions()).toHaveLength(0);

    const db = new Database(dbPath);
    db.prepare(`UPDATE jobs SET status = 'finalizing' WHERE id = ?`).run(jobId);
    db.close();
    expect(completions.enqueue(baseHandoff, authority)).toMatchObject({
      ok: false,
      code: COMPLETION_HANDOFF_CONFLICT_CODE,
      message: expect.stringContaining("expected claimed"),
    });
    expect(completions.getPendingCompletions()).toHaveLength(0);

    completions.close();
    jobs.close();
  });

  test("fences an ABA-stale handoff and safely replays the winning handoff", () => {
    const { jobs, completions, jobId, dbPath } = createSharedQueues();
    const staleAuthority = finalizationOptions(jobs, jobId);
    expect(
      jobs.defer(jobId, {
        workerId: "worker-publication",
        targetWorkerId: null,
        deferMs: 1_000,
      }),
    ).toMatchObject({ ok: true });

    const db = new Database(dbPath);
    db.prepare(`UPDATE jobs SET availableAt = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      jobId,
    );
    db.close();

    expect(jobs.claim("worker-replacement").job).toMatchObject({
      id: jobId,
      workerId: "worker-replacement",
      claimGeneration: 2,
    });
    const handoff = {
      jobId,
      sessionId: "dev",
      commitSha: "replacement-candidate",
      branch: "refs/pushpals/agent/worker/replacement-candidate",
      message: "replacement candidate retained",
      trustedValidationCommands: ["bun test"],
      trustedValidationSummary: "Run the trusted test suite",
      trustedValidationDetail: "The candidate requires host-side verification",
      jobResultSummary: "Replacement worker produced a candidate",
      jobArtifacts: [{ kind: "commit", sha: "replacement-candidate" }],
    };

    expect(completions.enqueue(handoff, staleAuthority)).toMatchObject({
      ok: false,
      code: COMPLETION_HANDOFF_CONFLICT_CODE,
      message: expect.stringContaining("stale or owned by another worker"),
    });
    expect(jobs.getJob(jobId)).toMatchObject({
      status: "claimed",
      workerId: "worker-replacement",
      claimGeneration: 2,
    });
    expect(completions.getPendingCompletions()).toHaveLength(0);

    const winningAuthority = finalizationOptions(jobs, jobId);
    const accepted = completions.enqueue(handoff, winningAuthority);
    expect(accepted).toMatchObject({ ok: true, jobStatus: "finalizing" });
    expect(jobs.getJob(jobId)).toMatchObject({
      status: "finalizing",
      workerId: "worker-replacement",
      claimGeneration: 2,
    });
    expect(completions.enqueue(handoff, winningAuthority)).toMatchObject({
      ok: true,
      completionId: accepted.completionId,
      deduped: true,
      jobStatus: "finalizing",
    });
    const changedImmutableHandoffs = [
      { ...handoff, commitSha: "changed-after-response-loss" },
      { ...handoff, trustedValidationSummary: "Changed validation summary" },
      { ...handoff, trustedValidationDetail: "Changed validation detail" },
      { ...handoff, jobResultSummary: "Changed parent result summary" },
      { ...handoff, jobArtifacts: [{ kind: "commit", sha: "different-candidate" }] },
    ];
    for (const changedHandoff of changedImmutableHandoffs) {
      expect(completions.enqueue(changedHandoff, winningAuthority)).toMatchObject({
        ok: false,
        code: COMPLETION_HANDOFF_CONFLICT_CODE,
        message: expect.stringContaining("different immutable handoff metadata"),
      });
    }
    expect(completions.listCompletions({ status: "all" })).toHaveLength(1);
    expect(jobs.getJob(jobId)?.result).toBe(
      JSON.stringify({
        summary: handoff.jobResultSummary,
        artifacts: handoff.jobArtifacts,
      }),
    );

    completions.close();
    jobs.close();
  });

  test("accepts exact-authority diagnostics after the job enters finalizing", () => {
    const { jobs, completions, jobId } = createSharedQueues();
    const options = finalizationOptions(jobs, jobId);
    if (!options.beginJobFinalization) throw new Error("finalization authority is required");
    const authority = options.jobClaimAuthority;
    expect(
      completions.enqueue(
        {
          jobId,
          sessionId: "dev",
          commitSha: "candidate-with-late-diagnostics",
          branch: "refs/pushpals/agent/worker/candidate-with-late-diagnostics",
          message: "candidate retained before diagnostics upload",
        },
        options,
      ),
    ).toMatchObject({ ok: true, jobStatus: "finalizing" });
    expect(jobs.getJob(jobId)?.status).toBe("finalizing");

    expect(
      jobs.saveJobDiagnostics(
        jobId,
        {
          diagnostics: {
            validationRuns: [{ attempt: 1, command: "bun test", exitCode: 0, passed: true }],
          },
        },
        {
          workerId: authority.workerId,
          claimGeneration: authority.claimGeneration + 1,
        },
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining("ownership changed") });
    expect(jobs.getJobDiagnostics(jobId).validationRuns).toHaveLength(0);

    expect(
      jobs.saveJobDiagnostics(
        jobId,
        {
          diagnostics: {
            validationRuns: [{ attempt: 1, command: "bun test", exitCode: 0, passed: true }],
          },
        },
        authority,
      ),
    ).toMatchObject({ ok: true, counts: { validationRuns: 1 } });
    expect(jobs.getJob(jobId)?.status).toBe("finalizing");

    const completionClaim = completions.claim("scm-diagnostics-order");
    expect(
      completions.markProcessedAndFinalizeJob(
        completionClaim.completion?.id ?? "",
        "https://github.com/pushpals/pushpals/pull/123",
        undefined,
        undefined,
        "scm-diagnostics-order",
        completionClaim.completion?.claimToken,
      ),
    ).toMatchObject({ ok: true, jobTransitioned: true });
    expect(jobs.getJobDiagnostics(jobId).terminal).toMatchObject({
      status: "completed",
      terminalStage: "publication",
    });
    expect(
      jobs.saveJobDiagnostics(
        jobId,
        {
          diagnostics: {
            terminal: {
              status: "completed",
              terminalStage: "worker-late-overwrite",
              summary: "must not replace publication authority",
            },
          },
        },
        authority,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining("ownership changed") });
    expect(jobs.getJobDiagnostics(jobId).terminal).toMatchObject({
      status: "completed",
      terminalStage: "publication",
    });

    completions.close();
    jobs.close();
  });

  test("repoints durable owners when startup reconciliation abandons an ordinary duplicate", () => {
    const dir = mkdtempSync(join(tmpdir(), "pushpals-completion-owner-startup-migration-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "pushpals.db");
    let jobs: JobQueue | null = new JobQueue(dbPath);
    let completions: CompletionQueue | null = new CompletionQueue(dbPath);

    try {
      const dedupeKey = "legacy:startup-publication-owner";
      const publicationEnqueued = jobs.enqueue({
        taskId: "task-startup-publication-owner",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
        dedupeKey,
      });
      const publicationJobId = String(publicationEnqueued.jobId ?? "");
      const publicationWorkerId = "worker-startup-publication-owner";
      const publicationClaim = jobs.claim(publicationWorkerId).job;
      expect(publicationClaim?.id).toBe(publicationJobId);
      const publicationCompletion = completions.enqueue({
        jobId: publicationJobId,
        sessionId: "dev",
        commitSha: "startup-publication-owner",
        branch: "refs/pushpals/agent/worker/startup-publication-owner",
        message: "legacy publication awaiting startup reconciliation",
      });
      expect(publicationCompletion.ok).toBe(true);
      expect(
        jobs.complete(
          publicationJobId,
          { summary: "legacy worker completed before publication" },
          {
            workerId: publicationWorkerId,
            claimGeneration: Number(publicationClaim?.claimGeneration ?? 0),
          },
        ).ok,
      ).toBe(true);

      const duplicateEnqueued = jobs.enqueue({
        taskId: "task-startup-ordinary-duplicate",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
        dedupeKey,
      });
      const duplicateJobId = String(duplicateEnqueued.jobId ?? "");
      const duplicateWorkerId = "worker-startup-ordinary-duplicate";
      expect(jobs.claim(duplicateWorkerId).job?.id).toBe(duplicateJobId);
      const owners = seedLegacyDurableOwners(dbPath, "startup-ordinary-duplicate", duplicateJobId);

      completions.close();
      completions = null;
      jobs.close();
      jobs = null;

      // Production constructs JobQueue first. Because the publication parent
      // is still completed, only CompletionQueue can see that it outranks the
      // ordinary claimed duplicate when restoring finalizing state.
      jobs = new JobQueue(dbPath);
      expect(jobs.getJob(duplicateJobId)?.status).toBe("claimed");
      completions = new CompletionQueue(dbPath);

      expect(jobs.getJob(publicationJobId)).toMatchObject({
        status: "finalizing",
        dedupeKey,
      });
      expect(jobs.getJob(duplicateJobId)).toMatchObject({
        status: "abandoned",
        dedupeKey,
      });
      expect(
        jobs.listWorkers().find((worker) => worker.workerId === duplicateWorkerId),
      ).toMatchObject({ status: "idle", currentJobId: null });
      expectLegacyDurableOwners(dbPath, owners, publicationJobId);

      const completionClaim = completions.claim("scm-startup-publication-owner").completion;
      expect(completionClaim?.id).toBe(publicationCompletion.completionId);
      expect(
        completions.markProcessedAndFinalizeJob(
          String(publicationCompletion.completionId ?? ""),
          "https://github.com/org/repo/pull/startup-publication-owner",
          undefined,
          undefined,
          "scm-startup-publication-owner",
          completionClaim?.claimToken,
        ),
      ).toMatchObject({ ok: true, jobId: publicationJobId, jobTransitioned: true });
    } finally {
      completions?.close();
      jobs?.close();
    }
  });

  test("restores two same-key legacy publication parents without dropping either completion", () => {
    const dir = mkdtempSync(join(tmpdir(), "pushpals-completion-dedupe-migration-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "pushpals.db");
    let jobs: JobQueue | null = new JobQueue(dbPath);
    let completions: CompletionQueue | null = new CompletionQueue(dbPath);

    try {
      const dedupeKey = "legacy:two-unresolved-publications";
      const seedLegacyParent = (suffix: string): { jobId: string; completionId: string } => {
        const enqueued = jobs!.enqueue({
          taskId: `task-legacy-publication-${suffix}`,
          sessionId: "dev",
          kind: "task.execute",
          params: {},
          dedupeKey,
        });
        const jobId = String(enqueued.jobId ?? "");
        const workerId = `worker-legacy-publication-${suffix}`;
        const claimed = jobs!.claim(workerId).job;
        expect(claimed).toMatchObject({ id: jobId, workerId });
        const completion = completions!.enqueue({
          jobId,
          sessionId: "dev",
          commitSha: `legacy-${suffix}`,
          branch: `refs/pushpals/agent/worker/legacy-${suffix}`,
          message: `legacy candidate ${suffix}`,
        });
        expect(completion.ok).toBe(true);
        expect(
          jobs!.complete(
            jobId,
            { summary: `legacy premature completion ${suffix}` },
            {
              workerId,
              claimGeneration: Number(claimed?.claimGeneration ?? 0),
            },
          ).ok,
        ).toBe(true);
        return { jobId, completionId: String(completion.completionId ?? "") };
      };

      const first = seedLegacyParent("first");
      const second = seedLegacyParent("second");
      expect(jobs.countByStatus()).toMatchObject({ completed: 2, finalizing: 0 });

      completions.close();
      completions = null;
      jobs.close();
      jobs = null;

      // Production opens JobQueue first, which installs the widened active
      // dedupe index, and CompletionQueue second, which restores legacy parent
      // states. The second constructor used to fail on this exact database.
      jobs = new JobQueue(dbPath);
      completions = new CompletionQueue(dbPath);

      const parentRows = [jobs.getJob(first.jobId), jobs.getJob(second.jobId)];
      expect(parentRows.map((row) => row?.status)).toEqual(["finalizing", "finalizing"]);
      expect(parentRows.filter((row) => row?.dedupeKey === dedupeKey)).toHaveLength(1);
      expect(parentRows.filter((row) => row?.dedupeKey === null)).toHaveLength(1);
      expect(completions.getCompletion(first.completionId)).toMatchObject({
        jobId: first.jobId,
        status: "pending",
      });
      expect(completions.getCompletion(second.completionId)).toMatchObject({
        jobId: second.jobId,
        status: "pending",
      });

      const releasedParent = parentRows.find((row) => row?.dedupeKey === null);
      expect(
        jobs
          .listJobLogs(String(releasedParent?.id))
          .some(
            (log) =>
              log.message.includes("completion startup reconciliation") &&
              log.message.includes("publication remains active"),
          ),
      ).toBe(true);
      terminalizeTwoPublicationCandidates({
        jobs,
        completions,
        completionIds: [first.completionId, second.completionId],
      });
    } finally {
      completions?.close();
      jobs?.close();
    }
  });

  test("restores a completed legacy parent beside an existing same-key finalizing parent", () => {
    const dir = mkdtempSync(join(tmpdir(), "pushpals-completion-finalizing-collision-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "pushpals.db");
    let jobs: JobQueue | null = new JobQueue(dbPath);
    let completions: CompletionQueue | null = new CompletionQueue(dbPath);

    try {
      const dedupeKey = "legacy:completed-and-finalizing";
      const legacyEnqueued = jobs.enqueue({
        taskId: "task-legacy-completed-parent",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
        dedupeKey,
      });
      const legacyJobId = String(legacyEnqueued.jobId ?? "");
      const legacyClaim = jobs.claim("worker-legacy-completed-parent").job;
      expect(legacyClaim?.id).toBe(legacyJobId);
      const legacyCompletion = completions.enqueue({
        jobId: legacyJobId,
        sessionId: "dev",
        commitSha: "legacy-completed-candidate",
        branch: "refs/pushpals/agent/worker/legacy-completed-candidate",
        message: "legacy completed candidate",
      });
      expect(legacyCompletion.ok).toBe(true);
      expect(
        jobs.complete(
          legacyJobId,
          { summary: "legacy premature completion" },
          {
            workerId: "worker-legacy-completed-parent",
            claimGeneration: Number(legacyClaim?.claimGeneration ?? 0),
          },
        ).ok,
      ).toBe(true);

      const currentEnqueued = jobs.enqueue({
        taskId: "task-current-finalizing-parent",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
        dedupeKey,
      });
      const currentJobId = String(currentEnqueued.jobId ?? "");
      expect(jobs.claim("worker-current-finalizing-parent").job?.id).toBe(currentJobId);
      const currentCompletion = completions.enqueue(
        {
          jobId: currentJobId,
          sessionId: "dev",
          commitSha: "current-finalizing-candidate",
          branch: "refs/pushpals/agent/worker/current-finalizing-candidate",
          message: "current finalizing candidate",
        },
        finalizationOptions(jobs, currentJobId),
      );
      expect(currentCompletion).toMatchObject({ ok: true, jobStatus: "finalizing" });
      expect(jobs.getJob(legacyJobId)).toMatchObject({ status: "completed", dedupeKey });
      expect(jobs.getJob(currentJobId)).toMatchObject({ status: "finalizing", dedupeKey });

      completions.close();
      completions = null;
      jobs.close();
      jobs = null;

      jobs = new JobQueue(dbPath);
      completions = new CompletionQueue(dbPath);

      expect(jobs.getJob(legacyJobId)).toMatchObject({
        status: "finalizing",
        dedupeKey,
      });
      expect(jobs.getJob(currentJobId)).toMatchObject({
        status: "finalizing",
        dedupeKey: null,
      });
      expect(completions.getCompletion(String(legacyCompletion.completionId ?? ""))).toMatchObject({
        jobId: legacyJobId,
        status: "pending",
      });
      expect(completions.getCompletion(String(currentCompletion.completionId ?? ""))).toMatchObject(
        {
          jobId: currentJobId,
          status: "pending",
        },
      );
      expect(
        jobs
          .listJobLogs(currentJobId)
          .some((log) => log.message.includes("publication remains active")),
      ).toBe(true);
    } finally {
      completions?.close();
      jobs?.close();
    }
  });

  test("promotes a claimed same-key parent and terminalizes both unresolved completions", () => {
    const dir = mkdtempSync(join(tmpdir(), "pushpals-completion-claimed-collision-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "pushpals.db");
    let jobs: JobQueue | null = new JobQueue(dbPath);
    let completions: CompletionQueue | null = new CompletionQueue(dbPath);

    try {
      const dedupeKey = "legacy:completed-and-claimed-publications";
      const legacyEnqueued = jobs.enqueue({
        taskId: "task-legacy-completed-before-claimed",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
        dedupeKey,
      });
      const legacyJobId = String(legacyEnqueued.jobId ?? "");
      const legacyClaim = jobs.claim("worker-legacy-before-claimed").job;
      const legacyCompletion = completions.enqueue({
        jobId: legacyJobId,
        sessionId: "dev",
        commitSha: "legacy-before-claimed",
        branch: "refs/pushpals/agent/worker/legacy-before-claimed",
        message: "legacy completed candidate",
      });
      expect(
        jobs.complete(
          legacyJobId,
          { summary: "legacy premature completion" },
          {
            workerId: "worker-legacy-before-claimed",
            claimGeneration: Number(legacyClaim?.claimGeneration ?? 0),
          },
        ).ok,
      ).toBe(true);

      const claimedEnqueued = jobs.enqueue({
        taskId: "task-claimed-with-completion",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
        dedupeKey,
      });
      const claimedJobId = String(claimedEnqueued.jobId ?? "");
      expect(jobs.claim("worker-claimed-with-completion").job?.id).toBe(claimedJobId);
      const claimedCompletion = completions.enqueue({
        jobId: claimedJobId,
        sessionId: "dev",
        commitSha: "claimed-unresolved-candidate",
        branch: "refs/pushpals/agent/worker/claimed-unresolved-candidate",
        message: "claimed parent already persisted its candidate",
      });
      expect(claimedCompletion.ok).toBe(true);

      completions.close();
      completions = null;
      jobs.close();
      jobs = null;

      jobs = new JobQueue(dbPath);
      completions = new CompletionQueue(dbPath);

      const publicationParents = [jobs.getJob(legacyJobId), jobs.getJob(claimedJobId)];
      expect(publicationParents.map((row) => row?.status)).toEqual(["finalizing", "finalizing"]);
      expect(publicationParents.filter((row) => row?.dedupeKey === dedupeKey)).toHaveLength(1);
      expect(publicationParents.filter((row) => row?.dedupeKey === null)).toHaveLength(1);
      expect(completions.getCompletion(String(legacyCompletion.completionId ?? ""))).toMatchObject({
        jobId: legacyJobId,
        status: "pending",
      });
      expect(completions.getCompletion(String(claimedCompletion.completionId ?? ""))).toMatchObject(
        {
          jobId: claimedJobId,
          status: "pending",
        },
      );
      expect(
        jobs.listWorkers().find((worker) => worker.workerId === "worker-claimed-with-completion"),
      ).toMatchObject({ status: "idle", currentJobId: null });

      const releasedParent = publicationParents.find((row) => row?.dedupeKey === null);
      expect(
        jobs
          .listJobLogs(String(releasedParent?.id))
          .some(
            (log) =>
              log.message.includes("completion startup reconciliation") &&
              log.message.includes("publication remains active"),
          ),
      ).toBe(true);
      terminalizeTwoPublicationCandidates({
        jobs,
        completions,
        completionIds: [
          String(legacyCompletion.completionId ?? ""),
          String(claimedCompletion.completionId ?? ""),
        ],
      });
    } finally {
      completions?.close();
      jobs?.close();
    }
  });

  test("promotes a pending same-key parent and terminalizes both unresolved completions", () => {
    const dir = mkdtempSync(join(tmpdir(), "pushpals-completion-pending-collision-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "pushpals.db");
    let jobs: JobQueue | null = new JobQueue(dbPath);
    let completions: CompletionQueue | null = new CompletionQueue(dbPath);

    try {
      const dedupeKey = "legacy:completed-and-pending-publications";
      const legacyEnqueued = jobs.enqueue({
        taskId: "task-legacy-completed-before-pending",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
        dedupeKey,
      });
      const legacyJobId = String(legacyEnqueued.jobId ?? "");
      const legacyClaim = jobs.claim("worker-legacy-before-pending").job;
      const legacyCompletion = completions.enqueue({
        jobId: legacyJobId,
        sessionId: "dev",
        commitSha: "legacy-before-pending",
        branch: "refs/pushpals/agent/worker/legacy-before-pending",
        message: "legacy completed candidate",
      });
      expect(
        jobs.complete(
          legacyJobId,
          { summary: "legacy premature completion" },
          {
            workerId: "worker-legacy-before-pending",
            claimGeneration: Number(legacyClaim?.claimGeneration ?? 0),
          },
        ).ok,
      ).toBe(true);

      const pendingEnqueued = jobs.enqueue({
        taskId: "task-pending-with-completion",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
        dedupeKey,
      });
      const pendingJobId = String(pendingEnqueued.jobId ?? "");
      const pendingCompletion = completions.enqueue({
        jobId: pendingJobId,
        sessionId: "dev",
        commitSha: "pending-unresolved-candidate",
        branch: "refs/pushpals/agent/worker/pending-unresolved-candidate",
        message: "pending parent already persisted its candidate",
      });
      expect(pendingCompletion.ok).toBe(true);
      expect(jobs.getJob(pendingJobId)?.status).toBe("pending");

      completions.close();
      completions = null;
      jobs.close();
      jobs = null;

      jobs = new JobQueue(dbPath);
      completions = new CompletionQueue(dbPath);

      const publicationParents = [jobs.getJob(legacyJobId), jobs.getJob(pendingJobId)];
      expect(publicationParents.map((row) => row?.status)).toEqual(["finalizing", "finalizing"]);
      expect(publicationParents.filter((row) => row?.dedupeKey === dedupeKey)).toHaveLength(1);
      expect(publicationParents.filter((row) => row?.dedupeKey === null)).toHaveLength(1);
      expect(jobs.getJob(pendingJobId)?.availableAt).toBeNull();
      expect(completions.getCompletion(String(legacyCompletion.completionId ?? ""))).toMatchObject({
        jobId: legacyJobId,
        status: "pending",
      });
      expect(completions.getCompletion(String(pendingCompletion.completionId ?? ""))).toMatchObject(
        {
          jobId: pendingJobId,
          status: "pending",
        },
      );

      const releasedParent = publicationParents.find((row) => row?.dedupeKey === null);
      expect(
        jobs
          .listJobLogs(String(releasedParent?.id))
          .some(
            (log) =>
              log.message.includes("completion startup reconciliation") &&
              log.message.includes("publication remains active"),
          ),
      ).toBe(true);
      terminalizeTwoPublicationCandidates({
        jobs,
        completions,
        completionIds: [
          String(legacyCompletion.completionId ?? ""),
          String(pendingCompletion.completionId ?? ""),
        ],
      });
    } finally {
      completions?.close();
      jobs?.close();
    }
  });

  for (const legacyParentStatus of ["claimed", "pending"] as const) {
    test(`preserves an old-index finalizing + ${legacyParentStatus} publication collision in constructor order`, () => {
      const dir = mkdtempSync(
        join(tmpdir(), `pushpals-completion-old-index-${legacyParentStatus}-collision-`),
      );
      tempDirs.push(dir);
      const dbPath = join(dir, "pushpals.db");
      let jobs: JobQueue | null = new JobQueue(dbPath);
      let completions: CompletionQueue | null = new CompletionQueue(dbPath);

      try {
        const dedupeKey = `legacy:finalizing-and-${legacyParentStatus}-publications`;
        const finalizingEnqueued = jobs.enqueue({
          taskId: `task-finalizing-before-${legacyParentStatus}`,
          sessionId: "dev",
          kind: "task.execute",
          params: {},
          dedupeKey,
        });
        const finalizingJobId = String(finalizingEnqueued.jobId ?? "");
        expect(jobs.claim(`worker-finalizing-before-${legacyParentStatus}`).job?.id).toBe(
          finalizingJobId,
        );
        const finalizingCompletion = completions.enqueue(
          {
            jobId: finalizingJobId,
            sessionId: "dev",
            commitSha: `finalizing-before-${legacyParentStatus}`,
            branch: `refs/pushpals/agent/worker/finalizing-before-${legacyParentStatus}`,
            message: `finalizing publication before ${legacyParentStatus} collision`,
          },
          finalizationOptions(jobs, finalizingJobId),
        );
        expect(finalizingCompletion).toMatchObject({ ok: true, jobStatus: "finalizing" });

        const sharedDb = (jobs as unknown as { db: Database }).db;
        sharedDb.exec(`
          DROP INDEX idx_jobs_dedupe_active;
          CREATE UNIQUE INDEX idx_jobs_dedupe_active
            ON jobs(dedupeKey)
            WHERE dedupeKey IS NOT NULL
              AND dedupeKey <> ''
              AND status IN ('pending','claimed');
        `);

        const legacyEnqueued = jobs.enqueue({
          taskId: `task-${legacyParentStatus}-with-persisted-completion`,
          sessionId: "dev",
          kind: "task.execute",
          params: {},
          dedupeKey: `${dedupeKey}:seed`,
        });
        const legacyJobId = String(legacyEnqueued.jobId ?? "");
        const legacyWorkerId = `worker-${legacyParentStatus}-with-persisted-completion`;
        if (legacyParentStatus === "claimed") {
          expect(jobs.claim(legacyWorkerId).job?.id).toBe(legacyJobId);
        }
        const legacyCompletion = completions.enqueue({
          jobId: legacyJobId,
          sessionId: "dev",
          commitSha: `${legacyParentStatus}-persisted-candidate`,
          branch: `refs/pushpals/agent/worker/${legacyParentStatus}-persisted-candidate`,
          message: `${legacyParentStatus} parent already persisted its publication candidate`,
        });
        expect(legacyCompletion.ok).toBe(true);
        sharedDb.prepare(`UPDATE jobs SET dedupeKey = ? WHERE id = ?`).run(dedupeKey, legacyJobId);
        expect(jobs.getJob(finalizingJobId)?.status).toBe("finalizing");
        expect(jobs.getJob(legacyJobId)?.status).toBe(legacyParentStatus);

        completions.close();
        completions = null;
        jobs.close();
        jobs = null;

        // The production server constructs JobQueue before CompletionQueue. The
        // first constructor must widen the old index without abandoning either
        // persisted publication candidate; the second promotes its legacy parent.
        jobs = new JobQueue(dbPath);
        expect(jobs.getJob(finalizingJobId)?.status).toBe("finalizing");
        expect(jobs.getJob(legacyJobId)?.status).toBe(legacyParentStatus);
        expect(
          [jobs.getJob(finalizingJobId), jobs.getJob(legacyJobId)].every(
            (row) => row?.status !== "abandoned",
          ),
        ).toBe(true);
        completions = new CompletionQueue(dbPath);

        const publicationParents = [jobs.getJob(finalizingJobId), jobs.getJob(legacyJobId)];
        expect(publicationParents.map((row) => row?.status)).toEqual(["finalizing", "finalizing"]);
        expect(publicationParents.filter((row) => row?.dedupeKey === dedupeKey)).toHaveLength(1);
        expect(publicationParents.filter((row) => row?.dedupeKey === null)).toHaveLength(1);
        expect(
          jobs
            .listJobLogs(finalizingJobId)
            .concat(jobs.listJobLogs(legacyJobId))
            .some((log) => log.message.includes("publication remains active")),
        ).toBe(true);
        if (legacyParentStatus === "claimed") {
          expect(
            jobs.listWorkers().find((worker) => worker.workerId === legacyWorkerId),
          ).toMatchObject({ status: "idle", currentJobId: null });
        }

        terminalizeTwoPublicationCandidates({
          jobs,
          completions,
          completionIds: [
            String(finalizingCompletion.completionId ?? ""),
            String(legacyCompletion.completionId ?? ""),
          ],
        });
      } finally {
        completions?.close();
        jobs?.close();
      }
    });
  }

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
    expect(
      completions.markFailed(
        handoff.completionId ?? "",
        "merge failed",
        ...currentCompletionClaim(completions, handoff.completionId ?? ""),
      ).ok,
    ).toBe(true);
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
      claimToken: expect.any(String),
      claimGeneration: 1,
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

    const processed = queue.markProcessed(
      completionId,
      "https://github.com/org/repo/pull/34",
      ...currentCompletionClaim(queue, completionId),
    );
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
    const claimToken = String(claimed.completion?.claimToken ?? "");
    expect(queue.renewLease(enqueued.completionId ?? "", "scm-other", claimToken).ok).toBe(false);
    expect(queue.renewLease(enqueued.completionId ?? "", "scm-owner", claimToken).ok).toBe(true);
    queue.close();
  });

  test("rejects ownerless completion lease and terminal callbacks", () => {
    const queue = new CompletionQueue(":memory:");
    const enqueued = queue.enqueue({
      jobId: "job-ownerless-callback",
      sessionId: "dev",
      message: "candidate retained",
    });
    const completionId = String(enqueued.completionId ?? "");
    expect(queue.claim("scm-owner").ok).toBe(true);

    expect(queue.renewLease(completionId, "", "").ok).toBe(false);
    expect(queue.markProcessed(completionId).ok).toBe(false);
    expect(queue.markFailed(completionId, "ownerless failure").ok).toBe(false);
    expect(queue.getCompletion(completionId)?.status).toBe("claimed");
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
    const firstClaim = queue.claim("scm-old");
    expect(firstClaim.ok).toBe(true);
    const staleToken = String(firstClaim.completion?.claimToken ?? "");
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
    expect(queue.markProcessed(enqueued.completionId ?? "", null, "scm-old", staleToken).ok).toBe(
      false,
    );
    expect(
      queue.markProcessed(
        enqueued.completionId ?? "",
        null,
        "scm-new",
        reclaimed.completion?.claimToken,
      ).ok,
    ).toBe(true);
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
    const processedClaim = queue.claim("scm-expired");
    expect(processedClaim.ok).toBe(true);
    db.prepare(`UPDATE completions SET leaseExpiresAt = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      processedCandidate.completionId,
    );
    expect(
      queue.markProcessed(
        processedCandidate.completionId ?? "",
        null,
        "scm-expired",
        processedClaim.completion?.claimToken,
      ).ok,
    ).toBe(false);

    const failedCandidate = queue.enqueue({
      jobId: "job-expired-failed-callback",
      sessionId: "dev",
      message: "candidate retained",
    });
    const failedClaim = queue.claim("scm-expired");
    expect(failedClaim.ok).toBe(true);
    db.prepare(`UPDATE completions SET leaseExpiresAt = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      failedCandidate.completionId,
    );
    expect(
      queue.markFailed(
        failedCandidate.completionId ?? "",
        "stale callback",
        "scm-expired",
        failedClaim.completion?.claimToken,
      ).ok,
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
      finalizationOptions(jobs, jobId),
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
        row?.claimToken,
      ),
    ).toMatchObject({ ok: false });
    expect(jobs.getJob(jobId)?.status).toBe("finalizing");
    completions.close();
    jobs.close();
  });

  test("does not revoke an unexpired claim when the same pusher polls again", () => {
    const queue = new CompletionQueue(":memory:");
    const first = queue.enqueue({ jobId: "job-reconcile-1", sessionId: "dev", message: "one" });
    const second = queue.enqueue({ jobId: "job-reconcile-2", sessionId: "dev", message: "two" });
    const claimed = queue.claim("scm-stable");
    expect(claimed.completion?.id).toBe(first.completionId);
    const originalToken = claimed.completion?.claimToken;

    const secondPoll = queue.claim("scm-stable");
    expect(secondPoll.ok).toBe(false);
    expect(queue.getCompletion(first.completionId ?? "")).toMatchObject({
      status: "claimed",
      claimToken: originalToken,
      claimAttempts: 1,
    });
    expect(queue.getPendingCompletions().map((row) => row.id)).toEqual([second.completionId]);
    queue.close();
  });

  test("fences stale callbacks when the same pusher reclaims after expiry", () => {
    const db = new Database(":memory:");
    const queue = new CompletionQueue(db);
    const enqueued = queue.enqueue({
      jobId: "job-same-pusher-aba",
      sessionId: "dev",
      message: "one",
    });
    const completionId = String(enqueued.completionId ?? "");
    const first = queue.claim("scm-stable");
    const staleToken = String(first.completion?.claimToken ?? "");
    db.prepare(`UPDATE completions SET leaseExpiresAt = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      completionId,
    );
    const second = queue.claim("scm-stable");
    const activeToken = String(second.completion?.claimToken ?? "");
    expect(activeToken).not.toBe(staleToken);
    expect(second.completion?.claimGeneration).toBe(2);

    expect(queue.renewLease(completionId, "scm-stable", staleToken).ok).toBe(false);
    expect(queue.markProcessed(completionId, null, "scm-stable", staleToken).ok).toBe(false);
    expect(queue.markFailed(completionId, "stale", "scm-stable", staleToken).ok).toBe(false);
    expect(queue.renewLease(completionId, "scm-stable", activeToken).ok).toBe(true);
    expect(queue.markProcessed(completionId, null, "scm-stable", activeToken).ok).toBe(true);
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
