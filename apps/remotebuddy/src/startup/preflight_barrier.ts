import type { RemotebuddyPreflightConfig } from "./preflight_runner.js";
import { enforceStartupPreflightGate } from "./startup_preflight_gate.js";

export class RemoteBuddyPreflightError extends Error {
  constructor(
    message =
      "RemoteBuddy startup blocked by infrastructure preflight failure. Review the preflight logs above for remediation steps.",
  ) {
    super(message);
    this.name = "RemoteBuddyPreflightError";
  }
}

export type PreflightGateExecutor = typeof enforceStartupPreflightGate;

export interface PreflightBarrierOptions {
  runPreflightGate?: PreflightGateExecutor;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<typeof console, "log" | "error">;
}

export async function ensurePreflightPasses(
  config: RemotebuddyPreflightConfig,
  options: PreflightBarrierOptions = {},
): Promise<void> {
  const gate = options.runPreflightGate ?? enforceStartupPreflightGate;
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const ok = await gate({
    config,
    env,
    logger,
  });
  if (!ok) {
    throw new RemoteBuddyPreflightError();
  }
}
