#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { classifyJobTerminalSemantics } from "../apps/server/src/job_terminal_semantics";

type Row = Record<string, unknown>;
export type RunHealthWindow = { since: string; until: string; observedAt?: string };
export type RunHealthData = {
  jobs: Row[];
  completions?: Row[];
  diagnostics?: Row[];
  providers?: Row[];
  reviews?: Row[];
  missingTables?: string[];
  truncatedTables?: string[];
};
const MAX_ROWS = 1_000;
const MAX_RESULT_CHARS = 64 * 1024;
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const time = (value: unknown): number | null => {
  const parsed = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const elapsed = (start: unknown, end: unknown): number | null => {
  const a = time(start),
    b = time(end);
  return a != null && b != null && b >= a ? b - a : null;
};
const ratio = (numerator: number, denominator: number): number | null =>
  denominator ? numerator / denominator : null;
function prKey(value: unknown): string {
  try {
    const url = new URL(text(value));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return "";
  }
}
function durations(values: Array<number | null>) {
  const sorted = values.filter((value): value is number => value != null).sort((a, b) => a - b);
  const quantile = (p: number) =>
    sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return {
    samples: sorted.length,
    missing: values.length - sorted.length,
    meanMs: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    atMost10Minutes: sorted.filter((value) => value <= 600_000).length,
  };
}
function checkedWindow(window: RunHealthWindow) {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  const since = time(window.since),
    until = time(window.until);
  if (
    !iso.test(window.since) ||
    !iso.test(window.until) ||
    since == null ||
    until == null ||
    since >= until
  )
    throw new Error("Require valid ISO --since and --until with since < until");
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

/** Pure aggregation; completion transport, publication, review and merge are distinct outcomes. */
export function aggregateRunHealth(data: RunHealthData, window: RunHealthWindow) {
  const cohort = checkedWindow(window);
  const jobs = data.jobs.filter((job) => {
    const created = time(job.createdAt);
    return (
      created != null && created >= Date.parse(cohort.since) && created < Date.parse(cohort.until)
    );
  });
  const jobIds = new Set(jobs.map((job) => text(job.id)));
  const completions = (data.completions ?? []).filter((row) => jobIds.has(text(row.jobId)));
  const handoffsByJob = new Map<string, Row[]>();
  for (const completion of completions) {
    const id = text(completion.jobId);
    const rows = handoffsByJob.get(id) ?? [];
    rows.push(completion);
    handoffsByJob.set(id, rows);
  }
  const diagnostics = new Map((data.diagnostics ?? []).map((row) => [text(row.jobId), row]));
  const statusCounts: Record<string, number> = {};
  let terminal = 0,
    successful = 0,
    noChange = 0,
    published = 0,
    semanticEvidenceTruncated = 0;
  const completedDurations: Array<number | null> = [],
    executionDurations: Array<number | null> = [];
  const prs = new Set<string>();
  for (const job of jobs) {
    const status = text(job.status) || "unknown";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const diagnostic = diagnostics.get(text(job.id));
    const semantic = classifyJobTerminalSemantics({
      status,
      result: job.result,
      error: job.error,
      summary: diagnostic?.summary,
      failureClass: diagnostic?.failureClass,
    });
    if (semantic.terminal) terminal++;
    if (semantic.noChange) noChange++;
    if (
      semantic.terminal &&
      (job.resultTruncated ||
        job.errorTruncated ||
        diagnostic?.summaryTruncated ||
        diagnostic?.failureClassTruncated)
    )
      semanticEvidenceTruncated++;
    const handoffs = (handoffsByJob.get(text(job.id)) ?? []).sort((a, b) =>
      text(a.createdAt).localeCompare(text(b.createdAt)),
    );
    const publication = handoffs.some(
      (row) =>
        row.status === "processed" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(text(row.commitSha)),
    );
    if (semantic.success) {
      successful++;
      if (publication) published++;
      completedDurations.push(elapsed(job.createdAt, job.completedAt));
    }
    executionDurations.push(handoffs.length ? elapsed(job.startedAt, handoffs[0].createdAt) : null);
    for (const url of [job.prUrl, ...handoffs.map((row) => row.prUrl)]) {
      const key = prKey(url);
      if (key) prs.add(key);
    }
  }
  const providers = new Map(
    (data.providers ?? []).map((row) => [prKey(row.normalizedPrUrl ?? row.prUrl), row]),
  );
  const reviewsByPr = new Map<string, Row[]>();
  for (const review of data.reviews ?? []) {
    const key = prKey(review.pr_url_normalized ?? review.pr_url);
    const rows = reviewsByPr.get(key) ?? [];
    rows.push(review);
    reviewsByPr.set(key, rows);
  }
  let merged = 0,
    closedUnmerged = 0,
    open = 0,
    unknown = 0;
  let reviewed = 0,
    firstPassApproved = 0,
    firstPassMerged = 0,
    revisions = 0;
  for (const key of prs) {
    const provider = providers.get(key);
    const isMerged = provider?.merged === 1 && provider?.terminal === 1;
    if (isMerged) merged++;
    else if (provider?.terminal === 1) closedUnmerged++;
    else if (["open", "opened", "approved_unmergeable"].includes(text(provider?.verdict))) open++;
    else unknown++;
    const reviews = (reviewsByPr.get(key) ?? []).sort(
      (a, b) =>
        text(a.created_at).localeCompare(text(b.created_at)) ||
        (number(a.id) ?? 0) - (number(b.id) ?? 0),
    );
    const decisions = reviews.filter((row) => {
      const verdict = text(row.verdict).toLowerCase();
      return (
        /reject|changes_requested|revision/.test(verdict) ||
        (/^approved(?:_|$)/.test(verdict) &&
          row.source === "review_agent" &&
          number(row.review_score) != null &&
          number(row.review_threshold) != null)
      );
    });
    if (decisions.length) reviewed++;
    const prRevisions = decisions.filter((row) =>
      /reject|changes_requested|revision/.test(text(row.verdict).toLowerCase()),
    ).length;
    revisions += prRevisions;
    const first = decisions[0];
    if (
      first &&
      /^approved(?:_|$)/.test(text(first.verdict)) &&
      number(first.review_score)! >= number(first.review_threshold)!
    ) {
      firstPassApproved++;
      if (isMerged && prRevisions === 0 && first.verdict !== "approved_unmergeable")
        firstPassMerged++;
    }
  }
  const truncatedTables = data.truncatedTables ?? [];
  const missingTables = data.missingTables ?? [];
  const cohortIncomplete = truncatedTables.includes("jobs");
  const semanticIncomplete =
    cohortIncomplete ||
    semanticEvidenceTruncated > 0 ||
    missingTables.includes("job_terminal_diagnostics") ||
    truncatedTables.includes("job_terminal_diagnostics");
  const reviewIncomplete =
    cohortIncomplete ||
    truncatedTables.includes("autonomy_pr_feedback") ||
    (data.missingTables ?? []).includes("autonomy_pr_feedback");
  return {
    schemaVersion: 1,
    cohort: { ...cohort, jobs: jobs.length, boundary: "createdAt >= since AND createdAt < until" },
    observedAt: window.observedAt ?? new Date().toISOString(),
    evidence: {
      sampled: truncatedTables.length > 0,
      truncatedTables,
      missingTables: data.missingTables ?? [],
      semanticEvidenceTruncated,
      semanticOutcomesComplete: !semanticIncomplete,
    },
    jobs: {
      statusCounts,
      terminal,
      successful,
      noChange,
      verifiedPublished: published,
      terminalSuccessRate: semanticIncomplete ? null : ratio(successful, terminal),
      verifiedPublicationRate:
        semanticIncomplete ||
        truncatedTables.includes("completions") ||
        missingTables.includes("completions")
          ? null
          : ratio(published, terminal),
    },
    timing: {
      completedEndToEnd: durations(completedDurations),
      executionToHandoff: durations(executionDurations),
      terminalPublicationWait: durations(
        completions
          .filter((row) => ["processed", "failed"].includes(text(row.status)))
          .map((row) => elapsed(row.createdAt, row.updatedAt)),
      ),
      pendingPublicationAge: durations(
        completions
          .filter((row) => !["processed", "failed"].includes(text(row.status)))
          .map((row) => elapsed(row.createdAt, window.observedAt ?? new Date().toISOString())),
      ),
      trustedInstall: durations(completions.map((row) => number(row.trustedInstallDurationMs))),
      trustedValidation: durations(
        completions.map((row) => number(row.trustedValidationDurationMs)),
      ),
    },
    pullRequests: {
      unique: prs.size,
      merged,
      closedUnmerged,
      open,
      unknown,
      mergedRate:
        cohortIncomplete || unknown || truncatedTables.includes("pr_provider_outcomes")
          ? null
          : ratio(merged, prs.size),
      reviewed,
      revisions,
      observedFirstPassApproved: firstPassApproved,
      observedFirstPassMerged: firstPassMerged,
      observedFirstPassApprovalRate: reviewIncomplete ? null : ratio(firstPassApproved, reviewed),
      observedFirstPassMergeRate: reviewIncomplete ? null : ratio(firstPassMerged, reviewed),
    },
    uptime: { rate: null, reason: "No continuous health-sample evidence is read by this report." },
    notes: [
      "The window selects job creation time; outcomes are current persisted state, not a reconstructed historical snapshot.",
      "No-change attempts remain in the terminal denominator but never count as successful delivery.",
      "Publication is not merge or review approval. First-pass metrics describe recorded review evidence, not missing/pruned history.",
      "Trusted timings are completion-recorded values, not guaranteed totals across all recovery attempts.",
    ],
  };
}

export function readRunHealthReport(dbPath: string, window: RunHealthWindow, limit = MAX_ROWS) {
  const cohort = checkedWindow(window);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS)
    throw new Error(`Row limit must be 1..${MAX_ROWS}`);
  const db = new Database(resolve(dbPath), { readonly: true, strict: true });
  try {
    return db.transaction(() => {
      const missingTables: string[] = [],
        truncatedTables: string[] = [];
      const read = (
        table: string,
        fields: string[],
        where = "",
        args: string[] = [],
        order = "",
      ) => {
        const columns = new Set(
          (db.query(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => text(row.name)),
        );
        if (!columns.size) {
          missingTables.push(table);
          return [];
        }
        const select = fields.map((field) => (columns.has(field) ? field : `NULL AS ${field}`));
        if (table === "jobs") {
          for (const field of ["result", "error"]) {
            if (!columns.has(field)) continue;
            select[fields.indexOf(field)] = `SUBSTR(${field}, 1, ${MAX_RESULT_CHARS}) AS ${field}`;
            select.push(`LENGTH(${field}) > ${MAX_RESULT_CHARS} AS ${field}Truncated`);
          }
        }
        if (table === "job_terminal_diagnostics") {
          for (const field of ["summary", "failureClass"]) {
            if (!columns.has(field)) continue;
            select[fields.indexOf(field)] = `SUBSTR(${field}, 1, 4096) AS ${field}`;
            select.push(`LENGTH(${field}) > 4096 AS ${field}Truncated`);
          }
        }
        const rows = db
          .query(`SELECT ${select.join(",")} FROM ${table} ${where} ${order} LIMIT ?`)
          .all(...args, limit + 1) as Row[];
        if (rows.length > limit) truncatedTables.push(table);
        return rows.slice(0, limit);
      };
      const jobs = read(
        "jobs",
        ["id", "status", "createdAt", "startedAt", "completedAt", "result", "error", "prUrl"],
        "WHERE createdAt >= ? AND createdAt < ?",
        [cohort.since, cohort.until],
        "ORDER BY createdAt, id",
      );
      if (missingTables.includes("jobs"))
        throw new Error("Database has no jobs table; refusing an empty success report");
      const ids = JSON.stringify(jobs.map((job) => job.id));
      const completions = read(
        "completions",
        [
          "id",
          "jobId",
          "status",
          "commitSha",
          "prUrl",
          "createdAt",
          "updatedAt",
          "trustedInstallDurationMs",
          "trustedValidationDurationMs",
        ],
        "WHERE jobId IN (SELECT value FROM json_each(?))",
        [ids],
        "ORDER BY createdAt, id",
      );
      const diagnostics = read(
        "job_terminal_diagnostics",
        ["jobId", "summary", "failureClass"],
        "WHERE jobId IN (SELECT value FROM json_each(?))",
        [ids],
      );
      const urls = JSON.stringify([
        ...new Set([...jobs, ...completions].map((row) => prKey(row.prUrl)).filter(Boolean)),
      ]);
      const providers = read(
        "pr_provider_outcomes",
        ["normalizedPrUrl", "prUrl", "verdict", "terminal", "merged"],
        "WHERE normalizedPrUrl IN (SELECT value FROM json_each(?))",
        [urls],
      );
      const reviews = read(
        "autonomy_pr_feedback",
        [
          "id",
          "pr_url_normalized",
          "pr_url",
          "verdict",
          "review_score",
          "review_threshold",
          "source",
          "created_at",
        ],
        "WHERE pr_url_normalized IN (SELECT value FROM json_each(?))",
        [urls],
        "ORDER BY created_at, id",
      );
      return aggregateRunHealth(
        { jobs, completions, diagnostics, providers, reviews, missingTables, truncatedTables },
        { ...cohort, observedAt: window.observedAt },
      );
    })();
  } finally {
    db.close();
  }
}

export function parseRunHealthArgs(args: string[], now = new Date().toISOString()) {
  const options: Record<string, string> = { until: now };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (
      !["--db", "--since", "--until"].includes(flag) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    ) {
      throw new Error(
        "Usage: bun run scripts/run-health-report.ts --db <path> --since <ISO> [--until <ISO>]",
      );
    }
    if (seen.has(flag)) throw new Error(`Duplicate ${flag}`);
    seen.add(flag);
    options[flag.slice(2)] = args[index + 1];
  }
  if (!options.db || !options.since) throw new Error("--db and --since are required");
  return {
    dbPath: options.db,
    window: checkedWindow({ since: options.since, until: options.until }),
  };
}
if (import.meta.main) {
  try {
    const { dbPath, window } = parseRunHealthArgs(process.argv.slice(2));
    console.log(JSON.stringify(readRunHealthReport(dbPath, window), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
