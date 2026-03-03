import {
  runRemotebuddyPreflight,
  type RemotebuddyPreflightConfig,
} from "./preflight_runner.js";

type PreflightRunner = typeof runRemotebuddyPreflight;
type StartupLogger = Pick<typeof console, "log" | "error">;

export interface StartupPreflightGateOptions {
  config: RemotebuddyPreflightConfig;
  env?: NodeJS.ProcessEnv;
  runPreflight?: PreflightRunner;
  exit?: (code: number) => void;
  logger?: StartupLogger;
}

export async function enforceStartupPreflightGate(
  options: StartupPreflightGateOptions,
): Promise<boolean> {
  const runner = options.runPreflight ?? runRemotebuddyPreflight;
  const logger = options.logger ?? console;
  const exitFn = options.exit ?? ((code: number) => process.exit(code));
  const env = options.env ?? process.env;
  const result = await runner({
    config: options.config,
    env,
  });
  if (!result.ok) {
    if (result.failure) {
      const failure = result.failure;
      logger.error(`[RemoteBuddy][Preflight] Startup blocked: ${failure.detail}`);
      logger.error(
        `[RemoteBuddy][Preflight] Failure identifiers: ${JSON.stringify({
          code: failure.code,
          check: failure.check,
        })}`,
      );
      logger.error(`[RemoteBuddy][Preflight] Action: ${failure.action}`);
    } else {
      const fallbackDetail =
        "Preflight runner reported failure without details; inspect the preceding preflight logs for the blocking check.";
      const fallbackAction =
        "Re-run RemoteBuddy with DEBUG=preflight (or bun test apps/remotebuddy) to capture telemetry, fix the failing check, then restart.";
      logger.error(`[RemoteBuddy][Preflight] Startup blocked: ${fallbackDetail}`);
      const lastEntry =
        result.history.length > 0 ? result.history[result.history.length - 1] : undefined;
      if (lastEntry) {
        logger.error(
          `[RemoteBuddy][Preflight] Last telemetry sample: ${JSON.stringify({
            check: lastEntry.check,
            status: lastEntry.status,
            detail: lastEntry.detail,
            metadata: lastEntry.metadata,
          })}`,
        );
      } else {
        logger.error(
          "[RemoteBuddy][Preflight] No telemetry history was returned by the runner; treating as malformed output.",
        );
      }
      logger.error(`[RemoteBuddy][Preflight] Action: ${fallbackAction}`);
    }
    exitFn(1);
    return false;
  }
  logger.log("[RemoteBuddy] Preflight checks passed; continuing startup.");
  return true;
}
