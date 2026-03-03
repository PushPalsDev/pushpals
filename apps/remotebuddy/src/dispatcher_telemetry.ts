export type DispatcherRequestPriority = "interactive" | "normal" | "background";

export interface MetricSummary {
  sampleCount: number;
  totalSamples: number;
  last: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  p50: number | null;
  p95: number | null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function percentile(sortedValues: number[], percentileRank: number): number | null {
  if (sortedValues.length === 0) return null;
  if (percentileRank <= 0) return sortedValues[0] ?? null;
  if (percentileRank >= 100) return sortedValues[sortedValues.length - 1] ?? null;
  const idx = Math.ceil((percentileRank / 100) * sortedValues.length) - 1;
  const clampedIdx = Math.max(0, Math.min(sortedValues.length - 1, idx));
  return sortedValues[clampedIdx] ?? null;
}

class MetricWindow {
  private readonly values: number[] = [];
  private lastValue: number | null = null;
  private totalSamples = 0;

  constructor(private readonly capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  add(value: number): void {
    if (!isFiniteNonNegative(value)) return;
    this.values.push(value);
    this.lastValue = value;
    this.totalSamples += 1;
    if (this.values.length > this.capacity) {
      this.values.shift();
    }
  }

  snapshot(): MetricSummary {
    if (this.values.length === 0) {
      return {
        sampleCount: 0,
        totalSamples: this.totalSamples,
        last: null,
        min: null,
        max: null,
        avg: null,
        p50: null,
        p95: null,
      };
    }
    const sorted = [...this.values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    const avg = sum / sorted.length;
    return {
      sampleCount: sorted.length,
      totalSamples: this.totalSamples,
      last: this.lastValue,
      min: sorted[0] ?? null,
      max: sorted[sorted.length - 1] ?? null,
      avg: Number.isFinite(avg) ? Math.round(avg) : null,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
    };
  }
}

export interface DispatcherTelemetrySnapshot {
  queueWaitMs: MetricSummary;
  dispatchLatencyMs: MetricSummary;
  concurrency: {
    pending: number;
    active: number;
    managedWorkers: number;
    maxWorkers: number;
  };
  lastPriority: DispatcherRequestPriority | null;
  backpressure: DispatcherBackpressureState;
}

export type DispatcherBackpressurePhase =
  | "inactive"
  | "active_hold"
  | "recovery_pending";

export interface DispatcherBackpressureState {
  active: boolean;
  phase: DispatcherBackpressurePhase;
  code: string | null;
  reason: string | null;
  triggeredAtMs: number | null;
  lastObservedLatencyP95Ms: number | null;
  releaseEligibleAtMs: number | null;
  intakeHoldMs: number | null;
}

const DEFAULT_BACKPRESSURE_STATE: DispatcherBackpressureState = {
  active: false,
  phase: "inactive",
  code: null,
  reason: null,
  triggeredAtMs: null,
  lastObservedLatencyP95Ms: null,
  releaseEligibleAtMs: null,
  intakeHoldMs: null,
};

export class DispatcherTelemetry {
  private readonly queueWaitWindow: MetricWindow;
  private readonly dispatchLatencyWindow: MetricWindow;
  private pendingDispatches = 0;
  private activeDispatches = 0;
  private managedWorkers = 0;
  private maxWorkers = 0;
  private lastPriority: DispatcherRequestPriority | null = null;
  private backpressure: DispatcherBackpressureState = { ...DEFAULT_BACKPRESSURE_STATE };

  constructor(opts?: { queueWindowSize?: number; dispatchWindowSize?: number }) {
    const queueWindowSize = opts?.queueWindowSize ?? 120;
    const dispatchWindowSize = opts?.dispatchWindowSize ?? 120;
    this.queueWaitWindow = new MetricWindow(queueWindowSize);
    this.dispatchLatencyWindow = new MetricWindow(dispatchWindowSize);
  }

  incrementPending(): void {
    this.pendingDispatches += 1;
  }

  beginDispatch(meta: { queueWaitMs?: number; priority?: DispatcherRequestPriority }): void {
    if (this.pendingDispatches > 0) {
      this.pendingDispatches -= 1;
    }
    this.activeDispatches += 1;
    if (isFiniteNonNegative(meta.queueWaitMs)) {
      this.queueWaitWindow.add(Math.round(meta.queueWaitMs));
    }
    if (meta.priority) {
      this.lastPriority = meta.priority;
    }
  }

  completeDispatch(latencyMs: number): void {
    if (isFiniteNonNegative(latencyMs)) {
      this.dispatchLatencyWindow.add(Math.round(latencyMs));
    }
    if (this.activeDispatches > 0) {
      this.activeDispatches -= 1;
    }
  }

  setWorkerPoolStats(stats: { managed: number; max: number }): void {
    this.managedWorkers = Math.max(0, Math.floor(stats.managed));
    this.maxWorkers = Math.max(1, Math.floor(stats.max));
  }

  setBackpressureState(state: DispatcherBackpressureState): void {
    this.backpressure = { ...state };
  }

  snapshot(): DispatcherTelemetrySnapshot {
    return {
      queueWaitMs: this.queueWaitWindow.snapshot(),
      dispatchLatencyMs: this.dispatchLatencyWindow.snapshot(),
      concurrency: {
        pending: this.pendingDispatches,
        active: this.activeDispatches,
        managedWorkers: this.managedWorkers,
        maxWorkers: this.maxWorkers,
      },
      lastPriority: this.lastPriority,
      backpressure: { ...this.backpressure },
    };
  }
}

export interface DispatcherBackpressureOptions {
  triggerP95Ms?: number;
  releaseP95Ms?: number;
  minHoldMs?: number;
  minSamples?: number;
}

export interface DispatcherBackpressureSignal {
  active: boolean;
  phase: DispatcherBackpressurePhase;
  code: string;
  reason: string;
  triggeredAtMs: number;
  intakeHoldMs?: number;
}

export interface BackpressureEvaluation {
  changed: boolean;
  state: DispatcherBackpressureState;
  event: "activated" | "cleared" | null;
  signal: DispatcherBackpressureSignal | null;
}

const DEFAULT_TRIGGER_P95_MS = 1_500;
const DEFAULT_RELEASE_P95_MS = 1_000;
const DEFAULT_MIN_HOLD_MS = 60_000;
const DEFAULT_MIN_SAMPLES = 5;

export class DispatcherBackpressureController {
  private readonly triggerP95Ms: number;
  private readonly releaseP95Ms: number;
  private readonly minHoldMs: number;
  private readonly minSamples: number;
  private state: DispatcherBackpressureState = { ...DEFAULT_BACKPRESSURE_STATE };
  private lastClearSampleVersion = 0;

  constructor(options: DispatcherBackpressureOptions = {}) {
    this.triggerP95Ms = Math.max(1, options.triggerP95Ms ?? DEFAULT_TRIGGER_P95_MS);
    this.releaseP95Ms = Math.max(0, options.releaseP95Ms ?? DEFAULT_RELEASE_P95_MS);
    this.minHoldMs = Math.max(1_000, options.minHoldMs ?? DEFAULT_MIN_HOLD_MS);
    this.minSamples = Math.max(1, Math.floor(options.minSamples ?? DEFAULT_MIN_SAMPLES));
  }

  evaluate(snapshot: DispatcherTelemetrySnapshot, now = Date.now()): BackpressureEvaluation {
    const latencySummary = snapshot.dispatchLatencyMs;
    const p95 = isFiniteNonNegative(latencySummary.p95 ?? null) ? Number(latencySummary.p95) : null;
    const sampleCount = latencySummary.sampleCount ?? 0;
    const sampleVersion = isFiniteNonNegative(latencySummary.totalSamples ?? null)
      ? Number(latencySummary.totalSamples)
      : sampleCount;
    this.state = {
      ...this.state,
      lastObservedLatencyP95Ms: p95,
    };

    if (!this.state.active) {
      const shouldActivate =
        sampleVersion > this.lastClearSampleVersion &&
        p95 != null &&
        sampleCount >= this.minSamples &&
        p95 >= this.triggerP95Ms;
      if (shouldActivate) {
        const triggeredAtMs = now;
        const releaseEligibleAtMs = triggeredAtMs + this.minHoldMs;
        const intakeHoldMs = Math.max(1_000, Math.min(2_000, Math.floor(this.minHoldMs / 30)));
        this.state = {
          active: true,
          phase: "active_hold",
          code: "dispatcher.backpressure.latency_p95_high",
          reason: `dispatch_latency_p95=${p95}ms threshold=${this.triggerP95Ms}ms`,
          triggeredAtMs,
          lastObservedLatencyP95Ms: p95,
          releaseEligibleAtMs,
          intakeHoldMs,
        };
        return {
          changed: true,
          state: this.state,
          event: "activated",
          signal: {
            active: true,
            phase: this.state.phase,
            code: this.state.code ?? "dispatcher.backpressure.latency_p95_high",
            reason: this.state.reason ?? "dispatcher latency backpressure",
            triggeredAtMs,
            intakeHoldMs,
          },
        };
      }
      return { changed: false, state: this.state, event: null, signal: null };
    }

    const releaseEligibleAtMs =
      this.state.releaseEligibleAtMs ??
      (this.state.triggeredAtMs ? this.state.triggeredAtMs + this.minHoldMs : null);
    const holdExpired = releaseEligibleAtMs != null ? now >= releaseEligibleAtMs : true;
    const phase = holdExpired ? "recovery_pending" : "active_hold";
    if (this.state.phase !== phase) {
      this.state = {
        ...this.state,
        phase,
        releaseEligibleAtMs,
      };
    }
    const shouldRelease =
      holdExpired &&
      (p95 == null || p95 <= this.releaseP95Ms || sampleCount < this.minSamples);
    if (shouldRelease) {
      this.state = {
        ...DEFAULT_BACKPRESSURE_STATE,
        lastObservedLatencyP95Ms: p95,
      };
      this.lastClearSampleVersion = sampleVersion;
      return {
        changed: true,
        state: this.state,
        event: "cleared",
        signal: {
          active: false,
          phase: this.state.phase,
          code: "dispatcher.backpressure.cleared",
          reason: "dispatcher backpressure cleared",
          triggeredAtMs: now,
        },
      };
    }

    this.state = {
      ...this.state,
      lastObservedLatencyP95Ms: p95,
      releaseEligibleAtMs,
      phase,
    };

    return { changed: false, state: this.state, event: null, signal: null };
  }
}

export class DispatcherIntakeGate {
  private holdUntilMs = 0;

  requestHold(durationMs: number, now = Date.now()): number {
    const hold = Math.max(0, Math.floor(durationMs));
    if (hold <= 0) return this.holdUntilMs;
    const target = now + hold;
    this.holdUntilMs = Math.max(this.holdUntilMs, target);
    return this.holdUntilMs;
  }

  clear(): void {
    this.holdUntilMs = 0;
  }

  remainingHoldMs(now = Date.now()): number {
    if (this.holdUntilMs <= 0) return 0;
    return Math.max(0, this.holdUntilMs - now);
  }

  isHolding(now = Date.now()): boolean {
    return this.remainingHoldMs(now) > 0;
  }
}
