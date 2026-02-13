export const DEFAULT_OPENHANDS_TIMEOUT_MS = 1_800_000;
export const DEFAULT_DOCKER_TIMEOUT_MS = 1_860_000;

export function parseOpenHandsTimeoutMs(raw: string | undefined): number {
  const parsed = parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_OPENHANDS_TIMEOUT_MS;
  return Math.max(10_000, parsed);
}

export function parseDockerTimeoutMs(raw: string | undefined): number {
  const parsed = parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DOCKER_TIMEOUT_MS;
  return Math.max(10_000, parsed);
}

export function computeTimeoutWarningWindow(timeoutMs: number): { leadMs: number; delayMs: number } {
  const normalized = Math.max(10_000, Math.floor(timeoutMs));
  const leadMs = Math.min(60_000, Math.max(10_000, normalized - 5_000));
  const delayMs = Math.max(1_000, normalized - leadMs);
  return { leadMs, delayMs };
}
