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
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
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
  logPath?: string;
};

type ServiceManagerState = {
  attempts: number;
  nextRestartAtMs: number;
  lastRestartReason: string;
  pendingRestartTimer: ReturnType<typeof setTimeout> | null;
};

export type ServiceManagerOptions = {
  pollMs?: number;
  maxRestartAttempts?: number;
  stableWindowMs?: number;
  computeRestartBackoffMs?: (attempt: number) => number;
  degradedAction?: string;
  spawnService?: (spec: ManagedServiceSpec) => ManagedServiceProcess;
  onHealthChange?: (health: EmbeddedRuntimeHealth | null) => void;
  onServiceDegraded?: (name: string, reason: string, health: EmbeddedRuntimeHealth) => void;
  onEvent?: (level: "log" | "warn" | "error", line: string) => void;
};

const DEFAULT_SERVICE_MANAGER_POLL_MS = 1_000;
const DEFAULT_SERVICE_MANAGER_MAX_RESTART_ATTEMPTS = 4;
const DEFAULT_SERVICE_MANAGER_STABLE_WINDOW_MS = 60_000;
const DEFAULT_SERVICE_MANAGER_BASE_BACKOFF_MS = 2_000;
const DEFAULT_SERVICE_MANAGER_MAX_BACKOFF_MS = 30_000;

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

function pipeProcessStreamToLines(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  onLine?: (line: string) => void,
): void {
  if (!stream || typeof stream === "number" || typeof stream.getReader !== "function") return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
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
      reader.releaseLock();
    }
  })();
}

function spawnManagedService(spec: ManagedServiceSpec): ManagedServiceProcess {
  const env = { ...(spec.env ?? {}) };
  const proc = Bun.spawn(spec.command, {
    cwd: spec.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  pipeProcessStreamToLines(proc.stdout, spec.onStdoutLine);
  pipeProcessStreamToLines(proc.stderr, spec.onStderrLine);
  const service: ManagedServiceProcess = {
    name: spec.name,
    proc,
    command: [...spec.command],
    cwd: spec.cwd,
    env,
    exited: false,
    exitCode: null,
    launchedAtMs: Date.now(),
    logPath: spec.logPath,
  };
  void proc.exited.then((code) => {
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
  private readonly computeRestartBackoffMs: (attempt: number) => number;
  private readonly degradedAction: string;
  private readonly spawnService: (spec: ManagedServiceSpec) => ManagedServiceProcess;
  private readonly onHealthChange?: (health: EmbeddedRuntimeHealth | null) => void;
  private readonly onServiceDegraded?: (name: string, reason: string, health: EmbeddedRuntimeHealth) => void;
  private readonly onEvent?: (level: "log" | "warn" | "error", line: string) => void;
  private readonly timer: ReturnType<typeof setInterval>;
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
    this.computeRestartBackoffMs = options.computeRestartBackoffMs ?? computeServiceRestartBackoffMs;
    this.degradedAction =
      options.degradedAction ??
      "Inspect the affected service logs or restart the runtime after fixing the failure.";
    this.spawnService = options.spawnService ?? spawnManagedService;
    this.onHealthChange = options.onHealthChange;
    this.onServiceDegraded = options.onServiceDegraded;
    this.onEvent = options.onEvent;
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

  getServices(): ManagedServiceProcess[] {
    return Array.from(this.services.values());
  }

  getService(name: string): ManagedServiceProcess | null {
    return this.services.get(name) ?? null;
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

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    for (const state of this.stateByService.values()) {
      if (!state.pendingRestartTimer) continue;
      clearTimeout(state.pendingRestartTimer);
      state.pendingRestartTimer = null;
    }
    for (const service of this.services.values()) {
      try {
        const pid = service.proc.pid;
        if (process.platform === "win32" && typeof pid === "number" && pid > 0) {
          Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          });
        } else {
          service.proc.kill();
        }
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

  private tick(): void {
    if (this.stopped) return;
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
        continue;
      }
      if (state.pendingRestartTimer) continue;
      if (state.nextRestartAtMs > now) continue;

      const reason = `exit code ${service.exitCode ?? "unknown"}`;
      if (!shouldRestartService(state.attempts, this.maxRestartAttempts)) {
        this.emitEvent(
          "error",
          `Managed ${name} exited (${reason}) and reached restart limit (${state.attempts}/${this.maxRestartAttempts}).`,
        );
        this.launchSpecs.delete(name);
        if (!this.degradedServiceReasons.has(name)) {
          const degradationReason = `reached restart limit after ${reason} (${state.attempts}/${this.maxRestartAttempts})`;
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
      this.emitEvent(
        "warn",
        `Managed ${name} exited (${reason}); restarting attempt ${nextAttempt}/${this.maxRestartAttempts} in ${backoffMs}ms.`,
      );
      state.nextRestartAtMs = now + backoffMs;
      state.pendingRestartTimer = setTimeout(() => {
        state.pendingRestartTimer = null;
        state.nextRestartAtMs = 0;
        if (this.stopped) return;
        const current = this.services.get(name);
        if (!current || !current.exited) return;
        const spec = this.launchSpecs.get(name);
        if (!spec) return;
        if (!shouldRestartService(state.attempts, this.maxRestartAttempts)) return;
        state.attempts += 1;
        const restarted = this.spawnService(spec);
        this.services.set(name, restarted);
        this.emitEvent("log", `Restarted managed ${name}.`);
      }, backoffMs);
    }
  }
}

export function buildCoreManagedServiceSpecs(
  bunExecPath = (process.execPath ?? "").trim() || "bun",
  cwd = process.cwd(),
  env?: Record<string, string>,
): ManagedServiceSpec[] {
  const base = { cwd, env };
  return [
    { name: "server", color: "blue", command: [bunExecPath, "run", "server:only"], ...base },
    { name: "remotebuddy", color: "red", command: [bunExecPath, "run", "remotebuddy:only"], ...base },
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
    { name: "client", color: "green", command: [bunExecPath, "run", "client:only:offline"], ...base },
  ];
}
