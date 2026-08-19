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
