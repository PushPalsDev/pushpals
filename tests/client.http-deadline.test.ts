import { describe, expect, test } from "bun:test";
import {
  fetchClientResponseWithDeadline,
  type ClientFetchLike,
} from "../apps/client/src/lib/httpDeadline";

describe("client HTTP deadlines", () => {
  test("returns when response headers never arrive even if fetch ignores abort", async () => {
    const fetchImpl = (() => new Promise<Response>(() => {})) as ClientFetchLike;
    const startedAt = Date.now();

    await expect(
      fetchClientResponseWithDeadline("http://127.0.0.1/headers", {}, { timeoutMs: 20, fetchImpl }),
    ).rejects.toThrow("timed out after 20ms");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("returns when response body never completes", async () => {
    let cancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {},
          cancel() {
            cancelled = true;
          },
        }),
      )) as ClientFetchLike;

    await expect(
      fetchClientResponseWithDeadline("http://127.0.0.1/body", {}, { timeoutMs: 20, fetchImpl }),
    ).rejects.toThrow("timed out after 20ms");

    await Bun.sleep(0);
    expect(cancelled).toBe(true);
  });

  test("buffers successful JSON responses", async () => {
    const response = await fetchClientResponseWithDeadline(
      "http://127.0.0.1/ok",
      {},
      { timeoutMs: 1_000, fetchImpl: async () => Response.json({ ok: true }) },
    );
    expect(await response.json()).toEqual({ ok: true });
  });

  test("cancels an incrementally oversized response", async () => {
    let cancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5, 6]));
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as ClientFetchLike;

    await expect(
      fetchClientResponseWithDeadline(
        "http://127.0.0.1/large",
        {},
        { timeoutMs: 1_000, maxResponseBytes: 4, fetchImpl },
      ),
    ).rejects.toThrow("exceeded 4 byte limit");
    expect(cancelled).toBe(true);
  });

  test("cancels a stalled body that arrives after the deadline", async () => {
    let cancelled = false;
    const fetchImpl = (async () => {
      await Bun.sleep(40);
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {},
          cancel() {
            cancelled = true;
          },
        }),
      );
    }) as ClientFetchLike;

    await expect(
      fetchClientResponseWithDeadline(
        "http://127.0.0.1/late-body",
        {},
        { timeoutMs: 10, fetchImpl },
      ),
    ).rejects.toThrow("timed out after 10ms");
    await Bun.sleep(75);
    expect(cancelled).toBe(true);
  });

  test("cancels a response rejected by declared content length", async () => {
    let cancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {},
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "100" } },
      )) as ClientFetchLike;

    await expect(
      fetchClientResponseWithDeadline(
        "http://127.0.0.1/declared-large",
        {},
        { timeoutMs: 1_000, maxResponseBytes: 4, fetchImpl },
      ),
    ).rejects.toThrow("exceeded 4 byte limit");
    expect(cancelled).toBe(true);
  });
});
