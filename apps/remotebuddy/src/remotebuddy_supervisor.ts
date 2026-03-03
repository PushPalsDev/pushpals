#!/usr/bin/env bun

import { loadPushPalsConfig } from "shared";

import {
  runRemoteBuddyPreflight,
  type RemoteBuddyPreflightFailure,
  type RemoteBuddyPreflightOptions,
  type RemoteBuddyPreflightRecord,
  type RemoteBuddyPreflightResult,
} from "./startup/preflight.js";

const bunExecPath = (process.execPath ?? "").trim() || "bun";
const command = [bunExecPath, "run", "src/remotebuddy_main.ts"];

let restartEnabled = false;
let maxRestarts = 0;
let restartBackoffMs = 0;

let activeChild: ReturnType<typeof Bun.spawn> | null = null;
let shuttingDown = false;

const UNKNOWN_PREFLIGHT_FAILURE_CODE =
  "remotebuddy.unknown_preflight_failure" as const;

type TelemetryMode = "observable" | "deterministic";

const resolveTelemetryMode = (override?: TelemetryMode): TelemetryMode => {
  if (override) return override;
  const envValue = process.env.REMOTEBUDDY_TELEMETRY_MODE?.toLowerCase();
  return envValue === "deterministic" ? "deterministic" : "observable";
};

type UnknownPreflightFailure = {
  code: typeof UNKNOWN_PREFLIGHT_FAILURE_CODE;
  detail: string;
  action: string;
  category: "unknown";
  step: number;
};

type SupervisorPreflightFailure =
  | RemoteBuddyPreflightFailure
  | UnknownPreflightFailure;

const nowIso = () => new Date().toISOString();
const FALLBACK_FAILURE_ACTION =
  "Inspect supervisor logs and rerun bun run preflight --json.";

export class RemoteBuddySupervisorPreflightError extends Error {
  failure: SupervisorPreflightFailure;
  elapsedMs: number;

  constructor(failure: SupervisorPreflightFailure, elapsedMs: number) {
    super(
      `RemoteBuddy preflight blocked: code=${failure.code} step=${failure.step} action=${failure.action} detail=${failure.detail}`,
    );
    this.name = "RemoteBuddySupervisorPreflightError";
    this.failure = failure;
    this.elapsedMs = elapsedMs;
  }
}

export interface SupervisorPreflightSuccess {
  elapsedMs: number;
  recordCount: number;
}

export interface SupervisorPreflightOptions {
  runPreflight?: (
    options: RemoteBuddyPreflightOptions,
  ) => Promise<RemoteBuddyPreflightResult>;
  reporter?: (record: RemoteBuddyPreflightRecord) => void;
  logger?: Pick<typeof console, "log" | "error">;
  now?: () => number;
  allowDirtyWorktree?: boolean;
  allowMissingAuthToken?: boolean;
  telemetryMode?: TelemetryMode;
}

const buildRecordReporter = (
  logger: Pick<typeof console, "log">,
): ((record: RemoteBuddyPreflightRecord) => void) => {
  return (record) => {
    const statusToken = record.status === "pass" ? "PASS" : "FAIL";
    const detail = JSON.stringify(record.detail ?? "");
    const action = record.action ? ` action=${JSON.stringify(record.action)}` : "";
    logger.log(
      `[RemoteBuddySupervisor] [preflight] ${statusToken} step=${record.step} code=${record.code} category=${record.category} detail=${detail}${action}`,
    );
  };
};

const deriveFailureFromRecords = (
  records: RemoteBuddyPreflightRecord[],
): RemoteBuddyPreflightFailure | null => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.status !== "fail") continue;
    return {
      code: record.code,
      detail: record.detail,
      action:
        record.action ??
        `Resolve ${record.code} then rerun bun run preflight --json.`,
      category: record.category,
      step: record.step,
    };
  }
  return null;
};

const logStructuredPreflightResult = (
  logger: Pick<typeof console, "log" | "error">,
  telemetryMode: TelemetryMode,
  status: "passed" | "failed",
  input: {
    elapsedMs: number;
    recordCount: number;
    failure?: SupervisorPreflightFailure;
  },
): void => {
  const payload: Record<string, unknown> = {
    component: "RemoteBuddySupervisor",
    event: "preflight_result",
    status,
    record_count: input.recordCount,
    elapsed_ms: input.elapsedMs,
  };
  if (telemetryMode !== "deterministic") {
    payload.timestamp = nowIso();
  }
  if (input.failure) {
    payload.failure = {
      code: input.failure.code,
      category: input.failure.category,
      step: input.failure.step,
      detail: input.failure.detail,
      action: input.failure.action,
    };
  }
  const serialized = JSON.stringify(payload);
  if (status === "failed") {
    logger.error(serialized);
  } else {
    logger.log(serialized);
  }
};

export const enforceSupervisorPreflight = async (
  options: SupervisorPreflightOptions = {},
): Promise<SupervisorPreflightSuccess> => {
  const runPreflight = options.runPreflight ?? runRemoteBuddyPreflight;
  const logger = options.logger ?? console;
  const now = options.now ?? (() => Date.now());
  const reporter = options.reporter ?? buildRecordReporter(logger);
  const telemetryMode = resolveTelemetryMode(options.telemetryMode);
  const started = now();
  let result: RemoteBuddyPreflightResult | null = null;
  let thrownError: unknown;
  try {
    result = await runPreflight({
      allowDirtyWorktree: options.allowDirtyWorktree,
      allowMissingAuthToken: options.allowMissingAuthToken,
      reporter,
    });
  } catch (error) {
    thrownError = error;
  }
  const elapsedMs = Math.max(0, now() - started);
  const recordCount = result?.records.length ?? 0;

  const escalateFailure = (failure: SupervisorPreflightFailure): never => {
    logger.error(
      `[RemoteBuddySupervisor] preflight_failed code=${failure.code} step=${failure.step} category=${failure.category} action=${JSON.stringify(failure.action)} detail=${JSON.stringify(failure.detail)} elapsed_ms=${elapsedMs}`,
    );
    logStructuredPreflightResult(logger, telemetryMode, "failed", {
      elapsedMs,
      recordCount,
      failure,
    });
    throw new RemoteBuddySupervisorPreflightError(failure, elapsedMs);
  };

  if (thrownError) {
    const detail =
      thrownError instanceof Error
        ? `${thrownError.name}: ${thrownError.message}`
        : String(thrownError ?? "Unknown error");
    const failure: UnknownPreflightFailure = {
      code: UNKNOWN_PREFLIGHT_FAILURE_CODE,
      detail: `Unexpected preflight exception: ${detail}`,
      action: FALLBACK_FAILURE_ACTION,
      category: "unknown",
      step: -1,
    };
    if (thrownError instanceof Error && thrownError.stack) {
      logger.error(
        `[RemoteBuddySupervisor] preflight_exception stack=${JSON.stringify(
          thrownError.stack,
        )}`,
      );
    }
    escalateFailure(failure);
  }

  if (!result) {
    const failure: UnknownPreflightFailure = {
      code: UNKNOWN_PREFLIGHT_FAILURE_CODE,
      detail: "Preflight returned no result.",
      action: FALLBACK_FAILURE_ACTION,
      category: "unknown",
      step: -1,
    };
    escalateFailure(failure);
  }

  if (!result.ok) {
    const failure: SupervisorPreflightFailure =
      result.failure ??
      deriveFailureFromRecords(result.records) ??
      {
        code: UNKNOWN_PREFLIGHT_FAILURE_CODE,
        detail: "Preflight failed without emitting failure metadata.",
        action: FALLBACK_FAILURE_ACTION,
        category: "unknown",
        step: -1,
      };
    escalateFailure(failure);
  }

  logger.log(
    `[RemoteBuddySupervisor] preflight_passed steps=${recordCount} elapsed_ms=${elapsedMs}`,
  );
  logStructuredPreflightResult(logger, telemetryMode, "passed", {
    elapsedMs,
    recordCount,
  });
  return { elapsedMs, recordCount };
};

function requestShutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (activeChild) {
    try {
      activeChild.kill();
    } catch {
      // best-effort shutdown
    }
  }
  setTimeout(() => {
    process.exit(exitCode);
  }, 50).unref();
}

process.on("SIGINT", () => requestShutdown(130));
process.on("SIGTERM", () => requestShutdown(143));

function shouldAttemptRestart(exitCode: number): boolean {
  if (shuttingDown) return false;
  if (!restartEnabled) return false;
  if (exitCode === 0) return false;
  if (exitCode === 130 || exitCode === 143) return false;
  return true;
}

async function run(): Promise<never> {
  try {
    await enforceSupervisorPreflight();
  } catch (error) {
    if (error instanceof RemoteBuddySupervisorPreflightError) {
      process.exit(2);
    }
    console.error(`[RemoteBuddySupervisor] Startup preflight crashed: ${String(error)}`);
    process.exit(1);
  }

  const config = loadPushPalsConfig();
  restartEnabled = config.remotebuddy.crashRestartEnabled;
  maxRestarts = Math.max(0, config.remotebuddy.crashRestartMaxRestarts);
  restartBackoffMs = Math.max(0, config.remotebuddy.crashRestartBackoffMs);

  if (restartEnabled) {
    console.log(
      `[RemoteBuddySupervisor] Crash restart enabled (max_restarts=${maxRestarts}, backoff_ms=${restartBackoffMs}).`,
    );
  } else {
    console.log("[RemoteBuddySupervisor] Crash restart disabled.");
  }

  let restartCount = 0;
  while (true) {
    activeChild = Bun.spawn(command, {
      cwd: process.cwd(),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    });

    const exitCode = await activeChild.exited;
    activeChild = null;

    if (!shouldAttemptRestart(exitCode)) {
      process.exit(exitCode);
    }

    if (restartCount >= maxRestarts) {
      console.error(
        `[RemoteBuddySupervisor] RemoteBuddy exited with code ${exitCode}; restart limit reached (${restartCount}/${maxRestarts}).`,
      );
      process.exit(exitCode);
    }

    restartCount += 1;
    console.warn(
      `[RemoteBuddySupervisor] RemoteBuddy exited with code ${exitCode}; restarting (${restartCount}/${maxRestarts}) in ${restartBackoffMs}ms.`,
    );
    if (restartBackoffMs > 0) {
      await Bun.sleep(restartBackoffMs);
    }
  }
}

if (import.meta.main) {
  run().catch((err) => {
    console.error(`[RemoteBuddySupervisor] Fatal: ${String(err)}`);
    process.exit(1);
  });
}
