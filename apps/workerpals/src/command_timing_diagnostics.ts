import { coerceCodexCommandTimings } from "./common/generic_python_executor.js";

/** Flatten recovery nesting to fit the server's bounded metadata depth. */
export function durableCodexCommandTimings(value: unknown): Record<string, unknown> | undefined {
  const report = coerceCodexCommandTimings(value);
  if (!report) return undefined;
  const attempts = report.attempts as Array<Record<string, unknown>>;
  const commands = attempts.flatMap((attempt) =>
    (attempt.commands as Array<Record<string, unknown>>).map((command) => ({
      recoveryAttempt: attempt.attempt,
      ...command,
    })),
  );
  const total = (key: string) =>
    attempts.reduce((sum, attempt) => sum + Number(attempt[key] ?? 0), 0);
  return {
    schemaVersion: 1,
    observationOnly: true,
    commands: commands.slice(-50),
    observedAttemptCount: attempts.length,
    omittedAttempts: report.omittedAttempts,
    omittedCommands: total("omittedCommands") + Math.max(0, commands.length - 50),
    omittedEvents: total("omittedEvents"),
    malformedEvents: total("malformedEvents"),
    duplicateEvents: total("duplicateEvents"),
  };
}
