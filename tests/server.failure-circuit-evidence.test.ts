import { describe, expect, test } from "bun:test";
import { JobQueue } from "../apps/server/src/jobs";

function failedJob(
  queue: JobQueue,
  taskId: string,
  paths: string[],
  runs: Record<string, unknown>[],
) {
  const created = queue.enqueue({
    taskId,
    sessionId: "dev",
    kind: "task.execute",
    params: { origin: "autonomy", planning: { targetPaths: paths } },
  });
  expect(created.ok).toBe(true);
  const claim = queue.claim("worker-evidence");
  expect(claim.job?.id).toBe(created.jobId);
  expect(
    queue.fail(
      created.jobId!,
      {
        message: "Required visual evidence is unavailable",
        diagnostics: {
          terminal: {
            failureClass: "validation",
            terminalStage: "critic",
            summary: "Required visual evidence is unavailable",
          },
          validationRuns: runs,
        },
      },
      { workerId: "worker-evidence", claimGeneration: claim.job!.claimGeneration },
    ).ok,
  ).toBe(true);
}

describe("failure circuit authoritative evidence", () => {
  test("a later deferred observation cannot erase an executed failing check", () => {
    const queue = new JobQueue(":memory:");
    try {
      for (let i = 0; i < 2; i++)
        failedJob(
          queue,
          `late-deferral-${i}`,
          ["src/alpha.ts"],
          [
            {
              command: "bun run check",
              passed: false,
              exitCode: 1,
              failureClass: "validation",
              stderrTail: "(fail) alpha renders",
              metadata: { capability: "worker" },
            },
            {
              command: "bun run check",
              passed: false,
              exitCode: 1,
              failureClass: "environment.docker",
              metadata: { capability: "trusted_host" },
            },
          ],
        );
      const summary = queue.similarFailureFingerprintSummary({ targetPaths: ["src/alpha.ts"] });
      expect(summary.blocked).toBe(true);
      expect(summary.failureClass).toBe("validation");
      expect(summary.command).toBe("bun run check");
      expect(summary.failedTestSample).toEqual(["alpha renders"]);
    } finally {
      queue.close();
    }
  });

  test.each(["deferred", "recovered"])(
    "does not turn %s checks into failed-test fingerprints",
    (mode) => {
      const queue = new JobQueue(":memory:");
      try {
        for (let i = 0; i < 2; i++)
          failedJob(
            queue,
            `${mode}-${i}`,
            ["src/widget.ts", "docs/context.md"],
            mode === "deferred"
              ? [
                  {
                    command: "bun run validate",
                    passed: false,
                    exitCode: 1,
                    failureClass: "environment.docker",
                    metadata: { capability: "trusted_host" },
                  },
                ]
              : [
                  {
                    command: "bun test tests/widget.test.ts",
                    passed: false,
                    exitCode: 1,
                    failureClass: "validation",
                    stderrTail: "(fail) widget renders",
                  },
                  { command: "bun test tests/widget.test.ts", passed: true, exitCode: 0 },
                ],
          );
        const summary = queue.similarFailureFingerprintSummary({
          targetPaths: ["src/widget.ts", "docs/context.md"],
        });
        expect(summary.command).toBeNull();
        expect(summary.failedTestSample).toEqual([]);
        expect(summary.failureClass).toBe("validation");
      } finally {
        queue.close();
      }
    },
  );

  test("an incidental shared file cannot circuit-break a different component", () => {
    const queue = new JobQueue(":memory:");
    try {
      for (let i = 0; i < 2; i++)
        failedJob(
          queue,
          `real-failure-${i}`,
          ["src/alpha.ts", "docs/shared.md"],
          [
            {
              command: "bun test tests/alpha.test.ts",
              passed: false,
              exitCode: 1,
              failureClass: "validation",
              stderrTail: "(fail) alpha renders",
            },
          ],
        );
      expect(
        queue.similarFailureFingerprintSummary({ targetPaths: ["src/beta.ts", "docs/shared.md"] })
          .blocked,
      ).toBe(false);
      const same = queue.similarFailureFingerprintSummary({
        targetPaths: ["docs/shared.md", "src/alpha.ts"],
      });
      expect(same.blocked).toBe(true);
      expect(same.targetPathSample).toEqual(["docs/shared.md", "src/alpha.ts"]);
      expect(same.command).toBe("bun test tests/alpha.test.ts");
    } finally {
      queue.close();
    }
  });
});
