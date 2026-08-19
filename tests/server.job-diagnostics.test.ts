import { describe, expect, test } from "bun:test";
import { JobQueue, resolveWorkerRuntimeCircuitRetryAfterMs } from "../apps/server/src/jobs";

describe("server JobQueue diagnostics", () => {
  function enqueueClaimedJob(
    queue: JobQueue,
    taskId: string,
    params: Record<string, unknown> = {},
    workerId = "worker-diagnostics",
    runtimeGeneration?: string,
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
    const claimed = queue.claim(workerId, { runtimeGeneration });
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

  function failWorkerRuntimeJob(
    queue: JobQueue,
    taskId: string,
    options?: {
      failureClass?: string;
      detail?: string;
      summary?: string;
      terminalStage?: string;
      runtimeGeneration?: string;
    },
  ): void {
    const jobId = enqueueClaimedJob(
      queue,
      taskId,
      {
        origin: "autonomy",
        autonomy: { patternKey: `runtime.${taskId}` },
      },
      "worker-diagnostics",
      options?.runtimeGeneration,
    );
    const detail =
      options?.detail ??
      `ReferenceError: Cannot access 'timedOut' before initialization.\n` +
        `    at <anonymous> (/workspace/apps/workerpals/src/common/generic_python_executor.ts:412:13)\n` +
        `Bun v1.3.14`;
    const summary = options?.summary ?? "Job failed before returning a structured result";
    const failed = queue.fail(jobId, {
      message: "WorkerPal job execution failed",
      detail,
      diagnostics: {
        attempts: [
          {
            attempt: 1,
            workerId: "worker-diagnostics",
            backend: "openai_codex",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 15_000,
            terminalReason: detail,
            exitCode: 1,
          },
        ],
        terminal: {
          status: "failed",
          failureClass: options?.failureClass ?? "worker_runtime_failure",
          terminalStage: options?.terminalStage ?? "executor",
          executorBackend: "openai_codex",
          summary,
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

  test("opens the worker-runtime circuit after two identical internal failures", () => {
    const queue = new JobQueue(":memory:");
    try {
      failWorkerRuntimeJob(queue, "task-runtime-reference-error-1", {
        // Live v1.2.37 diagnostics mislabeled this exact WorkerPal crash as an
        // artifact-only patch. Strong internal stack evidence must override
        // that legacy classifier label.
        failureClass: "artifact_only_no_publishable_patch",
        detail:
          `jobId=6a5b9b85-1111-4222-8333-123456789abc\n` +
          `ReferenceError: Cannot access 'timedOut' before initialization.\n` +
          `    at <anonymous> (/workspace/apps/workerpals/src/common/generic_python_executor.ts:412:13)`,
      });
      expect(
        queue.workerRuntimeFailureCircuitSummary({
          windowMs: 60 * 60 * 1000,
          threshold: 2,
        }).blocked,
      ).toBe(false);

      failWorkerRuntimeJob(queue, "task-runtime-reference-error-2", {
        failureClass: "no_structured_result",
        detail:
          `jobId=17fc74d9-2222-4333-8444-abcdef123456\n` +
          `ReferenceError: Cannot access 'timedOut' before initialization.\n` +
          `    at <anonymous> (/workspace/apps/workerpals/src/common/generic_python_executor.ts:419:9)`,
      });
      failWorkerRuntimeJob(queue, "task-runtime-distinct-reference-error", {
        failureClass: "worker_runtime_failure",
        detail:
          `jobId=d63d44be-3333-4444-8555-fedcba654321\n` +
          `ReferenceError: Cannot access 'processResult' before initialization.\n` +
          `    at <anonymous> (/workspace/apps/workerpals/src/common/generic_python_executor.ts:412:13)`,
      });
      const summary = queue.workerRuntimeFailureCircuitSummary({
        windowMs: 60 * 60 * 1000,
        threshold: 2,
      });
      expect(summary.blocked).toBe(true);
      expect(summary.qualifyingFailureCount).toBe(3);
      expect(summary.recentMatchingFailureCount).toBe(2);
      expect(summary.fingerprint).toHaveLength(24);
      expect(summary.failureClass).toBe("worker_runtime_failure");
      expect(summary.signatureSample).toContain("generic_python_executor.ts");
      expect(summary.signatureSample).not.toContain("generic_python_executor.ts:41");
      expect(summary.lastFailureAt).toBeTruthy();

      const lastFailureAtMs = Date.parse(String(summary.lastFailureAt));
      const nearExpiry = queue.workerRuntimeFailureCircuitSummary({
        windowMs: 60 * 60 * 1000,
        maxBlockMs: 30 * 60 * 1000,
        threshold: 2,
        nowMs: lastFailureAtMs + 29 * 60 * 1000,
      });
      expect(nearExpiry.blocked).toBe(true);
      expect(
        resolveWorkerRuntimeCircuitRetryAfterMs(nearExpiry, {
          nowMs: lastFailureAtMs + 29 * 60 * 1000,
        }),
      ).toBe(60 * 1000);

      const canaryDue = queue.workerRuntimeFailureCircuitSummary({
        windowMs: 60 * 60 * 1000,
        maxBlockMs: 30 * 60 * 1000,
        threshold: 2,
        nowMs: lastFailureAtMs + 30 * 60 * 1000,
      });
      expect(canaryDue.blocked).toBe(true);
      expect(canaryDue.phase).toBe("open");
      expect(canaryDue.recentMatchingFailureCount).toBe(2);
    } finally {
      queue.close();
    }
  });

  test("ignores worker-runtime failures from an earlier runtime generation", () => {
    const queue = new JobQueue(":memory:");
    try {
      failWorkerRuntimeJob(queue, "task-runtime-prior-generation-1", {
        runtimeGeneration: "runtime-v1",
      });
      failWorkerRuntimeJob(queue, "task-runtime-prior-generation-2", {
        runtimeGeneration: "runtime-v1",
      });
      expect(
        queue.workerRuntimeFailureCircuitSummary({
          threshold: 2,
          runtimeGeneration: "runtime-v1",
        }).blocked,
      ).toBe(true);

      const resetSummary = queue.workerRuntimeFailureCircuitSummary({
        threshold: 2,
        runtimeGeneration: "runtime-v2",
      });
      expect(resetSummary.blocked).toBe(false);
      expect(resetSummary.qualifyingFailureCount).toBe(0);
      expect(resetSummary.recentMatchingFailureCount).toBe(0);

      failWorkerRuntimeJob(queue, "task-runtime-current-generation-1", {
        runtimeGeneration: "runtime-v2",
      });
      const oneCurrentFailure = queue.workerRuntimeFailureCircuitSummary({
        threshold: 2,
        runtimeGeneration: "runtime-v2",
      });
      expect(oneCurrentFailure.blocked).toBe(false);
      expect(oneCurrentFailure.qualifyingFailureCount).toBe(1);
      expect(oneCurrentFailure.recentMatchingFailureCount).toBe(1);

      failWorkerRuntimeJob(queue, "task-runtime-current-generation-2", {
        runtimeGeneration: "runtime-v2",
      });
      const reopenedSummary = queue.workerRuntimeFailureCircuitSummary({
        threshold: 2,
        runtimeGeneration: "runtime-v2",
      });
      expect(reopenedSummary.blocked).toBe(true);
      expect(reopenedSummary.qualifyingFailureCount).toBe(2);
      expect(reopenedSummary.recentMatchingFailureCount).toBe(2);
    } finally {
      queue.close();
    }
  });

  test("admits exactly one half-open canary after the durable retry deadline", () => {
    const queue = new JobQueue(":memory:");
    try {
      failWorkerRuntimeJob(queue, "task-runtime-canary-lock-1");
      failWorkerRuntimeJob(queue, "task-runtime-canary-lock-2");
      const open = queue.workerRuntimeFailureCircuitSummary({ threshold: 2 });
      const canaryDueMs = Date.parse(String(open.retryAt)) + 1;

      const firstJobId = enqueueClaimedJob(
        queue,
        "task-runtime-canary-first",
        { origin: "user" },
        "worker-canary-first",
      );
      const secondJobId = enqueueClaimedJob(
        queue,
        "task-runtime-canary-second",
        { origin: "user" },
        "worker-canary-second",
      );
      const first = queue.acquireWorkerRuntimeCanary(firstJobId, "worker-canary-first", {
        threshold: 2,
        nowMs: canaryDueMs,
      });
      const second = queue.acquireWorkerRuntimeCanary(secondJobId, "worker-canary-second", {
        threshold: 2,
        nowMs: canaryDueMs,
      });

      expect(first).toMatchObject({ allowed: true, canary: true });
      expect(first.summary.phase).toBe("half_open");
      expect(second).toMatchObject({
        allowed: false,
        canary: false,
        reason: "canary_in_flight",
      });
      expect(second.summary.canaryJobId).toBe(firstJobId);
    } finally {
      queue.close();
    }
  });

  test("successful canary closes the circuit and releases deferred jobs", () => {
    const queue = new JobQueue(":memory:");
    try {
      failWorkerRuntimeJob(queue, "task-runtime-release-1");
      failWorkerRuntimeJob(queue, "task-runtime-release-2");
      const open = queue.workerRuntimeFailureCircuitSummary({ threshold: 2 });
      const canaryDueMs = Date.parse(String(open.retryAt)) + 1;

      const deferredJobId = enqueueClaimedJob(
        queue,
        "task-runtime-release-backlog",
        { origin: "user" },
        "worker-backlog",
      );
      expect(
        queue.defer(deferredJobId, {
          workerId: "worker-backlog",
          deferMs: 30_000,
          reason: "worker_runtime_circuit_open",
          detail: JSON.stringify({ fingerprint: open.fingerprint }),
        }).ok,
      ).toBe(true);
      const canaryJobId = enqueueClaimedJob(
        queue,
        "task-runtime-release-canary",
        { origin: "user" },
        "worker-release-canary",
      );
      expect(
        queue.acquireWorkerRuntimeCanary(canaryJobId, "worker-release-canary", {
          threshold: 2,
          nowMs: canaryDueMs,
        }),
      ).toMatchObject({ allowed: true, canary: true });
      expect(queue.recordWorkerRuntimeCanarySuccess(canaryJobId, canaryDueMs + 1).reopened).toBe(
        false,
      );
      expect(
        queue.complete(canaryJobId, {
          summary: "runtime canary completed",
          diagnostics: {
            terminal: {
              failureClass: "success",
              terminalStage: "completed",
              executorBackend: "openai_codex",
            },
          },
        }).ok,
      ).toBe(true);
      const recovered = queue.recordWorkerRuntimeCanarySuccess(canaryJobId, canaryDueMs + 2);

      expect(recovered).toMatchObject({ reopened: true, releasedJobCount: 1 });
      expect(queue.getJob(deferredJobId)).toMatchObject({
        status: "pending",
        deferReason: null,
        deferredAt: null,
      });
      expect(
        queue.workerRuntimeFailureCircuitSummary({ threshold: 2, nowMs: canaryDueMs + 3 }),
      ).toMatchObject({ blocked: false, phase: "closed" });
    } finally {
      queue.close();
    }
  });

  test("matching canary failure reopens the full cooldown", () => {
    const queue = new JobQueue(":memory:");
    try {
      failWorkerRuntimeJob(queue, "task-runtime-renew-1");
      failWorkerRuntimeJob(queue, "task-runtime-renew-2");
      const open = queue.workerRuntimeFailureCircuitSummary({ threshold: 2 });
      const canaryDueMs = Date.parse(String(open.retryAt)) + 1;
      const canaryJobId = enqueueClaimedJob(
        queue,
        "task-runtime-renew-canary",
        { origin: "user" },
        "worker-renew-canary",
      );
      expect(
        queue.acquireWorkerRuntimeCanary(canaryJobId, "worker-renew-canary", {
          threshold: 2,
          nowMs: canaryDueMs,
        }).canary,
      ).toBe(true);
      const detail =
        `ReferenceError: Cannot access 'timedOut' before initialization.\n` +
        `    at <anonymous> (/workspace/apps/workerpals/src/common/generic_python_executor.ts:999:4)`;
      expect(
        queue.fail(canaryJobId, {
          message: "WorkerPal job execution failed",
          detail,
          diagnostics: {
            terminal: {
              failureClass: "worker_runtime_failure",
              terminalStage: "executor",
              executorBackend: "openai_codex",
              summary: "Job failed before returning a structured result",
            },
          },
        }).ok,
      ).toBe(true);
      const failed = queue.recordWorkerRuntimeCanaryFailure(canaryJobId, {
        nowMs: canaryDueMs + 2,
        blockDurationMs: 30 * 60_000,
      });

      expect(failed).toMatchObject({ renewed: true, matchingFailure: true });
      expect(Date.parse(String(failed.retryAt)) - (canaryDueMs + 2)).toBe(30 * 60_000);
      expect(
        queue.workerRuntimeFailureCircuitSummary({ threshold: 2, nowMs: canaryDueMs + 3 }),
      ).toMatchObject({ blocked: true, phase: "open" });
    } finally {
      queue.close();
    }
  });

  test("expired half-open lease recovers the claimed canary and retries within 30 seconds", () => {
    const queue = new JobQueue(":memory:");
    try {
      failWorkerRuntimeJob(queue, "task-runtime-lost-1");
      failWorkerRuntimeJob(queue, "task-runtime-lost-2");
      const open = queue.workerRuntimeFailureCircuitSummary({ threshold: 2 });
      const canaryDueMs = Date.parse(String(open.retryAt)) + 1;
      const canaryJobId = enqueueClaimedJob(
        queue,
        "task-runtime-lost-canary",
        { origin: "user" },
        "worker-lost-canary",
      );
      expect(
        queue.acquireWorkerRuntimeCanary(canaryJobId, "worker-lost-canary", {
          threshold: 2,
          nowMs: canaryDueMs,
          canaryLeaseMs: 5_000,
        }).canary,
      ).toBe(true);

      const recovered = queue.recoverExpiredWorkerRuntimeCanary({
        nowMs: canaryDueMs + 5_001,
        recheckMs: 30_000,
      });
      expect(recovered.circuitRecovered).toBe(true);
      expect(recovered.jobId).toBe(canaryJobId);
      expect(recovered.recoveredJob?.jobId).toBe(canaryJobId);
      expect(Date.parse(String(recovered.retryAt)) - (canaryDueMs + 5_001)).toBe(30_000);
      expect(["failed", "abandoned"]).toContain(queue.getJob(canaryJobId)?.status);
    } finally {
      queue.close();
    }
  });

  test("keeps ordinary user-code failures outside the worker-runtime circuit", () => {
    const queue = new JobQueue(":memory:");
    try {
      for (const taskId of ["task-user-code-1", "task-user-code-2"]) {
        const jobId = enqueueClaimedJob(queue, taskId, { origin: "autonomy" });
        const failed = queue.fail(jobId, {
          message: "focused validation failed",
          detail:
            `ReferenceError: Cannot access 'timedOut' before initialization.\n` +
            `    at routeShell (src/routeShell.ts:42:7)\n` +
            `    at <anonymous> (/workspace/apps/workerpals/src/common/generic_python_executor.ts:412:13)`,
          diagnostics: {
            terminal: {
              status: "failed",
              failureClass: "validation_failed",
              terminalStage: "quality_gate",
              summary: "SectorCommand focused test failed",
            },
          },
        });
        expect(failed.ok).toBe(true);
      }

      const summary = queue.workerRuntimeFailureCircuitSummary({ threshold: 2 });
      expect(summary.blocked).toBe(false);
      expect(summary.qualifyingFailureCount).toBe(0);
      expect(summary.recentMatchingFailureCount).toBe(0);
    } finally {
      queue.close();
    }
  });

  test("rejects user filenames that collide with WorkerPal runtime basenames", () => {
    const queue = new JobQueue(":memory:");
    try {
      for (const taskId of [
        "task-runtime-basename-collision-1",
        "task-runtime-basename-collision-2",
      ]) {
        failWorkerRuntimeJob(queue, taskId, {
          failureClass: "worker_runtime_failure",
          detail: "TypeError: user fixture broke\n    at src/generic_python_executor.ts:42:7",
        });
      }

      const summary = queue.workerRuntimeFailureCircuitSummary({ threshold: 2 });
      expect(summary.blocked).toBe(false);
      expect(summary.qualifyingFailureCount).toBe(0);
      expect(summary.recentMatchingFailureCount).toBe(0);
    } finally {
      queue.close();
    }
  });

  test("accepts structurally owned JobRunner runtime failures without a serialized stack", () => {
    const queue = new JobQueue(":memory:");
    try {
      for (const taskId of ["task-job-runner-fatal-1", "task-job-runner-fatal-2"]) {
        failWorkerRuntimeJob(queue, taskId, {
          failureClass: "worker_runtime_failure",
          terminalStage: "worker_runtime",
          detail: "TypeError: internal state unavailable",
          summary: "WorkerPal encountered an unexpected runtime failure",
        });
      }

      const summary = queue.workerRuntimeFailureCircuitSummary({ threshold: 2 });
      expect(summary.blocked).toBe(true);
      expect(summary.qualifyingFailureCount).toBe(2);
      expect(summary.recentMatchingFailureCount).toBe(2);
      expect(summary.failureClass).toBe("worker_runtime_failure");
    } finally {
      queue.close();
    }
  });

  test("normalizes volatile durations when clustering missing structured results", () => {
    const queue = new JobQueue(":memory:");
    try {
      failWorkerRuntimeJob(queue, "task-no-result-1", {
        failureClass: "no_structured_result",
        detail: "Worker returned no structured result after elapsed=20173ms (pid=1234)",
        summary: "Executor returned no structured result after 20173ms",
      });
      failWorkerRuntimeJob(queue, "task-no-result-2", {
        failureClass: "no_structured_result",
        detail: "Worker returned no structured result after elapsed=42900ms (pid=9876)",
        summary: "Executor returned no structured result after 42900ms",
      });

      const summary = queue.workerRuntimeFailureCircuitSummary({ threshold: 2 });
      expect(summary.blocked).toBe(true);
      expect(summary.recentMatchingFailureCount).toBe(2);
    } finally {
      queue.close();
    }
  });

  test("does not treat a different successful task as proof the failed runtime path recovered", async () => {
    const queue = new JobQueue(":memory:");
    try {
      const overlapping = queue.enqueue({
        taskId: "task-runtime-overlapping-before-failure",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      expect(overlapping.ok).toBe(true);
      const overlappingJobId = String(overlapping.jobId ?? "");
      expect(queue.claim("worker-overlapping").job?.id).toBe(overlappingJobId);

      failWorkerRuntimeJob(queue, "task-runtime-before-recovery-1");
      failWorkerRuntimeJob(queue, "task-runtime-before-recovery-2");
      expect(queue.workerRuntimeFailureCircuitSummary({ threshold: 2 }).blocked).toBe(true);

      await Bun.sleep(2);
      expect(
        queue.complete(overlappingJobId, {
          summary: "older overlapping work eventually completed",
          diagnostics: {
            terminal: {
              status: "completed",
              failureClass: "success",
              terminalStage: "completed",
              executorBackend: "openai_codex",
              summary: "older overlapping work eventually completed",
            },
          },
        }).ok,
      ).toBe(true);
      expect(queue.workerRuntimeFailureCircuitSummary({ threshold: 2 }).blocked).toBe(true);

      const stillBlocked = queue.workerRuntimeFailureCircuitSummary({ threshold: 2 });
      expect(stillBlocked.recentMatchingFailureCount).toBe(2);
      expect(stillBlocked.blocked).toBe(true);
    } finally {
      queue.close();
    }
  });

  test("caps worker-runtime backoff and shrinks it to the remaining circuit window", () => {
    const nowMs = Date.parse("2026-08-18T22:00:00.000Z");
    const base = {
      blockDurationMs: 60 * 60 * 1000,
      lastFailureAt: new Date(nowMs - 10 * 60 * 1000).toISOString(),
    };
    expect(
      resolveWorkerRuntimeCircuitRetryAfterMs(base, {
        nowMs,
        maxRetryAfterMs: 30 * 60 * 1000,
      }),
    ).toBe(30 * 60 * 1000);
    expect(
      resolveWorkerRuntimeCircuitRetryAfterMs(
        {
          ...base,
          blockDurationMs: 30 * 60 * 1000,
          lastFailureAt: new Date(nowMs - 22 * 60 * 1000).toISOString(),
        },
        { nowMs, maxRetryAfterMs: 30 * 60 * 1000 },
      ),
    ).toBe(8 * 60 * 1000);
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

  test("clusters nested environment gate failures when structured validation rows are absent", () => {
    const queue = new JobQueue(":memory:");
    try {
      const params = (patternKey: string) => ({
        origin: "autonomy",
        autonomy: {
          patternKey,
          targetPaths: ["scripts/test-supabase.js"],
        },
      });
      const detail =
        "[supabase tests] Failed to start the local stack.\n" +
        "failed to inspect service: connect /var/run/docker.sock: operation not permitted\n" +
        'error: script "test:supabase" exited with code 1';

      const firstId = enqueueClaimedJob(
        queue,
        "nested-environment-first",
        params("supabase.first-wording"),
      );
      expect(
        queue.fail(firstId, {
          message:
            "Required vision.md validation failed after 3 auto-revision attempts: bun run validate exited 1",
          detail,
        }).ok,
      ).toBe(true);

      const secondId = enqueueClaimedJob(
        queue,
        "nested-environment-second",
        params("supabase.completely-different-wording"),
      );
      expect(
        queue.fail(secondId, {
          message: "Repeated unchanged validation failure circuit opened",
          detail:
            'Validation failed unchanged after two attempts for "bun run validate".\n' + detail,
        }).ok,
      ).toBe(true);

      const summary = queue.similarFailureFingerprintSummary({
        targetPaths: ["scripts/test-supabase.js"],
        threshold: 2,
      });
      expect(summary.blocked).toBe(true);
      expect(summary.recentSimilarFailureCount).toBe(2);
      expect(summary.failureClass).toBe("environment");
      expect(summary.command).toBe("bun run test:supabase");
      expect(summary.failedTestSample).toEqual(["script:test:supabase"]);
    } finally {
      queue.close();
    }
  });
});
