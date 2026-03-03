/**
 * RemoteBuddy bootstrap system preflight.
 *
 * Validates runtime dependencies before the orchestrator starts so
 * downstream queue logic never executes when the host is misconfigured.
 */

export const SYSTEM_PREFLIGHT_FAILURE_CODES = {
  ENVIRONMENT_MISSING: "system.env.missing",
  BUN_VERSION_UNSUPPORTED: "system.runtime.bun_version",
  DOCKER_UNREACHABLE: "system.docker.unreachable",
  UNEXPECTED_RUNTIME_ERROR: "system.runtime.unexpected",
} as const;

export type SystemPreflightFailureCode =
  (typeof SYSTEM_PREFLIGHT_FAILURE_CODES)[keyof typeof SYSTEM_PREFLIGHT_FAILURE_CODES];

export type SystemPreflightCategory = "env" | "runtime" | "docker";

export type SystemPreflightStatus = "pass" | "fail";

export interface SystemPreflightOptions {
  requiredEnv?: string[];
  minBunVersion?: string;
}

export interface DockerProbeResult {
  ok: boolean;
  version?: string;
  detail?: string;
}

export interface SystemPreflightRecord {
  code: SystemPreflightFailureCode;
  label: string;
  action: string;
  category: SystemPreflightCategory;
  step: number;
  status: SystemPreflightStatus;
  detail: string;
  elapsedMs: number;
}

export interface SystemPreflightFailure {
  code: SystemPreflightFailureCode;
  detail: string;
  action: string;
  category: SystemPreflightCategory;
  step: number;
}

export interface SystemPreflightResult {
  ok: boolean;
  history: SystemPreflightRecord[];
  failure?: SystemPreflightFailure;
}

export interface SystemPreflightContext {
  env: Record<string, string | undefined>;
  bunVersion: string;
  dockerProbe: () => Promise<DockerProbeResult>;
  now?: () => number;
  log?: (record: SystemPreflightRecord) => void;
}

export interface StartupPreflightRecordPayload {
  phase: "startup_preflight";
  step: number;
  code: SystemPreflightFailureCode;
  category: SystemPreflightCategory;
  status: SystemPreflightStatus;
  detail: string;
  action?: string;
  elapsedMs: number;
}

export interface StartupPreflightFailurePayload {
  phase: "startup_preflight_failure";
  step: number;
  code: SystemPreflightFailureCode;
  category: SystemPreflightCategory;
  detail: string;
  action: string;
  error?: string;
}

export type StartupPreflightLogPayload =
  | StartupPreflightRecordPayload
  | StartupPreflightFailurePayload;

export type StartupPreflightLogger = (payload: StartupPreflightLogPayload) => void;

type StartupPreflightStructuredEvent = {
  source: "remotebuddy.startup_preflight";
  severity: "info" | "error";
  timestamp: string;
  payload: StartupPreflightLogPayload;
};

const buildStructuredEvent = (
  payload: StartupPreflightLogPayload,
): StartupPreflightStructuredEvent => ({
  source: "remotebuddy.startup_preflight",
  severity:
    payload.phase === "startup_preflight"
      ? payload.status === "pass"
        ? "info"
        : "error"
      : "error",
  timestamp: new Date().toISOString(),
  payload,
});

export interface EnforceSystemPreflightOptions {
  contextOverrides?: Partial<SystemPreflightContext>;
  preflightOptions?: SystemPreflightOptions;
  log?: StartupPreflightLogger;
  /**
   * Internal: allows tests to inject a custom runner.
   */
  runner?: typeof runSystemPreflight;
}

export type GuardSystemPreflightOptions = EnforceSystemPreflightOptions;

type SystemPreflightCheckDefinition = {
  code: SystemPreflightFailureCode;
  label: string;
  action: string;
  category: SystemPreflightCategory;
  run: (
    ctx: SystemPreflightContext,
    options: Required<SystemPreflightOptions>,
  ) => Promise<{ ok: boolean; detail?: string }>;
};

export interface SystemPreflightStructure {
  code: SystemPreflightFailureCode;
  label: string;
  action: string;
  category: SystemPreflightCategory;
  step: number;
}

const DEFAULT_REQUIRED_ENV = [
  "PUSHPALS_AUTH_TOKEN",
  "REMOTE_STABLE_ID",
  "SERVER_BASE_URL",
  "WORKERPALS_API_URL",
] as const;

const DEFAULT_MIN_BUN_VERSION = "1.1.0";

const systemChecks: readonly SystemPreflightCheckDefinition[] = [
  {
    code: SYSTEM_PREFLIGHT_FAILURE_CODES.ENVIRONMENT_MISSING,
    label: "Startup environment variables must be present.",
    action:
      "Export PUSHPALS_AUTH_TOKEN, REMOTE_STABLE_ID, SERVER_BASE_URL, and WORKERPALS_API_URL (see docs/startup.md) before launching RemoteBuddy.",
    category: "env",
    run: async (ctx, options) => {
      const missing = options.requiredEnv
        .filter((key) => !hasValue(ctx.env[key]))
        .map((key) => key);
      if (missing.length > 0) {
        return {
          ok: false,
          detail: `Missing required environment variables: ${missing.join(
            ", ",
          )}. Export them or load configs/local.* before retrying.`,
        };
      }
      return {
        ok: true,
        detail: `All required env vars present (${options.requiredEnv.join(", ")}).`,
      };
    },
  },
  {
    code: SYSTEM_PREFLIGHT_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    label: "Bun runtime must satisfy the repo minimum.",
    action:
      "Install Bun >= 1.1.x (curl https://bun.sh/install | bash) or run `bun upgrade --canary` until bun --version meets the minimum.",
    category: "runtime",
    run: async (ctx, options) => {
      const detected = ctx.bunVersion ?? "";
      if (!detected) {
        return {
          ok: false,
          detail: "Bun version was not detected from process.versions.bun.",
        };
      }
      if (isVersionAtLeast(detected, options.minBunVersion)) {
        return {
          ok: true,
          detail: `Detected Bun ${detected} (minimum ${options.minBunVersion}).`,
        };
      }
      return {
        ok: false,
        detail: `Bun ${detected} does not meet minimum ${options.minBunVersion}.`,
      };
    },
  },
  {
    code: SYSTEM_PREFLIGHT_FAILURE_CODES.DOCKER_UNREACHABLE,
    label: "Docker daemon must be reachable via CLI.",
    action:
      "Start Docker Desktop/daemon and ensure `docker info` succeeds locally; verify your user has permission to access the Docker socket.",
    category: "docker",
    run: async (ctx) => {
      const probe = await ctx.dockerProbe();
      if (probe.ok) {
        const versionDetail = probe.version ? ` (ServerVersion ${probe.version})` : "";
        return {
          ok: true,
          detail: `docker info responded${versionDetail}.`,
        };
      }
      return {
        ok: false,
        detail: probe.detail
          ? `Docker unreachable: ${probe.detail}`
          : "Docker unreachable: docker info failed.",
      };
    },
  },
];

export const SYSTEM_PREFLIGHT_STRUCTURE: readonly SystemPreflightStructure[] =
  systemChecks.map((check, idx) => ({
    code: check.code,
    label: check.label,
    action: check.action,
    category: check.category,
    step: idx + 1,
  }));

const nowMs = (ctx: SystemPreflightContext): number => (ctx.now ? ctx.now() : Date.now());

const defaultDockerProbe = async (): Promise<DockerProbeResult> => {
  try {
    const result = Bun.spawnSync({
      cmd: ["docker", "info", "--format", "{{json .ServerVersion}}"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      const stderr = decodeText(result.stderr).trim();
      const detail = stderr || `docker info exited with code ${result.exitCode}`;
      return { ok: false, detail };
    }
    const raw = decodeText(result.stdout).trim();
    const version = parseDockerVersion(raw);
    return {
      ok: true,
      version: version || undefined,
      detail: raw || "docker info succeeded.",
    };
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown docker probe failure.";
    return { ok: false, detail };
  }
};

const decodeText = (buffer: Uint8Array | undefined): string => {
  if (!buffer) return "";
  return new TextDecoder().decode(buffer);
};

const parseDockerVersion = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string" && parsed.trim()) {
      return parsed.trim();
    }
  } catch {
    // fall through to raw
  }
  return trimmed;
};

const hasValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value !== "string") return false;
  return value.trim().length > 0;
};

const sanitizeVersion = (value: string): [number, number, number] => {
  const numeric = value.trim().replace(/[^0-9.].*$/, "");
  const segments = numeric.split(".");
  return [
    Number.parseInt(segments[0] ?? "0", 10) || 0,
    Number.parseInt(segments[1] ?? "0", 10) || 0,
    Number.parseInt(segments[2] ?? "0", 10) || 0,
  ];
};

const isVersionAtLeast = (current: string, minimum: string): boolean => {
  const cur = sanitizeVersion(current);
  const min = sanitizeVersion(minimum);
  for (let i = 0; i < cur.length; i += 1) {
    if (cur[i] > min[i]) return true;
    if (cur[i] < min[i]) return false;
  }
  return true;
};

const buildContext = (
  overrides: Partial<SystemPreflightContext> = {},
): SystemPreflightContext => ({
  env: { ...process.env },
  bunVersion: process.versions?.bun ?? "",
  dockerProbe: defaultDockerProbe,
  ...overrides,
});

const buildOptions = (
  overrides: SystemPreflightOptions = {},
): Required<SystemPreflightOptions> => ({
  requiredEnv: overrides.requiredEnv ?? [...DEFAULT_REQUIRED_ENV],
  minBunVersion: overrides.minBunVersion ?? DEFAULT_MIN_BUN_VERSION,
});

export const runSystemPreflight = async (
  overrides: Partial<SystemPreflightContext> = {},
  options: SystemPreflightOptions = {},
): Promise<SystemPreflightResult> => {
  const ctx = buildContext(overrides);
  const resolvedOptions = buildOptions(options);
  const history: SystemPreflightRecord[] = [];

  for (const [index, check] of systemChecks.entries()) {
    const step = index + 1;
    const started = nowMs(ctx);
    let status: SystemPreflightStatus = "pass";
    let detail = check.label;
    try {
      const outcome = await check.run(ctx, resolvedOptions);
      status = outcome.ok ? "pass" : "fail";
      detail = outcome.detail ?? check.label;
    } catch (error) {
      status = "fail";
      detail =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Unknown preflight error.";
    }
    const record: SystemPreflightRecord = {
      code: check.code,
      label: check.label,
      action: check.action,
      category: check.category,
      step,
      status,
      detail,
      elapsedMs: Math.max(0, nowMs(ctx) - started),
    };
    history.push(record);
    ctx.log?.(record);
    if (status === "fail") {
      return {
        ok: false,
        history,
        failure: {
          code: check.code,
          detail,
          action: check.action,
          category: check.category,
          step,
        },
      };
    }
  }

  return { ok: true, history };
};

const UNEXPECTED_FAILURE_STRUCTURE = {
  code: SYSTEM_PREFLIGHT_FAILURE_CODES.UNEXPECTED_RUNTIME_ERROR,
  label: "System preflight must complete without internal errors.",
  action:
    "Collect RemoteBuddy logs, verify Bun/Docker installs, then retry `bun run src/remotebuddy_main.ts`. Escalate to #remote-infra if it repeats.",
  category: "runtime" as SystemPreflightCategory,
} as const;

const formatRecordPayload = (
  record: SystemPreflightRecord,
): StartupPreflightRecordPayload => ({
  phase: "startup_preflight",
  step: record.step,
  code: record.code,
  category: record.category,
  status: record.status,
  detail: record.detail,
  action: record.status === "fail" ? record.action : undefined,
  elapsedMs: record.elapsedMs,
});

const buildFailurePayload = (
  failure: SystemPreflightFailure,
): StartupPreflightFailurePayload => ({
  phase: "startup_preflight_failure",
  step: failure.step,
  code: failure.code,
  category: failure.category,
  detail: failure.detail,
  action: failure.action,
});

const detailFromError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown preflight exception.";
  }
};

const buildUnexpectedFailurePayload = (
  error: unknown,
  nextStep: number,
): StartupPreflightFailurePayload => ({
  phase: "startup_preflight_failure",
  step: nextStep,
  code: UNEXPECTED_FAILURE_STRUCTURE.code,
  category: UNEXPECTED_FAILURE_STRUCTURE.category,
  detail: detailFromError(error),
  action: UNEXPECTED_FAILURE_STRUCTURE.action,
  error:
    error instanceof Error
      ? error.stack ?? error.message
      : typeof error === "string"
        ? error
        : undefined,
});

const defaultPreflightLogger: StartupPreflightLogger = (payload) => {
  const event = buildStructuredEvent(payload);
  const sink = event.severity === "info" ? console.log : console.error;
  sink(JSON.stringify(event));
};

export class SystemPreflightError extends Error {
  readonly payload: StartupPreflightFailurePayload;

  constructor(payload: StartupPreflightFailurePayload) {
    super(
      `Startup preflight blocked at step ${payload.step} (${payload.code}): ${payload.detail}`,
    );
    this.name = "SystemPreflightError";
    this.payload = payload;
  }
}

export const enforceSystemPreflightOrThrow = async (
  options: EnforceSystemPreflightOptions = {},
): Promise<void> => {
  const {
    contextOverrides,
    preflightOptions,
    log = defaultPreflightLogger,
    runner = runSystemPreflight,
  } = options;
  let result: SystemPreflightResult | null = null;
  try {
    result = await runner(contextOverrides, preflightOptions);
    for (const record of result.history) {
      log(formatRecordPayload(record));
    }
    if (!result.ok) {
      if (!result.failure) {
        throw new Error("System preflight failed without failure payload.");
      }
      const failurePayload = buildFailurePayload(result.failure);
      log(failurePayload);
      throw new SystemPreflightError(failurePayload);
    }
    console.log(
      `[RemoteBuddy] Startup preflight passed (${result.history.length} checks).`,
    );
  } catch (error) {
    if (error instanceof SystemPreflightError) {
      throw error;
    }
    const failurePayload = buildUnexpectedFailurePayload(
      error,
      (result?.history.length ?? 0) + 1,
    );
    log(failurePayload);
    throw new SystemPreflightError(failurePayload);
  }
};

export const guardStartupWithSystemPreflight = async (
  next: () => Promise<void> | void,
  options?: GuardSystemPreflightOptions,
): Promise<void> => {
  await enforceSystemPreflightOrThrow(options);
  await next();
};
