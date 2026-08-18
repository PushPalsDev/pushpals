import { describe, expect, test } from "bun:test";
import { CommunicationManager } from "../packages/shared/src/communication";

describe("CommunicationManager transport deadlines", () => {
  test("returns false and aborts when the server transport never settles", async () => {
    let observedSignal: AbortSignal | null = null;
    const comm = new CommunicationManager({
      serverUrl: "http://127.0.0.1:1",
      sessionId: "dev",
      from: "agent:test",
      requestTimeoutMs: 20,
      fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? null;
        return new Promise<Response>(() => {});
      }) as typeof fetch,
    });

    const startedAt = Date.now();
    expect(await comm.assistantMessage("bounded")).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(observedSignal?.aborted).toBe(true);
  });

  test("preserves successful server responses", async () => {
    const comm = new CommunicationManager({
      serverUrl: "http://127.0.0.1:1",
      sessionId: "dev",
      from: "agent:test",
      requestTimeoutMs: 100,
      fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch,
    });

    expect(await comm.assistantMessage("delivered")).toBe(true);
  });

  test("returns false when headers arrive but the response body never closes", async () => {
    let observedSignal: AbortSignal | null = null;
    const comm = new CommunicationManager({
      serverUrl: "http://127.0.0.1:1",
      sessionId: "dev",
      from: "agent:test",
      requestTimeoutMs: 20,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? null;
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Deliberately leave the body open after headers are available.
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    const startedAt = Date.now();
    expect(await comm.assistantMessage("bounded body")).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(observedSignal?.aborted).toBe(true);
  });
});
