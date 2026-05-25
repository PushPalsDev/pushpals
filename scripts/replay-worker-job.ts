#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join, resolve } from "path";

type ReplayWorkerJobOptions = {
  repo: string;
  jobId: string;
  server: string;
  dbPath?: string;
  authToken?: string;
  sessionId?: string;
  taskId?: string;
  targetWorkerId?: string;
  preserveDedupe: boolean;
  preserveTargetWorker: boolean;
  dryRun: boolean;
};

export type ReplayJobRow = {
  id: string;
  taskId: string;
  sessionId: string;
  kind: string;
  params: string;
  dedupeKey: string | null;
  priority: string;
  queueWaitBudgetMs: number;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
  targetWorkerId: string | null;
  prUrl: string | null;
};

export type ReplayJobPayload = {
  taskId: string;
  sessionId: string;
  kind: string;
  params: Record<string, unknown>;
  priority?: string;
  queueWaitBudgetMs?: number;
  executionBudgetMs?: number;
  finalizationBudgetMs?: number;
  dedupeKey?: string;
  targetWorkerId?: string;
  prUrl?: string;
};

function usage(): string {
  return `Usage:
  bun run scripts/replay-worker-job.ts --repo <path> --job-id <id> [--server <url>]

Options:
  --repo <path>              Repo that owns the original PushPals job DB.
  --job-id <id>              Existing jobs.id value to replay.
  --server <url>             Running PushPals server URL. Default: http://127.0.0.1:3001
  --db <path>                Override DB path. Default: <repo>/outputs/data/pushpals.db
  --session-id <id>          Override replay sessionId. Default: source job sessionId, then dev.
  --task-id <id>             Override replay taskId. Default: <source taskId>-replay-<timestamp>.
  --target-worker-id <id>    Send replay to a specific WorkerPal.
  --preserve-target-worker   Reuse source job targetWorkerId when present.
  --preserve-dedupe          Reuse source dedupeKey. Default: generate a replay-specific key.
  --auth-token <token>       Optional Bearer token for non-local test servers.
  --dry-run                  Print the enqueue payload without posting.
  -h, --help                 Show this help.
`;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function parseReplayWorkerJobArgs(argv: string[]): ReplayWorkerJobOptions {
  const options: ReplayWorkerJobOptions = {
    repo: "",
    jobId: "",
    server: "http://127.0.0.1:3001",
    preserveDedupe: false,
    preserveTargetWorker: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      throw new Error(usage());
    }
    if (arg === "--repo") {
      options.repo = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--job-id") {
      options.jobId = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--server") {
      options.server = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--db") {
      options.dbPath = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--session-id") {
      options.sessionId = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--task-id") {
      options.taskId = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--target-worker-id") {
      options.targetWorkerId = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--auth-token") {
      options.authToken = requireValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--preserve-dedupe") {
      options.preserveDedupe = true;
      continue;
    }
    if (arg === "--preserve-target-worker") {
      options.preserveTargetWorker = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.repo.trim()) throw new Error("--repo is required.");
  if (!options.jobId.trim()) throw new Error("--job-id is required.");
  options.repo = resolve(options.repo);
  options.server = normalizeServerUrl(options.server);
  if (options.dbPath) options.dbPath = resolve(options.dbPath);
  return options;
}

function normalizeServerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("--server cannot be empty.");
  try {
    return new URL(trimmed).toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`--server must be a valid URL: ${value}`);
  }
}

export function resolveDefaultPushpalsDbPath(repo: string): string {
  return join(resolve(repo), "outputs", "data", "pushpals.db");
}

function parseParamsJson(raw: string, jobId: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("params JSON is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Job ${jobId} has invalid params JSON: ${detail}`);
  }
}

export function loadReplayJobFromDb(dbPath: string, jobId: string): ReplayJobRow {
  if (!existsSync(dbPath)) {
    throw new Error(`PushPals DB not found: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query(
        `SELECT id, taskId, sessionId, kind, params, dedupeKey, priority,
                queueWaitBudgetMs, executionBudgetMs, finalizationBudgetMs,
                targetWorkerId, prUrl
         FROM jobs
         WHERE id = ?
         LIMIT 1`,
      )
      .get(jobId) as ReplayJobRow | null;
    if (!row) throw new Error(`Job not found in ${dbPath}: ${jobId}`);
    return row;
  } finally {
    db.close();
  }
}

function shortTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
}

function positiveIntOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function buildReplayJobEnqueuePayload(
  row: ReplayJobRow,
  options: Pick<
    ReplayWorkerJobOptions,
    "sessionId" | "taskId" | "targetWorkerId" | "preserveDedupe" | "preserveTargetWorker"
  >,
  now = new Date(),
): ReplayJobPayload {
  const params = parseParamsJson(row.params, row.id);
  const stamp = shortTimestamp(now);
  const replayTaskId =
    options.taskId?.trim() || `${row.taskId || row.id}-replay-${stamp}`.slice(0, 180);
  const replaySessionId = options.sessionId?.trim() || row.sessionId?.trim() || "dev";
  const dedupeKey = options.preserveDedupe
    ? row.dedupeKey?.trim() || undefined
    : `replay:${row.id}:${stamp}`;
  const targetWorkerId =
    options.targetWorkerId?.trim() ||
    (options.preserveTargetWorker ? row.targetWorkerId?.trim() : "") ||
    undefined;

  return {
    taskId: replayTaskId,
    sessionId: replaySessionId,
    kind: row.kind,
    params: {
      ...params,
      replayOfJobId: row.id,
      replayedAt: now.toISOString(),
    },
    ...(row.priority ? { priority: row.priority } : {}),
    ...(positiveIntOrUndefined(row.queueWaitBudgetMs)
      ? { queueWaitBudgetMs: row.queueWaitBudgetMs }
      : {}),
    ...(positiveIntOrUndefined(row.executionBudgetMs)
      ? { executionBudgetMs: row.executionBudgetMs }
      : {}),
    ...(positiveIntOrUndefined(row.finalizationBudgetMs)
      ? { finalizationBudgetMs: row.finalizationBudgetMs }
      : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(targetWorkerId ? { targetWorkerId } : {}),
    ...(row.prUrl ? { prUrl: row.prUrl } : {}),
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function assertServerIsReachable(server: string, authToken?: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(`${server}/healthz`, { headers }, 5_000);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `PushPals server is not reachable at ${server}. Start the local server/WorkerPal runtime first. Detail: ${detail}`,
    );
  }
  if (!response.ok) {
    throw new Error(`PushPals server health check failed: HTTP ${response.status}`);
  }
}

export async function enqueueReplayJob(
  server: string,
  payload: ReplayJobPayload,
  authToken?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetchWithTimeout(
    `${server}/jobs/enqueue`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    30_000,
  );
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(`Replay enqueue failed: HTTP ${response.status} ${text}`.trim());
  }
  return parsed;
}

export async function replayWorkerJob(options: ReplayWorkerJobOptions): Promise<void> {
  const dbPath = options.dbPath || resolveDefaultPushpalsDbPath(options.repo);
  const row = loadReplayJobFromDb(dbPath, options.jobId);
  const payload = buildReplayJobEnqueuePayload(row, options);

  console.log(`[replay-worker-job] repo=${options.repo}`);
  console.log(`[replay-worker-job] db=${dbPath}`);
  console.log(`[replay-worker-job] sourceJobId=${row.id}`);
  console.log(`[replay-worker-job] sourceTaskId=${row.taskId}`);
  console.log(`[replay-worker-job] replayTaskId=${payload.taskId}`);
  console.log(`[replay-worker-job] server=${options.server}`);

  if (options.dryRun) {
    console.log("[replay-worker-job] dry run payload:");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  await assertServerIsReachable(options.server, options.authToken);
  const result = await enqueueReplayJob(options.server, payload, options.authToken);
  console.log(`[replay-worker-job] enqueue result: ${JSON.stringify(result)}`);
  if (typeof result.jobId === "string") {
    console.log(`[replay-worker-job] replayJobId=${result.jobId}`);
  }
}

if (import.meta.main) {
  try {
    const options = parseReplayWorkerJobArgs(process.argv.slice(2));
    await replayWorkerJob(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("Usage:\n")) {
      console.log(message);
      process.exit(0);
    }
    console.error(`[replay-worker-job] ${message}`);
    console.error("");
    console.error(usage());
    process.exit(1);
  }
}
