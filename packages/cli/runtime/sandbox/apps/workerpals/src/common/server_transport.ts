import type { CommandRequest } from "protocol";

export type WorkerHeartbeatStatus = "idle" | "busy" | "error" | "offline";

type QueuePriority = "high" | "normal";

type TransportTask = {
  label: string;
  priority: QueuePriority;
  droppable: boolean;
  run: () => Promise<void>;
  resolve: () => void;
};

export type WorkerServerTransportOptions = {
  server: string;
  headers: Record<string, string>;
  workerId: string;
  pollMs: number;
  heartbeatMs: number;
  staleClaimTtlMs: number;
  fetchFn?: typeof fetch;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
  nowFn?: () => number;
};

export type WorkerTransportHealthSnapshot = {
  heartbeatInFlight: boolean;
  consecutiveHeartbeatFailures: number;
  lastHeartbeatAttemptAt: number;
  lastHeartbeatSuccessAt: number;
  queuedRequests: number;
  droppedLogRequests: number;
};

export type WorkerHeartbeatPayload = {
  status: WorkerHeartbeatStatus;
  currentJobId: string | null;
  capabilities?: Record<string, unknown>;
  details?: Record<string, unknown>;
};

function computeHeartbeatTimeoutMs(heartbeatMs: number): number {
  return Math.max(1_500, Math.min(4_000, Math.floor(heartbeatMs * 0.8)));
}

function computeRequestTimeoutMs(heartbeatMs: number): number {
  return Math.max(4_000, Math.min(10_000, Math.floor(heartbeatMs * 2)));
}

async function readResponseDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.trim();
}

export class WorkerServerTransport {
  private readonly server: string;
  private readonly headers: Record<string, string>;
  private readonly workerId: string;
  private readonly pollMs: number;
  private readonly staleClaimTtlMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly logInfo: (message: string) => void;
  private readonly logWarn: (message: string) => void;
  private readonly nowFn: () => number;
  private readonly heartbeatTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxQueuedRequests = 256;

  private queuedRequests: TransportTask[] = [];
  private queueDrainInFlight = false;
  private queueFlushWaiters: Array<() => void> = [];
  private droppedLogRequests = 0;
  private heartbeatInFlight = false;
  private lastHeartbeatAttemptAt = 0;
  private lastHeartbeatSuccessAt = 0;
  private consecutiveHeartbeatFailures = 0;
  private firstHeartbeatFailureAt = -1;
  private lastHeartbeatFailureDetail = "";

  constructor(options: WorkerServerTransportOptions) {
    this.server = options.server;
    this.headers = options.headers;
    this.workerId = options.workerId;
    this.pollMs = options.pollMs;
    this.staleClaimTtlMs = options.staleClaimTtlMs;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logInfo = options.logInfo ?? ((message) => console.log(message));
    this.logWarn = options.logWarn ?? ((message) => console.warn(message));
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.heartbeatTimeoutMs = computeHeartbeatTimeoutMs(options.heartbeatMs);
    this.requestTimeoutMs = computeRequestTimeoutMs(options.heartbeatMs);
  }

  getHealthSnapshot(): WorkerTransportHealthSnapshot {
    return {
      heartbeatInFlight: this.heartbeatInFlight,
      consecutiveHeartbeatFailures: this.consecutiveHeartbeatFailures,
      lastHeartbeatAttemptAt: this.lastHeartbeatAttemptAt,
      lastHeartbeatSuccessAt: this.lastHeartbeatSuccessAt,
      queuedRequests: this.queuedRequests.length,
      droppedLogRequests: this.droppedLogRequests,
    };
  }

  getHeartbeatStaleAgeMs(nowMs = this.nowFn()): number {
    if (this.lastHeartbeatSuccessAt <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, nowMs - this.lastHeartbeatSuccessAt);
  }

  shouldRecycleBusyWorker(nowMs = this.nowFn()): boolean {
    const failureAgeMs =
      this.firstHeartbeatFailureAt >= 0
        ? Math.max(0, nowMs - this.firstHeartbeatFailureAt)
        : null;
    if (failureAgeMs == null) return false;
    const threshold = Math.min(
      this.staleClaimTtlMs,
      Math.max(
        30_000,
        Math.min(
          this.staleClaimTtlMs - this.heartbeatTimeoutMs,
          Math.floor(this.staleClaimTtlMs * 0.75),
        ),
      ),
    );
    return failureAgeMs >= threshold;
  }

  async sendHeartbeat(payload: WorkerHeartbeatPayload): Promise<boolean> {
    if (this.heartbeatInFlight) {
      return false;
    }
    this.heartbeatInFlight = true;
    this.lastHeartbeatAttemptAt = this.nowFn();
    try {
      const response = await this.postJson("/workers/heartbeat", {
        workerId: this.workerId,
        status: payload.status,
        currentJobId: payload.currentJobId,
        pollMs: this.pollMs,
        capabilities: payload.capabilities ?? {},
        details: payload.details ?? {},
      }, this.heartbeatTimeoutMs);
      if (!response.ok) {
        const detail = await readResponseDetail(response);
        throw new Error(
          `heartbeat rejected (${response.status})${detail ? `: ${detail}` : ""}`,
        );
      }
      const previousFailures = this.consecutiveHeartbeatFailures;
      this.lastHeartbeatSuccessAt = this.nowFn();
      this.consecutiveHeartbeatFailures = 0;
      this.firstHeartbeatFailureAt = -1;
      this.lastHeartbeatFailureDetail = "";
      if (previousFailures > 0) {
        this.logInfo(
          `[WorkerPals] Heartbeat recovered for ${this.workerId} after ${previousFailures} failed attempt(s).`,
        );
      }
      return true;
    } catch (error) {
      if (this.consecutiveHeartbeatFailures === 0) {
        this.firstHeartbeatFailureAt = this.nowFn();
      }
      this.consecutiveHeartbeatFailures += 1;
      this.lastHeartbeatFailureDetail = error instanceof Error ? error.message : String(error);
      const staleAgeMs = this.getHeartbeatStaleAgeMs();
      this.logWarn(
        `[WorkerPals] Heartbeat failure ${this.consecutiveHeartbeatFailures} for ${this.workerId}: ${this.lastHeartbeatFailureDetail} (lastSuccessAgeMs=${Number.isFinite(staleAgeMs) ? staleAgeMs : -1}).`,
      );
      return false;
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  queueSessionCommand(
    sessionId: string,
    cmd: CommandRequest,
    options: { priority?: QueuePriority; droppable?: boolean } = {},
  ): Promise<void> {
    return this.enqueueTask({
      label: `command:${cmd.type}`,
      priority: options.priority ?? "normal",
      droppable: options.droppable ?? false,
      run: async () => {
        const response = await this.postJson(
          `/sessions/${sessionId}/command`,
          cmd,
          this.requestTimeoutMs,
        );
        if (!response.ok) {
          const detail = await readResponseDetail(response);
          this.logWarn(
            `[WorkerPals] Command ${cmd.type} failed: ${response.status}${detail ? ` ${detail}` : ""}`,
          );
        }
      },
    });
  }

  queueJobLog(
    jobId: string,
    payload: { stream: "stdout" | "stderr"; seq: number; message: string; ts: string },
  ): Promise<void> {
    return this.enqueueTask({
      label: "job_log",
      priority: "normal",
      droppable: true,
      run: async () => {
        const response = await this.postJson(`/jobs/${jobId}/log`, payload, this.requestTimeoutMs);
        if (!response.ok) {
          const detail = await readResponseDetail(response);
          this.logWarn(
            `[WorkerPals] Job log delivery failed for ${jobId}: ${response.status}${detail ? ` ${detail}` : ""}`,
          );
        }
      },
    });
  }

  async flush(timeoutMs = 15_000): Promise<void> {
    if (this.queuedRequests.length === 0 && !this.queueDrainInFlight) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.logWarn(
          `[WorkerPals] Timed out flushing queued server transport requests after ${timeoutMs}ms (queued=${this.queuedRequests.length}).`,
        );
        resolve();
      }, timeoutMs);
      this.queueFlushWaiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      this.maybeResolveFlushWaiters();
    });
  }

  private enqueueTask(task: Omit<TransportTask, "resolve">): Promise<void> {
    if (task.droppable && this.queuedRequests.length >= this.maxQueuedRequests) {
      this.droppedLogRequests += 1;
      if (this.droppedLogRequests === 1 || this.droppedLogRequests % 25 === 0) {
        this.logWarn(
          `[WorkerPals] Dropped ${this.droppedLogRequests} queued low-priority transport request(s) because the queue is saturated (limit=${this.maxQueuedRequests}).`,
        );
      }
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const queued: TransportTask = { ...task, resolve };
      if (queued.priority === "high") {
        const firstNormalIndex = this.queuedRequests.findIndex((entry) => entry.priority !== "high");
        if (firstNormalIndex === -1) {
          this.queuedRequests.push(queued);
        } else {
          this.queuedRequests.splice(firstNormalIndex, 0, queued);
        }
      } else {
        this.queuedRequests.push(queued);
      }
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.queueDrainInFlight) return;
    this.queueDrainInFlight = true;
    try {
      while (this.queuedRequests.length > 0) {
        const task = this.queuedRequests.shift();
        if (!task) break;
        try {
          await task.run();
        } catch (error) {
          this.logWarn(
            `[WorkerPals] Transport request ${task.label} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          task.resolve();
        }
      }
    } finally {
      this.queueDrainInFlight = false;
      this.maybeResolveFlushWaiters();
    }
  }

  private maybeResolveFlushWaiters(): void {
    if (this.queuedRequests.length > 0 || this.queueDrainInFlight) return;
    const waiters = this.queueFlushWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private async postJson(path: string, payload: unknown, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      return await this.fetchFn(`${this.server}${path}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`request timed out after ${timeoutMs}ms (${path})`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
