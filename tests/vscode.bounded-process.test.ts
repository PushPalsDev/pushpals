import { describe, expect, test } from "bun:test";
import {
  buildWindowsDescendantSweepArgs,
  runBoundedNodeCommand,
} from "../apps/vscode-client/src/boundedProcess";

describe("VS Code bounded subprocesses", () => {
  test("builds a bounded Windows orphan-descendant sweep", () => {
    const args = buildWindowsDescendantSweepArgs(4321);
    expect(args.slice(0, 6)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
    ]);
    const script = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
    expect(script).toContain("$rootPid = 4321");
    expect(script).toContain("Get-CimInstance Win32_Process");
  });

  test("terminates a helper process that never exits", async () => {
    const startedAt = Date.now();
    const result = await runBoundedNodeCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 50,
      drainTimeoutMs: 100,
    });

    expect(result.code).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain("timed out after 50ms");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test("caps retained output from noisy helpers", async () => {
    const result = await runBoundedNodeCommand({
      command: process.execPath,
      args: ["-e", "console.log('x'.repeat(5000))"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      outputLimitChars: 128,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("process output truncated");
    expect(result.stdout.length).toBeLessThan(256);
  });
});
