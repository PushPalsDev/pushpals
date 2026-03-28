import type { SourceControlManagerConfig } from "./config";

export type SourceControlManagerStartupStatusPhase = "startup" | "online" | "shutdown";

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

export function createStartupStatusTracker(
  initialPhase: SourceControlManagerStartupStatusPhase = "startup",
): {
  getPhase: () => SourceControlManagerStartupStatusPhase;
  canEmitInitializing: (running: boolean) => boolean;
  beginOnlineTransition: () => boolean;
  revertOnlineTransition: () => void;
  markShutdown: () => void;
} {
  let phase = initialPhase;

  return {
    getPhase: () => phase,
    canEmitInitializing: (running: boolean) => running && phase === "startup",
    beginOnlineTransition: () => {
      if (phase !== "startup") return false;
      phase = "online";
      return true;
    },
    revertOnlineTransition: () => {
      if (phase === "online") {
        phase = "startup";
      }
    },
    markShutdown: () => {
      phase = "shutdown";
    },
  };
}
