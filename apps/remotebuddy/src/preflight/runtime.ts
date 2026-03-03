const TELEMETRY_PREFIX = "[RemoteBuddyPreflight]";
const PREFLIGHT_FAILURE_EXIT_CODE = 1;

export const PREFLIGHT_FAILURE_CODES = {
  BUN_VERSION_UNSUPPORTED: "preflight.runtime.bun_version",
  GIT_VERSION_UNSUPPORTED: "preflight.runtime.git_version",
  ENV_VARS_MISSING: "preflight.env.required_missing",
  CREDENTIALS_MISSING: "preflight.credentials.missing",
} as const;

export type PreflightFailureCode =
  (typeof PREFLIGHT_FAILURE_CODES)[keyof typeof PREFLIGHT_FAILURE_CODES];

type PreflightCheckStatus = "pass" | "fail";
type PreflightCheckCategory = "runtime" | "env" | "credentials";

export interface PreflightTelemetryEvent {
  event: "preflight_check";
  code: PreflightFailureCode;
  status: PreflightCheckStatus;
  category: PreflightCheckCategory;
  detail: string;
  action?: string;
  metadata?: Record<string, string>;
  elapsedMs: number;
}

export type PreflightTelemetryEmitter = (event: PreflightTelemetryEvent) => void;

type StructuredTelemetryLevel = "info" | "error";

export interface PreflightTelemetryLogOptions {
  now?: () => Date;
  prefix?: string;
  info?: (line: string) => void;
  error?: (line: string) => void;
}

export interface PreflightCheckRecord {
  code: PreflightFailureCode;
  label: string;
  category: PreflightCheckCategory;
  status: PreflightCheckStatus;
  detail: string;
  action?: string;
  elapsedMs: number;
  metadata?: Record<string, string>;
}

export interface PreflightFailure {
  code: PreflightFailureCode;
  category: PreflightCheckCategory;
  detail: string;
  action: string;
  exitCode: number;
}

export type RuntimePreflightResult =
  | {
      ok: true;
      history: PreflightCheckRecord[];
    }
  | {
      ok: false;
      failure: PreflightFailure;
      history: PreflightCheckRecord[];
    };

export interface RuntimePreflightOptions {
  env?: NodeJS.ProcessEnv;
  bunVersion?: string;
  detectGitVersion?: () => Promise<string | null>;
  emit?: PreflightTelemetryEmitter;
  now?: () => number;
}

interface RuntimePreflightContext {
  env: NodeJS.ProcessEnv;
  bunVersion: string;
  detectGitVersion: () => Promise<string | null>;
  emit: PreflightTelemetryEmitter;
  now: () => number;
}

interface PreflightCheckOutcome {
  ok: boolean;
  detail?: string;
  metadata?: Record<string, string>;
}

type PreflightCheckDefinition = {
  code: PreflightFailureCode;
  label: string;
  action: string;
  category: PreflightCheckCategory;
  run: (ctx: RuntimePreflightContext) => Promise<PreflightCheckOutcome>;
};

const MIN_BUN_VERSION = "1.1.0";
const MIN_GIT_VERSION = "2.40.0";

const REQUIRED_ENV_VARS: ReadonlyArray<{ name: string; label: string }> = [
  { name: "REMOTE_STABLE_ID", label: "RemoteBuddy stable session id" },
  { name: "WORKERPALS_API_URL", label: "WorkerPals API base URL" },
  { name: "SERVER_BASE_URL", label: "Server base URL" },
];

const CREDENTIAL_GROUPS: ReadonlyArray<{
  id: string;
  label: string;
  keys: readonly string[];
}> = [
  {
    id: "server_auth_token",
    label: "PushPals API bearer token (PUSHPALS_AUTH_TOKEN)",
    keys: ["PUSHPALS_AUTH_TOKEN"],
  },
  {
    id: "git_token",
    label: "Git automation token (PUSHPALS_GIT_TOKEN | GITHUB_TOKEN | GH_TOKEN)",
    keys: ["PUSHPALS_GIT_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"],
  },
];

const runtimeChecks: readonly PreflightCheckDefinition[] = [
  {
    code: PREFLIGHT_FAILURE_CODES.BUN_VERSION_UNSUPPORTED,
    label: `Bun runtime must be >= ${MIN_BUN_VERSION}.`,
    action:
      "Update Bun to 1.1.x+ (curl -fsSL https://bun.sh/install | bash) before launching RemoteBuddy.",
    category: "runtime",
    run: async (ctx) => {
      const observed = sanitizeVersion(ctx.bunVersion);
      if (!observed) {
        return {
          ok: false,
          detail: "Bun version detection failed; Bun.version returned an empty value.",
        };
      }
      if (!isVersionAtLeast(observed, MIN_BUN_VERSION)) {
        return {
          ok: false,
          detail: `Bun ${observed} is below required ${MIN_BUN_VERSION}.`,
          metadata: { observed, minimum: MIN_BUN_VERSION },
        };
      }
      return {
        ok: true,
        detail: `Bun ${observed} ≥ ${MIN_BUN_VERSION}.`,
        metadata: { observed, minimum: MIN_BUN_VERSION },
      };
    },
  },
  {
    code: PREFLIGHT_FAILURE_CODES.GIT_VERSION_UNSUPPORTED,
    label: `Git cli must be installed and >= ${MIN_GIT_VERSION}.`,
    action: "Install/upgrade git (brew install git / sudo apt-get install git) then retry.",
    category: "runtime",
    run: async (ctx) => {
      const detected = sanitizeVersion(await ctx.detectGitVersion());
      if (!detected) {
        return {
          ok: false,
          detail:
            "git --version did not return a parsable version; ensure git is installed in PATH.",
        };
      }
      if (!isVersionAtLeast(detected, MIN_GIT_VERSION)) {
        return {
          ok: false,
          detail: `Git ${detected} is below required ${MIN_GIT_VERSION}.`,
          metadata: { observed: detected, minimum: MIN_GIT_VERSION },
        };
      }
      return {
        ok: true,
        detail: `Git ${detected} ≥ ${MIN_GIT_VERSION}.`,
        metadata: { observed: detected, minimum: MIN_GIT_VERSION },
      };
    },
  },
  {
    code: PREFLIGHT_FAILURE_CODES.ENV_VARS_MISSING,
    label: "Required RemoteBuddy environment variables must be exported.",
    action:
      "Populate REMOTE_STABLE_ID, WORKERPALS_API_URL, and SERVER_BASE_URL in .env or the shell session before restarting.",
    category: "env",
    run: async (ctx) => {
      const missing = REQUIRED_ENV_VARS.filter((entry) => !hasValue(ctx.env[entry.name]));
      if (missing.length > 0) {
        return {
          ok: false,
          detail: `Missing required env vars: ${missing
            .map((entry) => entry.name)
            .join(", ")}.`,
          metadata: { missing: missing.map((entry) => entry.name).join(",") },
        };
      }
      return {
        ok: true,
        detail: `Env vars ready: ${REQUIRED_ENV_VARS.map((entry) => entry.name).join(", ")}.`,
      };
    },
  },
  {
    code: PREFLIGHT_FAILURE_CODES.CREDENTIALS_MISSING,
    label: "Server and git credentials must be configured.",
    action:
      "Export PUSHPALS_AUTH_TOKEN plus one git token (PUSHPALS_GIT_TOKEN/GITHUB_TOKEN/GH_TOKEN) so RemoteBuddy can authenticate before startup continues.",
    category: "credentials",
    run: async (ctx) => {
      const satisfied: string[] = [];
      const missing: string[] = [];
      for (const group of CREDENTIAL_GROUPS) {
        const match = group.keys.find((key) => hasValue(ctx.env[key]));
        if (match) {
          satisfied.push(`${group.id}:${match}`);
        } else {
          missing.push(group.id);
        }
      }
      if (missing.length > 0) {
        return {
          ok: false,
          detail: `Missing credential groups: ${missing.join(
            ", ",
          )}. Ensure the documented env vars are exported.`,
          metadata: {
            missing: missing.join(","),
            expected: CREDENTIAL_GROUPS.map((group) => `${group.id}=[${group.keys.join("|")}]`).join(
              ";",
            ),
          },
        };
      }
      return {
        ok: true,
        detail: `Credential sources ready (${satisfied.join(", ")}).`,
      };
    },
  },
];

export const runRuntimePreflight = async (
  options: RuntimePreflightOptions = {},
): Promise<RuntimePreflightResult> => {
  const ctx = buildRuntimePreflightContext(options);
  const history: PreflightCheckRecord[] = [];

  for (const check of runtimeChecks) {
    const started = ctx.now();
    let outcome: PreflightCheckOutcome;
    try {
      outcome = await check.run(ctx);
    } catch (error) {
      outcome = {
        ok: false,
        detail:
          error instanceof Error
            ? error.message
            : "Unknown error while running runtime preflight check.",
      };
    }
    const elapsedMs = Math.max(0, ctx.now() - started);
    const detail = outcome.detail ?? check.label;
    const status: PreflightCheckStatus = outcome.ok ? "pass" : "fail";
    const record: PreflightCheckRecord = {
      code: check.code,
      label: check.label,
      category: check.category,
      status,
      detail,
      action: status === "fail" ? check.action : undefined,
      elapsedMs,
      metadata: outcome.metadata,
    };
    history.push(record);
    ctx.emit({
      event: "preflight_check",
      code: check.code,
      status,
      category: check.category,
      detail,
      action: record.action,
      metadata: outcome.metadata,
      elapsedMs,
    });

    if (!outcome.ok) {
      return {
        ok: false,
        failure: {
          code: check.code,
          category: check.category,
          detail,
          action: check.action,
          exitCode: PREFLIGHT_FAILURE_EXIT_CODE,
        },
        history,
      };
    }
  }

  return { ok: true, history };
};

const buildRuntimePreflightContext = (
  options: RuntimePreflightOptions,
): RuntimePreflightContext => ({
  env: options.env ?? process.env,
  bunVersion: options.bunVersion ?? Bun.version,
  detectGitVersion: options.detectGitVersion ?? detectGitVersionDefault,
  emit: options.emit ?? defaultTelemetryEmitter,
  now: options.now ?? Date.now,
});

const printStructuredTelemetry = (
  payload: Record<string, unknown>,
  level: StructuredTelemetryLevel,
  options?: PreflightTelemetryLogOptions,
) => {
  const stamp = options?.now ? options.now() : new Date();
  const envelope = {
    ts: stamp.toISOString(),
    origin: "remotebuddy.preflight",
    ...payload,
  };
  const serialized = `${options?.prefix ?? TELEMETRY_PREFIX} ${JSON.stringify(envelope)}`;
  if (level === "error") {
    (options?.error ?? console.error)(serialized);
  } else {
    (options?.info ?? console.log)(serialized);
  }
};

const defaultTelemetryEmitter: PreflightTelemetryEmitter = (event) => {
  const level: StructuredTelemetryLevel = event.status === "fail" ? "error" : "info";
  printStructuredTelemetry(event, level);
};

interface StartupPreflightFailurePayload {
  event: "startup_preflight_failed";
  code: PreflightFailureCode;
  category: PreflightCheckCategory;
  detail: string;
  action: string;
  exitCode: number;
  checksCompleted: number;
  lastCheck?: {
    code: PreflightFailureCode;
    category: PreflightCheckCategory;
    status: PreflightCheckStatus;
    detail: string;
    elapsedMs: number;
  };
}

export const logStartupPreflightFailure = (
  failure: PreflightFailure,
  history: PreflightCheckRecord[],
  options?: PreflightTelemetryLogOptions,
): void => {
  const lastRecord = history.length > 0 ? history[history.length - 1] : undefined;
  const payload: StartupPreflightFailurePayload = {
    event: "startup_preflight_failed",
    code: failure.code,
    category: failure.category,
    detail: failure.detail,
    action: failure.action,
    exitCode: failure.exitCode,
    checksCompleted: history.length,
    lastCheck: lastRecord
      ? {
          code: lastRecord.code,
          category: lastRecord.category,
          status: lastRecord.status,
          detail: lastRecord.detail,
          elapsedMs: lastRecord.elapsedMs,
        }
      : undefined,
  };
  printStructuredTelemetry(payload, "error", options);
};

const sanitizeVersion = (value: string | null | undefined): string =>
  String(value ?? "").trim();

const hasValue = (value: string | undefined): boolean => sanitizeVersion(value).length > 0;

const parseVersionParts = (value: string): [number, number, number] => {
  const parts = sanitizeVersion(value).split(".");
  const normalized = parts
    .map((token) => {
      const parsed = Number.parseInt(token, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    })
    .slice(0, 3);
  while (normalized.length < 3) {
    normalized.push(0);
  }
  return [normalized[0], normalized[1], normalized[2]];
};

const isVersionAtLeast = (observed: string, minimum: string): boolean => {
  const [oMajor, oMinor, oPatch] = parseVersionParts(observed);
  const [mMajor, mMinor, mPatch] = parseVersionParts(minimum);
  if (oMajor !== mMajor) return oMajor > mMajor;
  if (oMinor !== mMinor) return oMinor > mMinor;
  return oPatch >= mPatch;
};

const detectGitVersionDefault = async (): Promise<string | null> => {
  try {
    const proc = Bun.spawn(["git", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, _stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return null;
    }
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
};
