import {
  extractTrustedValidationFailureEvidence,
  normalizeTrustedValidationCommands,
  tokenizeTrustedValidationCommand,
  truncateTrustedValidationOutput,
  type TrustedValidationExecutionResult,
} from "../../../packages/shared/src/trusted_validation.js";
import { createHash } from "crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { basename, resolve } from "path";
import {
  buildWindowsProcessTreeTerminationArgv as buildSharedWindowsProcessTreeTerminationArgv,
  runBoundedProcess,
  terminateProcessTree as terminateSharedProcessTree,
  type BoundedSubprocess,
} from "../../../packages/shared/src/bounded_process.js";
import { copyEnvWithoutScmRepairAuthoritySecret } from "../../../packages/shared/src/scm_repair_authority.js";

export type TrustedValidationCommandResult = TrustedValidationExecutionResult;

export type TrustedValidationOutcome = {
  terminalResults: TrustedValidationCommandResult[];
  terminalFailure: TrustedValidationCommandResult | null;
};

export type TrustedValidationInvariantContext = {
  /** Exact integration head the candidate was prepared against. */
  baseSha: string;
  /** Exact candidate tree/content being prepared. */
  candidateSha: string;
  /** Repository-relative paths changed between the base and candidate trees. */
  affectedPaths: readonly string[];
};

export type TrustedValidationProgressEvent =
  | {
      boundary: "start";
      phase: TrustedValidationCommandResult["phase"];
      command: string;
      attempt: number;
    }
  | {
      boundary: "complete";
      phase: TrustedValidationCommandResult["phase"];
      command: string;
      attempt: number;
      ok: boolean;
      durationMs: number;
      cached: boolean;
    }
  | {
      boundary: "retry";
      phase: TrustedValidationCommandResult["phase"];
      command: string;
      attempt: number;
      retryReason: "transient_infrastructure";
    };

export type TrustedValidationProgressCallback = (
  event: Readonly<TrustedValidationProgressEvent>,
) => void;

type CommandRunner = (
  argv: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<{ ok: boolean; output: string; exitCode: number; timedOut?: boolean }>;

const DEFAULT_TRUSTED_VALIDATION_TIMEOUT_MS = 8 * 60_000;
const PROCESS_TREE_TERMINATION_GRACE_MS = 5_000;
const PROCESS_STREAM_DRAIN_GRACE_MS = 2_000;
const PROCESS_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const TRUSTED_INSTALL_MARKER = ".pushpals-trusted-install.json";
const trustedInstallFlights = new Map<
  string,
  { fingerprint: string | null; promise: Promise<TrustedValidationCommandResult> }
>();
const BUN_DEPENDENCY_COMMANDS = new Set([
  "bun",
  "bunx",
  "eslint",
  "jest",
  "node",
  "npm",
  "npx",
  "tsc",
  "vitest",
]);

function emitTrustedValidationProgress(
  callback: TrustedValidationProgressCallback | undefined,
  event: TrustedValidationProgressEvent,
): void {
  try {
    callback?.(event);
  } catch {
    // Health/telemetry observers must never change validation or publication.
  }
}

export function trustedValidationHealthPhase(event: TrustedValidationProgressEvent): string {
  return `trusted_validation_${event.phase}_${event.boundary}_attempt_${event.attempt}`;
}

/**
 * Validation retries are retained in reports for latency/failure telemetry,
 * while publication is decided by the terminal attempt for each phase and
 * command. A recovered first attempt must not veto a successful retry.
 */
export function resolveTrustedValidationOutcome(
  results: TrustedValidationCommandResult[],
): TrustedValidationOutcome {
  const terminalByCommand = new Map<string, TrustedValidationCommandResult>();
  for (const result of results) {
    terminalByCommand.set(`${result.phase}\0${result.command}`, result);
  }
  const terminalResults = [...terminalByCommand.values()];
  return {
    terminalResults,
    terminalFailure: terminalResults.find((result) => !result.ok) ?? null,
  };
}

function currentBunExecutable(explicit?: string): string {
  const configured = String(explicit ?? process.env.PUSHPALS_BUN_BIN ?? "").trim();
  if (configured) return configured;
  const execPath = String(process.execPath ?? "").trim();
  return /^(?:bun|bun\.exe)$/i.test(basename(execPath)) ? execPath : "";
}

export function resolveTrustedValidationArgv(argv: string[], bunExecutable?: string): string[] {
  if (argv.length === 0) return [];
  const bun = currentBunExecutable(bunExecutable);
  if (!bun) return [...argv];
  const executable = String(argv[0] ?? "")
    .trim()
    .toLowerCase();
  if (executable === "bun" || executable === "bun.exe") {
    return [bun, ...argv.slice(1)];
  }
  if (executable === "bunx" || executable === "bunx.exe") {
    return [bun, "x", ...argv.slice(1)];
  }
  return [...argv];
}

export function resolveTrustedValidationPreparationArgv(options: {
  repoPath: string;
  commandArgv: string[][];
  bunExecutable?: string;
}): string[] | null {
  const hasBunProject =
    existsSync(`${options.repoPath}/package.json`) &&
    (existsSync(`${options.repoPath}/bun.lock`) || existsSync(`${options.repoPath}/bun.lockb`));
  const needsDependencies = options.commandArgv.some((argv) =>
    BUN_DEPENDENCY_COMMANDS.has(
      String(argv[0] ?? "")
        .trim()
        .toLowerCase(),
    ),
  );
  if (!hasBunProject || !needsDependencies) return null;

  const bun = currentBunExecutable(options.bunExecutable);
  return [bun || "bun", "install", "--frozen-lockfile"];
}

export function normalizeTrustedValidationAffectedPaths(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths
        .map((value) =>
          String(value ?? "")
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\.\//, "")
            .replace(/\/{2,}/g, "/")
            .replace(/\/$/, ""),
        )
        .filter((value) => value.length > 0 && value !== "."),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function trustedValidationInstallFingerprint(options: {
  repoPath: string;
  bunExecutable?: string;
  invariantContext?: TrustedValidationInvariantContext;
}): string | null {
  const candidateSha = String(options.invariantContext?.candidateSha ?? "")
    .trim()
    .toLowerCase();
  const baseSha = String(options.invariantContext?.baseSha ?? "")
    .trim()
    .toLowerCase();
  // Install hooks and generated artifacts may depend on candidate contents
  // outside package/lock files. No exact tree identity means no cache reuse.
  if (!candidateSha || !baseSha) return null;
  const packagePath = resolve(options.repoPath, "package.json");
  const lockPath = [
    resolve(options.repoPath, "bun.lock"),
    resolve(options.repoPath, "bun.lockb"),
  ].find((path) => existsSync(path));
  if (!existsSync(packagePath) || !lockPath) return null;
  const hash = createHash("sha256");
  hash.update(`platform=${process.platform}-${process.arch}\n`);
  hash.update(`bun=${currentBunExecutable(options.bunExecutable) || "bun"}\n`);
  hash.update(`version=${typeof Bun !== "undefined" ? Bun.version : "unknown"}\n`);
  if (options.invariantContext) {
    hash.update(`candidate=${candidateSha}\n`);
    hash.update(`base=${baseSha}\n`);
    hash.update(
      `affected=${JSON.stringify(
        normalizeTrustedValidationAffectedPaths(options.invariantContext.affectedPaths),
      )}\n`,
    );
  }
  hash.update(readFileSync(packagePath));
  hash.update("\0");
  hash.update(readFileSync(lockPath));
  return hash.digest("hex");
}

function trustedInstallMarkerPath(repoPath: string): string {
  return resolve(repoPath, "node_modules", TRUSTED_INSTALL_MARKER);
}

function invalidateTrustedInstallMarker(repoPath: string): void {
  const markerPath = trustedInstallMarkerPath(repoPath);
  rmSync(markerPath, { force: true });
  if (existsSync(markerPath)) {
    throw new Error("Could not invalidate the prior trusted dependency install marker.");
  }
}

export function hasFreshTrustedValidationInstall(options: {
  repoPath: string;
  bunExecutable?: string;
  invariantContext?: TrustedValidationInvariantContext;
}): boolean {
  const fingerprint = trustedValidationInstallFingerprint(options);
  if (!fingerprint) return false;
  try {
    const marker = JSON.parse(readFileSync(trustedInstallMarkerPath(options.repoPath), "utf8")) as {
      fingerprint?: unknown;
    };
    return marker.fingerprint === fingerprint;
  } catch {
    return false;
  }
}

async function runTimed(
  runner: CommandRunner,
  argv: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: boolean; output: string; exitCode: number; durationMs: number }> {
  const startedAt = Date.now();
  const result = await runner(argv, options);
  return { ...result, durationMs: Math.max(0, Date.now() - startedAt) };
}

function trustedInstallWaitFailure(reason: "timeout" | "cancelled", durationMs: number) {
  const message =
    reason === "cancelled"
      ? "Trusted dependency install wait was cancelled."
      : "Timed out waiting for the repository's trusted dependency install lock.";
  return {
    command: "bun install --frozen-lockfile",
    ok: false,
    output: message,
    exitCode: 124,
    durationMs: Math.max(0, durationMs),
    phase: "dependency_install" as const,
    failureClass: "timeout" as const,
    failedTests: [],
    targetPathHints: [],
    failureLines: [message],
  };
}

async function waitForTrustedInstallFlight(
  promise: Promise<TrustedValidationCommandResult>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<
  | { state: "completed"; result: TrustedValidationCommandResult }
  | { state: "failed"; error: unknown }
  | { state: "timeout" | "cancelled" }
> {
  if (signal?.aborted) return { state: "cancelled" };
  return await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (
      result:
        | { state: "completed"; result: TrustedValidationCommandResult }
        | { state: "failed"; error: unknown }
        | { state: "timeout" | "cancelled" },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const onAbort = () => finish({ state: "cancelled" });
    const timer = setTimeout(() => finish({ state: "timeout" }), Math.max(1, timeoutMs));
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => finish({ state: "completed", result }),
      (error) => finish({ state: "failed", error }),
    );
  });
}

async function ensureTrustedValidationInstall(options: {
  repoPath: string;
  preparationArgv: string[];
  timeoutMs: number;
  bunExecutable?: string;
  invariantContext?: TrustedValidationInvariantContext;
  runner: CommandRunner;
  signal?: AbortSignal;
  singleFlightWaitMs?: number;
}): Promise<TrustedValidationCommandResult> {
  const waitStartedAt = Date.now();
  const waitDeadline =
    waitStartedAt + Math.max(1, options.singleFlightWaitMs ?? options.timeoutMs + 1_000);
  const flightKey = resolve(options.repoPath);
  const requestedFingerprint = trustedValidationInstallFingerprint(options);
  let waitedForFlight = false;
  while (true) {
    if (options.signal?.aborted) {
      return trustedInstallWaitFailure("cancelled", Date.now() - waitStartedAt);
    }
    const activeFlight = trustedInstallFlights.get(flightKey);
    if (activeFlight) {
      waitedForFlight = true;
      const remainingMs = waitDeadline - Date.now();
      if (remainingMs <= 0) {
        return trustedInstallWaitFailure("timeout", Date.now() - waitStartedAt);
      }
      const waited = await waitForTrustedInstallFlight(
        activeFlight.promise,
        remainingMs,
        options.signal,
      );
      if (waited.state === "failed") throw waited.error;
      if (waited.state !== "completed") {
        return trustedInstallWaitFailure(waited.state, Date.now() - waitStartedAt);
      }
      if (trustedInstallFlights.get(flightKey) === activeFlight) {
        trustedInstallFlights.delete(flightKey);
      }
      if (activeFlight.fingerprint === requestedFingerprint && !waited.result.ok) {
        return waited.result;
      }
      continue;
    }
    // A marker is only meaningful while no install is mutating this repo's
    // dependency tree. Always drain the active per-repo flight first, even if
    // the marker currently matches this caller's candidate.
    if (hasFreshTrustedValidationInstall(options)) {
      return {
        command: "bun install --frozen-lockfile",
        ok: true,
        output: waitedForFlight
          ? "Trusted dependency install cache hit after waiting for another validation."
          : "Trusted dependency install cache hit for unchanged candidate inputs.",
        exitCode: 0,
        durationMs: 0,
        cached: true,
        phase: "dependency_install",
      };
    }

    const flight = (async (): Promise<TrustedValidationCommandResult> => {
      // A non-cached install can mutate the shared dependency tree before it
      // succeeds. Invalidate any marker from a different candidate first so a
      // waiter cannot treat that pre-mutation state as trusted after this
      // flight fails or is cancelled. Removal is synchronous and fail-closed:
      // the install runner is never entered while an old marker remains.
      invalidateTrustedInstallMarker(options.repoPath);
      let preparation: Awaited<ReturnType<typeof runTimed>>;
      try {
        preparation = await runTimed(options.runner, options.preparationArgv, {
          cwd: options.repoPath,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          return trustedInstallWaitFailure("cancelled", Date.now() - waitStartedAt);
        }
        throw error;
      }
      const evidence = preparation.ok
        ? null
        : extractTrustedValidationFailureEvidence({
            command: "bun install --frozen-lockfile",
            phase: "dependency_install",
            output: preparation.output,
            exitCode: preparation.exitCode,
          });
      const result: TrustedValidationCommandResult = {
        command: "bun install --frozen-lockfile",
        ...preparation,
        output: truncateTrustedValidationOutput(preparation.output),
        phase: "dependency_install",
        ...(evidence ?? {}),
      };
      if (preparation.ok) {
        const fingerprint = trustedValidationInstallFingerprint(options);
        if (fingerprint) {
          try {
            writeFileSync(
              trustedInstallMarkerPath(options.repoPath),
              JSON.stringify({
                schemaVersion: 3,
                fingerprint,
                updatedAt: new Date().toISOString(),
              }),
              "utf8",
            );
          } catch {
            // A successful install remains valid for this run; a later run will
            // simply reinstall if its marker could not be persisted.
          }
        }
      }
      return result;
    })();
    const flightRecord = { fingerprint: requestedFingerprint, promise: flight };
    trustedInstallFlights.set(flightKey, flightRecord);
    try {
      return await flight;
    } finally {
      if (trustedInstallFlights.get(flightKey) === flightRecord) {
        trustedInstallFlights.delete(flightKey);
      }
    }
  }
}

export function buildWindowsProcessTreeTerminationArgv(pid: number): string[] {
  return buildSharedWindowsProcessTreeTerminationArgv(pid);
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(null), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function captureBoundedProcessStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  maxBytes = PROCESS_OUTPUT_LIMIT_BYTES,
): { done: Promise<string>; cancel: () => void } {
  if (!stream || typeof stream === "number" || typeof stream.getReader !== "function") {
    return { done: Promise.resolve(""), cancel: () => {} };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  let truncated = false;
  let cancelled = false;
  const done = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (bytes < maxBytes) {
          const remaining = Math.max(0, maxBytes - bytes);
          const value =
            chunk.value.byteLength > remaining ? chunk.value.slice(0, remaining) : chunk.value;
          output += decoder.decode(value, { stream: true });
          bytes += value.byteLength;
          if (value.byteLength < chunk.value.byteLength) truncated = true;
        } else {
          truncated = true;
        }
      }
      output += decoder.decode();
    } catch {
      // Stream cancellation is expected after the bounded drain deadline.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // best-effort stream cleanup
      }
    }
    return `${output}${truncated ? "\n[pushpals: process output truncated]" : ""}`;
  })();
  return {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      try {
        void reader.cancel().catch(() => {});
      } catch {
        // best-effort stream cleanup
      }
    },
  };
}

export async function terminateProcessTree(
  proc: ReturnType<typeof Bun.spawn>,
  platform = process.platform,
): Promise<void> {
  await terminateSharedProcessTree(proc as unknown as BoundedSubprocess, { platform });
}

export async function runProcessWithTreeTimeout(
  argv: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: boolean; output: string; exitCode: number; timedOut?: boolean }> {
  const result = await runBoundedProcess(argv, {
    cwd: options.cwd,
    env: copyEnvWithoutScmRepairAuthoritySecret(process.env),
    timeoutMs: Math.max(1, options.timeoutMs),
    outputLimitBytes: PROCESS_OUTPUT_LIMIT_BYTES,
    streamDrainTimeoutMs: PROCESS_STREAM_DRAIN_GRACE_MS,
    signal: options.signal,
  });
  return {
    ok: !result.timedOut && result.exitCode === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    exitCode: result.exitCode,
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

export async function runTrustedValidationCommands(options: {
  repoPath: string;
  commandsJson: string;
  timeoutMs?: number;
  bunExecutable?: string;
  runner?: CommandRunner;
  retryTransientFailures?: boolean;
  onProgress?: TrustedValidationProgressCallback;
  signal?: AbortSignal;
  singleFlightWaitMs?: number;
  /**
   * Scopes only candidate-invariant preparation caching. Validation commands
   * always execute against the exact candidate and are never reused.
   */
  invariantContext?: TrustedValidationInvariantContext;
}): Promise<TrustedValidationCommandResult[]> {
  const normalized = normalizeTrustedValidationCommands(options.commandsJson);
  if (!normalized.ok) {
    throw new Error(`Invalid trusted-validation handoff: ${normalized.message}`);
  }

  const runner = options.runner ?? runProcessWithTreeTimeout;
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TRUSTED_VALIDATION_TIMEOUT_MS);
  const results: TrustedValidationCommandResult[] = [];
  const commandsWithArgv = normalized.commands.map((command) => {
    const argv = tokenizeTrustedValidationCommand(command);
    if (!argv)
      throw new Error(`Invalid trusted-validation command after normalization: ${command}`);
    return { command, argv };
  });
  const preparationArgv = resolveTrustedValidationPreparationArgv({
    repoPath: options.repoPath,
    commandArgv: commandsWithArgv.map(({ argv }) => argv),
    bunExecutable: options.bunExecutable,
  });
  if (preparationArgv) {
    const preparationCommand = "bun install --frozen-lockfile";
    emitTrustedValidationProgress(options.onProgress, {
      boundary: "start",
      phase: "dependency_install",
      command: preparationCommand,
      attempt: 1,
    });
    let preparation = await ensureTrustedValidationInstall({
      repoPath: options.repoPath,
      preparationArgv,
      timeoutMs,
      bunExecutable: options.bunExecutable,
      invariantContext: options.invariantContext,
      runner,
      signal: options.signal,
      singleFlightWaitMs: options.singleFlightWaitMs,
    });
    emitTrustedValidationProgress(options.onProgress, {
      boundary: "complete",
      phase: "dependency_install",
      command: preparationCommand,
      attempt: 1,
      ok: preparation.ok,
      durationMs: preparation.durationMs,
      cached: Boolean(preparation.cached),
    });
    if (
      !preparation.ok &&
      options.retryTransientFailures !== false &&
      isTransientTrustedValidationFailure(preparation)
    ) {
      results.push({
        ...preparation,
        attempt: 1,
        retryReason: "transient_infrastructure",
      });
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "retry",
        phase: "dependency_install",
        command: preparationCommand,
        attempt: 2,
        retryReason: "transient_infrastructure",
      });
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "start",
        phase: "dependency_install",
        command: preparationCommand,
        attempt: 2,
      });
      preparation = {
        ...(await ensureTrustedValidationInstall({
          repoPath: options.repoPath,
          preparationArgv,
          timeoutMs,
          bunExecutable: options.bunExecutable,
          invariantContext: options.invariantContext,
          runner,
          signal: options.signal,
          singleFlightWaitMs: options.singleFlightWaitMs,
        })),
        attempt: 2,
        retryReason: "transient_infrastructure",
      };
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "complete",
        phase: "dependency_install",
        command: preparationCommand,
        attempt: 2,
        ok: preparation.ok,
        durationMs: preparation.durationMs,
        cached: Boolean(preparation.cached),
      });
    }
    results.push(preparation);
    if (!preparation.ok) return results;
  }

  for (const { command, argv } of commandsWithArgv) {
    const resolvedArgv = resolveTrustedValidationArgv(argv, options.bunExecutable);
    const execute = async (attempt: number): Promise<TrustedValidationCommandResult> => {
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "start",
        phase: "validation",
        command,
        attempt,
      });
      const result = await runTimed(runner, resolvedArgv, {
        cwd: options.repoPath,
        timeoutMs,
        signal: options.signal,
      });
      const evidence = result.ok
        ? null
        : extractTrustedValidationFailureEvidence({
            command,
            phase: "validation",
            output: result.output,
            exitCode: result.exitCode,
          });
      const validationResult: TrustedValidationCommandResult = {
        command,
        ...result,
        output: truncateTrustedValidationOutput(result.output),
        phase: "validation",
        attempt,
        ...(evidence ?? {}),
      };
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "complete",
        phase: "validation",
        command,
        attempt,
        ok: validationResult.ok,
        durationMs: validationResult.durationMs,
        cached: Boolean(validationResult.cached),
      });
      return validationResult;
    };
    let validationResult = await execute(1);
    if (
      !validationResult.ok &&
      options.retryTransientFailures !== false &&
      isTransientTrustedValidationFailure(validationResult)
    ) {
      results.push({
        ...validationResult,
        retryReason: "transient_infrastructure",
      });
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "retry",
        phase: "validation",
        command,
        attempt: 2,
        retryReason: "transient_infrastructure",
      });
      validationResult = {
        ...(await execute(2)),
        retryReason: "transient_infrastructure",
      };
    }
    results.push(validationResult);
    if (!validationResult.ok) break;
  }
  return results;
}

export function isTransientTrustedValidationFailure(
  result: Pick<TrustedValidationCommandResult, "failureClass" | "output" | "exitCode">,
): boolean {
  if (result.failureClass === "timeout" || result.exitCode === 124) return true;
  return /\b(?:connection (?:reset|closed|refused)|econnreset|etimedout|temporary failure|temporarily unavailable|docker daemon is not responding|the docker daemon|tls handshake timeout|network is unreachable|could not resolve host|resource busy)\b/i.test(
    String(result.output ?? ""),
  );
}
