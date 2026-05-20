import { describe, expect, test } from "bun:test";

import {
  buildRuntimeConfigToml,
  WORKERPAL_WARMUP_OUTCOME_PATTERN,
} from "../scripts/release-windows-runtime-smoke";

describe("release Windows runtime smoke config", () => {
  test("uses direct WorkerPal startup instead of Docker-backed sandbox startup", () => {
    const config = buildRuntimeConfigToml(32000);

    expect(config).toContain('url = "http://127.0.0.1:32000"');
    expect(config).toContain("port = 32000");
    expect(config).toContain("[remotebuddy]");
    expect(config).toContain("auto_spawn_workerpals = true");
    expect(config).toContain("min_workerpals = 1");
    expect(config).toContain("max_workerpals = 1");
    expect(config).toContain("workerpal_docker = false");
    expect(config).toContain("workerpal_require_docker = false");
    expect(config).not.toContain("workerpal_docker = true");
    expect(config).not.toContain("workerpal_require_docker = true");
  });

  test("accepts direct WorkerPal child startup logs as a warmup outcome", () => {
    expect(
      WORKERPAL_WARMUP_OUTCOME_PATTERN.test(
        "[WorkerPals workerpal-abc123] Polling http://127.0.0.1:3001 every 2000ms",
      ),
    ).toBe(true);
    expect(
      WORKERPAL_WARMUP_OUTCOME_PATTERN.test(
        "[WorkerPals workerpal-abc123] Direct mode with isolated worktrees enabled",
      ),
    ).toBe(true);
  });
});
