import { describe, expect, test } from "bun:test";
import { JobQueue } from "../apps/server/src/jobs";

describe("server tool-run telemetry", () => {
  test("records and lists tool runs for a job", () => {
    const queue = new JobQueue(":memory:");
    try {
      const enqueue = queue.enqueue({
        taskId: "task-tool-run-1",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      expect(enqueue.ok).toBe(true);
      const jobId = String(enqueue.jobId);

      const record = queue.recordToolRun({
        id: "tool-run-test-1",
        jobId,
        workerId: "worker-1",
        sessionId: "dev",
        phase: "task.execute",
        tool: "codex",
        argv: ["codex", "--version"],
        ok: false,
        exitCode: 127,
        stdoutTail: "codex --version failed",
        stderrTail: "env: 'node': No such file or directory",
        durationMs: 42,
      });

      expect(record).toEqual({ ok: true, id: "tool-run-test-1" });
      const toolRuns = queue.listJobToolRuns(jobId);
      expect(toolRuns).toHaveLength(1);
      expect(toolRuns[0]).toMatchObject({
        id: "tool-run-test-1",
        jobId,
        workerId: "worker-1",
        sessionId: "dev",
        tool: "codex",
        kind: "known",
        argv: ["codex", "--version"],
        ok: false,
        exitCode: 127,
        failureClass: "missing_runtime",
        retryable: false,
      });
      expect(toolRuns[0]?.remediation).toContain("Bun-backed Codex launcher");
    } finally {
      queue.close();
    }
  });

  test("does not require new schema for unknown tools", () => {
    const queue = new JobQueue(":memory:");
    try {
      const enqueue = queue.enqueue({
        taskId: "task-tool-run-2",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      const jobId = String(enqueue.jobId);

      const record = queue.recordToolRun({
        id: "tool-run-sapling",
        jobId,
        tool: "sapling",
        argv: ["sl", "status"],
        ok: false,
        exitCode: 2,
        stderrTail: "workspace error",
        metadata: {
          token: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
        },
      });

      expect(record.ok).toBe(true);
      const saved = queue.listJobToolRuns(jobId)[0];
      expect(saved).toMatchObject({
        tool: "sapling",
        kind: "discovered",
        failureClass: "nonzero_exit",
      });
      expect(saved?.metadata?.token).toBe("GITHUB_TOKEN=[redacted]");
    } finally {
      queue.close();
    }
  });

  test("infers and stores canonical tool names when callers only provide command context", () => {
    const queue = new JobQueue(":memory:");
    try {
      const enqueue = queue.enqueue({
        taskId: "task-tool-run-infer-tool",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      const jobId = String(enqueue.jobId);

      const record = queue.recordToolRun({
        id: "tool-run-infer-codex",
        jobId,
        commandLine: "codex --version",
        ok: false,
        exitCode: 127,
        stderrTail: "env: 'node': No such file or directory",
      });

      expect(record.ok).toBe(true);
      const saved = queue.listJobToolRuns(jobId)[0];
      expect(saved).toMatchObject({
        tool: "codex",
        kind: "known",
        commandLine: "codex --version",
        failureClass: "missing_runtime",
      });
    } finally {
      queue.close();
    }
  });

  test("keeps specific server classifications authoritative over client hints", () => {
    const queue = new JobQueue(":memory:");
    try {
      const enqueue = queue.enqueue({
        taskId: "task-tool-run-3",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      const jobId = String(enqueue.jobId);

      const record = queue.recordToolRun({
        id: "tool-run-authoritative",
        jobId,
        tool: "codex",
        ok: false,
        exitCode: 1,
        failureClass: "network",
        retryable: true,
        remediation: "Retry once the network is back.",
        stderrTail:
          "The 'gpt-5.5' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
      });

      expect(record.ok).toBe(true);
      const saved = queue.listJobToolRuns(jobId)[0];
      expect(saved).toMatchObject({
        failureClass: "missing_runtime",
        retryable: false,
        remediation: "Upgrade the Codex CLI/runtime used by PushPals before retrying this model.",
      });
    } finally {
      queue.close();
    }
  });

  test("accepts client classifications when server only sees a generic nonzero exit", () => {
    const queue = new JobQueue(":memory:");
    try {
      const enqueue = queue.enqueue({
        taskId: "task-tool-run-4",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      const jobId = String(enqueue.jobId);

      const record = queue.recordToolRun({
        id: "tool-run-client-specific",
        jobId,
        tool: "sapling",
        ok: false,
        exitCode: 2,
        failureClass: "permission",
        retryable: false,
        remediation: "Grant access to the Sapling workspace.",
        stderrTail: "workspace operation failed",
      });

      expect(record.ok).toBe(true);
      const saved = queue.listJobToolRuns(jobId)[0];
      expect(saved).toMatchObject({
        tool: "sapling",
        kind: "discovered",
        failureClass: "permission",
        retryable: false,
        remediation: "Grant access to the Sapling workspace.",
      });
    } finally {
      queue.close();
    }
  });
});
