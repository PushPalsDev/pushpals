import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import {
  BoundedJsonBodyError,
  drainRejectedJsonBody,
  readBoundedJsonObject,
} from "../apps/server/src/bounded_json_body";

describe("bounded control-plane JSON", () => {
  test("retains the accepted size and JSON-object requirements", async () => {
    const request = (body: string) =>
      new Request("http://localhost/control", { method: "POST", body });
    expect(await readBoundedJsonObject(request('{"ok":true}'), 11, "Control")).toEqual({
      ok: true,
    });
    await expect(
      readBoundedJsonObject(request('{"ok":true}'), 10, "Control"),
    ).rejects.toMatchObject({ status: 413 });
    for (const body of ["null", "[]", "invalid"]) {
      await expect(readBoundedJsonObject(request(body), 100, "Control")).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  test("bounds discarded bytes even if cancellation never settles", async () => {
    let pulls = 0;
    let cancelled = 0;
    const reader = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1_024));
      },
      cancel() {
        cancelled += 1;
        return new Promise<void>(() => {});
      },
    }).getReader();
    try {
      expect(await drainRejectedJsonBody(reader, 4_096)).toBe(false);
      expect(pulls).toBeLessThanOrEqual(7);
      expect(cancelled).toBe(1);
    } finally {
      reader.releaseLock();
    }
  });

  test("bounds stalled upload draining even if cancellation never settles", async () => {
    let cancelled = 0;
    const reader = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled += 1;
        return new Promise<void>(() => {});
      },
    }).getReader();
    const started = performance.now();
    try {
      expect(await drainRejectedJsonBody(reader, 4_096, 30)).toBe(false);
      expect(performance.now() - started).toBeLessThan(500);
      expect(cancelled).toBe(1);
    } finally {
      reader.releaseLock();
    }
  });

  test("waits for a short chunked upload terminator before 413 and bounds a never-ending sender", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (req.method === "GET") return Response.json({ ok: true });
        try {
          await readBoundedJsonObject(req, 64, "Control");
          return Response.json({ ok: true });
        } catch (error) {
          if (!(error instanceof BoundedJsonBodyError)) throw error;
          return Response.json(
            { error: error.message },
            { status: error.status, headers: { Connection: "close" } },
          );
        }
      },
    });
    const sockets: ReturnType<typeof connect>[] = [];
    try {
      for (const finishUpload of [true, false]) {
        const socket = connect(server.port!, "127.0.0.1");
        sockets.push(socket);
        let wire = "";
        let resolveResponse: () => void = () => {};
        const responseArrived = new Promise<void>((resolve) => {
          resolveResponse = resolve;
        });
        socket.on("data", (chunk) => {
          wire += chunk.toString();
          if (wire.includes("too large")) resolveResponse();
        });
        socket.on("error", () => {});
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
        const started = performance.now();
        socket.write(
          `POST /control HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n41\r\n${"x".repeat(65)}\r\n`,
        );
        await Bun.sleep(30);
        expect(wire).toBe("");
        if (finishUpload) socket.write("0\r\n\r\n");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            responseArrived,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("bounded rejection did not respond")),
                1_500,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        expect(wire).toContain("413 Payload Too Large");
        expect(performance.now() - started).toBeLessThan(1_000);
        // A sender that misses the drain bound cannot reuse its partial upload
        // connection. Other connections, including critical health, stay usable.
        const health = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
          keepalive: false,
          headers: { Connection: "close" },
          signal: AbortSignal.timeout(1_000),
        });
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ ok: true });
        socket.destroy();
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.stop(true);
    }
  });
});
