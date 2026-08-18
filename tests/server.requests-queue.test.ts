import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
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
    const firstComplete = queue.complete(first.requestId!, {
      agentId: "remotebuddy-orchestrator",
      claimToken: firstClaim.request?.claimToken,
      result: { ok: true },
    });
    expect(firstComplete.ok).toBe(true);

    const second = queue.enqueue({
      sessionId: "dev",
      prompt: "second request",
      priority: "normal",
    });
    expect(second.ok).toBe(true);
    const secondClaim = queue.claim("remotebuddy-orchestrator");
    expect(secondClaim.ok).toBe(true);
    const secondFail = queue.fail(second.requestId!, {
      agentId: "remotebuddy-orchestrator",
      claimToken: secondClaim.request?.claimToken,
      message: "planner failed",
    });
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

  test("renews claimed request leases only for the current owner", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({ sessionId: "dev", prompt: "plan a durable handoff" });
    const requestId = String(enqueued.requestId ?? "");
    const claimed = queue.claim("remotebuddy-a", { leaseMs: 60_000 });

    expect(claimed.ok).toBe(true);
    expect(claimed.request?.leaseExpiresAt).toBeTruthy();
    expect(claimed.request?.lastHeartbeatAt).toBeTruthy();
    expect(claimed.request?.claimAttempts).toBe(1);

    const previousExpiry = String(claimed.request?.leaseExpiresAt ?? "");
    const claimToken = String(claimed.request?.claimToken ?? "");
    expect(queue.renewLease(requestId, "remotebuddy-b", claimToken, { leaseMs: 120_000 }).ok).toBe(
      false,
    );
    const renewed = queue.renewLease(requestId, "remotebuddy-a", claimToken, {
      leaseMs: 120_000,
    });
    expect(renewed.ok).toBe(true);
    expect(Date.parse(String(renewed.leaseExpiresAt))).toBeGreaterThanOrEqual(
      Date.parse(previousExpiry),
    );
    queue.close();
  });

  test("rejects ownerless terminal writes and worker handoffs", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({ sessionId: "dev", prompt: "keep ownership explicit" });
    const requestId = String(enqueued.requestId ?? "");
    expect(queue.claim("remotebuddy-owner").ok).toBe(true);

    expect(queue.recordWorkerHandoff(requestId, "job-ownerless", "", "").ok).toBe(false);
    expect(queue.complete(requestId, { result: { ok: true } }).ok).toBe(false);
    expect(queue.fail(requestId, { message: "ownerless" }).ok).toBe(false);
    expect(queue.getRequest(requestId)?.status).toBe("claimed");
    queue.close();
  });

  test("recovers an expired claim and rejects the stale owner's terminal write", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({ sessionId: "dev", prompt: "recover this planner" });
    const requestId = String(enqueued.requestId ?? "");
    const claimed = queue.claim("remotebuddy-old", { leaseMs: 30_000 });
    expect(claimed.ok).toBe(true);

    const recovered = queue.recoverExpiredClaims(
      new Date(Date.parse(String(claimed.request?.leaseExpiresAt)) + 1),
    );
    expect(recovered).toEqual({ recovered: 1, requestIds: [requestId] });
    expect(queue.getRequest(requestId)?.status).toBe("pending");
    const staleToken = String(claimed.request?.claimToken ?? "");
    expect(
      queue.complete(requestId, {
        agentId: "remotebuddy-old",
        claimToken: staleToken,
        result: { ok: true },
      }).ok,
    ).toBe(false);

    const reclaimed = queue.claim("remotebuddy-new");
    expect(reclaimed.request?.id).toBe(requestId);
    expect(reclaimed.request?.claimAttempts).toBe(2);
    expect(
      queue.complete(requestId, {
        agentId: "remotebuddy-old",
        claimToken: staleToken,
        result: { ok: true },
      }).ok,
    ).toBe(false);
    expect(
      queue.complete(requestId, {
        agentId: "remotebuddy-new",
        claimToken: reclaimed.request?.claimToken,
        result: { ok: true },
      }).ok,
    ).toBe(true);
    queue.close();
  });

  test("persists worker requirements and handoffs before completion", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({
      sessionId: "dev",
      prompt: "delegate this request",
      forceWorker: true,
    });
    const requestId = String(enqueued.requestId ?? "");
    const claimed = queue.claim("remotebuddy-owner");

    expect(claimed.request?.workerRequired).toBe(1);
    expect(claimed.request?.handoffJobId).toBeNull();
    const claimToken = String(claimed.request?.claimToken ?? "");
    expect(queue.recordWorkerHandoff(requestId, "job-1", "wrong-owner", claimToken).ok).toBe(false);
    expect(queue.recordWorkerHandoff(requestId, "job-1", "remotebuddy-owner", claimToken).ok).toBe(
      true,
    );
    expect(queue.getRequest(requestId)).toMatchObject({
      workerRequired: 1,
      handoffJobId: "job-1",
    });
    expect(
      queue.complete(requestId, {
        agentId: "remotebuddy-owner",
        claimToken,
        result: { requiresWorker: false },
      }).ok,
    ).toBe(true);
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
          reservationRequired: true,
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
    expect(autonomy.reservationRequired).toBe(true);
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

  test("requeues a failed idempotent request instead of suppressing it forever", () => {
    const queue = new RequestQueue(":memory:");
    const body = {
      sessionId: "dev",
      prompt: "retry this autonomy objective",
      priority: "background",
      forceWorker: true,
      idempotencyKey: "autonomy:obj-retry",
    };
    const first = queue.enqueue(body);
    const requestId = String(first.requestId ?? "");
    const claimed = queue.claim("remotebuddy-first");
    expect(claimed.ok).toBe(true);
    expect(
      queue.fail(requestId, {
        agentId: "remotebuddy-first",
        claimToken: claimed.request?.claimToken,
        message: "transient planning transport failure",
      }).ok,
    ).toBe(true);

    const retried = queue.enqueue(body);
    expect(retried).toMatchObject({ ok: true, requestId, requeued: true });
    expect(retried.deduplicated).not.toBe(true);
    expect(queue.getRequest(requestId)).toMatchObject({
      status: "pending",
      forceWorker: 1,
      workerRequired: 1,
      handoffJobId: null,
      error: null,
      claimAttempts: 1,
    });
    const reclaimed = queue.claim("remotebuddy-second");
    expect(reclaimed.request).toMatchObject({ id: requestId, claimAttempts: 2 });
    queue.close();
  });

  test("fences stale callbacks when the same agent reclaims an expired request", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({ sessionId: "dev", prompt: "same-agent ABA" });
    const requestId = String(enqueued.requestId ?? "");
    const first = queue.claim("remotebuddy-stable", { leaseMs: 30_000 });
    const staleToken = String(first.request?.claimToken ?? "");
    expect(staleToken).not.toBe("");

    queue.recoverExpiredClaims(new Date(Date.parse(String(first.request?.leaseExpiresAt)) + 1));
    const second = queue.claim("remotebuddy-stable", { leaseMs: 30_000 });
    const activeToken = String(second.request?.claimToken ?? "");
    expect(activeToken).not.toBe(staleToken);
    expect(second.request?.claimGeneration).toBe(2);

    expect(queue.validateActiveLease(requestId, "remotebuddy-stable", staleToken).ok).toBe(false);
    expect(queue.renewLease(requestId, "remotebuddy-stable", staleToken).ok).toBe(false);
    expect(
      queue.recordWorkerHandoff(requestId, "job-stale", "remotebuddy-stable", staleToken).ok,
    ).toBe(false);
    expect(
      queue.complete(requestId, {
        agentId: "remotebuddy-stable",
        claimToken: staleToken,
        result: { ok: true },
      }).ok,
    ).toBe(false);
    expect(
      queue.fail(requestId, {
        agentId: "remotebuddy-stable",
        claimToken: staleToken,
        message: "stale failure",
      }).ok,
    ).toBe(false);
    expect(queue.validateActiveLease(requestId, "remotebuddy-stable", activeToken).ok).toBe(true);
    expect(
      queue.complete(requestId, {
        agentId: "remotebuddy-stable",
        claimToken: activeToken,
        result: { ok: true },
      }).ok,
    ).toBe(true);
    queue.close();
  });

  test("replays terminal callbacks idempotently only for the same claim token", () => {
    const queue = new RequestQueue(":memory:");
    const completed = queue.enqueue({ sessionId: "dev", prompt: "complete once" });
    const completedClaim = queue.claim("remotebuddy-stable");
    const completedBody = {
      agentId: "remotebuddy-stable",
      claimToken: completedClaim.request?.claimToken,
      result: { ok: true },
    };

    expect(queue.complete(String(completed.requestId), completedBody)).toMatchObject({
      ok: true,
      transitioned: true,
    });
    expect(queue.complete(String(completed.requestId), completedBody)).toMatchObject({
      ok: true,
      transitioned: false,
      idempotent: true,
    });
    expect(
      queue.complete(String(completed.requestId), {
        ...completedBody,
        claimToken: "stale-token",
      }).ok,
    ).toBe(false);
    expect(
      queue.fail(String(completed.requestId), {
        agentId: "remotebuddy-stable",
        claimToken: completedClaim.request?.claimToken,
        message: "late opposite transition",
      }).ok,
    ).toBe(false);

    const failed = queue.enqueue({ sessionId: "dev", prompt: "fail once" });
    const failedClaim = queue.claim("remotebuddy-stable");
    const failedBody = {
      agentId: "remotebuddy-stable",
      claimToken: failedClaim.request?.claimToken,
      message: "expected failure",
    };
    expect(queue.fail(String(failed.requestId), failedBody)).toMatchObject({
      ok: true,
      transitioned: true,
    });
    expect(queue.fail(String(failed.requestId), failedBody)).toMatchObject({
      ok: true,
      transitioned: false,
      idempotent: true,
    });
    expect(queue.complete(String(failed.requestId), completedBody).ok).toBe(false);
    queue.close();
  });

  test("reconciles an expired ordinary request from only its strict durable task job", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-request-handoff-reconcile-"));
    const dbPath = join(root, "requests.sqlite");
    const queue = new RequestQueue(dbPath);
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          sessionId TEXT NOT NULL,
          kind TEXT NOT NULL,
          params TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
      `);
      const good = queue.enqueue({ sessionId: "user-session", prompt: "dispatch once" });
      const wrongSession = queue.enqueue({
        sessionId: "user-session",
        prompt: "do not match another session",
      });
      const malformed = queue.enqueue({
        sessionId: "user-session",
        prompt: "do not match malformed params",
      });
      const goodClaim = queue.claim("remotebuddy-stable", { leaseMs: 30_000 });
      const wrongClaim = queue.claim("remotebuddy-stable", { leaseMs: 30_000 });
      const malformedClaim = queue.claim("remotebuddy-stable", { leaseMs: 30_000 });
      expect(goodClaim.request?.id).toBe(good.requestId);
      expect(wrongClaim.request?.id).toBe(wrongSession.requestId);
      expect(malformedClaim.request?.id).toBe(malformed.requestId);

      const createdAt = new Date(Date.now() + 1_000).toISOString();
      const insert = db.prepare(
        `INSERT INTO jobs (id, sessionId, kind, params, createdAt) VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run(
        "job-good",
        "user-session",
        "task.execute",
        JSON.stringify({ requestId: good.requestId }),
        createdAt,
      );
      insert.run(
        "job-wrong-session",
        "other-session",
        "task.execute",
        JSON.stringify({ requestId: wrongSession.requestId }),
        createdAt,
      );
      insert.run("job-malformed", "user-session", "task.execute", "{not-json", createdAt);
      insert.run(
        "job-wrong-kind",
        "user-session",
        "task.inspect",
        JSON.stringify({ requestId: malformed.requestId }),
        createdAt,
      );
      insert.finalize();

      const reconcileAt = new Date(Date.parse(String(goodClaim.request?.leaseExpiresAt)) + 1);
      expect(queue.reconcileWorkerHandoffsFromJobs(reconcileAt)).toEqual({
        completed: 1,
        requestIds: [good.requestId],
        jobIds: ["job-good"],
      });
      expect(queue.getRequest(String(good.requestId))).toMatchObject({
        status: "completed",
        workerRequired: 1,
        handoffJobId: "job-good",
        agentId: "remotebuddy-stable",
        claimToken: goodClaim.request?.claimToken,
      });
      expect(queue.getRequest(String(wrongSession.requestId))?.status).toBe("claimed");
      expect(queue.getRequest(String(malformed.requestId))?.status).toBe("claimed");
      expect(
        queue.complete(String(good.requestId), {
          agentId: "remotebuddy-stable",
          claimToken: goodClaim.request?.claimToken,
          result: { requiresWorker: true, jobId: "job-good" },
        }),
      ).toMatchObject({ ok: true, idempotent: true });
    } finally {
      queue.close();
      db.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup for Windows file lock timing
      }
    }
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

  test("startup migration requeues a claimed request that has no fencing token", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-request-legacy-claim-"));
    const dbPath = join(root, "requests.sqlite");
    let queue: RequestQueue | null = new RequestQueue(dbPath);
    try {
      const enqueued = queue.enqueue({ sessionId: "dev", prompt: "legacy active claim" });
      const requestId = String(enqueued.requestId ?? "");
      expect(queue.claim("legacy-remotebuddy", { leaseMs: 120_000 }).ok).toBe(true);
      queue.close();
      queue = null;

      const db = new Database(dbPath);
      db.prepare(`UPDATE requests SET claimToken = NULL WHERE id = ?`).run(requestId);
      db.close();

      queue = new RequestQueue(dbPath);
      expect(queue.getRequest(requestId)).toMatchObject({
        status: "pending",
        agentId: null,
        claimToken: null,
        leaseExpiresAt: null,
      });
      expect(queue.claim("replacement-remotebuddy").request).toMatchObject({
        id: requestId,
        status: "claimed",
        claimToken: expect.any(String),
        claimGeneration: 2,
      });
    } finally {
      queue?.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup for Windows file lock timing
      }
    }
  });

  test("tolerates malformed legacy metadata during restart and claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-request-legacy-json-"));
    const dbPath = join(root, "requests.sqlite");
    let queue: RequestQueue | null = null;

    try {
      queue = new RequestQueue(dbPath);
      const enqueued = queue.enqueue({ sessionId: "dev", prompt: "legacy request" });
      const requestId = String(enqueued.requestId ?? "");
      queue.close();
      queue = null;

      const db = new Database(dbPath);
      db.prepare(`UPDATE requests SET metadataJson = ? WHERE id = ?`).run("{not-json", requestId);
      db.close();

      queue = new RequestQueue(dbPath);
      expect(queue.getRequest(requestId)?.metadata).toBeUndefined();
      expect(queue.claim("remotebuddy-legacy")).toMatchObject({
        ok: true,
        request: { id: requestId, metadata: undefined },
      });
    } finally {
      queue?.close();
      let lastError: unknown;
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        try {
          rmSync(root, { recursive: true, force: true });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await Bun.sleep(25 * attempt);
        }
      }
      if (lastError) throw lastError;
    }
  }, 15_000);
});
