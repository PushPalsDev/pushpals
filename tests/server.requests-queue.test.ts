import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

  test("preserves autonomy metadata with scoped writeGlobs", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({
      sessionId: "dev",
      prompt: "autonomy background objective",
      priority: "background",
      forceWorker: true,
      forceLane: "worker",
      metadata: {
        origin: "autonomy",
        autonomy: {
          objectiveId: "obj_123",
          runId: "run_123",
          snapshotId: "snap_123",
          componentArea: "tests/integration",
          targetPaths: ["tests/integration/test_workerpals_e2e.py"],
          writeGlobs: ["tests/integration/*.py"],
        },
      },
    });
    expect(enqueued.ok).toBe(true);
    const claimed = queue.claim("remotebuddy-orchestrator");
    expect(claimed.ok).toBe(true);
    const metadata = (claimed.request?.metadata ?? {}) as Record<string, unknown>;
    const autonomy = (metadata.autonomy ?? {}) as Record<string, unknown>;
    expect(metadata.origin).toBe("autonomy");
    expect(Array.isArray(autonomy.writeGlobs)).toBe(true);
    expect((autonomy.writeGlobs as string[])[0]).toBe("tests/integration/*.py");
    queue.close();
  });

  test("derives autonomy componentArea from repo-relative scope when omitted", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({
      sessionId: "dev",
      prompt: "autonomy background objective",
      metadata: {
        origin: "autonomy",
        autonomy: {
          targetPaths: ["src/autonomy.ts"],
          writeGlobs: ["src/autonomy.ts"],
        },
      },
    });
    expect(enqueued.ok).toBe(true);
    const claimed = queue.claim("remotebuddy-orchestrator");
    const metadata = (claimed.request?.metadata ?? {}) as Record<string, unknown>;
    const autonomy = (metadata.autonomy ?? {}) as Record<string, unknown>;
    expect(autonomy.componentArea).toBe("src");
    queue.close();
  });

  test("rejects autonomy metadata without writeGlobs", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({
      sessionId: "dev",
      prompt: "autonomy background objective",
      metadata: {
        origin: "autonomy",
        autonomy: {
          objectiveId: "obj_123",
          componentArea: "apps/server",
          targetPaths: ["apps/server/src/server_main.ts"],
        },
      },
    });
    expect(enqueued.ok).toBe(false);
    expect(String(enqueued.message ?? "")).toContain("write_globs");
    queue.close();
  });

  test("rejects autonomy metadata with unsupported glob syntax", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({
      sessionId: "dev",
      prompt: "autonomy background objective",
      metadata: {
        origin: "autonomy",
        autonomy: {
          componentArea: "tests/integration",
          targetPaths: ["tests/integration/test_workerpals_e2e.py"],
          writeGlobs: ["tests/integration/[a-z].py"],
        },
      },
    });
    expect(enqueued.ok).toBe(false);
    expect(String(enqueued.message ?? "")).toContain("scope invalid");
    queue.close();
  });

  test("preserves mixed-root autonomy metadata as review hints", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({
      sessionId: "dev",
      prompt: "autonomy background objective",
      metadata: {
        origin: "autonomy",
        autonomy: {
          targetPaths: ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
          writeGlobs: ["app/**", "scripts/**"],
        },
      },
    });
    expect(enqueued.ok).toBe(true);
    const claimed = queue.claim("remotebuddy-orchestrator");
    expect(claimed.ok).toBe(true);
    const metadata = (claimed.request?.metadata ?? {}) as Record<string, unknown>;
    const autonomy = (metadata.autonomy ?? {}) as Record<string, unknown>;
    expect(autonomy.targetPaths).toEqual([
      "app/_layout.tsx",
      "scripts/fix-baseline-browser-mapping.js",
    ]);
    expect(autonomy.writeGlobs).toEqual(["app/**", "scripts/**"]);
    queue.close();
  });

  test("counts autonomy requests by status", () => {
    const queue = new RequestQueue(":memory:");

    const autonomyOne = queue.enqueue({
      sessionId: "dev",
      prompt: "autonomy request one",
      metadata: {
        origin: "autonomy",
        autonomy: {
          componentArea: "apps/server",
          targetPaths: ["apps/server/src/server_main.ts"],
          writeGlobs: ["apps/server/src/*"],
        },
      },
    });
    const autonomyTwo = queue.enqueue({
      sessionId: "dev",
      prompt: "autonomy request two",
      metadata: {
        origin: "autonomy",
        autonomy: {
          componentArea: "apps/remotebuddy",
          targetPaths: ["apps/remotebuddy/src/autonomous_engine.ts"],
          writeGlobs: ["apps/remotebuddy/src/*"],
        },
      },
    });
    const userRequest = queue.enqueue({
      sessionId: "dev",
      prompt: "plain user request",
    });

    expect(autonomyOne.ok).toBe(true);
    expect(autonomyTwo.ok).toBe(true);
    expect(userRequest.ok).toBe(true);
    expect(queue.countAutonomyRequests(["pending"])).toBe(2);

    const claim = queue.claim("remotebuddy-orchestrator");
    expect(claim.ok).toBe(true);
    expect(queue.countAutonomyRequests(["pending"])).toBe(1);
    expect(queue.countAutonomyRequests(["pending", "claimed"])).toBe(2);
    queue.close();
  });

  test("deduplicates enqueue by idempotency key", () => {
    const queue = new RequestQueue(":memory:");
    const first = queue.enqueue({
      sessionId: "dev",
      prompt: "resume autonomy objective",
      priority: "background",
      idempotencyKey: "autonomy_resume:q_123",
    });
    const second = queue.enqueue({
      sessionId: "dev",
      prompt: "resume autonomy objective",
      priority: "background",
      idempotencyKey: "autonomy_resume:q_123",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.deduplicated).toBe(true);
    expect(second.requestId).toBe(first.requestId);
    expect(queue.getPendingRequests().length).toBe(1);
    queue.close();
  });

  test("deduplicates enqueue by idempotency key across queue restart", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-request-queue-restart-"));
    const dbPath = join(root, "requests.sqlite");
    let queue: RequestQueue | null = null;

    try {
      queue = new RequestQueue(dbPath);
      const first = queue.enqueue({
        sessionId: "dev",
        prompt: "resume autonomy objective after crash",
        priority: "background",
        idempotencyKey: "autonomy_resume:q_restart",
      });
      expect(first.ok).toBe(true);
      const firstId = String(first.requestId ?? "");
      expect(firstId.length).toBeGreaterThan(0);
      queue.close();
      queue = null;

      queue = new RequestQueue(dbPath);
      const second = queue.enqueue({
        sessionId: "dev",
        prompt: "resume autonomy objective after crash",
        priority: "background",
        idempotencyKey: "autonomy_resume:q_restart",
      });
      expect(second.ok).toBe(true);
      expect(second.deduplicated).toBe(true);
      expect(second.requestId).toBe(firstId);
      expect(queue.getPendingRequests().length).toBe(1);
    } finally {
      queue?.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup for Windows file lock timing
      }
    }
  });
});
