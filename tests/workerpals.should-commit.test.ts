import { describe, expect, test } from "bun:test";
import { shouldCommit } from "../apps/workerpals/src/execute_job";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("workerpals shouldCommit", () => {
  test("returns true for task.execute job kind", () => {
    expect(shouldCommit("task.execute")).toBe(true);
  });

  test("returns false for non-file-modifying job kinds", () => {
    expect(shouldCommit("warmup.execute")).toBe(false);
    expect(shouldCommit("other.job")).toBe(false);
    expect(shouldCommit("chat")).toBe(false);
  });

  test("respects runtime-configured file modifying jobs", () => {
    const base = loadPushPalsConfig({ reload: true });
    const runtimeConfig = {
      ...base,
      workerpals: {
        ...base.workerpals,
        fileModifyingJobs: ["warmup.execute"],
      },
    };

    expect(shouldCommit("task.execute", runtimeConfig)).toBe(false);
    expect(shouldCommit("warmup.execute", runtimeConfig)).toBe(true);
  });
});
