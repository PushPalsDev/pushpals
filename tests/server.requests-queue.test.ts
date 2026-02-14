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

  test("orders claims by priority and returns queue metadata", () => {
    const queue = new RequestQueue(":memory:");

    const normal = queue.enqueue({
      sessionId: "dev",
      prompt: "normal request",
      priority: "normal",
    });
    const background = queue.enqueue({
      sessionId: "dev",
      prompt: "background request",
      priority: "background",
    });
    const interactive = queue.enqueue({
      sessionId: "dev",
      prompt: "interactive request",
      priority: "interactive",
    });

    expect(normal.ok).toBe(true);
    expect(background.ok).toBe(true);
    expect(interactive.ok).toBe(true);
    expect(interactive.queuePosition).toBe(1);
    expect(interactive.etaMs).toBe(0);

    const claim1 = queue.claim("remotebuddy-orchestrator");
    const claim2 = queue.claim("remotebuddy-orchestrator");
    const claim3 = queue.claim("remotebuddy-orchestrator");

    expect(claim1.ok).toBe(true);
    expect(claim2.ok).toBe(true);
    expect(claim3.ok).toBe(true);
    expect(claim1.request?.priority).toBe("interactive");
    expect(claim2.request?.priority).toBe("normal");
    expect(claim3.request?.priority).toBe("background");
    expect(typeof claim1.queueWaitMs).toBe("number");
    queue.close();
  });

  test("computes request SLO summary for recent terminal requests", () => {
    const queue = new RequestQueue(":memory:");

    const first = queue.enqueue({
      sessionId: "dev",
      prompt: "first request",
      priority: "interactive",
    });
    expect(first.ok).toBe(true);
    const firstClaim = queue.claim("remotebuddy-orchestrator");
    expect(firstClaim.ok).toBe(true);
    const firstComplete = queue.complete(first.requestId!, { result: { ok: true } });
    expect(firstComplete.ok).toBe(true);

    const second = queue.enqueue({
      sessionId: "dev",
      prompt: "second request",
      priority: "normal",
    });
    expect(second.ok).toBe(true);
    const secondClaim = queue.claim("remotebuddy-orchestrator");
    expect(secondClaim.ok).toBe(true);
    const secondFail = queue.fail(second.requestId!, { message: "planner failed" });
    expect(secondFail.ok).toBe(true);

    const slo = queue.sloSummary(24);
    expect(slo.terminal).toBe(2);
    expect(slo.completed).toBe(1);
    expect(slo.failed).toBe(1);
    expect(slo.successRate).toBe(0.5);
    expect(slo.durationMs.sampleSize).toBeGreaterThanOrEqual(2);
    expect(slo.queueWaitMs.sampleSize).toBeGreaterThanOrEqual(2);

    queue.close();
  });
});
