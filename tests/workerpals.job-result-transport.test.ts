import { describe, expect, test } from "bun:test";
import { DockerExecutor, type DockerJobResult } from "../apps/workerpals/src/docker_executor";
import { formatJobRunnerResult } from "../apps/workerpals/src/job_runner";
import {
  JOB_RESULT_MAX_CHARS,
  JOB_RESULT_OUTPUT_MAX_CHARS,
  JOB_RESULT_PREFIX,
} from "../apps/workerpals/src/common/job_result_transport";

interface StreamTestExecutor {
  readStream(
    stream: ReadableStream<Uint8Array>,
    name: "stdout" | "stderr",
    onLog: (name: "stdout" | "stderr", line: string) => void,
    lines: string[],
    signal?: AbortSignal,
    maxRetainedChars?: number,
  ): Promise<void>;
  parseResult(
    stdout: string[],
    stderr: string[],
    exitCode: number,
    context: { timedOutByDocker: boolean; elapsedMs: number; timeoutMs: number },
  ): DockerJobResult;
}

async function receiveOutput(
  output: string,
  { chunkBytes = 8192, maxRetainedChars = 512, streamName = "stdout" as "stdout" | "stderr" } = {},
) {
  const bytes = new TextEncoder().encode(output);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
      offset += chunkBytes;
    },
  });
  return receiveStream(stream, { maxRetainedChars, streamName });
}

async function receiveStream(
  stream: ReadableStream<Uint8Array>,
  { maxRetainedChars = 512, streamName = "stdout" as "stdout" | "stderr" } = {},
) {
  const executor = new DockerExecutor({
    repo: process.cwd(),
    workerId: "workerpal-result-transport-test",
    imageName: "unused-no-container-started",
    timeoutMs: 60_000,
  }) as unknown as StreamTestExecutor;
  const retained: string[] = [];
  const logs: string[] = [];
  await executor.readStream(
    stream,
    streamName,
    (_name, line) => logs.push(line),
    retained,
    undefined,
    maxRetainedChars,
  );
  const result = executor.parseResult(
    streamName === "stdout" ? retained : [],
    streamName === "stderr" ? retained : [],
    0,
    { timedOutByDocker: false, elapsedMs: 1000, timeoutMs: 60_000 },
  );
  return { result, logs, retained };
}

const candidateResult = {
  ok: true,
  exitCode: 0,
  summary: "Candidate requires trusted-host validation",
  commit: { branch: "refs/pushpals/agent/test/job", sha: "a".repeat(40) },
  validationBlocked: {
    category: "environment" as const,
    summary: "Docker-dependent validation deferred",
    detail: "Run the blocked command on the candidate SHA in the trusted host.",
    commands: ["bun run validate"],
  },
  usage: { promptTokens: 120_000, completionTokens: 3500, totalTokens: 123_500 },
  usageAttempts: [
    {
      stage: "executor" as const,
      attempt: 1,
      source: "test",
      promptTokens: 120_000,
      completionTokens: 3500,
    },
  ],
  candidateState: {
    status: "held" as const,
    reason: "validation pending",
    changedPaths: ["src/component.tsx"],
    checkpoint: {
      ref: "refs/pushpals/agent/test/job",
      sha: "a".repeat(40),
      capturedAt: "2026-09-05T04:00:00.000Z",
    },
  },
  diagnostics: {
    validationRuns: [
      { command: "bun run test", passed: true, exitCode: 0, stdoutTail: "123 tests passed" },
      {
        command: "bun run validate",
        passed: false,
        failureClass: "validation_environment",
        stderrTail: "Docker daemon unavailable",
      },
    ],
    metadata: { validationEvidence: "exact-candidate-sha" },
  },
};

describe("worker result transport", () => {
  test("flushes a large result through real process pipes before an immediate exit", async () => {
    const moduleUrl = new URL("../apps/workerpals/src/job_runner.ts", import.meta.url).href;
    const source = [
      `import { formatJobRunnerResult } from ${JSON.stringify(moduleUrl)};`,
      `const result = ${JSON.stringify(candidateResult)};`,
      'result.stdout = "passed test\\n".repeat(50_000);',
      'result.stderr = "warning\\n".repeat(50_000);',
      "console.log(formatJobRunnerResult(result));",
      "process.exit(0);",
    ].join("\n");
    const proc = Bun.spawn([process.execPath, "--eval", source], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    try {
      const [{ result }, stderr, exitCode] = await Promise.all([
        receiveStream(proc.stdout),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.commit).toEqual(candidateResult.commit);
      expect(result.validationBlocked).toEqual(candidateResult.validationBlocked);
      expect(result.diagnostics?.validationRuns).toEqual(
        candidateResult.diagnostics.validationRuns,
      );
      expect(result.usage).toEqual(candidateResult.usage);
      expect(result.stdout?.length).toBe(JOB_RESULT_OUTPUT_MAX_CHARS);
      expect(result.stderr?.length).toBe(JOB_RESULT_OUTPUT_MAX_CHARS);
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await proc.exited;
    }
  }, 10_000);

  test("preserves a large chunked candidate result past ordinary log bounds and shutdown noise", async () => {
    // Regression: the old 64 KiB pending-line cap erased ___RESULT___ during
    // Docker streaming, turning committed candidates into no_structured_result.
    const payload = { ...candidateResult, stdout: "test output\n".repeat(25_000) };
    const frame = `${JOB_RESULT_PREFIX} ${JSON.stringify(payload)}`;
    expect(frame.length).toBeGreaterThan(64 * 1024);
    const { result, logs, retained } = await receiveOutput(
      `startup\n${frame}\n${"shutdown noise\n".repeat(1000)}`,
    );
    expect(result.ok).toBe(true);
    expect(result.commit).toEqual(candidateResult.commit);
    expect(result.validationBlocked).toEqual(candidateResult.validationBlocked);
    expect(result.candidateState).toEqual(candidateResult.candidateState);
    expect(result.usage).toEqual(candidateResult.usage);
    expect(result.usageAttempts).toEqual(candidateResult.usageAttempts);
    expect(result.diagnostics).toEqual(candidateResult.diagnostics);
    expect(result.stdout).toBe(payload.stdout);
    expect(retained.at(-1)).toBe(frame);
    expect(retained.slice(1, -1).join("\n").length).toBeLessThanOrEqual(512);
    expect(logs.some((line) => line.startsWith(JOB_RESULT_PREFIX))).toBe(false);
  });

  test("compacts verbose output while preserving validation, commit and usage handoff", async () => {
    const original = {
      ...candidateResult,
      stdout: `first output\n${"passed test\n".repeat(50_000)}last output`,
      stderr: `first diagnostic\n${"warning\n".repeat(50_000)}last diagnostic`,
    };
    const frame = formatJobRunnerResult(original);
    const { result } = await receiveOutput(`${frame}\n`);
    expect(result.ok).toBe(true);
    expect(result.stdout?.length).toBe(JOB_RESULT_OUTPUT_MAX_CHARS);
    expect(result.stdout).toStartWith("first output");
    expect(result.stdout).toEndWith("last output");
    expect(result.stderr?.length).toBe(JOB_RESULT_OUTPUT_MAX_CHARS);
    expect(result.stderr).toStartWith("first diagnostic");
    expect(result.stderr).toEndWith("last diagnostic");
    expect(result.commit).toEqual(original.commit);
    expect(result.validationBlocked).toEqual(original.validationBlocked);
    expect(result.candidateState).toEqual(original.candidateState);
    expect(result.usage).toEqual(original.usage);
    expect(result.usageAttempts).toEqual(original.usageAttempts);
    expect(result.diagnostics?.validationRuns).toEqual(original.diagnostics.validationRuns);
    expect(result.diagnostics?.metadata?.resultTransport).toEqual({
      stdoutOriginalChars: original.stdout.length,
      stderrOriginalChars: original.stderr.length,
      stdoutRetainedChars: JOB_RESULT_OUTPUT_MAX_CHARS,
      stderrRetainedChars: JOB_RESULT_OUTPUT_MAX_CHARS,
    });
    expect(original.stdout.length).toBeGreaterThan(JOB_RESULT_OUTPUT_MAX_CHARS);
    expect(original.diagnostics.metadata).toEqual({ validationEvidence: "exact-candidate-sha" });
  });

  test("preserves Unicode and CRLF control frames split inside the sentinel and multibyte text", async () => {
    const frame = formatJobRunnerResult({ ok: true, summary: "Résumé 🚀 ready", exitCode: 0 });
    const { result } = await receiveOutput(`${frame}\r\n`, { chunkBytes: 1 });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Résumé 🚀 ready");
  });

  test("preserves a complete result without a final newline", async () => {
    const { result } = await receiveOutput(formatJobRunnerResult(candidateResult));
    expect(result.ok).toBe(true);
    expect(result.validationBlocked).toEqual(candidateResult.validationBlocked);
  });

  test("a malformed newest control frame cannot fall back to an older success", async () => {
    for (const invalid of [JOB_RESULT_PREFIX, `${JOB_RESULT_PREFIX} {"ok":`]) {
      const { result } = await receiveOutput(
        `${formatJobRunnerResult(candidateResult)}\n${invalid}\n${"late log\n".repeat(1000)}`,
      );
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("malformed structured result");
    }
  });

  test("oversized frames fail explicitly for both single-chunk and streamed output", async () => {
    const oversized = `${JOB_RESULT_PREFIX} ${JSON.stringify({
      ok: true,
      summary: "must not pass",
      stdout: "x".repeat(JOB_RESULT_MAX_CHARS),
    })}`;
    for (const chunkBytes of [8192, oversized.length + 100]) {
      const { result, retained } = await receiveOutput(
        `${formatJobRunnerResult(candidateResult)}\n${oversized}\nafter overflow\n`,
        { chunkBytes },
      );
      expect(result.ok).toBe(false);
      expect(result.diagnostics?.terminal?.failureClass).toBe("structured_result_too_large");
      expect(result.summary).toContain("transport limit");
      expect(retained.join("\n").length).toBeLessThan(2048);
    }
  });

  test("an endless oversized frame is bounded and does not restore an older success at EOF", async () => {
    const { result, retained } = await receiveOutput(
      `${formatJobRunnerResult(candidateResult)}\n${JOB_RESULT_PREFIX} ${"x".repeat(JOB_RESULT_MAX_CHARS + 100_000)}`,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics?.terminal?.failureClass).toBe("structured_result_too_large");
    expect(retained.join("\n").length).toBeLessThan(2048);
  });

  test("accepts a newer valid failure after draining an oversized frame", async () => {
    const { result } = await receiveOutput(
      `${JOB_RESULT_PREFIX} ${"x".repeat(JOB_RESULT_MAX_CHARS + 1000)}\n${formatJobRunnerResult({
        ok: false,
        exitCode: 1,
        summary: "actual terminal failure",
      })}\n`,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("actual terminal failure");
  });

  test("does not interpret stderr or the retained tail of an ordinary oversized line as a result", async () => {
    const success = formatJobRunnerResult(candidateResult);
    const stderr = await receiveOutput(success, { streamName: "stderr" });
    expect(stderr.result.ok).toBe(false);
    expect(stderr.result.summary).toContain("without returning a structured result");
    const ordinary = await receiveOutput(`${"x".repeat(4096)}${success}`, { chunkBytes: 512 });
    expect(ordinary.result.ok).toBe(false);
    expect(ordinary.result.summary).toContain("without returning a structured result");
    const shortSuccess = formatJobRunnerResult({
      ok: true,
      summary: "must remain a log".repeat(10),
    });
    const sentinelAtTailBoundary = await receiveOutput(`log prefix${shortSuccess}\n`, {
      maxRetainedChars: shortSuccess.length + 1,
      chunkBytes: 8192,
    });
    expect(sentinelAtTailBoundary.result.ok).toBe(false);
    expect(sentinelAtTailBoundary.result.summary).toContain(
      "without returning a structured result",
    );
  });

  test("the sender fails explicitly if non-log metadata alone exceeds the protocol bound", async () => {
    const { result } = await receiveOutput(
      formatJobRunnerResult({
        ok: true,
        summary: "must not pass",
        diagnostics: { metadata: { unexpectedPayload: "x".repeat(JOB_RESULT_MAX_CHARS) } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics?.terminal?.failureClass).toBe("structured_result_too_large");
  });
});
