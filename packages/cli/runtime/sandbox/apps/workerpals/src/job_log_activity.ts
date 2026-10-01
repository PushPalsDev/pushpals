/** Status messages describe activity; they must not manufacture it. */
export function createJobLogActivity(startedAtMs: number) {
  let lastExecutionOutputAt = startedAtMs;
  return {
    note(source: "execution" | "status", atMs: number): void {
      if (source === "execution" && Number.isFinite(atMs))
        lastExecutionOutputAt = Math.max(lastExecutionOutputAt, atMs);
    },
    quietForMs(nowMs: number): number {
      return Math.max(0, nowMs - lastExecutionOutputAt);
    },
  };
}
