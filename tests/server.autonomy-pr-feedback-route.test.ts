import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { invalidatePushPalsConfigCache } from "shared";

const AUTH_TOKEN = "route-secret";
const ENV_KEYS = [
  "PUSHPALS_DATA_DIR",
  "PUSHPALS_DB_PATH",
  "REMOTEBUDDY_DB_PATH",
  "PUSHPALS_PORT",
  "PUSHPALS_SERVER_URL",
  "PUSHPALS_AUTH_TOKEN",
] as const;

let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";
let tempRoot = "";
let serverModule: typeof import("../apps/server/src/server_main") | null = null;
const priorEnv = new Map<string, string | undefined>();
let invokeFetch: ((req: Request) => Promise<Response>) | null = null;
let protocolReady = true;
try {
  await import("protocol");
} catch (err: any) {
  try {
    await import("../packages/protocol/src/index.ts");
  } catch (innerErr: any) {
    protocolReady = false;
    console.error("Failed to import protocol package:", innerErr?.message ?? innerErr);
  }
}

if (!protocolReady) {
  test("POST /autonomy/pr-feedback route requires protocol package to be importable", () => {
    throw new Error(
      "Unable to import the protocol package. Run `bun install` / `bun run protocol:build` before executing autonomy route tests.",
    );
  });
} else {
beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "autonomy-pr-feedback-route-"));
  priorEnv.clear();
  for (const key of ENV_KEYS) {
    priorEnv.set(key, process.env[key]);
  }
  process.env.PUSHPALS_DATA_DIR = tempRoot;
  process.env.PUSHPALS_DB_PATH = join(tempRoot, "pushpals.db");
  process.env.REMOTEBUDDY_DB_PATH = join(tempRoot, "remotebuddy-state.db");
  const port = 48000 + Math.floor(Math.random() * 1000);
  process.env.PUSHPALS_PORT = String(port);
  process.env.PUSHPALS_SERVER_URL = `http://127.0.0.1:${port}`;
  process.env.PUSHPALS_AUTH_TOKEN = AUTH_TOKEN;

  serverModule = await import("../apps/server/src/server_main");
  serverModule.sessionManager.authToken = AUTH_TOKEN;
  invalidatePushPalsConfigCache();
  const serveImpl = (options: Parameters<typeof Bun.serve>[0]) => {
    const stubServer = {
      port,
      url: `http://127.0.0.1:${port}`,
      stop: () => {},
      upgrade: () => false,
    } as ReturnType<typeof Bun.serve>;
    invokeFetch = (req: Request) => options.fetch(req, stubServer);
    return stubServer;
  };
  server = serverModule.createRequestHandler({ serveImpl });
  baseUrl = `http://127.0.0.1:${server!.port}`;
});

afterAll(() => {
  server?.stop();
  serverModule?.autonomyStore?.close();
  serverModule?.jobQueue?.close();
  serverModule?.sessionManager?.store?.close();
  for (const key of ENV_KEYS) {
    const previous = priorEnv.get(key);
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  invalidatePushPalsConfigCache();
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

beforeEach(() => {
  if (!serverModule) return;
  const db = (serverModule.autonomyStore as unknown as { db?: { exec: (sql: string) => void } }).db;
  try {
    db?.exec(
      [
        "DELETE FROM autonomy_pr_feedback;",
        "DELETE FROM autonomy_outcomes;",
        "DELETE FROM autonomy_objectives;",
        "DELETE FROM autonomy_runs;",
        "DELETE FROM autonomy_snapshots;",
      ].join("\n"),
    );
  } catch {
    // tables may not exist yet in isolated test DB
  }
  const jobDb = (serverModule.jobQueue as unknown as { db?: { exec: (sql: string) => void } }).db;
  try {
    jobDb?.exec(
      ["DELETE FROM jobs;", "DELETE FROM job_logs;", "DELETE FROM job_artifacts;"].join("\n"),
    );
  } catch {
    // ignore missing tables in test setup
  }
});

async function seedRouteObjective(overrides?: {
  objectiveId?: string;
  requestId?: string;
  jobId?: string;
  prUrl?: string;
}): Promise<{
  objectiveId: string;
  requestId: string;
  jobId: string;
  patternKey: string;
  prUrl: string;
}> {
  if (!serverModule) throw new Error("server not initialized");
  const store = serverModule.autonomyStore;
  const sessionId = "session-route";
  const runId = "run-route";
  const snapshot = store.createSnapshot({ sessionId, runId });
  const prUrl = overrides?.prUrl ?? "https://example.com/pr/route";
  const enqueueResult = serverModule.jobQueue.enqueue({
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    kind: "task.execute",
    sessionId,
    prUrl,
  });
  expect(enqueueResult.ok).toBe(true);
  const jobId = overrides?.jobId ?? String(enqueueResult.jobId);
  const objectiveId = overrides?.objectiveId ?? `obj-route-${Math.random().toString(36).slice(2)}`;
  const requestId = overrides?.requestId ?? `req-route-${Math.random().toString(36).slice(2)}`;
  const decision = store.recordObjectiveDecision({
    runId,
    snapshotId: snapshot.snapshot_id,
    sessionId,
    objective: {
      id: objectiveId,
      title: "Route objective",
      instruction: "Ensure PR feedback routing works",
      objective_type: "lint_fix",
      component_area: "apps/server",
      trigger_type: "lint_failure",
      target_paths: ["apps/server/src/server_main.ts"],
      scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
      confidence: 0.9,
      risk_level: "low",
      expected_validation: ["bun test"],
      status: "dispatched",
      request_id: requestId,
      job_id: jobId,
    },
  });
  expect(decision.ok).toBe(true);
  const patternKey = String(decision.patternKey ?? "");
  expect(patternKey).toBeTruthy();
  return { objectiveId, requestId, jobId, patternKey, prUrl };
}

function selectAutonomyCount(table: string): number {
  if (!serverModule) throw new Error("server not initialized");
  const db = (serverModule.autonomyStore as unknown as { db: any }).db;
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

describe("POST /autonomy/pr-feedback route", () => {
  async function callRoute(
    path: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
  ): Promise<Response> {
    if (!invokeFetch) throw new Error("server not initialized");
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const req = new Request(`${baseUrl}${path}`, {
      method: init.method ?? "POST",
      headers,
      body: init.body,
    });
    return invokeFetch(req);
  }

  const postAutonomyFeedback = (payload: Record<string, unknown>) =>
    callRoute("/autonomy/pr-feedback", {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

  test("requires auth token", async () => {
    const payload = {
      verdict: "rejected",
      patternKey: "pk_route_test",
      summary: "Route auth test",
    };

    const unauth = await callRoute("/autonomy/pr-feedback", {
      body: JSON.stringify(payload),
      headers: {},
    });
    expect(unauth.status).toBe(401);

    const authed = await callRoute("/autonomy/pr-feedback", {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });

  test("resolves objective, request, job, and prUrl hints for context", async () => {
    const seeded = await seedRouteObjective({
      prUrl: "https://example.com/pr/context-route",
    });
    const requests = [
      { feedbackKey: "ctx-request", requestId: seeded.requestId, verdict: "rejected" },
      { feedbackKey: "ctx-job", jobId: seeded.jobId, verdict: "rejected_comment_cap_closed" },
      { feedbackKey: "ctx-pr-url", prUrl: seeded.prUrl, verdict: "approved_unmergeable" },
      { feedbackKey: "ctx-objective", objectiveId: seeded.objectiveId, verdict: "approved_merged" },
    ];

    for (const entry of requests) {
      const response = await postAutonomyFeedback({
        summary: `Route context test for ${entry.feedbackKey}`,
        ...entry,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok?: boolean;
        patternKey?: string;
        objectiveId?: string;
        normalizedVerdict?: string | null;
      };
      expect(body.ok).toBe(true);
      expect(body.patternKey).toBe(seeded.patternKey);
      expect(body.objectiveId).toBe(seeded.objectiveId);
      expect(body.normalizedVerdict).toBe(entry.verdict);
    }
  });

  test("dedupes repeated feedback_key submissions", async () => {
    const seeded = await seedRouteObjective();
    const first = await postAutonomyFeedback({
      verdict: "approved_merged",
      feedbackKey: "dup-route",
      objectiveId: seeded.objectiveId,
      summary: "First outcome",
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      ok?: boolean;
      deduped?: boolean;
      normalizedVerdict?: string | null;
      rawVerdict?: string | null;
    };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.deduped).toBeUndefined();
    expect(firstBody.normalizedVerdict).toBe("approved_merged");
    expect(firstBody.rawVerdict).toBe("approved_merged");
    expect(selectAutonomyCount("autonomy_pr_feedback")).toBe(1);
    expect(selectAutonomyCount("autonomy_outcomes")).toBe(1);

    const second = await postAutonomyFeedback({
      verdict: "approved_merged",
      feedbackKey: "dup-route",
      objectiveId: seeded.objectiveId,
      summary: "Duplicate outcome",
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      ok?: boolean;
      deduped?: boolean;
      normalizedVerdict?: string | null;
    };
    expect(secondBody.ok).toBe(true);
    expect(secondBody.deduped).toBe(true);
    expect(secondBody.normalizedVerdict).toBe("approved_merged");
    expect(selectAutonomyCount("autonomy_pr_feedback")).toBe(1);
    expect(selectAutonomyCount("autonomy_outcomes")).toBe(1);
  });

  test("maps verdicts to deterministic outcomes", async () => {
    const seeded = await seedRouteObjective();
    const accepted = await postAutonomyFeedback({
      verdict: "approved_merged",
      feedbackKey: "route-accepted",
      objectiveId: seeded.objectiveId,
      summary: "Merged cleanly",
    });
    const acceptedBody = (await accepted.json()) as {
      success?: boolean;
      userAction?: string;
      normalizedVerdict?: string | null;
    };
    expect(acceptedBody.success).toBe(true);
    expect(acceptedBody.userAction).toBe("accepted");
    expect(acceptedBody.normalizedVerdict).toBe("approved_merged");

    const blocked = await postAutonomyFeedback({
      verdict: "approved_unmergeable",
      feedbackKey: "route-blocked",
      objectiveId: seeded.objectiveId,
      summary: "Merge conflict",
    });
    const blockedBody = (await blocked.json()) as {
      success?: boolean;
      userAction?: string;
      normalizedVerdict?: string | null;
    };
    expect(blockedBody.success).toBe(false);
    expect(blockedBody.userAction).toBe("merge_conflict");
    expect(blockedBody.normalizedVerdict).toBe("approved_unmergeable");

    const rows = (
      (serverModule!.autonomyStore as unknown as { db: any }).db
        .prepare(
          `SELECT user_action AS userAction, success
           FROM autonomy_outcomes
           ORDER BY id ASC`,
        )
        .all() as Array<{ userAction: string | null; success: number }>
    ).map((row) => ({ userAction: row.userAction, success: row.success }));
    expect(rows).toEqual([
      { userAction: "accepted", success: 1 },
      { userAction: "merge_conflict", success: 0 },
    ]);
  });

  test("ignores unknown verdict strings for outcome recording", async () => {
    const seeded = await seedRouteObjective();
    const response = await postAutonomyFeedback({
      verdict: "custom_notice",
      feedbackKey: "route-unknown",
      objectiveId: seeded.objectiveId,
      summary: "Informational only",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success?: boolean;
      userAction?: string;
      normalizedVerdict?: string | null;
      rawVerdict?: string | null;
    };
    expect(body.success).toBeUndefined();
    expect(body.userAction).toBeUndefined();
    expect(body.normalizedVerdict).toBeNull();
    expect(body.rawVerdict).toBe("custom_notice");
    expect(selectAutonomyCount("autonomy_outcomes")).toBe(0);
  });
});
}
