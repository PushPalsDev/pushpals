import { describe, expect, test } from "bun:test";
import {
  findDisallowedCliPackageEntries,
  findDisallowedReleaseArtifactEntries,
} from "../scripts/verify-cli-package-payload.ts";

describe("release package payload verification", () => {
  test("allows the expected CLI package payload shape without vendored tool binaries", () => {
    const issues = findDisallowedCliPackageEntries([
      { path: "README.md" },
      { path: "bin/pushpals.cjs" },
      { path: "dist/pushpals-cli.js" },
      { path: "runtime/configs/default.toml" },
      { path: "runtime/sandbox/bun.lock" },
      { path: "runtime/sandbox/apps/workerpals/uv.lock" },
      { path: "monitor-ui/assets/__node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf" },
    ]);

    expect(issues).toEqual([]);
  });

  test("rejects external toolchain binaries and runtime dependency directories", () => {
    const issues = findDisallowedCliPackageEntries([
      { path: "bin/pushpals.cjs" },
      { path: "dist/pushpals-cli.js" },
      { path: "runtime/bin/bun.exe" },
      { path: "runtime/bin/node" },
      { path: "runtime/bin/git.cmd" },
      { path: "runtime/bin/docker" },
      { path: "runtime/bin/codex" },
      { path: "runtime/bin/uv" },
      { path: "runtime/lib/native.node" },
      { path: "runtime/vendor/libsqlite3.so.0" },
      { path: "runtime/sandbox/node_modules/package/index.js" },
      { path: "runtime/sandbox/apps/workerpals/.venv/bin/python" },
    ]);

    expect(issues.map((issue) => issue.path)).toEqual([
      "runtime/bin/bun.exe",
      "runtime/bin/node",
      "runtime/bin/git.cmd",
      "runtime/bin/docker",
      "runtime/bin/codex",
      "runtime/bin/uv",
      "runtime/lib/native.node",
      "runtime/vendor/libsqlite3.so.0",
      "runtime/sandbox/node_modules/package/index.js",
      "runtime/sandbox/apps/workerpals/.venv/bin/python",
    ]);
  });

  test("rejects package payloads missing required CLI entry files", () => {
    const issues = findDisallowedCliPackageEntries([{ path: "README.md" }]);

    expect(issues).toEqual([
      {
        path: "bin/pushpals.cjs",
        reason: "required CLI package entry is missing",
      },
      {
        path: "dist/pushpals-cli.js",
        reason: "required CLI package entry is missing",
      },
    ]);
  });

  test("release artifact guard allows only PushPals release assets", () => {
    expect(
      findDisallowedReleaseArtifactEntries([
        "pushpals-linux-x64",
        "pushpals-windows-x64.exe",
        "pushpals-macos-x64",
        "pushpals-macos-arm64",
        "pushpals-runtime-server-linux-x64",
        "pushpals-runtime-source-control-manager-windows-x64.exe",
        "SHA256SUMS.txt",
        "SHA256SUMS.txt.asc",
      ]),
    ).toEqual([]);

    expect(
      findDisallowedReleaseArtifactEntries([
        "bun.exe",
        "node",
        "codex",
        "pushpals-runtime-workerpals-windows-x64.exe.old",
      ]).map((issue) => issue.path),
    ).toEqual(["bun.exe", "node", "codex", "pushpals-runtime-workerpals-windows-x64.exe.old"]);
  });
});
