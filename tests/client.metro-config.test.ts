import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const metroConfigPath = resolve(import.meta.dir, "..", "apps", "client", "metro.config.js");
const metroConfig = require(metroConfigPath) as {
  watchFolders?: string[];
  resolver?: {
    nodeModulesPaths?: string[];
    blockList?: RegExp | RegExp[];
  };
};

describe("client metro config", () => {
  test("keeps watchFolders scoped to workspace packages only", () => {
    const expectedPackagesRoot = resolve(import.meta.dir, "..", "packages");
    expect(metroConfig.watchFolders).toEqual([expectedPackagesRoot]);
  });

  test("resolves modules from app-level node_modules only", () => {
    const expectedAppNodeModules = resolve(import.meta.dir, "..", "apps", "client", "node_modules");
    expect(metroConfig.resolver?.nodeModulesPaths).toEqual([expectedAppNodeModules]);
  });

  test("blocks repo-root workspace links under node_modules", () => {
    const sampleWorkspaceLink = resolve(
      import.meta.dir,
      "..",
      "node_modules",
      "client",
    );
    const blockList = metroConfig.resolver?.blockList;
    const patterns = Array.isArray(blockList) ? blockList : blockList ? [blockList] : [];
    expect(patterns.some((pattern) => pattern.test(sampleWorkspaceLink))).toBe(true);
  });
});

