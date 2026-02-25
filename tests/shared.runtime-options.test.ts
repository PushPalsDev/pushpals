import { describe, expect, test } from "bun:test";
import {
  loadWorkerRuntimeOptions,
  resolveWorkerRuntimeDefaults,
  loadRemoteBuddyRuntimeOptions,
  loadLocalBuddyRuntimeOptions,
  RuntimeCliError,
  type WorkerRuntimeDefaults,
  type RemoteBuddyRuntimeDefaults,
  type LocalBuddyRuntimeDefaults,
} from "../packages/shared/src/runtime_options";
import { loadPushPalsConfig } from "../packages/shared/src/config";

const makeWorkerDefaults = (
  overrides: Partial<WorkerRuntimeDefaults> = {},
): WorkerRuntimeDefaults => ({
  serverUrl: "http://config",
  pollMs: 2000,
  heartbeatMs: 5000,
  repo: process.cwd(),
  authToken: null,
  requireDocker: false,
  dockerImage: "image",
  gitToken: null,
  dockerTimeoutMs: 600000,
  dockerIdleTimeoutMs: 600000,
  dockerNetworkMode: "bridge",
  worktreeBaseRef: "origin/main",
  labels: [],
  failureCooldownMs: 20000,
  ...overrides,
});

describe("shared runtime option loader", () => {
  test("merges worker CLI overrides and sanitizes flags", () => {
    const defaults: WorkerRuntimeDefaults = {
      serverUrl: "http://config",
      pollMs: 2000,
      heartbeatMs: 5000,
      repo: process.cwd(),
      authToken: "config-token",
      requireDocker: false,
      dockerImage: "config/image:latest",
      gitToken: "config-git",
      dockerTimeoutMs: 600000,
      dockerIdleTimeoutMs: 600000,
      dockerNetworkMode: "bridge",
      worktreeBaseRef: "origin/main",
      labels: ["default"],
      failureCooldownMs: 20000,
    };

    const opts = loadWorkerRuntimeOptions(
      [
        "--server",
        "http://cli",
        "--poll",
        "4000",
        "--heartbeat",
        "0",
        "--workerId",
        "worker-123",
        "--token",
        "cli-token",
        "--docker",
        "--require-docker",
        "--docker-image",
        "cli/image:tag",
        "--git-token",
        "cli-git",
        "--docker-timeout",
        "900000",
        "--docker-idle-timeout",
        "123456",
        "--docker-network",
        "host",
        "--base-ref",
        "origin/feature",
        "--labels",
        "fast,worker",
        "--failure-cooldown-ms",
        "999999",
      ],
      defaults,
    );

    expect(opts.server).toBe("http://cli");
    expect(opts.pollMs).toBe(4000);
    expect(opts.heartbeatMs).toBe(4000);
    expect(opts.workerId).toBe("worker-123");
    expect(opts.authToken).toBe("cli-token");
    expect(opts.docker).toBe(true);
    expect(opts.requireDocker).toBe(true);
    expect(opts.dockerImage).toBe("cli/image:tag");
    expect(opts.gitToken).toBe("cli-git");
    expect(opts.dockerTimeout).toBe(900000);
    expect(opts.dockerIdleTimeout).toBe(123456);
    expect(opts.dockerNetworkMode).toBe("host");
    expect(opts.worktreeBaseRef).toBe("origin/feature");
    expect(opts.labels).toEqual(["fast", "worker"]);
    expect(opts.failureCooldownMs).toBe(300000);
  });

  test("worker CLI rejects unknown and malformed flags", () => {
    const defaults: WorkerRuntimeDefaults = {
      serverUrl: "http://config",
      pollMs: 2000,
      heartbeatMs: 5000,
      repo: process.cwd(),
      authToken: null,
      requireDocker: false,
      dockerImage: "image",
      gitToken: null,
      dockerTimeoutMs: 600000,
      dockerIdleTimeoutMs: 600000,
      dockerNetworkMode: "bridge",
      worktreeBaseRef: "origin/main",
      labels: [],
      failureCooldownMs: 20000,
    };

    expect(() => loadWorkerRuntimeOptions(["--unknown"], defaults)).toThrow(RuntimeCliError);
    expect(() => loadWorkerRuntimeOptions(["--server=http://foo"], defaults)).toThrow(
      RuntimeCliError,
    );
    expect(() => loadWorkerRuntimeOptions(["--docker-image", ""], defaults)).toThrow(
      RuntimeCliError,
    );
  });

  test("worker CLI rejects missing values for required flags", () => {
    const defaults = makeWorkerDefaults();
    expect(() => loadWorkerRuntimeOptions(["--server"], defaults)).toThrow(RuntimeCliError);
    expect(() => loadWorkerRuntimeOptions(["--poll"], defaults)).toThrow(RuntimeCliError);
    expect(() => loadWorkerRuntimeOptions(["--heartbeat", " "], defaults)).toThrow(
      RuntimeCliError,
    );
    expect(() => loadWorkerRuntimeOptions(["--server", "   "], defaults)).toThrow(
      RuntimeCliError,
    );
  });

  test("remotebuddy CLI rejects unknown, malformed, and blank flag values", () => {
    const defaults: RemoteBuddyRuntimeDefaults = {
      serverUrl: "http://config",
      sessionId: "dev-session",
      authToken: "config-token",
    };
    expect(() => loadRemoteBuddyRuntimeOptions(["--nope"], defaults)).toThrow(RuntimeCliError);
    expect(() => loadRemoteBuddyRuntimeOptions(["--server=https://foo"], defaults)).toThrow(
      RuntimeCliError,
    );
    expect(() => loadRemoteBuddyRuntimeOptions(["--server", "   "], defaults)).toThrow(
      RuntimeCliError,
    );
    expect(() => loadRemoteBuddyRuntimeOptions(["--sessionId", ""], defaults)).toThrow(
      RuntimeCliError,
    );
    expect(() => loadRemoteBuddyRuntimeOptions(["--token"], defaults)).toThrow(RuntimeCliError);
  });

  test("localbuddy CLI rejects unknown, malformed, and blank flag values", () => {
    const defaults: LocalBuddyRuntimeDefaults = {
      serverUrl: "http://config",
      port: 3003,
      sessionId: "dev-session",
      authToken: null,
    };
    expect(() => loadLocalBuddyRuntimeOptions(["--unknown"], defaults)).toThrow(RuntimeCliError);
    expect(() => loadLocalBuddyRuntimeOptions(["--server=http://foo"], defaults)).toThrow(
      RuntimeCliError,
    );
    expect(() => loadLocalBuddyRuntimeOptions(["--server", ""], defaults)).toThrow(
      RuntimeCliError,
    );
    expect(() => loadLocalBuddyRuntimeOptions(["--sessionId", "   "], defaults)).toThrow(
      RuntimeCliError,
    );
    expect(() => loadLocalBuddyRuntimeOptions(["--port"], defaults)).toThrow(RuntimeCliError);
  });

  test("worker CLI honors CLI > env > config precedence", () => {
    const originalServer = process.env.PUSHPALS_SERVER_URL;
    process.env.PUSHPALS_SERVER_URL = "https://env-worker";
    const config = loadPushPalsConfig({ reload: true });
    const defaults = resolveWorkerRuntimeDefaults(config, {
      repo: process.cwd(),
    });

    const envResolved = loadWorkerRuntimeOptions([], defaults);
    expect(envResolved.server).toBe("https://env-worker");

    const cliResolved = loadWorkerRuntimeOptions(
      ["--server", "https://cli-worker"],
      defaults,
    );
    expect(cliResolved.server).toBe("https://cli-worker");

    if (originalServer === undefined) {
      delete process.env.PUSHPALS_SERVER_URL;
    } else {
      process.env.PUSHPALS_SERVER_URL = originalServer;
    }
    loadPushPalsConfig({ reload: true });
  });

  test("localbuddy and remotebuddy honor CLI > env > config precedence", () => {
    const originalServer = process.env.PUSHPALS_SERVER_URL;
    process.env.PUSHPALS_SERVER_URL = "https://env-server";
    const config = loadPushPalsConfig({ reload: true });
    const remoteDefaults: RemoteBuddyRuntimeDefaults = {
      serverUrl: config.server.url,
      sessionId: config.sessionId,
      authToken: config.authToken,
    };
    const optsFromEnv = loadRemoteBuddyRuntimeOptions([], remoteDefaults);
    expect(optsFromEnv.server).toBe("https://env-server");

    const optsFromCli = loadRemoteBuddyRuntimeOptions(
      ["--server", "https://cli"],
      remoteDefaults,
    );
    expect(optsFromCli.server).toBe("https://cli");

    const localDefaults: LocalBuddyRuntimeDefaults = {
      serverUrl: "http://config",
      port: 3003,
      sessionId: "dev",
      authToken: null,
    };
    const localOpts = loadLocalBuddyRuntimeOptions(
      ["--server", "http://cli", "--port", "4000", "--sessionId", "cli-session"],
      localDefaults,
    );
    expect(localOpts.server).toBe("http://cli");
    expect(localOpts.port).toBe(4000);
    expect(localOpts.sessionId).toBe("cli-session");

    if (originalServer === undefined) {
      delete process.env.PUSHPALS_SERVER_URL;
    } else {
      process.env.PUSHPALS_SERVER_URL = originalServer;
    }
    loadPushPalsConfig({ reload: true });
  });
});
