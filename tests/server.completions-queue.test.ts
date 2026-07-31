import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CompletionQueue } from "../apps/server/src/completions";

describe("server CompletionQueue PR URL persistence", () => {
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
