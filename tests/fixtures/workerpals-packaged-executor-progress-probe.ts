import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { loadPushPalsConfig } from "/workspace/packages/shared/src/index.ts";
import { createGenericPythonExecutor } from "/workspace/apps/workerpals/src/common/generic_python_executor.ts";

async function runProbe(structuredResult: boolean): Promise<void> {
  const root = join(tmpdir(), `pushpals-container-executor-${randomUUID()}`);
  const scriptPath = join(root, "quiet-wrapper.ts");
  const resultPrefix = "__PUSHPALS_CONTAINER_TEST_RESULT__ ";
  mkdirSync(root, { recursive: true });
  writeFileSync(
    scriptPath,
    structuredResult
      ? [
          "await Bun.sleep(80);",
          `console.log(${JSON.stringify(resultPrefix)} + JSON.stringify({`,
          "  ok: true,",
          '  summary: "container quiet wrapper completed",',
          '  stdout: "container wrapper stdout",',
          '  stderr: "",',
          "  exitCode: 0,",
          "}));",
        ].join("\n")
      : "await Bun.sleep(80);\n",
    "utf8",
  );

  const baseConfig = loadPushPalsConfig({ projectRoot: "/workspace" });
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
    backendName: "container_test",
    scriptPath,
    pythonConfigKey: "testPython",
    timeoutConfigKey: "testTimeoutMs",
    progressIntervalMs: 10,
  });

  try {
    const result = await execute(
      "task.execute",
      { instruction: "exercise the packaged Linux runtime progress path" },
      "/workspace",
      runtimeConfig,
      (_stream, line) => logs.push(line),
    );
    if (structuredResult ? !result.ok : result.ok) {
      throw new Error(`unexpected executor result: ${JSON.stringify(result)}`);
    }
    if (!logs.some((line) => line.includes("Still running"))) {
      throw new Error(`missing progress heartbeat: ${JSON.stringify(logs)}`);
    }
    const logCountAfterCompletion = logs.length;
    await Bun.sleep(40);
    if (logs.length !== logCountAfterCompletion) {
      throw new Error(`progress timer leaked after completion: ${JSON.stringify(logs)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await runProbe(true);
await runProbe(false);
console.log("packaged WorkerPal executor progress probe passed");
