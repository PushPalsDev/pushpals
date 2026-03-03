export type QueueRunnerState = "idle" | "fetching" | "processing" | "cooldown" | "stopped";

export type QueueJobPhase = "start" | "success" | "failed";

export interface QueueRunnerStateEvent {
  type: "runner_state";
  runner: string;
  state: QueueRunnerState;
  timestamp: number;
  context?: Record<string, unknown>;
}

export interface QueueJobEvent {
  type: "job";
  runner: string;
  jobId: string;
  phase: QueueJobPhase;
  timestamp: number;
  durationMs?: number;
  errorMessage?: string;
  context?: Record<string, unknown>;
}

export interface QueueFastFailEvent {
  type: "fast_fail";
  runner: string;
  reason: string;
  timestamp: number;
  cooldownMs: number;
  cooldownExpiresAt: number;
}

export type QueueTelemetryEvent = QueueRunnerStateEvent | QueueJobEvent | QueueFastFailEvent;

export type QueueTelemetrySink = (event: QueueTelemetryEvent) => Promise<void> | void;

export interface QueueRunnerOptions<TJob> {
  name: string;
  fetchJob: () => Promise<TJob | null>;
  handleJob: (job: TJob) => Promise<void>;
  telemetrySinks?: QueueTelemetrySink[];
  describeJob?: (job: TJob) => Record<string, unknown>;
  getJobId?: (job: TJob) => string;
  idleBackoffMs?: number;
  fastFailBackoffMs?: number;
  fastFailReason?: string;
  fastFailMonitor?: RollingLatencyMonitor;
  now?: () => number;
  logger?: Pick<Console, "warn" | "error">;
}

export interface QueueRunnerRunOptions {
  signal?: AbortSignal;
  stopOnIdle?: boolean;
}

type QueueRunnerLogger = Pick<Console, "warn" | "error">;

export class QueueRunner<TJob extends object = Record<string, unknown>> {
  private readonly name: string;
  private readonly fetchJob: () => Promise<TJob | null>;
  private readonly handleJob: (job: TJob) => Promise<void>;
  private readonly telemetrySinks: QueueTelemetrySink[];
  private readonly describeJob?: (job: TJob) => Record<string, unknown>;
  private readonly getJobId: (job: TJob) => string;
  private readonly idleBackoffMs: number;
  private readonly fastFailBackoffMs: number;
  private readonly fastFailReason: string;
  private readonly fastFailMonitor?: RollingLatencyMonitor;
  private readonly now: () => number;
  private readonly logger: QueueRunnerLogger;
  private telemetryDispatch: Promise<void> = Promise.resolve();

  constructor(options: QueueRunnerOptions<TJob>) {
    this.name = options.name;
    this.fetchJob = options.fetchJob;
    this.handleJob = options.handleJob;
    this.telemetrySinks = options.telemetrySinks ?? [];
    this.describeJob = options.describeJob;
    this.getJobId =
      options.getJobId ??
      ((job: TJob) => {
        const candidate = (job as { id?: string }).id;
        return typeof candidate === "string" && candidate.length > 0
          ? candidate
          : `job-${Math.random().toString(36).slice(2, 8)}`;
      });
    this.idleBackoffMs = options.idleBackoffMs ?? 250;
    this.fastFailBackoffMs = options.fastFailBackoffMs ?? 1_000;
    this.fastFailReason = options.fastFailReason ?? "rolling_latency_sla_breached";
    this.fastFailMonitor = options.fastFailMonitor;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? console;
  }

  async run(options: QueueRunnerRunOptions = {}): Promise<void> {
    const { signal, stopOnIdle = false } = options;

    try {
      while (!signal?.aborted) {
        if (this.fastFailMonitor && this.fastFailMonitor.shouldFastFail(this.now())) {
          const now = this.now();
          await this.emitRunnerState("cooldown");
          await this.emitFastFail(now);
          this.fastFailMonitor.markAlertSent(now);
          await delay(this.fastFailBackoffMs, signal);
          continue;
        }

        const processed = await this.runOnceInternal(signal);
        if (!processed) {
          if (stopOnIdle) break;
          await delay(this.idleBackoffMs, signal);
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }
    } finally {
      await this.emitRunnerState("stopped");
    }
  }

  async runOnce(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    try {
      return await this.runOnceInternal(options.signal);
    } catch (error) {
      if (isAbortError(error)) return false;
      throw error;
    }
  }

  private async runOnceInternal(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) throw new QueueRunnerAbortError();

    await this.emitRunnerState("fetching");
    const job = await this.fetchJob();
    if (!job) {
      await this.emitRunnerState("idle");
      return false;
    }

    const jobId = this.getJobId(job);
    const jobContext = this.describeJob?.(job);

    await this.emitRunnerState("processing", jobContext);
    await this.emitJobEvent("start", jobId, jobContext);

    const startedAt = this.now();
    try {
      await this.handleJob(job);
      const durationMs = Math.max(0, this.now() - startedAt);
      await this.emitJobEvent("success", jobId, jobContext, durationMs);
    } catch (error) {
      const durationMs = Math.max(0, this.now() - startedAt);
      await this.emitJobEvent("failed", jobId, jobContext, durationMs, error);
      this.logger.error(`[QueueRunner:${this.name}] job ${jobId} failed: ${errorMessage(error)}`);
    }

    return true;
  }

  private async emitRunnerState(
    state: QueueRunnerState,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const event: QueueRunnerStateEvent = {
      type: "runner_state",
      runner: this.name,
      state,
      timestamp: this.now(),
    };
    if (context) {
      event.context = context;
    }
    await this.emitTelemetry(event);
  }

  private async emitJobEvent(
    phase: QueueJobPhase,
    jobId: string,
    context?: Record<string, unknown>,
    durationMs?: number,
    error?: unknown,
  ): Promise<void> {
    const event: QueueJobEvent = {
      type: "job",
      runner: this.name,
      jobId,
      phase,
      timestamp: this.now(),
    };
    if (context) event.context = context;
    if (typeof durationMs === "number") event.durationMs = durationMs;
    if (error) event.errorMessage = errorMessage(error);
    await this.emitTelemetry(event);
  }

  private async emitFastFail(now: number): Promise<void> {
    if (!this.fastFailMonitor) return;
    const cooldownMs = this.fastFailMonitor.cooldownMs;
    const event: QueueFastFailEvent = {
      type: "fast_fail",
      runner: this.name,
      reason: this.fastFailReason,
      timestamp: now,
      cooldownMs,
      cooldownExpiresAt: now + cooldownMs,
    };
    await this.emitTelemetry(event);
  }

  private async emitTelemetry(event: QueueTelemetryEvent): Promise<void> {
    const queued = this.telemetryDispatch.then(() => this.dispatchTelemetry(event));
    this.telemetryDispatch = queued.catch((error) => {
      this.logger.error(
        `[QueueRunner:${this.name}] telemetry dispatch failed: ${errorMessage(error)}`,
      );
    });

    await this.telemetryDispatch;
  }

  private async dispatchTelemetry(event: QueueTelemetryEvent): Promise<void> {
    for (const [index, sink] of this.telemetrySinks.entries()) {
      try {
        await sink(event);
      } catch (error) {
        const sinkName = sink.name || `sink#${index}`;
        this.logger.warn(
          `[QueueRunner:${this.name}] telemetry sink ${sinkName} rejected: ${errorMessage(error)}`,
        );
      }
    }
  }
}

export interface RollingLatencyMonitorOptions {
  windowMs: number;
  slaMs: number;
  cooldownMs: number;
  now?: () => number;
}

export interface RollingLatencySample {
  p95Ms: number;
  timestamp?: number;
}

export class RollingLatencyMonitor {
  public readonly cooldownMs: number;

  private readonly windowMs: number;
  private readonly slaMs: number;
  private readonly now: () => number;
  private samples: Array<{ timestamp: number; p95Ms: number }> = [];
  private lastBreachAt?: number;
  private lastAlertAt?: number;

  constructor(options: RollingLatencyMonitorOptions) {
    this.cooldownMs = options.cooldownMs;
    this.windowMs = options.windowMs;
    this.slaMs = options.slaMs;
    this.now = options.now ?? (() => Date.now());
  }

  record(sample: RollingLatencySample): void {
    const timestamp = sample.timestamp ?? this.now();
    this.samples.push({ timestamp, p95Ms: sample.p95Ms });
    if (sample.p95Ms >= this.slaMs) {
      this.lastBreachAt = timestamp;
    }
    this.prune(timestamp);
  }

  shouldFastFail(now = this.now()): boolean {
    this.prune(now);
    if (this.lastBreachAt === undefined) {
      return false;
    }

    const breachWindowStart = now - this.windowMs;
    const breachStillActive = this.lastBreachAt >= breachWindowStart;
    if (!breachStillActive) {
      return false;
    }

    if (this.lastAlertAt === undefined) {
      // Without a prior alert we should notify immediately; cooldown starts after first alert.
      return true;
    }

    const cooldownElapsed = now - this.lastAlertAt;
    return cooldownElapsed >= this.cooldownMs;
  }

  markAlertSent(now = this.now()): void {
    this.lastAlertAt = now;
  }

  getLastAlertAt(): number | undefined {
    return this.lastAlertAt;
  }

  private prune(reference: number): void {
    const cutoff = reference - this.windowMs;
    if (!Number.isFinite(cutoff)) {
      return;
    }

    this.samples = this.samples.filter((sample) => sample.timestamp >= cutoff);

    const latestBreach = this.samples
      .filter((sample) => sample.p95Ms >= this.slaMs)
      .reduce<number | undefined>((latest, sample) => {
        if (latest === undefined || sample.timestamp > latest) {
          return sample.timestamp;
        }
        return latest;
      }, undefined);

    this.lastBreachAt = latestBreach;
    if (this.lastBreachAt !== undefined && this.lastBreachAt < cutoff) {
      this.lastBreachAt = undefined;
    }
  }
}

class QueueRunnerAbortError extends Error {
  constructor() {
    super("QueueRunner run aborted");
    this.name = "QueueRunnerAbortError";
  }
}

function isAbortError(error: unknown): error is QueueRunnerAbortError {
  return error instanceof QueueRunnerAbortError;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) throw new QueueRunnerAbortError();
    return;
  }
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) throw new QueueRunnerAbortError();

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new QueueRunnerAbortError());
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort);
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown_error";
  }
}
