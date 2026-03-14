import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  computeLocalBuddyRestartBackoffMs,
  DEFAULT_LOCALBUDDY_PORT,
  loadRuntimeConfigSnapshotFromFiles,
  parseRuntimeConfigSnapshot,
  resolveLocalBuddyRuntimeAction,
  resolveLocalBuddyStartGate,
} from "../apps/vscode-client/src/runtimeServicePolicy";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-vscode-runtime-policy-"));
  tempDirs.push(dir);
  return dir;
}

describe("vscode runtime service policy", () => {
  test("parses runtime snapshot with localbuddy enabled state and port", () => {
    const snapshot = parseRuntimeConfigSnapshot(
      JSON.stringify({
        localbuddy: {
          enabled: true,
          port: 4100,
        },
      }),
    );

    expect(snapshot).toEqual({
      localbuddy: {
        enabled: true,
        port: 4100,
      },
    });
  });

  test("falls back to the default localbuddy port when snapshot port is invalid", () => {
    const snapshot = parseRuntimeConfigSnapshot(
      JSON.stringify({
        localbuddy: {
          enabled: false,
          port: "not-a-port",
        },
      }),
    );

    expect(snapshot.localbuddy.port).toBe(DEFAULT_LOCALBUDDY_PORT);
  });

  test("rejects invalid runtime snapshot payloads", () => {
    expect(() => parseRuntimeConfigSnapshot("[]")).toThrow(
      "runtime config snapshot must be a JSON object",
    );
    expect(() => parseRuntimeConfigSnapshot("{}")).toThrow(
      "runtime config snapshot must include localbuddy",
    );
  });

  test("resolves localbuddy runtime actions from running and enabled state", () => {
    expect(resolveLocalBuddyRuntimeAction(false, true)).toBe("start");
    expect(resolveLocalBuddyRuntimeAction(true, false)).toBe("stop");
    expect(resolveLocalBuddyRuntimeAction(false, false)).toBe("noop");
    expect(resolveLocalBuddyRuntimeAction(true, true)).toBe("noop");
  });

  test("applies exponential restart backoff and stop gates for repeated failures", () => {
    expect(computeLocalBuddyRestartBackoffMs(1)).toBe(5_000);
    expect(computeLocalBuddyRestartBackoffMs(3)).toBe(20_000);
    expect(computeLocalBuddyRestartBackoffMs(10)).toBe(60_000);

    expect(
      resolveLocalBuddyStartGate({
        nowMs: 1_000,
        retryAfterMs: 0,
        consecutiveFailures: 0,
        maxConsecutiveFailures: 5,
      }),
    ).toBe("ready");
    expect(
      resolveLocalBuddyStartGate({
        nowMs: 1_000,
        retryAfterMs: 2_000,
        consecutiveFailures: 1,
        maxConsecutiveFailures: 5,
      }),
    ).toBe("backoff");
    expect(
      resolveLocalBuddyStartGate({
        nowMs: 10_000,
        retryAfterMs: 9_000,
        consecutiveFailures: 5,
        maxConsecutiveFailures: 5,
      }),
    ).toBe("retry_exhausted");
  });

  test("loads the localbuddy runtime snapshot from config files with env overrides", () => {
    const root = makeTempDir();
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "default.toml"),
      ['profile = "dev"', "", "[localbuddy]", "enabled = false", "port = 3003", ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(configDir, "dev.toml"),
      ["[localbuddy]", "enabled = true", "port = 3100", ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(configDir, "local.example.toml"),
      ["[localbuddy]", "port = 3200", ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(configDir, "local.toml"),
      ["[localbuddy]", "enabled = false", "port = 3300", ""].join("\n"),
      "utf8",
    );

    const snapshot = loadRuntimeConfigSnapshotFromFiles(root, {
      PUSHPALS_PROFILE: "dev",
      LOCALBUDDY_ENABLED: "true",
      LOCAL_AGENT_PORT: "3400",
    });

    expect(snapshot).toEqual({
      localbuddy: {
        enabled: true,
        port: 3400,
      },
    });
  });

  test("prefers on-disk .env overrides over inherited process env for live runtime state", () => {
    const root = makeTempDir();
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "default.toml"),
      ['profile = "dev"', "", "[localbuddy]", "enabled = false", "port = 3003", ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(root, ".env"),
      ["LOCALBUDDY_ENABLED=true", "LOCAL_AGENT_PORT=3600", ""].join("\n"),
      "utf8",
    );

    const snapshot = loadRuntimeConfigSnapshotFromFiles(root, {
      LOCALBUDDY_ENABLED: "false",
      LOCAL_AGENT_PORT: "3003",
    });

    expect(snapshot).toEqual({
      localbuddy: {
        enabled: true,
        port: 3600,
      },
    });
  });

  test("falls back to legacy config/ when configs/default.toml is absent", () => {
    const root = makeTempDir();
    const legacyDir = join(root, "config");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "default.toml"),
      ['profile = "dev"', "", "[localbuddy]", "enabled = true", "port = 3555", ""].join("\n"),
      "utf8",
    );

    const snapshot = loadRuntimeConfigSnapshotFromFiles(root, {});
    expect(snapshot.localbuddy.enabled).toBe(true);
    expect(snapshot.localbuddy.port).toBe(3555);
  });
});
