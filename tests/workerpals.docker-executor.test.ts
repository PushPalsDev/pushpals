import { describe, expect, test } from "bun:test";
import { DockerExecutor } from "../apps/workerpals/src/docker_executor";

function createExecutor() {
  return new DockerExecutor({
    repo: process.cwd(),
    workerId: "workerpal-test",
    imageName: "pushpals-worker-sandbox:latest",
    timeoutMs: 1_800_000,
  });
}

describe("workerpals docker executor internals", () => {
  test("readStream reassembles chunk-split lines", async () => {
    const executor = createExecutor() as unknown as {
      readStream: (
        readable: ReadableStream<Uint8Array>,
        streamName: "stdout" | "stderr",
        onLog: ((stream: "stdout" | "stderr", line: string) => void) | undefined,
        lines: string[],
      ) => Promise<void>;
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('___RESULT___ {"ok":true'));
        controller.enqueue(encoder.encode(',"summary":"ok"}\n'));
        controller.close();
      },
    });
    const lines: string[] = [];
    await executor.readStream(stream, "stdout", undefined, lines);
    expect(lines).toEqual(['___RESULT___ {"ok":true,"summary":"ok"}']);
  });

  test("parseResult only reports docker-timeout summary when docker timeout fired", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: { timedOutByDocker: boolean; elapsedMs: number },
      ) => {
        ok: boolean;
        summary: string;
      };
    };

    const terminated = executor.parseResult(["partial logs"], [], 143, {
      timedOutByDocker: false,
      elapsedMs: 500_000,
    });
    expect(terminated.ok).toBe(false);
    expect(terminated.summary).toContain("terminated (exit 143)");
    expect(terminated.summary).not.toContain("timed out in Docker executor");

    const timedOut = executor.parseResult(["partial logs"], [], 143, {
      timedOutByDocker: true,
      elapsedMs: 1_234_567,
    });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.summary).toContain("timed out in Docker executor");
    expect(timedOut.summary).toContain("1234567ms");
  });

  test("retry matching no longer treats generic timeout words as transient", () => {
    const executor = createExecutor() as unknown as {
      matchesRetryablePattern: (text: string) => boolean;
    };

    expect(executor.matchesRetryablePattern("opened timeout_policy.ts for review")).toBe(false);
    expect(executor.matchesRetryablePattern("APITimeoutError: Request timed out")).toBe(true);
    expect(executor.matchesRetryablePattern("OpenHands wrapper timed out after 900000ms")).toBe(
      true,
    );
  });
});
