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
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only run health reporting", () => {
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
