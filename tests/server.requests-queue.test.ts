import { describe, expect, test } from "bun:test";
import { RequestQueue } from "../apps/server/src/requests";

describe("server RequestQueue", () => {
  test("requires prompt for enqueue", () => {
    const queue = new RequestQueue(":memory:");
    const result = queue.enqueue({
      sessionId: "dev",
      originalPrompt: "legacy field should not be accepted",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("prompt");
    queue.close();
  });

  test("stores and returns prompt-only request shape", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({
      sessionId: "dev",
      prompt: "fix one bug",
    });
    expect(enqueued.ok).toBe(true);
    expect(enqueued.requestId).toBeTruthy();

    const claimed = queue.claim("remotebuddy-orchestrator");
    expect(claimed.ok).toBe(true);
    expect(claimed.request?.prompt).toBe("fix one bug");
    expect((claimed.request as any)?.originalPrompt).toBeUndefined();
    expect((claimed.request as any)?.enhancedPrompt).toBeUndefined();
    queue.close();
  });
});
