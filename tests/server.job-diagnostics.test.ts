import { describe, expect, test } from "bun:test";
import { JobQueue } from "../apps/server/src/jobs";

describe("server JobQueue diagnostics", () => {
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
});
