import { describe, expect, test } from "bun:test";
import {
  fetchBufferedWithHardDeadline,
  fetchWithHardDeadline,
  type FetchLike,
} from "../packages/shared/src/bounded_fetch";

describe("shared bounded HTTP fetch", () => {
  test("times out when response headers never arrive even if fetch ignores abort", async () => {
    const fetchImpl = (() => new Promise<Response>(() => {})) as FetchLike;
    const startedAt = Date.now();

    await expect(
      fetchWithHardDeadline({
        input: "http://127.0.0.1/never-headers",
        timeoutMs: 20,
        fetchImpl,
        timeoutMessage: "header deadline expired",
        consume: (response) => response.text(),
      }),
    ).rejects.toThrow("header deadline expired");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("times out when headers arrive but the response body never finishes", async () => {
    let bodyCancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Deliberately leave the body stream open without producing data.
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { status: 200 },
      )) as FetchLike;
    const startedAt = Date.now();

    await expect(
      fetchBufferedWithHardDeadline({
        input: "http://127.0.0.1/never-body",
        timeoutMs: 20,
        fetchImpl,
        timeoutMessage: "body deadline expired",
      }),
    ).rejects.toThrow("body deadline expired");

    await Bun.sleep(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(bodyCancelled).toBe(true);
  });

  test("cancels a late response body after the deadline already aborted", async () => {
    let bodyCancelled = false;
    const fetchImpl = (async () => {
      await Bun.sleep(50);
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // The late response also leaves its body open indefinitely.
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { status: 200 },
      );
    }) as FetchLike;

    await expect(
      fetchBufferedWithHardDeadline({
        input: "http://127.0.0.1/late-never-body",
        timeoutMs: 10,
        fetchImpl,
        timeoutMessage: "late response deadline expired",
      }),
    ).rejects.toThrow("late response deadline expired");

    await Bun.sleep(100);
    expect(bodyCancelled).toBe(true);
  });

  test("honors an upstream abort even when fetch and body consumption ignore it", async () => {
    const controller = new AbortController();
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Deliberately ignore the signal and leave the body open.
          },
        }),
        { status: 200 },
      )) as FetchLike;
    const startedAt = Date.now();
    setTimeout(() => controller.abort(new Error("caller deadline expired")), 20);

    await expect(
      fetchBufferedWithHardDeadline({
        input: "http://127.0.0.1/upstream-abort",
        init: { signal: controller.signal },
        timeoutMs: 10_000,
        fetchImpl,
      }),
    ).rejects.toThrow("caller deadline expired");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("returns an independently buffered response on success", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "x-pushpals-test": "bounded" },
      })) as FetchLike;

    const response = await fetchBufferedWithHardDeadline({
      input: "http://127.0.0.1/ok",
      timeoutMs: 1_000,
      fetchImpl,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-pushpals-test")).toBe("bounded");
    expect(await response.json()).toEqual({ ok: true });
  });

  test("cancels and rejects a response that exceeds the configured size cap", async () => {
    let bodyCancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            controller.enqueue(new Uint8Array([5, 6, 7, 8]));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { status: 200 },
      )) as FetchLike;

    await expect(
      fetchBufferedWithHardDeadline({
        input: "http://127.0.0.1/oversize",
        timeoutMs: 1_000,
        maxResponseBytes: 6,
        fetchImpl,
      }),
    ).rejects.toThrow("exceeded 6 byte buffer limit");

    expect(bodyCancelled).toBe(true);
  });
});
