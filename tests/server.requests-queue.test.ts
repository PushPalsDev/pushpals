import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { JobQueue } from "../apps/server/src/jobs";
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

  test("keeps provisional autonomy dispatches unclaimable until exact confirmation", () => {
    const queue = new RequestQueue(":memory:");
    const enqueued = queue.enqueue({
      sessionId: "dev",
      prompt: "run only if the autonomy cycle is still live",
      priority: "background",
      idempotencyKey: "autonomy:two-phase-dispatch",
      dispatchConfirmationRequired: true,
      dispatchConfirmationTtlMs: 30_000,
      metadata: {
        origin: "autonomy",
        autonomy: {
          objectiveId: "two-phase-dispatch",
          runId: "run-two-phase",
          snapshotId: "snapshot-two-phase",
          patternKey: "two-phase",
          componentArea: "apps/server",
          targetPaths: ["apps/server/src/requests.ts"],
          writeGlobs: ["apps/server/src/*.ts"],
          reservationRequired: true,
        },
      },
    });
    const requestId = String(enqueued.requestId ?? "");
    const confirmationToken = String(enqueued.dispatchConfirmationToken ?? "");

    expect(enqueued).toMatchObject({
      ok: true,
      dispatchConfirmationRequired: true,
      dispatchConfirmationToken: expect.any(String),
      dispatchConfirmationExpiresAt: expect.any(String),
    });
    expect(enqueued.queuePosition).toBeUndefined();
    expect(queue.getRequest(requestId)?.dispatchConfirmationToken).toBeNull();
    expect(queue.listRequests({ status: "pending" })[0]?.dispatchConfirmationToken).toBeNull();
    expect(queue.getPendingRequests()).toEqual([]);
    expect(queue.countByStatus().pending).toBe(0);
    expect(queue.countByPriority().background).toBe(0);
    expect(queue.countAutonomyRequests()).toBe(0);
    expect(queue.claim("remotebuddy-before-confirm")).toMatchObject({
      ok: false,
      message: "No pending requests",
    });
    expect(queue.confirmDispatch(requestId, "wrong-token").ok).toBe(false);

    expect(queue.confirmDispatch(requestId, confirmationToken)).toMatchObject({
      ok: true,
      confirmed: true,
      idempotent: false,
    });
    expect(queue.confirmDispatch(requestId, confirmationToken)).toMatchObject({
      ok: true,
      confirmed: true,
      idempotent: true,
    });
    expect(queue.countAutonomyRequests()).toBe(1);
    const claimed = queue.claim("remotebuddy-after-confirm");
    expect(claimed).toMatchObject({
      ok: true,
      request: { id: requestId, dispatchConfirmationToken: null },
    });
    expect(queue.confirmDispatch(requestId, confirmationToken)).toMatchObject({
      ok: true,
      confirmed: true,
      idempotent: true,
    });
    expect(
      queue.enqueue({
        sessionId: "dev",
        prompt: "run only if the autonomy cycle is still live",
        priority: "background",
        idempotencyKey: "autonomy:two-phase-dispatch",
        dispatchConfirmationRequired: true,
        dispatchConfirmationTtlMs: 30_000,
      }),
    ).toMatchObject({
      ok: true,
      requestId,
      deduplicated: true,
      dispatchConfirmed: true,
    });
    queue.close();
  });

  test("upgrades an unclaimed legacy idempotent row to fenced dispatch", () => {
    const queue = new RequestQueue(":memory:");
    const first = queue.enqueue({
      sessionId: "dev",
      prompt: "legacy pending autonomy request",
      priority: "background",
      idempotencyKey: "autonomy:legacy-pending-upgrade",
    });

    const upgraded = queue.enqueue({
      sessionId: "dev",
      prompt: "legacy pending autonomy request",
      priority: "background",
      idempotencyKey: "autonomy:legacy-pending-upgrade",
      dispatchConfirmationRequired: true,
      dispatchConfirmationTtlMs: 30_000,
    });
    const confirmationToken = String(upgraded.dispatchConfirmationToken ?? "");

    expect(upgraded).toMatchObject({
      ok: true,
      requestId: first.requestId,
      deduplicated: true,
      dispatchConfirmationRequired: true,
    });
    expect(queue.claim("remotebuddy-before-legacy-upgrade-confirm").ok).toBe(false);
    expect(queue.confirmDispatch(String(first.requestId), confirmationToken)).toMatchObject({
      ok: true,
      confirmed: true,
    });
    expect(queue.claim("remotebuddy-after-legacy-upgrade-confirm").ok).toBe(true);
    queue.close();
  });

  test("expires abandoned provisional dispatches and rearms their idempotency key", () => {
    const queue = new RequestQueue(":memory:");
    const body = {
      sessionId: "dev",
      prompt: "do not leak work from an expired cycle",
      priority: "background",
      idempotencyKey: "autonomy:expired-two-phase-dispatch",
      dispatchConfirmationRequired: true,
      dispatchConfirmationTtlMs: 1_000,
      metadata: {
        origin: "autonomy",
        autonomy: {
          objectiveId: "expired-two-phase-dispatch",
          runId: "run-expired-two-phase",
          snapshotId: "snapshot-expired-two-phase",
          patternKey: "expired-two-phase",
          componentArea: "apps/server",
          targetPaths: ["apps/server/src/requests.ts"],
          writeGlobs: ["apps/server/src/*.ts"],
          reservationRequired: true,
        },
      },
    };
    const first = queue.enqueue(body);
    const afterExpiry = new Date(Date.parse(first.dispatchConfirmationExpiresAt!) + 1);

    expect(queue.expireUnconfirmedDispatches(afterExpiry)).toMatchObject({
      expired: 1,
      requestIds: [first.requestId],
    });
    expect(queue.getRequest(first.requestId!)).toMatchObject({ status: "failed" });
    expect(
      queue.confirmDispatch(first.requestId!, first.dispatchConfirmationToken!, afterExpiry).ok,
    ).toBe(false);

    const retry = queue.enqueue(body);
    expect(retry).toMatchObject({
      ok: true,
      requestId: first.requestId,
      requeued: true,
      dispatchConfirmationRequired: true,
    });
    expect(retry.dispatchConfirmationToken).not.toBe(first.dispatchConfirmationToken);
    expect(queue.claim("remotebuddy-before-retry-confirm").ok).toBe(false);
    queue.close();
  });

  test("preserves provisional confirmation ownership across a queue restart", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-provisional-request-restart-"));
    const dbPath = join(root, "requests.sqlite");
    const body = {
      sessionId: "dev",
      prompt: "survive the server restart without becoming claimable",
      priority: "background",
      idempotencyKey: "autonomy:restart-two-phase-dispatch",
      dispatchConfirmationRequired: true,
      dispatchConfirmationTtlMs: 30_000,
      dispatchConfirmationDeadlineAt: new Date(Date.now() + 20_000).toISOString(),
      metadata: {
        origin: "autonomy",
        autonomy: {
          objectiveId: "restart-two-phase-dispatch",
          runId: "run-restart-two-phase",
          snapshotId: "snapshot-restart-two-phase",
          patternKey: "restart-two-phase",
          componentArea: "apps/server",
          targetPaths: ["apps/server/src/requests.ts"],
          writeGlobs: ["apps/server/src/*.ts"],
          reservationRequired: true,
        },
      },
    };
    let queue: RequestQueue | null = new RequestQueue(dbPath);

    try {
      const first = queue.enqueue(body);
      const requestId = String(first.requestId ?? "");
      const confirmationToken = String(first.dispatchConfirmationToken ?? "");
      const requestedDeadlineMs = Date.parse(body.dispatchConfirmationDeadlineAt);
      expect(Date.parse(first.dispatchConfirmationExpiresAt!)).toBeLessThanOrEqual(
        requestedDeadlineMs,
      );
      queue.close();

      queue = new RequestQueue(dbPath);
      expect(queue.claim("remotebuddy-after-restart").ok).toBe(false);
      const replayed = queue.enqueue(body);
      expect(replayed).toMatchObject({
        ok: true,
        requestId,
        deduplicated: true,
        dispatchConfirmationRequired: true,
      });
      expect(replayed.dispatchConfirmationToken).toBe(confirmationToken);
      expect(queue.confirmDispatch(requestId, confirmationToken)).toMatchObject({
        ok: true,
        confirmed: true,
      });
      expect(queue.claim("remotebuddy-confirmed-after-restart")).toMatchObject({
        ok: true,
        request: { id: requestId },
      });
    } finally {
      queue?.close();
      rmSync(root, { recursive: true, force: true });
    }
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

  test("keeps durable worker handoffs delegated until the exact job terminates", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-request-outcome-"));
    const dbPath = join(root, "requests.sqlite");
    const queue = new RequestQueue(dbPath);
    const db = new Database(dbPath);

    try {
      db.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          sessionId TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'task.execute',
          params TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL,
          failedAt TEXT,
          abandonedAt TEXT,
          publishBlockedAt TEXT,
          completedAt TEXT,
          createdAt TEXT NOT NULL DEFAULT '',
          updatedAt TEXT
        );
      `);
      const request = queue.enqueue({
        sessionId: "truthful-request-outcome",
        prompt: "delegate this work",
      });
      const requestId = String(request.requestId ?? "");
      const claim = queue.claim("remotebuddy-truthful");
      const claimToken = String(claim.request?.claimToken ?? "");
      const jobId = "job-truthful-outcome";
      const jobCreatedAt = new Date().toISOString();
      db.run(
        `INSERT INTO jobs (id, status, updatedAt) VALUES (?, 'claimed', ?)`,
        jobId,
        jobCreatedAt,
      );
      expect(
        queue.recordWorkerHandoff(requestId, jobId, "remotebuddy-truthful", claimToken),
      ).toMatchObject({ ok: true });
      expect(
        queue.complete(requestId, {
          agentId: "remotebuddy-truthful",
          claimToken,
          result: { requiresWorker: true, jobId },
        }),
      ).toMatchObject({ ok: true });

      expect(queue.getRequest(requestId)).toMatchObject({
        status: "completed",
        workerRequired: 1,
        handoffJobId: jobId,
        handoffJobStatus: "claimed",
        outcomeStatus: "delegated",
        outcomeDurationMs: null,
      });
      expect(queue.sloSummary(24)).toMatchObject({
        terminal: 0,
        completed: 0,
        failed: 0,
        successRate: null,
      });

      const failedAt = new Date(Date.now() + 1_000).toISOString();
      db.run(
        `UPDATE jobs SET status = 'failed', failedAt = ?, updatedAt = ? WHERE id = ?`,
        failedAt,
        failedAt,
        jobId,
      );

      expect(queue.listRequests({ status: "completed" })).toContainEqual(
        expect.objectContaining({
          id: requestId,
          status: "completed",
          handoffJobStatus: "failed",
          outcomeStatus: "failed",
          outcomeUpdatedAt: failedAt,
        }),
      );
      expect(queue.sloSummary(24)).toMatchObject({
        terminal: 1,
        completed: 0,
        failed: 1,
        successRate: 0,
        durationMs: { sampleSize: 1 },
      });
    } finally {
      queue.close();
      db.close(true);
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup for Windows file lock timing
      }
    }
  });

  test.each(["completed", "failed"])(
    "repoints a retry-safe recovered handoff and projects the successor as %s",
    (terminalStatus) => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-request-recovery-handoff-"));
      const dbPath = join(root, "requests.sqlite");
      const requestQueue = new RequestQueue(dbPath);
      const jobQueue = new JobQueue(dbPath);

      try {
        const request = requestQueue.enqueue({
          sessionId: "truthful-recovery",
          prompt: `recover and finish as ${terminalStatus}`,
          forceWorker: true,
        });
        const requestId = String(request.requestId ?? "");
        const requestClaim = requestQueue.claim("remotebuddy-recovery");
        const requestClaimToken = String(requestClaim.request?.claimToken ?? "");

        const enqueuedJob = jobQueue.enqueue({
          taskId: `task-recovery-${terminalStatus}`,
          sessionId: "truthful-recovery",
          kind: "task.execute",
          params: { requestId, retrySafety: "retry_safe" },
        });
        const originalJobId = String(enqueuedJob.jobId ?? "");
        expect(jobQueue.claim("worker-original")).toMatchObject({
          ok: true,
          job: { id: originalJobId },
        });
        expect(
          requestQueue.recordWorkerHandoff(
            requestId,
            originalJobId,
            "remotebuddy-recovery",
            requestClaimToken,
          ),
        ).toMatchObject({ ok: true });
        expect(
          requestQueue.complete(requestId, {
            agentId: "remotebuddy-recovery",
            claimToken: requestClaimToken,
            result: { requiresWorker: true, jobId: originalJobId },
          }),
        ).toMatchObject({ ok: true });

        const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
        const jobsDb = (jobQueue as unknown as { db: Database }).db;
        jobsDb
          .prepare(`UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?`)
          .run(staleIso, "worker-original");
        jobsDb
          .prepare(
            `UPDATE jobs
             SET updatedAt = ?, claimedAt = ?, startedAt = ?,
                 firstLogAt = NULL, lastActivityAt = ?
             WHERE id = ?`,
          )
          .run(staleIso, staleIso, staleIso, staleIso, originalJobId);

        const recovered = jobQueue.recoverStaleClaimedJobs(120_000);
        expect(recovered).toHaveLength(1);
        const replacementJobId = String(recovered[0]?.replacementJobId ?? "");
        expect(replacementJobId).not.toBe("");
        expect(jobQueue.getJob(originalJobId)?.status).toBe("abandoned");
        expect(requestQueue.getRequest(requestId)).toMatchObject({
          status: "completed",
          workerRequired: 1,
          handoffJobId: replacementJobId,
          handoffJobStatus: "pending",
          outcomeStatus: "delegated",
          outcomeDurationMs: null,
        });

        jobsDb
          .prepare(`UPDATE jobs SET availableAt = ? WHERE id = ?`)
          .run(new Date(Date.now() - 1_000).toISOString(), replacementJobId);
        expect(jobQueue.claim("worker-successor")).toMatchObject({
          ok: true,
          job: { id: replacementJobId },
        });
        if (terminalStatus === "completed") {
          expect(
            jobQueue.complete(replacementJobId, { summary: "recovered successfully" }).ok,
          ).toBe(true);
        } else {
          expect(
            jobQueue.fail(replacementJobId, {
              message: "successor failed with a real terminal error",
            }).ok,
          ).toBe(true);
        }

        expect(requestQueue.getRequest(requestId)).toMatchObject({
          status: "completed",
          handoffJobId: replacementJobId,
          handoffJobStatus: terminalStatus,
          outcomeStatus: terminalStatus,
          outcomeUpdatedAt: expect.any(String),
        });
        expect(requestQueue.sloSummary(24)).toMatchObject({
          terminal: 1,
          completed: terminalStatus === "completed" ? 1 : 0,
          failed: terminalStatus === "failed" ? 1 : 0,
          successRate: terminalStatus === "completed" ? 1 : 0,
        });
      } finally {
        jobQueue.close();
        requestQueue.close();
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          // best-effort cleanup for Windows file lock timing
        }
      }
    },
  );

  test.each([
    ["pending", "delegated"],
    ["completed", "completed"],
    ["failed", "failed"],
  ] as const)(
    "repairs an upgraded durable request pinned to an abandoned predecessor with a %s leaf",
    (leafStatus, expectedOutcomeStatus) => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-request-legacy-chain-"));
      const dbPath = join(root, "requests.sqlite");
      const jobQueue = new JobQueue(dbPath);
      const requestQueue = new RequestQueue(dbPath);
      const db = new Database(dbPath);

      try {
        const requestId = String(
          requestQueue.enqueue({
            sessionId: `legacy-${leafStatus}`,
            prompt: `recover the ${leafStatus} successor`,
            forceWorker: true,
          }).requestId ?? "",
        );
        const predecessorJobId = `job-legacy-${leafStatus}-predecessor`;
        const leafJobId = `job-legacy-${leafStatus}-leaf`;
        const fixtureBaseMs = Date.now();
        const predecessorAt = new Date(fixtureBaseMs + 1_000).toISOString();
        const leafAt = new Date(fixtureBaseMs + 2_000).toISOString();
        const insertJob = db.prepare(
          `INSERT INTO jobs (
             id, taskId, sessionId, kind, status, resumeOfJobId, attempt,
             abandonedAt, failedAt, completedAt, createdAt, updatedAt
           ) VALUES (?, ?, ?, 'task.execute', ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        insertJob.run(
          predecessorJobId,
          `task-${leafStatus}`,
          `legacy-${leafStatus}`,
          "abandoned",
          null,
          1,
          predecessorAt,
          null,
          null,
          predecessorAt,
          predecessorAt,
        );
        insertJob.run(
          leafJobId,
          `task-${leafStatus}`,
          `legacy-${leafStatus}`,
          leafStatus,
          predecessorJobId,
          2,
          null,
          leafStatus === "failed" ? leafAt : null,
          leafStatus === "completed" ? leafAt : null,
          leafAt,
          leafAt,
        );
        insertJob.finalize();
        db.run(
          `UPDATE requests
           SET workerRequired = 1,
               handoffJobId = ?,
               status = 'completed',
               completedAt = ?,
               updatedAt = ?
           WHERE id = ?`,
          predecessorJobId,
          predecessorAt,
          predecessorAt,
          requestId,
        );

        expect(requestQueue.getRequest(requestId)).toMatchObject({
          handoffJobId: predecessorJobId,
          handoffJobStatus: "abandoned",
          outcomeStatus: "failed",
        });

        expect(requestQueue.reconcileRecoveredWorkerHandoffChains()).toEqual({
          scanned: 1,
          repointed: 1,
          requestIds: [requestId],
          previousJobIds: [predecessorJobId],
          replacementJobIds: [leafJobId],
          cycleDetected: 0,
          depthLimitReached: 0,
        });
        expect(requestQueue.getRequest(requestId)).toMatchObject({
          handoffJobId: leafJobId,
          handoffJobStatus: leafStatus,
          outcomeStatus: expectedOutcomeStatus,
          outcomeDurationMs: leafStatus === "pending" ? null : expect.any(Number),
        });
        expect(requestQueue.reconcileRecoveredWorkerHandoffChains()).toMatchObject({
          scanned: 0,
          repointed: 0,
        });
      } finally {
        db.close(true);
        requestQueue.close();
        jobQueue.close();
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          // best-effort cleanup for Windows file lock timing
        }
      }
    },
  );

  test("follows a deterministic multi-hop retry chain without crossing its depth bound", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-request-multihop-chain-"));
    const dbPath = join(root, "requests.sqlite");
    const jobQueue = new JobQueue(dbPath);
    const requestQueue = new RequestQueue(dbPath);
    const db = new Database(dbPath);

    try {
      const requestId = String(
        requestQueue.enqueue({
          sessionId: "legacy-multihop",
          prompt: "recover the full successor chain",
          forceWorker: true,
        }).requestId ?? "",
      );
      const insertJob = db.prepare(
        `INSERT INTO jobs (
           id, taskId, sessionId, kind, status, resumeOfJobId, attempt,
           abandonedAt, completedAt, createdAt, updatedAt
         ) VALUES (?, 'task-multihop', 'legacy-multihop', 'task.execute', ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertJob.run(
        "job-chain-root",
        "abandoned",
        null,
        1,
        "2026-08-18T02:00:00.000Z",
        null,
        "2026-08-18T02:00:00.000Z",
        "2026-08-18T02:00:00.000Z",
      );
      insertJob.run(
        "job-chain-middle",
        "abandoned",
        "job-chain-root",
        2,
        "2026-08-18T02:01:00.000Z",
        null,
        "2026-08-18T02:01:00.000Z",
        "2026-08-18T02:01:00.000Z",
      );
      insertJob.run(
        "job-chain-leaf",
        "completed",
        "job-chain-middle",
        3,
        null,
        "2026-08-18T02:02:00.000Z",
        "2026-08-18T02:02:00.000Z",
        "2026-08-18T02:02:00.000Z",
      );
      // A malformed older fork must not win over the higher-attempt retry chain.
      insertJob.run(
        "job-chain-old-fork",
        "failed",
        "job-chain-root",
        1,
        null,
        null,
        "2026-08-18T02:03:00.000Z",
        "2026-08-18T02:03:00.000Z",
      );
      insertJob.finalize();
      db.run(
        `UPDATE requests
         SET workerRequired = 1,
             handoffJobId = 'job-chain-root',
             status = 'completed',
             completedAt = '2026-08-18T02:00:00.000Z',
             updatedAt = '2026-08-18T02:00:00.000Z'
         WHERE id = ?`,
        requestId,
      );

      expect(
        requestQueue.reconcileRecoveredWorkerHandoffChains({ maxRequests: 1, maxDepth: 1 }),
      ).toMatchObject({
        scanned: 1,
        repointed: 0,
        cycleDetected: 0,
        depthLimitReached: 1,
      });
      expect(requestQueue.getRequest(requestId)?.handoffJobId).toBe("job-chain-root");

      expect(
        requestQueue.reconcileRecoveredWorkerHandoffChains({ maxRequests: 1, maxDepth: 2 }),
      ).toMatchObject({
        scanned: 1,
        repointed: 1,
        replacementJobIds: ["job-chain-leaf"],
        cycleDetected: 0,
        depthLimitReached: 0,
      });
      expect(requestQueue.getRequest(requestId)).toMatchObject({
        handoffJobId: "job-chain-leaf",
        handoffJobStatus: "completed",
        outcomeStatus: "completed",
      });
    } finally {
      db.close(true);
      requestQueue.close();
      jobQueue.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup for Windows file lock timing
      }
    }
  });

  test("bounds cyclic legacy retry metadata without changing the durable handoff", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-request-cycle-chain-"));
    const dbPath = join(root, "requests.sqlite");
    const jobQueue = new JobQueue(dbPath);
    const requestQueue = new RequestQueue(dbPath);
    const db = new Database(dbPath);

    try {
      const requestId = String(
        requestQueue.enqueue({
          sessionId: "legacy-cycle",
          prompt: "do not loop over corrupt retry metadata",
          forceWorker: true,
        }).requestId ?? "",
      );
      const insertJob = db.prepare(
        `INSERT INTO jobs (
           id, taskId, sessionId, kind, status, resumeOfJobId, attempt,
           abandonedAt, createdAt, updatedAt
         ) VALUES (?, 'task-cycle', 'legacy-cycle', 'task.execute', 'abandoned', ?, ?, ?, ?, ?)`,
      );
      insertJob.run(
        "job-cycle-a",
        "job-cycle-b",
        1,
        "2026-08-18T03:00:00.000Z",
        "2026-08-18T03:00:00.000Z",
        "2026-08-18T03:00:00.000Z",
      );
      insertJob.run(
        "job-cycle-b",
        "job-cycle-a",
        2,
        "2026-08-18T03:01:00.000Z",
        "2026-08-18T03:01:00.000Z",
        "2026-08-18T03:01:00.000Z",
      );
      insertJob.finalize();
      db.run(
        `UPDATE requests
         SET workerRequired = 1,
             handoffJobId = 'job-cycle-a',
             status = 'completed'
         WHERE id = ?`,
        requestId,
      );

      expect(requestQueue.reconcileRecoveredWorkerHandoffChains({ maxDepth: 64 })).toMatchObject({
        scanned: 1,
        repointed: 0,
        cycleDetected: 1,
        depthLimitReached: 0,
      });
      expect(requestQueue.getRequest(requestId)).toMatchObject({
        handoffJobId: "job-cycle-a",
        handoffJobStatus: "abandoned",
        outcomeStatus: "failed",
      });
    } finally {
      db.close(true);
      requestQueue.close();
      jobQueue.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup for Windows file lock timing
      }
    }
  });

  test("leaves no-successor, unrelated, and non-durable handoffs unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-request-unrelated-chain-"));
    const dbPath = join(root, "requests.sqlite");
    const jobQueue = new JobQueue(dbPath);
    const requestQueue = new RequestQueue(dbPath);
    const db = new Database(dbPath);

    try {
      const insertJob = db.prepare(
        `INSERT INTO jobs (
           id, taskId, sessionId, kind, status, resumeOfJobId, attempt,
           abandonedAt, completedAt, createdAt, updatedAt
         ) VALUES (?, ?, 'legacy-unrelated', 'task.execute', ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertJob.run(
        "job-no-successor",
        "task-no-successor",
        "abandoned",
        null,
        1,
        "2026-08-18T04:00:00.000Z",
        null,
        "2026-08-18T04:00:00.000Z",
        "2026-08-18T04:00:00.000Z",
      );
      insertJob.run(
        "job-nondurable-root",
        "task-nondurable",
        "abandoned",
        null,
        1,
        "2026-08-18T04:01:00.000Z",
        null,
        "2026-08-18T04:01:00.000Z",
        "2026-08-18T04:01:00.000Z",
      );
      insertJob.run(
        "job-nondurable-leaf",
        "task-nondurable",
        "completed",
        "job-nondurable-root",
        2,
        null,
        "2026-08-18T04:02:00.000Z",
        "2026-08-18T04:02:00.000Z",
        "2026-08-18T04:02:00.000Z",
      );
      insertJob.run(
        "job-unrelated-complete",
        "task-unrelated",
        "completed",
        null,
        1,
        null,
        "2026-08-18T04:03:00.000Z",
        "2026-08-18T04:03:00.000Z",
        "2026-08-18T04:03:00.000Z",
      );
      insertJob.finalize();

      const createPinnedRequest = (prompt: string, jobId: string, workerRequired: 0 | 1) => {
        const requestId = String(
          requestQueue.enqueue({ sessionId: "legacy-unrelated", prompt }).requestId ?? "",
        );
        db.run(
          `UPDATE requests
           SET workerRequired = ?, handoffJobId = ?, status = 'completed'
           WHERE id = ?`,
          workerRequired,
          jobId,
          requestId,
        );
        return requestId;
      };
      const noSuccessorRequestId = createPinnedRequest(
        "abandoned without a retry",
        "job-no-successor",
        1,
      );
      const nonDurableRequestId = createPinnedRequest(
        "not a durable worker handoff",
        "job-nondurable-root",
        0,
      );
      const unrelatedRequestId = createPinnedRequest(
        "already points to a terminal leaf",
        "job-unrelated-complete",
        1,
      );

      expect(requestQueue.reconcileRecoveredWorkerHandoffChains()).toEqual({
        scanned: 0,
        repointed: 0,
        requestIds: [],
        previousJobIds: [],
        replacementJobIds: [],
        cycleDetected: 0,
        depthLimitReached: 0,
      });
      expect(requestQueue.getRequest(noSuccessorRequestId)).toMatchObject({
        handoffJobId: "job-no-successor",
        outcomeStatus: "failed",
      });
      expect(requestQueue.getRequest(nonDurableRequestId)).toMatchObject({
        workerRequired: 0,
        handoffJobId: "job-nondurable-root",
        outcomeStatus: "completed",
      });
      expect(requestQueue.getRequest(unrelatedRequestId)).toMatchObject({
        handoffJobId: "job-unrelated-complete",
        outcomeStatus: "completed",
      });
    } finally {
      db.close(true);
      requestQueue.close();
      jobQueue.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup for Windows file lock timing
      }
    }
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

  test("defers a fenced claim without terminating it and requeues it after a bounded delay", () => {
    const queue = new RequestQueue(":memory:");
    const deferredRequest = queue.enqueue({
      sessionId: "autonomy-deferred",
      prompt: "retry this autonomy request after the circuit closes",
      priority: "background",
    });
    const eligibleRequest = queue.enqueue({
      sessionId: "user-eligible",
      prompt: "continue to this eligible request",
      priority: "background",
    });
    const requestId = String(deferredRequest.requestId ?? "");
    const firstClaim = queue.claim("remotebuddy-circuit", { leaseMs: 60_000 });
    const firstClaimToken = String(firstClaim.request?.claimToken ?? "");
    expect(firstClaim.request?.id).toBe(requestId);

    const deferred = queue.deferClaim(
      requestId,
      "remotebuddy-circuit",
      firstClaimToken,
      60 * 60_000,
    );
    expect(deferred).toMatchObject({ ok: true, retryAfterMs: 30 * 60_000 });
    const deferredUntil = String(deferred.deferredUntil ?? "");
    expect(Date.parse(deferredUntil)).toBeGreaterThan(Date.now());
    expect(queue.getRequest(requestId)).toMatchObject({
      status: "claimed",
      agentId: "remotebuddy-circuit",
      claimToken: firstClaimToken,
      leaseExpiresAt: deferredUntil,
      failedAt: null,
      error: null,
    });

    const nextClaim = queue.claim("remotebuddy-circuit");
    expect(nextClaim.request?.id).toBe(eligibleRequest.requestId);
    expect(
      queue.complete(String(eligibleRequest.requestId), {
        agentId: "remotebuddy-circuit",
        claimToken: nextClaim.request?.claimToken,
        result: { ok: true },
      }).ok,
    ).toBe(true);

    expect(queue.recoverExpiredClaims(new Date(Date.parse(deferredUntil) - 1))).toEqual({
      recovered: 0,
      requestIds: [],
    });
    expect(queue.recoverExpiredClaims(new Date(Date.parse(deferredUntil) + 1))).toEqual({
      recovered: 1,
      requestIds: [requestId],
    });
    const reclaimed = queue.claim("remotebuddy-retry");
    expect(reclaimed.request).toMatchObject({
      id: requestId,
      status: "claimed",
      claimAttempts: 2,
    });
    expect(reclaimed.request?.claimToken).not.toBe(firstClaimToken);
    expect(
      queue.complete(requestId, {
        agentId: "remotebuddy-circuit",
        claimToken: firstClaimToken,
        result: { stale: true },
      }).ok,
    ).toBe(false);
    queue.close();
  });

  test("caps runtime-circuit claims at 30 seconds and recovers tagged and legacy deferrals", () => {
    const queue = new RequestQueue(":memory:");
    const tagged = queue.enqueue({
      sessionId: "runtime-tagged",
      prompt: "retry after a bounded runtime recheck",
    });
    const taggedClaim = queue.claim("remotebuddy-tagged", { leaseMs: 60_000 });
    expect(taggedClaim.request?.id).toBe(tagged.requestId);
    const taggedDeferred = queue.deferClaim(
      String(tagged.requestId),
      "remotebuddy-tagged",
      String(taggedClaim.request?.claimToken),
      60 * 60_000,
      { reason: "worker_runtime_circuit_open" },
    );
    const legacy = queue.enqueue({
      sessionId: "runtime-legacy",
      prompt: "recover a deferral written before reason tags existed",
      forceWorker: true,
      forceLane: "worker",
      metadata: {
        origin: "autonomy",
        autonomy: {
          objectiveId: "runtime-legacy-objective",
          runId: "runtime-legacy-run",
          snapshotId: "runtime-legacy-snapshot",
          componentArea: "apps/server",
          targetPaths: ["apps/server/src/requests.ts"],
          writeGlobs: ["apps/server/src/*.ts"],
        },
      },
    });
    const legacyClaim = queue.claim("remotebuddy-legacy", { leaseMs: 60_000 });
    expect(legacyClaim.request?.id).toBe(legacy.requestId);
    const legacyDeferred = queue.deferClaim(
      String(legacy.requestId),
      "remotebuddy-legacy",
      String(legacyClaim.request?.claimToken),
      30 * 60_000,
    );
    expect(taggedDeferred).toMatchObject({ ok: true, retryAfterMs: 30_000 });
    expect(legacyDeferred.ok).toBe(true);

    const nowMs = Date.parse("2026-08-18T22:00:00.000Z");
    const farFuture = new Date(nowMs + 30 * 60_000).toISOString();
    const db = (queue as unknown as { db: any }).db as any;
    db.run(
      "UPDATE requests SET leaseExpiresAt = ? WHERE id IN (?, ?)",
      farFuture,
      tagged.requestId,
      legacy.requestId,
    );
    const shortened = queue.shortenWorkerRuntimeCircuitDeferredClaims({
      nowMs,
      maxDelayMs: 30_000,
      includeLegacyAutonomyClaims: true,
    });
    expect(shortened.shortened).toBe(2);
    expect(new Set(shortened.requestIds)).toEqual(
      new Set([String(tagged.requestId), String(legacy.requestId)]),
    );

    const released = queue.releaseWorkerRuntimeCircuitDeferredClaims(nowMs + 1);
    expect(released).toMatchObject({
      released: 1,
      requestIds: [String(tagged.requestId)],
    });
    expect(queue.recoverExpiredClaims(new Date(nowMs + 2)).requestIds).toContain(
      String(tagged.requestId),
    );
    expect(queue.recoverExpiredClaims(new Date(nowMs + 30_001)).requestIds).toContain(
      String(legacy.requestId),
    );
    queue.close();
  });

  test("shortens every durable runtime-circuit claim beyond the reported ID limit", () => {
    const queue = new RequestQueue(":memory:");
    const db = (queue as unknown as { db: any }).db as any;
    const nowMs = Date.parse("2026-08-19T19:00:00.000Z");
    const now = new Date(nowMs).toISOString();
    const farFuture = new Date(nowMs + 60 * 60_000).toISOString();
    const expectedDeferredUntil = new Date(nowMs + 30_000).toISOString();
    const eligibleCount = 605;
    const insertRequest = db.prepare(
      `INSERT INTO requests (
         id, sessionId, prompt, metadataJson, status, agentId, claimToken,
         claimGeneration, leaseExpiresAt, lastHeartbeatAt, claimAttempts,
         deferReason, enqueuedAt, claimedAt, createdAt, updatedAt
       ) VALUES (?, 'bulk-runtime-restart', ?, ?, 'claimed', ?, ?, 1, ?, ?, 1, ?, ?, ?, ?, ?)`,
    );
    const seed = db.transaction(() => {
      for (let index = 0; index < eligibleCount; index += 1) {
        const id = `bulk-runtime-request-${String(index).padStart(4, "0")}`;
        const tagged = index % 2 === 0;
        insertRequest.run(
          id,
          `Recover durable request ${index}`,
          tagged ? JSON.stringify({ origin: "user" }) : JSON.stringify({ origin: "autonomy" }),
          `bulk-runtime-agent-${index}`,
          `bulk-runtime-token-${index}`,
          farFuture,
          now,
          tagged ? "worker_runtime_circuit_open" : null,
          now,
          now,
          now,
          now,
        );
      }
      insertRequest.run(
        "bulk-runtime-request-unrelated",
        "Leave this unrelated claim untouched",
        JSON.stringify({ origin: "user" }),
        "bulk-runtime-agent-unrelated",
        "bulk-runtime-token-unrelated",
        farFuture,
        now,
        null,
        now,
        now,
        now,
        now,
      );
    });
    try {
      seed();
    } finally {
      insertRequest.finalize();
    }

    const shortened = queue.shortenWorkerRuntimeCircuitDeferredClaims({
      nowMs,
      maxDelayMs: 30_000,
      includeLegacyAutonomyClaims: true,
    });
    expect(shortened).toMatchObject({
      shortened: eligibleCount,
      unreportedRequestIds: eligibleCount - 500,
      deferredUntil: expectedDeferredUntil,
    });
    expect(shortened.requestIds).toHaveLength(500);
    expect(new Set(shortened.requestIds).size).toBe(500);
    expect(shortened.requestIds.every((id) => id.startsWith("bulk-runtime-request-"))).toBe(true);

    const eligibleStatement = db.prepare(
      `SELECT COUNT(*) AS count
       FROM requests
       WHERE id LIKE 'bulk-runtime-request-%'
         AND id != 'bulk-runtime-request-unrelated'
         AND leaseExpiresAt = ?`,
    );
    let eligible: { count: number } | null;
    try {
      eligible = eligibleStatement.get(expectedDeferredUntil) as { count: number } | null;
    } finally {
      eligibleStatement.finalize();
    }
    expect(eligible).not.toBeNull();
    expect(eligible?.count).toBe(eligibleCount);
    expect(queue.getRequest("bulk-runtime-request-unrelated")?.leaseExpiresAt).toBe(farFuture);

    expect(
      queue.shortenWorkerRuntimeCircuitDeferredClaims({
        nowMs,
        maxDelayMs: 30_000,
        includeLegacyAutonomyClaims: true,
      }),
    ).toEqual({
      shortened: 0,
      requestIds: [],
      unreportedRequestIds: 0,
      deferredUntil: expectedDeferredUntil,
    });
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
          validationIncident: {
            incidentId: "valid_inc_integration",
            candidateSha: "c".repeat(40),
            candidateRef: "refs/heads/repair/integration",
            baselineSha: "b".repeat(40),
            validationScope: "candidate_specific",
            failureFingerprint: "fp_integration",
            arbitrarySecret: "must-not-survive",
          },
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
    expect(autonomy.validationIncident).toEqual({
      incidentId: "valid_inc_integration",
      candidateSha: "c".repeat(40),
      candidateRef: "refs/heads/repair/integration",
      baselineSha: "b".repeat(40),
      validationScope: "candidate_specific",
      failureFingerprint: "fp_integration",
    });
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
      db.close(true);
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup for Windows file lock timing
      }
    }
  });

  test("does not reconcile a stale claimed provisional request until exact dispatch confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-provisional-handoff-reconcile-"));
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
      const provisional = queue.enqueue({
        sessionId: "autonomy",
        prompt: "dispatch only after the live fence confirms",
        dispatchConfirmationRequired: true,
        dispatchConfirmationTtlMs: 300_000,
      });
      const requestId = String(provisional.requestId ?? "");
      const confirmationToken = String(provisional.dispatchConfirmationToken ?? "");
      expect(confirmationToken).not.toBe("");

      const now = new Date();
      const staleLeaseAt = new Date(now.getTime() - 1_000).toISOString();
      const markClaimed = db.prepare(
        `UPDATE requests
         SET status = 'claimed',
             agentId = 'legacy-remotebuddy',
             claimToken = 'legacy-claim-token',
             claimGeneration = 1,
             leaseExpiresAt = ?
         WHERE id = ?`,
      );
      markClaimed.run(staleLeaseAt, requestId);
      markClaimed.finalize();
      const insertJob = db.prepare(
        `INSERT INTO jobs (id, sessionId, kind, params, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insertJob.run(
        "job-provisional-stale-claim",
        "autonomy",
        "task.execute",
        JSON.stringify({ requestId }),
        new Date(now.getTime() + 1).toISOString(),
      );
      insertJob.finalize();

      expect(queue.reconcileWorkerHandoffsFromJobs(now)).toEqual({
        completed: 0,
        requestIds: [],
        jobIds: [],
      });
      expect(queue.getRequest(requestId)).toMatchObject({
        status: "claimed",
        handoffJobId: null,
        dispatchConfirmedAt: null,
      });

      // A provisional request can never normally become claimed before
      // confirmation. Simulate the persisted confirmation half of a
      // mixed-version recovery record and prove only that state is eligible.
      const markConfirmed = db.prepare(
        `UPDATE requests SET dispatchConfirmedAt = ?, updatedAt = ? WHERE id = ?`,
      );
      markConfirmed.run(now.toISOString(), now.toISOString(), requestId);
      markConfirmed.finalize();
      expect(queue.reconcileWorkerHandoffsFromJobs(now)).toEqual({
        completed: 1,
        requestIds: [requestId],
        jobIds: ["job-provisional-stale-claim"],
      });
      expect(queue.getRequest(requestId)).toMatchObject({
        status: "completed",
        handoffJobId: "job-provisional-stale-claim",
      });
    } finally {
      queue.close();
      db.close(true);
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
      db.run(`UPDATE requests SET claimToken = NULL WHERE id = ?`, requestId);
      db.close(true);

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

  test("tolerates malformed legacy metadata and releases database handles on close", () => {
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
      db.run(`UPDATE requests SET metadataJson = ? WHERE id = ?`, "{not-json", requestId);
      db.close(true);

      queue = new RequestQueue(dbPath);
      expect(queue.getRequest(requestId)?.metadata).toBeUndefined();
      expect(queue.claim("remotebuddy-legacy")).toMatchObject({
        ok: true,
        request: { id: requestId, metadata: undefined },
      });
    } finally {
      queue?.close();
      // RequestQueue.close() is a synchronous ownership boundary: callers must
      // be able to rotate or delete the SQLite/WAL files immediately.
      rmSync(root, { recursive: true, force: true });
    }
  });
});
