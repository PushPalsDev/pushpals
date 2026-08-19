import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { loadPushPalsConfig, runBoundedProcess } from "shared";
import { createGenericPythonExecutor } from "../packages/cli/runtime/sandbox/apps/workerpals/src/common/generic_python_executor";

async function runQuietPackagedExecutorProbe(options?: {
  structuredResult?: boolean;
}): Promise<string[]> {
  const root = join(tmpdir(), `pushpals-packaged-executor-${randomUUID()}`);
  const scriptPath = join(root, "quiet-wrapper.ts");
  const resultPrefix = "__PUSHPALS_PACKAGED_TEST_RESULT__ ";
  mkdirSync(root, { recursive: true });
  const structuredResult = options?.structuredResult !== false;
  writeFileSync(
    scriptPath,
    structuredResult
      ? [
          "await Bun.sleep(80);",
          `console.log(${JSON.stringify(resultPrefix)} + JSON.stringify({`,
          "  ok: true,",
          '  summary: "packaged quiet wrapper completed",',
          '  stdout: "packaged wrapper stdout",',
          '  stderr: "",',
          "  exitCode: 0,",
          "}));",
        ].join("\n")
      : "await Bun.sleep(80);\n",
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
    backendName: "packaged_test",
    scriptPath,
    pythonConfigKey: "testPython",
    timeoutConfigKey: "testTimeoutMs",
    progressIntervalMs: 10,
  } as never);

  try {
    const result = await execute(
      "task.execute",
      { instruction: "exercise the packaged quiet progress path" },
      process.cwd(),
      runtimeConfig,
      (_stream, line) => logs.push(line),
    );

    if (structuredResult) {
      expect(result).toMatchObject({
        ok: true,
        summary: "packaged quiet wrapper completed",
        stdout: "packaged wrapper stdout",
        stderr: "",
        exitCode: 0,
      });
    } else {
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("did not return a structured result");
    }
    expect(logs.some((line) => line.includes("Still running"))).toBe(true);
    return logs;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("packaged WorkerPal runtime survives a quiet generic-executor progress tick", async () => {
  await runQuietPackagedExecutorProbe();
});

test("packaged WorkerPal runtime clears progress ticks after a silent wrapper exits", async () => {
  const logs = await runQuietPackagedExecutorProbe({ structuredResult: false });
  const logCountAfterCompletion = logs.length;
  await Bun.sleep(40);
  expect(logs).toHaveLength(logCountAfterCompletion);
});

const runDockerProbe = process.env.PUSHPALS_RUN_CONTAINER_VOLUME_INTEGRATION === "1";

(runDockerProbe ? test : test.skip)(
  "runs the packaged generic-executor progress gate inside the release WorkerPal image",
  async () => {
    const image = process.env.PUSHPALS_WORKERPAL_IMAGE || "pushpals-worker-sandbox:latest";
    const probePath = join(
      import.meta.dir,
      "fixtures",
      "workerpals-packaged-executor-progress-probe.ts",
    ).replace(/\\/g, "/");
    const containerName = `pushpals-packaged-executor-probe-${process.pid}-${Date.now()}`;
    try {
      const result = await runBoundedProcess(
        [
          "docker",
          "run",
          "--rm",
          "--name",
          containerName,
          "--cpus",
          "2",
          "--memory",
          "4g",
          "--entrypoint",
          "bun",
          "--mount",
          `type=bind,source=${probePath},target=/tmp/pushpals-packaged-executor-progress-probe.ts,readonly`,
          image,
          "run",
          "/tmp/pushpals-packaged-executor-progress-probe.ts",
        ],
        {
          timeoutMs: 90_000,
          streamDrainTimeoutMs: 5_000,
          outputLimitBytes: 512 * 1024,
          retainOutputTail: true,
        },
      );

      expect(result.exitCode, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
      expect(result.timedOut).toBe(false);
    } finally {
      await runBoundedProcess(["docker", "rm", "-f", containerName], {
        timeoutMs: 15_000,
        streamDrainTimeoutMs: 2_000,
        outputLimitBytes: 16 * 1024,
      });
    }
  },
  120_000,
);
