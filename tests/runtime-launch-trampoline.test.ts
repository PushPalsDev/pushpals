import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const trampoline = resolve(import.meta.dir, "..", "scripts", "runtime-launch-trampoline.ts");

describe("embedded runtime launch trampoline", () => {
  test("rejects an empty child command immediately", () => {
    const result = spawnSync(process.execPath, [trampoline], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("missing child command");
  });

  test("reports child creation before forwarding output and exit status", () => {
    const result = spawnSync(
      process.execPath,
      [
        trampoline,
        "--",
        process.execPath,
        "-e",
        'console.log("fixture-child-output"); process.exit(7)',
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      },
    );

    expect(result.status).toBe(7);
    expect(result.stdout).toContain("[pushpals-launch-trampoline] child-started");
    expect(result.stdout).toContain("fixture-child-output");
  });
});
