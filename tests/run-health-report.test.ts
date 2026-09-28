import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  aggregateRunHealth,
  parseRunHealthArgs,
  readRunHealthReport,
} from "../scripts/run-health-report";

const window = {
  since: "2026-01-01T00:00:00.000Z",
  until: "2026-01-02T00:00:00.000Z",
  observedAt: "2026-01-02T01:00:00.000Z",
};
const job = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: "completed",
  createdAt: window.since,
  ...overrides,
});
const pr = "https://example.test/team/repository/pull/1";
const analysis = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: "completed",
  createdAt: window.since,
  completedAt: "2026-01-01T00:00:30.000Z",
  requestJson: JSON.stringify({
    purpose: "priority",
    caller: { service: "remotebuddy" },
    context: { operation: "analyze_autonomy_opportunities" },
  }),
  resultJson: JSON.stringify({ data: { candidates: [] }, cache: { hit: false } }),
  ...overrides,
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only run health reporting", () => {
  test("surfaces completed empty repository analyses without inventing successful jobs", () => {
    const report = aggregateRunHealth(
      {
        jobs: [],
        repositoryAnalyses: [
          analysis("a"),
          analysis("b", {
            createdAt: "2026-01-01T00:01:00.000Z",
            completedAt: "2026-01-01T00:01:10.000Z",
            resultJson: JSON.stringify({ data: { candidates: [] }, cache: { hit: true } }),
          }),
          analysis("before", { createdAt: "2025-12-31T23:59:59.000Z" }),
          analysis("boundary", { createdAt: window.until }),
        ],
      },
      window,
    );
    expect(report.repositoryAnalysis).toMatchObject({
      available: true,
      complete: true,
      observed: 2,
      statusCounts: { completed: 2 },
      completedLatency: { samples: 2, missing: 0, meanMs: 20_000 },
      completedCache: { hits: 1, misses: 1, unknown: 0 },
      unknownOperation: 0,
      autonomyOpportunities: {
        observed: 2,
        completed: 2,
        candidateResults: { empty: 2, nonEmpty: 0, unknown: 0 },
        observedTrailingEmptyStreak: 2,
      },
    });
    expect(report.jobs.successful).toBe(0);
    expect(report.jobs.terminalSuccessRate).toBeNull();
    expect(report.pullRequests.mergedRate).toBeNull();
  });

  test("uses structured operation, not a caller, purpose, or prompt guess", () => {
    const report = aggregateRunHealth(
      {
        jobs: [],
        repositoryAnalyses: [
          analysis("other", {
            requestJson: JSON.stringify({
              purpose: "priority",
              caller: { service: "remotebuddy" },
              question: "analyze_autonomy_opportunities",
              context: { operation: "explain_repository" },
            }),
          }),
          analysis("unknown", {
            requestJson: JSON.stringify({
              purpose: "priority",
              caller: { service: "remotebuddy" },
              question: "analyze_autonomy_opportunities",
            }),
          }),
          analysis("autonomy"),
        ],
      },
      window,
    ).repositoryAnalysis;
    expect(report.observed).toBe(3);
    expect(report.completedLatency?.samples).toBe(3);
    expect(report.completedCache?.misses).toBe(3);
    expect(report.unknownOperation).toBe(1);
    expect(report.autonomyOpportunities).toMatchObject({
      observed: 1,
      completed: 1,
      candidateResults: { empty: 1, nonEmpty: 0, unknown: 0 },
      observedTrailingEmptyStreak: null,
    });
  });

  test.each([
    ["missing", null],
    ["malformed", "{not-json"],
    ["null", "null"],
    ["array", "[]"],
    ["missing data", JSON.stringify({ cache: { hit: "true" } })],
    ["null candidates", JSON.stringify({ data: { candidates: null }, cache: { hit: 1 } })],
    ["object candidates", JSON.stringify({ data: { candidates: {} }, cache: { hit: null } })],
    [
      "oversized",
      JSON.stringify({
        padding: "x".repeat(70_000),
        data: { candidates: [] },
        cache: { hit: true },
      }),
    ],
  ])("keeps %s repository result evidence unknown", (_name, resultJson) => {
    const report = aggregateRunHealth(
      { jobs: [], repositoryAnalyses: [analysis("a", { resultJson })] },
      window,
    );
    expect(report.repositoryAnalysis.autonomyOpportunities).toMatchObject({
      completed: 1,
      candidateResults: { empty: 0, nonEmpty: 0, unknown: 1 },
      observedTrailingEmptyStreak: null,
    });
    expect(report.repositoryAnalysis.completedCache).toEqual({ hits: 0, misses: 0, unknown: 1 });
  });

  test("distinguishes failed/in-flight analyses and missing durations from empty completed analyses", () => {
    const report = aggregateRunHealth(
      {
        jobs: [],
        repositoryAnalyses: [
          analysis("failed", { status: "failed" }),
          analysis("queued", { status: "queued" }),
          analysis("invalid", { completedAt: "invalid" }),
          analysis("missing", { completedAt: null }),
          analysis("negative", { completedAt: "2025-12-31T23:59:00.000Z" }),
          analysis("running", { status: "running", createdAt: "2026-01-01T01:00:00.000Z" }),
        ],
      },
      window,
    ).repositoryAnalysis;
    expect(report.statusCounts).toEqual({ failed: 1, queued: 1, completed: 3, running: 1 });
    expect(report.completedLatency).toMatchObject({ samples: 0, missing: 3, meanMs: null });
    expect(report.completedCache).toEqual({ hits: 0, misses: 3, unknown: 0 });
    expect(report.autonomyOpportunities).toMatchObject({
      observed: 6,
      completed: 3,
      candidateResults: { empty: 3, nonEmpty: 0, unknown: 0 },
      observedTrailingEmptyStreak: null,
    });
  });

  test("rejects parseable result or request prefixes marked truncated", () => {
    const report = aggregateRunHealth(
      {
        jobs: [],
        repositoryAnalyses: [
          analysis("a", { resultJsonTruncated: 1 }),
          analysis("b", { requestJsonTruncated: 1 }),
        ],
      },
      window,
    ).repositoryAnalysis;
    expect(report.truncatedEvidence).toEqual({ requests: 1, results: 1 });
    expect(report.unknownOperation).toBe(1);
    expect(report.completedCache).toEqual({ hits: 0, misses: 1, unknown: 1 });
    expect(report.autonomyOpportunities).toMatchObject({
      observed: 1,
      completed: 1,
      candidateResults: { empty: 0, nonEmpty: 0, unknown: 1 },
      observedTrailingEmptyStreak: null,
    });
  });

  test("counts only a known trailing empty streak and resets it after a nonempty result", () => {
    const rows = [
      analysis("a", { createdAt: "2026-01-01T00:00:00.000Z", resultJson: "{}" }),
      analysis("b", {
        createdAt: "2026-01-01T00:01:00.000Z",
        resultJson: JSON.stringify({ data: { candidates: [{ id: "candidate" }] } }),
      }),
      analysis("c", { createdAt: "2026-01-01T00:02:00.000Z" }),
      analysis("d", { createdAt: "2026-01-01T00:03:00.000Z" }),
    ];
    const data = { jobs: [], repositoryAnalyses: [...rows].reverse() };
    const report = aggregateRunHealth(data, window).repositoryAnalysis;
    expect(report.autonomyOpportunities).toMatchObject({
      candidateResults: { empty: 2, nonEmpty: 1, unknown: 1 },
      observedTrailingEmptyStreak: 2,
    });
    // A row cap cannot prove that later omitted rows did not interrupt the streak.
    expect(
      aggregateRunHealth({ ...data, truncatedTables: ["repository_agent_requests"] }, window)
        .repositoryAnalysis.autonomyOpportunities.observedTrailingEmptyStreak,
    ).toBeNull();
    expect(
      aggregateRunHealth({ jobs: [], repositoryAnalyses: [analysis("a"), analysis("b")] }, window)
        .repositoryAnalysis.autonomyOpportunities.observedTrailingEmptyStreak,
    ).toBeNull();
  });

  test("does not confuse unavailable analysis history with an observed idle cohort", () => {
    expect(aggregateRunHealth({ jobs: [] }, window).repositoryAnalysis).toMatchObject({
      available: false,
      complete: false,
      observed: null,
      statusCounts: null,
      completedLatency: null,
      completedCache: null,
      autonomyOpportunities: {
        observed: null,
        completed: null,
        candidateResults: null,
        observedTrailingEmptyStreak: null,
      },
    });
    expect(
      aggregateRunHealth({ jobs: [], repositoryAnalyses: [] }, window).repositoryAnalysis,
    ).toMatchObject({
      available: true,
      complete: true,
      observed: 0,
      statusCounts: {},
      completedLatency: { samples: 0, missing: 0, meanMs: null },
      autonomyOpportunities: {
        observed: 0,
        completed: 0,
        candidateResults: { empty: 0, nonEmpty: 0, unknown: 0 },
        observedTrailingEmptyStreak: null,
      },
    });
  });

  test.each([
    { name: "unknown operation first", id: "a", requestJson: "{}" },
    { name: "unknown operation last", id: "z", requestJson: "{}" },
    { name: "in-flight first", id: "a", status: "claimed" },
    { name: "in-flight last", id: "z", status: "claimed" },
  ])(
    "keeps a tied $name ambiguous even after subsequent empty analyses",
    ({ name: _name, id, ...overrides }) => {
      const nonEmpty = JSON.stringify({ data: { candidates: [{ id: "candidate" }] } });
      const rows = [
        analysis(id, overrides),
        analysis("m", { resultJson: nonEmpty }),
        analysis("empty1", { createdAt: "2026-01-01T00:01:00.000Z" }),
        analysis("empty2", { createdAt: "2026-01-01T00:02:00.000Z" }),
      ];
      expect(
        aggregateRunHealth({ jobs: [], repositoryAnalyses: rows }, window).repositoryAnalysis
          .autonomyOpportunities.observedTrailingEmptyStreak,
      ).toBeNull();
      rows.push(
        analysis("known-reset", { createdAt: "2026-01-01T00:03:00.000Z", resultJson: nonEmpty }),
        analysis("known-empty", { createdAt: "2026-01-01T00:04:00.000Z" }),
      );
      expect(
        aggregateRunHealth({ jobs: [], repositoryAnalyses: rows }, window).repositoryAnalysis
          .autonomyOpportunities.observedTrailingEmptyStreak,
      ).toBe(1);
    },
  );

  test("reads analysis cohorts independently with bounded private evidence and no writes", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-run-report-analyses-"));
    roots.push(root);
    const path = join(root, "run.sqlite");
    const db = new Database(path);
    db.exec(
      "CREATE TABLE jobs (id TEXT, status TEXT, createdAt TEXT); CREATE TABLE repository_agent_requests (id TEXT, status TEXT, createdAt TEXT, completedAt TEXT, requestJson TEXT, resultJson TEXT)",
    );
    const insert = db.query("INSERT INTO repository_agent_requests VALUES (?, ?, ?, ?, ?, ?)");
    const oversizedResult = JSON.stringify({
      data: { candidates: [] },
      cache: { hit: true },
      answer: "private-answer" + "x".repeat(70_000),
    });
    const oversizedRequest = JSON.stringify({
      context: { operation: "analyze_autonomy_opportunities" },
      question: "private-prompt" + "x".repeat(70_000),
    });
    for (const row of [
      analysis("a", { resultJson: oversizedResult }),
      analysis("b", { requestJson: oversizedRequest }),
      analysis("c"),
    ])
      insert.run(
        row.id,
        row.status,
        row.createdAt,
        row.completedAt,
        row.requestJson,
        row.resultJson,
      );
    db.close();
    const before = readFileSync(path);
    const report = readRunHealthReport(path, window, 2);
    expect(report.evidence.truncatedTables).toEqual(["repository_agent_requests"]);
    expect(report.repositoryAnalysis).toMatchObject({
      available: true,
      complete: false,
      observed: 2,
      completedCache: { hits: 0, misses: 1, unknown: 1 },
      truncatedEvidence: { requests: 1, results: 1 },
      unknownOperation: 1,
      autonomyOpportunities: {
        observed: 1,
        completed: 1,
        candidateResults: { empty: 0, nonEmpty: 0, unknown: 1 },
        observedTrailingEmptyStreak: null,
      },
    });
    expect(report.jobs.terminalSuccessRate).toBeNull();
    expect(JSON.stringify(report)).not.toContain("private-prompt");
    expect(JSON.stringify(report)).not.toContain("private-answer");
    expect(readFileSync(path)).toEqual(before);
  });

  test.each([true, false])(
    "exposes legacy analysis columns without changing the schema (createdAt present: %s)",
    (hasCreatedAt) => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-run-report-legacy-analysis-"));
      roots.push(root);
      const path = join(root, "run.sqlite");
      const db = new Database(path);
      db.exec(
        `CREATE TABLE jobs (id TEXT, status TEXT, createdAt TEXT); CREATE TABLE repository_agent_requests (status TEXT${hasCreatedAt ? ", createdAt TEXT" : ""})`,
      );
      if (hasCreatedAt)
        db.query("INSERT INTO repository_agent_requests VALUES (?, ?)").run(
          "completed",
          window.since,
        );
      else db.query("INSERT INTO repository_agent_requests VALUES (?)").run("completed");
      db.close();
      const before = readFileSync(path);
      const report = readRunHealthReport(path, window).repositoryAnalysis;
      expect(report.available).toBe(true);
      expect(report.complete).toBe(false);
      expect(report.observed).toBe(hasCreatedAt ? 1 : null);
      expect(report.missingColumns).toContain("requestJson");
      expect(report.missingColumns).toContain("resultJson");
      expect(report.autonomyOpportunities.observedTrailingEmptyStreak).toBeNull();
      if (hasCreatedAt) {
        expect(report.unknownOperation).toBe(1);
        expect(report.completedLatency).toMatchObject({ samples: 0, missing: 1, meanMs: null });
        expect(report.completedCache?.unknown).toBe(1);
      } else expect(report.missingColumns).toContain("createdAt");
      expect(readFileSync(path)).toEqual(before);
    },
  );

  test("tracks a SQLite planning-to-publication lifecycle without promoting earlier phases to success", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-run-report-lifecycle-"));
    roots.push(root);
    const path = join(root, "run.sqlite");
    const write = (change: (db: Database) => void) => {
      const db = new Database(path);
      try {
        change(db);
      } finally {
        db.close();
      }
    };
    const snapshot = () => {
      const before = readFileSync(path);
      const report = readRunHealthReport(path, window);
      expect(readFileSync(path)).toEqual(before);
      return report;
    };
    write((db) => {
      db.exec(`
        CREATE TABLE jobs (id TEXT, status TEXT, createdAt TEXT, startedAt TEXT, completedAt TEXT, prUrl TEXT);
        CREATE TABLE requests (id TEXT, status TEXT, createdAt TEXT);
        CREATE TABLE completions (id TEXT, jobId TEXT, status TEXT, commitSha TEXT, prUrl TEXT, createdAt TEXT, updatedAt TEXT);
        CREATE TABLE job_terminal_diagnostics (jobId TEXT, summary TEXT, failureClass TEXT);
        CREATE TABLE pr_provider_outcomes (normalizedPrUrl TEXT, prUrl TEXT, verdict TEXT, terminal INTEGER, merged INTEGER);
        CREATE TABLE autonomy_pr_feedback (id INTEGER, pr_url_normalized TEXT, pr_url TEXT, verdict TEXT, source TEXT, review_score REAL, review_threshold REAL, created_at TEXT);
        CREATE TABLE repository_agent_requests (id TEXT, status TEXT, createdAt TEXT, completedAt TEXT, requestJson TEXT, resultJson TEXT);
      `);
      for (const row of [
        analysis("empty-miss"),
        analysis("empty-hit", {
          createdAt: "2026-01-01T00:05:00.000Z",
          completedAt: "2026-01-01T00:05:05.000Z",
          resultJson: JSON.stringify({ data: { candidates: [] }, cache: { hit: true } }),
        }),
      ])
        db.query("INSERT INTO repository_agent_requests VALUES (?, ?, ?, ?, ?, ?)").run(
          row.id,
          row.status,
          row.createdAt,
          row.completedAt,
          row.requestJson,
          row.resultJson,
        );
    });
    const idle = snapshot();
    expect(idle.repositoryAnalysis.autonomyOpportunities.observedTrailingEmptyStreak).toBe(2);
    expect(idle.jobs.terminalSuccessRate).toBeNull();
    expect(idle.requests.observed).toBe(0);

    write((db) => {
      const row = analysis("actionable", {
        createdAt: "2026-01-01T00:10:00.000Z",
        completedAt: "2026-01-01T00:10:30.000Z",
        resultJson: JSON.stringify({
          data: { candidates: [{ id: "a" }, { id: "b" }] },
          cache: { hit: false },
        }),
      });
      db.query("INSERT INTO repository_agent_requests VALUES (?, ?, ?, ?, ?, ?)").run(
        row.id,
        row.status,
        row.createdAt,
        row.completedAt,
        row.requestJson,
        row.resultJson,
      );
      for (const id of ["a", "b"])
        db.query("INSERT INTO requests VALUES (?, 'pending', ?)").run(
          id,
          "2026-01-01T00:10:35.000Z",
        );
    });
    const planned = snapshot();
    expect(planned.repositoryAnalysis.autonomyOpportunities).toMatchObject({
      completed: 3,
      candidateResults: { empty: 2, nonEmpty: 1, unknown: 0 },
      observedTrailingEmptyStreak: 0,
    });
    expect(planned.requests.statusCounts).toEqual({ pending: 2 });
    expect(planned.cohort.jobs).toBe(0);

    write((db) => {
      db.exec("UPDATE requests SET status='completed'");
      for (const id of ["a", "b"])
        db.query("INSERT INTO jobs VALUES (?, 'claimed', ?, ?, NULL, NULL)").run(
          id,
          "2026-01-01T00:10:36.000Z",
          "2026-01-01T00:10:40.000Z",
        );
    });
    const dispatched = snapshot();
    expect(dispatched.requests.completed).toBe(2);
    expect(dispatched.jobs).toMatchObject({
      terminal: 0,
      successful: 0,
      terminalSuccessRate: null,
      verifiedPublished: 0,
    });

    write((db) => {
      db.exec("UPDATE jobs SET status='finalizing'");
      for (const id of ["a", "b"])
        db.query("INSERT INTO completions VALUES (?, ?, 'pending', ?, NULL, ?, ?)").run(
          `completion-${id}`,
          id,
          id.repeat(40),
          "2026-01-01T00:15:00.000Z",
          "2026-01-01T00:15:00.000Z",
        );
    });
    const handoff = snapshot();
    expect(handoff.jobs).toMatchObject({ terminal: 0, successful: 0, verifiedPublished: 0 });
    expect(handoff.timing.executionToHandoff).toMatchObject({ samples: 2, meanMs: 260_000 });
    expect(handoff.timing.pendingPublicationAge.samples).toBe(2);

    write((db) => {
      db.query("UPDATE jobs SET status='completed', completedAt=?, prUrl=? WHERE id='a'").run(
        "2026-01-01T00:20:36.000Z",
        pr,
      );
      db.exec("UPDATE jobs SET status='publish_blocked' WHERE id='b'");
      db.query(
        "UPDATE completions SET status='processed', updatedAt=?, prUrl=? WHERE jobId='a'",
      ).run("2026-01-01T00:20:36.000Z", pr);
      db.query("UPDATE completions SET status='failed', updatedAt=? WHERE jobId='b'").run(
        "2026-01-01T00:20:36.000Z",
      );
      db.query("INSERT INTO job_terminal_diagnostics VALUES ('b', ?, ?)").run(
        "Trusted validation failed",
        "trusted_validation_failed",
      );
      db.query("INSERT INTO pr_provider_outcomes VALUES (?, ?, 'open', 0, 0)").run(pr, pr);
    });
    const published = snapshot();
    expect(published.jobs).toMatchObject({
      terminal: 2,
      successful: 1,
      terminalSuccessRate: 0.5,
      verifiedPublished: 1,
      verifiedPublicationRate: 0.5,
    });
    expect(published.timing.completedEndToEnd).toMatchObject({
      samples: 1,
      meanMs: 600_000,
      atMost10Minutes: 1,
    });
    expect(published.pullRequests).toMatchObject({
      unique: 1,
      open: 1,
      merged: 0,
      reviewed: 0,
      observedFirstPassMergeRate: null,
    });

    write((db) => {
      db.exec("UPDATE pr_provider_outcomes SET verdict='approved_merged', terminal=1, merged=1");
      db.query(
        "INSERT INTO autonomy_pr_feedback VALUES (1, ?, ?, 'approved_merged', 'review_agent', 9, 8, ?)",
      ).run(pr, pr, "2026-01-01T00:22:00.000Z");
    });
    const merged = snapshot();
    expect(merged.pullRequests).toMatchObject({
      merged: 1,
      reviewed: 1,
      observedFirstPassMerged: 1,
      observedFirstPassMergeRate: 1,
    });
    expect(merged.jobs.terminalSuccessRate).toBe(0.5);
    expect(merged.repositoryAnalysis.completedCache).toEqual({ hits: 1, misses: 2, unknown: 0 });
  });

  test("reports failed requests even when worker startup created no jobs", () => {
    const report = aggregateRunHealth(
      {
        jobs: [],
        requests: [
          job("failed-request", { status: "failed" }),
          job("waiting-request", { status: "claimed" }),
          job("completed-request"),
          job("older-request", { status: "failed", createdAt: "2025-12-31T23:59:59Z" }),
          job("boundary-request", { status: "failed", createdAt: window.until }),
        ],
      },
      window,
    );
    expect(report.requests).toEqual({
      available: true,
      complete: true,
      observed: 3,
      statusCounts: { failed: 1, claimed: 1, completed: 1 },
      failed: 1,
      completed: 1,
    });
    expect(report.cohort.jobs).toBe(0);
    expect(report.jobs.successful).toBe(0);
    expect(report.jobs.terminalSuccessRate).toBeNull();
  });

  test("unknown or sampled request history is not reported as complete", () => {
    expect(aggregateRunHealth({ jobs: [] }, window).requests).toEqual({
      available: false,
      complete: false,
      observed: null,
      statusCounts: null,
      failed: null,
      completed: null,
    });
    const sampled = aggregateRunHealth(
      { jobs: [], requests: [job("request")], truncatedTables: ["requests"] },
      window,
    );
    expect(sampled.requests).toMatchObject({ available: true, complete: false, observed: 1 });
    expect(sampled.evidence.sampled).toBe(true);
  });

  test("reads failed request cohorts with an independent row cap and no database writes", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-run-report-requests-"));
    roots.push(root);
    const path = join(root, "run.sqlite");
    const db = new Database(path);
    db.exec(
      "CREATE TABLE jobs (id TEXT, status TEXT, createdAt TEXT); CREATE TABLE requests (id TEXT, status TEXT, createdAt TEXT)",
    );
    const insert = db.query("INSERT INTO requests VALUES (?, ?, ?)");
    insert.run("a", "failed", window.since);
    insert.run("b", "claimed", window.since);
    insert.run("c", "failed", window.since);
    db.close();
    const before = readFileSync(path);
    const report = readRunHealthReport(path, window, 2);
    expect(report.requests).toMatchObject({
      available: true,
      complete: false,
      observed: 2,
      statusCounts: { failed: 1, claimed: 1 },
      failed: 1,
    });
    expect(report.evidence.truncatedTables).toEqual(["requests"]);
    expect(report.cohort.jobs).toBe(0);
    expect(readFileSync(path)).toEqual(before);
  });

  test("separates completed/no-change, publication, merge and actual review success", () => {
    const report = aggregateRunHealth(
      {
        jobs: [
          job("published", { prUrl: pr }),
          job("no-change", { result: "Completed with no file changes" }),
          job("unpublished"),
          job("running", { status: "running" }),
        ],
        completions: [
          {
            jobId: "published",
            status: "processed",
            commitSha: "a".repeat(40),
            prUrl: pr,
            createdAt: window.since,
            updatedAt: window.until,
          },
        ],
        providers: [{ prUrl: pr, verdict: "open", terminal: 0, merged: 0 }],
        // This is provider reconciliation, not evidence that a reviewer approved a patch.
        reviews: [
          {
            pr_url: pr,
            source: "review_agent",
            verdict: "approved_merged",
            review_score: null,
            review_threshold: null,
          },
        ],
      },
      window,
    );
    expect(report.jobs).toMatchObject({
      terminal: 3,
      successful: 2,
      noChange: 1,
      terminalSuccessRate: 2 / 3,
      verifiedPublished: 1,
      verifiedPublicationRate: 1 / 3,
    });
    expect(report.pullRequests).toMatchObject({
      unique: 1,
      merged: 0,
      open: 1,
      reviewed: 0,
      observedFirstPassApproved: 0,
      observedFirstPassApprovalRate: null,
    });
    expect(report.uptime.rate).toBeNull();
  });

  test("missing or malformed timings are not coerced to zero", () => {
    const report = aggregateRunHealth(
      {
        jobs: [job("missing"), job("invalid", { completedAt: "bad", durationMs: null })],
        completions: [
          {
            jobId: "missing",
            status: "pending",
            trustedInstallDurationMs: null,
            trustedValidationDurationMs: "0",
          },
        ],
      },
      window,
    );
    expect(report.timing.completedEndToEnd).toMatchObject({
      samples: 0,
      missing: 2,
      meanMs: null,
      p50Ms: null,
      p95Ms: null,
    });
    expect(report.timing.executionToHandoff.meanMs).toBeNull();
    expect(report.timing.trustedInstall.meanMs).toBeNull();
    expect(report.timing.trustedValidation.meanMs).toBeNull();
    expect(report.timing.pendingPublicationAge.meanMs).toBeNull();
    expect(report.pullRequests.mergedRate).toBeNull();
  });

  test("reports end-to-end and handoff/publication timings with explicit sample counts", () => {
    const report = aggregateRunHealth(
      {
        jobs: [
          job("a", { startedAt: "2026-01-01T00:01:00Z", completedAt: "2026-01-01T00:10:00Z" }),
          job("b", { completedAt: "2026-01-01T00:20:00Z" }),
          job("c", { completedAt: "2026-01-01T00:30:00Z" }),
          job("missing"),
          job("before", { createdAt: "2025-12-31T23:59:59Z" }),
          job("boundary", { createdAt: window.until }),
        ],
        completions: [
          {
            jobId: "a",
            status: "processed",
            commitSha: "a".repeat(40),
            createdAt: "2026-01-01T00:06:00Z",
            updatedAt: "2026-01-01T00:10:00Z",
            trustedInstallDurationMs: 0,
            trustedValidationDurationMs: 180_000,
          },
        ],
      },
      window,
    );
    expect(report.cohort.jobs).toBe(4);
    expect(report.timing.completedEndToEnd).toMatchObject({
      samples: 3,
      missing: 1,
      meanMs: 1_200_000,
      p50Ms: 1_200_000,
      p95Ms: 1_800_000,
      atMost10Minutes: 1,
    });
    expect(report.timing.executionToHandoff).toMatchObject({
      samples: 1,
      missing: 3,
      meanMs: 300_000,
    });
    expect(report.timing.terminalPublicationWait.meanMs).toBe(240_000);
    expect(report.timing.trustedInstall.meanMs).toBe(0);
    expect(report.timing.trustedValidation.meanMs).toBe(180_000);
  });

  test("deduplicates PRs and requires provider merge plus a positive initial review", () => {
    const second = `${pr}2`,
      third = `${pr}3`;
    const approved = (url: string, id: number, verdict = "approved_merged") => ({
      id,
      pr_url: url,
      verdict,
      source: "review_agent",
      review_score: 9,
      review_threshold: 8,
      created_at: `2026-01-01T00:0${id}:00Z`,
    });
    const report = aggregateRunHealth(
      {
        jobs: [
          job("a", { prUrl: `${pr}/?view=1#comment` }),
          job("repair", { prUrl: pr.toUpperCase() }),
          job("b", { prUrl: second }),
          job("c", { prUrl: third }),
        ],
        providers: [pr, second, third].map((prUrl) => ({ prUrl, merged: 1, terminal: 1 })),
        reviews: [
          approved(pr, 1),
          approved(second, 1, "rejected"),
          approved(second, 2),
          approved(third, 1, "approved_unmergeable"),
          approved(third, 2),
        ],
      },
      window,
    );
    expect(report.pullRequests).toMatchObject({
      unique: 3,
      merged: 3,
      reviewed: 3,
      revisions: 1,
      observedFirstPassApproved: 2,
      observedFirstPassMerged: 1,
      observedFirstPassMergeRate: 1 / 3,
    });
  });

  test.each([
    { name: "omitted", providers: undefined },
    { name: "empty", providers: [] },
    {
      name: "missing table",
      providers: [],
      missingTables: ["pr_provider_outcomes"],
    },
    { name: "unknown state", providers: [{ prUrl: pr, verdict: "unknown" }] },
    {
      name: "truncated table",
      providers: [{ prUrl: pr, terminal: 1, merged: 1 }],
      truncatedTables: ["pr_provider_outcomes"],
    },
  ])("keeps first-pass merge rate unknown with $name provider evidence", (providerEvidence) => {
    const { name: _name, ...evidence } = providerEvidence;
    const report = aggregateRunHealth(
      {
        jobs: [job("a", { prUrl: pr })],
        reviews: [
          {
            pr_url: pr,
            verdict: "approved_merged",
            source: "review_agent",
            review_score: 9,
            review_threshold: 8,
          },
        ],
        ...evidence,
      },
      window,
    );
    expect(report.pullRequests).toMatchObject({
      unique: 1,
      reviewed: 1,
      observedFirstPassApproved: 1,
      observedFirstPassApprovalRate: 1,
      mergedRate: null,
      observedFirstPassMergeRate: null,
    });
  });

  test("partial provider coverage does not turn an unknown merge into a failed first pass", () => {
    const second = `${pr}2`;
    const report = aggregateRunHealth(
      {
        jobs: [job("a", { prUrl: pr }), job("b", { prUrl: second })],
        providers: [{ prUrl: pr, terminal: 1, merged: 1 }],
        reviews: [pr, second].map((pr_url) => ({
          pr_url,
          verdict: "approved_merged",
          source: "review_agent",
          review_score: 9,
          review_threshold: 8,
        })),
      },
      window,
    );
    expect(report.pullRequests).toMatchObject({
      unique: 2,
      merged: 1,
      unknown: 1,
      reviewed: 2,
      observedFirstPassApproved: 2,
      observedFirstPassMerged: 1,
      observedFirstPassApprovalRate: 1,
      mergedRate: null,
      observedFirstPassMergeRate: null,
    });
  });

  test.each([
    { verdict: "approved_merged", terminal: 1, merged: 1, expectedRate: 1 },
    { verdict: "closed_unmerged", terminal: 1, merged: 0, expectedRate: 0 },
    { verdict: "open", terminal: 0, merged: 0, expectedRate: 0 },
  ])("preserves known first-pass merge rate for $verdict provider outcomes", (outcome) => {
    const { expectedRate, ...provider } = outcome;
    const report = aggregateRunHealth(
      {
        jobs: [job("a", { prUrl: pr })],
        providers: [{ prUrl: pr, ...provider }],
        reviews: [
          {
            pr_url: pr,
            verdict: "approved",
            source: "review_agent",
            review_score: 9,
            review_threshold: 8,
          },
        ],
      },
      window,
    );
    expect(report.pullRequests).toMatchObject({
      unknown: 0,
      reviewed: 1,
      observedFirstPassApprovalRate: 1,
      mergedRate: expectedRate,
      observedFirstPassMergeRate: expectedRate,
    });
  });

  test("unknown provider state and incomplete review evidence never imply perfect quality", () => {
    const report = aggregateRunHealth(
      {
        jobs: [job("a", { prUrl: pr })],
        missingTables: ["completions", "autonomy_pr_feedback"],
        providers: [],
        reviews: [
          {
            pr_url: pr,
            verdict: "approved_merged",
            source: "review_agent",
            review_score: 10,
            review_threshold: 8,
          },
        ],
        truncatedTables: ["autonomy_pr_feedback"],
      },
      window,
    );
    expect(report.evidence.sampled).toBe(true);
    expect(report.jobs.verifiedPublicationRate).toBeNull();
    expect(report.pullRequests).toMatchObject({
      unknown: 1,
      mergedRate: null,
      observedFirstPassMergeRate: null,
    });
    expect(aggregateRunHealth({ jobs: [] }, window).jobs.terminalSuccessRate).toBeNull();
  });

  test("truncated no-change text prevents a confident lifecycle success rate", () => {
    const report = aggregateRunHealth(
      { jobs: [job("a", { result: "Large result excerpt", resultTruncated: 1 })] },
      window,
    );
    expect(report.evidence.semanticEvidenceTruncated).toBe(1);
    expect(report.jobs.terminalSuccessRate).toBeNull();
  });

  test("reads SQLite without changing rows/schema/file and visibly bounds the cohort", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-run-report-"));
    roots.push(root);
    const path = join(root, "run.sqlite");
    const db = new Database(path);
    db.exec(
      "CREATE TABLE jobs (id TEXT, status TEXT, createdAt TEXT, result TEXT); CREATE TABLE untouched (value TEXT)",
    );
    const insert = db.query("INSERT INTO jobs VALUES (?, ?, ?, ?)");
    insert.run("a", "completed", window.since, "no file changes");
    insert.run("b", "failed", window.since, null);
    insert.run("c", "running", window.since, null);
    db.close();
    const before = readFileSync(path);
    const report = readRunHealthReport(path, window, 2);
    expect(report.cohort.jobs).toBe(2);
    expect(report.evidence.truncatedTables).toEqual(["jobs"]);
    expect(report.evidence.missingTables).toContain("completions");
    expect(report.requests.available).toBe(false);
    expect(report.requests.failed).toBeNull();
    expect(report.jobs).toMatchObject({
      noChange: 1,
      successful: 0,
      terminalSuccessRate: null,
      verifiedPublicationRate: null,
    });
    expect(readFileSync(path)).toEqual(before);
    const check = new Database(path, { readonly: true });
    expect(check.query("SELECT count(*) AS count FROM jobs").get()).toEqual({ count: 3 });
    expect(
      check.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    ).toEqual([{ name: "jobs" }, { name: "untouched" }]);
    check.close();
    const absent = join(root, "missing.sqlite");
    expect(() => readRunHealthReport(absent, window)).toThrow();
    expect(existsSync(absent)).toBe(false);
  });

  test("a truncated all-success prefix cannot claim a perfect full-cohort rate", () => {
    const report = aggregateRunHealth(
      {
        jobs: [job("a", { prUrl: pr })],
        completions: [{ jobId: "a", status: "processed", commitSha: "a".repeat(40) }],
        providers: [{ prUrl: pr, terminal: 1, merged: 1 }],
        reviews: [
          {
            pr_url: pr,
            verdict: "approved_merged",
            source: "review_agent",
            review_score: 10,
            review_threshold: 8,
          },
        ],
        truncatedTables: ["jobs"],
      },
      window,
    );
    expect(report.jobs.terminalSuccessRate).toBeNull();
    expect(report.jobs.verifiedPublicationRate).toBeNull();
    expect(report.pullRequests.mergedRate).toBeNull();
    expect(report.pullRequests.observedFirstPassApprovalRate).toBeNull();
    expect(report.pullRequests.observedFirstPassMergeRate).toBeNull();
  });

  test("missing diagnostics and oversized diagnostic summaries leave semantic rates unknown", () => {
    const missing = aggregateRunHealth(
      { jobs: [job("a")], missingTables: ["job_terminal_diagnostics"] },
      window,
    );
    expect(missing.jobs.terminalSuccessRate).toBeNull();
    const root = mkdtempSync(join(tmpdir(), "pushpals-run-report-diagnostics-"));
    roots.push(root);
    const path = join(root, "run.sqlite");
    const db = new Database(path);
    db.exec(
      "CREATE TABLE jobs (id TEXT, status TEXT, createdAt TEXT); CREATE TABLE job_terminal_diagnostics (jobId TEXT, summary TEXT, failureClass TEXT)",
    );
    db.query("INSERT INTO jobs VALUES (?, ?, ?)").run("a", "completed", window.since);
    db.query("INSERT INTO job_terminal_diagnostics VALUES (?, ?, ?)").run(
      "a",
      "x".repeat(10_000) + " no change",
      null,
    );
    db.close();
    const report = readRunHealthReport(path, window);
    expect(report.evidence.semanticEvidenceTruncated).toBe(1);
    expect(report.evidence.semanticOutcomesComplete).toBe(false);
    expect(report.jobs.terminalSuccessRate).toBeNull();
  });

  test("rejects ambiguous CLI dates, invalid ranges and duplicate options", () => {
    const args = ["--db", "run.sqlite", "--since", window.since];
    expect(parseRunHealthArgs(args, window.until)).toEqual({
      dbPath: "run.sqlite",
      window: { since: window.since, until: window.until },
    });
    expect(() =>
      parseRunHealthArgs([...args, "--until", window.until, "--until", window.until]),
    ).toThrow("Duplicate");
    expect(() => parseRunHealthArgs(["--db", "run.sqlite", "--since", "yesterday"])).toThrow("ISO");
    expect(() => parseRunHealthArgs([...args, "--until", window.since])).toThrow("since < until");
    expect(() => parseRunHealthArgs(["--db", "run.sqlite"])).toThrow("required");
    expect(() => parseRunHealthArgs([...args, "--unknown", "x"])).toThrow("Usage");
  });
});
