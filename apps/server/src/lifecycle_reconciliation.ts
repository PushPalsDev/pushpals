export type ReconciliationHealth = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
};

export class LifecycleReconciliationTracker {
  private readonly health = new Map<string, ReconciliationHealth>();

  run<T>(label: string, fallback: T, reconcile: () => T, onError?: (detail: string) => void): T {
    const attemptedAt = new Date().toISOString();
    const previous = this.health.get(label);
    try {
      const result = reconcile();
      this.health.set(label, {
        lastAttemptAt: attemptedAt,
        lastSuccessAt: new Date().toISOString(),
        lastErrorAt: previous?.lastErrorAt ?? null,
        lastError: null,
        consecutiveFailures: 0,
      });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.health.set(label, {
        lastAttemptAt: attemptedAt,
        lastSuccessAt: previous?.lastSuccessAt ?? null,
        lastErrorAt: new Date().toISOString(),
        lastError: detail.slice(0, 1_000),
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      });
      onError?.(detail);
      return fallback;
    }
  }

  snapshot(nowMs = Date.now()): Record<
    string,
    ReconciliationHealth & {
      lastSuccessAgeMs: number | null;
      lastAttemptAgeMs: number | null;
    }
  > {
    return Object.fromEntries(
      [...this.health.entries()].map(([label, state]) => [
        label,
        {
          ...state,
          lastSuccessAgeMs: state.lastSuccessAt
            ? Math.max(0, nowMs - Date.parse(state.lastSuccessAt))
            : null,
          lastAttemptAgeMs: state.lastAttemptAt
            ? Math.max(0, nowMs - Date.parse(state.lastAttemptAt))
            : null,
        },
      ]),
    );
  }
}
