import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveWorkerpalsSourcePath } from "../apps/workerpals/src/common/runtime_paths";

const originalSourceRoot = process.env.PUSHPALS_WORKERPALS_SOURCE_ROOT;

afterEach(() => {
  if (originalSourceRoot === undefined) {
    delete process.env.PUSHPALS_WORKERPALS_SOURCE_ROOT;
  } else {
    process.env.PUSHPALS_WORKERPALS_SOURCE_ROOT = originalSourceRoot;
  }
});

describe("packaged WorkerPal runtime paths", () => {
  test("resolves Python backends from the explicit packaged src root", () => {
    process.env.PUSHPALS_WORKERPALS_SOURCE_ROOT = "/runtime/sandbox/apps/workerpals/src";

    expect(
      resolveWorkerpalsSourcePath("backends", "openai_codex", "openai_codex_executor.py"),
    ).toBe(
      resolve(
        "/runtime/sandbox/apps/workerpals/src",
        "backends",
        "openai_codex",
        "openai_codex_executor.py",
      ),
    );
  });

  test("defaults to the source tree root beside the common module", () => {
    delete process.env.PUSHPALS_WORKERPALS_SOURCE_ROOT;

    expect(resolveWorkerpalsSourcePath("backends", "miniswe", "miniswe_executor.py")).toBe(
      resolve(
        import.meta.dir,
        "..",
        "apps",
        "workerpals",
        "src",
        "backends",
        "miniswe",
        "miniswe_executor.py",
      ),
    );
  });
});
