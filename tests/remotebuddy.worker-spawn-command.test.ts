import { describe, expect, test } from "bun:test";
import {
  buildWorkerSpawnCommand,
  resolveWorkerStartupTimeoutMs,
} from "../apps/remotebuddy/src/worker_spawn";

describe("remotebuddy worker spawn command", () => {
  test("builds bun run command with valid argument ordering", () => {
    const command = buildWorkerSpawnCommand({
      server: "http://localhost:3001",
      workerId: "workerpal-abc12345",
      repoRoot: "C:/repo",
      pollMs: 2000,
      heartbeatMs: 5000,
      labels: ["autospawn", "background"],
      docker: true,
      requireDocker: true,
      dockerImage: "pushpals-worker-sandbox:latest",
    });

    expect(command.slice(0, 5)).toEqual([
      "bun",
      "run",
      "--env-file",
      ".env",
      "apps/workerpals/src/workerpals_main.ts",
    ]);
    expect(command).toContain("--server");
    expect(command).toContain("http://localhost:3001");
    expect(command).toContain("--workerId");
    expect(command).toContain("workerpal-abc12345");
    expect(command).toContain("--repo");
    expect(command).toContain("C:/repo");
    expect(command).toContain("--docker");
    expect(command).toContain("--require-docker");
    expect(command).toContain("--docker-image");
    expect(command).toContain("pushpals-worker-sandbox:latest");
    expect(command).not.toContain("--cwd");
  });

  test("omits optional args when not configured", () => {
    const command = buildWorkerSpawnCommand({
      server: "http://localhost:3001",
      workerId: "workerpal-minimal",
      repoRoot: "C:/repo",
      pollMs: null,
      heartbeatMs: null,
      labels: [],
      docker: false,
      requireDocker: false,
      dockerImage: null,
    });

    expect(command).not.toContain("--poll");
    expect(command).not.toContain("--heartbeat");
    expect(command).not.toContain("--labels");
    expect(command).not.toContain("--docker");
    expect(command).not.toContain("--docker-image");
  });

  test("supports absolute workerpals checkout paths when provided", () => {
    const command = buildWorkerSpawnCommand({
      server: "http://localhost:3001",
      workerId: "workerpal-abs",
      repoRoot: "C:/target-repo",
      pollMs: null,
      heartbeatMs: null,
      labels: [],
      docker: false,
      requireDocker: false,
      dockerImage: null,
      envFile: "C:/pushpals/.env",
      entrypoint: "C:/pushpals/apps/workerpals/src/workerpals_main.ts",
    });

    expect(command.slice(0, 5)).toEqual([
      "bun",
      "run",
      "--env-file",
      "C:/pushpals/.env",
      "C:/pushpals/apps/workerpals/src/workerpals_main.ts",
    ]);
    expect(command).toContain("--repo");
    expect(command).toContain("C:/target-repo");
    expect(command).not.toContain("--cwd");
  });

  test("prefers embedded workerpals binary when provided", () => {
    const command = buildWorkerSpawnCommand({
      server: "http://localhost:3001",
      workerId: "workerpal-bin",
      repoRoot: "C:/target-repo",
      pollMs: 2000,
      heartbeatMs: 5000,
      labels: ["autospawn"],
      docker: true,
      requireDocker: true,
      dockerImage: "pushpals-worker-sandbox:latest",
      binaryPath: "C:/runtime/pushpals-runtime-workerpals-windows-x64.exe",
      envFile: "C:/pushpals/.env",
      entrypoint: "C:/pushpals/apps/workerpals/src/workerpals_main.ts",
    });

    expect(command[0]).toBe("C:/runtime/pushpals-runtime-workerpals-windows-x64.exe");
    expect(command).toContain("--server");
    expect(command).toContain("http://localhost:3001");
    expect(command).toContain("--repo");
    expect(command).toContain("C:/target-repo");
    expect(command).toContain("--docker");
    expect(command).not.toContain("bun");
    expect(command).not.toContain("--env-file");
  });

  test("uses a higher startup timeout floor for Docker-backed workers", () => {
    expect(
      resolveWorkerStartupTimeoutMs({
        configuredMs: 10_000,
        docker: true,
        dockerAgentStartupTimeoutMs: 45_000,
      }),
    ).toBe(60_000);
    expect(
      resolveWorkerStartupTimeoutMs({
        configuredMs: 90_000,
        docker: true,
        dockerAgentStartupTimeoutMs: 45_000,
      }),
    ).toBe(90_000);
    expect(
      resolveWorkerStartupTimeoutMs({
        configuredMs: 10_000,
        docker: false,
        dockerAgentStartupTimeoutMs: 45_000,
      }),
    ).toBe(10_000);
  });
});
