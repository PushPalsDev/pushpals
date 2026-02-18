import { describe, expect, test } from "bun:test";
import {
  normalizeRepoPathHint,
  plannerTargetPaths,
} from "../apps/remotebuddy/src/path_targeting";

describe("remotebuddy path targeting", () => {
  test("normalizes safe repo-relative hints", () => {
    expect(normalizeRepoPathHint("apps\\server\\src\\jobs.ts")).toBe("apps/server/src/jobs.ts");
    expect(normalizeRepoPathHint("/repo/apps/server/src/jobs.ts")).toBe("apps/server/src/jobs.ts");
    expect(normalizeRepoPathHint("./README.md")).toBe("README.md");
  });

  test("rejects path escapes and absolute paths", () => {
    expect(normalizeRepoPathHint("../secret.txt")).toBeNull();
    expect(normalizeRepoPathHint("/etc/passwd")).toBeNull();
    expect(normalizeRepoPathHint("C:\\Windows\\System32\\drivers\\etc\\hosts")).toBeNull();
  });

  test("derives scoped paths from planner hints and prompt", () => {
    const paths = plannerTargetPaths(
      {
        scope: { write_globs: ["apps/workerpals/src/**/*.ts"] },
        discovery: { likely_dirs: ["apps/workerpals/src"] },
      },
      "Please update `apps/workerpals/src/workerpals_main.ts`.",
    );
    expect(paths).toEqual(["apps/workerpals/src/workerpals_main.ts", "apps/workerpals/src"]);
  });

  test("falls back to repository root when no safe hints exist", () => {
    const paths = plannerTargetPaths(
      {
        scope: { write_globs: ["../outside/**"] },
        discovery: { likely_dirs: ["/etc"] },
      },
      "improve this",
    );
    expect(paths).toEqual(["."]);
  });
});
