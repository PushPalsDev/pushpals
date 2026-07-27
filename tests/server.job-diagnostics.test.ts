import { describe, expect, test } from "bun:test";
import { JobQueue } from "../apps/server/src/jobs";

describe("server JobQueue diagnostics", () => {
  function enqueueClaimedJob(
    queue: JobQueue,
    taskId: string,
    params: Record<string, unknown> = {},
  ): string {
    const enqueued = queue.enqueue({
      taskId,
      sessionId: "dev",
      kind: "task.execute",
      params,
    });
    expect(enqueued.ok).toBe(true);
    const jobId = String(enqueued.jobId ?? "");
    expect(jobId.length).toBeGreaterThan(0);
    const claimed = queue.claim("worker-diagnostics");
    expect(claimed.ok).toBe(true);
    expect(claimed.job?.id).toBe(jobId);
    return jobId;
  }

  function failNoPublishableJob(
    queue: JobQueue,
    taskId: string,
    params: Record<string, unknown> = {},
  ): void {
    const jobId = enqueueClaimedJob(queue, taskId, params);
    const failed = queue.fail(jobId, {
      message: "executor failed",
      diagnostics: {
        attempts: [
          {
            attempt: 1,
            workerId: "worker-diagnostics",
            backend: "openai_codex",
            model: "gpt-5.6-sol",
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

  test("explicit diagnostic uploads survive a later partial terminal update", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueClaimedJob(queue, "task-diagnostic-upload");
    const uploaded = queue.saveJobDiagnostics(jobId, {
      diagnostics: {
        validationRuns: [
          {
            attempt: 1,
            command: "bun run validate",
            exitCode: 0,
            durationMs: 1234,
            passed: true,
          },
        ],
        patchSnapshots: [
          {
            attempt: 1,
            phase: "quality",
            publishableFileCount: 2,
            artifactOnlyPathCount: 0,
            changedPathSample: ["app/index.tsx", "tests/index.test.ts"],
            capturedAt: new Date().toISOString(),
          },
        ],
      },
    });
    expect(uploaded.ok).toBe(true);
    expect(uploaded.counts?.validationRuns).toBe(1);
    expect(uploaded.counts?.patchSnapshots).toBe(1);

    const completed = queue.complete(jobId, {
      summary: "done",
      diagnostics: {
        attempts: [{ attempt: 1, terminalReason: "done", exitCode: 0 }],
        terminal: { failureClass: "success", terminalStage: "completed" },
      },
    });
    expect(completed.ok).toBe(true);
    const persisted = queue.getJobDiagnostics(jobId);
    expect(persisted.validationRuns).toHaveLength(1);
    expect(persisted.patchSnapshots).toHaveLength(1);
  });

  function failCodexStartupStallJob(
    queue: JobQueue,
    taskId: string,
    params: Record<string, unknown> = {},
  ): void {
    const jobId = enqueueClaimedJob(queue, taskId, params);
    const failed = queue.fail(jobId, {
      message: "openai_codex stalled before first response",
      diagnostics: {
        attempts: [
          {
            attempt: 1,
            workerId: "worker-diagnostics",
            backend: "openai_codex",
            model: "gpt-5.6-sol",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 120000,
            terminalReason: "openai_codex stalled before first response",
            exitCode: 124,
          },
        ],
        terminal: {
          status: "failed",
          failureClass: "codex_startup_stall",
          terminalStage: "executor_startup",
          executorBackend: "openai_codex",
          summary: "openai_codex stalled before first response",
          watchdogFired: true,
          publishableFileCount: 0,
          artifactOnlyPathCount: 0,
          changedPathSample: [],
        },
      },
    });
    expect(failed.ok).toBe(true);
  }

  function failValidationFingerprintJob(
    queue: JobQueue,
    taskId: string,
    options: {
      patternKey: string;
      targetPath: string;
      command?: string;
      failureClass?: string;
      failedTest?: string;
      singularTargetPath?: boolean;
    },
  ): void {
    const jobId = enqueueClaimedJob(queue, taskId, {
      origin: "autonomy",
      ...(options.singularTargetPath ? { targetPath: options.targetPath } : {}),
      autonomy: {
        patternKey: options.patternKey,
        ...(options.singularTargetPath ? {} : { targetPaths: [options.targetPath] }),
      },
    });
    const command = options.command ?? "bun test tests/appRouteShellImportBoundaryProbe.test.ts";
    const failureClass = options.failureClass ?? "validation_failed";
    const failedTest =
      options.failedTest ?? "route shell import boundary > rejects forbidden feature imports";
    const failed = queue.fail(jobId, {
      message: "focused validation failed",
      diagnostics: {
        validationRuns: [
          {
            attempt: 1,
            command,
            exitCode: 1,
            durationMs: 1000,
            passed: false,
            failureClass,
            stderrTail: `(fail) ${failedTest} [12.00ms]`,
          },
        ],
        terminal: {
          status: "failed",
          failureClass,
          terminalStage: "quality_gate",
          summary: "focused validation failed",
          changedPathSample: [options.targetPath],
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

  test("does not count codex startup stalls as no-publishable failures", () => {
    const queue = new JobQueue(":memory:");
    try {
      failCodexStartupStallJob(queue, "task-startup-stall-1");
      failCodexStartupStallJob(queue, "task-startup-stall-2");
      failCodexStartupStallJob(queue, "task-startup-stall-3");

      const summary = queue.noPublishableFailureCircuitSummary({
        windowMs: 60 * 60 * 1000,
        threshold: 3,
        failureRateThreshold: 0.5,
      });
      expect(summary.blocked).toBe(false);
      expect(summary.noPublishableFailureCount).toBe(0);
      expect(summary.terminalCount).toBe(3);
    } finally {
      queue.close();
    }
  });

  test("suppresses similar autonomy no-publishable failures by pattern key", () => {
    const queue = new JobQueue(":memory:");
    try {
      const params = {
        origin: "autonomy",
        autonomy: {
          patternKey: "ui.readability.polish",
        },
        planning: {
          targetPaths: ["src/shell.ts"],
        },
      };
      failNoPublishableJob(queue, "task-similar-pattern-1", params);
      expect(
        queue.similarNoPublishableFailureSummary({
          patternKey: "ui.readability.polish",
          targetPaths: ["src/shell.ts"],
          threshold: 2,
        }).blocked,
      ).toBe(false);

      failNoPublishableJob(queue, "task-similar-pattern-2", params);
      const summary = queue.similarNoPublishableFailureSummary({
        patternKey: "ui.readability.polish",
        targetPaths: ["src/other.ts"],
        threshold: 2,
      });
      expect(summary.blocked).toBe(true);
      expect(summary.recentSimilarFailureCount).toBe(2);
      expect(summary.patternKey).toBe("ui.readability.polish");
      expect(summary.lastFailureAt).toBeTruthy();
    } finally {
      queue.close();
    }
  });

  test("does not suppress similar autonomy work after codex startup stalls", () => {
    const queue = new JobQueue(":memory:");
    try {
      const params = {
        origin: "autonomy",
        autonomy: {
          patternKey: "infra.startup.stall",
        },
        planning: {
          targetPaths: ["src/retryable.ts"],
        },
      };
      failCodexStartupStallJob(queue, "task-startup-stall-similar-1", params);
      failCodexStartupStallJob(queue, "task-startup-stall-similar-2", params);

      const summary = queue.similarNoPublishableFailureSummary({
        patternKey: "infra.startup.stall",
        targetPaths: ["src/retryable.ts"],
        threshold: 2,
      });
      expect(summary.blocked).toBe(false);
      expect(summary.recentSimilarFailureCount).toBe(0);
    } finally {
      queue.close();
    }
  });

  test("suppresses similar autonomy no-publishable failures by overlapping target paths", () => {
    const queue = new JobQueue(":memory:");
    try {
      failNoPublishableJob(queue, "task-similar-path-1", {
        origin: "autonomy",
        autonomy: {
          patternKey: "first.pattern",
        },
        paths: ["src/components/Button.tsx"],
      });
      failNoPublishableJob(queue, "task-similar-path-2", {
        origin: "autonomy",
        autonomy: {
          patternKey: "second.pattern",
        },
        planning: {
          targetPaths: ["src/components"],
        },
      });

      const summary = queue.similarNoPublishableFailureSummary({
        patternKey: "unrelated.pattern",
        targetPaths: ["src/components/Button.tsx"],
        threshold: 2,
      });
      expect(summary.blocked).toBe(true);
      expect(summary.recentSimilarFailureCount).toBe(2);
      expect(summary.targetPathSample).toEqual(["src/components/button.tsx"]);

      const unrelated = queue.similarNoPublishableFailureSummary({
        patternKey: "unrelated.pattern",
        targetPaths: ["docs/release.md"],
        threshold: 2,
      });
      expect(unrelated.blocked).toBe(false);
    } finally {
      queue.close();
    }
  });

  test("suppresses unchanged target-and-failure clusters across pattern-key variations", () => {
    const queue = new JobQueue(":memory:");
    try {
      failValidationFingerprintJob(queue, "task-fingerprint-1", {
        patternKey: "route.shell.first-wording",
        targetPath: "app/(tabs)/_layout.tsx",
      });
      expect(
        queue.similarFailureFingerprintSummary({
          targetPaths: ["app/(tabs)/_layout.tsx"],
          threshold: 2,
        }).blocked,
      ).toBe(false);

      failValidationFingerprintJob(queue, "task-fingerprint-2", {
        patternKey: "totally.different.prompt-key",
        targetPath: "app/(tabs)/_layout.tsx",
        singularTargetPath: true,
      });
      const summary = queue.similarFailureFingerprintSummary({
        targetPaths: ["app/(tabs)/_layout.tsx"],
        threshold: 2,
      });
      expect(summary.blocked).toBe(true);
      expect(summary.recentSimilarFailureCount).toBe(2);
      expect(summary.fingerprint).toHaveLength(24);
      expect(summary.command).toContain("approuteshellimportboundaryprobe");
      expect(summary.failedTestSample).toContain(
        "route shell import boundary > rejects forbidden feature imports",
      );

      expect(
        queue.similarFailureFingerprintSummary({
          targetPaths: ["docs/release.md"],
          threshold: 2,
        }).blocked,
      ).toBe(false);

      failValidationFingerprintJob(queue, "task-fingerprint-distinct-a", {
        patternKey: "shared-parent-a",
        targetPath: "app/components/alpha.tsx",
      });
      failValidationFingerprintJob(queue, "task-fingerprint-distinct-b", {
        patternKey: "shared-parent-b",
        targetPath: "app/components/beta.tsx",
      });
      const sharedParent = queue.similarFailureFingerprintSummary({
        targetPaths: ["app/components"],
        threshold: 2,
      });
      expect(sharedParent.blocked).toBe(false);
      expect(sharedParent.recentSimilarFailureCount).toBe(1);
    } finally {
      queue.close();
    }
  });
});
