import { describe, expect, test } from "bun:test";
import { JobQueue } from "../apps/server/src/jobs";

describe("server JobQueue dedupe", () => {
  test("dedupes against active pending/claimed jobs by dedupeKey", () => {
    const queue = new JobQueue(":memory:");
    const first = queue.enqueue({
      taskId: "task-dup-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "pr:22:abcd1234",
      dedupeCooldownMs: 60_000,
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");
    expect(firstJobId.length).toBeGreaterThan(0);

    const second = queue.enqueue({
      taskId: "task-dup-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "PR:22:ABCD1234",
      dedupeCooldownMs: 60_000,
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.jobId).toBe(firstJobId);
    expect(second.taskId).toBe("task-dup-1");
    queue.close();
  });

  test("dedupes during cooldown after previous job completed", () => {
    const queue = new JobQueue(":memory:");
    const first = queue.enqueue({
      taskId: "task-cooldown-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "pr:23:abcd1234",
      dedupeCooldownMs: 60_000,
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");
    expect(firstJobId.length).toBeGreaterThan(0);

    const claimed = queue.claim("worker-1");
    expect(claimed.ok).toBe(true);
    expect(claimed.job?.id).toBe(firstJobId);
    const completed = queue.complete(firstJobId, { summary: "ok" });
    expect(completed.ok).toBe(true);

    const second = queue.enqueue({
      taskId: "task-cooldown-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "pr:23:abcd1234",
      dedupeCooldownMs: 60_000,
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.jobId).toBe(firstJobId);
    expect(second.taskId).toBe("task-cooldown-1");
    queue.close();
  });

  test("preserves multi-hour dedupe cooldowns for repeated autonomy work", () => {
    const queue = new JobQueue(":memory:");
    const cooldownMs = 6 * 60 * 60 * 1000;
    const first = queue.enqueue({
      taskId: "task-autonomy-cooldown-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "task.execute:autonomy:dev:app/__tests__/contract.test.ts",
      dedupeCooldownMs: cooldownMs,
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");
    expect(firstJobId.length).toBeGreaterThan(0);

    const claimed = queue.claim("worker-autonomy");
    expect(claimed.ok).toBe(true);
    expect(claimed.job?.dedupeCooldownMs).toBe(cooldownMs);
    expect(queue.complete(firstJobId, { summary: "no publishable patch" }).ok).toBe(true);

    const second = queue.enqueue({
      taskId: "task-autonomy-cooldown-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "task.execute:autonomy:dev:app/__tests__/contract.test.ts",
      dedupeCooldownMs: cooldownMs,
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.jobId).toBe(firstJobId);
    expect(second.taskId).toBe("task-autonomy-cooldown-1");
    queue.close();
  });

  test("allows enqueue after dedupe cooldown expires", async () => {
    const queue = new JobQueue(":memory:");
    const first = queue.enqueue({
      taskId: "task-cooldown-expire-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "pr:24:abcd1234",
      dedupeCooldownMs: 25,
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");

    const claimed = queue.claim("worker-2");
    expect(claimed.ok).toBe(true);
    const completed = queue.complete(firstJobId, { summary: "ok" });
    expect(completed.ok).toBe(true);

    await Bun.sleep(40);

    const second = queue.enqueue({
      taskId: "task-cooldown-expire-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "pr:24:abcd1234",
      dedupeCooldownMs: 25,
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).not.toBe(true);
    expect(second.jobId).not.toBe(firstJobId);
    queue.close();
  });
});
