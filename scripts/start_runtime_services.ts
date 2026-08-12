export {
  computeLocalBuddyRestartBackoffMs,
  resolveLocalBuddyRuntimeAction,
  resolveLocalBuddyStartGate,
  type LocalBuddyRuntimeAction,
  type LocalBuddyStartGateReason,
} from "../packages/shared/src/localbuddy_runtime.js";

export type EmbeddedRuntimeHealth = {
  state: "degraded";
  detail: string;
  action?: string;
};

export type ManagedServiceSpec = {
  name: string;
  color: string;
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  logPath?: string;
  launchTimeoutMs?: number;
  launchReadyLine?: string;
  onLaunchTimeout?: (timeoutMs: number) => void;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  healthCheck?: {
    url: string;
    intervalMs?: number;
    timeoutMs?: number;
    unhealthyThreshold?: number;
  };
};

export type ManagedServiceProcess = {
  name: string;
  proc: ReturnType<typeof Bun.spawn>;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  exited: boolean;
  exitCode: number | null;
  launchedAtMs: number;
  launchReady?: Promise<boolean>;
  launchTimedOut?: boolean;
  logPath?: string;
  stopOutputPipes?: () => void;
};

type ServiceManagerState = {
  attempts: number;
  nextRestartAtMs: number;
  lastRestartReason: string;
  pendingRestartTimer: ReturnType<typeof setTimeout> | null;
  lastReportedExitedProcess: ManagedServiceProcess | null;
  lastExitFingerprint: string;
  matchingExitFingerprintCount: number;
  lastExitFingerprintAtMs: number;
  nextHealthProbeAtMs: number;
  healthProbeInFlight: boolean;
  consecutiveUnhealthyProbes: number;
  healthTerminationRequested: boolean;
  healthFailureDetail: string;
};

export type ManagedServiceExitFingerprintContext = {
  service: string;
  exitCode: number | null;
  uptimeMs: number;
  logPath?: string;
  command: string[];
};

export type ServiceManagerOptions = {
  pollMs?: number;
  maxRestartAttempts?: number;
  stableWindowMs?: number;
  repeatedExitFingerprintLimit?: number;
  repeatedExitFingerprintWindowMs?: number;
  resolveExitFingerprint?: (context: ManagedServiceExitFingerprintContext) => string | null;
  computeRestartBackoffMs?: (attempt: number) => number;
  degradedAction?: string;
  spawnService?: (spec: ManagedServiceSpec) => ManagedServiceProcess;
  onHealthChange?: (health: EmbeddedRuntimeHealth | null) => void;
  onServiceDegraded?: (name: string, reason: string, health: EmbeddedRuntimeHealth) => void;
  onEvent?: (level: "log" | "warn" | "error", line: string) => void;
  onLifecycleEvent?: (event: ManagedServiceLifecycleEvent) => void;
  probeServiceHealth?: (spec: NonNullable<ManagedServiceSpec["healthCheck"]>) => Promise<{
    ok: boolean;
    detail: string;
  }>;
  terminateService?: (service: ManagedServiceProcess) => Promise<void>;
};

export type ManagedServiceLifecycleEvent =
  | {
      type: "exit";
      service: string;
      exitCode: number | null;
      uptimeMs: number;
      rssBytes: number | null;
      restartAttempt: number;
      maxRestartAttempts: number;
      recoveryPlanned: boolean;
      observedAt: string;
    }
  | {
      type: "restarted";
      service: string;
      restartAttempt: number;
      maxRestartAttempts: number;
      observedAt: string;
    }
  | {
      type: "recovery_exhausted";
      service: string;
      restartAttempt: number;
      maxRestartAttempts: number;
      observedAt: string;
    };

export type ManagedServiceLaunchRetryOptions = {
  maxAttempts?: number;
  computeBackoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, maxAttempts: number, backoffMs: number) => void;
};

const DEFAULT_SERVICE_MANAGER_POLL_MS = 1_000;
const DEFAULT_SERVICE_MANAGER_MAX_RESTART_ATTEMPTS = 4;
const DEFAULT_SERVICE_MANAGER_STABLE_WINDOW_MS = 60_000;
const DEFAULT_REPEATED_EXIT_FINGERPRINT_LIMIT = 2;
const DEFAULT_REPEATED_EXIT_FINGERPRINT_WINDOW_MS = 15 * 60_000;
const DEFAULT_SERVICE_MANAGER_BASE_BACKOFF_MS = 2_000;
const DEFAULT_SERVICE_MANAGER_MAX_BACKOFF_MS = 30_000;
const DEFAULT_SERVICE_HEALTH_INTERVAL_MS = 5_000;
const DEFAULT_SERVICE_HEALTH_TIMEOUT_MS = 2_500;
const DEFAULT_SERVICE_UNHEALTHY_THRESHOLD = 3;

async function settleManagedProcessWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
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

export function buildWindowsManagedServiceTreeTerminationArgv(pid: number): string[] {
  return ["taskkill", "/PID", String(Math.max(0, Math.floor(pid))), "/T", "/F"];
}

async function defaultProbeServiceHealth(
  spec: NonNullable<ManagedServiceSpec["healthCheck"]>,
): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timeoutMs = Math.max(250, spec.timeoutMs ?? DEFAULT_SERVICE_HEALTH_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(spec.url, { signal: controller.signal });
    const detail = await response.text().catch(() => "");
    return {
      ok: response.ok,
      detail: detail.trim().slice(0, 500) || `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function terminateManagedServiceTree(
  service: ManagedServiceProcess,
  platform = process.platform,
): Promise<void> {
  service.stopOutputPipes?.();
  const pid = Number(service.proc.pid);
  if (platform === "win32" && Number.isFinite(pid) && pid > 0) {
    try {
      const taskkill = Bun.spawn(buildWindowsManagedServiceTreeTerminationArgv(pid), {
        stdout: "ignore",
        stderr: "ignore",
      });
      const result = await settleManagedProcessWithin(taskkill.exited, 5_000);
      if (result === null) {
        taskkill.kill("SIGKILL");
      } else if (
        result === 0 &&
        (await settleManagedProcessWithin(service.proc.exited, 2_000)) !== null
      ) {
        return;
      }
    } catch {
      // Fall back to terminating the managed parent directly.
    }
  }
  try {
    service.proc.kill("SIGKILL");
  } catch {
    // Process already exited.
  }
}

export function formatEmbeddedRuntimeHealthLines(health: EmbeddedRuntimeHealth | null): string[] {
  if (!health) return [];
  const lines = [`[pushpals] embeddedRuntime=${health.state} detail=${health.detail}`];
  if (health.action) {
    lines.push(`[pushpals] embeddedRuntimeAction=${health.action}`);
  }
  return lines;
}

export function computeServiceRestartBackoffMs(attempt: number): number {
  const boundedAttempt = Math.max(1, Math.floor(attempt));
  const exponential = DEFAULT_SERVICE_MANAGER_BASE_BACKOFF_MS * Math.pow(2, boundedAttempt - 1);
  return Math.max(
    DEFAULT_SERVICE_MANAGER_BASE_BACKOFF_MS,
    Math.min(DEFAULT_SERVICE_MANAGER_MAX_BACKOFF_MS, Math.floor(exponential)),
  );
}

export function shouldRestartService(
  attempts: number,
  maxAttempts = DEFAULT_SERVICE_MANAGER_MAX_RESTART_ATTEMPTS,
): boolean {
  const normalizedAttempts = Math.max(0, Math.floor(attempts));
  const normalizedMax = Math.max(1, Math.floor(maxAttempts));
  return normalizedAttempts < normalizedMax;
}

export function maxRssKiBToBytes(value: unknown): number | null {
  const maxRssKiB = Number(value);
  if (!Number.isFinite(maxRssKiB) || maxRssKiB < 0) return null;
  return Math.floor(maxRssKiB * 1024);
}

function managedServiceMaxRssBytes(service: ManagedServiceProcess): number | null {
  try {
    return maxRssKiBToBytes(service.proc.resourceUsage?.()?.maxRSS);
  } catch {
    return null;
  }
}

export function isRetryableManagedServiceLaunchError(error: unknown): boolean {
  const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? "")
    .trim()
    .toUpperCase();
  if (["EPERM", "EACCES", "EBUSY", "ETXTBSY", "ETIMEDOUT"].includes(code)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\b(?:EPERM|EACCES|EBUSY|ETXTBSY|ETIMEDOUT)\b|operation not permitted|resource busy|text file busy|launch did not become ready/i.test(
    message,
  );
}

function pipeProcessStreamToLines(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  onLine?: (line: string) => void,
): { cancel: () => void } {
  if (!stream || typeof stream === "number" || typeof stream.getReader !== "function") {
    return { cancel: () => {} };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let cancelled = false;
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (!trimmed) continue;
          onLine?.(trimmed);
        }
      }
      const rest = decoder.decode();
      if (rest) pending += rest;
      const tail = pending.trimEnd();
      if (tail) onLine?.(tail);
    } catch {
      // best-effort stream piping only
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // best-effort stream cleanup only
      }
    }
  })();
  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      try {
        void reader.cancel().catch(() => {});
      } catch {
        // best-effort stream cleanup only
      }
    },
  };
}

function spawnManagedService(spec: ManagedServiceSpec): ManagedServiceProcess {
  const env = { ...(spec.env ?? {}) };
  const launchReadyLine = String(spec.launchReadyLine ?? "").trim();
  let launchSettled = !launchReadyLine;
  let settleLaunchReady: (ready: boolean) => void = () => {};
  const launchReady = launchReadyLine
    ? new Promise<boolean>((resolve) => {
        settleLaunchReady = resolve;
      })
    : Promise.resolve(true);
  const observeLaunchLine = (line: string): void => {
    if (launchSettled || !launchReadyLine || !line.includes(launchReadyLine)) return;
    launchSettled = true;
    settleLaunchReady(true);
  };
  const proc = Bun.spawn(spec.command, {
    cwd: spec.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPipe = pipeProcessStreamToLines(proc.stdout, (line) => {
    observeLaunchLine(line);
    spec.onStdoutLine?.(line);
  });
  const stderrPipe = pipeProcessStreamToLines(proc.stderr, (line) => {
    observeLaunchLine(line);
    spec.onStderrLine?.(line);
  });
  const service: ManagedServiceProcess = {
    name: spec.name,
    proc,
    command: [...spec.command],
    cwd: spec.cwd,
    env,
    exited: false,
    exitCode: null,
    launchedAtMs: Date.now(),
    launchReady,
    launchTimedOut: false,
    logPath: spec.logPath,
    stopOutputPipes: () => {
      stdoutPipe.cancel();
      stderrPipe.cancel();
    },
  };
  const configuredLaunchTimeoutMs = Math.floor(spec.launchTimeoutMs ?? 0);
  const launchTimeoutMs =
    configuredLaunchTimeoutMs > 0 ? Math.max(100, configuredLaunchTimeoutMs) : 0;
  const launchTimer =
    launchReadyLine && launchTimeoutMs > 0
      ? setTimeout(() => {
          if (launchSettled) return;
          launchSettled = true;
          service.launchTimedOut = true;
          spec.onLaunchTimeout?.(launchTimeoutMs);
          try {
            proc.kill("SIGKILL");
          } catch {
            // The isolated launcher may already have exited.
          }
          settleLaunchReady(false);
        }, launchTimeoutMs)
      : null;
  void proc.exited.then((code) => {
    if (launchTimer) clearTimeout(launchTimer);
    if (!launchSettled) {
      launchSettled = true;
      settleLaunchReady(false);
    }
    service.exited = true;
    service.exitCode = code;
  });
  return service;
}

export class ServiceManager {
  private readonly services = new Map<string, ManagedServiceProcess>();
  private readonly launchSpecs = new Map<string, ManagedServiceSpec>();
  private readonly stateByService = new Map<string, ServiceManagerState>();
  private readonly degradedServiceReasons = new Map<string, string>();
  private readonly pollMs: number;
  private readonly maxRestartAttempts: number;
  private readonly stableWindowMs: number;
  private readonly repeatedExitFingerprintLimit: number;
  private readonly repeatedExitFingerprintWindowMs: number;
  private readonly resolveExitFingerprint?: ServiceManagerOptions["resolveExitFingerprint"];
  private readonly computeRestartBackoffMs: (attempt: number) => number;
  private readonly degradedAction: string;
  private readonly spawnService: (spec: ManagedServiceSpec) => ManagedServiceProcess;
  private readonly onHealthChange?: (health: EmbeddedRuntimeHealth | null) => void;
  private readonly onServiceDegraded?: (
    name: string,
    reason: string,
    health: EmbeddedRuntimeHealth,
  ) => void;
  private readonly onEvent?: (level: "log" | "warn" | "error", line: string) => void;
  private readonly onLifecycleEvent?: (event: ManagedServiceLifecycleEvent) => void;
  private readonly probeServiceHealth: NonNullable<ServiceManagerOptions["probeServiceHealth"]>;
  private readonly terminateService: NonNullable<ServiceManagerOptions["terminateService"]>;
  private readonly timer: ReturnType<typeof setInterval>;
  private shutdownBegun = false;
  private stopped = false;

  constructor(options: ServiceManagerOptions = {}) {
    this.pollMs = Math.max(50, Math.floor(options.pollMs ?? DEFAULT_SERVICE_MANAGER_POLL_MS));
    this.maxRestartAttempts = Math.max(
      1,
      Math.floor(options.maxRestartAttempts ?? DEFAULT_SERVICE_MANAGER_MAX_RESTART_ATTEMPTS),
    );
    this.stableWindowMs = Math.max(
      1_000,
      Math.floor(options.stableWindowMs ?? DEFAULT_SERVICE_MANAGER_STABLE_WINDOW_MS),
    );
    this.repeatedExitFingerprintLimit = Math.max(
      2,
      Math.floor(options.repeatedExitFingerprintLimit ?? DEFAULT_REPEATED_EXIT_FINGERPRINT_LIMIT),
    );
    this.repeatedExitFingerprintWindowMs = Math.max(
      1_000,
      Math.floor(
        options.repeatedExitFingerprintWindowMs ?? DEFAULT_REPEATED_EXIT_FINGERPRINT_WINDOW_MS,
      ),
    );
    this.resolveExitFingerprint = options.resolveExitFingerprint;
    this.computeRestartBackoffMs =
      options.computeRestartBackoffMs ?? computeServiceRestartBackoffMs;
    this.degradedAction =
      options.degradedAction ??
      "Inspect the affected service logs or restart the runtime after fixing the failure.";
    this.spawnService = options.spawnService ?? spawnManagedService;
    this.onHealthChange = options.onHealthChange;
    this.onServiceDegraded = options.onServiceDegraded;
    this.onEvent = options.onEvent;
    this.onLifecycleEvent = options.onLifecycleEvent;
    this.probeServiceHealth = options.probeServiceHealth ?? defaultProbeServiceHealth;
    this.terminateService = options.terminateService ?? terminateManagedServiceTree;
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  startService(spec: ManagedServiceSpec): ManagedServiceProcess {
    this.launchSpecs.set(spec.name, {
      ...spec,
      command: [...spec.command],
      env: { ...(spec.env ?? {}) },
    });
    const service = this.spawnService(spec);
    this.services.set(spec.name, service);
    return service;
  }

  replaceService(
    spec: ManagedServiceSpec,
    options: { resetAttempts?: boolean } = {},
  ): ManagedServiceProcess {
    const existing = this.services.get(spec.name);
    if (existing && !existing.exited) {
      try {
        existing.stopOutputPipes?.();
        existing.proc.kill("SIGTERM");
      } catch {
        // ignore best-effort replacement shutdown failures
      }
    }

    const state = this.ensureState(spec.name);
    if (state.pendingRestartTimer) {
      clearTimeout(state.pendingRestartTimer);
      state.pendingRestartTimer = null;
    }
    state.nextRestartAtMs = 0;
    state.lastRestartReason = "";
    state.nextHealthProbeAtMs = 0;
    state.healthProbeInFlight = false;
    state.consecutiveUnhealthyProbes = 0;
    state.healthTerminationRequested = false;
    state.healthFailureDetail = "";
    if (options.resetAttempts !== false) {
      state.attempts = 0;
      state.lastExitFingerprint = "";
      state.matchingExitFingerprintCount = 0;
      state.lastExitFingerprintAtMs = 0;
    }
    this.degradedServiceReasons.delete(spec.name);
    this.emitHealthChange();

    return this.startService(spec);
  }

  getServices(): ManagedServiceProcess[] {
    return Array.from(this.services.values());
  }

  getService(name: string): ManagedServiceProcess | null {
    return this.services.get(name) ?? null;
  }

  abandonService(service: ManagedServiceProcess): void {
    if (this.services.get(service.name) !== service) return;
    service.stopOutputPipes?.();
    try {
      service.proc.kill("SIGKILL");
    } catch {
      // Best-effort isolated-launcher termination only.
    }
    this.services.delete(service.name);
    this.launchSpecs.delete(service.name);
    const state = this.stateByService.get(service.name);
    if (state?.pendingRestartTimer) clearTimeout(state.pendingRestartTimer);
    this.stateByService.delete(service.name);
    this.degradedServiceReasons.delete(service.name);
    this.emitHealthChange();
  }

  getHealth(): EmbeddedRuntimeHealth | null {
    if (this.degradedServiceReasons.size === 0) return null;
    const detail = Array.from(this.degradedServiceReasons.entries())
      .map(([name, reason]) => `${name}: ${reason}`)
      .join(" | ");
    return {
      state: "degraded",
      detail,
      action: this.degradedAction,
    };
  }

  beginShutdown(): void {
    if (this.shutdownBegun || this.stopped) return;
    this.shutdownBegun = true;
    clearInterval(this.timer);
    for (const state of this.stateByService.values()) {
      if (!state.pendingRestartTimer) continue;
      clearTimeout(state.pendingRestartTimer);
      state.pendingRestartTimer = null;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.beginShutdown();
    this.stopped = true;
    for (const service of this.services.values()) {
      try {
        service.stopOutputPipes?.();
        service.proc.kill("SIGTERM");
      } catch {
        // ignore best-effort shutdown failures
      }
    }
  }

  private ensureState(name: string): ServiceManagerState {
    const existing = this.stateByService.get(name);
    if (existing) return existing;
    const created: ServiceManagerState = {
      attempts: 0,
      nextRestartAtMs: 0,
      lastRestartReason: "",
      pendingRestartTimer: null,
      lastReportedExitedProcess: null,
      lastExitFingerprint: "",
      matchingExitFingerprintCount: 0,
      lastExitFingerprintAtMs: 0,
      nextHealthProbeAtMs: 0,
      healthProbeInFlight: false,
      consecutiveUnhealthyProbes: 0,
      healthTerminationRequested: false,
      healthFailureDetail: "",
    };
    this.stateByService.set(name, created);
    return created;
  }

  private emitHealthChange(): void {
    this.onHealthChange?.(this.getHealth());
  }

  private emitEvent(level: "log" | "warn" | "error", line: string): void {
    this.onEvent?.(level, line);
  }

  private recordExitFingerprint(
    state: ServiceManagerState,
    name: string,
    service: ManagedServiceProcess,
    now: number,
  ): { fingerprint: string; count: number; limitReached: boolean } | null {
    if (!this.resolveExitFingerprint) return null;
    let resolved = "";
    try {
      resolved = String(
        this.resolveExitFingerprint({
          service: name,
          exitCode: service.exitCode,
          uptimeMs: Math.max(0, now - service.launchedAtMs),
          logPath: service.logPath,
          command: [...service.command],
        }) ?? "",
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 240);
    } catch (error) {
      this.emitEvent(
        "warn",
        `Managed ${name} exit fingerprint resolver failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    if (!resolved) return null;

    const withinWindow =
      state.lastExitFingerprint === resolved &&
      now - state.lastExitFingerprintAtMs <= this.repeatedExitFingerprintWindowMs;
    state.matchingExitFingerprintCount = withinWindow ? state.matchingExitFingerprintCount + 1 : 1;
    state.lastExitFingerprint = resolved;
    state.lastExitFingerprintAtMs = now;
    return {
      fingerprint: resolved,
      count: state.matchingExitFingerprintCount,
      limitReached: state.matchingExitFingerprintCount >= this.repeatedExitFingerprintLimit,
    };
  }

  private scheduleHealthProbe(
    name: string,
    service: ManagedServiceProcess,
    spec: ManagedServiceSpec,
    state: ServiceManagerState,
    now: number,
  ): void {
    const healthCheck = spec.healthCheck;
    if (
      !healthCheck ||
      state.healthProbeInFlight ||
      state.healthTerminationRequested ||
      state.nextHealthProbeAtMs > now
    ) {
      return;
    }
    state.healthProbeInFlight = true;
    state.nextHealthProbeAtMs =
      now + Math.max(50, healthCheck.intervalMs ?? DEFAULT_SERVICE_HEALTH_INTERVAL_MS);
    void this.probeServiceHealth(healthCheck)
      .then(async (health) => {
        if (this.shutdownBegun || this.stopped) return;
        if (this.services.get(name) !== service || service.exited) return;
        if (health.ok) {
          state.consecutiveUnhealthyProbes = 0;
          state.healthFailureDetail = "";
          return;
        }
        state.consecutiveUnhealthyProbes += 1;
        state.healthFailureDetail = health.detail;
        const threshold = Math.max(
          1,
          Math.floor(healthCheck.unhealthyThreshold ?? DEFAULT_SERVICE_UNHEALTHY_THRESHOLD),
        );
        this.emitEvent(
          state.consecutiveUnhealthyProbes >= threshold ? "warn" : "log",
          `Managed ${name} health probe failed (${state.consecutiveUnhealthyProbes}/${threshold}): ${health.detail}`,
        );
        if (state.consecutiveUnhealthyProbes < threshold) return;
        state.healthTerminationRequested = true;
        this.emitEvent(
          "warn",
          `Managed ${name} is unhealthy; terminating its process tree so the supervisor can restart it.`,
        );
        await this.terminateService(service);
      })
      .catch((error) => {
        this.emitEvent(
          "warn",
          `Managed ${name} health supervision failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        state.healthProbeInFlight = false;
      });
  }

  private tick(): void {
    if (this.shutdownBegun || this.stopped) return;
    const now = Date.now();
    for (const [name, service] of this.services.entries()) {
      const launchSpec = this.launchSpecs.get(name);
      if (!launchSpec) continue;
      const state = this.ensureState(name);
      if (!service.exited) {
        if (state.attempts > 0 && now - service.launchedAtMs >= this.stableWindowMs) {
          state.attempts = 0;
          state.nextRestartAtMs = 0;
          state.lastRestartReason = "";
        }
        this.scheduleHealthProbe(name, service, launchSpec, state, now);
        continue;
      }
      if (state.pendingRestartTimer) continue;
      if (state.nextRestartAtMs > now) continue;

      const reason = state.healthTerminationRequested
        ? `unhealthy health probe${state.healthFailureDetail ? `: ${state.healthFailureDetail}` : ""}`
        : `exit code ${service.exitCode ?? "unknown"}`;
      const exitAlreadyReported = state.lastReportedExitedProcess === service;
      const uptimeMs = Math.max(0, now - service.launchedAtMs);
      const exitFingerprint = exitAlreadyReported
        ? null
        : this.recordExitFingerprint(state, name, service, now);
      const fingerprintCircuitOpen = Boolean(exitFingerprint?.limitReached);
      if (
        fingerprintCircuitOpen ||
        !shouldRestartService(state.attempts, this.maxRestartAttempts)
      ) {
        if (!exitAlreadyReported) {
          state.lastReportedExitedProcess = service;
          this.onLifecycleEvent?.({
            type: "exit",
            service: name,
            exitCode: service.exitCode,
            uptimeMs,
            rssBytes: managedServiceMaxRssBytes(service),
            restartAttempt: state.attempts,
            maxRestartAttempts: this.maxRestartAttempts,
            recoveryPlanned: false,
            observedAt: new Date(now).toISOString(),
          });
        }
        this.onLifecycleEvent?.({
          type: "recovery_exhausted",
          service: name,
          restartAttempt: state.attempts,
          maxRestartAttempts: this.maxRestartAttempts,
          observedAt: new Date(now).toISOString(),
        });
        const repeatedFailureDetail = fingerprintCircuitOpen
          ? `repeated identical native failure (${exitFingerprint?.count}/${this.repeatedExitFingerprintLimit}, fingerprint=${exitFingerprint?.fingerprint})`
          : `reached restart limit (${state.attempts}/${this.maxRestartAttempts})`;
        this.emitEvent("error", `Managed ${name} exited (${reason}) and ${repeatedFailureDetail}.`);
        this.launchSpecs.delete(name);
        if (!this.degradedServiceReasons.has(name)) {
          const degradationReason = fingerprintCircuitOpen
            ? `${repeatedFailureDetail} after ${reason}; automatic restarts paused for this service`
            : `reached restart limit after ${reason} (${state.attempts}/${this.maxRestartAttempts})`;
          this.degradedServiceReasons.set(name, degradationReason);
          const health = this.getHealth();
          if (health) {
            this.onHealthChange?.(health);
            this.onServiceDegraded?.(name, degradationReason, health);
          }
        }
        continue;
      }

      const nextAttempt = state.attempts + 1;
      state.lastRestartReason = reason;
      const backoffMs = Math.max(1, Math.floor(this.computeRestartBackoffMs(nextAttempt)));
      if (!exitAlreadyReported) {
        state.lastReportedExitedProcess = service;
        this.onLifecycleEvent?.({
          type: "exit",
          service: name,
          exitCode: service.exitCode,
          uptimeMs,
          rssBytes: managedServiceMaxRssBytes(service),
          restartAttempt: nextAttempt,
          maxRestartAttempts: this.maxRestartAttempts,
          recoveryPlanned: true,
          observedAt: new Date(now).toISOString(),
        });
      }
      this.emitEvent(
        "warn",
        `Managed ${name} exited (${reason}); restarting attempt ${nextAttempt}/${this.maxRestartAttempts} in ${backoffMs}ms.`,
      );
      state.nextRestartAtMs = now + backoffMs;
      state.pendingRestartTimer = setTimeout(() => {
        state.pendingRestartTimer = null;
        state.nextRestartAtMs = 0;
        if (this.shutdownBegun || this.stopped) return;
        const current = this.services.get(name);
        if (!current || !current.exited) return;
        const spec = this.launchSpecs.get(name);
        if (!spec) return;
        if (!shouldRestartService(state.attempts, this.maxRestartAttempts)) return;
        state.attempts += 1;
        try {
          const restarted = this.spawnService(spec);
          this.services.set(name, restarted);
          state.nextHealthProbeAtMs =
            Date.now() +
            Math.max(50, spec.healthCheck?.intervalMs ?? DEFAULT_SERVICE_HEALTH_INTERVAL_MS);
          state.consecutiveUnhealthyProbes = 0;
          state.healthTerminationRequested = false;
          state.healthFailureDetail = "";
          this.emitEvent("log", `Restarted managed ${name}.`);
          this.onLifecycleEvent?.({
            type: "restarted",
            service: name,
            restartAttempt: state.attempts,
            maxRestartAttempts: this.maxRestartAttempts,
            observedAt: new Date().toISOString(),
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          state.lastRestartReason = `launch error: ${detail}`;
          this.emitEvent(
            "warn",
            `Managed ${name} restart attempt ${state.attempts}/${this.maxRestartAttempts} could not launch: ${detail}`,
          );
        }
      }, backoffMs);
    }
  }
}

export async function startManagedServiceWithRetry(
  serviceManager: ServiceManager,
  spec: ManagedServiceSpec,
  options: ManagedServiceLaunchRetryOptions = {},
): Promise<ManagedServiceProcess> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const computeBackoffMs =
    options.computeBackoffMs ?? ((attempt: number) => Math.min(10_000, 2_000 * attempt));
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const shouldRetry = options.shouldRetry ?? isRetryableManagedServiceLaunchError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const service = serviceManager.startService(spec);
      const launchReady = service.launchReady ? await service.launchReady : true;
      if (!launchReady) {
        serviceManager.abandonService(service);
        throw Object.assign(
          new Error(
            `Managed ${spec.name} launch did not become ready within ${Math.max(0, Math.floor(spec.launchTimeoutMs ?? 0))}ms.`,
          ),
          { code: "ETIMEDOUT" },
        );
      }
      return service;
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error;
      const backoffMs = Math.max(0, Math.floor(computeBackoffMs(attempt)));
      options.onRetry?.(error, attempt, maxAttempts, backoffMs);
      await sleep(backoffMs);
    }
  }
  throw new Error(`Managed ${spec.name} launch retry loop ended without a result.`);
}

export function buildCoreManagedServiceSpecs(
  bunExecPath = (process.execPath ?? "").trim() || "bun",
  cwd = process.cwd(),
  env?: Record<string, string>,
): ManagedServiceSpec[] {
  const base = { cwd, env };
  return [
    { name: "server", color: "blue", command: [bunExecPath, "run", "server:only"], ...base },
    {
      name: "remotebuddy",
      color: "red",
      command: [bunExecPath, "run", "remotebuddy:only"],
      ...base,
    },
    {
      name: "workerpals",
      color: "yellow",
      command: [bunExecPath, "run", "workerpals:only:docker"],
      ...base,
    },
    {
      name: "source_control_manager",
      color: "cyan",
      command: [bunExecPath, "run", "source_control_manager:only:dev"],
      ...base,
    },
    {
      name: "client",
      color: "green",
      command: [bunExecPath, "run", "client:only:offline"],
      ...base,
    },
  ];
}
