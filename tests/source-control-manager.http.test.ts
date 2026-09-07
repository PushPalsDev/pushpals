import { describe, expect, test } from "bun:test";
import { MergeQueueDB } from "../apps/source_control_manager/src/db";
import { createStatusServer } from "../apps/source_control_manager/src/http";
import { createSourceControlManagerHealthTracker } from "../apps/source_control_manager/src/runtime_helpers";
import { runProcessWithTreeTimeout } from "../apps/source_control_manager/src/trusted_validation";

describe("SourceControlManager status health", () => {
  test("serves health during validation output capture, timeout termination, and bounded draining", async () => {
    const db = new MergeQueueDB(":memory:");
    const tracker = createSourceControlManagerHealthTracker({
      tickStallMs: 17 * 60_000,
      idleBacklogGraceMs: 30_000,
    });
    tracker.beginTick("trusted_validation");
    tracker.progress("trusted_validation_validation_start_attempt_1", "completion-liveness");
    const server = createStatusServer(db, 0, tracker.snapshot);
    const healthUrl = `http://127.0.0.1:${server.port}/health`;
    let validationSettled = false;
    // This child only writes bounded-size messages and waits. It does not
    // launch the application, touch a repository, or contact any provider.
    const validation = runProcessWithTreeTimeout(
      [
        process.execPath,
        "-e",
        "setInterval(() => { console.log('validation-alive'); console.error('validation-progress'); }, 20)",
      ],
      { cwd: process.cwd(), timeoutMs: 1_000 },
    ).finally(() => {
      validationSettled = true;
    });
    try {
      let probesDuringValidation = 0;
      // A responsive HTTP route alone is insufficient: prove that it stays
      // responsive while the real subprocess runner is still in flight.
      while (!validationSettled) {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          healthy: true,
          activeTick: true,
          activeCompletionId: "completion-liveness",
          phase: "trusted_validation_validation_start_attempt_1",
        });
        if (!validationSettled) probesDuringValidation += 1;
        await Bun.sleep(25);
      }
      const result = await validation;
      expect(result).toMatchObject({ ok: false, exitCode: 124, timedOut: true });
      expect(result.output).toContain("validation-alive");
      expect(result.output).toContain("validation-progress");
      expect(probesDuringValidation).toBeGreaterThanOrEqual(3);

      tracker.completeTick();
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        healthy: true,
        activeTick: false,
        phase: "idle",
      });
    } finally {
      // The runner owns a hard deadline and process-tree cleanup even when an
      // HTTP assertion fails; do not leave the fake child running after a test.
      await validation.catch(() => undefined);
      server.stop(true);
      db.close();
    }
  }, 15_000);

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
      reviewProvider: null,
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
