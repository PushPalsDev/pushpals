export interface QueueRequestPayload {
  id: string;
  prompt: string;
  priority?: string;
  queueWaitBudgetMs?: number;
  forceWorker?: boolean;
  forceLane?: string | null;
  metadata?: Record<string, unknown>;
  metadataJson?: string | null;
  [key: string]: unknown;
}

interface ClaimResponse {
  ok: boolean;
  request?: QueueRequestPayload;
  queueWaitMs?: number;
}

interface PendingQueueItem {
  request: QueueRequestPayload;
  queueWaitMs: number;
  enqueuedAt: number;
}

export interface QueueWorkerClaimEvent {
  result: "claimed" | "empty" | "error";
  durationMs: number;
  requestId?: string;
  queueWaitMs?: number;
  status?: number;
  error?: unknown;
}

export interface QueueWorkerEnqueueEvent {
  requestId: string;
  queueWaitMs: number;
  queueDepth: number;
}

export interface QueueWorkerDispatchEvent {
  requestId: string;
  queueWaitMs: number;
  localDelayMs: number;
  active: number;
  queueDepth: number;
}

export interface QueueWorkerCompleteEvent {
  requestId: string;
  durationMs: number;
  success: boolean;
  active: number;
  error?: unknown;
}

export interface QueueWorkerObserver {
  onClaim(event: QueueWorkerClaimEvent): void;
  onEnqueue(event: QueueWorkerEnqueueEvent): void;
  onDispatch(event: QueueWorkerDispatchEvent): void;
  onComplete(event: QueueWorkerCompleteEvent): void;
}

function isoTimestamp(): string {
  return new Date().toISOString();
}

export class ConsoleQueueWorkerObserver implements QueueWorkerObserver {
  onClaim(event: QueueWorkerClaimEvent): void {
    const parts = [
      `[QueueWorker] ${isoTimestamp()} claim=${event.result}`,
      `duration=${Math.round(event.durationMs)}ms`,
    ];
    if (event.requestId) parts.push(`request=${event.requestId.slice(0, 8)}`);
    if (typeof event.queueWaitMs === "number") {
      parts.push(`queueWait=${Math.round(event.queueWaitMs)}ms`);
    }
    if (typeof event.status === "number") parts.push(`status=${event.status}`);
    console.log(parts.join(" "));
    if (event.error) {
      console.error("[QueueWorker] claim error:", event.error);
    }
  }

  onEnqueue(event: QueueWorkerEnqueueEvent): void {
    console.log(
      `[QueueWorker] ${isoTimestamp()} enqueue request=${event.requestId.slice(0, 8)} queueWait=${Math.round(event.queueWaitMs)}ms depth=${event.queueDepth}`,
    );
  }

  onDispatch(event: QueueWorkerDispatchEvent): void {
    console.log(
      `[QueueWorker] ${isoTimestamp()} dispatch request=${event.requestId.slice(0, 8)} localDelay=${Math.round(event.localDelayMs)}ms queueWait=${Math.round(event.queueWaitMs)}ms active=${event.active} depth=${event.queueDepth}`,
    );
  }

  onComplete(event: QueueWorkerCompleteEvent): void {
    const status = event.success ? "complete" : "error";
    console.log(
      `[QueueWorker] ${isoTimestamp()} ${status} request=${event.requestId.slice(0, 8)} duration=${Math.round(event.durationMs)}ms active=${event.active}`,
    );
    if (!event.success && event.error) {
      console.error("[QueueWorker] handler error:", event.error);
    }
  }
}

export interface RequestQueueWorkerOptions {
  server: string;
  agentId: string;
  pollIntervalMs: number;
  claimBatchSize: number;
  maxParallel: number;
  authHeaders(): Record<string, string>;
  onRequest(request: QueueRequestPayload, queueWaitMs: number): Promise<void>;
  observer?: QueueWorkerObserver;
}

const MIN_POLL_MS = 200;
const MAX_BATCH_SIZE = 8;
const MAX_PARALLEL = 8;

export class RequestQueueWorker {
  private readonly pollIntervalMs: number;
  private readonly claimBatchSize: number;
  private readonly maxParallel: number;
  private readonly observer: QueueWorkerObserver;
  private readonly queue: PendingQueueItem[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private loopPromise: Promise<void> | null = null;
  private active = 0;
  private disposed = false;

  constructor(private readonly opts: RequestQueueWorkerOptions) {
    this.pollIntervalMs = Math.max(MIN_POLL_MS, Math.floor(opts.pollIntervalMs));
    this.claimBatchSize = Math.min(
      MAX_BATCH_SIZE,
      Math.max(1, Math.floor(opts.claimBatchSize)),
    );
    this.maxParallel = Math.min(MAX_PARALLEL, Math.max(1, Math.floor(opts.maxParallel)));
    this.observer = opts.observer ?? new ConsoleQueueWorkerObserver();
  }

  start(): void {
    if (this.loopPromise) return;
    this.disposed = false;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.disposed = true;
    if (this.loopPromise) {
      await this.loopPromise;
    }
    const tasks = Array.from(this.inflight);
    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.disposed) {
      const claimed = await this.fillAndDispatch();
      if (!claimed) {
        await Bun.sleep(this.pollIntervalMs);
      }
    }
    // drain whatever was queued before shutdown
    while (this.queue.length > 0) {
      this.drainQueue();
      if (this.queue.length > 0) {
        await Bun.sleep(10);
      }
    }
  }

  private async fillAndDispatch(): Promise<boolean> {
    if (this.disposed) return false;
    this.drainQueue();
    const availableSlots = Math.max(0, this.maxParallel - this.active - this.queue.length);
    if (availableSlots <= 0) {
      return false;
    }
    const batchSize = Math.min(this.claimBatchSize, availableSlots);
    const claims = await Promise.all(
      Array.from({ length: batchSize }, () => this.claimOnce()),
    );
    let claimedAny = false;
    for (const claim of claims) {
      if (!claim) continue;
      claimedAny = true;
      this.queue.push({ ...claim, enqueuedAt: Date.now() });
      this.observer.onEnqueue({
        requestId: claim.request.id,
        queueWaitMs: claim.queueWaitMs,
        queueDepth: this.queue.length,
      });
    }
    if (claimedAny) {
      this.drainQueue();
    }
    return claimedAny;
  }

  private drainQueue(): void {
    if (this.disposed) return;
    while (this.queue.length > 0 && this.active < this.maxParallel) {
      const next = this.queue.shift();
      if (!next) break;
      this.dispatch(next);
    }
  }

  private async claimOnce(): Promise<{ request: QueueRequestPayload; queueWaitMs: number } | null> {
    const started = Date.now();
    try {
      const res = await fetch(`${this.opts.server}/requests/claim`, {
        method: "POST",
        headers: this.opts.authHeaders(),
        body: JSON.stringify({ agentId: this.opts.agentId }),
      });
      const durationMs = Date.now() - started;
      if (!res.ok) {
        this.observer.onClaim({ result: "error", durationMs, status: res.status });
        return null;
      }
      const data = (await res.json()) as ClaimResponse;
      if (data.ok && data.request) {
        const waitMs = Math.max(0, Number(data.queueWaitMs ?? 0));
        this.observer.onClaim({
          result: "claimed",
          durationMs,
          requestId: data.request.id,
          queueWaitMs: waitMs,
        });
        return { request: data.request, queueWaitMs: waitMs };
      }
      this.observer.onClaim({ result: "empty", durationMs });
      return null;
    } catch (err) {
      const durationMs = Date.now() - started;
      this.observer.onClaim({ result: "error", durationMs, error: err });
      return null;
    }
  }

  private dispatch(item: PendingQueueItem): void {
    this.active += 1;
    const started = Date.now();
    this.observer.onDispatch({
      requestId: item.request.id,
      queueWaitMs: item.queueWaitMs,
      localDelayMs: started - item.enqueuedAt,
      active: this.active,
      queueDepth: this.queue.length,
    });

    const work = (async () => {
      let success = true;
      let error: unknown;
      try {
        await this.opts.onRequest(item.request, item.queueWaitMs);
      } catch (err) {
        success = false;
        error = err;
      }
      const durationMs = Date.now() - started;
      this.active = Math.max(0, this.active - 1);
      this.observer.onComplete({
        requestId: item.request.id,
        durationMs,
        success,
        error,
        active: this.active,
      });
    })();

    this.inflight.add(work);
    work
      .catch((err) => {
        console.error("[QueueWorker] handler pipeline error:", err);
      })
      .finally(() => {
        this.inflight.delete(work);
        if (!this.disposed) {
          this.drainQueue();
        }
      });
  }
}
