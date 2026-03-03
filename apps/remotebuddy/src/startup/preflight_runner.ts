const MIN_BUN_VERSION = "1.1.0";
const MAX_BUN_VERSION_EXCLUSIVE = "2.0.0";
const MIN_DOCKER_VERSION = "24.0.0";

export const PREFLIGHT_FAILURE_CODES = {
  BUN_VERSION_UNSUPPORTED: "preflight.bun_unsupported",
  DOCKER_UNAVAILABLE: "preflight.docker_unavailable",
  DOCKER_VERSION_UNSUPPORTED: "preflight.docker_version",
  ENV_VARS_MISSING: "preflight.env_missing",
  SECRETS_MISSING: "preflight.secret_missing",
} as const;

export type PreflightFailureCode =
  (typeof PREFLIGHT_FAILURE_CODES)[keyof typeof PREFLIGHT_FAILURE_CODES];

export type PreflightCheckName =
  | "bun_version"
  | "docker_version"
  | "required_env"
  | "required_secrets";

const PREFLIGHT_TELEMETRY_BASE_CODES = {
  bun_version: "preflight.check.bun_version",
  docker_version: "preflight.check.docker_version",
  required_env: "preflight.check.required_env",
  required_secrets: "preflight.check.required_secrets",
} as const satisfies Record<PreflightCheckName, string>;

type PreflightTelemetryBaseCode =
  (typeof PREFLIGHT_TELEMETRY_BASE_CODES)[keyof typeof PREFLIGHT_TELEMETRY_BASE_CODES];

export type PreflightTelemetryCode = `${PreflightTelemetryBaseCode}.${"pass" | "fail"}`;

const buildTelemetryCode = (
  check: PreflightCheckName,
  status: "pass" | "fail",
): PreflightTelemetryCode => `${PREFLIGHT_TELEMETRY_BASE_CODES[check]}.${status}`;

export interface RemotebuddyPreflightConfig {
  sessionId: string | null;
  authToken: string | null;
  serverUrl: string | null;
  llmBackend: string;
  llmApiKey: string | null;
}

export interface PreflightTelemetryEntry {
  code: PreflightTelemetryCode;
  check: PreflightCheckName;
  status: "pass" | "fail";
  detail: string;
  metadata: Record<string, string>;
  elapsedMs: number;
  timestamp: string;
  action?: string;
  failureCode?: PreflightFailureCode;
}

export interface PreflightFailure {
  code: PreflightFailureCode;
  check: PreflightCheckName;
  detail: string;
  action: string;
}

export interface PreflightResult {
  ok: boolean;
  failure?: PreflightFailure;
  history: PreflightTelemetryEntry[];
}

export interface PreflightCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  error?: string;
}

export interface PreflightCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type PreflightCommandRunner = (
  command: string,
  args: string[],
  options?: PreflightCommandOptions,
) => Promise<PreflightCommandResult>;

export interface RemotebuddyPreflightContext {
  config: RemotebuddyPreflightConfig;
  env?: NodeJS.ProcessEnv;
  bunVersion?: string;
  now?: () => number;
  runCommand?: PreflightCommandRunner;
  log?: (entry: PreflightTelemetryEntry) => void;
}

interface RunnerDeps {
  config: RemotebuddyPreflightConfig;
  env: NodeJS.ProcessEnv;
  bunVersion: string;
  now: () => number;
  runCommand: PreflightCommandRunner;
  log: (entry: PreflightTelemetryEntry) => void;
}

interface PreflightCheckDefinition {
  name: PreflightCheckName;
  code: PreflightFailureCode;
  label: string;
  defaultAction: string;
  run: (deps: RunnerDeps) => Promise<{
    ok: boolean;
    detail: string;
    metadata?: Record<string, string>;
    action?: string;
    code?: PreflightFailureCode;
  }>;
}

interface ValueRequirement {
  names: string[];
  label: string;
  action: string;
  fallback?: (deps: RunnerDeps) => string | null | undefined;
}

const textDecoder = new TextDecoder();

const defaultCommandRunner: PreflightCommandRunner = async (command, args, options = {}) => {
  try {
    const result = Bun.spawnSync({
      cmd: [command, ...args],
      stdout: "pipe",
      stderr: "pipe",
      cwd: options.cwd,
      env: options.env,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout ? textDecoder.decode(result.stdout) : "",
      stderr: result.stderr ? textDecoder.decode(result.stderr) : "",
      failed: !result.success,
    };
  } catch (error) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      failed: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const defaultLog = (entry: PreflightTelemetryEntry) => {
  const payload = {
    component: "remotebuddy.preflight",
    ...entry,
  };
  console.log(`[RemoteBuddy][Preflight] ${JSON.stringify(payload)}`);
};

const DEFAULT_ENV_REQUIREMENTS: readonly ValueRequirement[] = [
  {
    names: ["PUSHPALS_SERVER_URL"],
    label: "PushPals server URL",
    action: "Set PUSHPALS_SERVER_URL in .env so RemoteBuddy can reach the PushPals server.",
    fallback: (deps) => deps.config.serverUrl,
  },
];

const DEFAULT_SECRET_REQUIREMENTS: readonly ValueRequirement[] = [
  {
    names: ["PUSHPALS_AUTH_TOKEN"],
    label: "PushPals auth token",
    action:
      "Export PUSHPALS_AUTH_TOKEN (or set configs.auth_token/--token) with a bearer token for the PushPals server.",
    fallback: (deps) => deps.config.authToken,
  },
];

const localBackends = new Set(["lmstudio", "ollama", "ollama_chat", "ollama.chat"]);

const compareVersions = (a: string, b: string): number => {
  const sanitize = (value: string) =>
    value
      .split(/[^0-9]+/g)
      .filter(Boolean)
      .map((part) => Number.parseInt(part, 10));
  const aParts = sanitize(a);
  const bParts = sanitize(b);
  const max = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < max; i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
};

const formatVersionRequirement = (
  min: string,
  maxExclusive?: string,
): string => (maxExclusive ? `${min} ≤ version < ${maxExclusive}` : `≥ ${min}`);

const trimValue = (value: string | null | undefined): string => (value ?? "").trim();

const resolveRequirement = (
  requirement: ValueRequirement,
  deps: RunnerDeps,
): { source: string; value: string } | null => {
  for (const name of requirement.names) {
    const candidate = trimValue(deps.env[name]);
    if (candidate) {
      return { source: `env:${name}`, value: candidate };
    }
  }
  if (requirement.fallback) {
    const fallback = trimValue(requirement.fallback(deps));
    if (fallback) {
      return { source: "config", value: fallback };
    }
  }
  return null;
};

const extractVersionToken = (output: string): string | null => {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
};

const detectDockerVersion = async (
  deps: RunnerDeps,
): Promise<{
  version: string | null;
  method: string;
  unavailable: boolean;
  stderr: string;
}> => {
  const formatted = await deps.runCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (!formatted.failed) {
    const raw = formatted.stdout.trim();
    if (raw) {
      return { version: raw, method: "docker version --format", unavailable: false, stderr: "" };
    }
  }
  const fallback = await deps.runCommand("docker", ["--version"]);
  if (!fallback.failed) {
    const token = extractVersionToken(fallback.stdout);
    if (token) {
      return { version: token, method: "docker --version", unavailable: false, stderr: "" };
    }
  }
  const stderr = formatted.stderr || fallback.stderr || formatted.error || fallback.error || "";
  const unavailable = Boolean(formatted.error?.includes("ENOENT") || fallback.error?.includes("ENOENT"));
  return { version: null, method: "docker version", unavailable, stderr };
};

const shouldRequireLlmSecret = (backendRaw: string): boolean => {
  const backend = backendRaw.trim().toLowerCase();
  if (!backend) return false;
  if (localBackends.has(backend)) return false;
  if (backend.includes("openai") || backend.includes("anthropic") || backend.includes("azure")) {
    return true;
  }
  return backend !== "lmstudio";
};

const buildSecretRequirements = (deps: RunnerDeps): ValueRequirement[] => {
  const requirements: ValueRequirement[] = [...DEFAULT_SECRET_REQUIREMENTS];
  if (shouldRequireLlmSecret(deps.config.llmBackend)) {
    requirements.push({
      names: ["REMOTEBUDDY_LLM_API_KEY", "OPENAI_API_KEY"],
      label: "RemoteBuddy LLM API key",
      action:
        "Set REMOTEBUDDY_LLM_API_KEY or OPENAI_API_KEY with an API key that can access the configured RemoteBuddy LLM backend.",
      fallback: () => deps.config.llmApiKey,
    });
  }
  return requirements;
};

const runRequirementsCheck = (
  deps: RunnerDeps,
  requirements: readonly ValueRequirement[],
): {
  missing: ValueRequirement[];
  metadata: Record<string, string>;
} => {
  const metadata: Record<string, string> = {};
  const missing: ValueRequirement[] = [];
  requirements.forEach((req) => {
    const result = resolveRequirement(req, deps);
    const key = `req.${req.names.join("|")}`;
    if (result) {
      metadata[key] = result.source;
    } else {
      metadata[key] = "missing";
      missing.push(req);
    }
  });
  metadata.requirement_count = `${requirements.length}`;
  metadata.missing_count = `${missing.length}`;
  return { missing, metadata };
};

const checks: readonly PreflightCheckDefinition[] = [
  {
    name: "bun_version",
    code: PREFLIGHT_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    label: "Bun runtime must meet RemoteBuddy requirements.",
    defaultAction:
      "Install Bun 1.1.x (>=1.1.0 <2.0.0) via https://bun.sh or upgrade your existing Bun installation, then restart RemoteBuddy.",
    run: async (deps) => {
      const version = trimValue(deps.bunVersion);
      const metadata: Record<string, string> = {
        observed: version || "unknown",
        required: formatVersionRequirement(MIN_BUN_VERSION, MAX_BUN_VERSION_EXCLUSIVE),
      };
      if (!version) {
        return {
          ok: false,
          detail: "Bun did not report a version string.",
          metadata,
        };
      }
      if (compareVersions(version, MIN_BUN_VERSION) < 0) {
        return {
          ok: false,
          detail: `Installed Bun ${version} is below the required minimum ${MIN_BUN_VERSION}.`,
          metadata,
        };
      }
      if (
        MAX_BUN_VERSION_EXCLUSIVE &&
        compareVersions(version, MAX_BUN_VERSION_EXCLUSIVE) >= 0
      ) {
        return {
          ok: false,
          detail: `Installed Bun ${version} is newer than supported (< ${MAX_BUN_VERSION_EXCLUSIVE}).`,
          metadata,
        };
      }
      return {
        ok: true,
        detail: `Bun ${version} satisfies runtime requirements.`,
        metadata,
      };
    },
  },
  {
    name: "docker_version",
    code: PREFLIGHT_FAILURE_CODES.DOCKER_VERSION_UNSUPPORTED,
    label: "Docker CLI must be installed and meet worker requirements.",
    defaultAction:
      "Install or upgrade Docker (>= 24.0.0) so WorkerPals containers can launch, then rerun RemoteBuddy.",
    run: async (deps) => {
      const detection = await detectDockerVersion(deps);
      const metadata: Record<string, string> = {
        method: detection.method,
        required: `>= ${MIN_DOCKER_VERSION}`,
      };
      if (detection.version) {
        metadata.observed = detection.version;
        if (compareVersions(detection.version, MIN_DOCKER_VERSION) < 0) {
          return {
            ok: false,
            detail: `Docker ${detection.version} is below the required minimum ${MIN_DOCKER_VERSION}.`,
            metadata,
          };
        }
        return {
          ok: true,
          detail: `Docker ${detection.version} satisfies WorkerPal requirements.`,
          metadata,
        };
      }
      if (detection.unavailable) {
        metadata.stderr = detection.stderr || "docker command missing";
        return {
          ok: false,
          detail: "Docker CLI is not installed or not on PATH.",
          metadata,
          action:
            "Install Docker Desktop or the Docker CLI, ensure `docker` is on PATH, then restart RemoteBuddy.",
          code: PREFLIGHT_FAILURE_CODES.DOCKER_UNAVAILABLE,
        };
      }
      metadata.stderr = detection.stderr || "unknown";
      return {
        ok: false,
        detail: "Failed to determine Docker version (command returned no version string).",
        metadata,
      };
    },
  },
  {
    name: "required_env",
    code: PREFLIGHT_FAILURE_CODES.ENV_VARS_MISSING,
    label: "Required environment wiring must be present.",
    defaultAction:
      "Populate the missing environment variables in your .env or shell, then restart RemoteBuddy.",
    run: async (deps) => {
      const { missing, metadata } = runRequirementsCheck(deps, DEFAULT_ENV_REQUIREMENTS);
      if (missing.length > 0) {
        return {
          ok: false,
          detail: `Missing required environment variables: ${missing
            .map((req) => req.label)
            .join(", ")}.`,
          metadata,
          action: missing[0]?.action ?? undefined,
        };
      }
      return {
        ok: true,
        detail: "All required environment variables resolved.",
        metadata,
      };
    },
  },
  {
    name: "required_secrets",
    code: PREFLIGHT_FAILURE_CODES.SECRETS_MISSING,
    label: "Secrets (auth + LLM keys) must be configured.",
    defaultAction:
      "Set the missing secrets (PUSHPALS_AUTH_TOKEN and relevant LLM API keys) before restarting RemoteBuddy.",
    run: async (deps) => {
      const requirements = buildSecretRequirements(deps);
      const { missing, metadata } = runRequirementsCheck(deps, requirements);
      if (missing.length > 0) {
        return {
          ok: false,
          detail: `Missing required secrets: ${missing.map((req) => req.label).join(", ")}.`,
          metadata,
          action: missing[0]?.action ?? undefined,
        };
      }
      return {
        ok: true,
        detail: "All required secrets resolved.",
        metadata,
      };
    },
  },
];

const buildDeps = (ctx: RemotebuddyPreflightContext): RunnerDeps => ({
  config: ctx.config,
  env: ctx.env ?? process.env,
  bunVersion: ctx.bunVersion ?? Bun.version,
  now: ctx.now ?? (() => Date.now()),
  runCommand: ctx.runCommand ?? defaultCommandRunner,
  log: ctx.log ?? defaultLog,
});

export const runRemotebuddyPreflight = async (
  ctx: RemotebuddyPreflightContext,
): Promise<PreflightResult> => {
  const deps = buildDeps(ctx);
  const history: PreflightTelemetryEntry[] = [];
  for (const check of checks) {
    const started = deps.now();
    let outcome;
    try {
      outcome = await check.run(deps);
    } catch (error) {
      outcome = {
        ok: false,
        detail:
          error instanceof Error
            ? `Unexpected error during ${check.name} check: ${error.message}`
            : `Unknown error during ${check.name} check.`,
      };
    }
    const finished = deps.now();
    const elapsedMs = Math.max(0, finished - started);
    const timestamp = new Date(finished).toISOString();
    const status: "pass" | "fail" = outcome.ok ? "pass" : "fail";
    const failureCode = outcome.ok ? undefined : outcome.code ?? check.code;
    const record: PreflightTelemetryEntry = {
      code: buildTelemetryCode(check.name, status),
      check: check.name,
      status,
      detail: outcome.detail,
      metadata: outcome.metadata ?? {},
      elapsedMs,
      timestamp,
      action: outcome.action ?? (status === "fail" ? check.defaultAction : undefined),
      failureCode,
    };
    history.push(record);
    deps.log(record);
    if (!outcome.ok) {
      return {
        ok: false,
        history,
        failure: {
          code: failureCode ?? check.code,
          check: check.name,
          detail: record.detail,
          action: record.action ?? check.defaultAction,
        },
      };
    }
  }
  return { ok: true, history };
};
