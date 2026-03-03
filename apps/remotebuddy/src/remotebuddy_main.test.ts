import { describe, expect, test } from "bun:test";

import {
  guardStartupAndLaunchRemoteBuddy,
  type StartupCliArguments,
} from "./startup/startup_guard.js";
import {
  SystemPreflightError,
  SYSTEM_PREFLIGHT_FAILURE_CODES,
  type StartupPreflightFailurePayload,
} from "./startup/system_preflight.js";

describe("guardStartupAndLaunchRemoteBuddy", () => {
  test("invokes orchestrator when preflight passes", async () => {
    const cli: StartupCliArguments = {
      server: "http://localhost:3001",
      sessionId: "session-123",
      authToken: "token",
    };
    const guardCalls: number[] = [];
    const startInvocations: StartupCliArguments[] = [];
    const guard = async (next: () => Promise<void>) => {
      guardCalls.push(guardCalls.length);
      await next();
    };
    const start = async (opts: StartupCliArguments) => {
      startInvocations.push(opts);
    };
    await expect(
      guardStartupAndLaunchRemoteBuddy(cli, start, { guard }),
    ).resolves.toBeUndefined();
    expect(guardCalls).toHaveLength(1);
    expect(startInvocations).toEqual([cli]);
  });

  test("blocks orchestrator launch when preflight rejects", async () => {
    const cli: StartupCliArguments = {
      server: "http://localhost:3001",
      sessionId: null,
      authToken: null,
    };
    const startInvocations: StartupCliArguments[] = [];
    const failurePayload: StartupPreflightFailurePayload = {
      phase: "startup_preflight_failure",
      step: 1,
      code: SYSTEM_PREFLIGHT_FAILURE_CODES.ENVIRONMENT_MISSING,
      category: "env",
      detail: "missing env var",
      action: "set env var",
    };
    const guardError = new SystemPreflightError(failurePayload);
    const guard = async () => {
      throw guardError;
    };
    await expect(
      guardStartupAndLaunchRemoteBuddy(cli, async (opts) => startInvocations.push(opts), {
        guard,
      }),
    ).rejects.toBe(guardError);
    expect(startInvocations).toHaveLength(0);
  });
});
