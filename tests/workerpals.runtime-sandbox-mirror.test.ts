import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

import * as sourceSandboxEnv from "../apps/workerpals/src/common/sandbox_env";
import * as packagedSandboxEnv from "../packages/cli/runtime/sandbox/apps/workerpals/src/common/sandbox_env";

const MIRRORED_WORKERPALS_FILES = [
  "common/direct_worktree.ts",
  "common/sandbox_env.ts",
  "common/generic_python_executor.ts",
  "backends/openhands_task_execute.ts",
  "docker_executor.ts",
  "execute_job.ts",
  "merge_conflict_job.ts",
  "workerpals_main.ts",
  "worktree_base_ref.ts",
] as const;

describe("packaged WorkerPal sandbox runtime parity", () => {
  test("keeps path and review-lease runtime files byte-identical", () => {
    for (const relativePath of MIRRORED_WORKERPALS_FILES) {
      const sourcePath = resolve("apps", "workerpals", "src", relativePath);
      const packagedPath = resolve(
        "packages",
        "cli",
        "runtime",
        "sandbox",
        "apps",
        "workerpals",
        "src",
        relativePath,
      );

      expect(readFileSync(packagedPath)).toEqual(readFileSync(sourcePath));
    }
  });

  test("exports the same compact Windows root contract from source and package", () => {
    expect(packagedSandboxEnv.WINDOWS_WORKER_SANDBOX_ROOT_NAME).toBe(
      sourceSandboxEnv.WINDOWS_WORKER_SANDBOX_ROOT_NAME,
    );
    expect(packagedSandboxEnv.WINDOWS_WORKER_SANDBOX_ROOT_NAME).toBe(".ppe");
  });

  test("derives identical roots for long Windows and non-Windows repository paths", () => {
    const scenarios: Array<{
      repo: string;
      platform: NodeJS.Platform;
      home: string;
      temp: string;
    }> = [
      {
        repo: "C:\\Users\\worker\\Documents\\very-long-parent\\another-long-parent\\SectorCommand",
        platform: "win32",
        home: "C:\\Users\\worker",
        temp: "C:\\Users\\worker\\AppData\\Local\\Temp",
      },
      {
        repo: "/srv/builds/projects/a-very-long-repository/SectorCommand",
        platform: "linux",
        home: "/home/worker",
        temp: "/tmp",
      },
    ];

    for (const scenario of scenarios) {
      expect(
        packagedSandboxEnv.resolveWorkerSandboxRoot(
          scenario.repo,
          scenario.platform,
          scenario.home,
          scenario.temp,
        ),
      ).toBe(
        sourceSandboxEnv.resolveWorkerSandboxRoot(
          scenario.repo,
          scenario.platform,
          scenario.home,
          scenario.temp,
        ),
      );
    }
  });
});
