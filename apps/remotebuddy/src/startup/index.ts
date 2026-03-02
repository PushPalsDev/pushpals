export type StartupComponent = "bun" | "docker";

export enum StartupFailureAction {
  Unknown = "unknown",
  InstallBun = "install_bun",
  UpgradeBun = "upgrade_bun",
  InstallDocker = "install_docker",
  StartDocker = "start_docker",
  UpgradeDocker = "upgrade_docker",
}

export enum StartupFailureCode {
  BunVersionUnknown = "bun.version.unknown",
  BunVersionUnsupported = "bun.version.unsupported",
  DockerBinaryMissing = "docker.binary.missing",
  DockerDaemonUnavailable = "docker.daemon.unavailable",
  DockerVersionUnparseable = "docker.version.unparseable",
  DockerVersionUnsupported = "docker.version.unsupported",
}

export enum StartupFailureHint {
  InstallBun = "install_bun",
  UpgradeBun = "upgrade_bun",
  InstallDocker = "install_docker",
  StartDocker = "start_docker",
  UpgradeDocker = "upgrade_docker",
  Unknown = "unknown",
}

export interface StartupValidationCheck {
  component: StartupComponent;
  passed: boolean;
  summary: string;
  observed?: string | null;
  required?: string;
  detail?: string;
  code?: StartupFailureCode;
  hint?: string;
  hintCode?: StartupFailureHint;
}

export interface StartupValidationIssue extends StartupValidationCheck {
  code: StartupFailureCode;
  hintCode: StartupFailureHint;
  hint: string;
  action: StartupFailureAction;
}

export interface StartupValidationResult {
  ok: boolean;
  checks: StartupValidationCheck[];
  issues: StartupValidationIssue[];
}

export interface CommandRunOptions {
  timeoutMs?: number;
}

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: unknown;
  timedOut?: boolean;
}

export type CommandRunner = (command: string[], options?: CommandRunOptions) => CommandRunResult;

export interface StartupValidatorOptions {
  minBunVersion?: string;
  minDockerVersion?: string;
  dockerPath?: string | null;
  dockerVersionCommand?: string[];
  dockerTimeoutMs?: number;
  bunVersion?: string | null;
  commandRunner?: CommandRunner;
}

interface StartupRequirements {
  bun: { minVersion: string };
  docker: { minVersion: string; timeoutMs: number };
}

const DEFAULT_REQUIREMENTS: StartupRequirements = {
  bun: { minVersion: "1.1.0" },
  docker: { minVersion: "24.0.0", timeoutMs: 3_000 },
};

const INSTALL_BUN_HINT =
  "Install or upgrade Bun via `curl -fsSL https://bun.sh/install | bash` (macOS/Linux) or `powershell -c \"irm https://bun.sh/install.ps1 | iex\"` on Windows.";
const START_DOCKER_HINT =
  "Start Docker Desktop or `systemctl start docker`, then rerun `docker version` to confirm the daemon is reachable.";
const INSTALL_DOCKER_HINT =
  "Install Docker Desktop >= 24.0 or the Docker Engine package for your OS, then verify `docker version` succeeds.";
const UPGRADE_DOCKER_HINT =
  "Upgrade Docker to 24.0+ so WorkerPals containers match the tested sandbox image.";
interface StartupFailureMetadata {
  hintCode: StartupFailureHint;
  hint: string;
  action: StartupFailureAction;
}

const STARTUP_FAILURE_METADATA: Record<StartupFailureCode, StartupFailureMetadata> = {
  [StartupFailureCode.BunVersionUnknown]: {
    hintCode: StartupFailureHint.InstallBun,
    hint: INSTALL_BUN_HINT,
    action: StartupFailureAction.InstallBun,
  },
  [StartupFailureCode.BunVersionUnsupported]: {
    hintCode: StartupFailureHint.UpgradeBun,
    hint: INSTALL_BUN_HINT,
    action: StartupFailureAction.UpgradeBun,
  },
  [StartupFailureCode.DockerBinaryMissing]: {
    hintCode: StartupFailureHint.InstallDocker,
    hint: INSTALL_DOCKER_HINT,
    action: StartupFailureAction.InstallDocker,
  },
  [StartupFailureCode.DockerDaemonUnavailable]: {
    hintCode: StartupFailureHint.StartDocker,
    hint: START_DOCKER_HINT,
    action: StartupFailureAction.StartDocker,
  },
  [StartupFailureCode.DockerVersionUnparseable]: {
    hintCode: StartupFailureHint.StartDocker,
    hint: START_DOCKER_HINT,
    action: StartupFailureAction.StartDocker,
  },
  [StartupFailureCode.DockerVersionUnsupported]: {
    hintCode: StartupFailureHint.UpgradeDocker,
    hint: UPGRADE_DOCKER_HINT,
    action: StartupFailureAction.UpgradeDocker,
  },
};

export function validateStartupPrerequisites(options: StartupValidatorOptions = {}): StartupValidationResult {
  const requirements: StartupRequirements = {
    bun: { minVersion: options.minBunVersion ?? DEFAULT_REQUIREMENTS.bun.minVersion },
    docker: {
      minVersion: options.minDockerVersion ?? DEFAULT_REQUIREMENTS.docker.minVersion,
      timeoutMs: options.dockerTimeoutMs ?? DEFAULT_REQUIREMENTS.docker.timeoutMs,
    },
  };

  const runner = options.commandRunner ?? defaultRunner;
  const checks: StartupValidationCheck[] = [];
  const issues: StartupValidationIssue[] = [];

  const bunVersion = normalizeVersion(options.bunVersion ?? detectBunVersion());
  if (!bunVersion) {
    const issue = createIssue({
      component: "bun",
      code: StartupFailureCode.BunVersionUnknown,
      summary: "Bun version could not be detected (Bun.version was empty)",
      required: requirements.bun.minVersion,
    });
    pushIssue(issue, checks, issues);
  } else if (compareVersions(bunVersion, requirements.bun.minVersion) < 0) {
    const issue = createIssue({
      component: "bun",
      code: StartupFailureCode.BunVersionUnsupported,
      summary: `Bun ${bunVersion} is below required ${requirements.bun.minVersion}`,
      observed: bunVersion,
      required: requirements.bun.minVersion,
    });
    pushIssue(issue, checks, issues);
  } else {
    checks.push({
      component: "bun",
      passed: true,
      summary: `Bun ${bunVersion} detected`,
      observed: bunVersion,
      required: requirements.bun.minVersion,
    });
  }

  const dockerBinary = typeof options.dockerPath === "string" ? options.dockerPath : detectDockerBinary();
  if (!dockerBinary) {
    const issue = createIssue({
      component: "docker",
      code: StartupFailureCode.DockerBinaryMissing,
      summary: "Docker CLI was not found in PATH",
      required: requirements.docker.minVersion,
    });
    pushIssue(issue, checks, issues);
  } else {
    const dockerVersionCommand = options.dockerVersionCommand ?? [
      dockerBinary,
      "version",
      "--format",
      "{{json .Server}}",
    ];

    const runResult = safeRunCommand(runner, dockerVersionCommand, { timeoutMs: requirements.docker.timeoutMs });
    if (runResult.timedOut) {
      const issue = createIssue({
        component: "docker",
        code: StartupFailureCode.DockerDaemonUnavailable,
        summary: "Docker version command timed out",
        detail: `Timeout after ${requirements.docker.timeoutMs}ms while running ${renderCommand(dockerVersionCommand)}`,
        required: requirements.docker.minVersion,
      });
      pushIssue(issue, checks, issues);
    } else if (runResult.error) {
      const issue = createIssue({
        component: "docker",
        code: StartupFailureCode.DockerDaemonUnavailable,
        summary: "Docker command threw before producing output",
        detail: `${runResult.error}`,
        required: requirements.docker.minVersion,
      });
      pushIssue(issue, checks, issues);
    } else if (runResult.exitCode !== 0) {
      const issue = createIssue({
        component: "docker",
        code: StartupFailureCode.DockerDaemonUnavailable,
        summary: "Docker daemon is not reachable (docker version failed)",
        detail: sanitizeCliOutput(runResult.stderr) || sanitizeCliOutput(runResult.stdout) ||
          `docker version exited with code ${runResult.exitCode}`,
        required: requirements.docker.minVersion,
      });
      pushIssue(issue, checks, issues);
    } else {
      const parsedVersion = parseDockerVersion(runResult.stdout);
      if (!parsedVersion) {
        const issue = createIssue({
          component: "docker",
          code: StartupFailureCode.DockerVersionUnparseable,
          summary: "Docker version output could not be parsed",
          detail: sanitizeCliOutput(runResult.stdout) || "(empty output)",
          required: requirements.docker.minVersion,
        });
        pushIssue(issue, checks, issues);
      } else if (compareVersions(parsedVersion, requirements.docker.minVersion) < 0) {
        const issue = createIssue({
          component: "docker",
          code: StartupFailureCode.DockerVersionUnsupported,
          summary: `Docker ${parsedVersion} is below required ${requirements.docker.minVersion}`,
          observed: parsedVersion,
          required: requirements.docker.minVersion,
        });
        pushIssue(issue, checks, issues);
      } else {
        checks.push({
          component: "docker",
          passed: true,
          summary: `Docker ${parsedVersion} reachable`,
          observed: parsedVersion,
          required: requirements.docker.minVersion,
        });
      }
    }
  }

  return { ok: issues.length === 0, checks, issues };
}

export function formatStartupReport(result: StartupValidationResult): string {
  if (result.ok) {
    const detail = result.checks
      .map((check) => `${check.component}:${check.observed ?? "ok"}`)
      .join(", ");
    return `[startup] prerequisites ok (${detail})`;
  }

  return result.issues
    .map((issue) => {
      const codeSuffix = ` code=${issue.code}`;
      const actionSuffix = issue.action ? ` action=${issue.action}` : "";
      const hintCodeSuffix = issue.hintCode ? ` hint_code=${issue.hintCode}` : "";
      const hintSuffix = issue.hint ? ` | hint: ${issue.hint}` : "";
      return `[startup][${issue.component}] ${issue.summary}${codeSuffix}${actionSuffix}${hintCodeSuffix}${hintSuffix}`;
    })
    .join("\n");
}

function parseDockerVersion(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.Version === "string" && parsed.Version.trim().length > 0) {
      return parsed.Version.trim();
    }
    // Fallback when templating is unavailable and CLI returns plain text
    if (typeof parsed === "string" && parsed.trim().length > 0) {
      return parsed.trim();
    }
  } catch {
    const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim();
    if (firstLine) return firstLine;
  }

  return null;
}

function detectBunVersion(): string | null {
  try {
    if (typeof Bun?.version === "string" && Bun.version.trim().length > 0) {
      return Bun.version.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function detectDockerBinary(): string | null {
  try {
    const binary = Bun.which?.("docker");
    return binary ?? null;
  } catch {
    return null;
  }
}

function safeRunCommand(
  runner: CommandRunner,
  command: string[],
  options: CommandRunOptions,
): CommandRunResult & { timedOut?: boolean } {
  try {
    const result = runner(command, options);
    return result;
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: "", error };
  }
}

function defaultRunner(command: string[], options?: CommandRunOptions): CommandRunResult {
  try {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      timedOut: false,
    };
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: "", error };
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((value) => parseInt(value, 10) || 0);
  const rightParts = right.split(".").map((value) => parseInt(value, 10) || 0);
  const max = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < max; i++) {
    const l = leftParts[i] ?? 0;
    const r = rightParts[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

function normalizeVersion(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function sanitizeCliOutput(value: string | undefined): string {
  if (!value) return "";
  return value.trim().split(/\r?\n/).slice(0, 3).join(" ");
}

function renderCommand(command: string[]): string {
  return command.map((part) => (part.includes(" ") ? `"${part}"` : part)).join(" ");
}

type StartupIssueInput = Omit<StartupValidationIssue, "passed" | "hint" | "hintCode" | "action"> & {
  hint?: string;
  hintCode?: StartupFailureHint;
  action?: StartupFailureAction;
};

function createIssue(input: StartupIssueInput): StartupValidationIssue {
  const metadata = input.code ? STARTUP_FAILURE_METADATA[input.code] : null;
  const hint = input.hint ?? metadata?.hint ?? "";
  const hintCode = input.hintCode ?? metadata?.hintCode ?? StartupFailureHint.Unknown;
  const action = input.action ?? metadata?.action ?? StartupFailureAction.Unknown;
  return { ...input, hintCode, hint, action, passed: false };
}

function pushIssue(
  issue: StartupValidationIssue,
  checks: StartupValidationCheck[],
  issues: StartupValidationIssue[],
): void {
  checks.push(issue);
  issues.push(issue);
}
