import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";

import * as sourceSandboxEnv from "../apps/workerpals/src/common/sandbox_env";
import * as packagedSandboxEnv from "../packages/cli/runtime/sandbox/apps/workerpals/src/common/sandbox_env";

const repoRoot = resolve(import.meta.dir, "..");
const packagedSandboxRoot = process.env.PUSHPALS_PACKAGED_RUNTIME_ROOT
  ? resolve(process.env.PUSHPALS_PACKAGED_RUNTIME_ROOT)
  : resolve(repoRoot, "packages", "cli", "runtime", "sandbox");
const MIRRORED_RUNTIME_TREES = [
  {
    sourceRoot: "apps/workerpals",
    packagedRoot: "apps/workerpals",
  },
  {
    sourceRoot: "packages/shared",
    packagedRoot: "packages/shared",
  },
  {
    sourceRoot: "packages/protocol",
    packagedRoot: "packages/protocol",
  },
] as const;

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

function listTrackedTreeFiles(sourceRoot: string): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "--", sourceRoot], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(
    result.exitCode,
    Buffer.from(result.stderr).toString("utf8") || `git ls-files failed for ${sourceRoot}`,
  ).toBe(0);
  const prefix = `${normalizePath(sourceRoot)}/`;
  return Buffer.from(result.stdout)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .map((pathValue) => {
      expect(pathValue.startsWith(prefix), pathValue).toBe(true);
      return pathValue.slice(prefix.length);
    })
    .sort();
}

function listPackagedTreeFiles(packagedRoot: string): string[] {
  const absoluteRoot = resolve(packagedSandboxRoot, packagedRoot);
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(normalizePath(relative(absoluteRoot, absolutePath)));
      }
    }
  };
  visit(absoluteRoot);
  return files.sort();
}

describe("packaged WorkerPal sandbox runtime parity", () => {
  test("keeps every tracked sandbox runtime file byte-identical", () => {
    for (const tree of MIRRORED_RUNTIME_TREES) {
      const trackedFiles = listTrackedTreeFiles(tree.sourceRoot);
      const packagedFiles = listPackagedTreeFiles(tree.packagedRoot);
      expect(packagedFiles, tree.packagedRoot).toEqual(trackedFiles);

      for (const relativePath of trackedFiles) {
        const sourcePath = resolve(repoRoot, tree.sourceRoot, relativePath);
        const packagedPath = resolve(packagedSandboxRoot, tree.packagedRoot, relativePath);
        expect(readFileSync(packagedPath), `${tree.packagedRoot}/${relativePath}`).toEqual(
          readFileSync(sourcePath),
        );
      }
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
