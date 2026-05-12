import { describe, expect, test } from "bun:test";
import { CompletionQueue } from "../apps/server/src/completions";

describe("server CompletionQueue PR URL persistence", () => {
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
