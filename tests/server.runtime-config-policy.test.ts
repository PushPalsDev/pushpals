import { describe, expect, test } from "bun:test";
import {
  deriveRuntimeConfigImpact,
  normalizeRuntimeConfigKey,
} from "../apps/server/src/runtime_config_policy";

describe("server runtime config policy", () => {
  test("normalizes runtime config keys consistently", () => {
    expect(normalizeRuntimeConfigKey("localbuddy.statusHeartbeatMs")).toBe(
      "localbuddy.status_heartbeat_ms",
    );
    expect(normalizeRuntimeConfigKey("sourceControlManager.repoPath")).toBe(
      "source_control_manager.repo_path",
    );
  });

  test("treats localbuddy.enabled as live-safe with a supervisor warning", () => {
    const impact = deriveRuntimeConfigImpact(["localbuddy.enabled"]);

    expect(impact.restartRequiredKeys).toEqual([]);
    expect(impact.warnings).toContain(
      "localbuddy.enabled applies live when the stack is managed by bun run start or the VS Code stack manager; other supervisors may require restart.",
    );
  });

  test("marks other localbuddy config changes as restart-required", () => {
    const impact = deriveRuntimeConfigImpact([
      "localbuddy.port",
      "localbuddy.statusHeartbeatMs",
      "localbuddy.llm.model",
    ]);

    expect(impact.restartRequiredKeys).toEqual([
      "localbuddy.port",
      "localbuddy.statusHeartbeatMs",
      "localbuddy.llm.model",
    ]);
    expect(impact.warnings).toContain(
      "LocalBuddy config changes other than localbuddy.enabled require a LocalBuddy restart to take effect.",
    );
  });

  test("treats LOCALBUDDY_ENABLED env alias as the live-safe toggle", () => {
    const impact = deriveRuntimeConfigImpact(["LOCALBUDDY_ENABLED"]);

    expect(impact.restartRequiredKeys).toEqual([]);
    expect(impact.warnings).toContain(
      "localbuddy.enabled applies live when the stack is managed by bun run start or the VS Code stack manager; other supervisors may require restart.",
    );
  });

  test("marks LocalBuddy env aliases other than LOCALBUDDY_ENABLED as restart-required", () => {
    const impact = deriveRuntimeConfigImpact([
      "LOCAL_AGENT_PORT",
      "LOCALBUDDY_STATUS_HEARTBEAT_MS",
      "LOCALBUDDY_LLM_MODEL",
    ]);

    expect(impact.restartRequiredKeys).toEqual([
      "LOCAL_AGENT_PORT",
      "LOCALBUDDY_STATUS_HEARTBEAT_MS",
      "LOCALBUDDY_LLM_MODEL",
    ]);
    expect(impact.warnings).toContain(
      "LocalBuddy config changes other than localbuddy.enabled require a LocalBuddy restart to take effect.",
    );
  });

  test("keeps existing restart-required infra keys", () => {
    const impact = deriveRuntimeConfigImpact(["server.port", "paths.sharedDbPath"]);

    expect(impact.restartRequiredKeys).toEqual(["server.port", "paths.sharedDbPath"]);
  });
});
