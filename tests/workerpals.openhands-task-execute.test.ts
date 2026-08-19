import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPushPalsConfig } from "shared";
import { executeWithOpenHands } from "../apps/workerpals/src/backends/openhands_task_execute";
import { inferWorkerTerminalFailureClass } from "../apps/workerpals/src/workerpals_main";

const RESULT_PREFIX = "__PUSHPALS_OPENHANDS_TEST_RESULT__ ";

function runtimeConfig(openhandsTimeoutMs = 10_000) {
  const base = loadPushPalsConfig({ projectRoot: process.cwd() });
  return {
    ...base,
    workerpals: {
      ...base.workerpals,
      openhandsPython: process.execPath,
      openhandsTimeoutMs,
      executorResultPrefix: RESULT_PREFIX,
    },
  } as never;
}

async function executeRealFakeWrapper(
  scenario: "success" | "nonzero" | "timeout_after_success" | "malformed" | "drain_timeout",
  options: { timeoutMs?: number; onLog?: (stream: "stdout" | "stderr", line: string) => void } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pushpals-fake-openhands-"));
  const scriptPath = join(root, "fake_openhands.ts");
  writeFileSync(
    scriptPath,
    `import { readFileSync } from "fs";

const prefix = ${JSON.stringify(RESULT_PREFIX)};
const payloadFlag = process.argv.indexOf("--payload-file");
if (payloadFlag < 0 || !process.argv[payloadFlag + 1]) {
  throw new Error("missing --payload-file");
}
const payloadBase64 = readFileSync(process.argv[payloadFlag + 1], "utf8");
const payload = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf8"));
if (["scriptPath", "minimumTimeoutMs", "processRunner"].some((key) => key in payload)) {
  throw new Error("test-only execution option leaked into the wrapper payload");
}
const scenario = payload.params.scenario;
const result = (value: unknown) => console.log(prefix + JSON.stringify(value));
const success = { ok: true, summary: "fake wrapper success", stdout: "structured stdout", stderr: "", exitCode: 0 };

switch (scenario) {
  case "success":
    console.log("fake wrapper streamed output");
    result(success);
    break;
  case "nonzero":
    result(success);
    process.exit(7);
  case "timeout_after_success":
    setTimeout(() => result(success), 25);
    await new Promise(() => undefined);
    break;
  case "malformed":
    result(success);
    console.log(prefix + "{not-json");
    break;
  case "drain_timeout": {
    result(success);
    const child = Bun.spawn(
      [process.execPath, "-e", "setTimeout(() => process.exit(0), 10_000)"],
      { stdin: "ignore", stdout: 1, stderr: 2, detached: process.platform === "win32" },
    );
    child.unref();
    break;
  }
}
`,
  );

  try {
    return await executeWithOpenHands(
      "task.execute",
      { scenario },
      process.cwd(),
      runtimeConfig(options.timeoutMs ?? 2_000),
      options.onLog,
      undefined,
      { scriptPath, minimumTimeoutMs: 1 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  test("retains the packaged wrapper path and 10-second production timeout floor by default", async () => {
    let capturedArgv: string[] = [];
    let capturedTimeoutMs = 0;
    const result = await executeWithOpenHands(
      "task.execute",
      {},
      process.cwd(),
      runtimeConfig(1),
      undefined,
      undefined,
      {
        processRunner: (async (argv, options) => {
          capturedArgv = argv;
          capturedTimeoutMs = options.timeoutMs;
          return {
            stdout: sentinel({ ok: true, summary: "default behavior", exitCode: 0 }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
            drainTimedOut: false,
          };
        }) as never,
      },
    );

    expect(capturedArgv[0]).toBe(process.execPath);
    expect(
      capturedArgv[1]?.replace(/\\/g, "/").endsWith("/backends/openhands/openhands_executor.py"),
    ).toBe(true);
    expect(capturedTimeoutMs).toBe(10_000);
    expect(result).toMatchObject({ ok: true, summary: "default behavior", exitCode: 0 });
    expect(result).not.toHaveProperty("scriptPath");
    expect(result).not.toHaveProperty("minimumTimeoutMs");
    expect(result).not.toHaveProperty("processRunner");
  });

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

describe("OpenHands real subprocess boundary", () => {
  test("transports the payload and accepts a successful wrapper result", async () => {
    const logs: string[] = [];
    const result = await executeRealFakeWrapper("success", {
      onLog: (stream, line) => logs.push(`${stream}:${line}`),
    });

    expect(result).toMatchObject({
      ok: true,
      summary: "fake wrapper success",
      stdout: "structured stdout",
      stderr: "",
      exitCode: 0,
    });
    expect(logs).toContain("stdout:fake wrapper streamed output");
  });

  test("makes actual nonzero process exit authoritative over structured success", async () => {
    const result = await executeRealFakeWrapper("nonzero");

    expect(result).toMatchObject({ ok: false, exitCode: 7 });
    expect(result.summary).toContain("process exited 7");
    expect(result.stderr).toContain("Discarded the structured ok=true result");
    expect(inferWorkerTerminalFailureClass(result)).toBe("nonzero_exit");
  });

  test("rejects structured success emitted shortly before an actual process timeout", async () => {
    const result = await executeRealFakeWrapper("timeout_after_success", { timeoutMs: 400 });

    expect(result).toMatchObject({ ok: false, exitCode: 124 });
    expect(result.summary).toContain("timed out");
    expect(result.stderr).toContain("Discarded the structured result");
    expect(result.diagnostics?.terminal?.metadata).toMatchObject({
      processTimedOut: true,
      processStateOverrodeStructuredResult: true,
    });
    expect(inferWorkerTerminalFailureClass(result)).toBe("timeout");
  });

  test("rejects a malformed latest sentinel from the actual wrapper process", async () => {
    const result = await executeRealFakeWrapper("malformed");

    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.summary).toContain("malformed structured result");
    expect(result.stderr).toContain("Malformed structured result");
    expect(inferWorkerTerminalFailureClass(result)).toBe("malformed_structured_result");
  });

  test("rejects success when a real descendant keeps inherited streams open", async () => {
    const result = await executeRealFakeWrapper("drain_timeout");

    expect(result).toMatchObject({ ok: false, exitCode: 124 });
    expect(result.summary).toContain("streams did not close");
    expect(result.stderr).toContain("stream-drain deadline fired");
    expect(result.diagnostics?.terminal?.metadata).toMatchObject({
      streamDrainTimedOut: true,
      processStateOverrodeStructuredResult: true,
    });
    expect(inferWorkerTerminalFailureClass(result)).toBe("timeout");
  }, 15_000);
});
