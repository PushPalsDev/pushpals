import { describe, expect, test } from "bun:test";
import { JobQueue } from "../apps/server/src/jobs";

describe("server JobQueue diagnostics", () => {
  function enqueueClaimedJob(queue: JobQueue, taskId: string): string {
    const enqueued = queue.enqueue({
      taskId,
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(enqueued.ok).toBe(true);
    const jobId = String(enqueued.jobId ?? "");
    expect(jobId.length).toBeGreaterThan(0);
    const claimed = queue.claim("worker-diagnostics");
    expect(claimed.ok).toBe(true);
    expect(claimed.job?.id).toBe(jobId);
    return jobId;
  }

  function failNoPublishableJob(queue: JobQueue, taskId: string): void {
    const jobId = enqueueClaimedJob(queue, taskId);
    const failed = queue.fail(jobId, {
      message: "executor failed",
      diagnostics: {
        attempts: [
          {
            attempt: 1,
            workerId: "worker-diagnostics",
            backend: "openai_codex",
            model: "gpt-5.5",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 120000,
            terminalReason: "openai_codex made no publishable changes before the no-edit watchdog",
            exitCode: 124,
          },
        ],
        terminal: {
          status: "failed",
          failureClass: "artifact_only_no_publishable_patch",
          terminalStage: "executor",
          executorBackend: "openai_codex",
          summary: "openai_codex made no publishable changes before the no-edit watchdog",
          watchdogFired: true,
          publishableFileCount: 0,
          artifactOnlyPathCount: 0,
          changedPathSample: [],
        },
      },
    });
    expect(failed.ok).toBe(true);
  }

  function completePublishableJob(queue: JobQueue, taskId: string): void {
    const jobId = enqueueClaimedJob(queue, taskId);
    const completed = queue.complete(jobId, {
      summary: "executor produced a patch",
      diagnostics: {
        terminal: {
          status: "completed",
          failureClass: "success",
          terminalStage: "completed",
          executorBackend: "openai_codex",
          summary: "executor produced a patch",
          publishableFileCount: 1,
          artifactOnlyPathCount: 0,
          changedPathSample: ["src/example.ts"],
        },
      },
    });
    expect(completed.ok).toBe(true);
  }

  test("persists bounded terminal diagnostics for completed jobs", () => {
    const queue = new JobQueue(":memory:");
    const enqueued = queue.enqueue({
      taskId: "task-diagnostics-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(enqueued.ok).toBe(true);
    const jobId = String(enqueued.jobId ?? "");
    expect(jobId.length).toBeGreaterThan(0);

    const claimed = queue.claim("worker-diagnostics");
    expect(claimed.ok).toBe(true);
    expect(claimed.job?.id).toBe(jobId);

    const complete = queue.complete(jobId, {
      summary: "diagnostic success",
      diagnostics: {
        attempts: Array.from({ length: 10 }, (_, index) => ({
          attempt: index + 1,
          workerId: "worker-diagnostics",
          backend: "openai_codex",
          model: "codex-test",
          startedAt: "2026-06-06T12:00:00.000Z",
          finishedAt: "2026-06-06T12:00:01.000Z",
          durationMs: 1000,
          terminalReason: "ok",
          exitCode: 0,
        })),
        terminal: {
          failureClass: "success",
          terminalStage: "completed",
          executorBackend: "openai_codex",
          summary: "diagnostic success",
          changedPathSample: Array.from({ length: 60 }, (_, index) => `src/file-${index}.ts`),
        },
        phaseSpans: [
          {
            attempt: 1,
            phase: "focused validation",
            startedAt: "2026-06-06T12:00:00.000Z",
            finishedAt: "2026-06-06T12:00:01.000Z",
            durationMs: 1000,
            outcome: "completed",
          },
        ],
        validationRuns: Array.from({ length: 22 }, (_, index) => ({
          attempt: 1,
          command: `bun test ${index}`,
          exitCode: 0,
          durationMs: 25,
          passed: true,
          stdoutTail: "x".repeat(9000),
          stderrTail: "",
        })),
        patchSnapshots: [
          {
            attempt: 1,
            phase: "quality",
            publishableFileCount: 2,
            artifactOnlyPathCount: 0,
            changedPathSample: ["src/a.ts", "src/b.ts"],
            topLevelDirs: ["src"],
            capturedAt: "2026-06-06T12:00:01.000Z",
          },
        ],
      },
    });
    expect(complete.ok).toBe(true);

    const diagnostics = queue.getJobDiagnostics(jobId) as {
      terminal: { status: string; failureClass: string; changedPathSample: string[] } | null;
      attempts: unknown[];
      phaseSpans: Array<{ phase: string; durationMs: number }>;
      validationRuns: Array<{ command: string; stdoutTail: string | null }>;
      patchSnapshots: Array<{ publishableFileCount: number; topLevelDirs: string[] }>;
    };
    expect(diagnostics.terminal?.status).toBe("completed");
    expect(diagnostics.terminal?.failureClass).toBe("success");
    expect(diagnostics.terminal?.changedPathSample).toHaveLength(50);
    expect(diagnostics.attempts).toHaveLength(8);
    expect(diagnostics.phaseSpans).toEqual([
      expect.objectContaining({ phase: "focused validation", durationMs: 1000 }),
    ]);
    expect(diagnostics.validationRuns).toHaveLength(20);
    expect(diagnostics.validationRuns[0]?.command).toBe("bun test 0");
    expect((diagnostics.validationRuns[0]?.stdoutTail ?? "").length).toBeLessThanOrEqual(8000);
    expect(diagnostics.patchSnapshots).toEqual([
      expect.objectContaining({ publishableFileCount: 2, topLevelDirs: ["src"] }),
    ]);

    queue.close();
  });

  test("opens no-publishable failure circuit after repeated recent watchdog failures", () => {
    const queue = new JobQueue(":memory:");
    try {
      failNoPublishableJob(queue, "task-no-publishable-1");
      failNoPublishableJob(queue, "task-no-publishable-2");
      expect(
        queue.noPublishableFailureCircuitSummary({
          windowMs: 60 * 60 * 1000,
          threshold: 3,
          failureRateThreshold: 0.5,
        }).blocked,
      ).toBe(false);

      failNoPublishableJob(queue, "task-no-publishable-3");
      const summary = queue.noPublishableFailureCircuitSummary({
        windowMs: 60 * 60 * 1000,
        threshold: 3,
        failureRateThreshold: 0.5,
      });
      expect(summary.blocked).toBe(true);
      expect(summary.noPublishableFailureCount).toBe(3);
      expect(summary.terminalCount).toBe(3);
      expect(summary.lastFailureAt).toBeTruthy();
    } finally {
      queue.close();
    }
  });

  test("keeps no-publishable failure circuit closed when successes dominate", () => {
    const queue = new JobQueue(":memory:");
    try {
      failNoPublishableJob(queue, "task-no-publishable-rate-1");
      failNoPublishableJob(queue, "task-no-publishable-rate-2");
      failNoPublishableJob(queue, "task-no-publishable-rate-3");
      completePublishableJob(queue, "task-publishable-success-1");
      completePublishableJob(queue, "task-publishable-success-2");
      completePublishableJob(queue, "task-publishable-success-3");
      completePublishableJob(queue, "task-publishable-success-4");

      const summary = queue.noPublishableFailureCircuitSummary({
        windowMs: 60 * 60 * 1000,
        threshold: 3,
        failureRateThreshold: 0.5,
      });
      expect(summary.blocked).toBe(false);
      expect(summary.noPublishableFailureCount).toBe(3);
      expect(summary.completedCount).toBe(4);
      expect(summary.terminalCount).toBe(7);
      expect(summary.noPublishableFailureRate).toBeLessThan(0.5);
    } finally {
      queue.close();
    }
  });
});
