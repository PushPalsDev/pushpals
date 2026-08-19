import { describe, expect, test } from "bun:test";
import { loadPushPalsConfig } from "shared";
import { executeWithOpenHands } from "../apps/workerpals/src/backends/openhands_task_execute";
import { inferWorkerTerminalFailureClass } from "../apps/workerpals/src/workerpals_main";

const RESULT_PREFIX = "__PUSHPALS_OPENHANDS_TEST_RESULT__ ";

function runtimeConfig() {
  const base = loadPushPalsConfig({ projectRoot: process.cwd() });
  return {
    ...base,
    workerpals: {
      ...base.workerpals,
      openhandsPython: process.execPath,
      openhandsTimeoutMs: 10_000,
      executorResultPrefix: RESULT_PREFIX,
    },
  } as never;
}

async function executeInjectedProcessResult(result: {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  drainTimedOut?: boolean;
}) {
  return executeWithOpenHands(
    "task.execute",
    {},
    process.cwd(),
    runtimeConfig(),
    undefined,
    undefined,
    {
      processRunner: (async () => ({
        stdout: result.stdout,
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
        timedOut: result.timedOut ?? false,
        drainTimedOut: result.drainTimedOut ?? false,
      })) as never,
    },
  );
}

function sentinel(payload: unknown): string {
  return `${RESULT_PREFIX}${JSON.stringify(payload)}\n`;
}

describe("OpenHands process-result authority", () => {
  test("rejects structured success after process timeout, nonzero exit, or drain timeout", async () => {
    const payload = { ok: true, summary: "wrapper claimed success", exitCode: 0 };
    const timedOut = await executeInjectedProcessResult({
      stdout: sentinel(payload),
      exitCode: 143,
      timedOut: true,
    });
    const exitedNonzero = await executeInjectedProcessResult({
      stdout: sentinel(payload),
      exitCode: 3,
    });
    const drainTimedOut = await executeInjectedProcessResult({
      stdout: sentinel(payload),
      drainTimedOut: true,
    });

    expect(timedOut).toMatchObject({ ok: false, exitCode: 124 });
    expect(exitedNonzero).toMatchObject({ ok: false, exitCode: 3 });
    expect(drainTimedOut).toMatchObject({ ok: false, exitCode: 124 });
    expect(inferWorkerTerminalFailureClass(timedOut)).toBe("timeout");
    expect(inferWorkerTerminalFailureClass(exitedNonzero)).toBe("nonzero_exit");
    expect(inferWorkerTerminalFailureClass(drainTimedOut)).toBe("timeout");
  });

  test("requires boolean ok and an optional finite integer exitCode", async () => {
    const malformedPayloads: unknown[] = [
      { summary: "missing ok", exitCode: 0 },
      { ok: "false", summary: "string ok", exitCode: 0 },
      { ok: true, summary: "string exit", exitCode: "3" },
      { ok: true, summary: "fractional exit", exitCode: 0.5 },
      [],
    ];

    for (const payload of malformedPayloads) {
      const result = await executeInjectedProcessResult({ stdout: sentinel(payload) });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.summary).toContain("malformed structured result");
      expect(result.diagnostics?.terminal?.failureClass).toBe("malformed_structured_result");
      expect(inferWorkerTerminalFailureClass(result)).toBe("malformed_structured_result");
    }
  });

  test("preserves valid explicit failure and exit-code-omitted success", async () => {
    const failure = await executeInjectedProcessResult({
      stdout: sentinel({ ok: false, summary: "valid failure", exitCode: 0 }),
    });
    const success = await executeInjectedProcessResult({
      stdout: sentinel({ ok: true, summary: "valid success" }),
    });

    expect(failure).toMatchObject({ ok: false, summary: "valid failure", exitCode: 0 });
    expect(success).toMatchObject({ ok: true, summary: "valid success", exitCode: 0 });
  });

  test("does not fall back to an older success after a malformed latest sentinel", async () => {
    for (const newestSentinel of [`${RESULT_PREFIX}{this-is-not-json`, RESULT_PREFIX.trimEnd()]) {
      const result = await executeInjectedProcessResult({
        stdout: [
          sentinel({ ok: true, summary: "stale success", exitCode: 0 }).trimEnd(),
          newestSentinel,
        ].join("\n"),
      });

      expect(result.ok).toBe(false);
      expect(result.summary).toContain("malformed structured result");
      expect(result.diagnostics?.terminal?.failureClass).toBe("malformed_structured_result");
    }
  });
});
