import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AutonomyStore, type AutonomyEvaluatorScorecard } from "../apps/server/src/autonomy";
import { CompletionQueue } from "../apps/server/src/completions";
import { JobQueue } from "../apps/server/src/jobs";
import { SqliteMemoryStore } from "../apps/server/src/memory_store";
import { applyRepositoryAgentMemoryFeedbackBatch } from "../apps/server/src/repository_agent_memory_feedback";
import { RepositoryAgentQueue } from "../apps/server/src/repository_agent_queue";
import { RequestQueue } from "../apps/server/src/requests";

// Keep SQLite-heavy fixtures bounded while tolerating host filesystem scheduling under the full suite.
setDefaultTimeout(15_000);

const stores: AutonomyStore[] = [];
const tempDirs: string[] = [];

function makeStore(): AutonomyStore {
  const store = new AutonomyStore(":memory:");
  stores.push(store);
  return store;
}

function makePersistentStore(prefix = "pushpals-autonomy-store-"): {
  store: AutonomyStore;
  dbPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(root, "autonomy.sqlite");
  tempDirs.push(root);
  const store = new AutonomyStore(dbPath);
  stores.push(store);
  return { store, dbPath };
}

function closeTrackedStore(store: AutonomyStore): void {
  const idx = stores.indexOf(store);
  if (idx >= 0) stores.splice(idx, 1);
  store.close();
}

function runEvaluatorNow(store: AutonomyStore): AutonomyEvaluatorScorecard {
  return (
    store as unknown as { runEvaluator: (nowIso?: string) => AutonomyEvaluatorScorecard }
  ).runEvaluator(new Date(Date.now() + 1000).toISOString());
}

function autonomyOutcomeCount(store: AutonomyStore, objectiveId: string): number {
  const db = (store as unknown as { db: any }).db;
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM autonomy_outcomes WHERE objective_id = ?`)
    .get(objectiveId) as { count: number };
  return Math.max(0, Math.floor(Number(row.count ?? 0)));
}

function autonomyObjectiveStatus(store: AutonomyStore, objectiveId: string): string | null {
  const db = (store as unknown as { db: any }).db;
  const row = db
    .prepare(`SELECT status FROM autonomy_objectives WHERE id = ? LIMIT 1`)
    .get(objectiveId) as { status: string | null } | undefined;
  return typeof row?.status === "string" ? row.status : null;
}

function autonomyPatternSampleCount(store: AutonomyStore, patternKey: string): number {
  const db = (store as unknown as { db: any }).db;
  const row = db
    .prepare(`SELECT sample_count FROM autonomy_pattern_stats WHERE pattern_key = ? LIMIT 1`)
    .get(patternKey) as { sample_count: number | null } | undefined;
  return Math.max(0, Math.floor(Number(row?.sample_count ?? 0)));
}

function seedRepositoryAgentMemoryFeedback(
  store: AutonomyStore,
  input: {
    observationId: string;
    objectiveId?: string;
    recordId?: string;
    memoryKey?: string;
    status?: "pending" | "processing" | "applied" | "failed";
    createdAt?: string;
    appliedAt?: string | null;
  },
): void {
  const db = (store as unknown as { db: any }).db;
  const objectiveId = input.objectiveId ?? `objective-${input.observationId}`;
  db.prepare(
    `INSERT INTO autonomy_repository_agent_memory_feedback (
       observation_id, objective_id, repository_id, repository_agent_request_id,
       outcome, authority_kind, authority_id, weight, memory_refs_json,
       status, attempts, claim_generation, created_at, applied_at
     ) VALUES (?, ?, ?, ?, 'successful', 'job_terminal', ?, 1, ?, ?, 0, 0, ?, ?)`,
  ).run(
    input.observationId,
    objectiveId,
    "github.com/example/project",
    `request-${input.observationId}`,
    `authority-${input.observationId}`,
    JSON.stringify([
      {
        id: input.recordId ?? `record-${input.observationId}`,
        namespace: "repository_agent_cache",
        key: input.memoryKey ?? `cache-${input.observationId}`,
        role: "analysis_cache",
      },
    ]),
    input.status ?? "pending",
    input.createdAt ?? new Date().toISOString(),
    input.appliedAt ?? null,
  );
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup for Windows file lock timing
    }
  }
});

describe("server AutonomyStore policy gates", () => {
  test("migrates legacy RepositoryAgent feedback columns before creating lease indexes", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-feedback-legacy-migration-"));
    const dbPath = join(root, "autonomy.sqlite");
    tempDirs.push(root);
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE autonomy_repository_agent_memory_feedback (
        observation_id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository_agent_request_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        authority_kind TEXT NOT NULL,
        authority_id TEXT NOT NULL,
        memory_refs_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
    `);
    legacy.close();

    const migrated = new AutonomyStore(dbPath);
    stores.push(migrated);
    const db = (migrated as unknown as { db: any }).db;
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(autonomy_repository_agent_memory_feedback)").all() as Array<{
          name: string;
        }>
      ).map((entry) => entry.name),
    );
    expect([...columns]).toEqual(
      expect.arrayContaining([
        "weight",
        "claim_token",
        "claim_generation",
        "lease_expires_at",
        "claimed_at",
      ]),
    );
    const indexes = new Set(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'autonomy_repository_agent_memory_feedback'`,
          )
          .all() as Array<{ name: string }>
      ).map((entry) => entry.name),
    );
    expect(indexes.has("idx_autonomy_repository_agent_feedback_lease")).toBe(true);
    expect(indexes.has("idx_autonomy_repository_agent_feedback_objective_created")).toBe(true);
  });

  test("durably applies one idempotent RepositoryAgent learning event from a terminal job", async () => {
    const { store, dbPath } = makePersistentStore("pushpals-repository-agent-feedback-");
    const jobs = new JobQueue(dbPath);
    const completions = new CompletionQueue(dbPath);
    const repositoryAgentQueue = new RepositoryAgentQueue(dbPath);
    let memory = new SqliteMemoryStore(dbPath);
    const repositoryId = "github.com/example/project";
    const cached = await memory.put({
      scope: { namespace: "repository_agent_cache", repositoryId },
      key: "analysis-key-1",
      kind: "repository_analysis",
      summary: "Candidate analysis",
      provenance: { service: "repository_agent", requestId: "seed" },
      confidence: 0.8,
      usefulness: 0.8,
    });
    const fact = await memory.put({
      scope: { namespace: "repository_facts", repositoryId },
      key: "fact-key-1",
      kind: "repository_evidence_observation",
      summary: "Host-verified evidence",
      provenance: { service: "repository_agent", requestId: "seed" },
      confidence: 0.9,
      usefulness: 0.7,
    });
    const repositoryAgentDeadlineAt = new Date(Date.now() + 60_000).toISOString();
    const repositoryAgentRequest = repositoryAgentQueue.enqueue({
      sessionId: "dev",
      callerService: "remotebuddy",
      purpose: "priority",
      repositoryId,
      repositoryRoot: "C:/repo",
      revision: "head-1",
      treeHash: "tree-1",
      dirty: false,
      priority: "background",
      deadlineAt: repositoryAgentDeadlineAt,
      idempotencyKey: "repository-agent-feedback",
      request: {
        schemaVersion: 1,
        caller: {
          service: "remotebuddy",
          sessionId: "dev",
          correlationId: "run-repository-agent-feedback",
        },
        purpose: "priority",
        repository: {
          identity: repositoryId,
          root: "C:/repo",
          revision: "head-1",
          tree: "tree-1",
          dirty: false,
        },
        question: "Which repository improvement should run next?",
        priority: "background",
        deadlineAt: repositoryAgentDeadlineAt,
        freshness: "cache_preferred",
        idempotencyKey: "repository-agent-feedback",
      },
    });
    const repositoryAgentRequestId = String(repositoryAgentRequest.requestId ?? "");
    const repositoryAgentClaim = repositoryAgentQueue.claim("repository-agent-test");
    expect(repositoryAgentClaim.request?.id).toBe(repositoryAgentRequestId);
    expect(
      repositoryAgentQueue.complete(repositoryAgentRequestId, {
        agentId: "repository-agent-test",
        claimToken: repositoryAgentClaim.request?.claimToken ?? "",
        claimGeneration: repositoryAgentClaim.request?.claimGeneration ?? 0,
        result: {
          schemaVersion: 1,
          requestId: repositoryAgentRequestId,
          analyzedRepository: { identity: repositoryId, revision: "head-1", tree: "tree-1" },
          answer: "Improve repository routing.",
          summary: "Repository routing is the highest-value bounded target.",
          confidence: 0.9,
          evidence: [
            { path: "src/routing/index.ts", revision: "head-1", rationale: "owns routing" },
          ],
          recommendations: [],
          validationProposals: [],
          cache: { hit: false, key: "analysis-key-1" },
          memoryRefs: [
            {
              id: cached.id,
              namespace: "repository_agent_cache",
              key: cached.key,
              role: "analysis_cache",
              relevance: 0.95,
              sourceRevision: "head-1",
            },
            {
              id: fact.id,
              namespace: "repository_facts",
              key: fact.key,
              role: "evidence_fact",
              relevance: 0.8,
              sourceRevision: "head-1",
            },
          ],
          completedAt: new Date().toISOString(),
        },
      }).ok,
    ).toBe(true);
    const enqueued = jobs.enqueue({
      taskId: "task-repository-agent-feedback",
      sessionId: "dev",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    const jobId = String(enqueued.jobId ?? "");
    expect(jobs.claim("worker-repository-agent-feedback").job?.id).toBe(jobId);

    const snapshotId = store.createSnapshot({
      sessionId: "dev",
      runId: "run-repository-agent-feedback",
    }).snapshot_id;
    const objective = {
      id: "objective-repository-agent-feedback",
      title: "Improve repository routing",
      instruction: "Improve and validate repository routing.",
      objective_type: "feature_small",
      component_area: "src/routing",
      trigger_type: "queue_health",
      target_paths: ["src/routing/index.ts"],
      scope: { read_anywhere: false, write_globs: ["src/routing/index.ts"] },
      confidence: 0.9,
      risk_level: "low",
      expected_validation: ["bun test"],
      status: "running",
      job_id: jobId,
    };
    const decision = store.recordObjectiveDecision({
      runId: "run-repository-agent-feedback",
      snapshotId,
      sessionId: "dev",
      repositoryAgentMemory: {
        // These caller-supplied addresses are deliberately false. Only the
        // completed server-owned RepositoryAgent request may be linked.
        repositoryId: "attacker.example/spoofed",
        requestId: repositoryAgentRequestId,
        memoryRefs: [
          {
            id: "spoofed-memory",
            namespace: "spoofed",
            key: "spoofed",
            role: "analysis_cache",
          },
        ],
      },
      objective,
    });
    expect(decision).toMatchObject({ ok: true });
    expect(
      store.recordObjectiveDecision({
        runId: "run-repository-agent-feedback",
        snapshotId,
        sessionId: "dev",
        // Normal lifecycle updates do not repeat RepositoryAgent attribution.
        objective: { ...objective, status: "running" },
      }).ok,
    ).toBe(true);
    expect(
      jobs.fail(jobId, {
        message: "candidate made no publishable repository change",
        diagnostics: {
          terminal: {
            failureClass: "artifact_only_no_publishable_patch",
            terminalStage: "quality",
            summary: "candidate made no publishable repository change",
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      store.recordOutcome({
        objectiveId: "objective-repository-agent-feedback",
        patternKey: decision.patternKey,
        jobId,
        success: false,
        userAction: "no_change",
      }).ok,
    ).toBe(true);

    expect(store.reconcileRepositoryAgentMemoryFeedback()).toEqual({ queued: 1 });
    expect(store.reconcileRepositoryAgentMemoryFeedback()).toEqual({ queued: 0 });
    const pending = store.listPendingRepositoryAgentMemoryFeedback();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      objectiveId: "objective-repository-agent-feedback",
      repositoryId,
      repositoryAgentRequestId,
      outcome: "failed",
      authorityKind: "job_terminal",
      weight: 0.5,
      attempts: 0,
    });
    expect(pending[0]?.memoryRefs.map((ref) => ref.role)).toEqual([
      "analysis_cache",
      "evidence_fact",
    ]);

    closeTrackedStore(store);
    const restarted = new AutonomyStore(dbPath);
    stores.push(restarted);
    expect(restarted.listPendingRepositoryAgentMemoryFeedback()).toHaveLength(1);

    expect(
      await applyRepositoryAgentMemoryFeedbackBatch({
        autonomyStore: restarted,
        memoryStore: memory,
        logger: { warn: () => {}, error: () => {} },
      }),
    ).toEqual({
      scanned: 1,
      applied: 1,
      deferred: 0,
      missingRecords: 0,
      staleRecords: 0,
    });
    const learnedCache = await memory.get(cached);
    const protectedFact = await memory.get(fact);
    expect(learnedCache?.usefulness).toBeLessThan(cached.usefulness);
    expect(learnedCache?.observations).toHaveLength(1);
    expect(protectedFact?.usefulness).toBe(fact.usefulness);
    expect(protectedFact?.observations).toHaveLength(0);
    expect(restarted.repositoryAgentMemoryFeedbackHealth()).toEqual({
      pending: 0,
      processing: 0,
      applied: 1,
      failed: 0,
      oldestPendingAgeMs: null,
      oldPendingCount: 0,
      pendingUnhealthyAfterMs: 5 * 60_000,
      staleClaimCount: 0,
      unhealthy: false,
    });
    await memory.close();
    memory = new SqliteMemoryStore(dbPath);
    expect((await memory.get(cached))?.observations).toHaveLength(1);
    expect(
      await applyRepositoryAgentMemoryFeedbackBatch({
        autonomyStore: restarted,
        memoryStore: memory,
        logger: { warn: () => {}, error: () => {} },
      }),
    ).toEqual({
      scanned: 0,
      applied: 0,
      deferred: 0,
      missingRecords: 0,
      staleRecords: 0,
    });
    await memory.close();
    completions.close();
    jobs.close();
    repositoryAgentQueue.close();
  });

  test("refuses planner memory addresses without a matching completed RepositoryAgent run", () => {
    const { store, dbPath } = makePersistentStore("pushpals-repository-agent-untrusted-link-");
    const repositoryAgentQueue = new RepositoryAgentQueue(dbPath);
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const pending = repositoryAgentQueue.enqueue({
      sessionId: "dev",
      callerService: "remotebuddy",
      purpose: "priority",
      repositoryId: "github.com/example/project",
      repositoryRoot: "C:/repo",
      revision: "head-1",
      treeHash: "tree-1",
      dirty: false,
      priority: "background",
      deadlineAt,
      idempotencyKey: "untrusted-link",
      request: {
        schemaVersion: 1,
        caller: {
          service: "remotebuddy",
          sessionId: "dev",
          correlationId: "run-repository-agent-untrusted-link",
        },
        purpose: "priority",
        repository: {
          identity: "github.com/example/project",
          root: "C:/repo",
          revision: "head-1",
          tree: "tree-1",
          dirty: false,
        },
        question: "Which improvement should run next?",
        priority: "background",
        deadlineAt,
        freshness: "cache_preferred",
        idempotencyKey: "untrusted-link",
      },
    });
    const snapshotId = store.createSnapshot({
      sessionId: "dev",
      runId: "run-repository-agent-untrusted-link",
    }).snapshot_id;
    expect(
      store.recordObjectiveDecision({
        runId: "run-repository-agent-untrusted-link",
        snapshotId,
        sessionId: "dev",
        repositoryAgentMemory: {
          requestId: pending.requestId,
          repositoryId: "attacker.example/spoofed",
          memoryRefs: [
            {
              id: "spoofed",
              namespace: "repository_agent_cache",
              key: "spoofed",
              role: "analysis_cache",
            },
          ],
        },
        objective: {
          id: "objective-repository-agent-untrusted-link",
          title: "Improve repository routing",
          instruction: "Improve and validate repository routing.",
          objective_type: "feature_small",
          component_area: "src/routing",
          trigger_type: "queue_health",
          target_paths: ["src/routing/index.ts"],
          scope: { read_anywhere: false, write_globs: ["src/routing/index.ts"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun test"],
          status: "proposed",
        },
      }).ok,
    ).toBe(true);
    const db = (store as unknown as { db: any }).db;
    expect(
      Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM autonomy_repository_agent_memory_links
             WHERE objective_id = ?`,
          )
          .get("objective-repository-agent-untrusted-link").count ?? 0,
      ),
    ).toBe(0);
    repositoryAgentQueue.close();
  });

  test("does not learn from infrastructure failures but accepts an explicit negative outcome", () => {
    const { store, dbPath } = makePersistentStore("pushpals-repository-agent-authority-");
    const jobs = new JobQueue(dbPath);
    const completions = new CompletionQueue(dbPath);
    const enqueued = jobs.enqueue({
      taskId: "task-repository-agent-authority",
      sessionId: "dev",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    const jobId = String(enqueued.jobId ?? "");
    expect(jobs.claim("worker-repository-agent-authority").job?.id).toBe(jobId);
    const snapshotId = store.createSnapshot({
      sessionId: "dev",
      runId: "run-repository-agent-authority",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run-repository-agent-authority",
      snapshotId,
      sessionId: "dev",
      objective: {
        id: "objective-repository-agent-authority",
        title: "Improve repository diagnostics",
        instruction: "Improve and validate repository diagnostics.",
        objective_type: "feature_small",
        component_area: "src/diagnostics",
        trigger_type: "queue_health",
        target_paths: ["src/diagnostics/index.ts"],
        scope: { read_anywhere: false, write_globs: ["src/diagnostics/index.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun test"],
        status: "running",
        job_id: jobId,
      },
    });
    expect(decision.ok).toBe(true);
    const db = (store as unknown as { db: any }).db;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO autonomy_repository_agent_memory_links (
         objective_id, repository_id, repository_agent_request_id,
         memory_refs_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "objective-repository-agent-authority",
      "github.com/example/project",
      "repository-agent-authority",
      JSON.stringify([
        {
          id: "cache-authority",
          namespace: "repository_agent_cache",
          key: "cache-authority",
          role: "analysis_cache",
        },
      ]),
      now,
      now,
    );
    expect(
      jobs.fail(jobId, {
        message: "worker runtime exited before the candidate could be evaluated",
        diagnostics: {
          terminal: {
            failureClass: "worker_runtime_failure",
            terminalStage: "executor",
            summary: "worker runtime process exited",
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      store.recordOutcome({
        objectiveId: "objective-repository-agent-authority",
        patternKey: decision.patternKey,
        jobId,
        success: false,
        userAction: "failed",
      }).ok,
    ).toBe(true);
    expect(store.reconcileRepositoryAgentMemoryFeedback()).toEqual({ queued: 0 });
    expect(store.listPendingRepositoryAgentMemoryFeedback()).toHaveLength(0);

    expect(
      store.recordOutcome({
        objectiveId: "objective-repository-agent-authority",
        patternKey: decision.patternKey,
        jobId,
        success: false,
        userAction: "rejected",
      }).ok,
    ).toBe(true);
    expect(store.reconcileRepositoryAgentMemoryFeedback()).toEqual({ queued: 1 });
    expect(store.listPendingRepositoryAgentMemoryFeedback()[0]).toMatchObject({
      outcome: "failed",
      authorityKind: "job_terminal",
      weight: 1,
    });
    completions.close();
    jobs.close();
  });

  test("waits for authoritative publication finalization before learning success", () => {
    const { store, dbPath } = makePersistentStore("pushpals-repository-agent-finalization-");
    const jobs = new JobQueue(dbPath);
    const completions = new CompletionQueue(dbPath);
    const enqueued = jobs.enqueue({
      taskId: "task-repository-agent-finalization",
      sessionId: "dev",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    const jobId = String(enqueued.jobId ?? "");
    expect(jobs.claim("worker-repository-agent-finalization").job?.id).toBe(jobId);
    const snapshotId = store.createSnapshot({
      sessionId: "dev",
      runId: "run-repository-agent-finalization",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run-repository-agent-finalization",
      snapshotId,
      sessionId: "dev",
      objective: {
        id: "objective-repository-agent-finalization",
        title: "Improve repository finalization",
        instruction: "Improve and validate repository finalization.",
        objective_type: "feature_small",
        component_area: "src/finalization",
        trigger_type: "queue_health",
        target_paths: ["src/finalization/index.ts"],
        scope: { read_anywhere: false, write_globs: ["src/finalization/index.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun test"],
        status: "running",
        job_id: jobId,
      },
    });
    expect(decision.ok).toBe(true);
    const db = (store as unknown as { db: any }).db;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO autonomy_repository_agent_memory_links (
         objective_id, repository_id, repository_agent_request_id,
         memory_refs_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "objective-repository-agent-finalization",
      "github.com/example/project",
      "repository-agent-finalization",
      JSON.stringify([
        {
          id: "cache-finalization",
          namespace: "repository_agent_cache",
          key: "cache-finalization",
          role: "analysis_cache",
        },
      ]),
      now,
      now,
    );
    const handoff = completions.enqueue({
      jobId,
      sessionId: "dev",
      origin: "autonomy",
      message: "publish candidate",
    });
    expect(jobs.complete(jobId, { summary: "worker candidate ready" }).ok).toBe(true);
    expect(
      store.recordOutcome({
        objectiveId: "objective-repository-agent-finalization",
        patternKey: decision.patternKey,
        jobId,
        success: true,
        userAction: "applied",
      }).ok,
    ).toBe(true);
    expect(store.reconcileRepositoryAgentMemoryFeedback()).toEqual({ queued: 0 });

    const claimed = completions.claim("scm-repository-agent-finalization");
    expect(claimed.completion?.id).toBe(handoff.completionId);
    expect(store.reconcileRepositoryAgentMemoryFeedback()).toEqual({ queued: 0 });
    expect(
      completions.markProcessedAndFinalizeJob(
        handoff.completionId ?? "",
        null,
        undefined,
        undefined,
        "scm-repository-agent-finalization",
        claimed.completion?.claimToken,
      ).ok,
    ).toBe(true);
    expect(store.reconcileRepositoryAgentMemoryFeedback()).toEqual({ queued: 1 });
    expect(store.listPendingRepositoryAgentMemoryFeedback()).toEqual([
      expect.objectContaining({
        outcome: "successful",
        authorityKind: "job_terminal",
        weight: 1,
      }),
    ]);
    completions.close();
    jobs.close();
  });

  test("records a later provider merge as a distinct correction after closed-unmerged", () => {
    const { store, dbPath } = makePersistentStore("pushpals-repository-agent-provider-transition-");
    const jobs = new JobQueue(dbPath);
    const completions = new CompletionQueue(dbPath);
    const prUrl = "https://github.com/example/project/pull/42";
    const enqueued = jobs.enqueue({
      taskId: "task-repository-agent-provider-transition",
      sessionId: "dev",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    const jobId = String(enqueued.jobId ?? "");
    expect(jobs.claim("worker-repository-agent-provider-transition").job?.id).toBe(jobId);
    expect(jobs.complete(jobId, { summary: "candidate ready", prUrl }).ok).toBe(true);
    const snapshotId = store.createSnapshot({
      sessionId: "dev",
      runId: "run-repository-agent-provider-transition",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run-repository-agent-provider-transition",
      snapshotId,
      sessionId: "dev",
      objective: {
        id: "objective-repository-agent-provider-transition",
        title: "Improve provider transitions",
        instruction: "Improve and validate provider transitions.",
        objective_type: "feature_small",
        component_area: "src/provider",
        trigger_type: "queue_health",
        target_paths: ["src/provider/index.ts"],
        scope: { read_anywhere: false, write_globs: ["src/provider/index.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun test"],
        status: "running",
        job_id: jobId,
      },
    });
    const db = (store as unknown as { db: any }).db;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO autonomy_repository_agent_memory_links (
         objective_id, repository_id, repository_agent_request_id,
         memory_refs_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "objective-repository-agent-provider-transition",
      "github.com/example/project",
      "repository-agent-provider-transition",
      JSON.stringify([
        {
          id: "cache-provider-transition",
          namespace: "repository_agent_cache",
          key: "cache-provider-transition",
          role: "analysis_cache",
        },
      ]),
      now,
      now,
    );
    const jobRow = db.prepare(`SELECT prUrlNormalized FROM jobs WHERE id = ?`).get(jobId) as {
      prUrlNormalized: string;
    };
    const closedAt = new Date(Date.now() - 1_000).toISOString();
    db.prepare(
      `INSERT INTO pr_provider_outcomes (
         normalizedPrUrl, prUrl, jobId, verdict, terminal, merged,
         providerStateAt, createdAt, updatedAt
       ) VALUES (?, ?, ?, 'closed_unmerged', 1, 0, ?, ?, ?)`,
    ).run(jobRow.prUrlNormalized, prUrl, jobId, closedAt, closedAt, closedAt);
    expect(
      store.recordOutcome({
        objectiveId: "objective-repository-agent-provider-transition",
        patternKey: decision.patternKey,
        jobId,
        success: false,
        userAction: "rejected",
      }).ok,
    ).toBe(true);
    expect(store.reconcileRepositoryAgentMemoryFeedback()).toEqual({ queued: 1 });
    const firstObservationId = store.listPendingRepositoryAgentMemoryFeedback()[0]!.observationId;

    const mergedAt = new Date().toISOString();
    db.prepare(
      `UPDATE pr_provider_outcomes
       SET verdict = 'merged', merged = 1, providerStateAt = ?, updatedAt = ?
       WHERE normalizedPrUrl = ?`,
    ).run(mergedAt, mergedAt, jobRow.prUrlNormalized);
    expect(
      store.recordOutcome({
        objectiveId: "objective-repository-agent-provider-transition",
        patternKey: decision.patternKey,
        jobId,
        success: true,
        userAction: "accepted",
      }).ok,
    ).toBe(true);
    expect(store.reconcileRepositoryAgentMemoryFeedback()).toEqual({ queued: 1 });
    const firstClaim = store.claimRepositoryAgentMemoryFeedback(10, 30_000)[0]!;
    expect(firstClaim.outcome).toBe("failed");
    expect(
      store.markRepositoryAgentMemoryFeedback(
        firstClaim.observationId,
        { claimToken: firstClaim.claimToken, claimGeneration: firstClaim.claimGeneration },
        true,
      ),
    ).toBe(true);
    const corrected = store.listPendingRepositoryAgentMemoryFeedback(10);
    expect(corrected).toEqual([
      expect.objectContaining({ outcome: "successful", authorityKind: "provider_terminal" }),
    ]);
    expect(corrected[0]!.observationId).not.toBe(firstObservationId);
    completions.close();
    jobs.close();
  });

  test("does not starve an older unreflected authority behind 500 reflected outcomes", () => {
    const { store, dbPath } = makePersistentStore("pushpals-repository-agent-feedback-page-");
    const jobs = new JobQueue(dbPath);
    const completions = new CompletionQueue(dbPath);
    const db = (store as unknown as { db: any }).db;
    const memoryRefsJson = JSON.stringify([
      {
        id: "cache-feedback-page",
        namespace: "repository_agent_cache",
        key: "cache-feedback-page",
        role: "analysis_cache",
      },
    ]);
    const insertJob = db.prepare(
      `INSERT INTO jobs (
         id, taskId, sessionId, kind, params, status, prUrl, prUrlNormalized,
         createdAt, updatedAt
       ) VALUES (?, ?, 'dev', 'task.execute', '{}', 'completed', ?, ?, ?, ?)`,
    );
    const insertObjective = db.prepare(
      `INSERT INTO autonomy_objectives (
         id, run_id, snapshot_id, session_id, title, instruction, objective_type,
         component_area, trigger_type, pattern_key, status, confidence, risk_level,
         job_id, scope_json, created_at, updated_at
       ) VALUES (?, ?, 'snapshot-feedback-page', 'dev', 'Paged objective',
                 'Validate paged feedback.', 'feature_small', 'src/paged', 'queue_health',
                 ?, 'completed', 0.9, 'low', ?,
                 '{"readAnywhere":false,"writeGlobs":["src/paged/**"],"targetPaths":["src/paged"]}',
                 ?, ?)`,
    );
    const insertLink = db.prepare(
      `INSERT INTO autonomy_repository_agent_memory_links (
         objective_id, repository_id, repository_agent_request_id,
         memory_refs_json, created_at, updated_at
       ) VALUES (?, 'github.com/example/project', ?, ?, ?, ?)`,
    );
    const insertProvider = db.prepare(
      `INSERT INTO pr_provider_outcomes (
         normalizedPrUrl, prUrl, jobId, verdict, terminal, merged,
         providerStateAt, createdAt, updatedAt
       ) VALUES (?, ?, ?, 'merged', 1, 1, ?, ?, ?)`,
    );
    const insertReflected = db.prepare(
      `INSERT INTO autonomy_repository_agent_memory_feedback (
         observation_id, objective_id, repository_id, repository_agent_request_id,
         outcome, authority_kind, authority_id, weight, memory_refs_json,
         status, attempts, claim_generation, created_at, applied_at
       ) VALUES (?, ?, 'github.com/example/project', ?, 'successful',
                 'provider_terminal', ?, 1, ?, 'applied', 1, 1, ?, ?)`,
    );
    const seed = db.transaction(() => {
      for (let index = 0; index <= 500; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const jobId = `job-feedback-page-${suffix}`;
        const objectiveId = `objective-feedback-page-${suffix}`;
        const requestId = `repository-agent-feedback-page-${suffix}`;
        const prUrl = `https://github.com/example/project/pull/${1000 + index}`;
        const normalizedPrUrl = prUrl.toLowerCase();
        const eventAt = new Date(Date.now() - (501 - index) * 1_000).toISOString();
        const authorityId = [normalizedPrUrl, jobId, eventAt, "merged", "1"].join("\u001f");
        insertJob.run(
          jobId,
          `task-feedback-page-${suffix}`,
          prUrl,
          normalizedPrUrl,
          eventAt,
          eventAt,
        );
        insertObjective.run(
          objectiveId,
          `run-feedback-page-${suffix}`,
          `pattern-feedback-page-${suffix}`,
          jobId,
          eventAt,
          eventAt,
        );
        insertLink.run(objectiveId, requestId, memoryRefsJson, eventAt, eventAt);
        insertProvider.run(normalizedPrUrl, prUrl, jobId, eventAt, eventAt, eventAt);
        if (index > 0) {
          insertReflected.run(
            `observation-feedback-page-${suffix}`,
            objectiveId,
            requestId,
            authorityId,
            memoryRefsJson,
            eventAt,
            eventAt,
          );
        }
      }
    });
    seed();

    expect(store.reconcileRepositoryAgentMemoryFeedback()).toEqual({ queued: 1 });
    expect(store.listPendingRepositoryAgentMemoryFeedback()).toEqual([
      expect.objectContaining({
        objectiveId: "objective-feedback-page-000",
        outcome: "successful",
        authorityKind: "provider_terminal",
      }),
    ]);
    completions.close();
    jobs.close();
  });

  test("claims RepositoryAgent feedback once and fences stale acknowledgements", () => {
    const { store, dbPath } = makePersistentStore("pushpals-repository-agent-feedback-lease-");
    const peer = new AutonomyStore(dbPath);
    stores.push(peer);
    const db = (store as unknown as { db: any }).db;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO autonomy_repository_agent_memory_feedback (
         observation_id, objective_id, repository_id, repository_agent_request_id,
         outcome, authority_kind, authority_id, weight, memory_refs_json,
         status, attempts, claim_generation, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?)`,
    ).run(
      "observation-feedback-lease",
      "objective-feedback-lease",
      "github.com/example/project",
      "repository-agent-feedback-lease",
      "successful",
      "job_terminal",
      "1",
      1,
      JSON.stringify([
        {
          id: "cache-feedback-lease",
          namespace: "repository_agent_cache",
          key: "cache-feedback-lease",
          role: "analysis_cache",
        },
      ]),
      now,
    );
    const claim = store.claimRepositoryAgentMemoryFeedback(1, 30_000);
    expect(claim).toHaveLength(1);
    expect(peer.claimRepositoryAgentMemoryFeedback(1, 30_000)).toHaveLength(0);
    expect(
      peer.markRepositoryAgentMemoryFeedback(
        claim[0]!.observationId,
        { claimToken: "stale-token", claimGeneration: claim[0]!.claimGeneration },
        true,
      ),
    ).toBe(false);
    expect(
      store.markRepositoryAgentMemoryFeedback(
        claim[0]!.observationId,
        { claimToken: claim[0]!.claimToken, claimGeneration: claim[0]!.claimGeneration },
        true,
      ),
    ).toBe(true);
    expect(store.repositoryAgentMemoryFeedbackHealth()).toMatchObject({
      pending: 0,
      processing: 0,
      applied: 1,
      staleClaimCount: 0,
      unhealthy: false,
    });
  });

  test("rejects expired leases and recovers missing or malformed lease timestamps", () => {
    const store = makeStore();
    seedRepositoryAgentMemoryFeedback(store, { observationId: "lease-expiry" });
    const db = (store as unknown as { db: any }).db;

    const first = store.claimRepositoryAgentMemoryFeedback(1, 30_000)[0]!;
    db.prepare(
      `UPDATE autonomy_repository_agent_memory_feedback
       SET lease_expires_at = ? WHERE observation_id = ?`,
    ).run(new Date(Date.now() - 1_000).toISOString(), first.observationId);
    expect(
      store.markRepositoryAgentMemoryFeedback(
        first.observationId,
        { claimToken: first.claimToken, claimGeneration: first.claimGeneration },
        true,
      ),
    ).toBe(false);
    expect(store.recoverExpiredRepositoryAgentMemoryFeedback()).toBe(1);

    const second = store.claimRepositoryAgentMemoryFeedback(1, 30_000)[0]!;
    expect(second.claimGeneration).toBe(first.claimGeneration + 1);
    db.prepare(
      `UPDATE autonomy_repository_agent_memory_feedback
       SET lease_expires_at = 'not-an-iso-timestamp' WHERE observation_id = ?`,
    ).run(second.observationId);
    expect(
      store.markRepositoryAgentMemoryFeedback(
        second.observationId,
        { claimToken: second.claimToken, claimGeneration: second.claimGeneration },
        false,
        new Error("late worker"),
      ),
    ).toBe(false);
    expect(store.repositoryAgentMemoryFeedbackHealth().staleClaimCount).toBe(1);
    expect(store.recoverExpiredRepositoryAgentMemoryFeedback()).toBe(1);

    const third = store.claimRepositoryAgentMemoryFeedback(1, 30_000)[0]!;
    expect(third.claimGeneration).toBe(second.claimGeneration + 1);
    expect(
      store.markRepositoryAgentMemoryFeedback(
        third.observationId,
        { claimToken: third.claimToken, claimGeneration: third.claimGeneration },
        true,
      ),
    ).toBe(true);
    expect(
      store.markRepositoryAgentMemoryFeedback(
        first.observationId,
        { claimToken: first.claimToken, claimGeneration: first.claimGeneration },
        true,
      ),
    ).toBe(false);

    seedRepositoryAgentMemoryFeedback(store, {
      observationId: "exhausted-first",
      objectiveId: "exhausted-objective",
      status: "processing",
    });
    seedRepositoryAgentMemoryFeedback(store, {
      observationId: "after-exhausted",
      objectiveId: "exhausted-objective",
    });
    db.prepare(
      `UPDATE autonomy_repository_agent_memory_feedback
       SET attempts = 5, claim_token = 'expired-final-token', claim_generation = 5,
           lease_expires_at = ?
       WHERE observation_id = 'exhausted-first'`,
    ).run(new Date(Date.now() - 1_000).toISOString());
    expect(store.recoverExpiredRepositoryAgentMemoryFeedback()).toBe(1);
    expect(
      db
        .prepare(
          `SELECT status FROM autonomy_repository_agent_memory_feedback
           WHERE observation_id = 'exhausted-first'`,
        )
        .get(),
    ).toEqual({ status: "failed" });
    expect(store.claimRepositoryAgentMemoryFeedback(1, 30_000)[0]?.observationId).toBe(
      "after-exhausted",
    );
  });

  test("claims feedback just in time and serializes events for one objective", () => {
    const { store, dbPath } = makePersistentStore("pushpals-feedback-ordering-");
    const peer = new AutonomyStore(dbPath);
    stores.push(peer);
    const baseMs = Date.now() - 10_000;
    seedRepositoryAgentMemoryFeedback(store, {
      observationId: "objective-a-first",
      objectiveId: "objective-a",
      createdAt: new Date(baseMs).toISOString(),
    });
    seedRepositoryAgentMemoryFeedback(store, {
      observationId: "objective-a-second",
      objectiveId: "objective-a",
      createdAt: new Date(baseMs + 1_000).toISOString(),
    });
    seedRepositoryAgentMemoryFeedback(store, {
      observationId: "objective-b-first",
      objectiveId: "objective-b",
      createdAt: new Date(baseMs + 2_000).toISOString(),
    });

    const first = store.claimRepositoryAgentMemoryFeedback(100, 30_000);
    expect(first.map((entry) => entry.observationId)).toEqual(["objective-a-first"]);
    const concurrent = peer.claimRepositoryAgentMemoryFeedback(100, 30_000);
    expect(concurrent.map((entry) => entry.observationId)).toEqual(["objective-b-first"]);
    expect(
      store.markRepositoryAgentMemoryFeedback(
        first[0]!.observationId,
        { claimToken: first[0]!.claimToken, claimGeneration: first[0]!.claimGeneration },
        true,
      ),
    ).toBe(true);
    const nextForObjective = store.claimRepositoryAgentMemoryFeedback(100, 30_000);
    expect(nextForObjective.map((entry) => entry.observationId)).toEqual(["objective-a-second"]);
  });

  test("prunes terminal feedback and settled links while surfacing old pending work", () => {
    const store = makeStore();
    const db = (store as unknown as { db: any }).db;
    const now = new Date();
    const old = new Date(now.getTime() - 40 * 24 * 60 * 60_000).toISOString();
    const recentlyOldPending = new Date(now.getTime() - 10 * 60_000).toISOString();
    seedRepositoryAgentMemoryFeedback(store, {
      observationId: "old-applied",
      status: "applied",
      createdAt: old,
      appliedAt: old,
    });
    seedRepositoryAgentMemoryFeedback(store, {
      observationId: "old-failed",
      status: "failed",
      createdAt: old,
    });
    seedRepositoryAgentMemoryFeedback(store, {
      observationId: "recent-applied-one",
      status: "applied",
      createdAt: new Date(now.getTime() - 2_000).toISOString(),
      appliedAt: new Date(now.getTime() - 2_000).toISOString(),
    });
    seedRepositoryAgentMemoryFeedback(store, {
      observationId: "recent-applied-two",
      status: "applied",
      createdAt: new Date(now.getTime() - 1_000).toISOString(),
      appliedAt: new Date(now.getTime() - 1_000).toISOString(),
    });
    seedRepositoryAgentMemoryFeedback(store, {
      observationId: "old-pending",
      status: "pending",
      createdAt: recentlyOldPending,
    });
    const insertLink = db.prepare(
      `INSERT INTO autonomy_repository_agent_memory_links (
         objective_id, repository_id, repository_agent_request_id,
         memory_refs_json, created_at, updated_at
       ) VALUES (?, ?, ?, '[]', ?, ?)`,
    );
    insertLink.run("orphan-old-link", "github.com/example/project", "request-old-link", old, old);
    insertLink.run(
      "objective-recent-applied-one",
      "github.com/example/project",
      "request-recent-applied-one",
      now.toISOString(),
      now.toISOString(),
    );
    insertLink.run(
      "objective-old-pending",
      "github.com/example/project",
      "request-old-pending",
      old,
      old,
    );

    expect(
      store.pruneRepositoryAgentMemoryFeedback({
        nowIso: now.toISOString(),
        terminalRetentionMs: 30 * 24 * 60 * 60_000,
        maxTerminalRows: 1,
        batchSize: 20,
      }),
    ).toEqual({ feedbackDeleted: 3, linksDeleted: 2 });
    const retainedLinks = (
      db
        .prepare(`SELECT objective_id AS objectiveId FROM autonomy_repository_agent_memory_links`)
        .all() as Array<{
        objectiveId: string;
      }>
    ).map((entry) => entry.objectiveId);
    expect(retainedLinks).not.toContain("orphan-old-link");
    expect(retainedLinks).not.toContain("objective-recent-applied-one");
    expect(retainedLinks).toContain("objective-old-pending");
    const health = store.repositoryAgentMemoryFeedbackHealth();
    expect(health).toMatchObject({
      pending: 1,
      applied: 1,
      failed: 0,
      oldPendingCount: 1,
      pendingUnhealthyAfterMs: 5 * 60_000,
      unhealthy: true,
    });
    db.prepare(
      `UPDATE autonomy_repository_agent_memory_feedback
       SET created_at = ? WHERE observation_id = 'old-pending'`,
    ).run(now.toISOString());
    expect(store.repositoryAgentMemoryFeedbackHealth()).toMatchObject({
      oldPendingCount: 0,
      unhealthy: false,
    });
  });

  test("acknowledges a stale memory record id without teaching its replacement", async () => {
    const { store, dbPath } = makePersistentStore("pushpals-feedback-stale-record-");
    const memory = new SqliteMemoryStore(dbPath);
    const scope = {
      namespace: "repository_agent_cache",
      repositoryId: "github.com/example/project",
    };
    const original = await memory.put({
      scope,
      key: "reused-analysis",
      kind: "repository_analysis",
      summary: "Original analysis",
      provenance: { service: "repository_agent" },
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(await memory.prune()).toBe(1);
    const replacement = await memory.put({
      scope,
      key: "reused-analysis",
      kind: "repository_analysis",
      summary: "Replacement analysis",
      provenance: { service: "repository_agent" },
    });
    seedRepositoryAgentMemoryFeedback(store, {
      observationId: "stale-record-feedback",
      recordId: original.id,
      memoryKey: "reused-analysis",
    });

    expect(
      await applyRepositoryAgentMemoryFeedbackBatch({
        autonomyStore: store,
        memoryStore: memory,
        limit: 1,
        logger: { warn: () => {}, error: () => {} },
      }),
    ).toEqual({
      scanned: 1,
      applied: 1,
      deferred: 0,
      missingRecords: 1,
      staleRecords: 1,
    });
    const unchanged = await memory.get(replacement);
    expect(unchanged?.revision).toBe(replacement.revision);
    expect(unchanged?.observations).toEqual([]);
    expect(store.repositoryAgentMemoryFeedbackHealth()).toMatchObject({
      applied: 1,
      failed: 0,
      unhealthy: false,
    });
    await memory.close();
  });

  test("repairs premature success telemetry after legacy publication failure reconciliation", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-lifecycle-");
    const jobs = new JobQueue(dbPath);
    let completions = new CompletionQueue(dbPath);
    const enqueued = jobs.enqueue({
      taskId: "task-lifecycle",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    const jobId = String(enqueued.jobId ?? "");
    expect(jobs.claim("worker-lifecycle").job?.id).toBe(jobId);
    const handoff = completions.enqueue({
      jobId,
      sessionId: "dev",
      message: "legacy candidate",
    });
    expect(jobs.complete(jobId, { summary: "premature success" }).ok).toBe(true);
    expect(
      store.recordOutcome({
        patternKey: "lifecycle:publication",
        jobId,
        success: true,
        userAction: "applied",
      }).ok,
    ).toBe(true);
    const claimed = completions.claim("scm-lifecycle");
    expect(claimed.completion?.id).toBe(handoff.completionId);
    expect(
      completions.markFailed(
        handoff.completionId ?? "",
        "merge failed",
        "scm-lifecycle",
        claimed.completion?.claimToken,
      ).ok,
    ).toBe(true);

    completions.close();
    completions = new CompletionQueue(dbPath);
    const reconciliation = store.reconcileJobLinkedOutcomeLifecycle();
    expect(reconciliation).toMatchObject({
      correctedFailures: 1,
      removedPrematureSuccesses: 0,
    });
    const db = (store as unknown as { db: any }).db;
    expect(
      db
        .prepare(
          `SELECT success, user_action AS userAction, regression_flag AS regressionFlag
           FROM autonomy_outcomes WHERE job_id = ?`,
        )
        .get(jobId),
    ).toMatchObject({ success: 0, userAction: "failed", regressionFlag: 1 });
    expect(
      db
        .prepare(
          `SELECT ema_success AS emaSuccess, fail_streak AS failStreak, sample_count AS sampleCount
           FROM autonomy_pattern_stats WHERE pattern_key = 'lifecycle:publication'`,
        )
        .get(),
    ).toMatchObject({ emaSuccess: 0, failStreak: 1, sampleCount: 1 });

    completions.close();
    jobs.close();
  });

  test("removes legacy approval-only PR success until provider-confirmed merge", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-legacy-approval-");
    const jobs = new JobQueue(dbPath);
    const enqueued = jobs.enqueue({
      taskId: "task-legacy-approval",
      sessionId: "dev",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    const jobId = String(enqueued.jobId ?? "");
    expect(jobs.claim("worker-legacy-approval").job?.id).toBe(jobId);
    expect(
      jobs.complete(jobId, {
        summary: "published for review",
        prUrl: "https://github.com/example/repo/pull/77",
      }).ok,
    ).toBe(true);

    const snapshotId = store.createSnapshot({
      sessionId: "dev",
      runId: "run-legacy-approval",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run-legacy-approval",
      snapshotId,
      sessionId: "dev",
      objective: {
        id: "obj-legacy-approval",
        title: "Improve import recovery",
        instruction: "Improve and validate import recovery.",
        objective_type: "feature_small",
        component_area: "src/imports",
        trigger_type: "queue_health",
        target_paths: ["src/imports/recover.ts"],
        scope: { read_anywhere: false, write_globs: ["src/imports/recover.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["npm test"],
        status: "running",
        job_id: jobId,
      },
    });
    expect(decision.ok).toBe(true);
    expect(
      store.recordOutcome({
        objectiveId: "obj-legacy-approval",
        jobId,
        patternKey: decision.patternKey,
        success: true,
        userAction: "accepted",
        terminal: true,
      }).ok,
    ).toBe(true);

    const repaired = store.reconcileJobLinkedOutcomeLifecycle();
    expect(repaired.removedPrematureSuccesses).toBe(1);
    expect(autonomyOutcomeCount(store, "obj-legacy-approval")).toBe(0);
    expect(autonomyObjectiveStatus(store, "obj-legacy-approval")).toBe("awaiting_review");

    expect(
      store.recordPrFeedback({
        feedbackKey: "legacy-approval:provider-merge",
        objectiveId: "obj-legacy-approval",
        jobId,
        patternKey: decision.patternKey,
        prNumber: 77,
        prUrl: "https://github.com/example/repo/pull/77",
        verdict: "approved_merged",
      }).ok,
    ).toBe(true);
    expect(store.reconcileJobLinkedOutcomeLifecycle().removedPrematureSuccesses).toBe(0);
    expect(autonomyOutcomeCount(store, "obj-legacy-approval")).toBe(1);
    expect(autonomyObjectiveStatus(store, "obj-legacy-approval")).toBe("completed");
    jobs.close();
  });

  test("createSnapshot builds multi-source state traits", () => {
    const store = makeStore();
    const snapshot = store.createSnapshot({
      sessionId: "s1",
      runId: "run_traits",
      requestSlo: { queueWaitMs: { p95: 210_000 } },
      jobSlo: { completed: 6, failed: 4 },
      repoHealthFlags: {
        is_worktree_dirty: true,
        is_merge_in_progress: false,
      },
    });

    expect(snapshot.top_signals.length).toBeGreaterThan(0);
    expect(snapshot.state_traits.length).toBeGreaterThan(0);
    expect(snapshot.state_traits.some((trait) => trait.trait_id === "queue_latency_high")).toBe(
      true,
    );
    expect(snapshot.state_traits.some((trait) => trait.trait_id === "job_failure_rate_high")).toBe(
      true,
    );
    expect(snapshot.state_traits.some((trait) => trait.trait_id === "repo_dirty_worktree")).toBe(
      true,
    );
  });

  test("large review backlogs do not hide execution-active objectives", () => {
    const store = makeStore();
    const seedSnapshot = store.createSnapshot({
      sessionId: "s1",
      runId: "run-large-review-backlog-seed",
    });
    for (let index = 0; index < 60; index += 1) {
      expect(
        store.recordObjectiveDecision({
          runId: `run-review-${index}`,
          snapshotId: seedSnapshot.snapshot_id,
          sessionId: "s1",
          objective: {
            id: `obj-review-${index}`,
            title: `Review backlog ${index}`,
            instruction: "Wait for provider review.",
            objective_type: "feature_small",
            component_area: `packages/item-${index}`,
            trigger_type: "queue_health",
            target_paths: [`packages/item-${index}/src/index.ts`],
            scope: {
              read_anywhere: false,
              write_globs: [`packages/item-${index}/src/index.ts`],
            },
            confidence: 0.9,
            risk_level: "low",
            expected_validation: ["npm test"],
            status: "awaiting_review",
          },
        }).ok,
      ).toBe(true);
    }
    expect(
      store.recordObjectiveDecision({
        runId: "run-active-after-review-backlog",
        snapshotId: seedSnapshot.snapshot_id,
        sessionId: "s1",
        objective: {
          id: "obj-active-after-review-backlog",
          title: "Active recovery work",
          instruction: "Continue active recovery work.",
          objective_type: "small_refactor",
          component_area: "services/recovery",
          trigger_type: "queue_health",
          target_paths: ["services/recovery/runner.go"],
          scope: { read_anywhere: false, write_globs: ["services/recovery/runner.go"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["go test ./..."],
          status: "running",
        },
      }).ok,
    ).toBe(true);
    const db = (store as unknown as { db: any }).db;
    db.prepare(
      `UPDATE autonomy_objectives SET updated_at = ? WHERE id = 'obj-active-after-review-backlog'`,
    ).run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const snapshot = store.createSnapshot({
      sessionId: "s1",
      runId: "run-large-review-backlog-check",
    });
    expect(
      snapshot.open_objectives.some(
        (row) => row.objective_id === "obj-active-after-review-backlog",
      ),
    ).toBe(true);
    expect(snapshot.open_objectives.filter((row) => row.status === "awaiting_review").length).toBe(
      60,
    );
  });

  test("createSnapshot marks repo validation red after repeated required command failures", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-validation-red-");
    const jobQueue = new JobQueue(dbPath);

    try {
      for (let i = 0; i < 2; i++) {
        const enqueued = jobQueue.enqueue({
          taskId: `task-validation-red-${i + 1}`,
          sessionId: "s1",
          kind: "task.execute",
          params: { instruction: "Repair the local web smoke baseline." },
        });
        expect(enqueued.ok).toBe(true);
        const claimed = jobQueue.claim(`worker-validation-red-${i + 1}`);
        expect(claimed.ok).toBe(true);
        const jobId = String(claimed.job?.id ?? "");
        expect(jobId.length).toBeGreaterThan(0);

        const failed = jobQueue.fail(jobId, {
          message: "Required validation failed",
          diagnostics: {
            terminal: {
              failureClass: "validation_failed",
              terminalStage: "focused_validation",
              executorBackend: "openai_codex",
              summary: "bun run web:e2e failed",
            },
            validationRuns: [
              {
                attempt: 1,
                command: "bun run web:e2e",
                exitCode: 1,
                durationMs: 1200,
                passed: false,
                failureClass: "browser_smoke_failed",
                stderrTail:
                  "scripts/__tests__/cleanup-harness.js:42 browser smoke assertion failed",
              },
            ],
          },
        });
        expect(failed.ok).toBe(true);
      }

      const snapshot = store.createSnapshot({ sessionId: "s1", runId: "run_validation_red" });
      expect(snapshot.repo_health_flags.required_validation_red).toBe(true);
      expect(snapshot.validation_incident?.command).toBe("bun run web:e2e");
      expect(snapshot.validation_incident?.signal_type).toBe("test_failure");
      expect(snapshot.validation_incident?.failure_count).toBe(2);
      expect(snapshot.validation_incident?.failed_job_ids).toHaveLength(2);
      expect(snapshot.validation_incident?.target_path_hints).toContain(
        "scripts/__tests__/cleanup-harness.js",
      );
      expect(
        snapshot.top_signals.some((signal) => signal.signal_id === "sig_validation_incident"),
      ).toBe(true);
      expect(snapshot.state_traits.some((trait) => trait.trait_id === "repo_validation_red")).toBe(
        true,
      );
    } finally {
      jobQueue.close();
    }
  });

  test("createSnapshot never turns trusted-environment deferrals into validation repair incidents", () => {
    const { store, dbPath } = makePersistentStore(
      "pushpals-autonomy-validation-environment-deferral-",
    );
    const jobQueue = new JobQueue(dbPath);

    try {
      for (let i = 0; i < 3; i++) {
        const enqueued = jobQueue.enqueue({
          taskId: `task-validation-environment-${i + 1}`,
          sessionId: "s1",
          kind: "task.execute",
          params: { instruction: "Run required validation." },
        });
        expect(enqueued.ok).toBe(true);
        const claimed = jobQueue.claim(`worker-validation-environment-${i + 1}`);
        const jobId = String(claimed.job?.id ?? "");
        expect(jobId.length).toBeGreaterThan(0);
        expect(
          jobQueue.fail(jobId, {
            message: "Trusted validation was deferred",
            diagnostics: {
              terminal: {
                failureClass: "trusted_validation_required",
                terminalStage: "trusted_environment_validation",
                executorBackend: "openai_codex",
                summary: "Candidate requires trusted-environment validation",
              },
              validationRuns: [
                {
                  attempt: 1,
                  command: "bun run validate",
                  exitCode: 1,
                  durationMs: 0,
                  passed: false,
                  failureClass: "environment",
                  stderrTail:
                    "Trusted-environment validation deferred before execution because the worker sandbox intentionally has no Docker socket. Run this command on the trusted host.",
                },
              ],
            },
          }).ok,
        ).toBe(true);
      }

      const snapshot = store.createSnapshot({
        sessionId: "s1",
        runId: "run_validation_environment_deferral",
      });
      expect(snapshot.repo_health_flags.required_validation_red).toBe(false);
      expect(snapshot.validation_incident).toBeNull();
      expect(
        snapshot.top_signals.some((signal) => signal.signal_id === "sig_validation_incident"),
      ).toBe(false);
      expect(snapshot.state_traits.some((trait) => trait.trait_id === "repo_validation_red")).toBe(
        false,
      );
    } finally {
      jobQueue.close();
    }
  });

  test("createSnapshot keeps scope-gate worker failures as queue health signals", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-scope-gate-signal-");
    const jobQueue = new JobQueue(dbPath);

    try {
      const enqueued = jobQueue.enqueue({
        taskId: "task-scope-gate-signal",
        sessionId: "s1",
        kind: "task.execute",
        params: { instruction: "Fix the current lint blocker and validate with bun run lint." },
      });
      expect(enqueued.ok).toBe(true);
      const claimed = jobQueue.claim("worker-scope-gate-signal");
      expect(claimed.ok).toBe(true);
      const jobId = String(claimed.job?.id ?? "");
      expect(jobId.length).toBeGreaterThan(0);

      const failed = jobQueue.fail(jobId, {
        message:
          "Quality gate needs revision 1/3: ScopeGate: found no relevant test file modified for this test-focused task.",
        diagnostics: {
          terminal: {
            failureClass: "artifact_only_no_publishable_patch",
            terminalStage: "test harness repair",
            executorBackend: "openai_codex",
            summary:
              "Quality gate needs revision 1/3: ScopeGate: found no relevant test file modified for this test-focused task.",
          },
        },
      });
      expect(failed.ok).toBe(true);

      const snapshot = store.createSnapshot({
        sessionId: "s1",
        runId: "run_scope_gate_signal",
      });
      const failureSignal = snapshot.top_signals.find(
        (signal) => signal.signal_id === "sig_fail_1",
      );
      expect(snapshot.repo_health_flags.required_validation_red).toBe(false);
      expect(snapshot.validation_incident).toBeNull();
      expect(failureSignal?.type).toBe("queue_health");
      expect(failureSignal?.evidence).toContain("class=no_reviewable_repo_change");
      expect(failureSignal?.evidence).not.toContain("artifact_only_no_publishable_patch");
    } finally {
      jobQueue.close();
    }
  });

  test("createSnapshot does not open a cross-job incident from retries in one terminal job", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-validation-red-single-job-");
    const jobQueue = new JobQueue(dbPath);

    try {
      const enqueued = jobQueue.enqueue({
        taskId: "task-validation-red-single-job",
        sessionId: "s1",
        kind: "task.execute",
        params: { instruction: "Repair the local web smoke baseline." },
      });
      expect(enqueued.ok).toBe(true);
      const claimed = jobQueue.claim("worker-validation-red-single-job");
      expect(claimed.ok).toBe(true);
      const jobId = String(claimed.job?.id ?? "");
      expect(jobId.length).toBeGreaterThan(0);

      const failed = jobQueue.fail(jobId, {
        message: "Required validation failed",
        diagnostics: {
          terminal: {
            failureClass: "validation_failed",
            terminalStage: "focused_validation",
            executorBackend: "openai_codex",
            summary: "bun run web:e2e failed",
          },
          validationRuns: [
            {
              attempt: 1,
              command: "bun run web:e2e",
              exitCode: 1,
              durationMs: 1200,
              passed: false,
              failureClass: "browser_smoke_failed",
              stderrTail: "tests/web-smoke.test.ts:42 home route startup failed",
            },
            {
              attempt: 2,
              command: "bun run web:e2e",
              exitCode: 1,
              durationMs: 1300,
              passed: false,
              failureClass: "browser_smoke_failed",
              stderrTail: "tests/web-smoke.test.ts:42 home route startup failed",
            },
          ],
        },
      });
      expect(failed.ok).toBe(true);

      const snapshot = store.createSnapshot({
        sessionId: "s1",
        runId: "run_validation_red_single_job",
      });
      expect(snapshot.repo_health_flags.required_validation_red).toBe(false);
      expect(snapshot.validation_incident).toBeNull();
    } finally {
      jobQueue.close();
    }
  });

  test("trusted-host failures stay candidate-specific until the failing candidate passes", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-trusted-host-circuit-");
    const jobs = new JobQueue(dbPath);
    const completions = new CompletionQueue(dbPath);
    const failedTest =
      "mandatory AccountProvider state machine > fails account deletion locally when the account API is not configured";
    const output = `account/__tests__/AccountContext.test.tsx:\n(fail) ${failedTest} [7ms]`;
    const finalize = (
      suffix: string,
      ok: boolean,
      candidateSha = `candidate-${suffix}`,
    ): string => {
      const enqueued = jobs.enqueue({
        taskId: `task-trusted-host-${suffix}`,
        sessionId: "s1",
        kind: "task.execute",
        params: { instruction: `Candidate ${suffix}` },
        dedupeKey: `trusted-host:${suffix}`,
      });
      const jobId = String(enqueued.jobId ?? "");
      const workerId = `worker-${suffix}`;
      const claimedJob = jobs.claim(workerId).job;
      expect(claimedJob?.id).toBe(jobId);
      expect(claimedJob?.claimGeneration).toBeGreaterThanOrEqual(1);
      const handoff = completions.enqueue(
        {
          jobId,
          sessionId: "s1",
          commitSha: candidateSha,
          branch: `refs/pushpals/agent/worker/${suffix}`,
          message: "candidate",
          trustedValidationCommands: ["bun run validate"],
        },
        {
          beginJobFinalization: true,
          jobClaimAuthority: {
            workerId,
            claimGeneration: Number(claimedJob?.claimGeneration ?? 0),
          },
        },
      );
      const completionId = handoff.completionId ?? "";
      const pusherId = `scm-${suffix}`;
      const claimed = completions.claim(pusherId);
      expect(claimed.completion?.id).toBe(completionId);
      const report = {
        version: 1,
        baselineSha: "shared-baseline",
        candidateSha,
        candidateRef: `refs/pushpals/validation/${"a".repeat(32)}/1/candidate`,
        results: [
          {
            ok,
            command: "bun run validate",
            output: ok ? "20 pass, 0 fail" : output,
            exitCode: ok ? 0 : 1,
            durationMs: 2_000,
            phase: "validation",
            ...(ok
              ? {}
              : {
                  failureClass: "test_failure",
                  failedTests: [failedTest],
                  targetPathHints: ["account/__tests__/AccountContext.test.tsx"],
                  failureLines: [
                    `candidate ${candidateSha} failed in disposable worktree ${suffix}`,
                  ],
                }),
          },
        ],
      };
      const result = ok
        ? completions.markProcessedAndFinalizeJob(
            completionId,
            null,
            undefined,
            report,
            pusherId,
            claimed.completion?.claimToken,
          )
        : completions.markFailedAndBlockJob(
            completionId,
            `Trusted validation failed: ${failedTest}`,
            undefined,
            report,
            pusherId,
            claimed.completion?.claimToken,
          );
      expect(result.ok).toBe(true);
      return jobId;
    };

    try {
      const firstFailedJobId = finalize("failure-a", false);
      finalize("failure-b", false);
      const red = store.createSnapshot({ sessionId: "s1", runId: "run_trusted_red" });
      expect(red.repo_health_flags.required_validation_red).toBe(true);
      expect(red.validation_incident).toMatchObject({
        source: "trusted_host",
        cross_job_circuit_open: true,
        command: "bun run validate",
        failure_count: 2,
        failed_tests: [failedTest],
        target_path_hints: ["account/__tests__/AccountContext.test.tsx"],
        failure_fingerprint: expect.any(String),
        validation_scope: "candidate_specific",
        baseline_failure_proven: false,
      });
      expect(red.validation_incident?.failed_job_ids).toHaveLength(2);
      expect(store.getReliabilityMetrics().validationFingerprintCollisionCount).toBe(0);

      const db = (store as unknown as { db: any }).db;
      db.prepare(
        `INSERT INTO job_validation_runs (
           jobId, command, exitCode, durationMs, passed, failureClass,
           stdoutTail, stderrTail, metadataJson, createdAt
         ) VALUES (?, 'bun run validate', 0, 100, 1, NULL, 'worker sandbox passed', NULL, '{}', ?)`,
      ).run(firstFailedJobId, new Date(Date.now() + 100).toISOString());
      const workerGreenOnly = store.createSnapshot({
        sessionId: "s1",
        runId: "run_trusted_worker_green_only",
      });
      expect(workerGreenOnly.repo_health_flags.required_validation_red).toBe(true);
      expect(workerGreenOnly.validation_incident?.source).toBe("trusted_host");

      finalize("unrelated-success", true);
      const stillRed = store.createSnapshot({
        sessionId: "s1",
        runId: "run_trusted_unrelated_green",
      });
      expect(stillRed.repo_health_flags.required_validation_red).toBe(true);
      expect(stillRed.validation_incident?.candidate_sha).toBe("candidate-failure-b");

      finalize("exact-success", true, "candidate-failure-b");
      const green = store.createSnapshot({ sessionId: "s1", runId: "run_trusted_green" });
      expect(green.repo_health_flags.required_validation_red).toBe(false);
      expect(green.validation_incident).toBeNull();
    } finally {
      completions.close();
      jobs.close();
    }
  });

  test("a deterministic terminal retry remains incident evidence after a transient first attempt", () => {
    const { store, dbPath } = makePersistentStore(
      "pushpals-autonomy-transient-then-deterministic-",
    );
    const jobs = new JobQueue(dbPath);
    const completions = new CompletionQueue(dbPath);
    const failedTest = "retry boundary > preserves the deterministic assertion";
    const command = "bun test tests/retry-boundary.test.ts";
    const failCandidate = (suffix: string): void => {
      const enqueued = jobs.enqueue({
        taskId: `task-transient-terminal-${suffix}`,
        sessionId: "s1",
        kind: "task.execute",
        params: { origin: "autonomy" },
        dedupeKey: `transient-terminal:${suffix}`,
      });
      const jobId = String(enqueued.jobId ?? "");
      const workerId = `worker-transient-terminal-${suffix}`;
      const claimedJob = jobs.claim(workerId).job;
      expect(claimedJob?.id).toBe(jobId);
      expect(claimedJob?.claimGeneration).toBeGreaterThanOrEqual(1);
      const handoff = completions.enqueue(
        {
          jobId,
          sessionId: "s1",
          commitSha: `candidate-${suffix}`,
          branch: `refs/pushpals/agent/worker/${suffix}`,
          message: "candidate",
          trustedValidationCommands: [command],
        },
        {
          beginJobFinalization: true,
          jobClaimAuthority: {
            workerId,
            claimGeneration: Number(claimedJob?.claimGeneration ?? 0),
          },
        },
      );
      const pusherId = `scm-transient-terminal-${suffix}`;
      const claimed = completions.claim(pusherId).completion;
      expect(claimed?.id).toBe(handoff.completionId);
      expect(
        completions.markFailedAndBlockJob(
          handoff.completionId ?? "",
          `Trusted validation failed: ${failedTest}`,
          undefined,
          {
            version: 1,
            baselineSha: "shared-retry-baseline",
            candidateSha: `candidate-${suffix}`,
            candidateRef: `refs/pushpals/validation/${suffix}/candidate`,
            results: [
              {
                ok: false,
                command,
                output: "ECONNRESET while contacting a transient dependency",
                exitCode: 1,
                durationMs: 100,
                phase: "validation",
                attempt: 1,
                retryReason: "transient_infrastructure",
              },
              {
                ok: false,
                command,
                output: `tests/retry-boundary.test.ts:\n(fail) ${failedTest}`,
                exitCode: 1,
                durationMs: 100,
                phase: "validation",
                attempt: 2,
                retryReason: "transient_infrastructure",
              },
            ],
          },
          pusherId,
          claimed?.claimToken,
        ).ok,
      ).toBe(true);
    };

    try {
      failCandidate("a");
      failCandidate("b");
      const snapshot = store.createSnapshot({
        sessionId: "s1",
        runId: "run_transient_then_deterministic",
      });
      expect(snapshot.validation_incident).toMatchObject({
        active: true,
        command,
        failure_count: 2,
        failed_tests: [failedTest],
        cross_job_circuit_open: true,
      });
      expect(store.getReliabilityMetrics().transientValidationRetries).toBe(2);
    } finally {
      completions.close();
      jobs.close();
    }
  });

  test("keeps trusted failures observable without inventing a repair candidate", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-no-candidate-ref-");
    const jobs = new JobQueue(dbPath);
    const db = (store as unknown as { db: any }).db;
    try {
      for (const [index, suffix] of ["a", "b"].entries()) {
        const enqueued = jobs.enqueue({
          taskId: `task-no-provenance-${suffix}`,
          sessionId: "s1",
          kind: "task.execute",
          params: { origin: "autonomy", autonomy: { origin: "autonomy" } },
          dedupeKey: `no-provenance:${suffix}`,
        });
        const jobId = String(enqueued.jobId ?? "");
        expect(jobs.claim(`worker-no-provenance-${suffix}`).job?.id).toBe(jobId);
        expect(jobs.publishBlocked(jobId, { message: "trusted host failed" }).ok).toBe(true);
        db.prepare(
          `INSERT INTO job_validation_runs (
             jobId, command, exitCode, durationMs, passed, failureClass,
             stdoutTail, stderrTail, metadataJson, createdAt
           ) VALUES (?, 'bun test', 1, 100, 0, 'test_failure', ?, NULL, ?, ?)`,
        ).run(
          jobId,
          "tests/example.test.ts:\n(fail) same retained failure",
          JSON.stringify({
            source: "trusted_host",
            baselineSha: "baseline-shared",
            candidateSha: `unverified-worker-${suffix}`,
            candidateRef: null,
            failureFingerprint: "same-no-provenance-failure",
            failedTests: ["same retained failure"],
            targetPathHints: ["tests/example.test.ts"],
          }),
          new Date(Date.now() + index * 100).toISOString(),
        );
      }

      const snapshot = store.createSnapshot({
        sessionId: "s1",
        runId: "run_no_candidate_provenance",
      });
      expect(snapshot.repo_health_flags.required_validation_red).toBe(true);
      expect(snapshot.validation_incident).toMatchObject({
        source: "trusted_host",
        validation_scope: "candidate_unavailable",
        candidate_sha: null,
        candidate_ref: null,
        candidate_shas: [],
      });
    } finally {
      jobs.close();
    }
  });

  test("candidate-specific validation incidents ignore passes from unrelated candidates", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-candidate-specific-pass-");
    const jobs = new JobQueue(dbPath);
    const db = (store as unknown as { db: any }).db;
    const baselineSha = "baseline-shared";
    const failingCandidateSha = "candidate-failing";
    const failureFingerprint = "same-candidate-failure";
    let sequence = 0;

    const recordRun = (suffix: string, candidateSha: string, passed: boolean): void => {
      const enqueued = jobs.enqueue({
        taskId: `task-candidate-pass-${suffix}`,
        sessionId: "s1",
        kind: "task.execute",
        params: { origin: "autonomy", autonomy: { origin: "autonomy" } },
        dedupeKey: `candidate-pass:${suffix}`,
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(jobs.claim(`worker-candidate-pass-${suffix}`).job?.id).toBe(jobId);
      if (passed) {
        expect(jobs.complete(jobId, { summary: "trusted host passed" }).ok).toBe(true);
      } else {
        expect(jobs.publishBlocked(jobId, { message: "trusted host failed" }).ok).toBe(true);
      }
      sequence += 1;
      db.prepare(
        `INSERT INTO job_validation_runs (
           jobId, command, exitCode, durationMs, passed, failureClass,
           stdoutTail, stderrTail, metadataJson, createdAt
         ) VALUES (?, 'bun test tests/account.test.ts', ?, 100, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        jobId,
        passed ? 0 : 1,
        passed ? 1 : 0,
        passed ? null : "test_failure",
        passed ? "1 pass" : "(fail) account state remains stale",
        JSON.stringify({
          source: "trusted_host",
          baselineSha,
          candidateSha,
          candidateRef: `refs/pushpals/candidate/${candidateSha}`,
          failureFingerprint,
          failedTests: passed ? [] : ["account state remains stale"],
          targetPathHints: passed ? [] : ["tests/account.test.ts"],
          failureLines: passed ? [] : ["(fail) account state remains stale"],
        }),
        new Date(Date.now() + sequence * 100).toISOString(),
      );
    };

    try {
      recordRun("failure-a", failingCandidateSha, false);
      recordRun("failure-b", failingCandidateSha, false);
      const red = store.createSnapshot({ sessionId: "s1", runId: "run_candidate_red" });
      expect(red.validation_incident).toMatchObject({
        validation_scope: "candidate_specific",
        candidate_sha: failingCandidateSha,
        baseline_sha: baselineSha,
      });

      recordRun("unrelated-pass", "candidate-unrelated", true);
      const stillRed = store.createSnapshot({
        sessionId: "s1",
        runId: "run_candidate_unrelated_pass",
      });
      expect(stillRed.validation_incident?.candidate_sha).toBe(failingCandidateSha);

      recordRun("exact-pass", failingCandidateSha, true);
      const green = store.createSnapshot({ sessionId: "s1", runId: "run_candidate_exact_pass" });
      expect(green.validation_incident).toBeNull();
      expect(green.repo_health_flags.required_validation_red).toBe(false);
    } finally {
      jobs.close();
    }
  });

  test("only explicit baseline execution proof creates and clears a baseline incident", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-explicit-baseline-");
    const jobs = new JobQueue(dbPath);
    const db = (store as unknown as { db: any }).db;
    const baselineSha = "baseline-explicit";
    let sequence = 0;
    const recordRun = (
      suffix: string,
      validationTarget: "candidate" | "baseline",
      passed: boolean,
    ) => {
      const enqueued = jobs.enqueue({
        taskId: `task-baseline-proof-${suffix}`,
        sessionId: "s1",
        kind: "task.execute",
        params: { origin: "autonomy", autonomy: { origin: "autonomy" } },
        dedupeKey: `baseline-proof:${suffix}`,
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(jobs.claim(`worker-baseline-proof-${suffix}`).job?.id).toBe(jobId);
      if (passed) {
        expect(jobs.complete(jobId, { summary: "trusted host passed" }).ok).toBe(true);
      } else {
        expect(jobs.publishBlocked(jobId, { message: "trusted host failed" }).ok).toBe(true);
      }
      sequence += 1;
      db.prepare(
        `INSERT INTO job_validation_runs (
           jobId, command, exitCode, durationMs, passed, failureClass,
           stdoutTail, stderrTail, metadataJson, createdAt
         ) VALUES (?, 'bun test tests/baseline.test.ts', ?, 100, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        jobId,
        passed ? 0 : 1,
        passed ? 1 : 0,
        passed ? null : "test_failure",
        passed ? "1 pass" : "(fail) shared baseline remains broken",
        JSON.stringify({
          source: "trusted_host",
          baselineSha,
          candidateSha: `candidate-${suffix}`,
          validationTarget,
          baselineFailureProven: validationTarget === "baseline",
          failedTests: passed ? [] : ["shared baseline remains broken"],
          targetPathHints: passed ? [] : ["tests/baseline.test.ts"],
          failureLines: passed ? [] : ["(fail) shared baseline remains broken"],
        }),
        new Date(Date.now() + sequence * 100).toISOString(),
      );
    };

    try {
      recordRun("failure-a", "baseline", false);
      recordRun("failure-b", "baseline", false);
      const red = store.createSnapshot({ sessionId: "s1", runId: "run_baseline_red" });
      expect(red.validation_incident).toMatchObject({
        validation_scope: "baseline_suspected",
        baseline_failure_proven: true,
        baseline_sha: baselineSha,
        candidate_sha: null,
      });

      recordRun("candidate-pass", "candidate", true);
      expect(
        store.createSnapshot({ sessionId: "s1", runId: "run_baseline_candidate_pass" })
          .validation_incident?.baseline_failure_proven,
      ).toBe(true);

      recordRun("baseline-pass", "baseline", true);
      expect(
        store.createSnapshot({ sessionId: "s1", runId: "run_baseline_green" }).validation_incident,
      ).toBeNull();
    } finally {
      jobs.close();
    }
  });

  test("trusted-host circuit does not combine distinct failures under one command", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-trusted-host-distinct-");
    const jobs = new JobQueue(dbPath);
    const db = (store as unknown as { db: any }).db;
    try {
      for (let i = 0; i < 2; i++) {
        const enqueued = jobs.enqueue({
          taskId: `task-distinct-${i}`,
          sessionId: "s1",
          kind: "task.execute",
          params: {},
          dedupeKey: `distinct:${i}`,
        });
        const jobId = String(enqueued.jobId ?? "");
        expect(jobs.claim(`worker-distinct-${i}`).job?.id).toBe(jobId);
        expect(jobs.publishBlocked(jobId, { message: "trusted validation failed" }).ok).toBe(true);
        db.prepare(
          `INSERT INTO job_validation_runs (
             jobId, command, exitCode, durationMs, passed, failureClass,
             stdoutTail, stderrTail, metadataJson, createdAt
           ) VALUES (?, 'bun run validate', 1, 100, 0, 'test_failure', ?, NULL, ?, ?)`,
        ).run(
          jobId,
          `(fail) distinct failed test ${i}`,
          JSON.stringify({
            source: "trusted_host",
            failureFingerprint: `fingerprint-${i}`,
            failedTests: [`distinct failed test ${i}`],
            targetPathHints: [`tests/distinct-${i}.test.ts`],
          }),
          new Date(Date.now() + i).toISOString(),
        );
      }

      const snapshot = store.createSnapshot({ sessionId: "s1", runId: "run_distinct" });
      expect(snapshot.repo_health_flags.required_validation_red).toBe(false);
      expect(snapshot.validation_incident).toBeNull();
    } finally {
      jobs.close();
    }
  });

  test("a later pass wins when validation rows share the same timestamp", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-validation-order-");
    const jobs = new JobQueue(dbPath);
    try {
      const enqueued = jobs.enqueue({
        taskId: "task-validation-order",
        sessionId: "s1",
        kind: "task.execute",
        params: {},
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(jobs.claim("worker-validation-order").job?.id).toBe(jobId);
      expect(
        jobs.fail(jobId, {
          message: "validation recovered on retry",
          diagnostics: {
            validationRuns: [
              {
                command: "bun test",
                passed: false,
                exitCode: 1,
                failureClass: "test_failure",
                stderrTail: "tests/order.test.ts failed",
              },
              {
                command: "bun test",
                passed: true,
                exitCode: 0,
                stdoutTail: "all tests passed",
              },
            ],
          },
        }).ok,
      ).toBe(true);

      const snapshot = store.createSnapshot({ sessionId: "s1", runId: "run_order" });
      expect(snapshot.repo_health_flags.required_validation_red).toBe(false);
      expect(snapshot.validation_incident).toBeNull();
    } finally {
      jobs.close();
    }
  });

  test("createSnapshot derives component strength traits from outcomes", () => {
    const store = makeStore();
    const sessionId = "s1";
    const runId = "run_component_traits";
    const snapshotId = store.createSnapshot({ sessionId, runId }).snapshot_id;

    for (let i = 0; i < 2; i++) {
      const objectiveId = `obj_component_${i + 1}`;
      const decision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: objectiveId,
          title: `Component trait seed ${i + 1}`,
          instruction: "Seed outcome for component area strength trait",
          objective_type: "lint_fix",
          component_area: "apps/client",
          trigger_type: "lint_failure",
          target_paths: ["apps/client/src/app.tsx"],
          scope: { read_anywhere: false, write_globs: ["apps/client/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run lint"],
          status: "rejected",
        },
      });
      expect(decision.ok).toBe(true);
      const outcome = store.recordOutcome({
        objectiveId,
        patternKey: decision.patternKey,
        success: true,
        userAction: "manual_fix",
      });
      expect(outcome.ok).toBe(true);
    }

    const enriched = store.createSnapshot({ sessionId, runId });
    expect(
      enriched.state_traits.some((trait) => trait.trait_id === "component_strong_apps/client"),
    ).toBe(true);
  });

  test("createSnapshot emits execution-health signals for stalled, blocked, and failing autonomy work", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-execution-health-");
    const jobQueue = new JobQueue(dbPath);
    const sessionId = "s1";
    const runId = "run_execution_health";
    const snapshotId = store.createSnapshot({ sessionId, runId }).snapshot_id;

    try {
      const stalledDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_stalled",
          title: "Stalled objective",
          instruction: "Seed stalled objective telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "queue_health",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "running",
        },
      });
      expect(stalledDecision.ok).toBe(true);

      const blockedDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_blocked",
          title: "Blocked objective",
          instruction: "Seed blocked objective telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "regret_signal",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "blocked",
        },
      });
      expect(blockedDecision.ok).toBe(true);

      const failedDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_failed",
          title: "Failed objective",
          instruction: "Seed failed objective telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "lint_failure",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "rejected",
        },
      });
      expect(failedDecision.ok).toBe(true);
      expect(
        store.recordOutcome({
          objectiveId: "obj_failed",
          patternKey: failedDecision.patternKey,
          success: false,
          userAction: "no_change",
          regressionFlag: true,
        }).ok,
      ).toBe(true);

      const staleJobId = String(
        jobQueue.enqueue({
          taskId: "task_worker_stale",
          sessionId,
          kind: "task.execute",
          params: {},
          priority: "background",
        }).jobId ?? "",
      );
      expect(staleJobId.length).toBeGreaterThan(0);
      expect(jobQueue.claim("workerpal-a").ok).toBe(true);
      expect(
        jobQueue.fail(staleJobId, {
          message: "Job auto-failed after stale worker claim",
          detail: "worker=workerpal-a; lastHeartbeat=2026-03-29T22:36:28.894Z",
        }).ok,
      ).toBe(true);
      const staleWorkerDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_worker_stale",
          title: "Worker stale claim objective",
          instruction: "Seed worker stale claim telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "queue_health",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "failed",
          job_id: staleJobId,
        },
      });
      expect(staleWorkerDecision.ok).toBe(true);

      const softPassJobId = String(
        jobQueue.enqueue({
          taskId: "task_quality_softpass",
          sessionId,
          kind: "task.execute",
          params: {},
          priority: "background",
        }).jobId ?? "",
      );
      expect(softPassJobId.length).toBeGreaterThan(0);
      expect(jobQueue.claim("workerpal-b").ok).toBe(true);
      expect(
        jobQueue.complete(softPassJobId, {
          summary:
            "Executed task and modified 1 file(s) (quality gate soft-pass after 1 auto-revision attempt(s)).",
          artifacts: [],
        }).ok,
      ).toBe(true);
      const softPassDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_quality_softpass",
          title: "Quality gate soft-pass objective",
          instruction: "Seed quality gate soft-pass telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "lint_failure",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "completed",
          job_id: softPassJobId,
        },
      });
      expect(softPassDecision.ok).toBe(true);

      const failedRevisionJobId = String(
        jobQueue.enqueue({
          taskId: "task_quality_failed",
          sessionId,
          kind: "task.execute",
          params: {},
          priority: "background",
        }).jobId ?? "",
      );
      expect(failedRevisionJobId.length).toBeGreaterThan(0);
      expect(jobQueue.claim("workerpal-c").ok).toBe(true);
      expect(
        jobQueue.fail(failedRevisionJobId, {
          message:
            "Quality gate failed after 1 auto-revision attempt(s): Critic score 2.0 is below required threshold 8.",
          detail: "[QualityGate] Codex critic score: 2/10",
        }).ok,
      ).toBe(true);
      const failedRevisionDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_quality_failed",
          title: "Quality gate failed objective",
          instruction: "Seed quality gate failure telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "lint_failure",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "failed",
          job_id: failedRevisionJobId,
        },
      });
      expect(failedRevisionDecision.ok).toBe(true);

      (store as any).db
        .prepare(
          `UPDATE autonomy_objectives
           SET updated_at = datetime('now', '-90 minutes')
           WHERE id IN ('obj_stalled', 'obj_blocked')`,
        )
        .run();

      const snapshot = store.createSnapshot({ sessionId, runId });

      expect(
        snapshot.top_signals.some(
          (signal) => signal.signal_id === "sig_objective_stall" && signal.type === "queue_health",
        ),
      ).toBe(true);
      expect(
        snapshot.top_signals.some(
          (signal) =>
            signal.signal_id === "sig_objective_blocked" && signal.type === "regret_signal",
        ),
      ).toBe(true);
      expect(
        snapshot.top_signals.some(
          (signal) =>
            signal.signal_id.startsWith("sig_objective_failure_") && signal.type === "lint_failure",
        ),
      ).toBe(true);
      expect(
        snapshot.top_signals.some(
          (signal) =>
            signal.signal_id === "sig_worker_stale_claims" && signal.type === "queue_health",
        ),
      ).toBe(true);
      expect(
        snapshot.top_signals.some(
          (signal) =>
            signal.signal_id === "sig_quality_revision_churn" && signal.type === "regret_signal",
        ),
      ).toBe(true);
      expect(
        snapshot.state_traits.some((trait) => trait.trait_id === "open_objectives_stalled"),
      ).toBe(true);
      expect(
        snapshot.state_traits.some((trait) => trait.trait_id === "blocked_objectives_waiting"),
      ).toBe(true);
      expect(
        snapshot.state_traits.some((trait) => trait.trait_id === "worker_stale_claim_pressure"),
      ).toBe(true);
      expect(
        snapshot.state_traits.some((trait) => trait.trait_id === "quality_revision_churn"),
      ).toBe(true);
    } finally {
      jobQueue.close();
      closeTrackedStore(store);
    }
  });

  test("rejects objective risk above policy ceiling", () => {
    const store = makeStore();
    store.createSnapshot({ sessionId: "s1" });

    const result = store.recordObjectiveDecision({
      runId: "run_1",
      snapshotId: store.createSnapshot({ sessionId: "s1" }).snapshot_id,
      sessionId: "s1",
      objective: {
        id: "obj_1",
        title: "Too risky flaky test objective",
        instruction: "Fix flaky test",
        objective_type: "flaky_test",
        component_area: "tests/integration",
        trigger_type: "test_failure",
        target_paths: ["tests/integration/test_workerpals_e2e.py"],
        scope: { read_anywhere: false, write_globs: ["tests/integration/*.py"] },
        confidence: 0.8,
        risk_level: "high",
        status: "dispatched",
      },
    });

    expect(result.ok).toBe(false);
    expect(String(result.reason ?? "")).toContain("exceeds policy");
  });

  test("rejects non-autonomous feature_large objectives", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1" }).snapshot_id;

    const result = store.recordObjectiveDecision({
      runId: "run_feature_large_block",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_feature_large",
        title: "Build broad feature autonomously",
        instruction: "Implement a large feature touching many areas.",
        objective_type: "feature_large",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "medium",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });

    expect(result.ok).toBe(false);
    expect(String(result.reason ?? "")).toContain("autonomous_allowed");
  });

  test("applies read_anywhere policy gate based on config allowlist", () => {
    const store = makeStore();
    const allowReadAnywhere =
      (
        store as unknown as {
          config?: { remotebuddy?: { autonomy?: { allowReadAnywhere?: boolean } } };
        }
      ).config?.remotebuddy?.autonomy?.allowReadAnywhere ?? false;
    const snapshotId = store.createSnapshot({ sessionId: "s1" }).snapshot_id;

    const result = store.recordObjectiveDecision({
      runId: "run_2",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_2",
        title: "Invalid broad read",
        instruction: "Do scoped lint fix",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: true, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.8,
        risk_level: "low",
        expected_validation: ["bun test tests/server.requests-queue.test.ts"],
        status: "dispatched",
      },
    });

    expect(result.ok).toBe(allowReadAnywhere);
    if (!allowReadAnywhere) {
      expect(String(result.reason ?? "")).toContain("read_anywhere");
    }
  });

  test("accepts broad repo scope hints without treating them as write permissions", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1" }).snapshot_id;

    const result = store.recordObjectiveDecision({
      runId: "run_broad_hints",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_broad_hints",
        title: "Improve repo behavior across owning files",
        instruction: "Use the target paths as starting points and edit the owning files.",
        objective_type: "small_refactor",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
        scope: { read_anywhere: true, write_globs: ["**/*"] },
        confidence: 0.8,
        risk_level: "medium",
        expected_validation: ["bun run test:root"],
        status: "dispatched",
      },
    });

    expect(result.ok).toBe(true);
  });

  test("dispatch lock is visible only to other runs", () => {
    const store = makeStore();
    const acquired = store.acquireDispatchLock({ sessionId: "s1", runId: "run_1", ttlMs: 60_000 });
    expect(acquired.ok).toBe(true);

    const ownSnapshot = store.createSnapshot({ sessionId: "s1", runId: "run_1" });
    expect(ownSnapshot.repo_health_flags.dispatch_lock_held).toBe(false);

    const otherSnapshot = store.createSnapshot({ sessionId: "s1", runId: "run_2" });
    expect(otherSnapshot.repo_health_flags.dispatch_lock_held).toBe(true);

    const released = store.releaseDispatchLock({ sessionId: "s1", runId: "run_1" });
    expect(released.ok).toBe(true);
    expect(released.released).toBe(true);

    const postReleaseSnapshot = store.createSnapshot({ sessionId: "s1", runId: "run_2" });
    expect(postReleaseSnapshot.repo_health_flags.dispatch_lock_held).toBe(false);
  });

  test("renewDispatchLock extends lock for the same owner", () => {
    const store = makeStore();
    const acquired = store.acquireDispatchLock({ sessionId: "s1", runId: "run_1", ttlMs: 30_000 });
    expect(acquired.ok).toBe(true);
    const firstUntil = String(acquired.lockUntil ?? "");
    expect(firstUntil.length).toBeGreaterThan(0);

    const renewed = store.renewDispatchLock({ sessionId: "s1", runId: "run_1", ttlMs: 90_000 });
    expect(renewed.ok).toBe(true);
    const renewedUntil = String(renewed.lockUntil ?? "");
    expect(renewedUntil.length).toBeGreaterThan(0);
    expect(Date.parse(renewedUntil)).toBeGreaterThan(Date.parse(firstUntil));
  });

  test("acquireDispatchLock can replace a stale same-session owner", () => {
    const store = makeStore();
    const acquired = store.acquireDispatchLock({ sessionId: "s1", runId: "run_1", ttlMs: 900_000 });
    expect(acquired.ok).toBe(true);

    const db = (store as unknown as { db: any }).db;
    db.prepare(
      `UPDATE autonomy_dispatch_lock
       SET updated_at = ?
       WHERE lock_id = 'autonomy_dispatch'`,
    ).run(new Date(Date.now() - 300_000).toISOString());

    const replaced = store.acquireDispatchLock({
      sessionId: "s1",
      runId: "run_2",
      ttlMs: 60_000,
      staleAfterMs: 120_000,
    });
    expect(replaced.ok).toBe(true);
    expect(replaced.replacedStale).toBe(true);

    const ownSnapshot = store.createSnapshot({ sessionId: "s1", runId: "run_2" });
    expect(ownSnapshot.repo_health_flags.dispatch_lock_held).toBe(false);
  });

  test("acquireDispatchLock does not replace fresh or cross-session owners", () => {
    const store = makeStore();
    const acquired = store.acquireDispatchLock({ sessionId: "s1", runId: "run_1", ttlMs: 900_000 });
    expect(acquired.ok).toBe(true);

    const freshSameSession = store.acquireDispatchLock({
      sessionId: "s1",
      runId: "run_2",
      ttlMs: 60_000,
      staleAfterMs: 120_000,
    });
    expect(freshSameSession.ok).toBe(false);

    const db = (store as unknown as { db: any }).db;
    db.prepare(
      `UPDATE autonomy_dispatch_lock
       SET updated_at = ?
       WHERE lock_id = 'autonomy_dispatch'`,
    ).run(new Date(Date.now() - 300_000).toISOString());

    const staleDifferentSession = store.acquireDispatchLock({
      sessionId: "s2",
      runId: "run_3",
      ttlMs: 60_000,
      staleAfterMs: 120_000,
    });
    expect(staleDifferentSession.ok).toBe(false);
  });

  test("rejects invalid objective enums before persistence", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1" }).snapshot_id;

    const invalidObjectiveType = store.recordObjectiveDecision({
      runId: "run_invalid_type",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_invalid_type",
        title: "Invalid objective type",
        instruction: "noop",
        objective_type: "bad_type",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.8,
        risk_level: "low",
        expected_validation: ["bun test tests/server.autonomy-store.test.ts"],
        status: "rejected",
      },
    });
    expect(invalidObjectiveType.ok).toBe(false);
    expect(String(invalidObjectiveType.reason ?? "")).toContain("invalid objective_type");

    const invalidTriggerType = store.recordObjectiveDecision({
      runId: "run_invalid_trigger",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_invalid_trigger",
        title: "Invalid trigger type",
        instruction: "noop",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "bad_trigger",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.8,
        risk_level: "low",
        expected_validation: ["bun test tests/server.autonomy-store.test.ts"],
        status: "rejected",
      },
    });
    expect(invalidTriggerType.ok).toBe(false);
    expect(String(invalidTriggerType.reason ?? "")).toContain("invalid trigger_type");
  });

  test("evaluateEligibility returns canonical server-side gate decisions", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_elig",
      repoHealthFlags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const result = store.evaluateEligibility({
      runId: "run_elig",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_low_conf",
          objective_type: "lint_fix",
          pattern_key: "pk_lint_fix",
          confidence: 0.1,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.results?.length).toBe(1);
    expect(result.results?.[0]?.ok).toBe(false);
    expect(String(result.results?.[0]?.reason ?? "")).toContain("confidence");
  });

  test("evaluateEligibility reserves normalized target paths across pattern variations", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_target_reservation",
      repoHealthFlags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
      },
    }).snapshot_id;
    const reserved = store.recordObjectiveDecision({
      runId: "run_target_reservation",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_target_reservation",
        title: "Reserve autonomy target",
        instruction: "Keep this target reserved until its worker completes.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps\\server\\src\\autonomy.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun test tests/server.autonomy-store.test.ts"],
        status: "gated",
      },
    });
    expect(reserved.ok).toBe(true);

    const result = store.evaluateEligibility({
      runId: "run_target_reservation",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_same_target_new_prompt",
          objective_type: "type_fix",
          component_area: "apps/server",
          pattern_key: "different-prompt-and-pattern",
          confidence: 0.95,
          target_paths: ["./apps/server/src"],
        },
      ],
    });

    expect(result.results?.[0]?.ok).toBe(false);
    expect(String(result.results?.[0]?.reason ?? "")).toBe(
      "target path already has active objective",
    );
  });

  test("coalesces the same vision objective and acceptance contract across adjacent paths", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_semantic_cluster",
    }).snapshot_id;
    const active = store.recordObjectiveDecision({
      runId: "run_semantic_cluster",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_semantic_cluster",
        title: "Repair route readiness",
        instruction: "Make route readiness deterministic.",
        objective_type: "flaky_test",
        component_area: "src/routes",
        trigger_type: "test_failure",
        target_paths: ["src/routes/alpha.ts"],
        scope: { read_anywhere: false, write_globs: ["src/routes/alpha.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun test"],
        vision_objective_id: "vision:route-readiness",
        acceptance_criteria: ["Route src/routes/alpha.ts becomes ready after 2 retries"],
        status: "proposed",
      },
    });
    expect(active.ok).toBe(true);

    const duplicate = store.evaluateEligibility({
      runId: "run_semantic_cluster",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_semantic_cluster_adjacent",
          objective_type: "flaky_test",
          component_area: "src/routes",
          pattern_key: "prompt-variation-that-must-not-escape",
          target_paths: ["src/routes/beta.ts"],
          vision_objective_id: "vision:route-readiness",
          acceptance_criteria: ["Route src/routes/beta.ts becomes ready after 5 retries"],
          confidence: 0.95,
        },
      ],
    });
    expect(duplicate.results?.[0]).toMatchObject({ ok: false });
    expect(String(duplicate.results?.[0]?.reason ?? "")).toBe(
      "pattern already has active objective",
    );

    const differentFamily = store.evaluateEligibility({
      runId: "run_semantic_cluster",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_semantic_cluster_other_family",
          objective_type: "flaky_test",
          component_area: "src/workers",
          target_paths: ["src/workers/beta.ts"],
          vision_objective_id: "vision:route-readiness",
          acceptance_criteria: ["Route src/workers/beta.ts becomes ready after 5 retries"],
          confidence: 0.95,
        },
      ],
    });
    expect(differentFamily.results?.[0]).toMatchObject({ ok: true });
  });

  test("normalizes Unicode cluster identity and honors explicit parent lineage", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_unicode_cluster",
    }).snapshot_id;
    const active = store.recordObjectiveDecision({
      runId: "run_unicode_cluster",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_unicode_cluster",
        title: "Repair résumé export",
        instruction: "Keep résumé export deterministic.",
        objective_type: "flaky_test",
        component_area: "src/export",
        trigger_type: "test_failure",
        target_paths: ["src/export/resume.ts"],
        scope: { read_anywhere: false, write_globs: ["src/export/resume.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun test"],
        vision_objective_id: "vision:re\u0301sume\u0301-export",
        acceptance_criteria: ["The re\u0301sume\u0301 export stays stable"],
        root_objective_id: "root:re\u0301sume\u0301",
        status: "proposed",
      },
    });
    expect(active.ok).toBe(true);

    const duplicate = store.evaluateEligibility({
      runId: "run_unicode_cluster",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_unicode_cluster",
          objective_type: "flaky_test",
          component_area: "tests/export",
          target_paths: ["tests/export/resume.test.ts"],
          vision_objective_id: "vision:résumé-export",
          acceptance_criteria: ["The résumé export stays stable"],
          root_objective_id: "root:résumé",
          confidence: 0.95,
        },
      ],
    });
    expect(duplicate.results?.[0]).toMatchObject({ ok: false });
    expect(String(duplicate.results?.[0]?.reason ?? "")).toBe(
      "pattern already has active objective",
    );
  });

  test("preserves digits in stable objective identifiers while abstracting prose numbers", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_numeric_objective_ids",
    }).snapshot_id;
    expect(
      store.recordObjectiveDecision({
        runId: "run_numeric_objective_ids",
        snapshotId,
        sessionId: "s1",
        objective: {
          id: "obj_numeric_objective_1",
          title: "Repair route generation 1",
          instruction: "Stabilize route after 2 retries.",
          objective_type: "flaky_test",
          component_area: "src/routes",
          trigger_type: "test_failure",
          target_paths: ["src/routes/alpha.ts"],
          scope: { read_anywhere: false, write_globs: ["src/routes/alpha.ts"] },
          confidence: 0.95,
          risk_level: "low",
          expected_validation: ["bun test"],
          vision_objective_id: "vision:route-readiness-v1",
          acceptance_criteria: ["Route becomes ready after 2 retries"],
          status: "proposed",
        },
      }).ok,
    ).toBe(true);

    const differentStableId = store.evaluateEligibility({
      runId: "run_numeric_objective_ids",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_numeric_objective_2",
          objective_type: "flaky_test",
          component_area: "src/routes",
          target_paths: ["src/routes/beta.ts"],
          vision_objective_id: "vision:route-readiness-v2",
          acceptance_criteria: ["Route becomes ready after 5 retries"],
          confidence: 0.95,
        },
      ],
    });
    expect(differentStableId.results?.[0]).toMatchObject({ ok: true });
  });

  test("blocks PushPals-internal autonomy ideas from user-repo targets", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_meta_leak",
      repoHealthFlags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const result = store.evaluateEligibility({
      runId: "run_meta_leak",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_queue_health_leak",
          objective_type: "small_refactor",
          component_area: "app",
          pattern_key: "queue_health_contract",
          title: "Add queue_health readability contract",
          instruction: "Expose WorkerPal queue_health diagnostics in the app layout tests.",
          target_paths: ["app/__tests__/_layout.autonomy.test.ts"],
          scope: { read_anywhere: true, write_globs: ["app/**"] },
          confidence: 0.95,
        },
        {
          candidate_id: "cand_pushpals_runtime",
          objective_type: "small_refactor",
          component_area: "apps/workerpals",
          pattern_key: "workerpal_queue_health_runtime",
          title: "Add WorkerPal queue health coverage",
          instruction: "Strengthen WorkerPal queue health tests in PushPals runtime code.",
          target_paths: ["apps/workerpals/src/execute_job.ts"],
          scope: { read_anywhere: true, write_globs: ["apps/workerpals/**"] },
          confidence: 0.95,
        },
        {
          candidate_id: "cand_generic_queue_product",
          objective_type: "small_refactor",
          component_area: "apps/server",
          pattern_key: "queue_health_contract",
          title: "Improve queue health reporting",
          instruction: "Make the product's durable message queue health easier to inspect.",
          target_paths: ["apps/server/src/queue.ts"],
          scope: { read_anywhere: true, write_globs: ["apps/server/src/**"] },
          confidence: 0.95,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results?.[0]).toMatchObject({
      candidate_id: "cand_queue_health_leak",
      ok: false,
    });
    expect(String(result.results?.[0]?.reason ?? "")).toContain("PushPals-internal");
    expect(result.results?.[1]).toMatchObject({
      candidate_id: "cand_pushpals_runtime",
      ok: true,
    });
    expect(result.results?.[2]).toMatchObject({
      candidate_id: "cand_generic_queue_product",
      ok: true,
    });

    const directDecision = store.recordObjectiveDecision({
      runId: "run_meta_leak",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_queue_health_leak",
        title: "Add queue_health readability contract",
        instruction: "Expose WorkerPal queue_health diagnostics in the app layout tests.",
        objective_type: "small_refactor",
        component_area: "app",
        trigger_type: "test_failure",
        target_paths: ["app/__tests__/_layout.autonomy.test.ts"],
        scope: { read_anywhere: true, write_globs: ["app/**"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun test"],
        status: "proposed",
      },
    });
    expect(directDecision.ok).toBe(false);
    expect(String(directDecision.reason ?? "")).toContain("PushPals-internal");
  });

  test("evaluateEligibility suppresses dispatch when same pattern succeeded within 24h", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_recent_exact",
      repoHealthFlags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const seeded = store.recordObjectiveDecision({
      runId: "run_recent_exact",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_recent_exact",
        candidate_id: "cand_recent_exact",
        title: "Seed exact pattern success",
        instruction: "Apply a stable lint fix",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "rejected",
      },
    });
    expect(seeded.ok).toBe(true);
    expect(typeof seeded.patternKey).toBe("string");

    const seededOutcome = store.recordOutcome({
      objectiveId: "obj_recent_exact",
      patternKey: seeded.patternKey,
      success: true,
      userAction: "applied",
    });
    expect(seededOutcome.ok).toBe(true);

    const result = store.evaluateEligibility({
      runId: "run_recent_exact",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_again_exact",
          objective_type: "lint_fix",
          component_area: "apps/server",
          pattern_key: seeded.patternKey,
          confidence: 0.95,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results?.[0]?.ok).toBe(false);
    expect(String(result.results?.[0]?.reason ?? "")).toContain(
      "recent_success_same_pattern_within_24h",
    );

    const spoofedRepair = store.evaluateEligibility({
      runId: "run_recent_exact",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_spoofed_repair",
          objective_type: "lint_fix",
          component_area: "apps/server",
          pattern_key: seeded.patternKey,
          confidence: 0.95,
          required_validation_repair: true,
        },
      ],
    });
    expect(spoofedRepair.results?.[0]?.ok).toBe(false);
    expect(String(spoofedRepair.results?.[0]?.reason ?? "")).toContain(
      "recent_success_same_pattern_within_24h",
    );
  });

  test("required validation repair bypasses only pattern suppression while an incident is active", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-required-repair-");
    const jobs = new JobQueue(dbPath);
    try {
      for (let index = 1; index <= 2; index += 1) {
        const enqueued = jobs.enqueue({
          taskId: `task-required-repair-${index}`,
          sessionId: "s1",
          kind: "task.execute",
          params: {},
          dedupeKey: `required-repair:${index}`,
        });
        const jobId = String(enqueued.jobId ?? "");
        expect(jobs.claim(`worker-required-repair-${index}`).job?.id).toBe(jobId);
        expect(
          jobs.fail(jobId, {
            message: "required validation failed in distinct jobs",
            diagnostics: {
              validationRuns: [
                {
                  attempt: 1,
                  command: "bun test",
                  passed: false,
                  exitCode: 1,
                  failureClass: "test_failure",
                  stderrTail: "tests/baseline.test.ts failed",
                },
              ],
            },
          }).ok,
        ).toBe(true);
      }
      const repairSnapshot = store.createSnapshot({
        sessionId: "s1",
        runId: "run_required_repair",
      });
      const snapshotId = repairSnapshot.snapshot_id;
      const incidentId = String(repairSnapshot.validation_incident?.incident_id ?? "");
      expect(incidentId).not.toBe("");
      const seeded = store.recordObjectiveDecision({
        runId: "run_required_repair",
        snapshotId,
        sessionId: "s1",
        objective: {
          id: "obj_required_repair_seed",
          title: "Seed prior success",
          instruction: "Repair baseline test",
          objective_type: "flaky_test",
          component_area: "tests",
          trigger_type: "test_failure",
          target_paths: ["tests/baseline.test.ts"],
          scope: { read_anywhere: false, write_globs: ["tests/baseline.test.ts"] },
          confidence: 0.95,
          risk_level: "low",
          expected_validation: ["bun test"],
          status: "rejected",
        },
      });
      expect(seeded.ok).toBe(true);
      expect(
        store.recordOutcome({
          objectiveId: "obj_required_repair_seed",
          patternKey: seeded.patternKey,
          success: true,
          userAction: "applied",
        }).ok,
      ).toBe(true);

      const activeDifferentPattern = store.recordObjectiveDecision({
        runId: "run_required_repair",
        snapshotId,
        sessionId: "s1",
        objective: {
          id: "obj_required_repair_active_target",
          title: "Active work on required validation target",
          instruction: "Keep unrelated active work visible to the target reservation gate.",
          objective_type: "small_refactor",
          component_area: "tests",
          trigger_type: "queue_health",
          target_paths: ["tests/baseline.test.ts"],
          scope: { read_anywhere: false, write_globs: ["tests/baseline.test.ts"] },
          confidence: 0.95,
          risk_level: "low",
          expected_validation: ["bun test"],
          status: "proposed",
        },
      });
      expect(activeDifferentPattern.ok).toBe(true);
      (store as any).db
        .prepare("UPDATE autonomy_objectives SET pattern_key = ? WHERE id = ?")
        .run(seeded.patternKey, "obj_required_repair_active_target");

      const allowed = store.evaluateEligibility({
        runId: "run_required_repair",
        snapshotId,
        candidates: [
          {
            candidate_id: "cand_required_repair",
            objective_type: "flaky_test",
            component_area: "tests",
            pattern_key: seeded.patternKey,
            confidence: 0.95,
            required_validation_repair: true,
          },
        ],
      });
      expect(allowed.results?.[0]).toMatchObject({
        candidate_id: "cand_required_repair",
        ok: true,
      });
      expect(
        store.recordOutcome({
          objectiveId: "obj_required_repair_active_target",
          patternKey: activeDifferentPattern.patternKey,
          success: true,
          userAction: "applied",
        }).ok,
      ).toBe(true);

      const dispatched = store.recordObjectiveDecision({
        runId: "run_required_repair",
        snapshotId,
        sessionId: "s1",
        objective: {
          id: "obj_required_repair",
          title: "Repair required validation",
          instruction: "Fix and rerun bun test",
          objective_type: "flaky_test",
          component_area: "tests",
          trigger_type: "test_failure",
          target_paths: ["tests/baseline.test.ts"],
          scope: { read_anywhere: false, write_globs: ["tests/baseline.test.ts"] },
          confidence: 0.95,
          risk_level: "low",
          expected_validation: ["bun test"],
          status: "dispatched",
          required_validation_repair: true,
          incident_key: incidentId,
          evidence: { validation_incident: repairSnapshot.validation_incident },
        },
      });
      expect(dispatched.ok).toBe(true);
      expect(
        store.authorizesValidationIncidentRepair({
          objectiveId: "obj_required_repair",
          incidentId,
          snapshotId,
        }),
      ).toBe(true);
      expect(
        store.authorizesValidationIncidentRepair({
          objectiveId: "obj_required_repair",
          incidentId: "valid_inc_spoofed",
          snapshotId,
        }),
      ).toBe(false);
      (store as any).db
        .prepare("UPDATE autonomy_objectives SET evidence_json = '{}' WHERE id = ?")
        .run("obj_required_repair");
      expect(
        store.authorizesValidationIncidentRepair({
          objectiveId: "obj_required_repair",
          incidentId,
          snapshotId,
        }),
      ).toBe(false);

      store.updateSafetyState({
        freezeForMs: 60_000,
        freezeReason: "test_required_repair_safety",
      });
      const recoveryDuringFreeze = store.evaluateEligibility({
        runId: "run_required_repair",
        snapshotId,
        candidates: [
          {
            candidate_id: "cand_required_repair_frozen",
            objective_type: "flaky_test",
            component_area: "tests",
            pattern_key: "pk_required_repair_freeze_probe",
            confidence: 0.95,
            required_validation_repair: true,
            work_class: "recovery",
          },
        ],
      });
      expect(recoveryDuringFreeze.results?.[0]).toMatchObject({
        candidate_id: "cand_required_repair_frozen",
        ok: true,
      });
    } finally {
      jobs.close();
    }
  });

  test("caller recovery labels cannot bypass an autonomy freeze", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_spoofed_frozen_recovery",
    }).snapshot_id;
    store.updateSafetyState({
      freezeForMs: 60_000,
      freezeReason: "test_spoofed_recovery",
    });
    const result = store.evaluateEligibility({
      runId: "run_spoofed_frozen_recovery",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_spoofed_frozen_recovery",
          objective_type: "small_refactor",
          component_area: "src",
          target_paths: ["src/file.ts"],
          confidence: 0.95,
          work_class: "recovery",
          lifecycle_recovery: true,
        },
      ],
    });
    expect(result.results?.[0]).toMatchObject({ ok: false });
    expect(String(result.results?.[0]?.reason ?? "")).toContain("autonomy frozen until");
  });

  test("validates and reconciles durable gated objective reservations", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-reservation-");
    const queue = new RequestQueue(dbPath);
    try {
      const snapshotId = store.createSnapshot({
        sessionId: "s_reservation",
        runId: "run_reservation",
        repoHealthFlags: {
          is_worktree_dirty: false,
          is_merge_in_progress: false,
        },
      }).snapshot_id;
      const gated = store.recordObjectiveDecision({
        runId: "run_reservation",
        snapshotId,
        sessionId: "s_reservation",
        objective: {
          id: "obj_reservation",
          title: "Durably reserve an objective",
          instruction: "Persist the objective before enqueueing its request.",
          objective_type: "small_refactor",
          component_area: "apps/server",
          trigger_type: "queue_health",
          target_paths: ["apps/server/src/requests.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
          confidence: 0.95,
          risk_level: "low",
          expected_validation: ["bun test tests/server.requests-queue.test.ts"],
          status: "gated",
        },
      });
      expect(gated.ok).toBe(true);
      expect(
        store.validateObjectiveReservation({
          objectiveId: "obj_reservation",
          sessionId: "s_reservation",
          runId: "run_reservation",
          snapshotId,
        }),
      ).toEqual({ ok: true });
      expect(
        store.validateObjectiveReservation({
          objectiveId: "obj_reservation",
          sessionId: "wrong-session",
          runId: "run_reservation",
          snapshotId,
        }),
      ).toMatchObject({ ok: false, reason: "autonomy objective reservation identity mismatch" });

      const request = queue.enqueue({
        sessionId: "s_reservation",
        prompt: "Run the reserved objective",
        idempotencyKey: "autonomy:obj_reservation",
      });
      expect(request.ok).toBe(true);
      const linked = store.reconcileGatedObjectiveReservations();
      expect(linked).toEqual({ linked: 1, failed: 0 });
      expect(autonomyObjectiveStatus(store, "obj_reservation")).toBe("dispatched");

      const orphan = store.recordObjectiveDecision({
        runId: "run_reservation",
        snapshotId,
        sessionId: "s_reservation",
        objective: {
          id: "obj_orphan_reservation",
          title: "Orphaned reservation",
          instruction: "Exercise startup reconciliation of a stale reservation.",
          objective_type: "docs",
          component_area: "docs",
          trigger_type: "regret_signal",
          target_paths: ["docs/autonomy.md"],
          scope: { read_anywhere: false, write_globs: ["docs/*.md"] },
          confidence: 0.95,
          risk_level: "low",
          expected_validation: ["bun run lint"],
          status: "gated",
        },
      });
      expect(orphan.ok).toBe(true);
      const db = (store as unknown as { db: any }).db;
      db.prepare(
        `UPDATE autonomy_objectives SET created_at = ? WHERE id = 'obj_orphan_reservation'`,
      ).run("2026-08-12T00:00:00.000Z");
      const reconciled = store.reconcileGatedObjectiveReservations(
        "2026-08-12T00:02:00.000Z",
        60_000,
      );
      expect(reconciled).toEqual({ linked: 0, failed: 1 });
      expect(autonomyObjectiveStatus(store, "obj_orphan_reservation")).toBe("failed");
    } finally {
      queue.close();
    }
  });

  test("restart reconciliation ignores provisional reservations until exact confirmation", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-provisional-restart-");
    let queue: RequestQueue | null = new RequestQueue(dbPath);
    try {
      const snapshotId = store.createSnapshot({
        sessionId: "s_provisional_restart",
        runId: "run_provisional_restart",
      }).snapshot_id;
      expect(
        store.recordObjectiveDecision({
          runId: "run_provisional_restart",
          snapshotId,
          sessionId: "s_provisional_restart",
          objective: {
            id: "obj_provisional_restart",
            title: "Fence restart reservation recovery",
            instruction: "Do not dispatch until the exact live cycle confirms.",
            objective_type: "small_refactor",
            component_area: "apps/server",
            trigger_type: "queue_health",
            target_paths: ["apps/server/src/requests.ts"],
            scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
            confidence: 0.95,
            risk_level: "low",
            expected_validation: ["bun test tests/server.requests-queue.test.ts"],
            status: "gated",
          },
        }),
      ).toMatchObject({ ok: true });
      const requestBody = {
        sessionId: "s_provisional_restart",
        prompt: "Run only after confirmation",
        idempotencyKey: "autonomy:obj_provisional_restart",
        dispatchConfirmationRequired: true,
        dispatchConfirmationTtlMs: 1_000,
      };
      const provisional = queue.enqueue(requestBody);
      const requestId = String(provisional.requestId ?? "");
      const expiredAt = new Date(Date.parse(provisional.dispatchConfirmationExpiresAt!) + 1);
      queue.close();

      queue = new RequestQueue(dbPath);
      expect(store.reconcileGatedObjectiveReservations()).toEqual({ linked: 0, failed: 0 });
      expect(autonomyObjectiveStatus(store, "obj_provisional_restart")).toBe("gated");
      expect(queue.expireUnconfirmedDispatches(expiredAt)).toMatchObject({ expired: 1 });
      expect(store.reconcileGatedObjectiveReservations(expiredAt.toISOString(), 60_000)).toEqual({
        linked: 0,
        failed: 0,
      });
      expect(autonomyObjectiveStatus(store, "obj_provisional_restart")).toBe("gated");

      const retry = queue.enqueue({
        ...requestBody,
        dispatchConfirmationTtlMs: 30_000,
        dispatchConfirmationDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
      });
      const confirmationToken = String(retry.dispatchConfirmationToken ?? "");
      expect(retry).toMatchObject({
        ok: true,
        requestId,
        requeued: true,
        dispatchConfirmationRequired: true,
      });
      expect(store.reconcileGatedObjectiveReservations()).toEqual({ linked: 0, failed: 0 });
      expect(queue.confirmDispatch(requestId, confirmationToken)).toMatchObject({
        ok: true,
        confirmed: true,
      });
      expect(store.reconcileGatedObjectiveReservations()).toEqual({ linked: 1, failed: 0 });
      expect(autonomyObjectiveStatus(store, "obj_provisional_restart")).toBe("dispatched");
    } finally {
      queue?.close();
    }
  });

  test("evaluateEligibility suppresses near-same docs candidate in same component after recent success", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_recent_docs_near",
      repoHealthFlags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const seeded = store.recordObjectiveDecision({
      runId: "run_recent_docs_near",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_recent_docs",
        candidate_id: "cand_recent_docs",
        title: "Seed docs success",
        instruction: "Refresh docs guidance",
        objective_type: "docs",
        component_area: "apps/remotebuddy",
        trigger_type: "queue_health",
        target_paths: ["apps/remotebuddy/docs/queue.md"],
        scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/docs/*.md"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "rejected",
      },
    });
    expect(seeded.ok).toBe(true);

    const seededOutcome = store.recordOutcome({
      objectiveId: "obj_recent_docs",
      patternKey: seeded.patternKey,
      success: true,
      userAction: "applied",
    });
    expect(seededOutcome.ok).toBe(true);

    const result = store.evaluateEligibility({
      runId: "run_recent_docs_near",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_docs_again",
          objective_type: "docs",
          component_area: "apps/remotebuddy",
          pattern_key: "pk_docs_other_scope",
          confidence: 0.95,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results?.[0]?.ok).toBe(false);
    expect(String(result.results?.[0]?.reason ?? "")).toContain(
      "recent_success_near_pattern_within_24h",
    );
  });

  test("evaluateEligibility allows dirty worktree when allowDirtyWorktree is enabled", () => {
    const store = makeStore();
    (
      store as unknown as {
        config?: { remotebuddy?: { autonomy?: { allowDirtyWorktree?: boolean } } };
      }
    ).config!.remotebuddy!.autonomy!.allowDirtyWorktree = true;
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_dirty_allowed",
      repoHealthFlags: {
        is_worktree_dirty: true,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const result = store.evaluateEligibility({
      runId: "run_dirty_allowed",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_dirty_allowed",
          objective_type: "lint_fix",
          pattern_key: "pk_dirty_allowed",
          confidence: 0.95,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results?.length).toBe(1);
    expect(result.results?.[0]?.ok).toBe(true);
  });

  test("evaluateEligibility blocks dirty worktree when allowDirtyWorktree is disabled", () => {
    const store = makeStore();
    (
      store as unknown as {
        config?: { remotebuddy?: { autonomy?: { allowDirtyWorktree?: boolean } } };
      }
    ).config!.remotebuddy!.autonomy!.allowDirtyWorktree = false;

    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_dirty_blocked",
      repoHealthFlags: {
        is_worktree_dirty: true,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const result = store.evaluateEligibility({
      runId: "run_dirty_blocked",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_dirty_blocked",
          objective_type: "lint_fix",
          pattern_key: "pk_dirty_blocked",
          confidence: 0.95,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results?.length).toBe(1);
    expect(result.results?.[0]?.ok).toBe(false);
    expect(String(result.results?.[0]?.reason ?? "")).toContain("worktree is dirty");
  });

  test("evaluateEligibility applies sequential accounting for batch candidates", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_seq",
      repoHealthFlags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const candidates = Array.from({ length: 8 }).map((_, i) => ({
      candidate_id: `cand_${i + 1}`,
      objective_type: "lint_fix",
      pattern_key: `pk_seq_${i + 1}`,
      confidence: 0.95,
    }));
    const result = store.evaluateEligibility({
      runId: "run_seq",
      snapshotId,
      applySequentialAccounting: true,
      candidates,
    });
    expect(result.ok).toBe(true);
    const rejected = (result.results ?? []).filter((row) => !row.ok);
    expect(rejected.length).toBeGreaterThan(0);
    const firstRejection = String(rejected[0]?.reason ?? "");
    expect(
      firstRejection.includes("max concurrent objectives reached") ||
        firstRejection.includes("budget exceeded"),
    ).toBe(true);
  });

  test("evaluateEligibility blocks dispatch when hourly token budget is exhausted", () => {
    const store = makeStore();
    const autonomyCfg = (
      store as unknown as {
        config?: { remotebuddy?: { autonomy?: { maxTokenUsagePerHour?: number } } };
      }
    ).config?.remotebuddy?.autonomy;
    const priorLimit = autonomyCfg?.maxTokenUsagePerHour;
    if (autonomyCfg) autonomyCfg.maxTokenUsagePerHour = 10;

    try {
      const snapshotId = store.createSnapshot({
        sessionId: "s1",
        runId: "run_token_budget",
      }).snapshot_id;

      const logged = store.recordLlmUsage({
        id: "llm_token_budget_1",
        service: "workerpals",
        sessionId: "s1",
        promptTokens: 7,
        completionTokens: 5,
      });
      expect(logged.ok).toBe(true);

      const result = store.evaluateEligibility({
        runId: "run_token_budget",
        snapshotId,
        candidates: [
          {
            candidate_id: "cand_token_budget",
            objective_type: "lint_fix",
            component_area: "apps/server",
            pattern_key: "pk_token_budget",
            confidence: 0.95,
          },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.results?.[0]?.ok).toBe(false);
      expect(String(result.results?.[0]?.reason ?? "")).toContain("token budget exceeded");
    } finally {
      if (autonomyCfg && typeof priorLimit === "number")
        autonomyCfg.maxTokenUsagePerHour = priorLimit;
    }
  });

  test("default hourly autonomy resource budgets remain unlimited under heavy usage", () => {
    const store = makeStore();
    const internal = store as unknown as {
      config: {
        remotebuddy: {
          autonomy: {
            maxTokenUsagePerHour: number;
            maxRuntimeMsPerHour: number;
          };
        };
      };
      resourceBudgetSnapshot: () => {
        token_usage_last_hour: number;
        runtime_ms_last_hour: number;
        token_budget_per_hour: number;
        runtime_budget_ms_per_hour: number;
        token_budget_exhausted: boolean;
        runtime_budget_exhausted: boolean;
      };
    };

    expect(internal.config.remotebuddy.autonomy.maxTokenUsagePerHour).toBe(0);
    expect(internal.config.remotebuddy.autonomy.maxRuntimeMsPerHour).toBe(0);
    expect(
      store.recordLlmUsage({
        id: "llm_unlimited_hourly_budget",
        service: "workerpals",
        promptTokens: 900_000,
        completionTokens: 100_000,
      }).ok,
    ).toBe(true);
    expect(
      store.recordOutcome({
        objectiveId: "obj_unlimited_hourly_budget",
        requestId: "req_unlimited_hourly_budget",
        jobId: "job_unlimited_hourly_budget",
        patternKey: "pk_unlimited_hourly_budget",
        success: true,
        userAction: "applied",
        latencyMs: 7_200_000,
      }).ok,
    ).toBe(true);

    const budget = internal.resourceBudgetSnapshot();
    expect(budget.token_usage_last_hour).toBe(1_000_000);
    expect(budget.runtime_ms_last_hour).toBe(7_200_000);
    expect(budget.token_budget_per_hour).toBe(0);
    expect(budget.runtime_budget_ms_per_hour).toBe(0);
    expect(budget.token_budget_exhausted).toBe(false);
    expect(budget.runtime_budget_exhausted).toBe(false);
  });

  test("evaluateEligibility blocks dispatch when hourly runtime budget is exhausted", () => {
    const store = makeStore();
    const autonomyCfg = (
      store as unknown as {
        config?: { remotebuddy?: { autonomy?: { maxRuntimeMsPerHour?: number } } };
      }
    ).config?.remotebuddy?.autonomy;
    const priorLimit = autonomyCfg?.maxRuntimeMsPerHour;
    if (autonomyCfg) autonomyCfg.maxRuntimeMsPerHour = 1_000;

    try {
      const snapshotId = store.createSnapshot({
        sessionId: "s1",
        runId: "run_runtime_budget",
      }).snapshot_id;
      const decision = store.recordObjectiveDecision({
        runId: "run_runtime_budget",
        snapshotId,
        sessionId: "s1",
        objective: {
          id: "obj_runtime_budget_seed",
          title: "Runtime budget seed objective",
          instruction: "Seed runtime usage for budget test.",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "lint_failure",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
          confidence: 0.92,
          risk_level: "low",
          expected_validation: ["bun run lint"],
          status: "dispatched",
        },
      });
      expect(decision.ok).toBe(true);
      const outcome = store.recordOutcome({
        objectiveId: "obj_runtime_budget_seed",
        patternKey: decision.patternKey,
        success: true,
        userAction: "applied",
        latencyMs: 1_500,
      });
      expect(outcome.ok).toBe(true);

      const result = store.evaluateEligibility({
        runId: "run_runtime_budget",
        snapshotId,
        candidates: [
          {
            candidate_id: "cand_runtime_budget",
            objective_type: "lint_fix",
            component_area: "apps/server",
            pattern_key: "pk_runtime_budget",
            confidence: 0.95,
          },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.results?.[0]?.ok).toBe(false);
      expect(String(result.results?.[0]?.reason ?? "")).toContain("runtime budget exceeded");
    } finally {
      if (autonomyCfg && typeof priorLimit === "number")
        autonomyCfg.maxRuntimeMsPerHour = priorLimit;
    }
  });

  test("aggregates llm usage by service with average tokens per call", () => {
    const store = makeStore();

    expect(
      store.recordLlmUsage({
        id: "usage_local_1",
        service: "localbuddy",
        promptTokens: 120,
        completionTokens: 30,
      }).ok,
    ).toBe(true);
    expect(
      store.recordLlmUsage({
        id: "usage_local_2",
        service: "localbuddy",
        promptTokens: 80,
        completionTokens: 20,
        estimated: true,
      }).ok,
    ).toBe(true);
    expect(
      store.recordLlmUsage({
        id: "usage_remote_1",
        service: "remotebuddy",
        promptTokens: 200,
        completionTokens: 50,
      }).ok,
    ).toBe(true);

    const summary = store.getLlmUsageSummary({ windowHours: 24 });

    expect(summary.callCount).toBe(3);
    expect(summary.totalTokens).toBe(500);
    expect(summary.avgTokensPerCall).toBeCloseTo(500 / 3, 5);
    expect(summary.avgTokensPerHour).toBeCloseTo(500 / 24, 5);
    expect(summary.estimatedCallCount).toBe(1);

    const localbuddy = summary.services.find((row) => row.service === "localbuddy");
    expect(localbuddy).toBeDefined();
    expect(localbuddy?.callCount).toBe(2);
    expect(localbuddy?.totalTokens).toBe(250);
    expect(localbuddy?.avgTokensPerHour).toBeCloseTo(250 / 24, 5);
    expect(localbuddy?.avgTokensPerCall).toBe(125);
    expect(localbuddy?.estimatedCallCount).toBe(1);

    const remotebuddy = summary.services.find((row) => row.service === "remotebuddy");
    expect(remotebuddy).toBeDefined();
    expect(remotebuddy?.callCount).toBe(1);
    expect(remotebuddy?.totalTokens).toBe(250);
    expect(remotebuddy?.avgTokensPerHour).toBeCloseTo(250 / 24, 5);
    expect(remotebuddy?.avgTokensPerCall).toBe(250);
  });

  test("tracks session token budget crossings from llm usage telemetry", () => {
    const store = makeStore();

    const first = store.recordLlmUsage(
      {
        id: "usage_worker_1",
        service: "workerpals",
        sessionId: "dev",
        promptTokens: 40,
        completionTokens: 20,
      },
      { sessionTokenBudget: 100, sessionTokenBudgetAction: "pause" },
    );
    expect(first.ok).toBe(true);
    expect(first.crossedLimit).toBe(false);
    expect(first.sessionBudget?.exceeded).toBe(false);
    expect(first.sessionBudget?.remainingTokens).toBe(40);

    const second = store.recordLlmUsage(
      {
        id: "usage_worker_2",
        service: "workerpals",
        sessionId: "dev",
        promptTokens: 30,
        completionTokens: 20,
      },
      { sessionTokenBudget: 100, sessionTokenBudgetAction: "pause" },
    );
    expect(second.ok).toBe(true);
    expect(second.crossedLimit).toBe(true);
    expect(second.sessionBudget?.exceeded).toBe(true);
    expect(second.sessionBudget?.totalTokens).toBe(110);
    expect(second.sessionBudget?.remainingTokens).toBe(0);
    expect(second.sessionBudget?.action).toBe("pause");

    const sessionSummary = store.getSessionLlmUsageSummary("dev");
    expect(sessionSummary).toBeDefined();
    expect(sessionSummary?.totalTokens).toBe(110);
    expect(sessionSummary?.callCount).toBe(2);
    expect(sessionSummary?.sessionId).toBe("dev");
  });

  test("persists candidates with run-scoped ids to prevent cross-run overwrites", () => {
    const store = makeStore();
    const snapshotA = store.createSnapshot({ sessionId: "s1", runId: "run_a" }).snapshot_id;
    const snapshotB = store.createSnapshot({ sessionId: "s1", runId: "run_b" }).snapshot_id;

    const baseCandidate = {
      id: "cand_shared",
      title: "Stabilize lint failures",
      objective_type: "lint_fix",
      problem_statement: "Fix recurring lint failure in server route.",
      trigger_type: "lint_failure",
      component_area: "apps/server",
      target_paths: ["apps/server/src/server_main.ts"],
      scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
      risk_level: "low",
      expected_validation: ["bun run lint"],
      estimated_effort: "small",
      why_now_signal_ids: ["sig_lint"],
      confidence: 0.9,
    };

    const runA = store.recordObjectiveDecision({
      runId: "run_a",
      snapshotId: snapshotA,
      sessionId: "s1",
      candidates: [baseCandidate],
    });
    const runB = store.recordObjectiveDecision({
      runId: "run_b",
      snapshotId: snapshotB,
      sessionId: "s1",
      candidates: [baseCandidate],
    });
    expect(runA.ok).toBe(true);
    expect(runB.ok).toBe(true);

    const db = (store as unknown as { db: any }).db;
    const rows = db
      .prepare(
        `SELECT id, run_id
         FROM autonomy_candidates
         WHERE id LIKE ?
         ORDER BY run_id ASC`,
      )
      .all("%:cand_shared") as Array<{ id: string; run_id: string }>;

    expect(rows.length).toBe(2);
    expect(rows[0]?.id).toBe("run_a:cand_shared");
    expect(rows[1]?.id).toBe("run_b:cand_shared");
  });

  test("persists engine idea trials and rolls outcome learning into snapshot priors", () => {
    const store = makeStore();
    const runId = "run_engine_idea_trials";
    const sessionId = "s1";
    const snapshotId = store.createSnapshot({ sessionId, runId }).snapshot_id;

    const decision = store.recordObjectiveDecision({
      runId,
      snapshotId,
      sessionId,
      candidates: [
        {
          id: "cand_engine_trial_seed",
          title: "Engine building block: novelty curriculum scheduler",
          objective_type: "lint_fix",
          problem_statement:
            "Prototype novelty curriculum scheduling for autonomous objective selection.",
          trigger_type: "lint_failure",
          component_area: "apps/remotebuddy",
          target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/src/*.ts"] },
          risk_level: "low",
          expected_validation: ["bun run test"],
          estimated_effort: "small",
          why_now_signal_ids: ["sig_queue_health"],
          confidence: 0.92,
          engine_trial: {
            building_block_id: "novelty_curriculum_scheduler",
            algorithm: "novelty curriculum scheduler",
            source: "engine_mapped",
            score: 0.81,
            objective_ids: ["reliable_autonomous_delivery"],
            gap_ids: ["idea_stagnation"],
            source_type: "external_repo",
            source_label: "acme/autonomy-lab",
            source_url: "https://example.com/acme/autonomy-lab",
            source_fingerprint: "fp_autonomy_lab_novelty",
            summary: "Increase idea diversity while preserving safety constraints.",
            hypothesis: "A curriculum schedule improves outcome quality over repeated loops.",
          },
        },
      ],
      objective: {
        id: "obj_engine_trial_seed",
        candidate_id: "cand_engine_trial_seed",
        title: "Seed objective for engine trial persistence",
        instruction: "Implement small autonomous scheduler scaffolding with metrics.",
        objective_type: "lint_fix",
        component_area: "apps/remotebuddy",
        trigger_type: "lint_failure",
        target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun run test"],
        status: "dispatched",
      },
    });
    expect(decision.ok).toBe(true);

    const db = (store as unknown as { db: any }).db;
    const trialBefore = db
      .prepare(
        `SELECT engine_building_block_id, engine_algorithm, inspiration_source_key, inspiration_source_type,
                inspiration_source_label, inspiration_source_url, inspiration_source_fingerprint, status, success, completed_at
         FROM autonomy_engine_idea_trials
         WHERE objective_id = ?`,
      )
      .get("obj_engine_trial_seed") as {
      engine_building_block_id: string;
      engine_algorithm: string;
      inspiration_source_key: string | null;
      inspiration_source_type: string | null;
      inspiration_source_label: string | null;
      inspiration_source_url: string | null;
      inspiration_source_fingerprint: string | null;
      status: string;
      success: number | null;
      completed_at: string | null;
    };
    expect(trialBefore.engine_building_block_id).toBe("novelty_curriculum_scheduler");
    expect(trialBefore.engine_algorithm).toBe("novelty curriculum scheduler");
    expect(String(trialBefore.inspiration_source_key ?? "")).toContain("fingerprint:");
    expect(trialBefore.inspiration_source_type).toBe("external_repo");
    expect(trialBefore.inspiration_source_label).toBe("acme/autonomy-lab");
    expect(trialBefore.inspiration_source_url).toBe("https://example.com/acme/autonomy-lab");
    expect(trialBefore.inspiration_source_fingerprint).toBe("fp_autonomy_lab_novelty");
    expect(trialBefore.status).toBe("dispatched");
    expect(trialBefore.success).toBe(null);
    expect(trialBefore.completed_at).toBe(null);

    const outcome = store.recordOutcome({
      objectiveId: "obj_engine_trial_seed",
      patternKey: decision.patternKey,
      requestId: "req_engine_trial_seed",
      jobId: "job_engine_trial_seed",
      success: true,
      userAction: "applied",
      latencyMs: 12_000,
      reopenedWithin24h: false,
      regressionFlag: false,
    });
    expect(outcome.ok).toBe(true);

    const trialAfter = db
      .prepare(
        `SELECT status, success, user_action, latency_ms, completed_at
         FROM autonomy_engine_idea_trials
         WHERE objective_id = ?`,
      )
      .get("obj_engine_trial_seed") as {
      status: string;
      success: number;
      user_action: string | null;
      latency_ms: number | null;
      completed_at: string | null;
    };
    expect(trialAfter.status).toBe("completed");
    expect(trialAfter.success).toBe(1);
    expect(trialAfter.user_action).toBe("applied");
    expect(trialAfter.latency_ms).toBe(12_000);
    expect(String(trialAfter.completed_at ?? "")).toContain("T");

    const ideaStats = db
      .prepare(
        `SELECT sample_count, ema_success, ema_user_accept
         FROM autonomy_engine_idea_stats
         WHERE engine_building_block_id = ?`,
      )
      .get("novelty_curriculum_scheduler") as {
      sample_count: number;
      ema_success: number;
      ema_user_accept: number;
    };
    expect(ideaStats.sample_count).toBe(1);
    expect(ideaStats.ema_success).toBeGreaterThan(0);
    expect(ideaStats.ema_user_accept).toBeGreaterThan(0);
    const sourceStats = db
      .prepare(
        `SELECT source_type, source_label, source_fingerprint, sample_count, ema_success, ema_user_accept
         FROM autonomy_engine_source_stats
         WHERE source_fingerprint = ?`,
      )
      .get("fp_autonomy_lab_novelty") as {
      source_type: string;
      source_label: string | null;
      source_fingerprint: string | null;
      sample_count: number;
      ema_success: number;
      ema_user_accept: number;
    };
    expect(sourceStats.source_type).toBe("external_repo");
    expect(sourceStats.source_label).toBe("acme/autonomy-lab");
    expect(sourceStats.source_fingerprint).toBe("fp_autonomy_lab_novelty");
    expect(sourceStats.sample_count).toBe(1);
    expect(sourceStats.ema_success).toBeGreaterThan(0);
    expect(sourceStats.ema_user_accept).toBeGreaterThan(0);

    const enriched = store.createSnapshot({ sessionId, runId });
    expect(enriched.engine_idea_priors.length).toBeGreaterThan(0);
    expect(enriched.engine_idea_priors[0]?.engine_building_block_id).toBe(
      "novelty_curriculum_scheduler",
    );
    expect(enriched.engine_source_priors.length).toBeGreaterThan(0);
    expect(enriched.engine_source_priors[0]?.source_type).toBe("external_repo");
  });

  test("curates inspiration sources into trusted shortlist and archives low performers", () => {
    const store = makeStore();
    const autonomyCfg = (
      store as unknown as {
        config?: {
          remotebuddy?: {
            autonomy?: {
              maxDispatchPerHour?: number;
              maxDispatchPerHourByType?: Record<string, number>;
            };
          };
        };
      }
    ).config?.remotebuddy?.autonomy;
    if (autonomyCfg) {
      autonomyCfg.maxDispatchPerHour = 64;
      autonomyCfg.maxDispatchPerHourByType = {
        ...autonomyCfg.maxDispatchPerHourByType,
        lint_fix: 64,
      };
    }
    const sessionId = "s1";
    const snapshotId = store.createSnapshot({
      sessionId,
      runId: "run_source_curation_seed",
    }).snapshot_id;
    const seedObjective = (params: {
      n: number;
      sourceFingerprint: string;
      sourceType: string;
      sourceLabel: string;
      sourceUrl: string;
      success: boolean;
      userAction: string;
    }) => {
      const idSuffix = `${params.sourceFingerprint}_${params.n}`;
      const decision = store.recordObjectiveDecision({
        runId: "run_source_curation_seed",
        snapshotId,
        sessionId,
        candidates: [
          {
            id: `cand_${idSuffix}`,
            title: `Engine building block: source_${params.sourceFingerprint}`,
            objective_type: "lint_fix",
            problem_statement: `Exercise source curation path for ${params.sourceFingerprint}`,
            trigger_type: "lint_failure",
            component_area: "apps/remotebuddy",
            target_paths: [
              `apps/remotebuddy/src/source_${params.sourceFingerprint}_${params.n}.ts`,
            ],
            scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/src/*.ts"] },
            risk_level: "low",
            expected_validation: ["bun run test"],
            estimated_effort: "small",
            why_now_signal_ids: ["sig_queue_health"],
            confidence: 0.9,
            engine_trial: {
              building_block_id: `bb_${params.sourceFingerprint}`,
              algorithm: `algo_${params.sourceFingerprint}`,
              source: "engine_mapped",
              score: 0.8,
              objective_ids: ["reliable_autonomous_delivery"],
              gap_ids: ["delivery_reliability_gap"],
              source_type: params.sourceType,
              source_label: params.sourceLabel,
              source_url: params.sourceUrl,
              source_fingerprint: params.sourceFingerprint,
            },
          },
        ],
        objective: {
          id: `obj_${idSuffix}`,
          candidate_id: `cand_${idSuffix}`,
          title: `Objective ${idSuffix}`,
          instruction: `Apply inspiration ${params.sourceFingerprint}`,
          objective_type: "lint_fix",
          component_area: "apps/remotebuddy",
          trigger_type: "lint_failure",
          target_paths: [`apps/remotebuddy/src/source_${params.sourceFingerprint}_${params.n}.ts`],
          scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/src/*.ts"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test"],
          status: "dispatched",
        },
      });
      expect(decision.ok).toBe(true);
      const outcome = store.recordOutcome({
        objectiveId: `obj_${idSuffix}`,
        requestId: `req_${idSuffix}`,
        jobId: `job_${idSuffix}`,
        patternKey: decision.patternKey,
        success: params.success,
        userAction: params.userAction,
        latencyMs: params.success ? 11_000 : 220_000,
        reopenedWithin24h: !params.success,
        regressionFlag: !params.success,
      });
      expect(outcome.ok).toBe(true);
    };
    for (let i = 0; i < 7; i += 1) {
      seedObjective({
        n: i,
        sourceFingerprint: "fp_trusted_source",
        sourceType: "external_repo",
        sourceLabel: "trusted/repo",
        sourceUrl: "https://example.com/trusted/repo",
        success: true,
        userAction: "applied",
      });
    }
    for (let i = 0; i < 9; i += 1) {
      seedObjective({
        n: i,
        sourceFingerprint: "fp_archived_source",
        sourceType: "external_doc",
        sourceLabel: "archived/doc",
        sourceUrl: "https://example.com/archived/doc",
        success: false,
        userAction: "rejected",
      });
    }
    const insights = store.listInsights({ limit: 100, feedbackLimit: 10 });
    const trusted = insights.engineSourceStats.find(
      (row) => row.sourceFingerprint === "fp_trusted_source",
    );
    const archived = insights.engineSourceStats.find(
      (row) => row.sourceFingerprint === "fp_archived_source",
    );
    expect(trusted).toBeDefined();
    expect(archived).toBeDefined();
    expect(trusted?.curationStatus).toBe("trusted");
    expect(archived?.curationStatus).toBe("archived");
    expect(trusted?.trustScore ?? 0).toBeGreaterThan(0.6);
    expect(archived?.trustScore ?? 1).toBeLessThan(0.5);
    expect(
      insights.trustedInspirationShortlist.some(
        (row) => row.sourceFingerprint === "fp_trusted_source",
      ),
    ).toBe(true);
    expect(
      insights.archivedInspirationSources.some(
        (row) => row.sourceFingerprint === "fp_archived_source",
      ),
    ).toBe(true);
  });

  test("ignores autonomy accepted outcomes before any worker job is linked", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1", runId: "run_guard" }).snapshot_id;

    const decision = store.recordObjectiveDecision({
      runId: "run_guard",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_guard",
        candidate_id: "cand_guard",
        title: "Guard against premature accepted outcome",
        instruction: "Run worker fix and validate",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
        request_id: "req_guard",
      },
    });
    expect(decision.ok).toBe(true);

    const premature = store.recordOutcome({
      objectiveId: "obj_guard",
      requestId: "req_guard",
      patternKey: decision.patternKey,
      success: true,
      userAction: "accepted",
    });
    expect(premature.ok).toBe(true);

    const db = (store as unknown as { db: any }).db;
    const before = db
      .prepare(`SELECT COUNT(*) AS count FROM autonomy_outcomes WHERE objective_id = ?`)
      .get("obj_guard") as { count: number };
    expect(before.count).toBe(0);

    const applied = store.recordOutcome({
      objectiveId: "obj_guard",
      requestId: "req_guard",
      jobId: "job_guard",
      patternKey: decision.patternKey,
      success: true,
      userAction: "applied",
    });
    expect(applied.ok).toBe(true);

    const after = db
      .prepare(`SELECT COUNT(*) AS count FROM autonomy_outcomes WHERE objective_id = ?`)
      .get("obj_guard") as { count: number };
    expect(after.count).toBe(1);
  });

  test("recordOutcome transitions objectives to terminal status and frees concurrency slots", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1", runId: "run_terminal" }).snapshot_id;

    const first = store.recordObjectiveDecision({
      runId: "run_terminal",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_terminal_1",
        title: "Seed first active objective",
        instruction: "Fix lint issue in server",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });
    const second = store.recordObjectiveDecision({
      runId: "run_terminal",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_terminal_2",
        title: "Seed second active objective",
        instruction: "Refresh docs",
        objective_type: "docs",
        component_area: "apps/remotebuddy",
        trigger_type: "queue_health",
        target_paths: ["apps/remotebuddy/docs/queue.md"],
        scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/docs/*.md"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const before = store.evaluateEligibility({
      runId: "run_terminal",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_before_terminal",
          objective_type: "type_fix",
          component_area: "apps/server",
          pattern_key: "pk_before_terminal",
          confidence: 0.95,
        },
      ],
    });
    expect(before.ok).toBe(true);
    expect(before.results?.[0]?.ok).toBe(false);
    expect(String(before.results?.[0]?.reason ?? "")).toContain(
      "max concurrent objectives reached",
    );

    const completed = store.recordOutcome({
      objectiveId: "obj_terminal_1",
      patternKey: first.patternKey,
      requestId: "req_terminal_1",
      jobId: "job_terminal_1",
      success: true,
      userAction: "applied",
      reopenedWithin24h: false,
      regressionFlag: false,
    });
    expect(completed.ok).toBe(true);

    const after = store.evaluateEligibility({
      runId: "run_terminal",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_after_terminal",
          objective_type: "type_fix",
          component_area: "apps/server",
          pattern_key: "pk_after_terminal",
          confidence: 0.95,
        },
      ],
    });
    expect(after.ok).toBe(true);
    expect(after.results?.[0]?.ok).toBe(true);
  });

  test("recordOutcome clears active pattern lock after terminal failure", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_pattern_release",
    }).snapshot_id;

    const seeded = store.recordObjectiveDecision({
      runId: "run_pattern_release",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_pattern_release",
        title: "Seed active pattern objective",
        instruction: "Fix lint issue",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });
    expect(seeded.ok).toBe(true);

    const blocked = store.evaluateEligibility({
      runId: "run_pattern_release",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_same_pattern_blocked",
          objective_type: "lint_fix",
          component_area: "apps/server",
          pattern_key: seeded.patternKey,
          confidence: 0.95,
        },
      ],
    });
    expect(blocked.ok).toBe(true);
    expect(blocked.results?.[0]?.ok).toBe(false);
    expect(String(blocked.results?.[0]?.reason ?? "")).toContain(
      "pattern already has active objective",
    );

    const failed = store.recordOutcome({
      objectiveId: "obj_pattern_release",
      patternKey: seeded.patternKey,
      requestId: "req_pattern_release",
      jobId: "job_pattern_release",
      success: false,
      userAction: "failed",
      reopenedWithin24h: false,
      regressionFlag: true,
    });
    expect(failed.ok).toBe(true);

    const unblocked = store.evaluateEligibility({
      runId: "run_pattern_release",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_same_pattern_unblocked",
          objective_type: "lint_fix",
          component_area: "apps/server",
          pattern_key: seeded.patternKey,
          confidence: 0.95,
        },
      ],
    });
    expect(unblocked.ok).toBe(true);
    expect(unblocked.results?.[0]?.ok).toBe(true);
  });

  test("listInsights returns pattern stats and structured PR feedback", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1", runId: "run_insights" }).snapshot_id;

    const decision = store.recordObjectiveDecision({
      runId: "run_insights",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_insights",
        title: "Seed objective for insights",
        instruction: "Fix lint issue for insights query",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });
    expect(decision.ok).toBe(true);

    const outcome = store.recordOutcome({
      objectiveId: "obj_insights",
      patternKey: decision.patternKey,
      requestId: "req_insights",
      jobId: "job_insights",
      success: false,
      userAction: "failed",
      reopenedWithin24h: false,
      regressionFlag: true,
    });
    expect(outcome.ok).toBe(true);

    const feedback = store.recordPrFeedback({
      objectiveId: "obj_insights",
      patternKey: decision.patternKey,
      jobId: "job_insights",
      verdict: "rejected",
      summary: "Missing validation coverage for edge-case transitions.",
      reviewScore: 6.2,
      reviewThreshold: 8.1,
      comments: [
        {
          userLogin: "reviewer-alpha",
          body: "Please add tests for empty queue and stale-claim handoff.",
          createdAt: "2026-03-02T12:00:00.000Z",
          htmlUrl: "https://example.test/comment/1",
        },
      ],
    });
    expect(feedback.ok).toBe(true);

    const insights = store.listInsights({
      patternKey: decision.patternKey,
      objectiveId: "obj_insights",
      limit: 5,
      feedbackLimit: 5,
    });
    expect(insights.patternStats.length).toBeGreaterThan(0);
    expect(insights.patternStats[0]?.patternKey).toBe(decision.patternKey);
    expect(insights.recentPrFeedback.length).toBeGreaterThan(0);
    expect(insights.recentPrFeedback[0]?.objectiveId).toBe("obj_insights");
    expect(insights.recentPrFeedback[0]?.summary).toContain("Missing validation coverage");
    expect(insights.recentPrFeedback[0]?.comments.length).toBeGreaterThan(0);
  });

  test("recordPrFeedback resolves autonomy pattern context from queued job params", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-pr-feedback-context-");
    const jobQueue = new JobQueue(dbPath);

    try {
      const enqueued = jobQueue.enqueue({
        taskId: "task_autonomy_feedback",
        kind: "task.execute",
        sessionId: "s1",
        params: {
          requestId: "req_autonomy_feedback",
          instruction: "Fix the targeted queue assertions.",
          autonomy: {
            origin: "autonomy",
            objectiveId: "obj_autonomy_feedback",
            patternKey: "flaky_test::components::__tests__",
          },
        },
      });
      expect(enqueued.ok).toBe(true);
      expect(typeof enqueued.jobId).toBe("string");

      const feedback = store.recordPrFeedback({
        jobId: enqueued.jobId,
        prUrl: "https://github.com/example/repo/pull/123",
        verdict: "rejected",
        summary: "Still missing coverage for stale-claim recovery.",
        reviewScore: 7.4,
        reviewThreshold: 8.1,
      });

      expect(feedback.ok).toBe(true);
      expect(feedback.patternKey).toBe("flaky_test::components::__tests__");
      expect(feedback.objectiveId).toBe("obj_autonomy_feedback");

      const insights = store.listInsights({
        patternKey: "flaky_test::components::__tests__",
        objectiveId: "obj_autonomy_feedback",
        limit: 5,
        feedbackLimit: 5,
      });
      expect(insights.recentPrFeedback.length).toBeGreaterThan(0);
      expect(insights.recentPrFeedback[0]?.objectiveId).toBe("obj_autonomy_feedback");
      expect(insights.recentPrFeedback[0]?.summary).toContain("stale-claim recovery");
    } finally {
      jobQueue.close();
    }
  });

  test("recordPrFeedback resolves review-agent source job context", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-pr-feedback-source-job-");
    const jobQueue = new JobQueue(dbPath);

    try {
      const source = jobQueue.enqueue({
        taskId: "task_autonomy_source_feedback",
        kind: "task.execute",
        sessionId: "s1",
        params: {
          requestId: "req_autonomy_source_feedback",
          instruction: "Improve the smoke review path.",
          autonomy: {
            origin: "autonomy",
            objectiveId: "obj_autonomy_source_feedback",
            patternKey: "web_smoke::review_path",
          },
        },
      });
      expect(source.ok).toBe(true);
      expect(typeof source.jobId).toBe("string");

      const reviewFix = jobQueue.enqueue({
        taskId: "review-fix-pr123-1",
        kind: "task.execute",
        sessionId: "s1",
        params: {
          instruction: "Fix review feedback for PR #123.",
          reviewAgent: {
            prNumber: 123,
            sourceJobId: source.jobId,
          },
        },
      });
      expect(reviewFix.ok).toBe(true);
      expect(typeof reviewFix.jobId).toBe("string");

      const feedback = store.recordPrFeedback({
        jobId: reviewFix.jobId,
        prUrl: "https://github.com/example/repo/pull/123",
        verdict: "approved_unmergeable",
        summary: "Approved but branch needs conflict resolution.",
        reviewScore: 8.4,
        reviewThreshold: 8.1,
      });

      expect(feedback.ok).toBe(true);
      expect(feedback.patternKey).toBe("web_smoke::review_path");
      expect(feedback.objectiveId).toBe("obj_autonomy_source_feedback");
    } finally {
      jobQueue.close();
    }
  });

  test("recordPrFeedback ignores legacy PR feedback that cannot resolve autonomy context", () => {
    const store = makeStore();

    const feedback = store.recordPrFeedback({
      feedbackKey: "review_agent:pr:987:head:legacy:verdict:rejected",
      prNumber: 987,
      prUrl: "https://github.com/example/repo/pull/987",
      verdict: "rejected",
      summary: "Legacy PR has no source job metadata to map back to autonomy.",
      reviewScore: 7.2,
      reviewThreshold: 8.1,
    });

    expect(feedback.ok).toBe(true);
    expect(feedback.ignored).toBe(true);
    expect(feedback.reason).toContain("unable to resolve patternKey");

    const insights = store.listInsights({ limit: 5, feedbackLimit: 5 });
    expect(insights.recentPrFeedback).toHaveLength(0);
  });

  test("recordPrFeedback keeps approved_unmergeable feedback non-terminal", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_merge_conflict_feedback",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_merge_conflict_feedback",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_merge_conflict_feedback",
        title: "Seed merge-conflict PR feedback objective",
        instruction: "Exercise approved-unmergeable feedback handling.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/autonomy.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun test tests/server.autonomy-store.test.ts"],
        status: "dispatched",
      },
    });
    expect(decision.ok).toBe(true);

    const feedback = store.recordPrFeedback({
      feedbackKey: "review_agent:pr:42:head:abc123:verdict:approved_unmergeable",
      objectiveId: "obj_merge_conflict_feedback",
      requestId: "req_merge_conflict_feedback",
      jobId: "job_merge_conflict_feedback",
      patternKey: decision.patternKey,
      prNumber: 42,
      verdict: "approved_unmergeable",
      summary: "Approved by ReviewAgent, but GitHub reported a merge conflict.",
      reviewScore: 8.3,
      reviewThreshold: 8.1,
    });

    expect(feedback.ok).toBe(true);
    expect(feedback.success).toBeUndefined();
    expect(autonomyOutcomeCount(store, "obj_merge_conflict_feedback")).toBe(0);
    expect(store.listInsights().portfolio.reviewRevisionCount).toBe(1);
  });

  test("does not infer terminal lifecycle state from natural-language verdict text", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_natural_language_feedback",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_natural_language_feedback",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_natural_language_feedback",
        title: "Keep provider lifecycle classification exact",
        instruction: "Do not treat prose as an authoritative provider state.",
        objective_type: "lint_fix",
        component_area: "src",
        trigger_type: "test_failure",
        target_paths: ["src/provider-state.ts"],
        scope: { read_anywhere: false, write_globs: ["src/provider-state.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["test"],
        status: "awaiting_review",
      },
    });
    expect(decision.ok).toBe(true);

    const feedback = store.recordPrFeedback({
      feedbackKey: "natural-language-feedback:not-failed",
      objectiveId: "obj_natural_language_feedback",
      patternKey: decision.patternKey,
      verdict: "not failed; provider review is still open",
    });

    expect(feedback).toMatchObject({ ok: true });
    expect(feedback.success).toBeUndefined();
    expect(autonomyOutcomeCount(store, "obj_natural_language_feedback")).toBe(0);
    expect(autonomyObjectiveStatus(store, "obj_natural_language_feedback")).toBe("awaiting_review");
  });

  test("rejects terminal provider feedback without complete persisted job and PR authority", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-feedback-authority-");
    const queue = new JobQueue(dbPath);
    try {
      const prUrl = "https://github.com/example/repo/pull/807";
      const enqueued = queue.enqueue({
        taskId: "feedback-authority",
        sessionId: "dev",
        kind: "task.execute",
        params: { origin: "autonomy" },
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(queue.claim("worker-feedback-authority").job?.id).toBe(jobId);
      expect(queue.complete(jobId, { summary: "published", prUrl }).ok).toBe(true);
      const snapshotId = store.createSnapshot({
        sessionId: "dev",
        runId: "run_feedback_authority",
      }).snapshot_id;
      const decision = store.recordObjectiveDecision({
        runId: "run_feedback_authority",
        snapshotId,
        sessionId: "dev",
        objective: {
          id: "obj_feedback_authority",
          title: "Require provider authority",
          instruction: "Reject incomplete terminal delivery claims.",
          objective_type: "small_refactor",
          component_area: "src",
          trigger_type: "regret_signal",
          target_paths: ["src/provider.ts"],
          scope: { read_anywhere: false, write_globs: ["src/provider.ts"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["git diff --check"],
          status: "awaiting_review",
          job_id: jobId,
        },
      });
      expect(decision.ok).toBe(true);

      expect(
        store.recordPrFeedback({
          feedbackKey: "authority:missing-url",
          objectiveId: "obj_feedback_authority",
          jobId,
          patternKey: decision.patternKey,
          verdict: "approved_merged",
        }),
      ).toMatchObject({ ok: true, ignored: true });
      expect(
        store.recordPrFeedback({
          feedbackKey: "authority:missing-job",
          objectiveId: "obj_feedback_authority",
          patternKey: decision.patternKey,
          prUrl,
          verdict: "approved_merged",
        }),
      ).toMatchObject({ ok: true, ignored: true });
      expect(autonomyOutcomeCount(store, "obj_feedback_authority")).toBe(0);
      expect(autonomyObjectiveStatus(store, "obj_feedback_authority")).toBe("awaiting_review");
      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(1);
    } finally {
      queue.close();
    }
  });

  test("does not reuse a feedback key for a different lifecycle event", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "dev",
      runId: "run_feedback_key",
    }).snapshot_id;
    const makeDecision = (id: string, path: string) =>
      store.recordObjectiveDecision({
        runId: "run_feedback_key",
        snapshotId,
        sessionId: "dev",
        objective: {
          id,
          title: `Feedback identity ${id}`,
          instruction: "Keep feedback identities immutable.",
          objective_type: "small_refactor",
          component_area: "src",
          trigger_type: "regret_signal",
          target_paths: [path],
          scope: { read_anywhere: false, write_globs: [path] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["git diff --check"],
          status: "awaiting_review",
        },
      });
    const first = makeDecision("obj_feedback_key_first", "src/first.ts");
    const second = makeDecision("obj_feedback_key_second", "src/second.ts");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(
      store.recordPrFeedback({
        feedbackKey: "immutable-feedback-key",
        objectiveId: "obj_feedback_key_first",
        patternKey: first.patternKey,
        verdict: "rejected",
      }).ok,
    ).toBe(true);

    const conflict = store.recordPrFeedback({
      feedbackKey: "immutable-feedback-key",
      objectiveId: "obj_feedback_key_second",
      patternKey: second.patternKey,
      verdict: "approved_merged",
    });
    expect(conflict).toMatchObject({
      ok: true,
      ignored: true,
      reason: "feedbackKey already belongs to a different PR feedback event",
    });
    expect(autonomyOutcomeCount(store, "obj_feedback_key_second")).toBe(0);
    expect(autonomyObjectiveStatus(store, "obj_feedback_key_second")).toBe("awaiting_review");
  });

  test("replays terminal lifecycle projection after a crash following feedback persistence", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-feedback-replay-");
    const queue = new JobQueue(dbPath);
    try {
      const prUrl = "https://github.com/example/repo/pull/808";
      const enqueued = queue.enqueue({
        taskId: "feedback-replay",
        sessionId: "dev",
        kind: "task.execute",
        params: { origin: "autonomy" },
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(queue.claim("worker-feedback-replay").job?.id).toBe(jobId);
      expect(queue.complete(jobId, { summary: "published", prUrl }).ok).toBe(true);

      const snapshotId = store.createSnapshot({
        sessionId: "dev",
        runId: "run_feedback_replay",
      }).snapshot_id;
      const decision = store.recordObjectiveDecision({
        runId: "run_feedback_replay",
        snapshotId,
        sessionId: "dev",
        objective: {
          id: "obj_feedback_replay",
          title: "Recover feedback projection",
          instruction: "Project the provider-confirmed merge exactly once.",
          objective_type: "small_refactor",
          component_area: "src",
          trigger_type: "queue_health",
          target_paths: ["src/recovery.ts"],
          scope: { read_anywhere: false, write_globs: ["src/recovery.ts"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["git diff --check"],
          status: "awaiting_review",
          job_id: jobId,
        },
      });
      expect(decision.ok).toBe(true);

      const feedbackKey = "provider:feedback-replay:merged";
      const db = (store as unknown as { db: any }).db;
      db.prepare(
        `INSERT INTO autonomy_pr_feedback (
           feedback_key, objective_id, job_id, pattern_key, pr_number, pr_url,
           pr_url_normalized, verdict, source, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'review_agent', ?)`,
      ).run(
        feedbackKey,
        "obj_feedback_replay",
        jobId,
        decision.patternKey,
        808,
        prUrl,
        prUrl,
        "approved_merged",
        new Date().toISOString(),
      );

      const replay = store.recordPrFeedback({
        feedbackKey,
        objectiveId: "obj_feedback_replay",
        jobId,
        patternKey: decision.patternKey,
        prNumber: 808,
        prUrl,
        verdict: "approved_merged",
      });
      expect(replay).toMatchObject({ ok: true, deduped: true, success: true });
      expect(autonomyObjectiveStatus(store, "obj_feedback_replay")).toBe("completed");
      expect(autonomyOutcomeCount(store, "obj_feedback_replay")).toBe(1);
      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(0);

      expect(
        store.recordPrFeedback({
          feedbackKey,
          objectiveId: "obj_feedback_replay",
          jobId,
          patternKey: decision.patternKey,
          prNumber: 808,
          prUrl,
          verdict: "approved_merged",
        }).ok,
      ).toBe(true);
      expect(autonomyOutcomeCount(store, "obj_feedback_replay")).toBe(1);
    } finally {
      queue.close();
    }
  });

  test("rolls back a partial terminal outcome projection and replays it atomically", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-outcome-atomic-");
    const queue = new JobQueue(dbPath);
    try {
      const prUrl = "https://github.com/example/repo/pull/809";
      const enqueued = queue.enqueue({
        taskId: "outcome-atomic",
        sessionId: "dev",
        kind: "task.execute",
        params: { origin: "autonomy" },
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(queue.claim("worker-outcome-atomic").job?.id).toBe(jobId);
      expect(queue.complete(jobId, { summary: "published", prUrl }).ok).toBe(true);
      const snapshotId = store.createSnapshot({
        sessionId: "dev",
        runId: "run_outcome_atomic",
      }).snapshot_id;
      const decision = store.recordObjectiveDecision({
        runId: "run_outcome_atomic",
        snapshotId,
        sessionId: "dev",
        objective: {
          id: "obj_outcome_atomic",
          title: "Keep terminal projection atomic",
          instruction: "Commit terminal delivery state and learning together.",
          objective_type: "small_refactor",
          component_area: "src",
          trigger_type: "regret_signal",
          target_paths: ["src/delivery.ts"],
          scope: { read_anywhere: false, write_globs: ["src/delivery.ts"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["git diff --check"],
          status: "awaiting_review",
          job_id: jobId,
        },
      });
      expect(decision.ok).toBe(true);
      const db = (store as unknown as { db: any }).db;
      db.exec(`
        CREATE TEMP TRIGGER fail_outcome_projection
        BEFORE UPDATE OF status ON autonomy_objectives
        WHEN NEW.id = 'obj_outcome_atomic' AND NEW.status = 'completed'
        BEGIN
          SELECT RAISE(ABORT, 'injected projection crash');
        END;
      `);
      const feedback = {
        feedbackKey: "provider:outcome-atomic:merged",
        objectiveId: "obj_outcome_atomic",
        jobId,
        patternKey: decision.patternKey,
        prNumber: 809,
        prUrl,
        verdict: "approved_merged",
      };

      expect(() => store.recordPrFeedback(feedback)).toThrow("injected projection crash");
      expect(autonomyOutcomeCount(store, "obj_outcome_atomic")).toBe(0);
      expect(autonomyObjectiveStatus(store, "obj_outcome_atomic")).toBe("awaiting_review");
      expect(autonomyPatternSampleCount(store, decision.patternKey ?? "")).toBe(0);
      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(1);
      expect(
        (
          db
            .prepare(`SELECT COUNT(*) AS count FROM autonomy_pr_feedback WHERE feedback_key = ?`)
            .get(feedback.feedbackKey) as { count: number }
        ).count,
      ).toBe(1);

      db.exec(`DROP TRIGGER fail_outcome_projection;`);
      expect(store.recordPrFeedback(feedback)).toMatchObject({
        ok: true,
        deduped: true,
        success: true,
      });
      expect(autonomyOutcomeCount(store, "obj_outcome_atomic")).toBe(1);
      expect(autonomyObjectiveStatus(store, "obj_outcome_atomic")).toBe("completed");
      expect(autonomyPatternSampleCount(store, decision.patternKey ?? "")).toBe(1);
      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(0);
    } finally {
      queue.close();
    }
  });

  test("counts one merged objective once across sibling jobs for the same PR", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-sibling-merge-");
    const queue = new JobQueue(dbPath);
    try {
      const prUrl = "https://github.com/example/repo/pull/810";
      const jobIds: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const enqueued = queue.enqueue({
          taskId: `sibling-merge-${index}`,
          sessionId: "dev",
          kind: "task.execute",
          params: { origin: "autonomy" },
        });
        const jobId = String(enqueued.jobId ?? "");
        jobIds.push(jobId);
        expect(queue.claim(`worker-sibling-merge-${index}`).job?.id).toBe(jobId);
        expect(queue.complete(jobId, { summary: "published", prUrl }).ok).toBe(true);
      }
      const snapshotId = store.createSnapshot({
        sessionId: "dev",
        runId: "run_sibling_merge",
      }).snapshot_id;
      const decision = store.recordObjectiveDecision({
        runId: "run_sibling_merge",
        snapshotId,
        sessionId: "dev",
        objective: {
          id: "obj_sibling_merge",
          title: "Count one delivered PR once",
          instruction: "Deduplicate provider confirmation across sibling jobs.",
          objective_type: "small_refactor",
          component_area: "src",
          trigger_type: "regret_signal",
          target_paths: ["src/count-once.ts"],
          scope: { read_anywhere: false, write_globs: ["src/count-once.ts"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["git diff --check"],
          status: "awaiting_review",
          job_id: jobIds[0],
        },
      });
      expect(decision.ok).toBe(true);

      for (let index = 0; index < jobIds.length; index += 1) {
        expect(
          store.recordPrFeedback({
            feedbackKey: `sibling-merge:${index}`,
            objectiveId: "obj_sibling_merge",
            jobId: jobIds[index],
            patternKey: decision.patternKey,
            prUrl,
            verdict: "approved_merged",
          }).ok,
        ).toBe(true);
      }

      expect(autonomyOutcomeCount(store, "obj_sibling_merge")).toBe(1);
      expect(autonomyPatternSampleCount(store, decision.patternKey ?? "")).toBe(1);
      expect(autonomyObjectiveStatus(store, "obj_sibling_merge")).toBe("completed");
      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(0);
    } finally {
      queue.close();
    }
  });

  test("PR publication remains pending until an authoritative merge outcome", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_pr_delivery_lifecycle",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_pr_delivery_lifecycle",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_pr_delivery_lifecycle",
        title: "Improve repository behavior",
        instruction: "Implement and validate one behavior improvement.",
        objective_type: "feature_small",
        component_area: "src/search",
        trigger_type: "queue_health",
        target_paths: ["src/search/rank.ts"],
        scope: { read_anywhere: false, write_globs: ["src/search/rank.ts"] },
        confidence: 0.92,
        risk_level: "low",
        expected_validation: ["bun test"],
        status: "running",
        job_id: "job_pr_delivery_lifecycle",
      },
    });
    expect(decision.ok).toBe(true);

    store.markObjectiveAwaitingReviewByJobId("job_pr_delivery_lifecycle");
    const lifecycleDb = (store as unknown as { db: any }).db;
    const awaitingReviewSince = (
      lifecycleDb
        .prepare(`SELECT awaiting_review_since AS value FROM autonomy_objectives WHERE id = ?`)
        .get("obj_pr_delivery_lifecycle") as { value: string | null }
    ).value;
    expect(awaitingReviewSince).toEqual(expect.any(String));
    expect(
      store.recordOutcome({
        objectiveId: "obj_pr_delivery_lifecycle",
        jobId: "job_pr_delivery_lifecycle",
        patternKey: decision.patternKey,
        success: true,
        userAction: "published",
        terminal: false,
      }).ok,
    ).toBe(true);
    expect(autonomyObjectiveStatus(store, "obj_pr_delivery_lifecycle")).toBe("awaiting_review");
    expect(
      (store as unknown as { activeObjectiveCount: () => number }).activeObjectiveCount(),
    ).toBe(0);
    const whileReviewing = store.evaluateEligibility({
      runId: "run_pr_delivery_lifecycle",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_unrelated_while_reviewing",
          objective_type: "feature_small",
          component_area: "src/imports",
          pattern_key: "feature_small::src/imports::health",
          target_paths: ["src/imports/parse.ts"],
          confidence: 0.9,
        },
        {
          candidate_id: "cand_duplicate_while_reviewing",
          objective_type: "type_fix",
          component_area: "src/search",
          pattern_key: "type_fix::src/search::typecheck_failure",
          target_paths: ["src/search/rank.ts"],
          confidence: 0.9,
        },
      ],
      applySequentialAccounting: false,
    });
    expect(whileReviewing.results?.[0]).toEqual({
      candidate_id: "cand_unrelated_while_reviewing",
      ok: true,
    });
    expect(whileReviewing.results?.[1]?.ok).toBe(false);
    expect(String(whileReviewing.results?.[1]?.reason ?? "")).toContain(
      "target path already has active objective",
    );
    expect(runEvaluatorNow(store).sampleCount).toBe(0);
    expect(autonomyPatternSampleCount(store, decision.patternKey ?? "")).toBe(0);

    expect(
      store.recordPrFeedback({
        feedbackKey: "pr-delivery:revision-1",
        objectiveId: "obj_pr_delivery_lifecycle",
        jobId: "job_pr_delivery_lifecycle",
        patternKey: decision.patternKey,
        verdict: "rejected",
      }).ok,
    ).toBe(true);
    expect(autonomyObjectiveStatus(store, "obj_pr_delivery_lifecycle")).toBe("awaiting_review");
    expect(
      (
        lifecycleDb
          .prepare(`SELECT awaiting_review_since AS value FROM autonomy_objectives WHERE id = ?`)
          .get("obj_pr_delivery_lifecycle") as { value: string | null }
      ).value,
    ).toBe(awaitingReviewSince);
    expect(runEvaluatorNow(store).sampleCount).toBe(0);

    expect(
      store.recordPrFeedback({
        feedbackKey: "pr-delivery:merged",
        objectiveId: "obj_pr_delivery_lifecycle",
        jobId: "job_pr_delivery_lifecycle",
        patternKey: decision.patternKey,
        verdict: "approved_merged",
      }).ok,
    ).toBe(true);
    expect(autonomyObjectiveStatus(store, "obj_pr_delivery_lifecycle")).toBe("completed");
    expect(runEvaluatorNow(store).sampleCount).toBe(1);
    expect(autonomyPatternSampleCount(store, decision.patternKey ?? "")).toBe(1);

    store.markObjectiveAwaitingReviewByJobId("job_pr_delivery_lifecycle");
    expect(autonomyObjectiveStatus(store, "obj_pr_delivery_lifecycle")).toBe("completed");
    expect(
      store.recordPrFeedback({
        feedbackKey: "pr-delivery:late-close",
        objectiveId: "obj_pr_delivery_lifecycle",
        jobId: "job_pr_delivery_lifecycle",
        patternKey: decision.patternKey,
        verdict: "closed_unmerged",
      }).ok,
    ).toBe(true);
    expect(autonomyObjectiveStatus(store, "obj_pr_delivery_lifecycle")).toBe("completed");
    expect(runEvaluatorNow(store).sampleCount).toBe(1);
  });

  test("portfolio insights retain vision provenance and review quality outcomes", () => {
    const store = makeStore();
    const runId = "run_portfolio_insights";
    const snapshotId = store.createSnapshot({ sessionId: "s1", runId }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId,
      snapshotId,
      sessionId: "s1",
      candidates: [
        {
          id: "cand_portfolio_insights",
          title: "Improve import recovery",
          objective_type: "feature_small",
          problem_statement: "Make interrupted imports recover predictably.",
          trigger_type: "queue_health",
          component_area: "src/imports",
          target_paths: ["src/imports/recover.ts"],
          scope: { read_anywhere: false, write_globs: ["src/imports/recover.ts"] },
          risk_level: "low",
          expected_validation: ["bun test"],
          estimated_effort: "small",
          why_now_signal_ids: ["sig_queue"],
          confidence: 0.9,
          work_kind: "product_behavior",
          work_area_key: "src/imports",
          work_target_key: "src/imports/recover.ts",
          vision_objective_id: "reliable-import-recovery",
          vision_objective_weight: 0.91,
          vision_priority_rank: 1,
          vision_source_bucket: "priorities",
          vision_category: "product_core",
          vision_alignment_reason: "Directly advances the top repository priority.",
          vision_section_refs: ["3"],
          feature_hypotheses: ["Interrupted imports resume without duplicate writes."],
        },
      ],
      objective: {
        id: "obj_portfolio_insights",
        candidate_id: "cand_portfolio_insights",
        title: "Improve import recovery",
        instruction: "Implement one bounded import recovery improvement.",
        objective_type: "feature_small",
        component_area: "src/imports",
        trigger_type: "queue_health",
        target_paths: ["src/imports/recover.ts"],
        scope: { read_anywhere: false, write_globs: ["src/imports/recover.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun test"],
        status: "running",
        job_id: "job_portfolio_insights",
      },
    });
    expect(decision.ok).toBe(true);

    store.markObjectiveAwaitingReviewByJobId("job_portfolio_insights");
    expect(
      store.recordOutcome({
        objectiveId: "obj_portfolio_insights",
        jobId: "job_portfolio_insights",
        patternKey: decision.patternKey,
        success: true,
        userAction: "published",
        terminal: false,
      }).ok,
    ).toBe(true);
    expect(
      store.recordPrFeedback({
        feedbackKey: "portfolio:revision",
        objectiveId: "obj_portfolio_insights",
        jobId: "job_portfolio_insights",
        patternKey: decision.patternKey,
        verdict: "rejected",
      }).ok,
    ).toBe(true);

    const pending = store.listInsights();
    expect(pending.portfolio).toMatchObject({
      objectiveCount: 1,
      visionAlignedObjectiveCount: 1,
      userObservableObjectiveCount: 1,
      uniqueVisionObjectiveCount: 1,
      awaitingReviewCount: 1,
      mergedObjectiveCount: 0,
      reviewRevisionCount: 1,
      firstPassMergeRate: 0,
    });

    expect(
      store.recordPrFeedback({
        feedbackKey: "portfolio:merged",
        objectiveId: "obj_portfolio_insights",
        jobId: "job_portfolio_insights",
        patternKey: decision.patternKey,
        verdict: "approved_merged",
      }).ok,
    ).toBe(true);
    expect(store.listInsights().portfolio).toMatchObject({
      awaitingReviewCount: 0,
      mergedObjectiveCount: 1,
      reviewRevisionCount: 1,
      firstPassMergeRate: 0,
    });
  });

  test("evaluator excludes iterative PR revisions until a terminal objective outcome", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_review_loop",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_review_loop",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_review_loop",
        title: "Seed iterative PR review objective",
        instruction: "Exercise iterative review feedback handling.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/autonomy.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun test tests/server.autonomy-store.test.ts"],
        status: "dispatched",
      },
    });
    expect(decision.ok).toBe(true);

    for (let i = 0; i < 7; i += 1) {
      const feedback = store.recordPrFeedback({
        feedbackKey: `review_agent:pr:42:head:reject-${i}:verdict:rejected`,
        objectiveId: "obj_review_loop",
        requestId: "req_review_loop",
        jobId: "job_review_loop",
        patternKey: decision.patternKey,
        prNumber: 42,
        verdict: "rejected",
        summary: `Review iteration ${i + 1} still needs fixes.`,
        reviewScore: 7.5,
        reviewThreshold: 8.1,
      });
      expect(feedback.ok).toBe(true);
    }

    const rejectedCard = runEvaluatorNow(store);
    expect(rejectedCard.sampleCount).toBe(0);
    expect(rejectedCard.successRate).toBeNull();
    expect(rejectedCard.regretRate).toBeNull();
    expect(rejectedCard.recommendation).toBe("constrain");
    expect(autonomyObjectiveStatus(store, "obj_review_loop")).toBe("awaiting_review");
    expect(autonomyPatternSampleCount(store, decision.patternKey)).toBe(0);
    expect(store.getReliabilityMetrics()).toMatchObject({
      objectiveTerminalCount: 0,
      objectiveSuccessRate: null,
      nonTerminalRevisionCount: 7,
      nonTerminalRevisionObjectiveCount: 1,
      revisedTerminalObjectiveCount: 0,
      objectiveRevisionRate: 1,
      objectiveFirstPassRate: 0,
    });

    const frozen = store.updateSafetyState({
      freezeForMs: 600_000,
      freezeReason: "auto_freeze:evaluator_pause",
    });
    expect(frozen.ok).toBe(true);
    expect(frozen.state.isFrozen).toBe(true);

    const recheckedCard = runEvaluatorNow(store);
    expect(recheckedCard.sampleCount).toBe(0);
    expect(recheckedCard.recommendation).toBe("constrain");
    expect(store.getSafetyState().isFrozen).toBe(false);

    const merged = store.recordPrFeedback({
      feedbackKey: "review_agent:pr:42:head:merged:verdict:approved_merged",
      objectiveId: "obj_review_loop",
      requestId: "req_review_loop",
      jobId: "job_review_loop",
      patternKey: decision.patternKey,
      prNumber: 42,
      verdict: "approved_merged",
      summary: "ReviewAgent approved and merged the PR.",
      reviewScore: 8.4,
      reviewThreshold: 8.1,
    });
    expect(merged.ok).toBe(true);
    expect(merged.success).toBe(true);

    const mergedCard = runEvaluatorNow(store);
    expect(mergedCard.sampleCount).toBe(1);
    expect(mergedCard.successRate).toBe(1);
    expect(mergedCard.regretRate).toBe(0);
    expect(mergedCard.recommendation).toBe("constrain");
    expect(autonomyObjectiveStatus(store, "obj_review_loop")).toBe("completed");
    expect(autonomyPatternSampleCount(store, decision.patternKey)).toBe(1);
    expect(store.getReliabilityMetrics()).toMatchObject({
      objectiveTerminalCount: 1,
      objectiveSuccessRate: 1,
      nonTerminalRevisionCount: 7,
      nonTerminalRevisionObjectiveCount: 1,
      revisedTerminalObjectiveCount: 1,
      objectiveRevisionRate: 1,
      objectiveFirstPassRate: 0,
    });
  });

  test("review revision rate includes unresolved revision work in the observed cohort", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-review-cohort-");
    const queue = new JobQueue(dbPath);
    const internal = store as unknown as {
      config: { remotebuddy: { autonomy: { evaluatorMinSamples: number } } };
    };
    const originalEvaluatorMinSamples = internal.config.remotebuddy.autonomy.evaluatorMinSamples;
    try {
      internal.config.remotebuddy.autonomy.evaluatorMinSamples = 1;
      const snapshotId = store.createSnapshot({
        sessionId: "dev",
        runId: "run_review_cohort",
      }).snapshot_id;

      const createPublishedObjective = (index: number) => {
        const prUrl = `https://github.com/example/repo/pull/${900 + index}`;
        const enqueued = queue.enqueue({
          taskId: `review-cohort-${index}`,
          sessionId: "dev",
          kind: "task.execute",
          params: { origin: "autonomy" },
        });
        const jobId = String(enqueued.jobId ?? "");
        expect(queue.claim(`worker-review-cohort-${index}`).job?.id).toBe(jobId);
        expect(queue.complete(jobId, { summary: "published", prUrl }).ok).toBe(true);
        const objectiveId = `obj_review_cohort_${index}`;
        const decision = store.recordObjectiveDecision({
          runId: "run_review_cohort",
          snapshotId,
          sessionId: "dev",
          objective: {
            id: objectiveId,
            title: `Review cohort objective ${index}`,
            instruction: "Validate review delivery cohort accounting.",
            objective_type: "small_refactor",
            component_area: `src/area-${index}`,
            trigger_type: "queue_health",
            target_paths: [`src/area-${index}/index.ts`],
            scope: {
              read_anywhere: false,
              write_globs: [`src/area-${index}/index.ts`],
            },
            confidence: 0.9,
            risk_level: "low",
            expected_validation: ["npm test"],
            status: "awaiting_review",
            job_id: jobId,
          },
        });
        expect(decision.ok).toBe(true);
        return { objectiveId, jobId, prUrl, patternKey: decision.patternKey };
      };

      const merged = createPublishedObjective(0);
      expect(
        store.recordPrFeedback({
          feedbackKey: "review-cohort:merged",
          objectiveId: merged.objectiveId,
          jobId: merged.jobId,
          patternKey: merged.patternKey,
          prUrl: merged.prUrl,
          verdict: "approved_merged",
        }).ok,
      ).toBe(true);

      for (let index = 1; index <= 3; index += 1) {
        const unresolved = createPublishedObjective(index);
        expect(
          store.recordPrFeedback({
            feedbackKey: `review-cohort:revision:${index}`,
            objectiveId: unresolved.objectiveId,
            jobId: unresolved.jobId,
            patternKey: unresolved.patternKey,
            prUrl: unresolved.prUrl,
            verdict: "rejected",
          }).ok,
        ).toBe(true);
      }

      const card = runEvaluatorNow(store);
      expect(card.reviewResolvedCount).toBe(1);
      expect(card.reviewRevisionRate).toBe(0.75);
      expect(card.recommendation).toBe("pause");
      expect(store.listInsights().portfolio).toMatchObject({
        resolvedObjectiveCount: 1,
        mergedObjectiveCount: 1,
        reviewRevisionCount: 3,
        firstPassMergeRate: 0.25,
      });
    } finally {
      internal.config.remotebuddy.autonomy.evaluatorMinSamples = originalEvaluatorMinSamples;
      queue.close();
    }
  });

  test("evaluator selects the chronologically latest outcome after replayed backfills", () => {
    const store = makeStore();
    const db = (store as unknown as { db: any }).db;
    const insert = db.prepare(
      `INSERT INTO autonomy_outcomes (
         objective_id, request_id, job_id, pattern_key, success, retries, latency_ms,
         user_action, reopened_within_24h, regression_flag, created_at
       ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, 0, ?, ?)`,
    );
    const nowMs = Date.now();

    insert.run(
      "obj_replayed_backfill",
      "req_replayed_backfill",
      "job_replayed_backfill",
      "pk_replayed_backfill",
      1,
      "published",
      0,
      new Date(nowMs - 30_000).toISOString(),
    );
    insert.run(
      "obj_replayed_backfill",
      "req_replayed_backfill",
      "job_replayed_backfill",
      "pk_replayed_backfill",
      0,
      "failed",
      1,
      new Date(nowMs - 60_000).toISOString(),
    );

    const card = runEvaluatorNow(store);
    expect(card.sampleCount).toBe(1);
    expect(card.successRate).toBe(1);
    expect(card.regretRate).toBe(0);
  });

  test("evaluator still pauses on independent failed objective samples", () => {
    const store = makeStore();

    for (let i = 0; i < 6; i += 1) {
      const outcome = store.recordOutcome({
        objectiveId: `obj_independent_failure_${i}`,
        requestId: `req_independent_failure_${i}`,
        jobId: `job_independent_failure_${i}`,
        patternKey: `pk_independent_failure_${i}`,
        success: false,
        userAction: "failed",
        reopenedWithin24h: false,
        regressionFlag: true,
      });
      expect(outcome.ok).toBe(true);
    }

    const card = runEvaluatorNow(store);
    expect(card.sampleCount).toBe(6);
    expect(card.successRate).toBe(0);
    expect(card.regretRate).toBe(1);
    expect(card.recommendation).toBe("pause");
    expect(store.getSafetyState().isFrozen).toBe(true);
    expect(store.getSafetyState().freezeReason).toBe("auto_freeze:evaluator_pause");
  });

  test("a repeated lane failure opens its cooldown without globally freezing autonomy", async () => {
    const store = makeStore();
    const startedAtMs = Date.now();

    for (let index = 0; index < 3; index += 1) {
      expect(
        store.recordOutcome({
          objectiveId: `obj_non_extending_freeze_${index}`,
          requestId: `req_non_extending_freeze_${index}`,
          jobId: `job_non_extending_freeze_${index}`,
          patternKey: "pk_non_extending_freeze",
          success: false,
          userAction: "failed",
          regressionFlag: true,
        }).ok,
      ).toBe(true);
    }
    const firstFreeze = store.getSafetyState();
    expect(firstFreeze.isFrozen).toBe(false);
    const db = (store as unknown as { db: any }).db;
    const firstCooldown = db
      .prepare(`SELECT cooldown_until FROM autonomy_pattern_stats WHERE pattern_key = ?`)
      .get("pk_non_extending_freeze") as { cooldown_until: string | null };
    expect(Date.parse(String(firstCooldown.cooldown_until))).toBeGreaterThan(startedAtMs);

    await Bun.sleep(10);
    expect(
      store.recordOutcome({
        objectiveId: "obj_non_extending_freeze_late",
        requestId: "req_non_extending_freeze_late",
        jobId: "job_non_extending_freeze_late",
        patternKey: "pk_non_extending_freeze",
        success: false,
        userAction: "failed",
        regressionFlag: true,
      }).ok,
    ).toBe(true);

    expect(store.getSafetyState().isFrozen).toBe(false);
    const constrainedAlerts = store
      .getOpsSummary()
      .recentAlerts.filter((alert) => alert.alertType.startsWith("autonomy_lane_constrained:"));
    expect(constrainedAlerts).toHaveLength(1);
  });

  test("evaluator freezes only after independent root-objective evidence reaches minimum samples", () => {
    const store = makeStore();
    const internal = store as unknown as {
      config: {
        remotebuddy: {
          autonomy: {
            autoFreezeDurationMs: number;
          };
        };
      };
      runEvaluator: (nowIso?: string) => AutonomyEvaluatorScorecard;
    };
    internal.config.remotebuddy.autonomy.autoFreezeDurationMs = 60_000;

    for (let index = 0; index < 6; index += 1) {
      expect(
        store.recordOutcome({
          objectiveId: `obj_overlapping_freeze_${index}`,
          requestId: `req_overlapping_freeze_${index}`,
          jobId: `job_overlapping_freeze_${index}`,
          patternKey: index < 3 ? "pk_overlapping_freeze" : `pk_overlapping_freeze_${index}`,
          success: false,
          userAction: "failed",
          regressionFlag: true,
        }).ok,
      ).toBe(true);
    }

    expect(store.getSafetyState().isFrozen).toBe(false);
    const evaluatedAt = Date.now() + 1_000;
    const evaluated = internal.runEvaluator(new Date(evaluatedAt).toISOString());
    expect(evaluated.recommendation).toBe("pause");
    const freeze = store.getSafetyState(new Date(evaluatedAt).toISOString());
    expect(freeze.isFrozen).toBe(true);
    expect(freeze.freezeReason).toBe("auto_freeze:evaluator_pause");
    const freezeUntilMs = Date.parse(String(freeze.freezeUntil));

    const afterExpiry = new Date(freezeUntilMs + 1_000).toISOString();
    const unchangedEvidence = internal.runEvaluator(afterExpiry);
    expect(unchangedEvidence.recommendation).toBe("constrain");
    expect(store.getSafetyState(afterExpiry).isFrozen).toBe(false);
    expect(store.getSafetyState(afterExpiry).freezeReason).toBeNull();
  });

  test("does not re-arm an expired evaluator freeze without new terminal evidence", () => {
    const store = makeStore();
    const internal = store as unknown as {
      config: {
        remotebuddy: {
          autonomy: {
            autoFreezeDurationMs: number;
          };
        };
      };
      runEvaluator: (nowIso?: string) => AutonomyEvaluatorScorecard;
    };
    internal.config.remotebuddy.autonomy.autoFreezeDurationMs = 60_000;
    for (let index = 0; index < 6; index += 1) {
      expect(
        store.recordOutcome({
          objectiveId: `obj_freeze_evidence_${index}`,
          requestId: `req_freeze_evidence_${index}`,
          jobId: `job_freeze_evidence_${index}`,
          patternKey: `pk_freeze_evidence_${index}`,
          success: false,
          userAction: "failed",
          regressionFlag: true,
        }).ok,
      ).toBe(true);
    }

    const firstAtMs = Date.now() + 1_000;
    const first = internal.runEvaluator(new Date(firstAtMs).toISOString());
    expect(first.recommendation).toBe("pause");
    expect(store.getSafetyState(new Date(firstAtMs).toISOString()).isFrozen).toBe(true);

    const afterExpiry = new Date(firstAtMs + 61_000).toISOString();
    const unchanged = internal.runEvaluator(afterExpiry);
    expect(unchanged.recommendation).toBe("constrain");
    expect(store.getSafetyState(afterExpiry).isFrozen).toBe(false);
    expect(store.getSafetyState(afterExpiry).freezeReason).toBeNull();

    expect(
      store.recordOutcome({
        objectiveId: "obj_freeze_evidence_new",
        requestId: "req_freeze_evidence_new",
        jobId: "job_freeze_evidence_new",
        patternKey: "pk_freeze_evidence_new",
        success: false,
        userAction: "failed",
        regressionFlag: true,
      }).ok,
    ).toBe(true);
    const withNewEvidence = internal.runEvaluator(new Date(firstAtMs + 62_000).toISOString());
    expect(withNewEvidence.recommendation).toBe("pause");
    expect(store.getSafetyState().isFrozen).toBe(true);
  });

  test("does not globally freeze for a review backlog below the independent-root minimum", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-review-freeze-");
    const queue = new JobQueue(dbPath);
    try {
      const internal = store as unknown as {
        config: {
          remotebuddy: {
            autonomy: {
              autoFreezeDurationMs: number;
            };
          };
        };
        runEvaluator: (nowIso?: string) => AutonomyEvaluatorScorecard;
      };
      internal.config.remotebuddy.autonomy.autoFreezeDurationMs = 60_000;

      const enqueued = queue.enqueue({
        taskId: "review-freeze-health",
        sessionId: "dev",
        kind: "task.execute",
        params: { origin: "autonomy" },
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(queue.claim("worker-review-freeze").job?.id).toBe(jobId);
      expect(queue.complete(jobId, { summary: "published" }).ok).toBe(true);

      const snapshotId = store.createSnapshot({
        sessionId: "dev",
        runId: "run_review_freeze",
      }).snapshot_id;
      for (let index = 0; index < 5; index += 1) {
        expect(
          store.recordObjectiveDecision({
            runId: "run_review_freeze",
            snapshotId,
            sessionId: "dev",
            objective: {
              id: `obj_review_freeze_${index}`,
              title: `Review backlog item ${index}`,
              instruction: "Keep the published change pending until provider reconciliation.",
              objective_type: "docs",
              component_area: "docs",
              trigger_type: "queue_health",
              target_paths: [`docs/review-${index}.md`],
              scope: { read_anywhere: false, write_globs: [`docs/review-${index}.md`] },
              confidence: 0.9,
              risk_level: "low",
              expected_validation: ["git diff --check"],
              status: "awaiting_review",
            },
          }).ok,
        ).toBe(true);
      }

      const firstAtMs = Date.now() + 1_000;
      const db = (store as unknown as { db: any }).db;
      db.prepare(
        `UPDATE autonomy_objectives
         SET updated_at = ?, awaiting_review_since = ?
         WHERE id LIKE 'obj_review_freeze_%'`,
      ).run(
        new Date(firstAtMs - 25 * 60 * 60 * 1_000).toISOString(),
        new Date(firstAtMs - 25 * 60 * 60 * 1_000).toISOString(),
      );

      const first = internal.runEvaluator(new Date(firstAtMs).toISOString());
      expect(first.recommendation).toBe("constrain");
      expect(store.getSafetyState(new Date(firstAtMs).toISOString()).isFrozen).toBe(false);

      const afterExpiry = new Date(firstAtMs + 61_000).toISOString();
      const unchanged = internal.runEvaluator(afterExpiry);
      expect(unchanged.recommendation).toBe("constrain");
      expect(store.getSafetyState(afterExpiry).isFrozen).toBe(false);
    } finally {
      queue.close();
    }
  });

  test("raw child-job health constrains its lane but cannot globally freeze without root outcomes", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-job-health-");
    const queue = new JobQueue(dbPath);
    try {
      for (let index = 0; index < 10; index += 1) {
        const enqueued = queue.enqueue({
          taskId: `job-health-${index}`,
          sessionId: "dev",
          kind: "task.execute",
          params: {
            origin: "autonomy",
            autonomy: { targetPaths: ["app/(tabs)/_layout.tsx"] },
          },
        });
        expect(enqueued.ok).toBe(true);
        const claimed = queue.claim("worker-health");
        expect(claimed.ok).toBe(true);
        const jobId = String(claimed.job?.id ?? "");
        if (index < 7) {
          expect(queue.complete(jobId, { summary: "published" }).ok).toBe(true);
        } else {
          expect(
            queue.fail(jobId, {
              message: "validation timed out",
              diagnostics: {
                terminal: {
                  status: "failed",
                  failureClass: "validation_timeout",
                  terminalStage: "quality_gate",
                  summary: "focused validation timed out",
                },
              },
            }).ok,
          ).toBe(true);
        }
      }

      const card = runEvaluatorNow(store);
      expect(card.avgLatencyMs).toBeNull();
      expect(card.jobTerminalCount).toBe(10);
      expect(card.jobSuccessRate).toBeCloseTo(0.7);
      expect(card.jobTimeoutRate).toBeCloseTo(0.3);
      expect(card.recommendation).toBe("constrain");
      expect(store.getSafetyState().isFrozen).toBe(false);
    } finally {
      queue.close();
    }
  });

  test("classifies completed_no_change as no_change rather than job success", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-no-change-health-");
    const queue = new JobQueue(dbPath);
    try {
      for (const [suffix, summary] of [
        ["published", "published candidate"],
        ["no-change", "completed_no_change"],
      ] as const) {
        const enqueued = queue.enqueue({
          taskId: `health-${suffix}`,
          sessionId: "dev",
          kind: "task.execute",
          params: { origin: "autonomy", autonomy: { origin: "autonomy" } },
        });
        const jobId = String(enqueued.jobId);
        expect(queue.claim(`worker-health-${suffix}`).job?.id).toBe(jobId);
        expect(queue.complete(jobId, { summary }).ok).toBe(true);
      }
      const health = (
        store as unknown as {
          getAutonomyJobHealth(
            nowIso: string,
            windowHours: number,
          ): {
            terminalCount: number;
            successRate: number | null;
          };
        }
      ).getAutonomyJobHealth(new Date().toISOString(), 24);
      expect(health).toMatchObject({ terminalCount: 2, successRate: 0.5 });
      expect(queue.sloSummary()).toMatchObject({
        terminal: 2,
        completed: 2,
        noChange: 1,
        successRate: 0.5,
      });
    } finally {
      queue.close();
    }
  });

  test("five root objectives and eight failed child jobs do not satisfy the global freeze minimum", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-root-samples-");
    const queue = new JobQueue(dbPath);
    try {
      for (let index = 0; index < 8; index += 1) {
        const enqueued = queue.enqueue({
          taskId: `root-sample-child-${index}`,
          sessionId: "dev",
          kind: "task.execute",
          params: { origin: "autonomy", autonomy: { origin: "autonomy" } },
        });
        const jobId = String(enqueued.jobId ?? "");
        expect(queue.claim(`worker-root-sample-${index}`).job?.id).toBe(jobId);
        expect(
          queue.fail(jobId, {
            message: "critic unavailable before validation handoff",
            diagnostics: {
              terminal: {
                failureClass: "critic_unavailable",
                terminalStage: "quality_gate",
                summary: "critic unavailable before validation handoff",
              },
            },
          }).ok,
        ).toBe(true);
        expect(
          store.recordOutcome({
            objectiveId: `obj_root_sample_${index % 5}`,
            jobId,
            patternKey: `cluster_root_sample_${index % 5}`,
            success: false,
            userAction: "failed",
            regressionFlag: false,
          }).ok,
        ).toBe(true);
      }

      const card = runEvaluatorNow(store);
      expect(card.sampleCount).toBe(5);
      expect(card.jobTerminalCount).toBe(8);
      expect(card.recommendation).toBe("constrain");
      expect(store.getSafetyState().isFrozen).toBe(false);
    } finally {
      queue.close();
    }
  });

  test("clusters identical objective failures across adjacent target paths", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-adjacent-failures-");
    const queue = new JobQueue(dbPath);
    try {
      for (const [index, route] of ["alpha", "beta"].entries()) {
        const enqueued = queue.enqueue({
          taskId: `adjacent-failure-${route}`,
          sessionId: "dev",
          kind: "task.execute",
          params: {
            origin: "autonomy",
            autonomy: {
              origin: "autonomy",
              objectiveType: "flaky_test",
              visionObjectiveId: "vision:route-readiness",
              acceptanceCriteria: [
                `Route src/routes/${route}.ts becomes ready after ${index + 2} retries`,
              ],
              targetPaths: [`src/routes/${route}.ts`],
            },
          },
        });
        const jobId = String(enqueued.jobId ?? "");
        expect(queue.claim(`worker-adjacent-${route}`).job?.id).toBe(jobId);
        expect(
          queue.fail(jobId, {
            message: "route readiness assertion failed",
            diagnostics: {
              terminal: {
                failureClass: "test_failure",
                terminalStage: "focused_validation",
                summary: "route readiness assertion failed",
              },
              validationRuns: [
                {
                  attempt: 1,
                  command: "bun test tests/route-readiness.test.ts",
                  passed: false,
                  exitCode: 1,
                  failureClass: "test_failure",
                  stderrTail: "(fail) route readiness > restores the route shell",
                },
              ],
            },
          }).ok,
        ).toBe(true);
      }

      const card = runEvaluatorNow(store);
      expect(card.repeatedFailureCount).toBe(2);
      expect(card.recommendation).toBe("constrain");
      expect(store.getSafetyState().isFrozen).toBe(false);
    } finally {
      queue.close();
    }
  });

  test("ops alerts remain open without duplicate events and resolve when healthy", () => {
    const store = makeStore();
    const first = store.getOpsSummary({ requestPending: 25 });
    expect(
      first.recentAlerts.filter((alert) => alert.alertType === "request_queue_pending_high"),
    ).toHaveLength(1);

    const repeated = store.getOpsSummary({ requestPending: 30 });
    const openAlert = repeated.recentAlerts.find(
      (alert) => alert.alertType === "request_queue_pending_high",
    );
    expect(openAlert?.status).toBe("open");
    expect(openAlert?.occurrenceCount).toBe(2);

    const identical = store.getOpsSummary({ requestPending: 30 });
    const unchangedAlert = identical.recentAlerts.find(
      (alert) => alert.alertType === "request_queue_pending_high",
    );
    expect(unchangedAlert?.occurrenceCount).toBe(2);

    const observationless = store.getOpsSummary();
    const stillOpen = observationless.recentAlerts.find(
      (alert) => alert.alertType === "request_queue_pending_high",
    );
    expect(stillOpen?.status).toBe("open");
    expect(stillOpen?.occurrenceCount).toBe(2);

    const db = (store as unknown as { db: any }).db;
    const historyCount = db
      .prepare(
        `SELECT COUNT(*) AS count FROM autonomy_ops_alerts WHERE alert_type = 'request_queue_pending_high'`,
      )
      .get() as { count: number };
    expect(historyCount.count).toBe(1);

    const healthy = store.getOpsSummary({ requestPending: 0 });
    expect(
      healthy.recentAlerts.some((alert) => alert.alertType === "request_queue_pending_high"),
    ).toBe(false);
    const state = db
      .prepare(
        `SELECT status, resolved_at FROM autonomy_ops_alert_state WHERE alert_type = 'request_queue_pending_high'`,
      )
      .get() as { status: string; resolved_at: string | null };
    expect(state.status).toBe("resolved");
    expect(state.resolved_at).toBeTruthy();
  });

  test("ingestInspirationPatterns dedupes fingerprints and tracks source attribution", () => {
    const store = makeStore();
    const firstIngest = store.ingestInspirationPatterns({
      entries: [
        {
          source_type: "external_repo",
          source_label: "github:org/autonomy-lab",
          source_url: "https://github.com/org/autonomy-lab",
          algorithm: "queue pressure governor",
          when_to_use: "when workers are saturated and queue latency increases",
          summary: "Throttle autonomous dispatch based on queue pressure and worker occupancy.",
          risks: ["Over-throttling can starve useful work."],
          validation: ["Replay historical queue windows to verify throughput/latency tradeoff."],
          tags: ["backpressure", "scheduling"],
          quality_score: 0.82,
          freshness_score: 0.7,
          metadata: { license: "MIT" },
        },
      ],
    });
    expect(firstIngest.ok).toBe(true);
    expect(firstIngest.inserted).toBe(1);
    expect(firstIngest.updated).toBe(0);

    const secondIngest = store.ingestInspirationPatterns({
      entries: [
        {
          source_type: "external_doc",
          source_label: "docs:ops-handbook",
          source_url: "https://example.test/ops/handbook",
          algorithm: "queue pressure governor",
          when_to_use: "when workers are saturated and queue latency increases",
          summary: "Use dynamic dispatch throttles and release caps as pressure falls.",
          risks: ["Can mask structural capacity limits."],
          validation: ["A/B replay with synthetic burst traffic."],
          tags: ["backpressure", "safety"],
          quality_score: 0.74,
          freshness_score: 0.9,
          metadata: { section: "throughput-control" },
        },
      ],
    });
    expect(secondIngest.ok).toBe(true);
    expect(secondIngest.inserted).toBe(0);
    expect(secondIngest.updated).toBe(1);

    const all = store.listInspirationPatterns({ limit: 10 });
    expect(all.length).toBe(1);
    const pattern = all[0];
    expect(pattern.algorithm).toBe("queue pressure governor");
    expect(pattern.seenCount).toBe(2);
    expect(pattern.tags).toContain("backpressure");
    expect(pattern.tags).toContain("safety");
    expect(pattern.sourceRefs.some((ref) => ref.includes("github.com"))).toBe(true);
    expect(pattern.sourceRefs.some((ref) => ref.includes("ops/handbook"))).toBe(true);

    const tagFiltered = store.listInspirationPatterns({ tag: "safety", limit: 10 });
    expect(tagFiltered.length).toBe(1);
    const queryFiltered = store.listInspirationPatterns({
      q: "queue latency",
      limit: 10,
    });
    expect(queryFiltered.length).toBe(1);
  });

  test("answerQuestion returns resume context and objective can be re-dispatched automatically", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_question_resume",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_question_resume",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_question_resume",
        candidate_id: "cand_question_resume",
        title: "Clarify queue priority objective",
        instruction: "Implement queue backpressure guardrail for autonomous dispatch.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["apps/server/src/autonomy.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
        confidence: 0.92,
        risk_level: "low",
        expected_validation: ["bun run test:root"],
        status: "blocked",
        block_reason: "requires_user_input",
      },
      question: {
        id: "q_question_resume",
        question: "Which queue class should receive priority under contention?",
        question_type: "bounded_text",
        expected_answer_schema: { min_length: 3, max_length: 300 },
      },
    });
    expect(decision.ok).toBe(true);

    const answered = store.answerQuestion(
      "q_question_resume",
      "Prioritize interactive tasks first, then normal, while capping background dispatch.",
    );
    expect(answered.ok).toBe(true);
    expect(answered.status).toBe("valid");
    expect(answered.objectiveId).toBe("obj_question_resume");
    expect(answered.resume?.objectiveId).toBe("obj_question_resume");
    expect(answered.resume?.sessionId).toBe("s1");
    expect(answered.resume?.runId).toBe("run_question_resume");
    expect(answered.resume?.snapshotId).toBe(snapshotId);
    expect(answered.resume?.patternKey).toBe(decision.patternKey);
    expect(answered.resume?.componentArea).toBe("apps/server");
    expect(answered.resume?.targetPaths).toEqual(["apps/server/src/autonomy.ts"]);
    expect(answered.resume?.writeGlobs).toEqual(["apps/server/src/*"]);
    expect(answered.resume?.idempotencyKey).toBe("autonomy_resume:q_question_resume");
    expect(String(answered.resume?.instruction ?? "")).toContain(
      "Prioritize interactive tasks first",
    );

    const db = (store as unknown as { db: any }).db;
    const gatedBeforeDispatch = db
      .prepare(`SELECT status FROM autonomy_objectives WHERE id = ?`)
      .get("obj_question_resume") as { status: string };
    expect(gatedBeforeDispatch.status).toBe("gated");

    store.markObjectiveDispatched("obj_question_resume", "req_question_resume");
    const dispatched = db
      .prepare(`SELECT status, request_id FROM autonomy_objectives WHERE id = ?`)
      .get("obj_question_resume") as { status: string; request_id: string | null };
    expect(dispatched.status).toBe("dispatched");
    expect(dispatched.request_id).toBe("req_question_resume");
  });

  test("markObjectiveRunningByJobId promotes linked objectives to running", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_running_state",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_running_state",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_running_state",
        candidate_id: "cand_running_state",
        title: "Promote objective to running on claim",
        instruction: "Run a scoped lint fix",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.91,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
        request_id: "req_running_state",
      },
    });
    expect(decision.ok).toBe(true);

    store.linkJobToObjectiveByRequest("req_running_state", "job_running_state");
    store.markObjectiveRunningByJobId("job_running_state");

    const db = (store as unknown as { db: any }).db;
    const row = db
      .prepare(`SELECT status, job_id FROM autonomy_objectives WHERE id = ?`)
      .get("obj_running_state") as { status: string; job_id: string | null };
    expect(row.status).toBe("running");
    expect(row.job_id).toBe("job_running_state");
  });

  test("resolves autonomous outcome context from job metadata when objective persistence is absent", () => {
    const store = makeStore();
    const context = store.resolveJobOutcomeContext("job_metadata_fallback", {
      origin: "autonomy",
      requestId: "req_metadata_fallback",
      autonomy: {
        objectiveId: "obj_metadata_fallback",
        patternKey: "pattern.metadata.fallback",
      },
    });

    expect(context).toEqual({
      objectiveId: "obj_metadata_fallback",
      requestId: "req_metadata_fallback",
      patternKey: "pattern.metadata.fallback",
    });
    expect(
      store.recordOutcome({
        ...context,
        jobId: "job_metadata_fallback",
        success: false,
        userAction: "failed",
        regressionFlag: true,
      }).ok,
    ).toBe(true);
    expect(runEvaluatorNow(store).sampleCount).toBe(1);
  });

  test("safety state kill switch blocks eligibility", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_safety_gate",
    }).snapshot_id;
    const toggled = store.updateSafetyState({ killSwitchEnabled: true });
    expect(toggled.ok).toBe(true);
    expect(toggled.state.killSwitchEnabled).toBe(true);

    const result = store.evaluateEligibility({
      runId: "run_safety_gate",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_safety_gate",
          objective_type: "lint_fix",
          component_area: "apps/server",
          pattern_key: "pk_safety_gate",
          confidence: 0.95,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.results?.[0]?.ok).toBe(false);
    expect(String(result.results?.[0]?.reason ?? "")).toContain("kill switch");
  });

  test("question actions support skip/close/escalate", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_question_actions",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_question_actions",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_question_actions",
        candidate_id: "cand_question_actions",
        title: "Question action target",
        instruction: "Need user preference.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "blocked",
      },
      question: {
        id: "q_question_actions",
        question: "Continue with strict priority?",
        question_type: "bounded_text",
        expected_answer_schema: { min_length: 3, max_length: 300 },
      },
    });
    expect(decision.ok).toBe(true);

    const escalated = store.actOnQuestion("q_question_actions", "escalate", "Need manual call");
    expect(escalated.ok).toBe(true);
    expect(escalated.action).toBe("escalate");

    const db = (store as unknown as { db: any }).db;
    const questionRow = db
      .prepare(`SELECT status, closed_reason FROM questions_queue WHERE id = ?`)
      .get("q_question_actions") as { status: string; closed_reason: string | null };
    expect(questionRow.status).toBe("closed");
    expect(questionRow.closed_reason).toBe("escalated_to_human");
    const objectiveRow = db
      .prepare(`SELECT status, block_reason FROM autonomy_objectives WHERE id = ?`)
      .get("obj_question_actions") as { status: string; block_reason: string | null };
    expect(objectiveRow.status).toBe("escalated");
    expect(objectiveRow.block_reason).toBe("escalated_to_human");
  });

  test("stale objective sweeper dead-letters stale active objectives", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_stale_sweep",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_stale_sweep",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_stale_sweep",
        candidate_id: "cand_stale_sweep",
        title: "Stale objective candidate",
        instruction: "Test stale sweep.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/autonomy.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.92,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });
    expect(decision.ok).toBe(true);
    const reviewDecision = store.recordObjectiveDecision({
      runId: "run_stale_sweep",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_stale_review",
        title: "Published objective under provider review",
        instruction: "Keep provider review state pending until reconciled.",
        objective_type: "docs",
        component_area: "docs",
        trigger_type: "queue_health",
        target_paths: ["docs/guide.md"],
        scope: { read_anywhere: false, write_globs: ["docs/guide.md"] },
        confidence: 0.92,
        risk_level: "low",
        expected_validation: ["git diff --check"],
        status: "awaiting_review",
      },
    });
    expect(reviewDecision.ok).toBe(true);
    const db = (store as unknown as { db: any }).db;
    db.prepare(
      `UPDATE autonomy_objectives SET updated_at = datetime('now', '-5 hours') WHERE id = ?`,
    ).run("obj_stale_sweep");
    db.prepare(
      `UPDATE autonomy_objectives SET updated_at = datetime('now', '-3 days') WHERE id = ?`,
    ).run("obj_stale_review");

    const sweep = store.maybeSweepStaleObjectives(new Date(Date.now() + 120_000).toISOString());
    expect(sweep.ok).toBe(true);
    expect(sweep.deadLettered).toBeGreaterThanOrEqual(1);
    const objectiveRow = db
      .prepare(`SELECT status, block_reason FROM autonomy_objectives WHERE id = ?`)
      .get("obj_stale_sweep") as { status: string; block_reason: string | null };
    expect(objectiveRow.status).toBe("dead_letter");
    expect(objectiveRow.block_reason).toBe("stale_objective_timeout");
    expect(autonomyObjectiveStatus(store, "obj_stale_review")).toBe("awaiting_review");
  });

  test("restart recovery sweep closes stale blocked objective + question without orphans", () => {
    const { store: firstStore, dbPath } = makePersistentStore("pushpals-autonomy-recovery-");
    const snapshotId = firstStore.createSnapshot({
      sessionId: "s1",
      runId: "run_restart_recovery",
    }).snapshot_id;
    const created = firstStore.recordObjectiveDecision({
      runId: "run_restart_recovery",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_restart_recovery",
        candidate_id: "cand_restart_recovery",
        title: "Pending clarification objective",
        instruction: "Need clarification before dispatch.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "blocked",
        block_reason: "requires_user_input",
      },
      question: {
        id: "q_restart_recovery",
        question: "Should interactive requests always preempt background work?",
        question_type: "bounded_text",
        expected_answer_schema: { min_length: 3, max_length: 300 },
      },
    });
    expect(created.ok).toBe(true);

    const firstDb = (firstStore as unknown as { db: any }).db;
    firstDb
      .prepare(
        `UPDATE autonomy_objectives SET updated_at = datetime('now', '-6 hours') WHERE id = ?`,
      )
      .run("obj_restart_recovery");

    closeTrackedStore(firstStore);
    const resumedStore = new AutonomyStore(dbPath);
    stores.push(resumedStore);

    const sweep = resumedStore.maybeSweepStaleObjectives(
      new Date(Date.now() + 120_000).toISOString(),
    );
    expect(sweep.ok).toBe(true);
    expect(sweep.deadLettered).toBeGreaterThanOrEqual(1);

    const resumedDb = (resumedStore as unknown as { db: any }).db;
    const objectiveRow = resumedDb
      .prepare(`SELECT status, block_reason FROM autonomy_objectives WHERE id = ?`)
      .get("obj_restart_recovery") as { status: string; block_reason: string | null };
    expect(objectiveRow.status).toBe("dead_letter");
    expect(objectiveRow.block_reason).toBe("stale_objective_timeout");
    const questionRow = resumedDb
      .prepare(`SELECT status, closed_reason FROM questions_queue WHERE id = ?`)
      .get("q_restart_recovery") as { status: string; closed_reason: string | null };
    expect(questionRow.status).toBe("closed");
    expect(questionRow.closed_reason).toBe("stale_objective_timeout");
  });

  test("keeps one active objective per validation incident across runs", () => {
    const store = makeStore();
    const firstSnapshot = store.createSnapshot({ sessionId: "s1", runId: "run_incident_a" });
    const objective = (id: string, runId: string, snapshotId: string) => ({
      runId,
      snapshotId,
      sessionId: "s1",
      objective: {
        id,
        title: "Repair exact validation incident",
        instruction: "Fix the evidence-backed failing test.",
        objective_type: "flaky_test",
        component_area: "tests",
        trigger_type: "test_failure",
        target_paths: ["tests/account.test.ts"],
        scope: { read_anywhere: false, write_globs: ["tests/account.test.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun test tests/account.test.ts"],
        status: "gated",
        required_validation_repair: true,
        incident_key: "valid_inc_exact_failure",
        evidence: {
          validation_incident: { incident_id: "valid_inc_exact_failure" },
        },
      },
    });
    expect(
      store.recordObjectiveDecision(
        objective("obj_incident_a", "run_incident_a", firstSnapshot.snapshot_id),
      ).ok,
    ).toBe(true);

    const secondSnapshot = store.createSnapshot({ sessionId: "s1", runId: "run_incident_b" });
    const duplicate = store.recordObjectiveDecision(
      objective("obj_incident_b", "run_incident_b", secondSnapshot.snapshot_id),
    );
    expect(duplicate.ok).toBe(false);
    expect(duplicate.objectiveId).toBe("obj_incident_a");
    expect(duplicate.reason).toContain("already has active objective");
  });

  test("reconciles worker-required requests to jobs or fails the orphan quickly", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-handoff-");
    const requests = new RequestQueue(dbPath);
    const jobs = new JobQueue(dbPath);
    try {
      const snapshot = store.createSnapshot({ sessionId: "s1", runId: "run_handoff" });
      const seedObjective = (
        id: string,
        targetPath = "apps/server/src/requests.ts",
        runId = "run_handoff",
        snapshotId = snapshot.snapshot_id,
        status: "gated" | "proposed" = "gated",
      ) =>
        store.recordObjectiveDecision({
          runId,
          snapshotId,
          sessionId: "s1",
          objective: {
            id,
            title: `Handoff ${id}`,
            instruction: "Create a durable worker handoff.",
            objective_type: "small_refactor",
            component_area: "apps/server",
            trigger_type: "queue_health",
            target_paths: [targetPath],
            scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
            confidence: 0.95,
            risk_level: "low",
            expected_validation: ["bun test tests/server.requests-queue.test.ts"],
            status,
          },
        });

      expect(seedObjective("obj_handoff_linked").ok).toBe(true);
      const linkedRequest = requests.enqueue({
        sessionId: "s1",
        prompt: "linked handoff",
        idempotencyKey: "autonomy:obj_handoff_linked",
      });
      store.markObjectiveDispatched("obj_handoff_linked", linkedRequest.requestId ?? "");
      const linkedJob = jobs.enqueue({
        taskId: "task_handoff_linked",
        sessionId: "s1",
        kind: "task.execute",
        params: {
          requestId: linkedRequest.requestId,
          origin: "autonomy",
          autonomy: { origin: "autonomy" },
        },
      });
      expect(store.reconcileObjectiveWorkerHandoffs()).toMatchObject({ linked: 1, failed: 0 });
      const db = (store as unknown as { db: any }).db;
      const promoteProposedObjectiveToGated = (objectiveId: string): void => {
        const promoted = db
          .prepare(
            `UPDATE autonomy_objectives
             SET status = 'gated'
             WHERE id = ? AND status = 'proposed'`,
          )
          .run(objectiveId);
        expect(promoted.changes).toBe(1);
      };
      expect(
        db.prepare(`SELECT job_id FROM autonomy_objectives WHERE id = ?`).get("obj_handoff_linked")
          .job_id,
      ).toBe(linkedJob.jobId);
      expect(requests.getRequest(linkedRequest.requestId ?? "")).toMatchObject({
        status: "completed",
        workerRequired: 1,
        handoffJobId: linkedJob.jobId,
        agentId: null,
        claimToken: null,
      });
      db.prepare(`UPDATE autonomy_objectives SET status = 'completed' WHERE id = ?`).run(
        "obj_handoff_linked",
      );

      expect(seedObjective("obj_handoff_orphan").ok).toBe(true);
      const orphanRequest = requests.enqueue({
        sessionId: "s1",
        prompt: "orphan handoff",
        idempotencyKey: "autonomy:obj_handoff_orphan",
      });
      store.markObjectiveDispatched("obj_handoff_orphan", orphanRequest.requestId ?? "");
      const orphanClaim = requests.claim("remote-handoff").request;
      expect(orphanClaim?.id).toBe(orphanRequest.requestId);
      expect(
        requests.complete(orphanRequest.requestId ?? "", {
          agentId: "remote-handoff",
          claimToken: orphanClaim?.claimToken,
          result: { requiresWorker: true },
        }).ok,
      ).toBe(true);
      db.prepare(`UPDATE autonomy_objectives SET updated_at = ? WHERE id = ?`).run(
        "2026-08-17T00:00:00.000Z",
        "obj_handoff_orphan",
      );
      const reconciled = store.reconcileObjectiveWorkerHandoffs("2026-08-17T00:01:00.000Z", 5_000);
      expect(reconciled.failed).toBe(1);
      expect(
        db
          .prepare(`SELECT status, block_reason FROM autonomy_objectives WHERE id = ?`)
          .get("obj_handoff_orphan"),
      ).toMatchObject({
        status: "failed",
        block_reason: "worker_handoff_missing_after_request_completion",
      });

      const slowSnapshot = store.createSnapshot({ sessionId: "s1", runId: "run_handoff_slow" });
      expect(
        seedObjective(
          "obj_handoff_in_flight",
          "apps/server/src/jobs.ts",
          "run_handoff_slow",
          slowSnapshot.snapshot_id,
          "proposed",
        ),
      ).toMatchObject({ ok: true });
      promoteProposedObjectiveToGated("obj_handoff_in_flight");
      const inFlightRequest = requests.enqueue({
        sessionId: "s1",
        prompt: "slow but healthy planner handoff",
        idempotencyKey: "autonomy:obj_handoff_in_flight",
      });
      expect(
        store.markObjectiveDispatched("obj_handoff_in_flight", inFlightRequest.requestId ?? ""),
      ).toBe(true);
      expect(requests.claim("remote-slow-planner").request?.id).toBe(inFlightRequest.requestId);
      db.prepare(`UPDATE autonomy_objectives SET updated_at = ? WHERE id = ?`).run(
        "2026-08-17T00:00:00.000Z",
        "obj_handoff_in_flight",
      );
      expect(store.reconcileObjectiveWorkerHandoffs("2026-08-17T00:01:00.000Z")).toMatchObject({
        failed: 0,
        pending: 1,
      });
      expect(
        db
          .prepare(`SELECT status FROM autonomy_objectives WHERE id = ?`)
          .get("obj_handoff_in_flight").status,
      ).toBe("dispatched");

      const expiredSnapshot = store.createSnapshot({
        sessionId: "s1",
        runId: "run_handoff_expired_lease",
      });
      expect(
        seedObjective(
          "obj_handoff_expired_lease",
          "apps/server/src/autonomy.ts",
          "run_handoff_expired_lease",
          expiredSnapshot.snapshot_id,
          "proposed",
        ).ok,
      ).toBe(true);
      promoteProposedObjectiveToGated("obj_handoff_expired_lease");
      const expiredRequest = requests.enqueue({
        sessionId: "s1",
        prompt: "planner whose completion lease expires",
        idempotencyKey: "autonomy:obj_handoff_expired_lease",
      });
      expect(
        store.markObjectiveDispatched("obj_handoff_expired_lease", expiredRequest.requestId ?? ""),
      ).toBe(true);
      expect(requests.claim("remote-expired-planner").request?.id).toBe(expiredRequest.requestId);
      db.prepare(`UPDATE autonomy_objectives SET updated_at = ? WHERE id = ?`).run(
        "2026-08-17T00:00:00.000Z",
        "obj_handoff_expired_lease",
      );
      db.prepare(
        `UPDATE requests
         SET leaseExpiresAt = ?, lastHeartbeatAt = ?, updatedAt = ?
         WHERE id = ?`,
      ).run(
        "2026-08-17T00:00:30.000Z",
        "2026-08-17T00:00:59.500Z",
        "2026-08-17T00:00:59.500Z",
        expiredRequest.requestId,
      );
      expect(
        store.reconcileObjectiveWorkerHandoffs("2026-08-17T00:01:00.000Z", 5_000),
      ).toMatchObject({ failed: 0 });
      expect(
        db
          .prepare(`SELECT status, block_reason FROM autonomy_objectives WHERE id = ?`)
          .get("obj_handoff_expired_lease"),
      ).toMatchObject({
        status: "dispatched",
        block_reason: null,
      });
      expect(requests.getRequest(expiredRequest.requestId ?? "")).toMatchObject({
        status: "pending",
        agentId: null,
        claimToken: null,
      });

      const pendingSnapshot = store.createSnapshot({
        sessionId: "s1",
        runId: "run_handoff_pending_restart",
      });
      expect(
        seedObjective(
          "obj_handoff_pending_restart",
          "apps/server/src/server_main.ts",
          "run_handoff_pending_restart",
          pendingSnapshot.snapshot_id,
          "proposed",
        ).ok,
      ).toBe(true);
      promoteProposedObjectiveToGated("obj_handoff_pending_restart");
      const pendingRequest = requests.enqueue({
        sessionId: "s1",
        prompt: "old pending work remains retryable",
        idempotencyKey: "autonomy:obj_handoff_pending_restart",
      });
      expect(
        store.markObjectiveDispatched(
          "obj_handoff_pending_restart",
          pendingRequest.requestId ?? "",
        ),
      ).toBe(true);
      db.prepare(`UPDATE autonomy_objectives SET updated_at = ? WHERE id = ?`).run(
        "2026-08-16T00:00:00.000Z",
        "obj_handoff_pending_restart",
      );
      const wrongSessionJob = jobs.enqueue({
        taskId: "task_handoff_wrong_session",
        sessionId: "other-session",
        kind: "task.execute",
        params: { requestId: pendingRequest.requestId },
      });
      const malformedJob = jobs.enqueue({
        taskId: "task_handoff_malformed_params",
        sessionId: "s1",
        kind: "task.execute",
        params: { requestId: pendingRequest.requestId },
      });
      db.prepare(`UPDATE jobs SET params = ? WHERE id = ?`).run("{malformed", malformedJob.jobId);
      expect(
        store.reconcileObjectiveWorkerHandoffs("2026-08-17T00:01:00.000Z", 5_000),
      ).toMatchObject({ failed: 0, linked: 0 });
      expect(requests.getRequest(pendingRequest.requestId ?? "")?.status).toBe("pending");
      expect(
        db
          .prepare(`SELECT status, job_id FROM autonomy_objectives WHERE id = ?`)
          .get("obj_handoff_pending_restart"),
      ).toMatchObject({ status: "dispatched", job_id: null });
      expect(wrongSessionJob.ok).toBe(true);
    } finally {
      requests.close();
      jobs.close();
    }
  });

  test("does not reconcile a reopened request to a stale job from its prior attempt", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-handoff-retry-");
    const requests = new RequestQueue(dbPath);
    const jobs = new JobQueue(dbPath);
    try {
      const snapshot = store.createSnapshot({ sessionId: "s1", runId: "run_handoff_retry" });
      expect(
        store.recordObjectiveDecision({
          runId: "run_handoff_retry",
          snapshotId: snapshot.snapshot_id,
          sessionId: "s1",
          objective: {
            id: "obj_handoff_retry",
            title: "Retry a failed planning handoff",
            instruction: "Create a fresh durable worker handoff.",
            objective_type: "small_refactor",
            component_area: "apps/server",
            trigger_type: "queue_health",
            target_paths: ["apps/server/src/requests.ts"],
            scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
            confidence: 0.95,
            risk_level: "low",
            expected_validation: ["bun test tests/server.requests-queue.test.ts"],
            status: "gated",
          },
        }).ok,
      ).toBe(true);

      const first = requests.enqueue({
        sessionId: "s1",
        prompt: "first planning attempt",
        idempotencyKey: "autonomy:obj_handoff_retry",
      });
      const firstClaim = requests.claim("remote-retry").request;
      expect(firstClaim?.id).toBe(first.requestId);
      expect(
        requests.fail(first.requestId ?? "", {
          agentId: "remote-retry",
          claimToken: firstClaim?.claimToken,
          message: "planner crashed before retry",
        }).ok,
      ).toBe(true);

      const staleJob = jobs.enqueue({
        taskId: "task_handoff_stale_prior_attempt",
        sessionId: "s1",
        kind: "task.execute",
        params: { requestId: first.requestId, origin: "autonomy" },
      });
      const retried = requests.enqueue({
        sessionId: "s1",
        prompt: "second planning attempt",
        idempotencyKey: "autonomy:obj_handoff_retry",
      });
      expect(retried).toMatchObject({ ok: true, requestId: first.requestId, requeued: true });
      store.markObjectiveDispatched("obj_handoff_retry", retried.requestId ?? "");

      const db = (store as unknown as { db: any }).db;
      db.prepare(`UPDATE jobs SET createdAt = ? WHERE id = ?`).run(
        "2026-08-17T00:00:00.000Z",
        staleJob.jobId,
      );
      db.prepare(`UPDATE requests SET enqueuedAt = ?, updatedAt = ? WHERE id = ?`).run(
        "2026-08-17T00:01:00.000Z",
        "2026-08-17T00:01:00.000Z",
        retried.requestId,
      );

      expect(store.reconcileObjectiveWorkerHandoffs("2026-08-17T00:02:00.000Z")).toMatchObject({
        linked: 0,
        failed: 0,
        pending: 1,
      });
      expect(requests.getRequest(retried.requestId ?? "")).toMatchObject({
        status: "pending",
        handoffJobId: null,
      });
      expect(
        db
          .prepare(`SELECT status, job_id FROM autonomy_objectives WHERE id = ?`)
          .get("obj_handoff_retry"),
      ).toMatchObject({ status: "dispatched", job_id: null });
    } finally {
      requests.close();
      jobs.close();
    }
  });

  test("reports attempt outcome taxonomy instead of one undifferentiated failure rate", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-reliability-");
    const jobs = new JobQueue(dbPath);
    try {
      const finish = (
        suffix: string,
        outcome: "completed" | "failed" | "publish_blocked",
        failureClass?: string,
        terminalStage?: string,
      ) => {
        const enqueued = jobs.enqueue({
          taskId: `task_${suffix}`,
          sessionId: "s1",
          kind: "task.execute",
          params: { origin: "autonomy", autonomy: { origin: "autonomy" } },
        });
        const jobId = enqueued.jobId ?? "";
        expect(jobs.claim(`worker_${suffix}`).job?.id).toBe(jobId);
        if (outcome === "completed") {
          expect(jobs.complete(jobId, { summary: failureClass ?? "published" }).ok).toBe(true);
        } else if (outcome === "publish_blocked") {
          expect(
            jobs.publishBlocked(jobId, {
              message: failureClass,
              diagnostics: {
                terminal: {
                  failureClass,
                  terminalStage: terminalStage ?? "publication",
                  summary: failureClass,
                },
              },
            }).ok,
          ).toBe(true);
        } else {
          expect(
            jobs.fail(jobId, {
              message: failureClass,
              diagnostics: {
                terminal: {
                  failureClass,
                  terminalStage:
                    terminalStage ?? (failureClass?.includes("artifact") ? "quality" : "docker"),
                  summary: failureClass,
                },
              },
            }).ok,
          ).toBe(true);
        }
      };
      finish("success", "completed");
      finish("success_regression_fix", "completed", "fixed regression");
      finish("no_change", "failed", "artifact_only_no_publishable_patch");
      finish("environment", "failed", "missing_runtime_asset");
      finish("completed_no_change", "completed", "completed_no_change");
      finish("publish_environment", "publish_blocked", "missing_runtime_asset");
      finish("quality_rejected", "failed", "critic_rejected", "quality_gate");
      finish("critic_unavailable", "failed", "critic_unavailable", "quality_gate");
      finish("regression", "failed", "regression_detected", "post_publish");
      finish(
        "trusted_validation",
        "publish_blocked",
        "trusted_validation_failed",
        "trusted_environment_validation",
      );

      const metrics = store.getReliabilityMetrics();
      expect(metrics.attemptsTotal).toBe(10);
      expect(metrics.outcomeCounts).toMatchObject({
        succeeded: 2,
        no_change: 2,
        environment_blocked: 2,
        validation_blocked: 1,
        product_quality_failed: 1,
        orchestration_failed: 1,
        regression_detected: 1,
      });
      expect(metrics.attemptSuccessRate).toBeCloseTo(2 / 10, 5);
    } finally {
      jobs.close();
    }
  });

  test("snapshot circuit evidence excludes environment, infrastructure, and unexecuted handoffs", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-circuit-evidence-");
    const jobs = new JobQueue(dbPath);
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_circuit_evidence_seed",
    }).snapshot_id;
    const db = (store as unknown as { db: any }).db;
    const seedObjective = (id: string, targetPath: string) => {
      const decision = store.recordObjectiveDecision({
        runId: "run_circuit_evidence_seed",
        snapshotId,
        sessionId: "s1",
        objective: {
          id,
          title: `Circuit evidence ${id}`,
          instruction: "Exercise one repair attempt outcome.",
          objective_type: "flaky_test",
          component_area: "tests",
          trigger_type: "test_failure",
          target_paths: [targetPath],
          scope: { read_anywhere: false, write_globs: [targetPath] },
          confidence: 0.95,
          risk_level: "low",
          expected_validation: ["bun test"],
          status: "rejected",
          incident_key: "valid_inc_circuit_evidence",
        },
      });
      expect(decision.ok).toBe(true);
    };
    const failLinkedJob = (objectiveId: string, suffix: string, failureClass: string): void => {
      const enqueued = jobs.enqueue({
        taskId: `task-circuit-evidence-${suffix}`,
        sessionId: "s1",
        kind: "task.execute",
        params: { origin: "autonomy", autonomy: { origin: "autonomy" } },
        dedupeKey: `circuit-evidence:${suffix}`,
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(jobs.claim(`worker-circuit-evidence-${suffix}`).job?.id).toBe(jobId);
      expect(
        jobs.fail(jobId, {
          message: failureClass,
          diagnostics: {
            terminal: {
              failureClass,
              terminalStage:
                failureClass === "test_failure" ? "trusted_environment_validation" : "executor",
              summary: failureClass,
            },
            ...(failureClass === "test_failure"
              ? {
                  validationRuns: [
                    {
                      attempt: 1,
                      command: "bun test tests/circuit-validation.test.ts",
                      passed: false,
                      exitCode: 1,
                      failureClass: "test_failure",
                      stderrTail: "(fail) circuit validation remains broken",
                      metadata: {
                        failedTests: ["circuit validation remains broken"],
                        targetPathHints: ["tests/circuit-validation.test.ts"],
                        failureLines: ["(fail) circuit validation remains broken"],
                      },
                    },
                  ],
                }
              : {}),
          },
        }).ok,
      ).toBe(true);
      db.prepare(
        `UPDATE autonomy_objectives
         SET status = 'failed', job_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(jobId, new Date().toISOString(), objectiveId);
    };

    try {
      seedObjective("obj_circuit_validation", "tests/circuit-validation.test.ts");
      failLinkedJob("obj_circuit_validation", "validation", "test_failure");
      seedObjective("obj_circuit_environment", "tests/circuit-environment.test.ts");
      failLinkedJob("obj_circuit_environment", "environment", "missing_runtime_asset");
      seedObjective("obj_circuit_infrastructure", "tests/circuit-infrastructure.test.ts");
      failLinkedJob("obj_circuit_infrastructure", "infrastructure", "worker_process_exit");
      seedObjective("obj_circuit_handoff", "tests/circuit-handoff.test.ts");
      db.prepare(
        `UPDATE autonomy_objectives SET status = 'failed', updated_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), "obj_circuit_handoff");

      const recent = store.createSnapshot({
        sessionId: "s1",
        runId: "run_circuit_evidence_assert",
      }).recent_objectives;
      const byId = new Map(recent.map((objective) => [objective.objective_id, objective]));
      expect(byId.get("obj_circuit_validation")).toMatchObject({
        attempt_outcome: "validation_blocked",
        deterministic_repair_failure: true,
        attempt_failure_fingerprint: expect.any(String),
      });
      expect(byId.get("obj_circuit_environment")).toMatchObject({
        attempt_outcome: "environment_blocked",
        deterministic_repair_failure: false,
      });
      expect(byId.get("obj_circuit_infrastructure")).toMatchObject({
        attempt_outcome: "orchestration_failed",
        deterministic_repair_failure: false,
      });
      expect(byId.get("obj_circuit_handoff")).toMatchObject({
        job_id: null,
        attempt_outcome: null,
        deterministic_repair_failure: false,
      });
    } finally {
      jobs.close();
    }
  });

  test("durably tombstones repeated stale provider feedback so reconciliation can advance", () => {
    const { store, dbPath } = makePersistentStore("pushpals-provider-tombstone-");
    const jobs = new JobQueue(dbPath);
    const feedback = {
      feedbackKey: "review-agent:stale-provider-observation:697",
      jobId: "job-that-was-pruned",
      prUrl: "https://github.com/example/repo/pull/697",
      verdict: "rejected",
    };

    try {
      const first = store.recordPrFeedback(feedback);
      expect(first).toMatchObject({
        ok: true,
        ignored: true,
        acknowledged: false,
        retryable: true,
        reason: "PR feedback jobId does not identify a persisted job",
      });
      expect(first.deduped).toBeUndefined();
      expect(store.recordPrFeedback(feedback)).toMatchObject({
        ok: true,
        ignored: true,
        acknowledged: false,
        retryable: true,
      });
      expect(store.recordPrFeedback(feedback)).toMatchObject({
        ok: true,
        ignored: true,
        acknowledged: false,
        retryable: true,
      });
      const db = (store as unknown as { db: any }).db;
      db.prepare(
        `UPDATE autonomy_pr_feedback_tombstones
         SET first_seen_at = ?
         WHERE feedback_key = ?`,
      ).run(new Date(Date.now() - 11 * 60_000).toISOString(), feedback.feedbackKey);
      expect(store.recordPrFeedback(feedback)).toMatchObject({
        ok: true,
        ignored: true,
        acknowledged: true,
        deduped: true,
      });
      expect(store.recordPrFeedback({ ...feedback, verdict: "approved_merged" })).toMatchObject({
        ok: false,
        reason: "feedbackKey identifies a different tombstoned provider observation",
      });

      expect(
        db
          .prepare(
            `SELECT reason, disposition, occurrence_count AS occurrenceCount
             FROM autonomy_pr_feedback_tombstones
             WHERE feedback_key = ?`,
          )
          .get(feedback.feedbackKey),
      ).toMatchObject({
        reason: "PR feedback jobId does not identify a persisted job",
        disposition: "permanent",
        occurrenceCount: 4,
      });
    } finally {
      jobs.close();
    }
  });

  test("acknowledges an explicitly pruned provider authority without waiting for staleness", () => {
    const { store, dbPath } = makePersistentStore("pushpals-explicit-pruned-authority-");
    const jobs = new JobQueue(dbPath);
    try {
      const result = store.recordPrFeedback({
        feedbackKey: "review-agent:explicit-pruned-authority:901",
        jobId: "explicitly-pruned-job",
        prUrl: "https://github.com/example/repo/pull/901",
        verdict: "closed_unmerged",
        providerAuthorityPruned: true,
      });
      expect(result).toMatchObject({
        ok: true,
        ignored: true,
        acknowledged: true,
        deduped: true,
      });
    } finally {
      jobs.close();
    }
  });

  test("retries provider authority ordering gaps and applies them once the PR link arrives", () => {
    const { store, dbPath } = makePersistentStore("pushpals-provider-ordering-gap-");
    const queue = new JobQueue(dbPath);
    try {
      const prUrl = "https://github.com/example/repo/pull/812";
      const enqueued = queue.enqueue({
        taskId: "provider-ordering-gap",
        sessionId: "dev",
        kind: "task.execute",
        params: {
          origin: "autonomy",
          autonomy: {
            origin: "autonomy",
            objectiveId: "obj-provider-ordering-gap",
            patternKey: "cluster-provider-ordering-gap",
          },
        },
      });
      const jobId = String(enqueued.jobId);
      const feedback = {
        feedbackKey: "provider-ordering-gap:812",
        jobId,
        prUrl,
        verdict: "approved_merged",
      };
      expect(store.recordPrFeedback(feedback)).toMatchObject({
        ok: true,
        ignored: true,
        acknowledged: false,
        retryable: true,
      });

      expect(queue.claim("worker-provider-ordering-gap").job?.id).toBe(jobId);
      expect(queue.complete(jobId, { summary: "published", prUrl }).ok).toBe(true);
      expect(store.recordPrFeedback(feedback)).toMatchObject({
        ok: true,
        patternKey: "cluster-provider-ordering-gap",
      });
      const db = (store as unknown as { db: Database }).db;
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM autonomy_pr_feedback_tombstones
             WHERE feedback_key = ?`,
          )
          .get(feedback.feedbackKey),
      ).toMatchObject({ count: 0 });
    } finally {
      queue.close();
    }
  });

  test("prunes provider tombstones by retention and a bounded row cap", () => {
    const store = makeStore();
    const db = (store as unknown as { db: Database }).db;
    const recent = new Date().toISOString();
    const old = "2020-01-01T00:00:00.000Z";
    const insert = db.prepare(
      `INSERT INTO autonomy_pr_feedback_tombstones (
         feedback_key, reason, payload_hash, disposition,
         occurrence_count, first_seen_at, last_seen_at
       ) VALUES (?, 'stale', ?, 'permanent', 1, ?, ?)`,
    );
    const seed = db.transaction(() => {
      for (let index = 0; index < 10_002; index += 1) {
        const key = `provider-tombstone-${String(index).padStart(5, "0")}`;
        const observedAt = index === 0 ? old : recent;
        insert.run(key, `hash-${index}`, observedAt, observedAt);
      }
    });
    seed();

    expect(
      store.recordPrFeedback({
        feedbackKey: "provider-prune-trigger",
        patternKey: "cluster-provider-prune",
        verdict: "approved_unmergeable",
      }).ok,
    ).toBe(true);
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM autonomy_pr_feedback_tombstones`).get(),
    ).toMatchObject({ count: 10_000 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM autonomy_pr_feedback_tombstones
           WHERE feedback_key = 'provider-tombstone-00000'`,
        )
        .get(),
    ).toMatchObject({ count: 0 });
  });

  test("ingests versioned nested validation evidence into reliability coverage", () => {
    const { store, dbPath } = makePersistentStore("pushpals-validation-evidence-v2-");
    const jobs = new JobQueue(dbPath);
    try {
      const enqueued = jobs.enqueue({
        taskId: "validation-evidence-v2",
        sessionId: "dev",
        kind: "task.execute",
        params: { origin: "autonomy", autonomy: { origin: "autonomy" } },
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(jobs.claim("worker-validation-evidence-v2").job?.id).toBe(jobId);
      expect(
        jobs.fail(jobId, {
          message: "Focused validation failed",
          diagnostics: {
            terminal: {
              failureClass: "test_failure",
              terminalStage: "focused_validation",
              summary: "One focused test failed",
            },
            validationRuns: [
              {
                attempt: 1,
                command: "bun test tests/router-shell.test.ts",
                passed: false,
                exitCode: 1,
                failureClass: "test_failure",
                metadata: {
                  validation_evidence: {
                    schema_version: 2,
                    failure_fingerprint: "router-shell-acceptance-v2",
                    failed_tests: ["route shell > restores navigation state"],
                    affected_paths: ["tests/router-shell.test.ts"],
                    failure_lines: ["expected navigation state to be restored"],
                  },
                },
              },
            ],
          },
        }).ok,
      ).toBe(true);

      expect(store.getReliabilityMetrics()).toMatchObject({
        validationFailureRuns: 1,
        validationEvidenceCoverageRate: 1,
        validationFingerprintCollisionCount: 0,
      });
    } finally {
      jobs.close();
    }
  });

  test("records end-to-end objective latency when terminal feedback omits latency", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "dev",
      runId: "run-end-to-end-latency",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run-end-to-end-latency",
      snapshotId,
      sessionId: "dev",
      objective: {
        id: "obj-end-to-end-latency",
        title: "Measure full objective delivery latency",
        instruction: "Carry the objective through worker and review delivery.",
        objective_type: "small_refactor",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["apps/server/src/autonomy.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/autonomy.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun test tests/server.autonomy-store.test.ts"],
        status: "dispatched",
        request_id: "req-end-to-end-latency",
      },
    });
    expect(decision.ok).toBe(true);

    const db = (store as unknown as { db: any }).db;
    const lifecycleStartedAt = new Date(Date.now() - 120_000).toISOString();
    db.prepare(
      `UPDATE autonomy_objectives
       SET created_at = ?, dispatched_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(lifecycleStartedAt, lifecycleStartedAt, lifecycleStartedAt, "obj-end-to-end-latency");
    expect(
      store.recordOutcome({
        objectiveId: "obj-end-to-end-latency",
        requestId: "req-end-to-end-latency",
        patternKey: decision.patternKey,
        success: true,
        userAction: "applied",
        latencyMs: null,
      }).ok,
    ).toBe(true);

    const outcome = db
      .prepare(`SELECT latency_ms AS latencyMs FROM autonomy_outcomes WHERE objective_id = ?`)
      .get("obj-end-to-end-latency") as { latencyMs: number };
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(119_000);
    expect(runEvaluatorNow(store).avgLatencyMs).toBeGreaterThanOrEqual(119_000);
  });

  test("resolves a rearmed repair through the original autonomous objective lineage", () => {
    const { store, dbPath } = makePersistentStore("pushpals-repair-lineage-");
    const jobs = new JobQueue(dbPath);
    try {
      const snapshotId = store.createSnapshot({
        sessionId: "dev",
        runId: "run-repair-lineage",
      }).snapshot_id;
      const decision = store.recordObjectiveDecision({
        runId: "run-repair-lineage",
        snapshotId,
        sessionId: "dev",
        objective: {
          id: "obj-repair-lineage",
          title: "Preserve repair lineage",
          instruction: "Publish a focused repository repair.",
          objective_type: "small_refactor",
          component_area: "apps/server",
          trigger_type: "queue_health",
          target_paths: ["apps/server/src/jobs.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/jobs.ts"] },
          confidence: 0.95,
          risk_level: "low",
          expected_validation: ["bun test tests/server.jobs-repair-scheduling.test.ts"],
          status: "dispatched",
          request_id: "req-repair-lineage",
        },
      });
      expect(decision.ok).toBe(true);

      const root = jobs.enqueue({
        taskId: "root-repair-lineage",
        sessionId: "dev",
        kind: "task.execute",
        params: {
          origin: "autonomy",
          requestId: "req-repair-lineage",
          autonomy: {
            origin: "autonomy",
            objectiveId: "obj-repair-lineage",
            patternKey: decision.patternKey,
          },
        },
      });
      store.linkJobToObjectiveByRequest("req-repair-lineage", String(root.jobId));
      expect(jobs.claim("worker-repair-lineage").job?.id).toBe(root.jobId);
      expect(
        jobs.complete(String(root.jobId), {
          summary: "candidate published",
          prUrl: "https://github.com/example/repo/pull/697",
        }).ok,
      ).toBe(true);

      const repairBody = {
        taskId: "review-fix-repair-lineage",
        sessionId: "dev",
        kind: "task.execute",
        repositoryIdentity: "https://github.com/example/repo.git",
        prUrl: "https://github.com/example/repo/pull/697",
        dedupeKey: "review-fix:697:lineage",
        params: {
          instruction: "Address review feedback for the published candidate.",
          reviewAgent: {
            prNumber: 697,
            prUrl: "https://github.com/example/repo/pull/697",
            repositoryIdentity: "https://github.com/example/repo.git",
            prHeadSha: "lineage-head-sha",
            prBaseSha: "lineage-base-sha",
            resolutionType: "review_fix",
            sourceJobId: root.jobId,
          },
        },
      };
      expect(jobs.authorizeReviewRepairCapability(repairBody)).toMatchObject({ ok: true });
      const repair = jobs.enqueue(repairBody, { authorizedElevatedWorkClass: "repair" });
      expect(jobs.claim("worker-repair-lineage").job?.id).toBe(repair.jobId);
      expect(
        jobs.fail(String(repair.jobId), {
          message: "Review repair needs a strategy change",
          diagnostics: {
            terminal: {
              failureClass: "product_quality",
              terminalStage: "critic",
              summary: "The first repair did not satisfy the acceptance criteria",
            },
          },
        }).ok,
      ).toBe(true);

      const recovery = jobs.getPendingJobs().find((job) => job.resumeOfJobId === repair.jobId);
      const recoveryParams = JSON.parse(String(recovery?.params ?? "{}"));
      expect(store.resolveJobOutcomeContext(String(recovery?.id ?? ""), recoveryParams)).toEqual({
        objectiveId: "obj-repair-lineage",
        requestId: "req-repair-lineage",
        patternKey: decision.patternKey,
      });

      const genericRecovery = jobs.enqueue({
        taskId: "generic-retry-repair-lineage",
        sessionId: "dev",
        kind: "task.execute",
        params: {
          origin: "autonomy",
          autonomy: { origin: "autonomy", patternKey: "child-attempt-pattern" },
        },
      });
      const jobsDb = (jobs as unknown as { db: any }).db;
      jobsDb
        .prepare(`UPDATE jobs SET resumeOfJobId = ? WHERE id = ?`)
        .run(root.jobId, genericRecovery.jobId);
      const genericRecoveryParams = JSON.parse(
        String(jobs.getJob(String(genericRecovery.jobId))?.params ?? "{}"),
      );
      expect(
        store.resolveJobOutcomeContext(String(genericRecovery.jobId), genericRecoveryParams),
      ).toEqual({
        objectiveId: "obj-repair-lineage",
        requestId: "req-repair-lineage",
        patternKey: decision.patternKey,
      });
    } finally {
      jobs.close();
    }
  });
});
