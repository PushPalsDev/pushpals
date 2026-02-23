import { describe, expect, test } from "bun:test";
import { buildWorkerSpawnCommand } from "../apps/remotebuddy/src/worker_spawn";

describe("remotebuddy worker spawn command", () => {
  test("builds bun run command with valid argument ordering", () => {
    const command = buildWorkerSpawnCommand({
      server: "http://localhost:3001",
      workerId: "workerpal-abc12345",
      pollMs: 2000,
      heartbeatMs: 5000,
      labels: ["autospawn", "background"],
      docker: true,
      requireDocker: true,
      dockerImage: "pushpals-worker-sandbox:latest",
    });

    expect(command.slice(0, 7)).toEqual([
      "bun",
      "run",
      "--cwd",
      "apps/workerpals",
      "--env-file",
      "../../.env",
      "src/workerpals_main.ts",
    ]);
    expect(command).toContain("--server");
    expect(command).toContain("http://localhost:3001");
    expect(command).toContain("--workerId");
    expect(command).toContain("workerpal-abc12345");
    expect(command).toContain("--docker");
    expect(command).toContain("--require-docker");
    expect(command).toContain("--docker-image");
    expect(command).toContain("pushpals-worker-sandbox:latest");
  });

  test("omits optional args when not configured", () => {
    const command = buildWorkerSpawnCommand({
      server: "http://localhost:3001",
      workerId: "workerpal-minimal",
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
});
