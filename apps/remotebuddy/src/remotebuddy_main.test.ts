import { describe, expect, test } from "bun:test";

import {
  guardStartupAndLaunchRemoteBuddy,
  handleRemoteBuddyStartupError,
  RemoteBuddyPreflightError,
  RemoteBuddyUsageError,
  type GuardStartupAndLaunchParams,
  type RemoteBuddyLaunchOptions,
} from "./remotebuddy_main.js";
import {
  STARTUP_FAILURE_CODES,
  type StartupCheckRecord,
  type StartupChecklistContext,
  type StartupChecklistFailure,
} from "./startup/checklist.js";

const baseContext: StartupChecklistContext = {
  describeRepo: async () => ({
    isDirty: false,
    isMergeInProgress: false,
  }),
  listFiringAlerts: async () => [],
  syntheticTester: {
    runSyntheticJob: async () => ({ ok: true, latencyMs: 25 }),
  },
};

const sampleRecord: StartupCheckRecord = {
  code: STARTUP_FAILURE_CODES.REPO_DIRTY,
  label: "Worktree must be clean.",
  category: "repo",
  step: 1,
  status: "pass",
  detail: "Worktree is clean.",
  elapsedMs: 5,
};

const sampleFailure: StartupChecklistFailure = {
  code: STARTUP_FAILURE_CODES.REPO_DIRTY,
  detail: "dirty repo",
  action: "Clean the worktree.",
  category: "repo",
  step: 2,
};

const serverArgv = ["--server", "http://cli.test"];

const noopStdout = (_line?: string) => {};

const baseContextFactory: GuardStartupAndLaunchParams["createChecklistContext"] = async (
  _input,
) => baseContext;

describe("guardStartupAndLaunchRemoteBuddy", () => {
  test("preflight pass launches orchestrator exactly once", async () => {
    const launches: RemoteBuddyLaunchOptions[] = [];
    const lines: string[] = [];
    await guardStartupAndLaunchRemoteBuddy({
      argv: serverArgv,
      stdout: (line) => lines.push(line),
      stderr: noopStdout,
      createChecklistContext: baseContextFactory,
      runStartupPreflight: async () => ({ ok: true, history: [sampleRecord] }),
      launchRemoteBuddy: async (opts) => {
        launches.push(opts);
      },
    });
    expect(launches).toHaveLength(1);
    expect(lines.some((line) => line.includes("Startup preflight passed"))).toBe(true);
  });

  test("preflight failure blocks launch and surfaces actionable error", async () => {
    const stderr: string[] = [];
    const launches: RemoteBuddyLaunchOptions[] = [];
    await expect(
      guardStartupAndLaunchRemoteBuddy({
        argv: serverArgv,
        stdout: noopStdout,
        stderr: (line) => stderr.push(line),
        createChecklistContext: baseContextFactory,
        runStartupPreflight: async () => ({
          ok: false,
          failure: sampleFailure,
          history: [],
        }),
        launchRemoteBuddy: async (opts) => {
          launches.push(opts);
        },
      }),
    ).rejects.toBeInstanceOf(RemoteBuddyPreflightError);
    expect(launches).toHaveLength(0);
    expect(stderr.join("\n")).toContain(sampleFailure.action);
  });

  test("prints usage for --help without running preflight", async () => {
    const stdout: string[] = [];
    let preflightCalls = 0;
    await guardStartupAndLaunchRemoteBuddy({
      argv: ["--help"],
      stdout: (line) => stdout.push(line),
      stderr: noopStdout,
      runStartupPreflight: async () => {
        preflightCalls += 1;
        return { ok: true, history: [sampleRecord] };
      },
      createChecklistContext: baseContextFactory,
      launchRemoteBuddy: async () => {
        throw new Error("should not launch");
      },
    });
    expect(preflightCalls).toBe(0);
    expect(stdout.join("\n")).toContain("Usage:");
  });

  test("prints version for --version without launching", async () => {
    const stdout: string[] = [];
    await guardStartupAndLaunchRemoteBuddy({
      argv: ["--version"],
      stdout: (line) => stdout.push(line),
      stderr: noopStdout,
      runStartupPreflight: async () => {
        throw new Error("preflight should not run");
      },
      createChecklistContext: baseContextFactory,
      launchRemoteBuddy: async () => {
        throw new Error("should not launch");
      },
    });
    expect(stdout.join("\n")).toMatch(/RemoteBuddy/i);
  });

  test("preflight-only mode exits before launching", async () => {
    const stdout: string[] = [];
    let launches = 0;
    await guardStartupAndLaunchRemoteBuddy({
      argv: [...serverArgv, "--preflight-only"],
      stdout: (line) => stdout.push(line),
      stderr: noopStdout,
      createChecklistContext: baseContextFactory,
      runStartupPreflight: async () => ({ ok: true, history: [sampleRecord] }),
      launchRemoteBuddy: async () => {
        launches += 1;
      },
    });
    expect(launches).toBe(0);
    expect(stdout.join("\n")).toContain("--preflight-only");
  });

  test("skip-preflight launches without invoking preflight pipeline", async () => {
    let preflightCalls = 0;
    let launches = 0;
    await guardStartupAndLaunchRemoteBuddy({
      argv: [...serverArgv, "--skip-preflight"],
      stdout: noopStdout,
      stderr: noopStdout,
      createChecklistContext: baseContextFactory,
      runStartupPreflight: async () => {
        preflightCalls += 1;
        return { ok: true, history: [sampleRecord] };
      },
      launchRemoteBuddy: async () => {
        launches += 1;
      },
    });
    expect(preflightCalls).toBe(0);
    expect(launches).toBe(1);
  });

  test("conflicting flags throw usage error", async () => {
    await expect(
      guardStartupAndLaunchRemoteBuddy({
        argv: [...serverArgv, "--preflight-only", "--skip-preflight"],
        stdout: noopStdout,
        stderr: noopStdout,
        createChecklistContext: baseContextFactory,
        runStartupPreflight: async () => ({ ok: true, history: [sampleRecord] }),
        launchRemoteBuddy: async () => {},
      }),
    ).rejects.toBeInstanceOf(RemoteBuddyUsageError);
  });

  test("unknown flags produce usage errors", async () => {
    await expect(
      guardStartupAndLaunchRemoteBuddy({
        argv: ["--unknown-flag"],
        stdout: noopStdout,
        stderr: noopStdout,
        createChecklistContext: baseContextFactory,
        runStartupPreflight: async () => ({ ok: true, history: [sampleRecord] }),
        launchRemoteBuddy: async () => {},
      }),
    ).rejects.toBeInstanceOf(RemoteBuddyUsageError);
  });

  test("empty inline flag values are rejected", async () => {
    await expect(
      guardStartupAndLaunchRemoteBuddy({
        argv: ["--server="],
        stdout: noopStdout,
        stderr: noopStdout,
        createChecklistContext: baseContextFactory,
        runStartupPreflight: async () => ({ ok: true, history: [sampleRecord] }),
        launchRemoteBuddy: async () => {},
      }),
    ).rejects.toBeInstanceOf(RemoteBuddyUsageError);
  });

  test("missing server config surfaces a usage error", async () => {
    await expect(
      guardStartupAndLaunchRemoteBuddy({
        argv: [],
        stdout: noopStdout,
        stderr: noopStdout,
        createChecklistContext: baseContextFactory,
        runStartupPreflight: async () => ({ ok: true, history: [sampleRecord] }),
        launchRemoteBuddy: async () => {},
        configOverrides: { serverUrl: "" },
      }),
    ).rejects.toBeInstanceOf(RemoteBuddyUsageError);
  });
});

describe("handleRemoteBuddyStartupError", () => {
  test("usage errors map to exit code 64 and print usage help", () => {
    const stderr: string[] = [];
    const exitSignal = new Error("exit");
    let exitCode: number | undefined;
    expect(() =>
      handleRemoteBuddyStartupError(new RemoteBuddyUsageError("bad input"), {
        stderr: (line) => stderr.push(line),
        exit: (code?: number): never => {
          exitCode = code;
          throw exitSignal;
        },
        version: "1.2.3",
      }),
    ).toThrow(exitSignal);
    expect(exitCode).toBe(64);
    expect(stderr[0]).toContain("bad input");
    expect(stderr.some((line) => line.includes("Usage"))).toBe(true);
  });

  test("preflight errors exit with code 1 and surface failure detail", () => {
    const stderr: string[] = [];
    const exitSignal = new Error("exit");
    let exitCode: number | undefined;
    expect(() =>
      handleRemoteBuddyStartupError(
        new RemoteBuddyPreflightError("blocked", sampleFailure),
        {
          stderr: (line) => stderr.push(line),
          exit: (code?: number): never => {
            exitCode = code;
            throw exitSignal;
          },
        },
      ),
    ).toThrow(exitSignal);
    expect(exitCode).toBe(1);
    expect(stderr.some((line) => line.includes(sampleFailure.code))).toBe(true);
  });

  test("unexpected runtime errors exit with code 1 and include stack detail", () => {
    const stderr: string[] = [];
    const exitSignal = new Error("exit");
    let exitCode: number | undefined;
    const fatal = new Error("boom");
    fatal.stack = "FatalStackTrace";
    expect(() =>
      handleRemoteBuddyStartupError(fatal, {
        stderr: (line) => stderr.push(line),
        exit: (code?: number): never => {
          exitCode = code;
          throw exitSignal;
        },
      }),
    ).toThrow(exitSignal);
    expect(exitCode).toBe(1);
    const lastLine = stderr[stderr.length - 1] ?? "";
    expect(lastLine).toContain("Fatal");
  });
});
