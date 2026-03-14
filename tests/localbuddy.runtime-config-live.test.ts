import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyRuntimeConfigMutations } from "../apps/server/src/runtime_config";
import { loadLocalBuddyRuntimeSnapshotFromFiles } from "../packages/shared/src/localbuddy_runtime";

const tempDirs: string[] = [];
const originalLocalBuddyEnabled = process.env.LOCALBUDDY_ENABLED;
const originalLocalAgentPort = process.env.LOCAL_AGENT_PORT;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-localbuddy-live-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }

  if (originalLocalBuddyEnabled == null) delete process.env.LOCALBUDDY_ENABLED;
  else process.env.LOCALBUDDY_ENABLED = originalLocalBuddyEnabled;

  if (originalLocalAgentPort == null) delete process.env.LOCAL_AGENT_PORT;
  else process.env.LOCAL_AGENT_PORT = originalLocalAgentPort;
});

describe("localbuddy live runtime config integration", () => {
  test("env mutations become visible to live supervisors through the on-disk .env file", () => {
    const root = makeTempDir();
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "default.toml"),
      ['profile = "dev"', "", "[localbuddy]", "enabled = false", "port = 3003", ""].join("\n"),
      "utf8",
    );
    writeFileSync(join(root, ".env"), "LOCALBUDDY_ENABLED=false\nLOCAL_AGENT_PORT=3003\n", "utf8");
    writeFileSync(join(configDir, "local.toml"), "", "utf8");

    applyRuntimeConfigMutations(
      {
        envPath: join(root, ".env"),
        localTomlPath: join(configDir, "local.toml"),
        projectRoot: root,
      },
      [
        { scope: "env", key: "LOCALBUDDY_ENABLED", value: true },
        { scope: "env", key: "LOCAL_AGENT_PORT", value: 4111 },
      ],
    );

    const snapshot = loadLocalBuddyRuntimeSnapshotFromFiles(root, {
      LOCALBUDDY_ENABLED: "false",
      LOCAL_AGENT_PORT: "3003",
    });
    expect(snapshot).toEqual({
      localbuddy: {
        enabled: true,
        port: 4111,
      },
    });
  });

  test("toml mutations become visible to live supervisors when no env alias overrides them", () => {
    const root = makeTempDir();
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "default.toml"),
      ['profile = "dev"', "", "[localbuddy]", "enabled = false", "port = 3003", ""].join("\n"),
      "utf8",
    );
    writeFileSync(join(root, ".env"), "", "utf8");
    writeFileSync(join(configDir, "local.toml"), "", "utf8");

    applyRuntimeConfigMutations(
      {
        envPath: join(root, ".env"),
        localTomlPath: join(configDir, "local.toml"),
        projectRoot: root,
      },
      [{ scope: "toml", key: "localbuddy.enabled", value: true }],
    );

    const snapshot = loadLocalBuddyRuntimeSnapshotFromFiles(root, {});
    expect(snapshot.localbuddy.enabled).toBe(true);
    expect(snapshot.localbuddy.port).toBe(3003);
  });
});
