import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionQueue } from "../apps/server/src/completions";
import { JobQueue } from "../apps/server/src/jobs";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createSharedQueues(): {
  jobs: JobQueue;
  completions: CompletionQueue;
  jobId: string;
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
  return { jobs, completions, jobId };
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
    expect(queue.claim("scm-migrated").completion?.trustedValidationCommandsJson).toBe(
      JSON.stringify(["bun run validate:publish"]),
    );
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
});
