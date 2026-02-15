import { describe, expect, test } from "bun:test";
import { shouldCommit } from "../apps/workerpals/src/execute_job";

describe("workerpals shouldCommit", () => {
  test("returns true for task.execute job kind", () => {
    expect(shouldCommit("task.execute")).toBe(true);
  });

  test("returns false for non-file-modifying job kinds", () => {
    expect(shouldCommit("warmup.execute")).toBe(false);
    expect(shouldCommit("other.job")).toBe(false);
    expect(shouldCommit("chat")).toBe(false);
  });
});