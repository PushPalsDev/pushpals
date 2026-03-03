import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join, relative, resolve, isAbsolute } from "node:path";

import { detectRepoRoot, loadPushPalsConfig } from "shared";

const DEFAULT_CONFIG_REL_PATHS = [
  "configs/default.toml",
  "configs/local.toml",
] as const;
const SYSTEM_STATUS_TIMEOUT_MS = 3_000;
const MAX_PENDING_REQUESTS = 15;
const MIN_IDLE_WORKERS = 1;
const DETERMINISTIC_TIMESTAMP = "1970-01-01T00:00:00.000Z";

type TelemetryMode = "observable" | "deterministic";

const normalizeTelemetryMode = (value?: string | null): TelemetryMode | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "deterministic") return "deterministic";
  if (normalized === "observable") return "observable";
  return null;
};

const createDeterministicClock = (): (() => number) => {
  let tick = 0;
  return () => {
    const current = tick;
    tick += 1;
    return current;
  };
};

const buildTimingProviders = (
  telemetryMode: TelemetryMode,
  overrides?: {
    clock?: () => number;
    timestampProvider?: () => string;
  },
): { clock: () => number; timestamp: () => string } => {
  const clock =
    overrides?.clock ??
    (telemetryMode === "deterministic" ? createDeterministicClock() : () => Date.now());
  const timestamp =
    overrides?.timestampProvider ??
    (telemetryMode === "deterministic"
      ? () => DETERMINISTIC_TIMESTAMP
      : () => new Date().toISOString());
  return { clock, timestamp };
};

export const REMOTEBUDDY_PREFLIGHT_FAILURE_CODES = {
  CONFIG_MISSING: "remotebuddy.config_missing",
  CONFIG_INVALID: "remotebuddy.config_invalid",
  SECRETS_MISSING: "remotebuddy.secrets_missing",
  MERGE_IN_PROGRESS: "remotebuddy.merge_in_progress",
  WORKSPACE_DIRTY: "remotebuddy.workspace_dirty",
  SERVER_UNREACHABLE: "remotebuddy.server_unreachable",
  WORKERPALS_CAPACITY: "remotebuddy.workerpals_capacity_blocked",
} as const;

export type RemoteBuddyPreflightFailureCode =
  (typeof REMOTEBUDDY_PREFLIGHT_FAILURE_CODES)[keyof typeof REMOTEBUDDY_PREFLIGHT_FAILURE_CODES];

export type RemoteBuddyPreflightCategory =
  | "config"
  | "secrets"
  | "workspace"
  | "dependencies";

type PreflightCheckStatus = "pass" | "fail";

export interface RemoteBuddyPreflightRecord {
  code: RemoteBuddyPreflightFailureCode;
  label: string;
  category: RemoteBuddyPreflightCategory;
  step: number;
  status: PreflightCheckStatus;
  detail: string;
  action?: string;
  elapsedMs: number;
  timestamp: string;
}

export interface RemoteBuddyPreflightFailure {
  code: RemoteBuddyPreflightFailureCode;
  detail: string;
  action: string;
  category: RemoteBuddyPreflightCategory;
  step: number;
}

export interface RemoteBuddyPreflightResult {
  ok: boolean;
  failure?: RemoteBuddyPreflightFailure;
  records: RemoteBuddyPreflightRecord[];
}

export interface RemoteBuddyPreflightConfigSnapshot {
  authToken: string | null;
  serverUrl: string;
  projectRoot: string;
  allowDirtyWorktree: boolean;
}

interface ConfigProbeResult {
  missing: string[];
  empty: string[];
}

interface WorkspaceStatus {
  isDirty: boolean;
  dirtyFiles: string[];
  mergeInProgress: boolean;
  detail: string;
}

interface SystemStatusProbeResult {
  ok: boolean;
  detail?: string;
  latencyMs: number;
  idleWorkers?: number;
  pendingRequests?: number;
}

type ConfigProbe = (input: {
  repoRoot: string;
  configPaths: readonly string[];
}) => Promise<ConfigProbeResult>;

type WorkspaceProbe = (input: { repoRoot: string }) => Promise<WorkspaceStatus>;

type SystemStatusProbe = (input: {
  config: RemoteBuddyPreflightConfigSnapshot;
}) => Promise<SystemStatusProbeResult>;

export interface RemoteBuddyPreflightOptions {
  repoRoot?: string;
  requiredConfigFiles?: readonly string[];
  reporter?: (record: RemoteBuddyPreflightRecord) => void;
  allowDirtyWorktree?: boolean;
  allowMissingAuthToken?: boolean;
  config?: RemoteBuddyPreflightConfigSnapshot;
  loadConfigSnapshot?: () => RemoteBuddyPreflightConfigSnapshot;
  telemetryMode?: TelemetryMode;
  clock?: () => number;
  timestampProvider?: () => string;
  probes?: Partial<{
    config: ConfigProbe;
    workspace: WorkspaceProbe;
    systemStatus: SystemStatusProbe;
  }>;
}

interface PreflightCheckDefinition {
  code: RemoteBuddyPreflightFailureCode;
  label: string;
  category: RemoteBuddyPreflightCategory;
  action: string;
  run: () => Promise<{ ok: boolean; detail?: string }>;
}


const summarizeList = (values: string[], limit = 5): string => {
  if (values.length === 0) return "none";
  if (values.length <= limit) return values.join(", ");
  return `${values.slice(0, limit).join(", ")} +${values.length - limit} more`;
};

const captureConfigSnapshot = (
  config: RemoteBuddyPreflightConfigSnapshot | null,
): RemoteBuddyPreflightConfigSnapshot => {
  if (config) return config;
  const loaded = loadPushPalsConfig();
  return {
    authToken: loaded.authToken,
    serverUrl: loaded.server.url,
    projectRoot: loaded.projectRoot,
    allowDirtyWorktree: Boolean(loaded.remotebuddy.autonomy.allowDirtyWorktree),
  };
};

const defaultConfigProbe: ConfigProbe = async ({ repoRoot, configPaths }) => {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const relPath of configPaths) {
    const absPath = isAbsolute(relPath) ? relPath : resolve(repoRoot, relPath);
    try {
      const info = await stat(absPath);
      if (info.size <= 0) {
        empty.push(relative(repoRoot, absPath));
      }
    } catch {
      missing.push(relative(repoRoot, absPath));
    }
  }
  return { missing, empty };
};

const defaultWorkspaceProbe: WorkspaceProbe = async ({ repoRoot }) => {
  const runGit = (args: string[]): string => {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", repoRoot, ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      const stderr = Buffer.from(result.stderr ?? []).toString("utf8").trim();
      throw new Error(`git ${args.join(" ")} failed: ${stderr || `exit ${result.exitCode}`}`);
    }
    return Buffer.from(result.stdout ?? []).toString("utf8");
  };

  const statusRaw = runGit(["status", "--porcelain"]);
  const dirtyEntries = statusRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const gitDirOutput = runGit(["rev-parse", "--git-dir"]).trim();
  const gitDir = isAbsolute(gitDirOutput)
    ? gitDirOutput
    : resolve(repoRoot, gitDirOutput || ".git");
  const mergeMarkers = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"];
  const mergeInProgress = mergeMarkers.some((marker) =>
    existsSync(join(gitDir, marker)),
  );
  return {
    mergeInProgress,
    isDirty: dirtyEntries.length > 0,
    dirtyFiles: dirtyEntries,
    detail: dirtyEntries.length === 0 ? "Worktree clean" : `Dirty files: ${summarizeList(dirtyEntries)}`,
  };
};

const createDefaultSystemStatusProbe = (
  telemetryMode: TelemetryMode,
): SystemStatusProbe => {
  return async ({ config }) => {
    const serverBase = config.serverUrl.replace(/\/+$/, "");
    const url = `${serverBase}/system/status`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYSTEM_STATUS_TIMEOUT_MS);
    const started = performance.now();
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.authToken) {
        headers.Authorization = `Bearer ${config.authToken}`;
      }
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      const latencyMs = Math.round(performance.now() - started);
      if (!response.ok) {
        return { ok: false, detail: `HTTP ${response.status}`, latencyMs };
      }
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const idleWorkers =
        typeof (body as any)?.workers?.idle === "number"
          ? (body as any).workers.idle
          : undefined;
      const pendingRequests =
        typeof (body as any)?.queues?.requests?.pending === "number"
          ? (body as any).queues.requests.pending
          : undefined;
      const ok = body?.ok !== false;
      return {
        ok,
        detail:
          telemetryMode === "deterministic"
            ? "system/status responded"
            : `system/status responded in ${latencyMs} ms`,
        latencyMs,
        idleWorkers: typeof idleWorkers === "number" ? idleWorkers : undefined,
        pendingRequests,
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, detail, latencyMs };
    } finally {
      clearTimeout(timeout);
    }
  };
};

const ensureRepoRoot = (override?: string): string => {
  if (override) return override;
  return detectRepoRoot(process.cwd());
};

export const runRemoteBuddyPreflight = async (
  options: RemoteBuddyPreflightOptions = {},
): Promise<RemoteBuddyPreflightResult> => {
  const records: RemoteBuddyPreflightRecord[] = [];
  const reporter = options.reporter ?? (() => {});
  let failure: RemoteBuddyPreflightFailure | undefined;
  let step = 0;
  const telemetryMode = options.telemetryMode ?? "observable";
  const { clock, timestamp } = buildTimingProviders(telemetryMode, {
    clock: options.clock,
    timestampProvider: options.timestampProvider,
  });

  const repoRoot = ensureRepoRoot(options.repoRoot);
  const configProbe = options.probes?.config ?? defaultConfigProbe;
  const workspaceProbe = options.probes?.workspace ?? defaultWorkspaceProbe;
  const systemStatusProbe =
    options.probes?.systemStatus ?? createDefaultSystemStatusProbe(telemetryMode);

  const configPaths = (options.requiredConfigFiles?.length
    ? options.requiredConfigFiles
    : DEFAULT_CONFIG_REL_PATHS
  ).map((relPath) => (isAbsolute(relPath) ? relPath : resolve(repoRoot, relPath)));

  const recordCheck = async (
    definition: PreflightCheckDefinition,
  ): Promise<boolean> => {
    step += 1;
    const started = clock();
    let detail = definition.label;
    let status: PreflightCheckStatus = "fail";
    try {
      const outcome = await definition.run();
      status = outcome.ok ? "pass" : "fail";
      detail = outcome.detail ?? definition.label;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err ?? "Unknown error");
      status = "fail";
    }
    const record: RemoteBuddyPreflightRecord = {
      code: definition.code,
      label: definition.label,
      category: definition.category,
      step,
      status,
      detail,
      action: status === "fail" ? definition.action : undefined,
      elapsedMs: Math.max(0, clock() - started),
      timestamp: timestamp(),
    };
    reporter(record);
    records.push(record);
    if (status === "fail") {
      failure = {
        code: definition.code,
        detail,
        action: definition.action,
        category: definition.category,
        step,
      };
      return false;
    }
    return true;
  };

  const configSnapshotProvider = (): RemoteBuddyPreflightConfigSnapshot => {
    if (options.config) return options.config;
    if (options.loadConfigSnapshot) return options.loadConfigSnapshot();
    return captureConfigSnapshot(null);
  };

  let configSnapshot: RemoteBuddyPreflightConfigSnapshot | undefined;
  let workspaceStatusPromise: Promise<WorkspaceStatus> | undefined;
  let systemStatusPromise: Promise<SystemStatusProbeResult> | undefined;

  const getWorkspaceStatus = () => {
    if (!workspaceStatusPromise) {
      workspaceStatusPromise = workspaceProbe({ repoRoot });
    }
    return workspaceStatusPromise;
  };

  const getSystemStatus = (config: RemoteBuddyPreflightConfigSnapshot) => {
    if (!systemStatusPromise) {
      systemStatusPromise = systemStatusProbe({ config });
    }
    return systemStatusPromise;
  };

  const allowMissingAuthToken = options.allowMissingAuthToken ?? false;

  const checks: PreflightCheckDefinition[] = [
    {
      code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.CONFIG_MISSING,
      label: "Required config files exist and are readable.",
      category: "config",
      action: "Copy configs/local.example.toml to configs/local.toml and re-run preflight.",
      run: async () => {
        const result = await configProbe({ repoRoot, configPaths });
        if (result.missing.length === 0 && result.empty.length === 0) {
          return {
            ok: true,
            detail: `Found ${configPaths.length} config files (${configPaths
              .map((p) => relative(repoRoot, p))
              .join(", ")}).`,
          };
        }
        const messages: string[] = [];
        if (result.missing.length > 0) {
          messages.push(`Missing: ${summarizeList(result.missing)}`);
        }
        if (result.empty.length > 0) {
          messages.push(`Empty: ${summarizeList(result.empty)}`);
        }
        return { ok: false, detail: messages.join("; ") };
      },
    },
    {
      code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.CONFIG_INVALID,
      label: "Config files parse and load successfully.",
      category: "config",
      action: "Fix TOML or env syntax so loadPushPalsConfig succeeds.",
      run: async () => {
        try {
          configSnapshot = configSnapshotProvider();
          return {
            ok: true,
            detail: `Loaded config for server ${configSnapshot.serverUrl}.`,
          };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { ok: false, detail };
        }
      },
    },
    {
      code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.SECRETS_MISSING,
      label: "Server auth token is configured.",
      category: "secrets",
      action: "Export PUSHPALS_AUTH_TOKEN in .env or shell, then rerun preflight.",
      run: async () => {
        if (!configSnapshot) {
          return { ok: false, detail: "Config snapshot unavailable." };
        }
        if (!configSnapshot.authToken && !allowMissingAuthToken) {
          return {
            ok: false,
            detail: "PUSHPALS_AUTH_TOKEN missing (set allowMissingAuthToken to bypass).",
          };
        }
        return {
          ok: true,
          detail: configSnapshot.authToken
            ? "Auth token present."
            : "Auth token intentionally missing (bypass flag set).",
        };
      },
    },
    {
      code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.MERGE_IN_PROGRESS,
      label: "No merge/rebase is in progress.",
      category: "workspace",
      action: "Resolve or abort the in-progress git merge/rebase before launching RemoteBuddy.",
      run: async () => {
        const status = await getWorkspaceStatus();
        if (status.mergeInProgress) {
          return { ok: false, detail: "Merge or rebase detected in repo." };
        }
        return { ok: true, detail: "No merge or rebase in progress." };
      },
    },
    {
      code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.WORKSPACE_DIRTY,
      label: "Worktree is clean or bypass is allowed.",
      category: "workspace",
      action:
        "Commit, stash, or drop local changes (or rerun with --allow-dirty for intentional overrides).",
      run: async () => {
        const status = await getWorkspaceStatus();
        const allowDirtyWorktree =
          options.allowDirtyWorktree ?? configSnapshot?.allowDirtyWorktree ?? false;
        if (!status.isDirty) {
          return { ok: true, detail: status.detail };
        }
        if (allowDirtyWorktree) {
          return {
            ok: true,
            detail: `Dirty worktree bypassed via allowDirtyWorktree (files=${summarizeList(status.dirtyFiles)}).`,
          };
        }
        return {
          ok: false,
          detail: `Dirty worktree detected: ${summarizeList(status.dirtyFiles)}.`,
        };
      },
    },
    {
      code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.SERVER_UNREACHABLE,
      label: "Server /system/status responds within latency budget.",
      category: "dependencies",
      action: "Start the Server process (`bun run server:only`) and ensure auth token matches before retrying.",
      run: async () => {
        if (!configSnapshot) {
          return { ok: false, detail: "Config snapshot unavailable." };
        }
        const status = await getSystemStatus(configSnapshot);
        if (!status.ok) {
          return { ok: false, detail: status.detail ?? "Server unreachable." };
        }
        return { ok: true, detail: status.detail ?? "Server healthy." };
      },
    },
    {
      code: REMOTEBUDDY_PREFLIGHT_FAILURE_CODES.WORKERPALS_CAPACITY,
      label: "WorkerPals capacity is sufficient before startup.",
      category: "dependencies",
      action: "Launch or scale WorkerPals lanes until idle slots ≥ 1 and queues.pending ≤ 15, then rerun preflight.",
      run: async () => {
        if (!configSnapshot) {
          return { ok: false, detail: "Config snapshot unavailable." };
        }
        const status = await getSystemStatus(configSnapshot);
        if (!status.ok) {
          return { ok: false, detail: status.detail ?? "Server unreachable." };
        }
        if (typeof status.idleWorkers !== "number") {
          return { ok: false, detail: "system/status missing workers.idle value." };
        }
        if (status.idleWorkers < MIN_IDLE_WORKERS) {
          return {
            ok: false,
            detail: `Idle worker slots ${status.idleWorkers} < ${MIN_IDLE_WORKERS}.`,
          };
        }
        if (typeof status.pendingRequests !== "number") {
          return {
            ok: false,
            detail: "system/status missing queues.requests.pending value.",
          };
        }
        if (status.pendingRequests > MAX_PENDING_REQUESTS) {
          return {
            ok: false,
            detail: `Pending requests ${status.pendingRequests} exceeds ${MAX_PENDING_REQUESTS}.`,
          };
        }
        return {
          ok: true,
          detail: `Idle workers=${status.idleWorkers}, pending requests=${status.pendingRequests}.`,
        };
      },
    },
  ];

  for (const check of checks) {
    const ok = await recordCheck(check);
    if (!ok) {
      return { ok: false, failure, records };
    }
  }

  return { ok: true, records };
};

export const ensureRemoteBuddyPreflight = async (
  options: RemoteBuddyPreflightOptions = {},
): Promise<void> => {
  const result = await runRemoteBuddyPreflight({
    ...options,
    reporter:
      options.reporter ??
      ((record) => {
        const status = record.status === "pass" ? "PASS" : "FAIL";
        console.log(
          `[remotebuddy:preflight] step=${record.step} code=${record.code} status=${status} detail=${record.detail}`,
        );
      }),
  });
  if (!result.ok && result.failure) {
    throw new Error(
      `RemoteBuddy preflight failed (${result.failure.code}): ${result.failure.detail}. Action: ${result.failure.action}`,
    );
  }
};

const CLI_USAGE =
  "Usage: bun run preflight [--json] [--allow-dirty] [--allow-missing-auth] [--telemetry=observable|deterministic]";

interface ParsedCliArgs {
  jsonOnly: boolean;
  allowDirty: boolean;
  allowMissingAuth: boolean;
  helpRequested: boolean;
  telemetryMode?: TelemetryMode;
  error?: string;
}

const parseCliArgs = (argv: string[]): ParsedCliArgs => {
  const args: ParsedCliArgs = {
    jsonOnly: false,
    allowDirty: false,
    allowMissingAuth: false,
    helpRequested: false,
  };
  for (const raw of argv) {
    const arg = raw.trim();
    if (!arg) continue;
    if (args.error || args.helpRequested) break;
    if (arg === "--json") {
      args.jsonOnly = true;
    } else if (arg === "--allow-dirty") {
      args.allowDirty = true;
    } else if (arg === "--allow-missing-auth") {
      args.allowMissingAuth = true;
    } else if (arg === "--help" || arg === "-h") {
      args.helpRequested = true;
    } else if (arg.startsWith("--telemetry=")) {
      const candidate = normalizeTelemetryMode(arg.split("=", 2)[1]);
      if (!candidate) {
        args.error = `Unknown telemetry mode: ${arg.split("=", 2)[1] ?? ""}`;
      } else {
        args.telemetryMode = candidate;
      }
    } else if (arg === "--deterministic") {
      args.telemetryMode = "deterministic";
    } else if (arg === "--observable") {
      args.telemetryMode = "observable";
    } else {
      args.error = `Unknown flag: ${arg}`;
    }
  }
  return args;
};

const resolveCliTelemetryMode = (input: {
  explicit?: TelemetryMode;
  env?: Record<string, string | undefined>;
  preferDeterministic: boolean;
}): TelemetryMode => {
  if (input.explicit) return input.explicit;
  const envMode = normalizeTelemetryMode(input.env?.REMOTEBUDDY_TELEMETRY_MODE);
  if (envMode) return envMode;
  if (input.preferDeterministic) return "deterministic";
  return "observable";
};

type CliConsole = Pick<typeof console, "log" | "error">;

const createCliReporter = (options: {
  console: CliConsole;
  jsonOnly: boolean;
}): {
  record: (record: RemoteBuddyPreflightRecord) => void;
  complete: (result: RemoteBuddyPreflightResult, elapsedMs: number) => void;
} => {
  return {
    record: (record) => {
      options.console.log(JSON.stringify(record));
      if (!options.jsonOnly) {
        const status = record.status === "pass" ? "PASS" : "FAIL";
        options.console.error(
          `[preflight] ${status} ${record.code} – ${record.detail} (step ${record.step})`,
        );
      }
    },
    complete: (result, elapsedMs) => {
      if (options.jsonOnly) return;
      if (result.ok) {
        options.console.error(`RemoteBuddy preflight passed in ${elapsedMs} ms.`);
        return;
      }
      if (result.failure) {
        options.console.error(
          `RemoteBuddy preflight failed (${result.failure.code}) after ${elapsedMs} ms: ${result.failure.detail}.`,
        );
        options.console.error(`Action: ${result.failure.action}`);
      } else {
        options.console.error("RemoteBuddy preflight failed without failure payload.");
      }
    },
  };
};

export interface RemoteBuddyPreflightCliCommandOptions {
  argv?: string[];
  deps?: {
    console?: CliConsole;
    env?: Record<string, string | undefined>;
    runPreflight?: (
      options: RemoteBuddyPreflightOptions,
    ) => Promise<RemoteBuddyPreflightResult>;
    clock?: () => number;
    timestampProvider?: () => string;
  };
}

export interface RemoteBuddyPreflightCliCommandResult {
  exitCode: number;
}

export const runRemoteBuddyPreflightCliCommand = async (
  options: RemoteBuddyPreflightCliCommandOptions = {},
): Promise<RemoteBuddyPreflightCliCommandResult> => {
  const argv = options.argv ?? process.argv.slice(2);
  const deps = options.deps ?? {};
  const consoleRef = deps.console ?? console;
  const env = deps.env ?? (typeof process !== "undefined" ? process.env : {});
  const runPreflightImpl = deps.runPreflight ?? runRemoteBuddyPreflight;
  const parsed = parseCliArgs(argv);

  if (parsed.error) {
    consoleRef.error(parsed.error);
    consoleRef.error(CLI_USAGE);
    return { exitCode: 1 };
  }
  if (parsed.helpRequested) {
    consoleRef.log(CLI_USAGE);
    return { exitCode: 0 };
  }

  const telemetryMode = resolveCliTelemetryMode({
    explicit: parsed.telemetryMode,
    env,
    preferDeterministic: parsed.jsonOnly,
  });
  const { clock, timestamp } = buildTimingProviders(telemetryMode, {
    clock: deps.clock,
    timestampProvider: deps.timestampProvider,
  });
  const reporter = createCliReporter({
    console: consoleRef,
    jsonOnly: parsed.jsonOnly,
  });
  const started = clock();
  const result = await runPreflightImpl({
    allowDirtyWorktree: parsed.allowDirty,
    allowMissingAuthToken: parsed.allowMissingAuth,
    reporter: reporter.record,
    telemetryMode,
    clock,
    timestampProvider: timestamp,
  });
  const elapsed = Math.max(0, clock() - started);
  reporter.complete(result, elapsed);
  return { exitCode: result.ok ? 0 : 1 };
};

export const runRemoteBuddyPreflightCli = async (
  argv = process.argv.slice(2),
): Promise<void> => {
  const { exitCode } = await runRemoteBuddyPreflightCliCommand({ argv });
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
};

if (import.meta.main) {
  runRemoteBuddyPreflightCli().catch((error) => {
    console.error(`RemoteBuddy preflight crashed: ${String(error)}`);
    process.exit(1);
  });
}
