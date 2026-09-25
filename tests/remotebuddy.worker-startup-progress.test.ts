import { describe, expect, test } from "bun:test";
import {
  WORKER_STARTUP_CLEANUP_GRACE_MS,
  WORKER_STARTUP_IMAGE_BUILD_MS,
  WORKER_STARTUP_IMAGE_PULL_MS,
  WORKER_STARTUP_SELFCHECK_MS,
  workerStartupAllowanceMs,
} from "shared";
import { forwardWorkerOutput, WorkerStartupProgress } from "../apps/remotebuddy/src/worker_startup";

function marker(
  event: string,
  phase = "docker-image-build",
  timeoutMs = WORKER_STARTUP_IMAGE_BUILD_MS,
): string {
  return `[WorkerPalStartup] ${JSON.stringify({ phase, event, timeoutMs })}`;
}

describe("RemoteBuddy bounded WorkerPal startup progress", () => {
  test("preserves the configured deadline without an explicit image phase", () => {
    const progress = new WorkerStartupProgress(120_000, 1_000, true);
    expect(progress.deadlineMs).toBe(121_000);
    for (const line of [
      "Building image...",
      "[WorkerPals] still running",
      marker("progress"),
      marker("complete"),
      marker("start", "unknown"),
      marker("start", "docker-image-build", 0),
      '[WorkerPalStartup] {"phase":"docker-image-build","event":"start","timeoutMs":"600000"}',
      '[WorkerPalStartup] {"phase":"docker-image-build","event":{"toString":null},"timeoutMs":600000}',
      '[WorkerPalStartup] {"phase":"docker-image-build","event":["start"],"timeoutMs":600000}',
      "[WorkerPalStartup] {invalid-json}",
      `${marker("start")} extra`,
    ]) {
      expect(progress.observeLine(line, 2_000)).toBe(false);
      expect(progress.deadlineMs).toBe(121_000);
    }
  });

  test("a quiet cold build gets its fixed command budget beyond the normal startup timeout", () => {
    const progress = new WorkerStartupProgress(120_000, 0, true);
    expect(progress.observeLine(marker("start"), 3_000)).toBe(true);
    // No progress bytes are required during a quiet Docker RUN/package install.
    expect(progress.deadlineMs).toBe(633_000);
    expect(240_000).toBeLessThan(progress.deadlineMs);
    expect(progress.absoluteDeadlineMs).toBe(workerStartupAllowanceMs(120_000, true));
  });

  test("even endless progress and duplicate starts cannot extend a hung build", () => {
    const progress = new WorkerStartupProgress(120_000, 0, true);
    progress.observeLine(marker("start"), 3_000);
    for (let now = 60_000; now < 633_000; now += 60_000) {
      expect(progress.observeLine(marker("progress"), now)).toBe(true);
      expect(progress.observeLine(marker("start"), now)).toBe(false);
      expect(progress.deadlineMs).toBe(633_000);
    }
    expect(progress.observeLine(marker("progress"), 633_000)).toBe(false);
    expect(progress.observeLine(marker("complete"), 633_000)).toBe(false);
    expect(progress.deadlineMs).toBe(633_000);
  });

  test("completion allows registration but cannot consume more than the overall ceiling", () => {
    const progress = new WorkerStartupProgress(120_000, 0, true);
    progress.observeLine(marker("start"), 100_000);
    expect(progress.deadlineMs).toBe(730_000);
    expect(progress.observeLine(marker("complete"), 690_000)).toBe(true);
    expect(progress.deadlineMs).toBe(810_000);
    expect(progress.observeLine(marker("complete"), 710_000)).toBe(false);
    expect(progress.observeLine(marker("start"), 710_000)).toBe(false);
    expect(progress.deadlineMs).toBe(810_000);
    expect(
      progress.observeLine(marker("start", "docker-startup-selfcheck", 300_000), 800_000),
    ).toBe(true);
    expect(
      progress.observeLine(marker("complete", "docker-startup-selfcheck", 300_000), 1_099_000),
    ).toBe(true);
    expect(progress.deadlineMs).toBe(Math.min(1_099_000 + 120_000, progress.absoluteDeadlineMs));
    expect(
      progress.observeLine(
        marker("start", "docker-image-pull", WORKER_STARTUP_IMAGE_PULL_MS),
        progress.deadlineMs - 1,
      ),
    ).toBe(true);
    expect(progress.deadlineMs).toBe(progress.absoluteDeadlineMs);
    expect(
      progress.observeLine(
        marker("complete", "docker-image-pull", WORKER_STARTUP_IMAGE_PULL_MS),
        progress.absoluteDeadlineMs - 1,
      ),
    ).toBe(true);
    expect(progress.deadlineMs).toBe(progress.absoluteDeadlineMs);
    expect(
      progress.observeLine(
        marker("start", "docker-startup-preflight", 120_000),
        progress.absoluteDeadlineMs,
      ),
    ).toBe(false);
  });

  test("fallback image phases share one finite preparation allowance", () => {
    const progress = new WorkerStartupProgress(120_000, 0, true);
    progress.observeLine(marker("start"), 3_000);
    progress.observeLine(marker("failed"), 590_000);
    expect(
      progress.observeLine(
        marker("start", "docker-image-pull", WORKER_STARTUP_IMAGE_PULL_MS),
        591_000,
      ),
    ).toBe(true);
    const fallbackDeadline = Math.min(
      591_000 + WORKER_STARTUP_IMAGE_PULL_MS + WORKER_STARTUP_CLEANUP_GRACE_MS,
      progress.absoluteDeadlineMs,
    );
    expect(progress.deadlineMs).toBe(fallbackDeadline);
    expect(progress.observeLine(marker("progress", "docker-image-build"), 600_000)).toBe(false);
    expect(progress.observeLine(marker("progress", "docker-image-pull"), 700_000)).toBe(true);
    expect(progress.deadlineMs).toBe(fallbackDeadline);
  });

  test("clamps oversized phase budgets and respects shorter actual command budgets", () => {
    const progress = new WorkerStartupProgress(120_000, 0, true);
    progress.observeLine(marker("start", "docker-image-build", 6_000_000), 1_000);
    expect(progress.deadlineMs).toBe(631_000);
    const shorter = new WorkerStartupProgress(120_000, 0, true);
    shorter.observeLine(marker("start", "docker-image-build", 30_000), 1_000);
    expect(shorter.deadlineMs).toBe(61_000);
  });

  test("a slow primary registry pull retains its full shared command budget", () => {
    const progress = new WorkerStartupProgress(120_000, 0, true);
    expect(
      progress.observeLine(
        marker("start", "docker-image-pull", WORKER_STARTUP_IMAGE_PULL_MS),
        3_000,
      ),
    ).toBe(true);
    expect(progress.deadlineMs).toBe(
      3_000 + WORKER_STARTUP_IMAGE_PULL_MS + WORKER_STARTUP_CLEANUP_GRACE_MS,
    );
    expect(
      progress.observeLine(
        marker("complete", "docker-image-pull", WORKER_STARTUP_IMAGE_PULL_MS),
        3_000 + WORKER_STARTUP_IMAGE_PULL_MS - 1,
      ),
    ).toBe(true);
    expect(progress.deadlineMs).toBeLessThanOrEqual(progress.absoluteDeadlineMs);
  });

  test("a build timeout can finish cleanup and enter its bounded pull fallback", () => {
    const progress = new WorkerStartupProgress(120_000, 0, true);
    progress.observeLine(marker("start"), 3_000);
    // The subprocess timeout fires at 603s; its failed marker follows tree
    // termination and inherited-pipe draining rather than arriving instantly.
    expect(progress.observeLine(marker("failed"), 610_000)).toBe(true);
    expect(
      progress.observeLine(
        marker("start", "docker-image-pull", WORKER_STARTUP_IMAGE_PULL_MS),
        610_001,
      ),
    ).toBe(true);
    expect(progress.deadlineMs).toBe(
      610_001 + WORKER_STARTUP_IMAGE_PULL_MS + WORKER_STARTUP_CLEANUP_GRACE_MS,
    );
    const pullCompletedAt = 610_001 + WORKER_STARTUP_IMAGE_PULL_MS - 1_000;
    expect(
      progress.observeLine(
        marker("complete", "docker-image-pull", WORKER_STARTUP_IMAGE_PULL_MS),
        pullCompletedAt,
      ),
    ).toBe(true);
    expect(
      progress.observeLine(
        marker("start", "docker-startup-selfcheck", WORKER_STARTUP_SELFCHECK_MS),
        pullCompletedAt + 1_000,
      ),
    ).toBe(true);
    expect(progress.deadlineMs).toBe(
      pullCompletedAt + 1_000 + WORKER_STARTUP_SELFCHECK_MS + WORKER_STARTUP_CLEANUP_GRACE_MS,
    );
    expect(
      progress.observeLine(
        marker("complete", "docker-startup-selfcheck", WORKER_STARTUP_SELFCHECK_MS),
        pullCompletedAt + WORKER_STARTUP_SELFCHECK_MS,
      ),
    ).toBe(true);
    expect(progress.deadlineMs).toBe(
      Math.min(
        pullCompletedAt + WORKER_STARTUP_SELFCHECK_MS + 120_000,
        progress.absoluteDeadlineMs,
      ),
    );
    expect(progress.deadlineMs).toBeLessThanOrEqual(progress.absoluteDeadlineMs);
  });

  test("slow self-checks on a cached image get one fixed bounded phase", () => {
    const progress = new WorkerStartupProgress(120_000, 0, true);
    expect(progress.observeLine(marker("start", "docker-startup-preflight", 120_000), 100)).toBe(
      true,
    );
    expect(
      progress.observeLine(marker("complete", "docker-startup-preflight", 120_000), 10_000),
    ).toBe(true);
    expect(progress.observeLine(marker("start", "docker-startup-selfcheck", 300_000), 11_000)).toBe(
      true,
    );
    expect(progress.deadlineMs).toBe(341_000);
    expect(
      progress.observeLine(marker("progress", "docker-startup-selfcheck", 300_000), 200_000),
    ).toBe(true);
    expect(progress.deadlineMs).toBe(341_000);
    expect(
      progress.observeLine(marker("start", "docker-startup-selfcheck", 300_000), 200_000),
    ).toBe(false);
    expect(
      progress.observeLine(marker("complete", "docker-startup-selfcheck", 300_000), 300_000),
    ).toBe(true);
    expect(progress.deadlineMs).toBe(420_000);
  });

  test("late markers and Docker markers from direct workers cannot revive startup", () => {
    const expired = new WorkerStartupProgress(120_000, 0, true);
    expect(expired.observeLine(marker("start"), 120_000)).toBe(false);
    expect(expired.deadlineMs).toBe(120_000);
    const direct = new WorkerStartupProgress(120_000, 0, false);
    expect(direct.observeLine(marker("start"), 1_000)).toBe(false);
    expect(direct.deadlineMs).toBe(120_000);
    expect(direct.absoluteDeadlineMs).toBe(120_000);
  });
});

describe("WorkerPal startup output forwarding", () => {
  test("preserves raw UTF-8 bytes and recognizes split complete markers", async () => {
    const content = `ordinary café log\n${marker("start")}\r\n${marker("complete")}`;
    const encoded = new TextEncoder().encode(content);
    const chunks = Array.from(encoded, (byte) => new Uint8Array([byte]));
    const written: Uint8Array[] = [];
    const lines: string[] = [];
    await forwardWorkerOutput(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      (chunk) => {
        written.push(chunk);
      },
      (line) => lines.push(line),
    );
    expect(Buffer.concat(written).toString("utf8")).toBe(content);
    expect(lines).toEqual(["ordinary café log", marker("start"), marker("complete")]);
  });

  test("discards oversized inspection lines without truncating logs or accepting their suffix", async () => {
    const chunks = ["x".repeat(100_000), marker("start"), `\n${marker("complete")}\n`];
    const lines: string[] = [];
    let forwardedBytes = 0;
    await forwardWorkerOutput(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      (chunk) => {
        forwardedBytes += chunk.byteLength;
      },
      (line) => lines.push(line),
    );
    expect(forwardedBytes).toBe(chunks.join("").length);
    expect(lines).toEqual([marker("complete")]);
  });

  test("waits for the output sink instead of buffering the worker's lifetime output", async () => {
    const writes: string[] = [];
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const forwarding = forwardWorkerOutput(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first\n"));
          controller.enqueue(new TextEncoder().encode("second\n"));
          controller.close();
        },
      }),
      async (chunk) => {
        writes.push(new TextDecoder().decode(chunk));
        if (writes.length === 1) await blockedWrite;
      },
      () => {},
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toEqual(["first\n"]);
    releaseWrite();
    await forwarding;
    expect(writes).toEqual(["first\n", "second\n"]);
  });

  test("aborts an inherited-open pipe without waiting for its stalled cancellation", async () => {
    const abort = new AbortController();
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations += 1;
        return new Promise<void>(() => {});
      },
    });
    const forwarding = forwardWorkerOutput(
      stream,
      () => {},
      () => {},
      abort.signal,
    );
    abort.abort();
    await forwarding;
    expect(cancellations).toBe(1);
    expect(stream.locked).toBe(false);
  });

  test("aborts a blocked log sink and releases the worker pipe", async () => {
    const abort = new AbortController();
    let cancellations = 0;
    let writes = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("some log\n"));
      },
      cancel() {
        cancellations += 1;
      },
    });
    const forwarding = forwardWorkerOutput(
      stream,
      () => {
        writes += 1;
        return new Promise<void>(() => {});
      },
      () => {},
      abort.signal,
    );
    await Promise.resolve();
    expect(writes).toBe(1);
    abort.abort();
    await forwarding;
    expect(cancellations).toBe(1);
    expect(stream.locked).toBe(false);
  });

  test("cancels and releases the reader if forwarding fails", async () => {
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("some log\n"));
      },
      cancel() {
        cancellations += 1;
        return new Promise<void>(() => {});
      },
    });
    await expect(
      forwardWorkerOutput(
        stream,
        () => {
          throw new Error("closed output sink");
        },
        () => {},
      ),
    ).rejects.toThrow("closed output sink");
    expect(cancellations).toBe(1);
    expect(stream.locked).toBe(false);
  });
});
