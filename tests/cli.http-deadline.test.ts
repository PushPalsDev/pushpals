import { describe, expect, test } from "bun:test";
import { fetchStreamingResponseWithHeaderTimeout, fetchWithTimeout } from "../scripts/pushpals-cli";
import type { FetchLike } from "../packages/shared/src/bounded_fetch";

describe("CLI HTTP deadlines", () => {
  test("non-streaming requests bound response-body consumption", async () => {
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Deliberately leave the body open.
          },
        }),
      )) as FetchLike;
    const startedAt = Date.now();

    await expect(
      fetchWithTimeout("http://127.0.0.1/stalled-body", {}, 20, 1024, fetchImpl),
    ).rejects.toThrow("timed out");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("streaming requests bound receipt of response headers", async () => {
    const fetchImpl = (() => new Promise<Response>(() => {})) as FetchLike;
    const startedAt = Date.now();

    await expect(
      fetchStreamingResponseWithHeaderTimeout(
        "http://127.0.0.1/stalled-headers",
        {},
        20,
        fetchImpl,
      ),
    ).rejects.toThrow();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("caller shutdown cancels an idle streaming response body", async () => {
    let cancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Simulate an SSE peer that is connected but currently idle.
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      )) as FetchLike;
    const controller = new AbortController();
    const response = await fetchStreamingResponseWithHeaderTimeout(
      "http://127.0.0.1/events",
      { signal: controller.signal },
      1_000,
      fetchImpl,
    );
    const read = response.body!.getReader().read();

    controller.abort(new Error("CLI shutting down"));
    const result = await Promise.race([read, Bun.sleep(500).then(() => null)]);

    expect(result).not.toBeNull();
    expect(cancelled).toBe(true);
  });
});
