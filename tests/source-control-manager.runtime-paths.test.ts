import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { resolveSourceControlManagerRuntimeRepoRoot } from "../apps/source_control_manager/src/runtime_paths";

describe("source_control_manager runtime repo root resolution", () => {
  test("prefers the configured project root over the binary location", () => {
    expect(
      resolveSourceControlManagerRuntimeRepoRoot(
        "C:/Users/example/Documents/project",
        "C:/Users/example/.pushpals/runtime/bin/v1.0.16-windows-x64",
      ),
    ).toBe(resolve("C:/Users/example/Documents/project"));
  });

  test("falls back to process cwd when project root is unavailable", () => {
    expect(resolveSourceControlManagerRuntimeRepoRoot("", "/tmp/pushpals-repo")).toBe(
      resolve("/tmp/pushpals-repo"),
    );
  });
});
