import { describe, expect, test } from "bun:test";
import type { RunPreflightResult } from "./preflight_cli.js";
import { runRemoteBuddyPreflightCliCommand } from "./preflight_cli.js";

const collectWriter = () => {
  const chunks: string[] = [];
  return {
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
      },
    },
    read: () => chunks.join(""),
  };
};

describe("runRemoteBuddyPreflightCliCommand", () => {
  test("returns exitCode=1 with structured stderr when runPreflightImpl throws", async () => {
    const stdout = collectWriter();
    const stderr = collectWriter();
    const failingPreflight = async (): Promise<RunPreflightResult> => {
      throw new Error("boom");
    };

    const { exitCode } = await runRemoteBuddyPreflightCliCommand({
      runPreflight: failingPreflight,
      stdout: stdout.writer,
      stderr: stderr.writer,
    });
    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    const payload = JSON.parse(stderr.read());
    expect(payload).toEqual({
      ok: false,
      exitCode: 1,
      message: "RemoteBuddy preflight crashed unexpectedly.",
      detail: expect.stringContaining("boom"),
      usage: "bun run remotebuddy:preflight [--allow-dirty-worktree] [--json]",
    });
  });
});
