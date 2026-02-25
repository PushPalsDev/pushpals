import { randomUUID } from "crypto";
import { detectRepoRoot } from "./repo.js";
import { loadPushPalsConfig, type PushPalsConfig } from "./config.js";
import { parseDockerTimeoutMs } from "./timeout_policy.js";

type FlagSpecKey<T extends string> = {
  property: T;
  takesValue: boolean;
  allowEmpty?: boolean;
};

type FlagSpecMap<T extends string> = Record<string, FlagSpecKey<T>>;

export class RuntimeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeCliError";
  }
}

function parseCliArgs<T extends string>(
  argv: string[],
  specs: FlagSpecMap<T>,
): Partial<Record<T, string | boolean>> {
  const values: Partial<Record<T, string | boolean>> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (!arg.startsWith("--")) {
      throw new RuntimeCliError(`Unexpected positional argument \"${arg}\"`);
    }
    if (arg.includes("=")) {
      throw new RuntimeCliError(
        `Unsupported flag form \"${arg}\". Use space-separated values (e.g., \"--flag value\").`,
      );
    }
    const name = arg.slice(2);
    const spec = specs[name];
    if (!spec) {
      throw new RuntimeCliError(`Unknown flag \"${arg}\"`);
    }
    if (!spec.takesValue) {
      values[spec.property] = true;
      continue;
    }
    const next = argv[++i];
    if (next == null) {
      throw new RuntimeCliError(`Flag \"${arg}\" requires a value`);
    }
    const trimmed = next.trim();
    if (!spec.allowEmpty && !trimmed) {
      throw new RuntimeCliError(`Flag \"${arg}\" cannot be blank`);
    }
    values[spec.property] = trimmed;
  }
  return values;
}

function normalizeLabels(input: string | boolean | undefined, fallback: string[]): string[] {
  if (typeof input !== "string") return [...fallback];
  const labels = input
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  return labels.length > 0 ? labels : [...fallback];
}

function normalizeOptionalToken(
  raw: string | boolean | undefined,
  fallback: string | null,
): string | null {
  if (typeof raw !== "string") return fallback ?? null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function normalizePositiveInt(value: string | boolean | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export interface WorkerRuntimeDefaults {
  serverUrl: string;
  pollMs: number;
  heartbeatMs: number;
  repo: string;
  authToken: string | null;
  requireDocker: boolean;
  dockerImage: string;
  gitToken: string | null;
  dockerTimeoutMs: number;
  dockerIdleTimeoutMs: number;
  dockerNetworkMode: string;
  worktreeBaseRef: string;
  labels: string[];
  failureCooldownMs: number;
}

export interface WorkerRuntimeOptions {
  server: string;
  pollMs: number;
  heartbeatMs: number;
  repo: string;
  workerId: string;
  authToken: string | null;
  docker: boolean;
  requireDocker: boolean;
  dockerImage: string;
  gitToken: string | null;
  dockerTimeout: number;
  dockerIdleTimeout: number;
  dockerNetworkMode: string;
  worktreeBaseRef: string;
  labels: string[];
  failureCooldownMs: number;
}

const workerFlagSpecs: FlagSpecMap<
  | "server"
  | "poll"
  | "heartbeat"
  | "repo"
  | "workerId"
  | "authToken"
  | "docker"
  | "requireDocker"
  | "dockerImage"
  | "gitToken"
  | "dockerTimeout"
  | "dockerIdleTimeout"
  | "dockerNetworkMode"
  | "worktreeBaseRef"
  | "labels"
  | "failureCooldownMs"
> = {
  server: { property: "server", takesValue: true },
  poll: { property: "poll", takesValue: true },
  heartbeat: { property: "heartbeat", takesValue: true },
  repo: { property: "repo", takesValue: true },
  workerId: { property: "workerId", takesValue: true },
  token: { property: "authToken", takesValue: true },
  docker: { property: "docker", takesValue: false },
  "require-docker": { property: "requireDocker", takesValue: false },
  "docker-image": { property: "dockerImage", takesValue: true },
  "git-token": { property: "gitToken", takesValue: true },
  "docker-timeout": { property: "dockerTimeout", takesValue: true },
  "docker-idle-timeout": { property: "dockerIdleTimeout", takesValue: true },
  "docker-network": { property: "dockerNetworkMode", takesValue: true },
  "base-ref": { property: "worktreeBaseRef", takesValue: true },
  labels: { property: "labels", takesValue: true },
  "failure-cooldown-ms": { property: "failureCooldownMs", takesValue: true },
};

export function resolveWorkerRuntimeDefaults(
  config: PushPalsConfig = loadPushPalsConfig(),
  overrides: Partial<WorkerRuntimeDefaults> = {},
): WorkerRuntimeDefaults {
  return {
    serverUrl: overrides.serverUrl ?? config.server.url,
    pollMs: overrides.pollMs ?? config.workerpals.pollMs,
    heartbeatMs: overrides.heartbeatMs ?? config.workerpals.heartbeatMs,
    repo: overrides.repo ?? detectRepoRoot(process.cwd()),
    authToken: overrides.authToken ?? config.authToken,
    requireDocker: overrides.requireDocker ?? config.workerpals.requireDocker,
    dockerImage: overrides.dockerImage ?? config.workerpals.dockerImage,
    gitToken: overrides.gitToken ?? config.gitToken,
    dockerTimeoutMs: overrides.dockerTimeoutMs ?? config.workerpals.dockerTimeoutMs,
    dockerIdleTimeoutMs:
      overrides.dockerIdleTimeoutMs ?? config.workerpals.dockerIdleTimeoutMs,
    dockerNetworkMode: overrides.dockerNetworkMode ?? config.workerpals.dockerNetworkMode,
    worktreeBaseRef: overrides.worktreeBaseRef ?? config.workerpals.baseRef,
    labels: overrides.labels ?? [...config.workerpals.labels],
    failureCooldownMs: overrides.failureCooldownMs ?? config.workerpals.failureCooldownMs,
  };
}

export function loadWorkerRuntimeOptions(
  argv: string[],
  defaults: WorkerRuntimeDefaults = resolveWorkerRuntimeDefaults(),
): WorkerRuntimeOptions {
  const overrides = parseCliArgs(argv, workerFlagSpecs);
  const server = (overrides.server as string | undefined) ?? defaults.serverUrl;
  if (!server.trim()) {
    throw new RuntimeCliError("Server URL cannot be empty");
  }

  const pollOverride = normalizePositiveInt(overrides.poll);
  const pollMs =
    pollOverride && pollOverride > 0 ? pollOverride : Math.max(200, defaults.pollMs);

  const heartbeatOverride = normalizePositiveInt(overrides.heartbeat);
  const heartbeatMs =
    heartbeatOverride && heartbeatOverride > 0 ? heartbeatOverride : Math.max(200, pollMs);

  const repo = overrides.repo ? detectRepoRoot(overrides.repo as string) : defaults.repo;
  const workerId =
    (overrides.workerId as string | undefined)?.trim() || `workerpal-${randomUUID().slice(0, 8)}`;

  const authToken = normalizeOptionalToken(overrides.authToken, defaults.authToken);
  const gitToken = normalizeOptionalToken(overrides.gitToken, defaults.gitToken);
  const docker = overrides.docker === true;
  const requireDocker = defaults.requireDocker || overrides.requireDocker === true;
  const dockerImage = (overrides.dockerImage as string | undefined) ?? defaults.dockerImage;
  if (!dockerImage.trim()) {
    throw new RuntimeCliError("Docker image cannot be empty");
  }

  const dockerTimeout =
    typeof overrides.dockerTimeout === "string"
      ? parseDockerTimeoutMs(overrides.dockerTimeout)
      : Math.max(10_000, defaults.dockerTimeoutMs);

  const dockerIdleOverride = normalizePositiveInt(overrides.dockerIdleTimeout);
  const dockerIdleTimeout =
    dockerIdleOverride != null && dockerIdleOverride >= 0
      ? dockerIdleOverride
      : Math.max(0, defaults.dockerIdleTimeoutMs);

  const dockerNetworkMode =
    (overrides.dockerNetworkMode as string | undefined) ?? defaults.dockerNetworkMode;

  const worktreeBaseRef =
    (overrides.worktreeBaseRef as string | undefined) ?? defaults.worktreeBaseRef;

  const labels = normalizeLabels(overrides.labels, defaults.labels);

  const failureCooldownOverride = normalizePositiveInt(overrides.failureCooldownMs);
  const failureCooldownMs = (() => {
    if (failureCooldownOverride == null || failureCooldownOverride < 0)
      return Math.max(0, defaults.failureCooldownMs);
    return Math.min(failureCooldownOverride, 300_000);
  })();

  return {
    server: server.trim(),
    pollMs,
    heartbeatMs,
    repo,
    workerId,
    authToken,
    docker,
    requireDocker,
    dockerImage,
    gitToken,
    dockerTimeout,
    dockerIdleTimeout,
    dockerNetworkMode,
    worktreeBaseRef,
    labels,
    failureCooldownMs,
  };
}

export interface RemoteBuddyRuntimeDefaults {
  serverUrl: string;
  sessionId: string | null;
  authToken: string | null;
}

export interface RemoteBuddyRuntimeOptions {
  server: string;
  sessionId: string | null;
  authToken: string | null;
}

const remoteFlagSpecs: FlagSpecMap<"server" | "sessionId" | "authToken"> = {
  server: { property: "server", takesValue: true },
  sessionId: { property: "sessionId", takesValue: true },
  token: { property: "authToken", takesValue: true },
};

export function resolveRemoteBuddyRuntimeDefaults(
  config: PushPalsConfig = loadPushPalsConfig(),
): RemoteBuddyRuntimeDefaults {
  return {
    serverUrl: config.server.url,
    sessionId: config.sessionId || null,
    authToken: config.authToken,
  };
}

export function loadRemoteBuddyRuntimeOptions(
  argv: string[],
  defaults: RemoteBuddyRuntimeDefaults = resolveRemoteBuddyRuntimeDefaults(),
): RemoteBuddyRuntimeOptions {
  const overrides = parseCliArgs(argv, remoteFlagSpecs);
  const server = (overrides.server as string | undefined) ?? defaults.serverUrl;
  if (!server.trim()) throw new RuntimeCliError("Server URL cannot be empty");
  const sessionId = (overrides.sessionId as string | undefined) ?? defaults.sessionId;
  const authToken = normalizeOptionalToken(overrides.authToken, defaults.authToken);
  return {
    server: server.trim(),
    sessionId: sessionId?.trim() || null,
    authToken,
  };
}

export interface LocalBuddyRuntimeDefaults {
  serverUrl: string;
  port: number;
  sessionId: string;
  authToken: string | null;
}

export interface LocalBuddyRuntimeOptions {
  server: string;
  port: number;
  sessionId: string;
  authToken: string | null;
}

const localFlagSpecs: FlagSpecMap<"server" | "port" | "sessionId" | "authToken"> = {
  server: { property: "server", takesValue: true },
  port: { property: "port", takesValue: true },
  sessionId: { property: "sessionId", takesValue: true },
  token: { property: "authToken", takesValue: true },
};

export function resolveLocalBuddyRuntimeDefaults(
  config: PushPalsConfig = loadPushPalsConfig(),
): LocalBuddyRuntimeDefaults {
  return {
    serverUrl: config.server.url,
    port: config.localbuddy.port,
    sessionId: config.sessionId,
    authToken: config.authToken,
  };
}

export function loadLocalBuddyRuntimeOptions(
  argv: string[],
  defaults: LocalBuddyRuntimeDefaults = resolveLocalBuddyRuntimeDefaults(),
): LocalBuddyRuntimeOptions {
  const overrides = parseCliArgs(argv, localFlagSpecs);
  const server = (overrides.server as string | undefined) ?? defaults.serverUrl;
  if (!server.trim()) throw new RuntimeCliError("Server URL cannot be empty");
  const portOverride = normalizePositiveInt(overrides.port);
  if (portOverride != null && portOverride <= 0) {
    throw new RuntimeCliError("Port must be a positive integer");
  }
  const port = portOverride ?? defaults.port;
  const sessionId = (overrides.sessionId as string | undefined) ?? defaults.sessionId;
  if (!sessionId.trim()) {
    throw new RuntimeCliError("Session ID cannot be empty");
  }
  const authToken = normalizeOptionalToken(overrides.authToken, defaults.authToken);
  return {
    server: server.trim(),
    port,
    sessionId: sessionId.trim(),
    authToken,
  };
}
