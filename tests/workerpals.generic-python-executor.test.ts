import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { loadPushPalsConfig } from "shared";
import { createPythonPayloadTransport } from "../apps/workerpals/src/common/python_payload_transport";
import {
  createGenericPythonExecutor,
  normalizeGenericPythonExecutorParsedResultForTimeout,
  resolveGenericPythonExecutorScriptPath,
  resolveGenericPythonExecutorChildTimeoutEnv,
  resolveGenericPythonExecutorChildTimeoutMs,
  resolveGenericPythonExecutorTimeoutMs,
  resolveOpenAICodexValidationReserveMs,
} from "../apps/workerpals/src/common/generic_python_executor";
import { inferWorkerTerminalFailureClass } from "../apps/workerpals/src/workerpals_main";

describe("python payload transport", () => {
  test("keeps large executor payloads out of process argv", () => {
    const payloadBase64 = "x".repeat(256 * 1024);
    const transport = createPythonPayloadTransport(payloadBase64);
    const filePath = transport.filePath;

    try {
      expect(transport.args).toEqual(["--payload-file", filePath]);
      expect(transport.args.join(" ")).not.toContain(payloadBase64.slice(0, 1024));
      expect(readFileSync(filePath, "utf8")).toBe(payloadBase64);
    } finally {
      transport.cleanup();
      transport.cleanup();
    }

    expect(existsSync(filePath)).toBe(false);
  });
});

describe("generic python executor timeout resolution", () => {
  test("keeps a quiet executor alive across progress ticks and clears the timer", async () => {
    const root = join(tmpdir(), `pushpals-generic-executor-${randomUUID()}`);
    const scriptPath = join(root, "quiet-wrapper.ts");
    const resultPrefix = "__PUSHPALS_TEST_RESULT__ ";
    mkdirSync(root, { recursive: true });
    writeFileSync(
      scriptPath,
      [
        "await Bun.sleep(80);",
        `console.log(${JSON.stringify(resultPrefix)} + JSON.stringify({`,
        "  ok: true,",
        '  summary: "quiet wrapper completed",',
        '  stdout: "wrapper stdout",',
        '  stderr: "",',
        "  exitCode: 0,",
        "}));",
      ].join("\n"),
      "utf8",
    );

    const baseConfig = loadPushPalsConfig({ projectRoot: process.cwd() });
    const runtimeConfig = {
      ...baseConfig,
      workerpals: {
        ...baseConfig.workerpals,
        testPython: process.execPath,
        testTimeoutMs: 10_000,
        executorResultPrefix: resultPrefix,
      },
    } as never;
    const logs: string[] = [];
    const execute = createGenericPythonExecutor({
      backendName: "test",
      scriptPath,
      pythonConfigKey: "testPython",
      timeoutConfigKey: "testTimeoutMs",
      progressIntervalMs: 10,
    });

    try {
      const result = await execute(
        "task.execute",
        { instruction: "exercise the quiet progress path" },
        process.cwd(),
        runtimeConfig,
        (_stream, line) => logs.push(line),
      );

      expect(result).toMatchObject({
        ok: true,
        summary: "quiet wrapper completed",
        stdout: "wrapper stdout",
        stderr: "",
        exitCode: 0,
      });
      expect(logs.some((line) => line.includes("Still running"))).toBe(true);

      const logCountAfterCompletion = logs.length;
      await Bun.sleep(40);
      expect(logs).toHaveLength(logCountAfterCompletion);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clears progress ticks after a silent wrapper returns without a result", async () => {
    const root = join(tmpdir(), `pushpals-silent-executor-${randomUUID()}`);
    const scriptPath = join(root, "silent-wrapper.ts");
    mkdirSync(root, { recursive: true });
    writeFileSync(scriptPath, "await Bun.sleep(80);\n", "utf8");

    const baseConfig = loadPushPalsConfig({ projectRoot: process.cwd() });
    const runtimeConfig = {
      ...baseConfig,
      workerpals: {
        ...baseConfig.workerpals,
        testPython: process.execPath,
        testTimeoutMs: 10_000,
      },
    } as never;
    const logs: string[] = [];
    const execute = createGenericPythonExecutor({
      backendName: "test",
      scriptPath,
      pythonConfigKey: "testPython",
      timeoutConfigKey: "testTimeoutMs",
      progressIntervalMs: 10,
    });

    try {
      const result = await execute(
        "task.execute",
        { instruction: "exercise silent timer cleanup" },
        process.cwd(),
        runtimeConfig,
        (_stream, line) => logs.push(line),
      );

      expect(result.ok).toBe(false);
      expect(result.summary).toContain("did not return a structured result");
      expect(logs.some((line) => line.includes("Still running"))).toBe(true);

      const logCountAfterCompletion = logs.length;
      await Bun.sleep(40);
      expect(logs).toHaveLength(logCountAfterCompletion);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a structured ok result when the wrapper process timed out", async () => {
    const resultPrefix = "__PUSHPALS_TIMEOUT_RESULT__ ";
    const baseConfig = loadPushPalsConfig({ projectRoot: process.cwd() });
    const execute = createGenericPythonExecutor({
      backendName: "test",
      scriptPath: process.execPath,
      pythonConfigKey: "testPython",
      timeoutConfigKey: "testTimeoutMs",
      processRunner: (async () => ({
        stdout: `${resultPrefix}${JSON.stringify({
          ok: true,
          summary: "wrapper claimed success before hanging",
          exitCode: 0,
        })}\n`,
        stderr: "",
        exitCode: 143,
        timedOut: true,
      })) as never,
    });
    const runtimeConfig = {
      ...baseConfig,
      workerpals: {
        ...baseConfig.workerpals,
        testPython: process.execPath,
        testTimeoutMs: 10_000,
        executorResultPrefix: resultPrefix,
      },
    } as never;

    const result = await execute("task.execute", {}, process.cwd(), runtimeConfig);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.summary).toContain("wrapper timed out after 10000ms");
    expect(result.stderr).toContain("exceeded the PushPals execution deadline");
  });

  test("rejects a structured ok result when the wrapper process exits nonzero", async () => {
    const resultPrefix = "__PUSHPALS_NONZERO_RESULT__ ";
    const baseConfig = loadPushPalsConfig({ projectRoot: process.cwd() });
    const execute = createGenericPythonExecutor({
      backendName: "test",
      scriptPath: process.execPath,
      pythonConfigKey: "testPython",
      timeoutConfigKey: "testTimeoutMs",
      processRunner: (async () => ({
        stdout: `${resultPrefix}${JSON.stringify({
          ok: true,
          summary: "wrapper claimed success before crashing",
          exitCode: 0,
        })}\n`,
        stderr: "native wrapper failure",
        exitCode: 3,
        timedOut: false,
      })) as never,
    });
    const runtimeConfig = {
      ...baseConfig,
      workerpals: {
        ...baseConfig.workerpals,
        testPython: process.execPath,
        testTimeoutMs: 10_000,
        executorResultPrefix: resultPrefix,
      },
    } as never;

    const result = await execute("task.execute", {}, process.cwd(), runtimeConfig);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.summary).toContain("process exited 3");
    expect(result.stderr).toContain("Discarded the structured ok=true result");
  });

  test("rejects a structured result when process stream draining times out", async () => {
    const resultPrefix = "__PUSHPALS_DRAIN_RESULT__ ";
    const baseConfig = loadPushPalsConfig({ projectRoot: process.cwd() });
    const execute = createGenericPythonExecutor({
      backendName: "test",
      scriptPath: process.execPath,
      pythonConfigKey: "testPython",
      timeoutConfigKey: "testTimeoutMs",
      processRunner: (async () => ({
        stdout: `${resultPrefix}${JSON.stringify({
          ok: true,
          summary: "wrapper claimed success before leaving inherited pipes open",
          exitCode: 0,
        })}\n`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
        drainTimedOut: true,
      })) as never,
    });
    const runtimeConfig = {
      ...baseConfig,
      workerpals: {
        ...baseConfig.workerpals,
        testPython: process.execPath,
        testTimeoutMs: 10_000,
        executorResultPrefix: resultPrefix,
      },
    } as never;

    const result = await execute("task.execute", {}, process.cwd(), runtimeConfig);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.summary).toContain("streams did not close");
    expect(result.diagnostics?.terminal?.metadata).toMatchObject({
      streamDrainTimedOut: true,
      processStateOverrodeStructuredResult: true,
    });
    expect(inferWorkerTerminalFailureClass(result)).toBe("timeout");
  });

  test("requires a strict structured-result boundary schema", async () => {
    const resultPrefix = "__PUSHPALS_SCHEMA_RESULT__ ";
    const baseConfig = loadPushPalsConfig({ projectRoot: process.cwd() });
    const runtimeConfig = {
      ...baseConfig,
      workerpals: {
        ...baseConfig.workerpals,
        testPython: process.execPath,
        testTimeoutMs: 10_000,
        executorResultPrefix: resultPrefix,
      },
    } as never;
    const malformedPayloads: unknown[] = [
      { summary: "missing ok", exitCode: 0 },
      { ok: "false", summary: "string ok", exitCode: 0 },
      { ok: true, summary: "string exit", exitCode: "3" },
      { ok: true, summary: "fractional exit", exitCode: 0.5 },
      [],
    ];

    for (const payload of malformedPayloads) {
      const execute = createGenericPythonExecutor({
        backendName: "test",
        scriptPath: process.execPath,
        pythonConfigKey: "testPython",
        timeoutConfigKey: "testTimeoutMs",
        processRunner: (async () => ({
          stdout: `${resultPrefix}${JSON.stringify(payload)}\n`,
          stderr: "",
          exitCode: 0,
          timedOut: false,
          drainTimedOut: false,
        })) as never,
      });

      const result = await execute("task.execute", {}, process.cwd(), runtimeConfig);

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.summary).toContain("malformed structured result");
      expect(result.diagnostics?.terminal?.failureClass).toBe("malformed_structured_result");
      expect(inferWorkerTerminalFailureClass(result)).toBe("malformed_structured_result");
    }
  });

  test("treats only the newest structured-result sentinel as authoritative", async () => {
    const resultPrefix = "__PUSHPALS_NEWEST_RESULT__ ";
    const baseConfig = loadPushPalsConfig({ projectRoot: process.cwd() });
    const runtimeConfig = {
      ...baseConfig,
      workerpals: {
        ...baseConfig.workerpals,
        testPython: process.execPath,
        testTimeoutMs: 10_000,
        executorResultPrefix: resultPrefix,
      },
    } as never;

    for (const newestSentinel of [`${resultPrefix}{this-is-not-json`, resultPrefix.trimEnd()]) {
      const execute = createGenericPythonExecutor({
        backendName: "test",
        scriptPath: process.execPath,
        pythonConfigKey: "testPython",
        timeoutConfigKey: "testTimeoutMs",
        processRunner: (async () => ({
          stdout: [
            `${resultPrefix}${JSON.stringify({ ok: true, summary: "stale success", exitCode: 0 })}`,
            newestSentinel,
          ].join("\n"),
          stderr: "",
          exitCode: 0,
          timedOut: false,
          drainTimedOut: false,
        })) as never,
      });

      const result = await execute("task.execute", {}, process.cwd(), runtimeConfig);

      expect(result.ok).toBe(false);
      expect(result.summary).toContain("malformed structured result");
      expect(result.diagnostics?.terminal?.failureClass).toBe("malformed_structured_result");
    }
  });

  test("preserves valid explicit failure and exit-code-omitted success", async () => {
    const resultPrefix = "__PUSHPALS_VALID_SCHEMA_RESULT__ ";
    const baseConfig = loadPushPalsConfig({ projectRoot: process.cwd() });
    const runtimeConfig = {
      ...baseConfig,
      workerpals: {
        ...baseConfig.workerpals,
        testPython: process.execPath,
        testTimeoutMs: 10_000,
        executorResultPrefix: resultPrefix,
      },
    } as never;
    const run = async (payload: Record<string, unknown>) => {
      const execute = createGenericPythonExecutor({
        backendName: "test",
        scriptPath: process.execPath,
        pythonConfigKey: "testPython",
        timeoutConfigKey: "testTimeoutMs",
        processRunner: (async () => ({
          stdout: `${resultPrefix}${JSON.stringify(payload)}\n`,
          stderr: "",
          exitCode: 0,
          timedOut: false,
          drainTimedOut: false,
        })) as never,
      });
      return execute("task.execute", {}, process.cwd(), runtimeConfig);
    };

    const failure = await run({ ok: false, summary: "valid failure", exitCode: 0 });
    const success = await run({ ok: true, summary: "valid success" });

    expect(failure).toMatchObject({ ok: false, summary: "valid failure", exitCode: 0 });
    expect(success).toMatchObject({ ok: true, summary: "valid success", exitCode: 0 });
  });

  test("preserves WorkerPal ownership and stack for caught internal executor exceptions", async () => {
    const internalError = new ReferenceError("internal executor state was unavailable");
    internalError.stack = [
      "ReferenceError: internal executor state was unavailable",
      "    at execute (/workspace/apps/workerpals/src/common/generic_python_executor.ts:412:13)",
    ].join("\n");
    const baseConfig = loadPushPalsConfig({ projectRoot: process.cwd() });
    const execute = createGenericPythonExecutor({
      backendName: "test",
      scriptPath: process.execPath,
      pythonConfigKey: "testPython",
      timeoutConfigKey: "testTimeoutMs",
      processRunner: (async () => {
        throw internalError;
      }) as never,
    });
    const runtimeConfig = {
      ...baseConfig,
      workerpals: {
        ...baseConfig.workerpals,
        testPython: process.execPath,
        testTimeoutMs: 10_000,
      },
    } as never;

    const result = await execute("task.execute", {}, process.cwd(), runtimeConfig);

    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      diagnostics: {
        terminal: {
          failureClass: "worker_runtime_failure",
          terminalStage: "worker_runtime",
          executorBackend: "test",
        },
      },
    });
    expect(result.stderr).toContain("generic_python_executor.ts:412:13");
    expect(inferWorkerTerminalFailureClass(result)).toBe("worker_runtime_failure");
  });

  test("recognizes packaged and Windows WorkerPal stack ownership", async () => {
    const baseConfig = loadPushPalsConfig({ projectRoot: process.cwd() });
    const runtimeConfig = {
      ...baseConfig,
      workerpals: {
        ...baseConfig.workerpals,
        testPython: process.execPath,
        testTimeoutMs: 10_000,
      },
    } as never;
    const ownedFrames = [
      "    at execute (C:\\workspace\\apps\\workerpals\\src\\common\\generic_python_executor.ts:412:13)",
      "    at execute (C:\\Users\\tester\\.pushpals\\runtime\\sandbox\\.pushpals-workerpals-runtime.js:120:8)",
    ];

    for (const frame of ownedFrames) {
      const internalError = new ReferenceError("owned runtime failure");
      internalError.stack = ["ReferenceError: owned runtime failure", frame].join("\n");
      const execute = createGenericPythonExecutor({
        backendName: "test",
        scriptPath: process.execPath,
        pythonConfigKey: "testPython",
        timeoutConfigKey: "testTimeoutMs",
        processRunner: (async () => {
          throw internalError;
        }) as never,
      });

      const result = await execute("task.execute", {}, process.cwd(), runtimeConfig);

      expect(result.diagnostics?.terminal?.failureClass).toBe("worker_runtime_failure");
      expect(result.stderr).toContain(frame.trim());
    }
  });

  test("does not claim errors whose first stack frame belongs to external code", async () => {
    const externalError = new TypeError("external runner failed");
    externalError.stack = [
      "TypeError: external runner failed",
      "    at run (C:\\workspace\\node_modules\\external-runner\\index.js:12:4)",
      "    at execute (C:\\workspace\\apps\\workerpals\\src\\common\\generic_python_executor.ts:412:13)",
    ].join("\n");
    const baseConfig = loadPushPalsConfig({ projectRoot: process.cwd() });
    const execute = createGenericPythonExecutor({
      backendName: "test",
      scriptPath: process.execPath,
      pythonConfigKey: "testPython",
      timeoutConfigKey: "testTimeoutMs",
      processRunner: (async () => {
        throw externalError;
      }) as never,
    });
    const runtimeConfig = {
      ...baseConfig,
      workerpals: {
        ...baseConfig.workerpals,
        testPython: process.execPath,
        testTimeoutMs: 10_000,
      },
    } as never;

    const result = await execute("task.execute", {}, process.cwd(), runtimeConfig);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("wrapper execution error");
    expect(result.diagnostics?.terminal?.failureClass).not.toBe("worker_runtime_failure");
  });

  test("caps normal backends to the job execution budget", () => {
    expect(
      resolveGenericPythonExecutorTimeoutMs({
        configuredTimeoutMs: 7_200_000,
        executionBudgetMs: 1_800_000,
      }),
    ).toBe(1_800_000);
  });

  test("uses finalization budget as host-side structured-result grace", () => {
    expect(
      resolveGenericPythonExecutorTimeoutMs({
        configuredTimeoutMs: 7_200_000,
        executionBudgetMs: 1_200_000,
        finalizationBudgetMs: 120_000,
      }),
    ).toBe(1_320_000);
  });

  test("still supports an explicit opt-out for bespoke backend wrappers", () => {
    expect(
      resolveGenericPythonExecutorTimeoutMs({
        configuredTimeoutMs: 7_200_000,
        executionBudgetMs: 1_800_000,
        capTimeoutToExecutionBudget: false,
      }),
    ).toBe(7_200_000);
  });

  test("keeps OpenAI Codex under the job planning budget", () => {
    for (const path of [
      "apps/workerpals/src/backends/openai_codex_backend.ts",
      "packages/cli/runtime/sandbox/apps/workerpals/src/backends/openai_codex_backend.ts",
    ]) {
      expect(readFileSync(path, "utf8")).not.toContain("capTimeoutToExecutionBudget: false");
    }
  });

  test("prefers fresh runtime sandbox Python wrappers over stale runtime app paths", () => {
    const root = join(tmpdir(), `pushpals-python-wrapper-${randomUUID()}`);
    const configDir = join(root, "configs");
    const scriptSegments = [
      "apps",
      "workerpals",
      "src",
      "backends",
      "openai_codex",
      "openai_codex_executor.py",
    ];
    const staleScript = join(root, ...scriptSegments);
    const sandboxScript = join(root, "sandbox", ...scriptSegments);
    mkdirSync(dirname(staleScript), { recursive: true });
    mkdirSync(dirname(sandboxScript), { recursive: true });
    writeFileSync(staleScript, "# stale executor\n", "utf8");
    writeFileSync(sandboxScript, "# fresh executor\n", "utf8");

    try {
      const result = resolveGenericPythonExecutorScriptPath(
        {
          backendName: "openai_codex",
          scriptPath: staleScript,
          scriptSegments,
          pythonConfigKey: "openaiCodexPython",
          timeoutConfigKey: "openaiCodexTimeoutMs",
        },
        {
          configDir,
          projectRoot: join(root, "repo"),
        } as never,
      );

      expect(result.scriptPath).toBe(sandboxScript);
      expect(result.candidates[0]).toBe(sandboxScript);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves packaged Python wrapper scripts from the runtime config directory", () => {
    const root = join(tmpdir(), `pushpals-python-wrapper-${randomUUID()}`);
    const configDir = join(root, "configs");
    const packagedScript = join(
      root,
      "apps",
      "workerpals",
      "src",
      "backends",
      "openai_codex",
      "openai_codex_executor.py",
    );
    mkdirSync(dirname(packagedScript), { recursive: true });
    writeFileSync(packagedScript, "# packaged executor\n", "utf8");

    try {
      expect(
        resolveGenericPythonExecutorScriptPath(
          {
            backendName: "openai_codex",
            scriptPath: join(root, "missing", "openai_codex_executor.py"),
            scriptSegments: [
              "apps",
              "workerpals",
              "src",
              "backends",
              "openai_codex",
              "openai_codex_executor.py",
            ],
            pythonConfigKey: "openaiCodexPython",
            timeoutConfigKey: "openaiCodexTimeoutMs",
          },
          {
            configDir,
            projectRoot: join(root, "repo"),
          } as never,
        ).scriptPath,
      ).toBe(packagedScript);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gives OpenAI Codex a child timeout below the host timeout for result salvage", () => {
    expect(
      resolveGenericPythonExecutorChildTimeoutMs({
        backendName: "openai_codex",
        hostTimeoutMs: 1_200_000,
      }),
    ).toBe(1_170_000);

    expect(
      resolveGenericPythonExecutorChildTimeoutEnv({
        backendName: "openai_codex",
        hostTimeoutMs: 1_200_000,
      }),
    ).toEqual({
      WORKERPALS_OPENAI_CODEX_TIMEOUT_MS: "1170000",
      WORKERPALS_OPENAI_CODEX_TIMEOUT_S: "1170",
    });
  });

  test("reserves validation and repair budget from long OpenAI Codex primary turns", () => {
    expect(resolveOpenAICodexValidationReserveMs(1_200_000)).toBe(300_000);
    expect(resolveOpenAICodexValidationReserveMs(1_800_000)).toBe(450_000);
    expect(resolveOpenAICodexValidationReserveMs(600_000)).toBe(60_000);
  });

  test("keeps Codex child timeout below execution budget without starving recovery", () => {
    expect(
      resolveGenericPythonExecutorChildTimeoutMs({
        backendName: "openai_codex",
        hostTimeoutMs: 1_320_000,
        executionBudgetMs: 1_200_000,
      }),
    ).toBe(870_000);
  });

  test("does not inject Codex timeout env into unrelated Python backends", () => {
    expect(
      resolveGenericPythonExecutorChildTimeoutEnv({
        backendName: "miniswe",
        hostTimeoutMs: 1_200_000,
      }),
    ).toEqual({});
  });

  test("normalizes host timeout SIGTERM from OpenAI Codex into a budget-expired result", () => {
    const result = normalizeGenericPythonExecutorParsedResultForTimeout({
      backendName: "openai_codex",
      kind: "task.execute",
      timedOut: true,
      timeoutMs: 1_320_000,
      timeoutDetail:
        "workerpals.openai_codex_timeout_ms=7200000ms capped by planning executionBudgetMs=1200000ms + finalizationBudgetMs=120000ms",
      summary: "openai_codex interrupted by signal 15",
      stdout: "partial stdout",
      stderr: "openai_codex interrupted by signal 15",
      exitCode: 143,
    });

    expect(result).toEqual({
      summary: "openai_codex execution budget expired after 1320000ms for task.execute",
      stdout: "partial stdout",
      stderr: [
        "OpenAI Codex exceeded the PushPals execution budget before returning a completed result.",
        "Timeout detail: workerpals.openai_codex_timeout_ms=7200000ms capped by planning executionBudgetMs=1200000ms + finalizationBudgetMs=120000ms.",
        "Last stderr:",
        "OpenAI Codex exceeded the execution budget",
      ].join("\n"),
      exitCode: 124,
    });
    expect(result.summary).not.toContain("signal 15");
    expect(result.stderr).not.toContain("signal 15");
  });

  test("does not rewrite non-timeout Codex interruptions", () => {
    expect(
      normalizeGenericPythonExecutorParsedResultForTimeout({
        backendName: "openai_codex",
        kind: "task.execute",
        timedOut: false,
        timeoutMs: 1_320_000,
        summary: "openai_codex interrupted by signal 15",
        stdout: "",
        stderr: "",
        exitCode: 143,
      }),
    ).toEqual({
      summary: "openai_codex interrupted by signal 15",
      stdout: "",
      stderr: "",
      exitCode: 143,
    });
  });
});
