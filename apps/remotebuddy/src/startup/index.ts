import { spawnSync } from "child_process";

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

const COMMAND_TIMEOUT_EXIT_CODE = 124;

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
  const requiredBunVersion = normalizeRequirementVersion(requirements.bun.minVersion);
  const requiredDockerVersion = normalizeRequirementVersion(requirements.docker.minVersion);

  const bunVersion = normalizeVersion(options.bunVersion ?? detectBunVersion());
  if (!bunVersion) {
    const issue = createIssue({
      component: "bun",
      code: StartupFailureCode.BunVersionUnknown,
      summary: "Bun version could not be detected (Bun.version was empty)",
      required: requiredBunVersion,
    });
    pushIssue(issue, checks, issues);
  } else if (compareVersions(bunVersion, requiredBunVersion) < 0) {
    const issue = createIssue({
      component: "bun",
      code: StartupFailureCode.BunVersionUnsupported,
      summary: `Bun ${bunVersion} is below required ${requiredBunVersion}`,
      observed: bunVersion,
      required: requiredBunVersion,
    });
    pushIssue(issue, checks, issues);
  } else {
    checks.push({
      component: "bun",
      passed: true,
      summary: `Bun ${bunVersion} detected`,
      observed: bunVersion,
      required: requiredBunVersion,
    });
  }

  const dockerBinary = typeof options.dockerPath === "string" ? options.dockerPath : detectDockerBinary();
  if (!dockerBinary) {
    const issue = createIssue({
      component: "docker",
      code: StartupFailureCode.DockerBinaryMissing,
      summary: "Docker CLI was not found in PATH",
      required: requiredDockerVersion,
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
        required: requiredDockerVersion,
      });
      pushIssue(issue, checks, issues);
    } else if (runResult.error) {
      const issue = createIssue({
        component: "docker",
        code: StartupFailureCode.DockerDaemonUnavailable,
        summary: "Docker command threw before producing output",
        detail: `${runResult.error}`,
        required: requiredDockerVersion,
      });
      pushIssue(issue, checks, issues);
    } else if (runResult.exitCode !== 0) {
      const issue = createIssue({
        component: "docker",
        code: StartupFailureCode.DockerDaemonUnavailable,
        summary: "Docker daemon is not reachable (docker version failed)",
        detail: sanitizeCliOutput(runResult.stderr) || sanitizeCliOutput(runResult.stdout) ||
          `docker version exited with code ${runResult.exitCode}`,
        required: requiredDockerVersion,
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
          required: requiredDockerVersion,
        });
        pushIssue(issue, checks, issues);
      } else if (compareVersions(parsedVersion, requiredDockerVersion) < 0) {
        const issue = createIssue({
          component: "docker",
          code: StartupFailureCode.DockerVersionUnsupported,
          summary: `Docker ${parsedVersion} is below required ${requiredDockerVersion}`,
          observed: parsedVersion,
          required: requiredDockerVersion,
        });
        pushIssue(issue, checks, issues);
      } else {
        checks.push({
          component: "docker",
          passed: true,
          summary: `Docker ${parsedVersion} reachable`,
          observed: parsedVersion,
          required: requiredDockerVersion,
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
      const normalized = normalizeVersion(parsed.Version);
      if (normalized) return normalized;
    }
    // Fallback when templating is unavailable and CLI returns plain text
    if (typeof parsed === "string" && parsed.trim().length > 0) {
      const normalized = normalizeVersion(parsed);
      if (normalized) return normalized;
    }
  } catch {
    // fall through to plain-text handling below
  }

  const lowerTrimmed = trimmed.toLowerCase();
  const serverIndex = lowerTrimmed.indexOf("server:");
  if (serverIndex >= 0) {
    const serverSection = trimmed.slice(serverIndex);
    const serverVersionLine = serverSection.match(/Version:\s*([^\r\n]+)/i);
    if (serverVersionLine?.[1]) {
      const normalizedServerLine = normalizeVersion(serverVersionLine[1]);
      if (normalizedServerLine) return normalizedServerLine;
    }
    const normalizedServerChunk = normalizeVersion(serverSection);
    if (normalizedServerChunk) return normalizedServerChunk;
  }

  const normalized = normalizeVersion(trimmed);
  if (normalized) return normalized;

  for (const line of trimmed.split(/\r?\n/)) {
    const normalizedLine = normalizeVersion(line);
    if (normalizedLine) return normalizedLine;
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
): CommandRunResult & { timedOut: boolean } {
  try {
    const result = runner(command, options);
    const timedOut = resolveTimedOutFlag(result, options);
    if (result.timedOut === timedOut) {
      return result as CommandRunResult & { timedOut: boolean };
    }
    return { ...result, timedOut };
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: "", error, timedOut: isTimeoutError(error) };
  }
}

function defaultRunner(command: string[], options?: CommandRunOptions): CommandRunResult {
  if (command.length === 0) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: "",
      error: new Error("No command provided"),
      timedOut: false,
    };
  }

  try {
    const [binary, ...args] = command;
    const timeout = coerceTimeoutMs(options?.timeoutMs);
    const spawnResult = spawnSync(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
    });
    const timedOut = didSpawnTimeout(spawnResult, timeout);
    return {
      exitCode:
        typeof spawnResult.status === "number"
          ? spawnResult.status
          : timedOut
            ? COMMAND_TIMEOUT_EXIT_CODE
            : spawnResult.signal
              ? 128
              : -1,
      stdout: typeof spawnResult.stdout === "string" ? spawnResult.stdout : "",
      stderr: typeof spawnResult.stderr === "string" ? spawnResult.stderr : "",
      error: timedOut ? undefined : spawnResult.error,
      timedOut,
    };
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: "", error, timedOut: isTimeoutError(error) };
  }
}

type PreReleaseIdentifier = number | string;

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: PreReleaseIdentifier[];
  prereleaseText: string[];
  build: string[];
  normalized: string;
}

const STRICT_SEMVER_REGEX =
  /^(?:v|V)?\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
const SEMVER_CANDIDATE_REGEX =
  /(?:v|V)?\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?/;
const SEMVER_CORE_REGEX =
  /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/;

function compareVersions(left: string, right: string): number {
  const leftSemver = parseSemver(left);
  const rightSemver = parseSemver(right);
  if (!leftSemver || !rightSemver) {
    return left === right ? 0 : left > right ? 1 : -1;
  }
  return compareParsedSemver(leftSemver, rightSemver);
}

function compareParsedSemver(left: ParsedSemver, right: ParsedSemver): number {
  if (left.major !== right.major) {
    return left.major > right.major ? 1 : -1;
  }
  if (left.minor !== right.minor) {
    return left.minor > right.minor ? 1 : -1;
  }
  if (left.patch !== right.patch) {
    return left.patch > right.patch ? 1 : -1;
  }
  const leftHasPrerelease = left.prerelease.length > 0;
  const rightHasPrerelease = right.prerelease.length > 0;
  if (!leftHasPrerelease && !rightHasPrerelease) {
    return 0;
  }
  if (!leftHasPrerelease) return 1;
  if (!rightHasPrerelease) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

function normalizeVersion(value: string | null | undefined): string | null {
  const parsed = parseSemver(value);
  return parsed?.normalized ?? null;
}

function normalizeRequirementVersion(value: string): string {
  const normalized = normalizeVersion(value);
  if (normalized) return normalized;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : value;
}

function parseSemver(value: string | null | undefined): ParsedSemver | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = findSemverCandidate(trimmed);
  if (!candidate) return null;
  return parseSemverCore(candidate);
}

function findSemverCandidate(value: string): string | null {
  if (STRICT_SEMVER_REGEX.test(value)) {
    return value;
  }
  const matches = value.match(new RegExp(SEMVER_CANDIDATE_REGEX.source, "g"));
  if (!matches || matches.length === 0) {
    return null;
  }
  let best = matches[0];
  let bestParsed = parseSemverCore(best);
  for (let i = 1; i < matches.length; i++) {
    const candidate = matches[i];
    const parsedCandidate = parseSemverCore(candidate);
    if (!parsedCandidate) {
      if (!bestParsed && candidate.length > best.length) {
        best = candidate;
      }
      continue;
    }
    if (!bestParsed) {
      best = candidate;
      bestParsed = parsedCandidate;
      continue;
    }
    if (compareParsedSemver(parsedCandidate, bestParsed) > 0) {
      best = candidate;
      bestParsed = parsedCandidate;
    }
  }
  return best;
}

function parseSemverCore(candidate: string): ParsedSemver | null {
  const sanitized = candidate.replace(/^(?:v|V)/, "");
  const match = sanitized.match(SEMVER_CORE_REGEX);
  if (!match) return null;
  const [, majorRaw, minorRaw, patchRaw, prereleaseRaw, buildRaw] = match;
  const major = Number.parseInt(majorRaw, 10);
  const minor = Number.parseInt(minorRaw ?? "0", 10);
  const patch = Number.parseInt(patchRaw ?? "0", 10);
  if ([major, minor, patch].some((segment) => Number.isNaN(segment))) {
    return null;
  }
  const prereleaseText = splitIdentifiers(prereleaseRaw);
  const prerelease = prereleaseText.map((segment) =>
    /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment,
  );
  const build = splitIdentifiers(buildRaw);
  const normalized = formatSemverString(major, minor, patch, prereleaseText, build);
  return { major, minor, patch, prerelease, prereleaseText, build, normalized };
}

function splitIdentifiers(value?: string): string[] {
  if (!value) return [];
  return value
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function formatSemverString(
  major: number,
  minor: number,
  patch: number,
  prerelease: string[],
  build: string[],
): string {
  let normalized = `${major}.${minor}.${patch}`;
  if (prerelease.length > 0) {
    normalized += `-${prerelease.join(".")}`;
  }
  if (build.length > 0) {
    normalized += `+${build.join(".")}`;
  }
  return normalized;
}

function comparePrerelease(left: PreReleaseIdentifier[], right: PreReleaseIdentifier[]): number {
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") {
      if (l > r) return 1;
      if (l < r) return -1;
      continue;
    }
    if (typeof l === "number") return -1;
    if (typeof r === "number") return 1;
    const comparison = String(l).localeCompare(String(r));
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("timedOut" in error && typeof (error as { timedOut?: unknown }).timedOut === "boolean") {
    return Boolean((error as { timedOut?: unknown }).timedOut);
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.toUpperCase() === "ETIMEDOUT";
}

function resolveTimedOutFlag(result: CommandRunResult, options?: CommandRunOptions): boolean {
  if (typeof result.timedOut === "boolean") {
    return result.timedOut;
  }
  if (result.error && isTimeoutError(result.error)) {
    return true;
  }
  return didExitLikeTimeout(result, options);
}

function didExitLikeTimeout(result: CommandRunResult, options?: CommandRunOptions): boolean {
  if (!options) return false;
  if (typeof options.timeoutMs !== "number" || options.timeoutMs <= 0) {
    return false;
  }
  return result.exitCode === COMMAND_TIMEOUT_EXIT_CODE;
}

function coerceTimeoutMs(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value <= 0) {
    return undefined;
  }
  const coerced = Math.floor(value);
  return coerced > 0 ? coerced : undefined;
}

function didSpawnTimeout(result: ReturnType<typeof spawnSync>, timeout?: number): boolean {
  if (typeof timeout !== "number" || timeout <= 0) {
    return false;
  }
  if (result.error && isTimeoutError(result.error)) {
    return true;
  }
  if (result.status === null && typeof result.signal === "string") {
    const normalizedSignal = result.signal.toUpperCase();
    return normalizedSignal === "SIGKILL" || normalizedSignal === "SIGTERM";
  }
  return false;
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
