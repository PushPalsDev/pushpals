export type WorkerExecutionReadinessDetails = {
  executionReady: boolean;
  executionReadiness: {
    status: "checking" | "ready" | "blocked";
    checkedAt: string | null;
    retryAt: string | null;
    failureClass: string | null;
  };
};

export function shouldUseLegacyWorkerCooldown(
  cooldownMs: number | undefined,
  readiness?: WorkerExecutionReadinessDetails,
): boolean {
  return (
    typeof cooldownMs === "number" &&
    Number.isFinite(cooldownMs) &&
    cooldownMs > 0 &&
    readiness?.executionReadiness.status !== "blocked"
  );
}

/** A local capability circuit, separate from task failures and task retry budgets. */
export class WorkerExecutionReadinessGate {
  private state: WorkerExecutionReadinessDetails["executionReadiness"] = {
    status: "checking",
    checkedAt: null,
    retryAt: null,
    failureClass: null,
  };
  private readyUntil = 0;
  private retryAfter = 0;
  private failures = 0;
  private generation = 0;
  private flight: Promise<boolean> | null = null;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;

  constructor(
    private readonly options: {
      /** Must enforce its own complete, bounded process deadline. */
      probe: () => Promise<void>;
      classifyFailure: (error: unknown) => { failureClass: string; retryable: boolean };
      onFailure?: (error: unknown) => void;
      now?: () => number;
      monotonicNow?: () => number;
      cacheMs?: number;
      failureCooldownMs?: number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? options.now ?? (() => performance.now());
  }

  details(): WorkerExecutionReadinessDetails {
    return {
      executionReady: this.state.status === "ready",
      executionReadiness: { ...this.state },
    };
  }

  /** Any failed job invalidates positive evidence; product failures do not open the circuit. */
  invalidate(): void {
    this.generation += 1;
    this.readyUntil = 0;
    if (this.state.status === "blocked") return;
    this.state = { ...this.state, status: "checking", retryAt: null, failureClass: null };
  }

  block(error: unknown): void {
    this.generation += 1;
    this.readyUntil = 0;
    this.failures = Math.min(this.failures + 1, 8);
    const failure = this.options.classifyFailure(error);
    const configured = Number(this.options.failureCooldownMs ?? 20_000);
    const baseMs = Number.isFinite(configured) ? Math.max(1_000, configured) : 20_000;
    // Permanent configuration/permission failures get a slow bounded canary,
    // never an immediate retry loop. A later external repair can recover them.
    const delayMs = failure.retryable
      ? Math.min(300_000, baseMs * 2 ** (this.failures - 1))
      : 300_000;
    this.retryAfter = this.monotonicNow() + delayMs;
    this.state = {
      status: "blocked",
      checkedAt: new Date(this.now()).toISOString(),
      retryAt: new Date(this.now() + delayMs).toISOString(),
      failureClass: failure.failureClass,
    };
    try {
      this.options.onFailure?.(error);
    } catch {
      // Observation must not change capability admission.
    }
  }

  ensureReady(): Promise<boolean> {
    if (this.flight) return this.flight;
    const now = this.monotonicNow();
    if (this.state.status === "ready" && now < this.readyUntil) return Promise.resolve(true);
    if (this.state.status === "blocked" && now < this.retryAfter) return Promise.resolve(false);
    this.state = { ...this.state, status: "checking", retryAt: null };
    const generation = this.generation;
    const flight = Promise.resolve()
      .then(() => this.options.probe())
      .then(
        () => {
          if (generation !== this.generation) return false;
          this.failures = 0;
          const configured = Number(this.options.cacheMs ?? 30_000);
          const cacheMs = Number.isFinite(configured)
            ? Math.max(0, Math.min(30_000, configured))
            : 30_000;
          this.readyUntil = this.monotonicNow() + cacheMs;
          this.state = {
            status: "ready",
            checkedAt: new Date(this.now()).toISOString(),
            retryAt: null,
            failureClass: null,
          };
          return true;
        },
        (error) => {
          if (generation === this.generation) this.block(error);
          return false;
        },
      )
      .finally(() => {
        if (this.flight === flight) this.flight = null;
      });
    this.flight = flight;
    return flight;
  }
}

/** Keep controller liveness visible without advertising execution capacity during a probe. */
export async function checkWorkerExecutionReadiness(
  gate: WorkerExecutionReadinessGate,
  heartbeat: (force: boolean) => Promise<void>,
  heartbeatMs: number,
): Promise<boolean> {
  const pending = gate.ensureReady();
  if (gate.details().executionReadiness.status !== "checking") {
    const ready = await pending;
    await heartbeat(false);
    return ready;
  }
  const timer = setInterval(
    () => {
      void heartbeat(false).catch(() => {});
    },
    Math.max(1_000, heartbeatMs),
  );
  try {
    await heartbeat(true);
    const ready = await pending;
    await heartbeat(true);
    return ready;
  } finally {
    clearInterval(timer);
  }
}
