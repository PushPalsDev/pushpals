import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  REPOSITORY_AGENT_MAX_CLAIM_ATTEMPTS,
  REPOSITORY_AGENT_MAX_DEADLINE_HORIZON_MS,
  RepositoryAgentQueue,
} from "../apps/server/src/repository_agent_queue";

function input(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "dev",
    callerService: "workerpals",
    purpose: "debug",
    repositoryId: "repo_abc",
    repositoryRoot: "C:/repo",
    revision: "abc123",
    treeHash: "tree123",
    dirty: false,
    priority: "normal" as const,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: crypto.randomUUID(),
    request: { question: "Where is this failure owned?" },
    ...overrides,
  };
}

describe("RepositoryAgentQueue", () => {
  test("deduplicates a request within one repository", () => {
    const queue = new RepositoryAgentQueue(":memory:");
    const request = input({ idempotencyKey: "same" });
    const first = queue.enqueue(request);
    const second = queue.enqueue(request);
    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: true,
      requestId: first.requestId,
      deduplicated: true,
      status: "pending",
    });
    queue.close();
  });

  test("rejects reuse of an idempotency key for a different logical request", () => {
    const queue = new RepositoryAgentQueue(":memory:");
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const original = input({
      idempotencyKey: "bound-operation",
      deadlineAt,
      request: {
        caller: { service: "workerpals", sessionId: "dev" },
        purpose: "debug",
        repository: { revision: "abc123", tree: "tree123" },
        question: "Where is this failure owned?",
        context: { paths: ["src/router.ts"] },
      },
    });
    const first = queue.enqueue(original);
    expect(first.ok).toBe(true);

    const reorderedRetry = queue.enqueue({
      ...original,
      request: {
        context: { paths: ["src/router.ts"] },
        question: "Where is this failure owned?",
        repository: { tree: "tree123", revision: "abc123" },
        purpose: "debug",
        caller: { sessionId: "dev", service: "workerpals" },
      },
    });
    expect(reorderedRetry).toMatchObject({
      ok: true,
      requestId: first.requestId,
      deduplicated: true,
    });

    const changedInputs = [
      { purpose: "architecture" },
      { revision: "def456" },
      { treeHash: "tree456" },
      {
        request: {
          ...original.request,
          question: "Which validation command owns this failure?",
        },
      },
      {
        request: {
          ...original.request,
          context: { paths: ["src/other.ts"] },
        },
      },
    ];
    for (const changed of changedInputs) {
      const conflict = queue.enqueue({ ...original, ...changed });
      expect(conflict).toMatchObject({
        ok: false,
        requestId: first.requestId,
        conflict: true,
        code: "idempotency_conflict",
      });
    }
    queue.close();
  });

  test("bounds how far a durable request deadline may extend", () => {
    let nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const queue = new RepositoryAgentQueue(":memory:", { now: () => new Date(nowMs) });
    expect(
      queue.enqueue(
        input({
          deadlineAt: new Date(nowMs + REPOSITORY_AGENT_MAX_DEADLINE_HORIZON_MS).toISOString(),
        }),
      ).ok,
    ).toBe(true);
    expect(
      queue.enqueue(
        input({
          deadlineAt: new Date(nowMs + REPOSITORY_AGENT_MAX_DEADLINE_HORIZON_MS + 1).toISOString(),
        }),
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining("no more than") });
    queue.close();
  });

  test("isolates idempotency keys by stable repository identity", () => {
    const queue = new RepositoryAgentQueue(":memory:");
    const first = queue.enqueue(input({ idempotencyKey: "same", repositoryId: "repo_a" }));
    const second = queue.enqueue(input({ idempotencyKey: "same", repositoryId: "repo_b" }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.requestId).not.toBe(first.requestId);
    queue.close();
  });

  test("namespaces idempotency keys by caller service and session", () => {
    const queue = new RepositoryAgentQueue(":memory:");
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const first = queue.enqueue(input({ idempotencyKey: "shared-operation-name", deadlineAt }));
    const anotherService = queue.enqueue(
      input({
        idempotencyKey: "shared-operation-name",
        deadlineAt,
        callerService: "source_control_manager",
        request: {
          question: "Which review owns this?",
          caller: { service: "source_control_manager" },
        },
      }),
    );
    const anotherSession = queue.enqueue(
      input({
        idempotencyKey: "shared-operation-name",
        deadlineAt,
        sessionId: "another-session",
        request: {
          question: "Where is this failure owned?",
          caller: { service: "workerpals", sessionId: "another-session" },
        },
      }),
    );

    expect(first.ok).toBe(true);
    expect(anotherService.ok).toBe(true);
    expect(anotherSession.ok).toBe(true);
    expect(
      new Set([first.requestId, anotherService.requestId, anotherSession.requestId]).size,
    ).toBe(3);
    queue.close();
  });

  test("uses a fenced renewable lease and rejects stale completion", () => {
    const queue = new RepositoryAgentQueue(":memory:");
    const created = queue.enqueue(input());
    const claim = queue.claim("repository-agent", { leaseMs: 30_000 });
    expect(claim.ok).toBe(true);
    expect(claim.request?.request?.question).toBe("Where is this failure owned?");

    const stale = queue.complete(created.requestId!, {
      agentId: "repository-agent",
      claimToken: "stale",
      claimGeneration: claim.request!.claimGeneration,
      result: { answer: "wrong" },
    });
    expect(stale.ok).toBe(false);

    const renewed = queue.renewLease(
      created.requestId!,
      "repository-agent",
      claim.request!.claimToken!,
      claim.request!.claimGeneration,
      { leaseMs: 45_000 },
    );
    expect(renewed.ok).toBe(true);
    expect(
      queue.complete(created.requestId!, {
        agentId: "repository-agent",
        claimToken: claim.request!.claimToken!,
        claimGeneration: claim.request!.claimGeneration,
        result: { answer: "owned by src/router.ts" },
      }).ok,
    ).toBe(true);
    const completed = queue.get(created.requestId!);
    expect(completed?.result?.answer).toBe("owned by src/router.ts");
    expect(completed?.claimToken).toBeNull();
    expect(completed?.leaseExpiresAt).toBeNull();
    queue.close();
  });

  test("recovers an expired claim after restart", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-repository-agent-"));
    const dbPath = join(root, "state.sqlite");
    let nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    try {
      const first = new RepositoryAgentQueue(dbPath, { now: () => new Date(nowMs) });
      const created = first.enqueue(
        input({ deadlineAt: new Date(nowMs + 30 * 60_000).toISOString() }),
      );
      expect(created.ok).toBe(true);
      const claim = first.claim("crashed-agent", { leaseMs: 10_000 });
      expect(claim.ok).toBe(true);
      first.close();

      nowMs = Date.parse(claim.request!.leaseExpiresAt!) + 1;
      const restarted = new RepositoryAgentQueue(dbPath, { now: () => new Date(nowMs) });
      const recovered = restarted.recoverExpiredClaims();
      expect(recovered).toEqual({ recovered: 1, requestIds: [created.requestId!] });
      nowMs = Date.parse(restarted.get(created.requestId!)!.nextAttemptAt!) + 1;
      const replacement = restarted.claim("replacement-agent");
      expect(replacement.ok).toBe(true);
      expect(replacement.request?.id).toBe(created.requestId);
      expect(replacement.request?.claimToken).not.toBe(claim.request?.claimToken);
      restarted.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows can briefly retain SQLite WAL handles after close.
      }
    }
  });

  test("safely migrates and fingerprints legacy queue rows", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-repository-agent-migration-"));
    const dbPath = join(root, "state.sqlite");
    const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const deadlineAt = new Date(nowMs + 30 * 60_000).toISOString();
    const legacy = input({ idempotencyKey: "legacy-key", deadlineAt });
    try {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE repository_agent_requests (
          id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, callerService TEXT NOT NULL,
          purpose TEXT NOT NULL, repositoryId TEXT NOT NULL, repositoryRoot TEXT NOT NULL,
          revision TEXT NOT NULL, treeHash TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0,
          priority TEXT NOT NULL DEFAULT 'normal', deadlineAt TEXT NOT NULL,
          idempotencyKey TEXT NOT NULL, requestJson TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', agentId TEXT, claimToken TEXT,
          claimGeneration INTEGER NOT NULL DEFAULT 0, claimAttempts INTEGER NOT NULL DEFAULT 0,
          leaseExpiresAt TEXT, lastHeartbeatAt TEXT, resultJson TEXT, error TEXT,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, claimedAt TEXT,
          completedAt TEXT, failedAt TEXT
        );
        CREATE UNIQUE INDEX idx_repository_agent_request_idempotency
          ON repository_agent_requests(repositoryId, idempotencyKey);
      `);
      const createdAt = new Date(nowMs).toISOString();
      db.prepare(
        `INSERT INTO repository_agent_requests (
          id, sessionId, callerService, purpose, repositoryId, repositoryRoot,
          revision, treeHash, dirty, priority, deadlineAt, idempotencyKey,
          requestJson, status, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        "legacy-request",
        legacy.sessionId,
        legacy.callerService,
        legacy.purpose,
        legacy.repositoryId,
        legacy.repositoryRoot,
        legacy.revision,
        legacy.treeHash,
        0,
        legacy.priority,
        legacy.deadlineAt,
        legacy.idempotencyKey,
        JSON.stringify(legacy.request),
        createdAt,
        createdAt,
      );
      db.close();

      const migrated = new RepositoryAgentQueue(dbPath, { now: () => new Date(nowMs) });
      expect(migrated.get("legacy-request")?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(migrated.enqueue(legacy)).toMatchObject({
        ok: true,
        requestId: "legacy-request",
        deduplicated: true,
      });
      expect(
        migrated.enqueue({
          ...legacy,
          request: { question: "A different legacy request" },
        }),
      ).toMatchObject({ ok: false, conflict: true, code: "idempotency_conflict" });
      expect(
        migrated.enqueue({
          ...legacy,
          callerService: "source_control_manager",
          request: {
            question: "A distinct caller may reuse the conventional operation name",
            caller: { service: "source_control_manager" },
          },
        }),
      ).toMatchObject({ ok: true, deduplicated: false });
      migrated.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows can briefly retain SQLite WAL handles after close.
      }
    }
  });

  test("retries retryable failures with backoff and dead-letters after a bounded attempt count", () => {
    let nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const queue = new RepositoryAgentQueue(":memory:", { now: () => new Date(nowMs) });
    const created = queue.enqueue(
      input({ deadlineAt: new Date(nowMs + 30 * 60_000).toISOString() }),
    );
    const retryableError = JSON.stringify({
      code: "temporary_transport_failure",
      message: "temporary transport failure",
      retryable: true,
    });

    for (let attempt = 1; attempt <= REPOSITORY_AGENT_MAX_CLAIM_ATTEMPTS; attempt++) {
      const claim = queue.claim(`agent-${attempt}`);
      expect(claim.ok).toBe(true);
      const failed = queue.fail(created.requestId!, {
        agentId: `agent-${attempt}`,
        claimToken: claim.request!.claimToken!,
        claimGeneration: claim.request!.claimGeneration,
        message: retryableError,
      });
      if (attempt < REPOSITORY_AGENT_MAX_CLAIM_ATTEMPTS) {
        expect(failed).toMatchObject({ ok: true, requeued: true });
        expect(queue.get(created.requestId!)?.status).toBe("pending");
        expect(queue.claim("too-early").ok).toBe(false);
        expect(queue.healthSummary().delayedRetryCount).toBe(1);
        nowMs = Date.parse(failed.nextAttemptAt!) + 1;
      } else {
        expect(failed).toMatchObject({ ok: true, deadLettered: true });
      }
    }

    const terminal = queue.get(created.requestId!);
    expect(terminal?.status).toBe("failed");
    expect(JSON.parse(terminal!.error!)).toMatchObject({
      code: "repository_agent_retry_exhausted",
      retryable: false,
    });
    expect(terminal?.claimAttempts).toBe(REPOSITORY_AGENT_MAX_CLAIM_ATTEMPTS);
    expect(queue.claim("fourth-agent").ok).toBe(false);
    queue.close();
  });

  test("terminalizes a retryable failure when its backoff cannot fit before the deadline", () => {
    const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const queue = new RepositoryAgentQueue(":memory:", { now: () => new Date(nowMs) });
    const created = queue.enqueue(input({ deadlineAt: new Date(nowMs + 500).toISOString() }));
    const claim = queue.claim("repository-agent");
    const failed = queue.fail(created.requestId!, {
      agentId: "repository-agent",
      claimToken: claim.request!.claimToken!,
      claimGeneration: claim.request!.claimGeneration,
      message: JSON.stringify({
        code: "temporary_transport_failure",
        message: "temporary transport failure",
        retryable: true,
      }),
    });

    expect(failed).toMatchObject({ ok: true, deadLettered: true });
    expect(queue.get(created.requestId!)?.status).toBe("failed");
    expect(JSON.parse(queue.get(created.requestId!)!.error!)).toMatchObject({
      code: "repository_agent_retry_deadline_exhausted",
      retryable: false,
    });
    queue.close();
  });

  test("dead-letters repeatedly expired worker leases", () => {
    let nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const queue = new RepositoryAgentQueue(":memory:", { now: () => new Date(nowMs) });
    const created = queue.enqueue(
      input({ deadlineAt: new Date(nowMs + 30 * 60_000).toISOString() }),
    );

    for (let attempt = 1; attempt <= REPOSITORY_AGENT_MAX_CLAIM_ATTEMPTS; attempt++) {
      const claim = queue.claim(`crashing-agent-${attempt}`, { leaseMs: 10_000 });
      expect(claim.ok).toBe(true);
      nowMs = Date.parse(claim.request!.leaseExpiresAt!) + 1;
      const recovered = queue.recoverExpiredClaims(new Date(nowMs));
      if (attempt < REPOSITORY_AGENT_MAX_CLAIM_ATTEMPTS) {
        expect(recovered.recovered).toBe(1);
        nowMs = Date.parse(queue.get(created.requestId!)!.nextAttemptAt!) + 1;
      } else {
        expect(recovered.recovered).toBe(0);
      }
    }

    expect(queue.get(created.requestId!)?.status).toBe("failed");
    expect(JSON.parse(queue.get(created.requestId!)!.error!)).toMatchObject({
      code: "repository_agent_retry_exhausted",
      retryable: false,
    });
    queue.close();
  });

  test("reports stale queue health and prunes terminal rows after retention", () => {
    let nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const deadlineAt = new Date(nowMs + 30 * 60_000).toISOString();
    const queue = new RepositoryAgentQueue(":memory:", {
      now: () => new Date(nowMs),
      terminalRetentionMs: 60_000,
    });
    const created = queue.enqueue(input({ deadlineAt }));
    const claim = queue.claim("stalled-agent", { leaseMs: 10_000 });
    nowMs = Date.parse(claim.request!.leaseExpiresAt!) + 1;
    expect(queue.healthSummary()).toMatchObject({
      staleClaimCount: 1,
      unhealthy: true,
      maxClaimAttempts: REPOSITORY_AGENT_MAX_CLAIM_ATTEMPTS,
    });

    queue.expirePastDeadlines(new Date(Date.parse(deadlineAt) + 1));
    nowMs = Date.parse(deadlineAt) + 60_001;
    const pruned = queue.pruneTerminal({ now: new Date(nowMs), retentionMs: 60_000 });
    expect(pruned).toEqual({ pruned: 1, requestIds: [created.requestId!] });
    expect(queue.get(created.requestId!)).toBeNull();
    queue.close();
  });

  test("marks a request unhealthy when no worker claims it for five minutes", () => {
    let nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const queue = new RepositoryAgentQueue(":memory:", { now: () => new Date(nowMs) });
    queue.enqueue(input({ deadlineAt: new Date(nowMs + 30 * 60_000).toISOString() }));

    nowMs += 5 * 60_000;
    expect(queue.healthSummary()).toMatchObject({
      oldestPendingAgeMs: 5 * 60_000,
      pendingUnhealthyAfterMs: 5 * 60_000,
      unhealthy: true,
    });
    queue.close();
  });

  test("fails past-deadline requests instead of claiming them", () => {
    const queue = new RepositoryAgentQueue(":memory:");
    const deadlineAt = new Date(Date.now() + 20).toISOString();
    const created = queue.enqueue(input({ deadlineAt }));
    expect(created.ok).toBe(true);
    const expired = queue.expirePastDeadlines(new Date(Date.parse(deadlineAt) + 1));
    expect(expired).toBe(1);
    expect(queue.claim("repository-agent").ok).toBe(false);
    expect(queue.get(created.requestId!)?.status).toBe("failed");
    queue.close();
  });
});
