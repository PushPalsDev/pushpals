import { describe, expect, test } from "bun:test";
import { WorkerStartupProgress } from "../apps/remotebuddy/src/worker_startup";
import { WorkerStartupBudget } from "../apps/workerpals/src/startup_budget";
import { WORKER_STARTUP_DEADLINE_ENV } from "../packages/shared/src/worker_startup";

// Production parent/child deadline contracts share a synthetic clock. No Docker,
// network, host processes, or real worktrees are needed to exercise these races.
function startupPair() {
  let now = 0;
  const supervisor = new WorkerStartupProgress(120_000, now, true);
  const observed: Array<{ phase: string; event: string; accepted: boolean }> = [];
  const worker = new WorkerStartupBudget({
    normalTimeoutMs: 120_000,
    docker: true,
    env: { [WORKER_STARTUP_DEADLINE_ENV]: String(supervisor.absoluteDeadlineMs) },
    now: () => now,
    monotonicNow: () => now,
    log: (line) => {
      const marker = JSON.parse(line.slice("[WorkerPalStartup] ".length));
      observed.push({ ...marker, accepted: supervisor.observeLine(line, now) });
    },
  });
  return { supervisor, worker, observed, now: () => now, advance: (ms: number) => (now += ms) };
}

describe("WorkerPal/RemoteBuddy composed startup deadlines", () => {
  test("a full build timeout can drain, pull its fallback, and finish a slow self-check", async () => {
    const pair = startupPair();
    const { worker, supervisor } = pair;
    pair.advance(3_000);
    await worker.phase("docker-startup-preflight", async () => pair.advance(20_000));
    const built = await worker.phase(
      "docker-image-build",
      async (timeoutMs) => {
        expect(timeoutMs).toBe(600_000);
        pair.advance(timeoutMs);
        expect(pair.now()).toBeLessThan(supervisor.deadlineMs);
        await worker.cleanup(async () => pair.advance(5_000));
        return false;
      },
      (ok) => ok,
    );
    expect(built).toBe(false);
    await worker.phase("docker-image-pull", async (timeoutMs) => {
      expect(timeoutMs).toBe(600_000);
      pair.advance(90_000);
      expect(pair.now()).toBeLessThan(supervisor.deadlineMs);
    });
    await worker.phase("docker-startup-selfcheck", async (timeoutMs) => {
      expect(timeoutMs).toBe(300_000);
      for (const stepMs of [45_000, 45_000, 25_000, 10_000, 20_000]) {
        expect(worker.capTimeout(stepMs)).toBe(stepMs);
        pair.advance(stepMs);
        expect(pair.now()).toBeLessThan(supervisor.deadlineMs);
      }
      await worker.cleanup(async () => pair.advance(5_000));
    });
    expect(pair.observed.map(({ phase, event }) => `${phase}:${event}`)).toEqual([
      "docker-startup-preflight:start",
      "docker-startup-preflight:complete",
      "docker-image-build:start",
      "docker-image-build:failed",
      "docker-image-pull:start",
      "docker-image-pull:complete",
      "docker-startup-selfcheck:start",
      "docker-startup-selfcheck:complete",
    ]);
    expect(pair.observed.every((marker) => marker.accepted)).toBe(true);
    // Markers preserve a bounded opportunity to register, never an online claim.
    expect(supervisor.deadlineMs - pair.now()).toBe(120_000);
    expect(supervisor.deadlineMs).toBeLessThanOrEqual(supervisor.absoluteDeadlineMs);
  });

  test("fallback commands consume the inherited ceiling instead of minting a new budget", async () => {
    const pair = startupPair();
    pair.advance(pair.supervisor.absoluteDeadlineMs - 50_000);
    let commandBudget = 0;
    await pair.worker.phase("docker-image-pull", async (timeoutMs) => {
      commandBudget = timeoutMs;
      expect(pair.worker.capTimeout(600_000)).toBe(timeoutMs);
      pair.advance(timeoutMs);
      expect(pair.worker.capTimeout(1)).toBe(0);
      await pair.worker.cleanup(async () => {
        expect(pair.worker.capTimeout(60_000)).toBeLessThanOrEqual(30_000);
        pair.advance(5_000);
      });
    });
    expect(commandBudget).toBeGreaterThan(0);
    expect(commandBudget).toBeLessThanOrEqual(10_000);
    let ran = false;
    await expect(
      pair.worker.phase("docker-startup-selfcheck", async () => {
        ran = true;
      }),
    ).rejects.toThrow("deadline expired");
    expect(ran).toBe(false);
    expect(pair.now()).toBeLessThanOrEqual(pair.supervisor.absoluteDeadlineMs);
  });
});
