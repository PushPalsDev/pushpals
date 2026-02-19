const BASE_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export function reconnectDelayMs(attemptIndex: number): number {
  const normalized = Number.isFinite(attemptIndex) ? Math.max(0, Math.floor(attemptIndex)) : 0;
  const delay = BASE_RECONNECT_DELAY_MS * 2 ** normalized;
  return Math.min(delay, MAX_RECONNECT_DELAY_MS);
}
