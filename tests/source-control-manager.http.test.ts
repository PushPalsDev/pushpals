import { describe, expect, test } from "bun:test";
import { MergeQueueDB } from "../apps/source_control_manager/src/db";
import { createStatusServer } from "../apps/source_control_manager/src/http";

describe("SourceControlManager status health", () => {
  test("returns 503 so the supervisor restarts a stalled publisher", async () => {
    const db = new MergeQueueDB(":memory:");
    let healthy = true;
    const server = createStatusServer(db, 0, () => ({
      healthy,
      status: healthy ? "ok" : "unhealthy",
      reason: healthy ? null : "tick_stalled_120000ms_phase_trusted_validation",
      startedAt: "2026-08-11T00:00:00.000Z",
      lastTickStartedAt: "2026-08-11T00:01:00.000Z",
      lastTickCompletedAt: null,
      lastProgressAt: "2026-08-11T00:01:00.000Z",
      activeTick: true,
      activeCompletionId: "completion-1",
      phase: "trusted_validation",
      publication: null,
    }));
    try {
      const healthyResponse = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(healthyResponse.status).toBe(200);
      healthy = false;
      const unhealthyResponse = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(unhealthyResponse.status).toBe(503);
      expect(await unhealthyResponse.json()).toMatchObject({
        status: "unhealthy",
        reason: expect.stringContaining("tick_stalled"),
        activeCompletionId: "completion-1",
      });
    } finally {
      server.stop(true);
      db.close();
    }
  });
});
