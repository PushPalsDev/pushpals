import { describe, expect, test } from "bun:test";
import { loadConfig } from "../apps/source_control_manager/src/config";
import {
  cloneSourceControlManagerConfigSnapshot,
  createSourceControlManagerHealthTracker,
  createStartupStatusTracker,
  createSingleFlightExecutor,
  probeReviewAgentRuntimeReadiness,
  summarizeReviewAgentRuntimeReadiness,
} from "../apps/source_control_manager/src/runtime_helpers";

describe("source_control_manager runtime helpers", () => {
  test("health tracker marks a tick unhealthy only after progress stalls", () => {
    let now = Date.parse("2026-08-11T00:00:00.000Z");
    const tracker = createSourceControlManagerHealthTracker({
      tickStallMs: 60_000,
      idleBacklogGraceMs: 30_000,
      now: () => now,
    });
    tracker.beginTick("trusted_validation");
    tracker.progress("trusted_validation", "completion-1");
    now += 59_999;
    expect(tracker.snapshot()).toMatchObject({ healthy: true, activeCompletionId: "completion-1" });
    now += 1;
    expect(tracker.snapshot()).toMatchObject({
      healthy: false,
      status: "unhealthy",
      reason: expect.stringContaining("tick_stalled"),
    });
  });

  test("health tracker reports an old finalization queue when the poller is idle", () => {
    let now = Date.parse("2026-08-11T00:00:00.000Z");
    const tracker = createSourceControlManagerHealthTracker({
      tickStallMs: 60_000,
      idleBacklogGraceMs: 30_000,
      now: () => now,
    });
    tracker.beginTick();
    tracker.completeTick();
    tracker.updatePublication({
      backlog: 12,
      pending: 11,
      claimed: 1,
      finalizing: 12,
      oldestPendingAgeMs: 20 * 60_000,
      oldestFinalizingAgeMs: 20 * 60_000,
      unhealthy: true,
    });
    now += 30_000;
    expect(tracker.snapshot()).toMatchObject({
      healthy: false,
      reason: expect.stringContaining("publication_backlog_stalled_12"),
    });
  });

  test("cloneSourceControlManagerConfigSnapshot isolates mutable review and check config", () => {
    const config = loadConfig();
    const snapshot = cloneSourceControlManagerConfigSnapshot(config);

    config.reviewAgent.enabled = !config.reviewAgent.enabled;
    config.checks.push({ name: "temp", command: "echo temp" });

    expect(snapshot.reviewAgent.enabled).not.toBe(config.reviewAgent.enabled);
    expect(snapshot.checks.some((check) => check.name === "temp")).toBe(false);
  });

  test("createSingleFlightExecutor dedupes concurrent executions and resets after settle", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = createSingleFlightExecutor(async () => {
      runs += 1;
      await gate;
      return runs;
    });

    const first = run();
    const second = run();
    expect(first).toBe(second);

    release();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(1);
    await expect(run()).resolves.toBe(2);
  });

  test("createStartupStatusTracker prevents stale initializing emissions after online", () => {
    const tracker = createStartupStatusTracker();

    expect(tracker.getPhase()).toBe("startup");
    expect(tracker.canEmitInitializing(true)).toBe(true);
    expect(tracker.beginOnlineTransition()).toBe(true);
    expect(tracker.getPhase()).toBe("online");
    expect(tracker.canEmitInitializing(true)).toBe(false);
    expect(tracker.beginOnlineTransition()).toBe(false);
  });

  test("createStartupStatusTracker can revert a failed online transition before shutdown", () => {
    const tracker = createStartupStatusTracker();

    expect(tracker.beginOnlineTransition()).toBe(true);
    tracker.revertOnlineTransition();
    expect(tracker.getPhase()).toBe("startup");
    expect(tracker.canEmitInitializing(true)).toBe(true);

    tracker.markShutdown();
    expect(tracker.getPhase()).toBe("shutdown");
    expect(tracker.canEmitInitializing(true)).toBe(false);
    expect(tracker.beginOnlineTransition()).toBe(false);
  });

  test("summarizeReviewAgentRuntimeReadiness waits for RemoteBuddy and WorkerPals", () => {
    expect(
      summarizeReviewAgentRuntimeReadiness(
        {
          ok: true,
          workers: { online: 1, idle: 1 },
          clients: { items: [] },
        },
        "dev",
      ),
    ).toEqual({
      ready: false,
      detail: "No connected RemoteBuddy session consumer found for session dev",
    });

    expect(
      summarizeReviewAgentRuntimeReadiness(
        {
          ok: true,
          workers: { online: 0, idle: 0 },
          clients: {
            items: [
              {
                clientId: "remotebuddy-dev",
                label: "RemoteBuddy",
                sessionId: "dev",
                status: "connected",
              },
            ],
          },
        },
        "dev",
      ),
    ).toEqual({
      ready: false,
      detail: "WorkerPal capacity is not online yet",
    });
  });

  test("summarizeReviewAgentRuntimeReadiness allows ReviewAgent after runtime readiness", () => {
    expect(
      summarizeReviewAgentRuntimeReadiness(
        {
          ok: true,
          workers: { online: 2, idle: 1 },
          clients: {
            items: [
              {
                clientId: "pushpals-remotebuddy-dev",
                label: "RemoteBuddy",
                sessionId: "dev",
                status: "connected",
              },
            ],
          },
        },
        "dev",
      ),
    ).toEqual({
      ready: true,
      detail:
        "RemoteBuddy session consumer connected (pushpals-remotebuddy-dev); WorkerPals online=2, 1 idle",
    });
  });

  test("probeReviewAgentRuntimeReadiness uses system status and bearer auth", async () => {
    let requestedUrl = "";
    let requestedAuth = "";
    const result = await probeReviewAgentRuntimeReadiness({
      serverUrl: "http://127.0.0.1:3001/",
      sessionId: "dev",
      authToken: "secret",
      fetchImpl: async (url, init) => {
        requestedUrl = url;
        requestedAuth = String(
          (init?.headers as Record<string, string> | undefined)?.Authorization ?? "",
        );
        return Response.json({
          ok: true,
          workers: { online: 1, idle: 1 },
          clients: {
            items: [
              {
                clientId: "remotebuddy-dev",
                label: "RemoteBuddy",
                sessionId: "dev",
                status: "connected",
              },
            ],
          },
        });
      },
    });

    expect(result.ready).toBe(true);
    expect(requestedUrl).toBe("http://127.0.0.1:3001/system/status");
    expect(requestedAuth).toBe("Bearer secret");
  });

  test("probeReviewAgentRuntimeReadiness bounds a system-status body that never completes", async () => {
    let bodyCancelled = false;
    const startedAt = Date.now();
    const result = await probeReviewAgentRuntimeReadiness({
      serverUrl: "http://127.0.0.1:3001",
      sessionId: "dev",
      timeoutMs: 20,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":true'));
            },
            cancel() {
              bodyCancelled = true;
            },
          }),
          { status: 200 },
        ),
    });

    expect(result.ready).toBe(false);
    expect(result.detail).toContain("system status probe timed out after 20ms");
    expect(bodyCancelled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
