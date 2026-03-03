/**
 * Queue runner instrumentation + latency monitoring.
 *
 * Single-file implementation (code + tests) to satisfy the max-files constraint.
 */

type Clock = () => number;

export type JobPriority = "interactive" | "normal" | "background" | (string & {});
export type QueueJobState =
  | "enqueued"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "retried"
  | "dead-lettered"
  | "skipped";

export interface QueueJob {
  id: string;
  priority: JobPriority;
  enqueuedAt: number;
  metadata?: Record<string, unknown>;
}

export type TelemetryEvent =
  | {
      type: "job_state_transition";
      jobId: string;
      from: QueueJobState;
      to: QueueJobState;
      priority: JobPriority;
      timestamp: number;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "job_latency";
      jobId: string;
      latencyMs: number;
      rollingP95Ms: number | null;
      sampleSize: number;
      priority: JobPriority;
      outcome: "completed" | "failed";
      timestamp: number;
    }
  | {
      type: "queue_fast_fail_alert";
      jobId: string;
      priority: JobPriority;
      p95LatencyMs: number;
      slaMs: number;
      sampleSize: number;
      timestamp: number;
    };

export interface TelemetrySink {
  emit(event: TelemetryEvent): void | Promise<void>;
}

export class NoopTelemetrySink implements TelemetrySink {
  emit(): void {}
}

const DEFAULT_PRIORITY_SLA_MS: Record<JobPriority, number> = {
  interactive: 20_000,
  normal: 90_000,
  background: 240_000,
};

export interface RollingLatencyOptions {
  windowSize?: number;
  windowMs?: number;
  minSamplesForSla?: number;
  slaMs?: number | Record<JobPriority, number>;
  cooldownMs?: number;
  clock?: Clock;
}

type Sample = { latencyMs: number; ts: number };

export interface RollingSummary {
  p95LatencyMs: number | null;
  sampleSize: number;
  latestLatencyMs: number;
  slaMs: number;
}

export class RollingLatencyMonitor {
  private readonly buckets = new Map<JobPriority, Sample[]>();
  private readonly lastAlertAt = new Map<JobPriority, number>();
  private readonly windowSize: number;
  private readonly windowMs: number;
  private readonly minSamplesForSla: number;
  private readonly cooldownMs: number;
  private readonly clock: Clock;

  constructor(private readonly options: RollingLatencyOptions = {}) {
    this.windowSize = Math.max(1, options.windowSize ?? 50);
    this.windowMs = Math.max(1, options.windowMs ?? 5 * 60_000);
    this.minSamplesForSla = Math.max(1, options.minSamplesForSla ?? 5);
    this.cooldownMs = Math.max(1, options.cooldownMs ?? 30_000);
    this.clock = options.clock ?? (() => Date.now());
  }

  record(priority: JobPriority, latencyMs: number, timestamp = this.clock()): RollingSummary {
    const bucket = this.ensureBucket(priority);
    bucket.push({ latencyMs, ts: timestamp });
    this.trim(bucket, timestamp);
    if (bucket.length > this.windowSize) {
      bucket.splice(0, bucket.length - this.windowSize);
    }
    return {
      p95LatencyMs: this.computeP95(bucket),
      sampleSize: bucket.length,
      latestLatencyMs: latencyMs,
      slaMs: this.slaFor(priority),
    };
  }

  shouldFastFail(priority: JobPriority, timestamp = this.clock()): RollingSummary | null {
    const bucket = this.ensureBucket(priority);
    this.trim(bucket, timestamp);
    if (bucket.length < this.minSamplesForSla) return null;
    const p95 = this.computeP95(bucket);
    if (p95 === null) return null;
    const slaMs = this.slaFor(priority);
    if (p95 <= slaMs) return null;
    const lastAlertAt = this.lastAlertAt.get(priority) ?? 0;
    if (timestamp - lastAlertAt < this.cooldownMs) {
      return null;
    }
    this.lastAlertAt.set(priority, timestamp);
    return {
      p95LatencyMs: p95,
      sampleSize: bucket.length,
      latestLatencyMs: bucket[bucket.length - 1]?.latencyMs ?? p95,
      slaMs,
    };
  }

  private ensureBucket(priority: JobPriority): Sample[] {
    if (!this.buckets.has(priority)) {
      this.buckets.set(priority, []);
    }
    return this.buckets.get(priority)!;
  }

  private trim(bucket: Sample[], now: number): void {
    while (bucket.length > 0 && now - bucket[0]!.ts > this.windowMs) {
      bucket.shift();
    }
  }

  private computeP95(bucket: Sample[]): number | null {
    if (bucket.length === 0) return null;
    const sorted = bucket.map((sample) => sample.latencyMs).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
    return sorted[idx]!;
  }

  private slaFor(priority: JobPriority): number {
    const { slaMs } = this.options;
    if (typeof slaMs === "number") return slaMs;
    if (slaMs && priority in slaMs) {
      return slaMs[priority as keyof typeof slaMs]!;
    }
    if (priority in DEFAULT_PRIORITY_SLA_MS) {
      return DEFAULT_PRIORITY_SLA_MS[priority];
    }
    return DEFAULT_PRIORITY_SLA_MS.normal;
  }
}

export class FastFailError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly priority: JobPriority,
    public readonly p95LatencyMs: number,
    public readonly slaMs: number,
  ) {
    super(
      `Fast-failed ${jobId} (${priority}) because rolling p95 ${p95LatencyMs}ms exceeded SLA ${slaMs}ms`,
    );
    this.name = "FastFailError";
  }
}

export interface QueueRunnerOptions {
  telemetry?: TelemetrySink;
  monitor?: RollingLatencyMonitor;
  fastFailEnabled?: boolean;
  clock?: Clock;
}

export type JobExecutor<T> = (job: QueueJob) => Promise<T>;

export class QueueRunner {
  private readonly telemetry: TelemetrySink;
  private readonly monitor: RollingLatencyMonitor;
  private readonly fastFailEnabled: boolean;
  private readonly clock: Clock;

  constructor(private readonly options: QueueRunnerOptions = {}) {
    this.telemetry = options.telemetry ?? new NoopTelemetrySink();
    this.monitor = options.monitor ?? new RollingLatencyMonitor();
    this.fastFailEnabled = options.fastFailEnabled ?? true;
    this.clock = options.clock ?? (() => Date.now());
  }

  markEnqueued(job: QueueJob, metadata?: Record<string, unknown>): void {
    this.emitTransition(job, "enqueued", "pending", metadata);
  }

  markRetried(job: QueueJob, metadata?: Record<string, unknown>): void {
    this.emitTransition(job, "failed", "retried", metadata);
    this.emitTransition(job, "retried", "pending", metadata);
  }

  markDeadLettered(job: QueueJob, metadata?: Record<string, unknown>): void {
    this.emitTransition(job, "failed", "dead-lettered", metadata);
  }

  async run<T>(job: QueueJob, executor: JobExecutor<T>): Promise<T> {
    const now = this.clock();
    if (this.fastFailEnabled) {
      const breach = this.monitor.shouldFastFail(job.priority, now);
      if (breach) {
        this.emitTransition(job, "pending", "skipped", {
          p95LatencyMs: breach.p95LatencyMs,
          slaMs: breach.slaMs,
        });
        this.telemetry.emit({
          type: "queue_fast_fail_alert",
          jobId: job.id,
          priority: job.priority,
          p95LatencyMs: breach.p95LatencyMs,
          slaMs: breach.slaMs,
          sampleSize: breach.sampleSize,
          timestamp: now,
        });
        throw new FastFailError(job.id, job.priority, breach.p95LatencyMs, breach.slaMs);
      }
    }

    this.emitTransition(job, "pending", "running");
    const start = this.clock();
    try {
      const result = await executor(job);
      const latencyMs = this.clock() - start;
      this.emitTransition(job, "running", "completed");
      this.emitLatency(job, latencyMs, "completed");
      return result;
    } catch (error) {
      const latencyMs = this.clock() - start;
      this.emitTransition(job, "running", "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.emitLatency(job, latencyMs, "failed");
      throw error;
    }
  }

  private emitTransition(
    job: QueueJob,
    from: QueueJobState,
    to: QueueJobState,
    metadata?: Record<string, unknown>,
  ): void {
    this.telemetry.emit({
      type: "job_state_transition",
      jobId: job.id,
      from,
      to,
      priority: job.priority,
      timestamp: this.clock(),
      metadata,
    });
  }

  private emitLatency(job: QueueJob, latencyMs: number, outcome: "completed" | "failed"): void {
    const summary = this.monitor.record(job.priority, latencyMs, this.clock());
    this.telemetry.emit({
      type: "job_latency",
      jobId: job.id,
      latencyMs,
      rollingP95Ms: summary.p95LatencyMs,
      sampleSize: summary.sampleSize,
      priority: job.priority,
      outcome,
      timestamp: this.clock(),
    });
  }
}

// ── Tests (guarded to avoid bun:test import during production builds) ────────────
if (typeof process !== "undefined" && process.env?.NODE_ENV === "test") {
  const { describe, expect, test } = await import("bun:test");

  class FakeClock {
    private current = 0;
    now = (): number => this.current;
    advance(ms: number): void {
      this.current += ms;
    }
  }

  class MemorySink implements TelemetrySink {
    readonly events: TelemetryEvent[] = [];
    emit(event: TelemetryEvent): void {
      this.events.push(event);
    }
  }

  const buildRunner = (clock: FakeClock, sink: MemorySink, monitor?: RollingLatencyMonitor) =>
    new QueueRunner({
      telemetry: sink,
      monitor:
        monitor ??
        new RollingLatencyMonitor({
          windowSize: 10,
          minSamplesForSla: 3,
          slaMs: 100,
          clock: clock.now,
          cooldownMs: 1,
        }),
      fastFailEnabled: true,
      clock: clock.now,
    });

  describe("QueueRunner instrumentation", () => {
    test("emits transitions and per-job latency", async () => {
      const clock = new FakeClock();
      const sink = new MemorySink();
      const runner = buildRunner(clock, sink);
      const job: QueueJob = { id: "job-1", priority: "interactive", enqueuedAt: 0 };

      const result = await runner.run(job, async () => {
        clock.advance(75);
        return "ok";
      });

      expect(result).toBe("ok");
      const transitions = sink.events.filter(
        (evt): evt is Extract<TelemetryEvent, { type: "job_state_transition" }> =>
          evt.type === "job_state_transition",
      );
      expect(transitions.map((evt) => [evt.from, evt.to])).toEqual([
        ["pending", "running"],
        ["running", "completed"],
      ]);
      const latencyEvent = sink.events.find(
        (evt): evt is Extract<TelemetryEvent, { type: "job_latency" }> =>
          evt.type === "job_latency",
      );
      expect(latencyEvent?.latencyMs).toBe(75);
      expect(latencyEvent?.rollingP95Ms).toBe(75);
      expect(latencyEvent?.sampleSize).toBe(1);
    });

    test("records failure transitions and latency", async () => {
      const clock = new FakeClock();
      const sink = new MemorySink();
      const runner = buildRunner(clock, sink);
      const job: QueueJob = { id: "job-2", priority: "normal", enqueuedAt: 0 };

      await expect(
        runner.run(job, async () => {
          clock.advance(40);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const lastTransition = sink.events
        .filter(
          (evt): evt is Extract<TelemetryEvent, { type: "job_state_transition" }> =>
            evt.type === "job_state_transition",
        )
        .at(-1);
      expect(lastTransition?.to).toBe("failed");
      const latencyEvent = sink.events.find(
        (evt): evt is Extract<TelemetryEvent, { type: "job_latency" }> =>
          evt.type === "job_latency",
      );
      expect(latencyEvent?.outcome).toBe("failed");
      expect(latencyEvent?.latencyMs).toBe(40);
    });

    test("triggers fast-fail alerts when rolling p95 exceeds SLA", async () => {
      const clock = new FakeClock();
      const sink = new MemorySink();
      const runner = buildRunner(clock, sink);

      const jobFactory = (idx: number): QueueJob => ({
        id: `job-${idx}`,
        priority: "interactive",
        enqueuedAt: 0,
      });

      for (let i = 0; i < 3; i++) {
        await runner.run(jobFactory(i), async () => {
          clock.advance(200);
        });
      }

      await expect(
        runner.run(jobFactory(99), async () => {
          clock.advance(10);
        }),
      ).rejects.toThrow(FastFailError);

      const alert = sink.events.find(
        (evt): evt is Extract<TelemetryEvent, { type: "queue_fast_fail_alert" }> =>
          evt.type === "queue_fast_fail_alert",
      );
      expect(alert?.p95LatencyMs).toBeGreaterThan(alert?.slaMs ?? Infinity);
      const skipped = sink.events.find(
        (evt): evt is Extract<TelemetryEvent, { type: "job_state_transition" }> =>
          evt.type === "job_state_transition" && evt.to === "skipped",
      );
      expect(skipped?.metadata?.p95LatencyMs).toBe(alert?.p95LatencyMs);
    });

    test("emits lifecycle transitions for enqueued, retried, and dead-lettered paths", async () => {
      const clock = new FakeClock();
      const sink = new MemorySink();
      const runner = buildRunner(clock, sink);
      const job: QueueJob = { id: "job-life", priority: "normal", enqueuedAt: 0 };

      runner.markEnqueued(job, { source: "ingress" });

      await expect(
        runner.run(job, async () => {
          clock.advance(10);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      runner.markRetried(job, { attempt: 2, delayMs: 5000 });

      await expect(
        runner.run(job, async () => {
          clock.advance(15);
          throw new Error("boom again");
        }),
      ).rejects.toThrow("boom again");

      runner.markDeadLettered(job, { reason: "max retries" });

      const transitions = sink.events
        .filter(
          (evt): evt is Extract<TelemetryEvent, { type: "job_state_transition" }> =>
            evt.type === "job_state_transition",
        )
        .map((evt) => [evt.from, evt.to]);

      expect(transitions).toEqual([
        ["enqueued", "pending"],
        ["pending", "running"],
        ["running", "failed"],
        ["failed", "retried"],
        ["retried", "pending"],
        ["pending", "running"],
        ["running", "failed"],
        ["failed", "dead-lettered"],
      ]);
    });
  });

  describe("RollingLatencyMonitor behavior", () => {
    test("drops stale samples when tracking p95 and surfaces SLA breaches", () => {
      const clock = new FakeClock();
      const monitor = new RollingLatencyMonitor({
        windowSize: 5,
        windowMs: 100,
        minSamplesForSla: 2,
        slaMs: 100,
        clock: clock.now,
        cooldownMs: 1,
      });
      const priority: JobPriority = "normal";

      monitor.record(priority, 10, clock.now());
      clock.advance(50);
      monitor.record(priority, 20, clock.now());
      clock.advance(50);
      monitor.record(priority, 30, clock.now());
      clock.advance(150);

      const summary = monitor.record(priority, 1000, clock.now());
      expect(summary.sampleSize).toBe(2);
      expect(summary.p95LatencyMs).toBe(1000);

      const breach = monitor.shouldFastFail(priority, clock.now());
      expect(breach).not.toBeNull();
      expect(breach?.p95LatencyMs).toBe(1000);
      expect(breach?.sampleSize).toBe(2);
    });
  });
}
