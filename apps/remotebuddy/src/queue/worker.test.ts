import { describe, expect, it, afterEach } from "bun:test";
import {
  RequestQueueWorker,
  type QueueRequestPayload,
  type QueueWorkerObserver,
  type QueueWorkerClaimEvent,
  type QueueWorkerEnqueueEvent,
  type QueueWorkerDispatchEvent,
  type QueueWorkerCompleteEvent,
} from "./worker.js";

class RecordingObserver implements QueueWorkerObserver {
  claims: QueueWorkerClaimEvent[] = [];
  enqueues: QueueWorkerEnqueueEvent[] = [];
  dispatches: QueueWorkerDispatchEvent[] = [];
  completes: QueueWorkerCompleteEvent[] = [];

  onClaim(event: QueueWorkerClaimEvent): void {
    this.claims.push(event);
  }

  onEnqueue(event: QueueWorkerEnqueueEvent): void {
    this.enqueues.push(event);
  }

  onDispatch(event: QueueWorkerDispatchEvent): void {
    this.dispatches.push(event);
  }

  onComplete(event: QueueWorkerCompleteEvent): void {
    this.completes.push(event);
  }
}

describe("RequestQueueWorker", () => {
  const originalFetch = globalThis.fetch;
  const handled: Array<{ id: string; started: number; finished: number }> = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    handled.length = 0;
  });

  it("limits latency with small batch claims and bounded parallelism", async () => {
    const queue: Array<{ payload: QueueRequestPayload; wait: number }> = [
      { payload: { id: "req-1", prompt: "a" }, wait: 1200 },
      { payload: { id: "req-2", prompt: "b" }, wait: 800 },
      { payload: { id: "req-3", prompt: "c" }, wait: 400 },
    ];

    globalThis.fetch = (async () => {
      const next = queue.shift();
      if (!next) {
        return new Response(JSON.stringify({ ok: false }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ ok: true, request: next.payload, queueWaitMs: next.wait }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const observer = new RecordingObserver();
    const worker = new RequestQueueWorker({
      server: "http://localhost:3001",
      agentId: "test-agent",
      pollIntervalMs: 20,
      claimBatchSize: 2,
      maxParallel: 2,
      authHeaders: () => ({ "Content-Type": "application/json" }),
      observer,
      onRequest: async (request) => {
        handled.push({ id: request.id, started: Date.now(), finished: 0 });
        await Bun.sleep(25);
        const entry = handled.find((item) => item.id === request.id);
        if (entry) entry.finished = Date.now();
      },
    });

    worker.start();
    const deadline = Date.now() + 500;
    while (handled.length < 3 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    await worker.stop();

    expect(handled.map((item) => item.id).sort()).toEqual(["req-1", "req-2", "req-3"]);
    expect(observer.enqueues.length).toBe(3);
    expect(observer.dispatches.length).toBe(3);
    expect(observer.completes.length).toBe(3);

    const maxActive = Math.max(...observer.dispatches.map((event) => event.active));
    expect(maxActive).toBeLessThanOrEqual(2);

    for (const event of observer.enqueues) {
      expect(event.queueWaitMs).toBeGreaterThanOrEqual(0);
    }
  });
});
