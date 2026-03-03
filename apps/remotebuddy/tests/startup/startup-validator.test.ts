import { describe, expect, test } from "bun:test";
import {
  type CommandRunner,
  StartupFailureAction,
  StartupFailureCode,
  StartupFailureHint,
  formatStartupReport,
  validateStartupPrerequisites,
} from "../../src/startup";

describe("remotebuddy startup validator", () => {
  const dockerRunnerWithVersion = (version: string): CommandRunner => () => ({
    exitCode: 0,
    stdout: JSON.stringify({ Version: version }),
    stderr: "",
  });
  const okDockerRunner = dockerRunnerWithVersion("25.0.2");

  test("passes when Bun and Docker meet requirements", () => {
    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "/usr/bin/docker",
      commandRunner: okDockerRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.checks.find((check) => check.component === "docker")?.observed).toBe("25.0.2");
  });

  test("reports Bun version failures with actionable hint", () => {
    const result = validateStartupPrerequisites({
      bunVersion: "1.0.0",
      dockerPath: "/usr/bin/docker",
      commandRunner: okDockerRunner,
    });

    expect(result.ok).toBe(false);
    const bunIssue = result.issues.find((issue) => issue.component === "bun");
    expect(bunIssue?.code).toBe(StartupFailureCode.BunVersionUnsupported);
    expect(bunIssue?.hintCode).toBe(StartupFailureHint.UpgradeBun);
    expect(bunIssue?.hint).toContain("bun.sh/install");
    expect(bunIssue?.summary).toContain("1.0.0");
  });

  test("handles Docker daemon outages deterministically", () => {
    const failingRunner: CommandRunner = () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
    });

    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "/usr/bin/docker",
      commandRunner: failingRunner,
    });

    expect(result.ok).toBe(false);
    const dockerIssue = result.issues.find((issue) => issue.component === "docker");
    expect(dockerIssue?.code).toBe(StartupFailureCode.DockerDaemonUnavailable);
    expect(dockerIssue?.action).toBe(StartupFailureAction.StartDocker);
    expect(dockerIssue?.hintCode).toBe(StartupFailureHint.StartDocker);
    expect(dockerIssue?.detail).toContain("Cannot connect");

    const report = formatStartupReport(result);
    expect(report).toContain("docker");
    expect(report).toContain(StartupFailureCode.DockerDaemonUnavailable);
    expect(report).toContain("hint_code=start_docker");
  });

  test("treats docker command timeouts as actionable outages", () => {
    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "/usr/bin/docker",
      dockerVersionCommand: ["/bin/sh", "-c", "sleep 1"],
      dockerTimeoutMs: 50,
    });

    expect(result.ok).toBe(false);
    const dockerIssue = result.issues.find((issue) => issue.component === "docker");
    expect(dockerIssue?.code).toBe(StartupFailureCode.DockerDaemonUnavailable);
    expect(dockerIssue?.summary).toContain("timed out");
    expect(dockerIssue?.action).toBe(StartupFailureAction.StartDocker);
    expect(dockerIssue?.hintCode).toBe(StartupFailureHint.StartDocker);
    expect(dockerIssue?.hint).toContain("Start Docker");
    expect(dockerIssue?.detail).toContain("/bin/sh");

    const report = formatStartupReport(result);
    expect(report).toContain(StartupFailureCode.DockerDaemonUnavailable);
    expect(report).toContain("code=docker.daemon.unavailable");
    expect(report).toContain("hint_code=start_docker");
    expect(report).toContain("action=start_docker");
    expect(report).toContain("timed out");
  });

  test("interprets ETIMEDOUT runner responses as docker timeouts", () => {
    const timeoutError = Object.assign(new Error("child process timed out"), { code: "ETIMEDOUT" });
    const timeoutRunner: CommandRunner = () => ({
      exitCode: -1,
      stdout: "",
      stderr: "",
      error: timeoutError,
    });

    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "/usr/bin/docker",
      commandRunner: timeoutRunner,
    });

    expect(result.ok).toBe(false);
    const dockerIssue = result.issues.find((issue) => issue.component === "docker");
    expect(dockerIssue?.code).toBe(StartupFailureCode.DockerDaemonUnavailable);
    expect(dockerIssue?.summary).toContain("timed out");
    expect(dockerIssue?.action).toBe(StartupFailureAction.StartDocker);
    expect(dockerIssue?.hintCode).toBe(StartupFailureHint.StartDocker);
    const report = formatStartupReport(result);
    expect(report).toContain("timed out");
    expect(report).toContain("code=docker.daemon.unavailable");
    expect(report).toContain("hint_code=start_docker");
  });

  test("treats bare exit code timeouts as actionable docker outages", () => {
    const timeoutExitRunner: CommandRunner = () => ({
      exitCode: 124,
      stdout: "",
      stderr: "",
    });

    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "/usr/bin/docker",
      commandRunner: timeoutExitRunner,
      dockerTimeoutMs: 250,
    });

    expect(result.ok).toBe(false);
    const dockerIssue = result.issues.find((issue) => issue.component === "docker");
    expect(dockerIssue?.code).toBe(StartupFailureCode.DockerDaemonUnavailable);
    expect(dockerIssue?.summary).toContain("timed out");
    expect(dockerIssue?.action).toBe(StartupFailureAction.StartDocker);
    expect(dockerIssue?.hintCode).toBe(StartupFailureHint.StartDocker);

    const report = formatStartupReport(result);
    expect(report).toContain(StartupFailureCode.DockerDaemonUnavailable);
    expect(report).toContain("code=docker.daemon.unavailable");
    expect(report).toContain("action=start_docker");
    expect(report).toContain("hint_code=start_docker");
    expect(report).toContain("timed out");
  });

  test("surfaces runner exceptions with deterministic messaging", () => {
    const throwingRunner: CommandRunner = () => {
      throw new Error("diagnostic failure");
    };

    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "/usr/bin/docker",
      commandRunner: throwingRunner,
    });

    expect(result.ok).toBe(false);
    const dockerIssue = result.issues.find((issue) => issue.component === "docker");
    expect(dockerIssue?.code).toBe(StartupFailureCode.DockerDaemonUnavailable);
    expect(dockerIssue?.summary).toContain("threw");
    expect(dockerIssue?.detail).toContain("diagnostic failure");
    expect(dockerIssue?.action).toBe(StartupFailureAction.StartDocker);
    expect(dockerIssue?.hintCode).toBe(StartupFailureHint.StartDocker);
    expect(dockerIssue?.hint).toContain("Start Docker");

    const report = formatStartupReport(result);
    expect(report).toContain(StartupFailureCode.DockerDaemonUnavailable);
    expect(report).toContain("code=docker.daemon.unavailable");
    expect(report).toContain("hint_code=start_docker");
    expect(report).toContain("action=start_docker");
    expect(report).toContain("Docker command threw");
    expect(report).toMatch(/hint: Start Docker/);
  });

  test("reports unknown Bun versions with install hint", () => {
    const result = validateStartupPrerequisites({
      bunVersion: "",
      dockerPath: "/usr/bin/docker",
      commandRunner: okDockerRunner,
    });

    expect(result.ok).toBe(false);
    const bunIssue = result.issues.find((issue) => issue.component === "bun");
    expect(bunIssue?.code).toBe(StartupFailureCode.BunVersionUnknown);
    expect(bunIssue?.action).toBe(StartupFailureAction.InstallBun);
    expect(bunIssue?.hintCode).toBe(StartupFailureHint.InstallBun);
    expect(bunIssue?.hint).toContain("bun.sh/install");
  });

  test("reports missing Docker binary deterministically", () => {
    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "",
      commandRunner: okDockerRunner,
    });

    expect(result.ok).toBe(false);
    const dockerIssue = result.issues.find((issue) => issue.component === "docker");
    expect(dockerIssue?.code).toBe(StartupFailureCode.DockerBinaryMissing);
    expect(dockerIssue?.action).toBe(StartupFailureAction.InstallDocker);
    expect(dockerIssue?.hintCode).toBe(StartupFailureHint.InstallDocker);
    expect(dockerIssue?.hint).toContain("Docker Desktop");
  });

  test("flags Docker version parsing issues", () => {
    const unparseableRunner: CommandRunner = () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "/usr/bin/docker",
      commandRunner: unparseableRunner,
    });

    expect(result.ok).toBe(false);
    const dockerIssue = result.issues.find((issue) => issue.component === "docker");
    expect(dockerIssue?.code).toBe(StartupFailureCode.DockerVersionUnparseable);
    expect(dockerIssue?.action).toBe(StartupFailureAction.StartDocker);
    expect(dockerIssue?.hintCode).toBe(StartupFailureHint.StartDocker);
    expect(dockerIssue?.hint).toContain("Start Docker");

    const report = formatStartupReport(result);
    expect(report).toContain(StartupFailureCode.DockerVersionUnparseable);
    expect(report).toContain("hint_code=start_docker");
  });

  test("captures Docker version mismatches with upgrade hint", () => {
    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "/usr/bin/docker",
      commandRunner: dockerRunnerWithVersion("23.0.0"),
    });

    expect(result.ok).toBe(false);
    const dockerIssue = result.issues.find((issue) => issue.component === "docker");
    expect(dockerIssue?.code).toBe(StartupFailureCode.DockerVersionUnsupported);
    expect(dockerIssue?.observed).toBe("23.0.0");
    expect(dockerIssue?.hintCode).toBe(StartupFailureHint.UpgradeDocker);
    expect(dockerIssue?.hint).toContain("Upgrade Docker");

    const report = formatStartupReport(result);
    expect(report).toContain(StartupFailureCode.DockerVersionUnsupported);
    expect(report).toContain("hint_code=upgrade_docker");
    expect(report).toContain("hint: Upgrade Docker");
  });

  test("normalizes Bun versions with prefixes and metadata", () => {
    const result = validateStartupPrerequisites({
      bunVersion: "v1.3.10+sha.abc123",
      dockerPath: "/usr/bin/docker",
      commandRunner: okDockerRunner,
    });

    expect(result.ok).toBe(true);
    const bunCheck = result.checks.find((check) => check.component === "bun");
    expect(bunCheck?.observed).toBe("1.3.10+sha.abc123");
  });

  test("accepts Docker versions with build metadata and prefixes", () => {
    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "/usr/bin/docker",
      commandRunner: dockerRunnerWithVersion("v25.1.2+azure.7"),
    });

    expect(result.ok).toBe(true);
    const dockerCheck = result.checks.find((check) => check.component === "docker");
    expect(dockerCheck?.passed).toBe(true);
    expect(dockerCheck?.observed).toBe("25.1.2+azure.7");
  });

  test("parses docker plain-text output when API version appears before server version", () => {
    const plainTextRunner: CommandRunner = () => ({
      exitCode: 0,
      stdout: `
Client: Docker Engine - Community
 Version:           25.0.2
 API version:       1.44
Server: Docker Engine - Community
 Version:           v25.0.2-beta.1+azure.7
 API version:       1.44
`,
      stderr: "",
    });

    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "/usr/bin/docker",
      commandRunner: plainTextRunner,
    });

    expect(result.ok).toBe(true);
    const dockerCheck = result.checks.find((check) => check.component === "docker");
    expect(dockerCheck?.observed).toBe("25.0.2-beta.1+azure.7");
  });

  test("treats Docker prerelease versions below required release as unsupported", () => {
    const result = validateStartupPrerequisites({
      bunVersion: "1.3.10",
      dockerPath: "/usr/bin/docker",
      commandRunner: dockerRunnerWithVersion("25.0.0-beta.1"),
      minDockerVersion: "25.0.0",
    });

    expect(result.ok).toBe(false);
    const dockerIssue = result.issues.find((issue) => issue.component === "docker");
    expect(dockerIssue?.code).toBe(StartupFailureCode.DockerVersionUnsupported);
    expect(dockerIssue?.observed).toBe("25.0.0-beta.1");
    expect(dockerIssue?.summary).toContain("25.0.0-beta.1");
    expect(dockerIssue?.summary).toContain("25.0.0");
  });
});
