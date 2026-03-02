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
});
