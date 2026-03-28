import type { SourceControlManagerConfig } from "./config";

export function cloneSourceControlManagerConfigSnapshot(
  config: SourceControlManagerConfig,
): SourceControlManagerConfig {
  return {
    ...config,
    checks: config.checks.map((check) => ({ ...check })),
    reviewAgent: {
      ...config.reviewAgent,
    },
  };
}

export function createSingleFlightExecutor<T>(worker: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  return () => {
    if (inFlight) return inFlight;
    inFlight = (async () => worker())().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
