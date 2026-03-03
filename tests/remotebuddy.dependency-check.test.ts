import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  notifyDependencyPreflightBlock,
  runDependencyPreflight,
} from "../apps/remotebuddy/src/startup/dependency_check";

type TempRepoOptions = {
  includeLock: boolean;
};

function createTempWorkspace(options: TempRepoOptions): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-deps-"));
  mkdirSync(join(dir, "configs"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"deps-test"}\n', "utf8");
  if (options.includeLock) {
    writeFileSync(join(dir, "bun.lock"), "lockfileVersion = 1\n", "utf8");
  }
  writeFileSync(join(dir, "configs", "default.toml"), "title = \"temp\"\n", "utf8");
  return dir;
}

describe("dependency preflight", () => {
  test("passes when workspace artifacts exist", async () => {
    const repo = createTempWorkspace({ includeLock: true });
    try {
      const outcome = await runDependencyPreflight(repo);
      expect(outcome.ok).toBe(true);
      expect(outcome.failure).toBeUndefined();
      expect(outcome.record.category).toBe("dependencies");
      expect(outcome.record.status).toBe("pass");
      expect(outcome.record.detail).toContain("detected");
      expect(outcome.record.step).toBe(0);
      expect(outcome.issues).toHaveLength(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("fails fast with actionable guidance when lockfile is missing", async () => {
    const repo = createTempWorkspace({ includeLock: false });
    try {
      const outcome = await runDependencyPreflight(repo);
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.code).toBe("dependencies.lockfile_missing");
      expect(outcome.failure?.action).toContain("bun install");
      expect(outcome.record.status).toBe("fail");
      expect(outcome.record.action).toContain("bun install");
      expect(outcome.issues).toHaveLength(1);
      expect(outcome.issues[0]?.label).toBe("bun.lock");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("notifyDependencyPreflightBlock surfaces canonical console output", async () => {
    const repo = createTempWorkspace({ includeLock: false });
    try {
      const outcome = await runDependencyPreflight(repo);
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      notifyDependencyPreflightBlock(outcome, repo);
      expect(errorSpy.mock.calls[0]?.[0]).toContain(
        "Dependency check blocked startup",
      );
      expect(
        errorSpy.mock.calls.some(([line]) => line.includes("missing bun.lock")),
      ).toBe(true);
      expect(
        errorSpy.mock.calls.some(([line]) => line.includes("bun install")),
      ).toBe(true);
      errorSpy.mockRestore();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
