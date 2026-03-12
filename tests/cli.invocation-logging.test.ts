import { describe, expect, test } from "bun:test";

describe("pushpals CLI invocation logging", () => {
  test("prints invocation context before help output", async () => {
    const proc = Bun.spawn(["bun", "scripts/pushpals-cli.ts", "--help"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PUSHPALS_CLI_PACKAGE_VERSION: "1.0.5-test" },
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).toBe(0);
    expect(stderr.trim()).toBe("");
    expect(stdout).toContain("[pushpals] invocation=");
    expect(stdout).toContain("[pushpals] version=1.0.5-test");
    expect(stdout).toContain("[pushpals] platform=");
    expect(stdout).toContain("[pushpals] cwd=");
    expect(stdout).toContain("[pushpals] args=--help");
    expect(stdout).toContain("PushPals CLI");
  });
});
