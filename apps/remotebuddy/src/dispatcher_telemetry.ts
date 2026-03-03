type DispatcherQueuePriority = "interactive" | "normal" | "background";
export type DispatcherTelemetryEvent =
  | "activate"
  | "hold"
  | "recovery"
  | "clear"
  | "insufficient_data"
  | "tick";
export type DispatcherBackpressurePhase =
  | "inactive"
  | "active"
  | "hold"
  | "recovery"
  | "insufficient_data";

export interface DispatcherTelemetryPayload {
  event: DispatcherTelemetryEvent;
  emittedAt: string;
  ingestion: {
    sampleCount: number;
    sampleWindowMs: number;
    p95: number | null;
    avg: number | null;
    latestQueueWaitMs: number | null;
    latestPriority: DispatcherQueuePriority | null;
    latestSampleAt: string | null;
  };
  backpressure: {
    phase: DispatcherBackpressurePhase;
    activationThresholdMs: number;
    releaseThresholdMs: number;
    minSamples: number;
    activatedAt: string | null;
    holdSince: string | null;
    recoverySince: string | null;
    insufficientSince: string | null;
  };
}

export interface DispatcherTelemetryOptions {
  enabled: boolean;
  emitIntervalMs: number;
  sampleTtlMs: number;
  minSamples: number;
  backpressure: {
    enabled: boolean;
    activationThresholdMs: number;
    releaseThresholdMs: number;
    minSamples: number;
    throttle: {
      activeDelayMs: number;
      recoveryDelayMs: number;
    };
  };
  emit: (payload: DispatcherTelemetryPayload) => void | Promise<void>;
  now?: () => number;
}

interface TelemetrySample {
  value: number;
  priority: DispatcherQueuePriority;
  ts: number;
}

interface TelemetryStats {
  sampleCount: number;
  p95: number | null;
  avg: number | null;
}

function normalizePriority(value: unknown): DispatcherQueuePriority {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "interactive" || text === "background") return text;
  return "normal";
}

function percentile(values: number[], percentileRank: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? null;
}

export class DispatcherTelemetry {
  private readonly samples: TelemetrySample[] = [];
  private stats: TelemetryStats = { sampleCount: 0, p95: null, avg: null };
  private lastSample: TelemetrySample | null = null;
  private lastTickEmitMs = 0;
  private readonly backpressure = {
    phase: "inactive" as DispatcherBackpressurePhase,
    activatedAtMs: null as number | null,
    holdSinceMs: null as number | null,
    recoverySinceMs: null as number | null,
    insufficientSinceMs: null as number | null,
  };
  private recoverySampleCount = 0;

  constructor(private readonly options: DispatcherTelemetryOptions) {}

  recordQueueSample(sample: { queueWaitMs: number | null | undefined; priority: unknown }): void {
    if (!this.options.enabled) return;
    const value = Number(sample.queueWaitMs);
    if (!Number.isFinite(value) || value < 0) return;
    const now = this.now();
    const normalized: TelemetrySample = {
      value: Math.floor(value),
      priority: normalizePriority(sample.priority),
      ts: now,
    };
    this.samples.push(normalized);
    this.trimSamples(now);
    this.lastSample = this.samples[this.samples.length - 1] ?? null;
    this.stats = this.computeStats();
    const transition = this.evaluateBackpressure(now, "sample");
    if (transition) {
      this.emit(transition, now);
    }
  }

  maybeEmitTick(now = this.now()): void {
    if (!this.options.enabled) return;
    this.trimSamples(now);
    this.lastSample = this.samples[this.samples.length - 1] ?? null;
    this.stats = this.computeStats();
    const transition = this.evaluateBackpressure(now, "tick");
    if (transition) {
      this.emit(transition, now);
    }
    if (this.lastTickEmitMs === 0 || now - this.lastTickEmitMs >= this.options.emitIntervalMs) {
      this.lastTickEmitMs = now;
      this.emit("tick", now);
    }
  }

  getIntakeDelayMs(): number {
    if (!this.options.enabled || !this.options.backpressure.enabled) return 0;
    const { throttle } = this.options.backpressure;
    switch (this.backpressure.phase) {
      case "active":
      case "hold":
      case "insufficient_data":
        return throttle.activeDelayMs;
      case "recovery":
        return throttle.recoveryDelayMs;
      default:
        return 0;
    }
  }

  getPhase(): DispatcherBackpressurePhase {
    return this.backpressure.phase;
  }

  private now(): number {
    return typeof this.options.now === "function" ? this.options.now() : Date.now();
  }

  private trimSamples(now: number): void {
    if (this.samples.length === 0) return;
    const cutoff = now - this.options.sampleTtlMs;
    while (this.samples.length > 0 && this.samples[0].ts < cutoff) {
      this.samples.shift();
    }
  }

  private computeStats(): TelemetryStats {
    if (this.samples.length === 0) {
      return { sampleCount: 0, p95: null, avg: null };
    }
    const values = this.samples.map((sample) => sample.value);
    const sum = values.reduce((acc, value) => acc + value, 0);
    return {
      sampleCount: values.length,
      p95: percentile(values, 95),
      avg: Math.round(sum / values.length),
    };
  }

  private evaluateBackpressure(
    now: number,
    source: "sample" | "tick",
  ): DispatcherTelemetryEvent | null {
    if (!this.options.backpressure.enabled) {
      if (this.backpressure.phase === "inactive") return null;
      this.resetBackpressure();
      return "clear";
    }

    const { activationThresholdMs, releaseThresholdMs, minSamples } = this.options.backpressure;
    const sampleCount = this.stats.sampleCount;
    const p95 = this.stats.p95;
    const phase = this.backpressure.phase;

    if (phase === "inactive") {
      if (sampleCount >= minSamples && p95 != null && p95 >= activationThresholdMs) {
        return this.transitionPhase("active", now);
      }
      return null;
    }

    if (sampleCount < minSamples || p95 == null) {
      if (phase === "insufficient_data") return null;
      return this.transitionPhase("insufficient_data", now);
    }

    if (p95 >= activationThresholdMs) {
      if (phase === "active") {
        return this.transitionPhase("hold", now);
      }
      if (phase !== "hold") {
        this.recoverySampleCount = 0;
        return this.transitionPhase("hold", now);
      }
      this.recoverySampleCount = 0;
      return null;
    }

    if (p95 <= releaseThresholdMs) {
      if (phase === "recovery") {
        if (source === "sample") {
          this.recoverySampleCount += 1;
        }
        if (this.recoverySampleCount >= minSamples) {
          this.resetBackpressure();
          return "clear";
        }
        return null;
      }
      this.recoverySampleCount = 1;
      return this.transitionPhase("recovery", now);
    }

    if (phase !== "hold") {
      this.recoverySampleCount = 0;
      return this.transitionPhase("hold", now);
    }
    this.recoverySampleCount = 0;
    return null;
  }

  private transitionPhase(
    next: DispatcherBackpressurePhase,
    now: number,
  ): DispatcherTelemetryEvent {
    if (next === "inactive") {
      this.resetBackpressure();
      return "clear";
    }
    this.backpressure.phase = next;
    switch (next) {
      case "active":
        this.backpressure.activatedAtMs = now;
        this.backpressure.holdSinceMs = null;
        this.backpressure.recoverySinceMs = null;
        this.backpressure.insufficientSinceMs = null;
        this.recoverySampleCount = 0;
        return "activate";
      case "hold":
        this.backpressure.holdSinceMs = now;
        this.backpressure.recoverySinceMs = null;
        this.backpressure.insufficientSinceMs = null;
        this.recoverySampleCount = 0;
        return "hold";
      case "recovery":
        this.backpressure.recoverySinceMs = now;
        this.backpressure.holdSinceMs = null;
        this.backpressure.insufficientSinceMs = null;
        this.recoverySampleCount = 1;
        return "recovery";
      case "insufficient_data":
        this.backpressure.insufficientSinceMs = now;
        return "insufficient_data";
      default:
        return "tick";
    }
  }

  private resetBackpressure(): void {
    this.backpressure.phase = "inactive";
    this.backpressure.activatedAtMs = null;
    this.backpressure.holdSinceMs = null;
    this.backpressure.recoverySinceMs = null;
    this.backpressure.insufficientSinceMs = null;
    this.recoverySampleCount = 0;
  }

  private emit(event: DispatcherTelemetryEvent, now: number): void {
    if (!this.options.enabled) return;
    const payload: DispatcherTelemetryPayload = {
      event,
      emittedAt: new Date(now).toISOString(),
      ingestion: {
        sampleCount: this.stats.sampleCount,
        sampleWindowMs: this.options.sampleTtlMs,
        p95: this.stats.p95,
        avg: this.stats.avg,
        latestQueueWaitMs: this.lastSample ? this.lastSample.value : null,
        latestPriority: this.lastSample ? this.lastSample.priority : null,
        latestSampleAt: this.lastSample ? new Date(this.lastSample.ts).toISOString() : null,
      },
      backpressure: {
        phase: this.backpressure.phase,
        activationThresholdMs: this.options.backpressure.activationThresholdMs,
        releaseThresholdMs: this.options.backpressure.releaseThresholdMs,
        minSamples: this.options.backpressure.minSamples,
        activatedAt: this.backpressure.activatedAtMs
          ? new Date(this.backpressure.activatedAtMs).toISOString()
          : null,
        holdSince: this.backpressure.holdSinceMs
          ? new Date(this.backpressure.holdSinceMs).toISOString()
          : null,
        recoverySince: this.backpressure.recoverySinceMs
          ? new Date(this.backpressure.recoverySinceMs).toISOString()
          : null,
        insufficientSince: this.backpressure.insufficientSinceMs
          ? new Date(this.backpressure.insufficientSinceMs).toISOString()
          : null,
      },
    };
    try {
      const result = this.options.emit(payload);
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch(() => {
          // swallow telemetry emission errors
        });
      }
    } catch {
      // ignore telemetry emit failures
    }
  }
}
