import { describe, expect, test } from "bun:test";
import {
  parseCompletionPositiveAck,
  postCompletionCallbackWithRetry,
  postCompletionProcessedWithRetry,
  withHardDeadline,
} from "../apps/source_control_manager/src/completion_callback";
import { fetchBufferedWithHardDeadline } from "../packages/shared/src/bounded_fetch";

describe("SourceControlManager completion callback recovery", () => {
  test("requires the server's explicit positive acknowledgement", async () => {
    await expect(
      parseCompletionPositiveAck(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ).resolves.toEqual({ ok: true, status: 200 });

    for (const body of ["", "not-json", JSON.stringify({ ok: false }), JSON.stringify({})]) {
      await expect(
        parseCompletionPositiveAck(new Response(body, { status: 200 })),
      ).resolves.toEqual({ ok: false, status: 200 });
    }
    await expect(parseCompletionPositiveAck(new Response(null, { status: 204 }))).resolves.toEqual({
      ok: false,
      status: 204,
    });
  });

  test("replays the same callback after the committed response is lost", async () => {
    let calls = 0;
    const result = await postCompletionProcessedWithRetry({
      request: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("connection closed after server commit");
        }
        return { ok: true, status: 200 };
      },
      retryDelayMs: 0,
    });

    expect(result).toEqual({
      confirmed: true,
      attempts: 2,
      lastStatus: 200,
      lastError: null,
    });
    expect(calls).toBe(2);
  });

  test("does not retry a rejected stale fencing token", async () => {
    let calls = 0;
    const result = await postCompletionProcessedWithRetry({
      request: async () => {
        calls += 1;
        return { ok: false, status: 409 };
      },
      retryDelayMs: 0,
    });

    expect(result).toMatchObject({ confirmed: false, lastStatus: 409 });
    expect(calls).toBe(1);
  });

  test("bounds retryable callback failures", async () => {
    let calls = 0;
    const result = await postCompletionProcessedWithRetry({
      request: async () => {
        calls += 1;
        return { ok: false, status: 503 };
      },
      attempts: 3,
      retryDelayMs: 0,
    });

    expect(result).toMatchObject({ confirmed: false, attempts: 3, lastStatus: 503 });
    expect(calls).toBe(3);
  });

  test("does not confirm a callback when a lost response is followed by malformed 2xx", async () => {
    let calls = 0;
    const result = await postCompletionCallbackWithRetry({
      attempts: 2,
      retryDelayMs: 0,
      request: async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection closed after server commit");
        return parseCompletionPositiveAck(
          new Response(JSON.stringify({ accepted: true }), { status: 200 }),
        );
      },
    });

    expect(result).toEqual({
      confirmed: false,
      attempts: 2,
      lastStatus: 200,
      lastError: null,
    });
    expect(calls).toBe(2);
  });

  test("aborts every unresponsive callback attempt instead of wedging the SCM tick", async () => {
    let calls = 0;
    const startedAt = Date.now();
    const result = await postCompletionCallbackWithRetry({
      request: (signal) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("callback timed out")), {
            once: true,
          });
        });
      },
      attempts: 2,
      timeoutMs: 100,
      retryDelayMs: 0,
    });

    expect(result).toMatchObject({
      confirmed: false,
      attempts: 2,
      lastError: "callback timed out",
    });
    expect(calls).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("hard deadline settles even when the operation ignores AbortSignal", async () => {
    const startedAt = Date.now();
    await expect(
      withHardDeadline(async () => new Promise<Response>(() => {}), 100, "hard deadline elapsed"),
    ).rejects.toThrow("hard deadline elapsed");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("cancels a completion callback body that stalls after successful headers", async () => {
    let bodyCancelled = false;
    const result = await postCompletionProcessedWithRetry({
      attempts: 1,
      timeoutMs: 200,
      retryDelayMs: 0,
      request: (signal) =>
        fetchBufferedWithHardDeadline({
          input: "http://127.0.0.1/completions/example/processed",
          init: { signal },
          timeoutMs: 20,
          timeoutMessage: "completion response body timed out",
          fetchImpl: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start() {
                  // Headers arrive, but the control-plane body never closes.
                },
                cancel() {
                  bodyCancelled = true;
                },
              }),
              { status: 200 },
            ),
        }),
    });

    expect(result).toMatchObject({
      confirmed: false,
      attempts: 1,
      lastError: "completion response body timed out",
    });
    await Bun.sleep(0);
    expect(bodyCancelled).toBe(true);
  });
});
