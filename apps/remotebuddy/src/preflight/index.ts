const TELEMETRY_COMPONENT = "remotebuddy.preflight";
const DEFAULT_MIN_BUN_VERSION = "1.1.0";
const DOCKER_BIN_ENV = "REMOTEBUDDY_PREFLIGHT_DOCKER_BIN";
const DOCKER_SKIP_ENV = "REMOTEBUDDY_PREFLIGHT_ALLOW_NO_DOCKER";

export type CheckStatus = "pass" | "fail";

export type FailureTaxonomyId =
  | "remotebuddy.preflight.bun.version.missing"
  | "remotebuddy.preflight.bun.version.unsupported"
  | "remotebuddy.preflight.docker.cli_missing"
  | "remotebuddy.preflight.docker.version_error"
  | "remotebuddy.preflight.docker.daemon_unreachable"
  | "remotebuddy.preflight.env.missing"
  | "remotebuddy.preflight.internal_error";

export interface FailureTaxonomyEntry {
  taxonomyId: FailureTaxonomyId;
  checkId: string;
  detail: string;
  remediation: string;
  severity: "fatal" | "warn";
}

export interface CheckSummary {
  id: string;
  name: string;
  status: CheckStatus;
  detail: string;
  observed?: Record<string, unknown>;
  remediation?: string;
  failure?: FailureTaxonomyEntry;
}

export interface TelemetryEvent {
  ts: string;
  component: string;
  event: "preflight_start" | "preflight_complete" | "check_start" | "check_result";
  checkId?: string;
  status?: CheckStatus;
  failureTaxonomy?: FailureTaxonomyId;
  detail?: string;
}

export interface EnvRequirement {
  name: string;
  description: string;
  remediation: string;
  alternatives?: string[];
  allowEmpty?: boolean;
}

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface CommandRunnerOptions {
  timeoutMs?: number;
}

export type CommandRunner = (args: string[], options?: CommandRunnerOptions) => Promise<CommandResult>;

export interface PreflightContext {
  env: NodeJS.ProcessEnv;
  bunVersion: string;
  minBunVersion: string;
  requiredEnvVars: EnvRequirement[];
  detectBinary: (binName: string) => string | null;
  runCommand: CommandRunner;
  now: () => Date;
  telemetryComponent: string;
}

interface CheckDescriptor {
  id: string;
  name: string;
  run(context: PreflightContext): Promise<Omit<CheckSummary, "id" | "name">>;
}

export interface RunPreflightOptions {
  minBunVersion?: string;
  requiredEnvVars?: EnvRequirement[];
  env?: NodeJS.ProcessEnv;
  bunVersion?: string;
  detectBinary?: (binName: string) => string | null;
  runCommand?: CommandRunner;
  now?: () => Date;
  checks?: CheckDescriptor[];
  telemetryComponent?: string;
}

export interface PreflightResult {
  ok: boolean;
  generatedAt: string;
  checks: CheckSummary[];
  failures: FailureTaxonomyEntry[];
  telemetry: TelemetryEvent[];
}

export const DEFAULT_ENV_REQUIREMENTS: EnvRequirement[] = [
  {
    name: "PUSHPALS_AUTH_TOKEN",
    description: "Bearer token RemoteBuddy uses when calling Server and WorkerPals APIs.",
    remediation: "Export PUSHPALS_AUTH_TOKEN (or add it to .env) before launching RemoteBuddy.",
  },
  {
    name: "REMOTE_STABLE_ID",
    description: "Identifier used in telemetry so ops can tie logs back to this host/pod.",
    remediation:
      "Set REMOTE_STABLE_ID to a unique host label (for example remotebuddy-dev1) before startup.",
  },
  {
    name: "WORKERPALS_API_URL",
    description: "HTTP base URL for WorkerPals when RemoteBuddy enqueues jobs directly.",
    remediation:
      "Set WORKERPALS_API_URL (e.g. http://localhost:3002) so RemoteBuddy can reach WorkerPals.",
  },
  {
    name: "SERVER_BASE_URL",
    description: "HTTP base URL for the PushPals Server API surface.",
    remediation:
      "Set SERVER_BASE_URL or PUSHPALS_SERVER_URL to the host running apps/server (default http://localhost:3001).",
    alternatives: ["PUSHPALS_SERVER_URL"],
  },
];

export async function runPreflight(options: RunPreflightOptions = {}): Promise<PreflightResult> {
  const {
    minBunVersion = DEFAULT_MIN_BUN_VERSION,
    requiredEnvVars = DEFAULT_ENV_REQUIREMENTS,
    env = process.env,
    bunVersion = Bun.version,
    detectBinary = (bin: string) => Bun.which(bin),
    runCommand = defaultCommandRunner,
    now = () => new Date(),
    checks,
    telemetryComponent = TELEMETRY_COMPONENT,
  } = options;

  const context: PreflightContext = {
    env,
    bunVersion,
    minBunVersion,
    requiredEnvVars,
    detectBinary,
    runCommand,
    now,
    telemetryComponent,
  };

  const descriptors = checks ?? createDefaultChecks(minBunVersion, requiredEnvVars);
  const telemetry: TelemetryEvent[] = [];
  const failures: FailureTaxonomyEntry[] = [];
  const startTs = now().toISOString();
  telemetry.push({
    ts: startTs,
    component: telemetryComponent,
    event: "preflight_start",
  });

  const results: CheckSummary[] = [];

  for (const descriptor of descriptors) {
    const start = now().toISOString();
    telemetry.push({
      ts: start,
      component: telemetryComponent,
      event: "check_start",
      checkId: descriptor.id,
    });

    let summary: CheckSummary;
    try {
      const raw = await descriptor.run(context);
      summary = {
        id: descriptor.id,
        name: descriptor.name,
        ...raw,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      summary = {
        id: descriptor.id,
        name: descriptor.name,
        status: "fail",
        detail: `Preflight check crashed: ${detail}`,
        failure: {
          taxonomyId: "remotebuddy.preflight.internal_error",
          checkId: descriptor.id,
          detail,
          remediation:
            "Re-run remotebuddy:preflight with DEBUG=1 and file a bug with the captured stack trace.",
          severity: "fatal",
        },
      };
    }

    if (summary.status === "fail" && !summary.failure) {
      summary.failure = {
        taxonomyId: "remotebuddy.preflight.internal_error",
        checkId: descriptor.id,
        detail: summary.detail,
        remediation:
          "Review remotebuddy:preflight output and ensure the failing check maps to a taxonomyId.",
        severity: "fatal",
      };
    }

    if (summary.failure && summary.failure.checkId !== descriptor.id) {
      summary.failure = { ...summary.failure, checkId: descriptor.id };
    }

    if (summary.failure) failures.push(summary.failure);

    telemetry.push({
      ts: now().toISOString(),
      component: telemetryComponent,
      event: "check_result",
      checkId: descriptor.id,
      status: summary.status,
      failureTaxonomy: summary.failure?.taxonomyId,
      detail: summary.detail,
    });

    results.push(summary);
  }

  const ok = results.every((check) => check.status === "pass");
  telemetry.push({
    ts: now().toISOString(),
    component: telemetryComponent,
    event: "preflight_complete",
    status: ok ? "pass" : "fail",
  });

  return {
    ok,
    generatedAt: now().toISOString(),
    checks: results,
    failures,
    telemetry,
  };
}

export function createBunVersionCheck(minVersion: string): CheckDescriptor {
  return {
    id: "bun.version",
    name: "Bun runtime",
    async run(context) {
      const runtimeVersion = (context.bunVersion ?? "").trim();
      const parsed = parseSemver(runtimeVersion);
      const required = parseSemver(minVersion);
      if (!runtimeVersion) {
        return {
          status: "fail",
          detail: "Bun version is not available. `process.versions.bun` returned an empty value.",
          remediation:
            "Install Bun 1.1.x (curl -fsSL https://bun.sh/install | bash) and restart the shell.",
          failure: {
            taxonomyId: "remotebuddy.preflight.bun.version.missing",
            checkId: "bun.version",
            detail: "Could not read Bun runtime version.",
            remediation:
              "Confirm Bun is installed and on PATH, then rerun remotebuddy:preflight.",
            severity: "fatal",
          },
        };
      }

      if (!parsed || !required) {
        return {
          status: "fail",
          detail: `Unable to parse Bun version (${runtimeVersion}).`,
          remediation: "Upgrade Bun to a stable 1.1.x build and re-run the preflight.",
          failure: {
            taxonomyId: "remotebuddy.preflight.bun.version.missing",
            checkId: "bun.version",
            detail: `Bun version "${runtimeVersion}" does not follow semver.`,
            remediation:
              "Install a supported Bun release (>=1.1.0) using the official installer.",
            severity: "fatal",
          },
        };
      }

      if (compareSemver(parsed, required) < 0) {
        return {
          status: "fail",
          detail: `Detected Bun ${runtimeVersion}, but RemoteBuddy requires at least ${minVersion}.`,
          remediation:
            "Upgrade Bun to >=1.1.0 via https://bun.sh/install and restart your terminal session.",
          observed: {
            detectedVersion: runtimeVersion,
            requiredVersion: minVersion,
          },
          failure: {
            taxonomyId: "remotebuddy.preflight.bun.version.unsupported",
            checkId: "bun.version",
            detail: `Bun ${runtimeVersion} is below required ${minVersion}.`,
            remediation: "Install Bun >=1.1.0 before starting RemoteBuddy.",
            severity: "fatal",
          },
        };
      }

      return {
        status: "pass",
        detail: `Bun ${runtimeVersion} meets the minimum requirement (${minVersion}).`,
        observed: {
          detectedVersion: runtimeVersion,
          requiredVersion: minVersion,
        },
      };
    },
  };
}

export function createDockerCheck(): CheckDescriptor {
  return {
    id: "docker.runtime",
    name: "Docker runtime",
    async run(context) {
      if (isTruthy(context.env[DOCKER_SKIP_ENV])) {
        return {
          status: "pass",
          detail: "Docker verification skipped via REMOTEBUDDY_PREFLIGHT_ALLOW_NO_DOCKER.",
          observed: { skip: true },
        };
      }

      const explicitPath = (context.env[DOCKER_BIN_ENV] ?? "").trim();
      const dockerPath = explicitPath || context.detectBinary("docker");
      if (!dockerPath) {
        return {
          status: "fail",
          detail: "Docker CLI not found in PATH. Install Docker Desktop or docker-ce.",
          remediation:
            "Install Docker, ensure the `docker` binary is on PATH, then rerun remotebuddy:preflight.",
          failure: {
            taxonomyId: "remotebuddy.preflight.docker.cli_missing",
            checkId: "docker.runtime",
            detail: "Docker CLI missing; check PATH or REMOTEBUDDY_PREFLIGHT_DOCKER_BIN.",
            remediation:
              "Install Docker or set REMOTEBUDDY_PREFLIGHT_DOCKER_BIN to the docker binary path.",
            severity: "fatal",
          },
        };
      }

      const result = await context.runCommand(
        [dockerPath, "version", "--format", "{{json .}}"],
        { timeoutMs: 5_000 },
      );

      if (!result.ok) {
        const errOutput = (result.stderr || result.stdout || result.error || "").trim();
        const taxonomy =
          errOutput.includes("Cannot connect to the Docker daemon") ||
          errOutput.includes("Is the docker daemon running?")
            ? "remotebuddy.preflight.docker.daemon_unreachable"
            : "remotebuddy.preflight.docker.version_error";
        return {
          status: "fail",
          detail:
            taxonomy === "remotebuddy.preflight.docker.daemon_unreachable"
              ? "Docker CLI is installed but the daemon is not reachable."
              : "Docker CLI could not return version information.",
          remediation:
            taxonomy === "remotebuddy.preflight.docker.daemon_unreachable"
              ? "Start Docker Desktop or your docker daemon before running RemoteBuddy."
              : "Verify Docker is installed correctly and rerun remotebuddy:preflight.",
          observed: {
            exitCode: result.exitCode,
            error: errOutput,
          },
          failure: {
            taxonomyId: taxonomy,
            checkId: "docker.runtime",
            detail: errOutput || "Docker command failed.",
            remediation:
              taxonomy === "remotebuddy.preflight.docker.daemon_unreachable"
                ? "Start the docker daemon (e.g., Docker Desktop) so `docker version` succeeds."
                : "Reinstall or repair Docker so `docker version` works.",
            severity: "fatal",
          },
        };
      }

      const payload = safeParseDockerInfo(result.stdout);
      if (!payload) {
        return {
          status: "fail",
          detail: "Docker CLI returned unrecognized version output.",
          remediation: "Upgrade Docker CLI to a stable release (24.x+) and retry.",
          observed: { raw: result.stdout.trim() },
          failure: {
            taxonomyId: "remotebuddy.preflight.docker.version_error",
            checkId: "docker.runtime",
            detail: "docker version output was not valid JSON.",
            remediation: "Upgrade Docker CLI or remove custom formatters.",
            severity: "fatal",
          },
        };
      }

      return {
        status: "pass",
        detail: `Docker client ${payload.clientVersion ?? "unknown"} / server ${payload.serverVersion ?? "unknown"} ready.`,
        observed: {
          clientVersion: payload.clientVersion,
          serverVersion: payload.serverVersion,
          cliPath: dockerPath,
        },
      };
    },
  };
}

export function createEnvCheck(requirements: EnvRequirement[]): CheckDescriptor {
  return {
    id: "env.core",
    name: "Environment variables",
    async run(context) {
      const satisfied: string[] = [];
      const missing: EnvRequirement[] = [];

      for (const requirement of requirements) {
        const variants = [requirement.name, ...(requirement.alternatives ?? [])];
        const found = variants.find((name) => hasEnvValue(context.env[name], requirement.allowEmpty));
        if (found) {
          satisfied.push(found);
        } else {
          missing.push(requirement);
        }
      }

      if (missing.length > 0) {
        const missingNames = missing.map((req) => req.name);
        const detail = `Missing environment variables: ${missingNames.join(
          ", ",
        )}. RemoteBuddy startup is blocked until they are exported.`;
        const remediation = missing
          .map((req) => `${req.name}: ${req.remediation}`)
          .join(" ");
        return {
          status: "fail",
          detail,
          remediation,
          observed: {
            satisfied,
            missing: missingNames,
          },
          failure: {
            taxonomyId: "remotebuddy.preflight.env.missing",
            checkId: "env.core",
            detail: missing.map((req) => `${req.name} (${req.description})`).join(", "),
            remediation,
            severity: "fatal",
          },
        };
      }

      return {
        status: "pass",
        detail: "All required RemoteBuddy environment variables are present.",
        observed: { satisfied },
      };
    },
  };
}

function createDefaultChecks(
  minBunVersion: string,
  requiredEnvVars: EnvRequirement[],
): CheckDescriptor[] {
  return [
    createBunVersionCheck(minBunVersion),
    createDockerCheck(),
    createEnvCheck(requiredEnvVars),
  ];
}

function parseSemver(input: string): { major: number; minor: number; patch: number } | null {
  const match = input.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number.parseInt(match[1] ?? "0", 10);
  const minor = Number.parseInt(match[2] ?? "0", 10);
  const patch = Number.parseInt(match[3] ?? "0", 10);
  if ([major, minor, patch].some((value) => Number.isNaN(value))) return null;
  return { major, minor, patch };
}

function compareSemver(
  left: { major: number; minor: number; patch: number },
  right: { major: number; minor: number; patch: number },
): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

async function defaultCommandRunner(
  args: string[],
  options: CommandRunnerOptions = {},
): Promise<CommandResult> {
  const command = args[0];
  if (!command) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: "No command specified.",
    };
  }

  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, options.timeoutMs);
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToString(proc.stdout),
      streamToString(proc.stderr),
      proc.exited,
    ]);

    if (timeout) clearTimeout(timeout);

    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      stdout,
      stderr,
      timedOut,
      error: timedOut ? `Command timed out after ${options.timeoutMs}ms` : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function streamToString(stream: ReadableStream | null | undefined): Promise<string> {
  if (!stream) return "";
  const response = new Response(stream);
  return await response.text();
}

function hasEnvValue(value: string | undefined, allowEmpty = false): boolean {
  if (value == null) return false;
  if (allowEmpty) return true;
  return value.trim().length > 0;
}

function isTruthy(value: string | undefined): boolean {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return false;
  return ["1", "true", "yes", "on"].includes(text);
}

function safeParseDockerInfo(output: string): {
  clientVersion?: string;
  serverVersion?: string;
} | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      Client?: { Version?: string };
      Server?: { Version?: string };
    };
    return {
      clientVersion: parsed.Client?.Version,
      serverVersion: parsed.Server?.Version,
    };
  } catch {
    return null;
  }
}
