import { describe, expect, test } from "bun:test";
import {
  WorkerServerTransport,
  type WorkerHeartbeatPayload,
} from "../apps/workerpals/src/common/server_transport";

function heartbeatPayload(currentJobId: string | null = "job-1"): WorkerHeartbeatPayload {
  return {
    status: currentJobId ? "busy" : "idle",
    currentJobId,
    capabilities: { docker: true, executor: "openai_codex" },
    details: { repo: "/repo/example" },
  };
}

function neverEndingBodyResponse(status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {
        // Intentionally send headers without ever closing the response body.
      },
    }),
    { status },
  );
}

describe("workerpals server transport", () => {
  test("attaches worker and claim-generation authority to every job log", async () => {
    let jobLogBody: Record<string, unknown> | null = null;
    const transport = new WorkerServerTransport({
      server: "http://127.0.0.1:3001",
      headers: { "Content-Type": "application/json" },
      workerId: "workerpal-log-authority",
      pollMs: 2_000,
      heartbeatMs: 5_000,
      staleClaimTtlMs: 120_000,
      fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        jobLogBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch,
    });

    const payload = {
      stream: "stdout",
      seq: 3,
      message: "bounded progress",
      ts: "2026-08-19T20:00:00.000Z",
      claimGeneration: 29,
      workerId: "stale-worker-id",
    } as const;
    await transport.queueJobLog("job-authority", payload);

    expect(jobLogBody).toEqual({
      workerId: "workerpal-log-authority",
      stream: "stdout",
      seq: 3,
      message: "bounded progress",
      ts: "2026-08-19T20:00:00.000Z",
      claimGeneration: 29,
    });
  });

  test("sends the runtime generation with every heartbeat", async () => {
    let heartbeatBody: Record<string, unknown> | null = null;
    const transport = new WorkerServerTransport({
      server: "http://127.0.0.1:3001",
      headers: { "Content-Type": "application/json" },
      workerId: "workerpal-generation",
      pollMs: 2_000,
      heartbeatMs: 5_000,
      staleClaimTtlMs: 120_000,
      runtimeGeneration: "v1.2.39",
      fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        heartbeatBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch,
    });

    expect(await transport.sendHeartbeat(heartbeatPayload(null))).toBe(true);
    expect(heartbeatBody).toMatchObject({
      workerId: "workerpal-generation",
      runtimeGeneration: "v1.2.39",
      status: "idle",
    });
  });

  test("does not treat malformed HTTP 2xx heartbeat bodies as delivered", async () => {
    for (const responseBody of ["{}", '{"ok":false}', "not-json"]) {
      const warnings: string[] = [];
      const transport = new WorkerServerTransport({
        server: "http://127.0.0.1:3001",
        headers: { "Content-Type": "application/json" },
        workerId: "workerpal-malformed-heartbeat",
        pollMs: 2_000,
        heartbeatMs: 5_000,
        staleClaimTtlMs: 120_000,
        logWarn: (message) => warnings.push(message),
        fetchFn: (async () => new Response(responseBody, { status: 200 })) as typeof fetch,
      });

      expect(await transport.sendHeartbeat(heartbeatPayload())).toBe(false);
      expect(transport.getHealthSnapshot().consecutiveHeartbeatFailures).toBe(1);
      expect(warnings.join("\n")).toContain("heartbeat rejected (200)");
    }
  });

  test("keeps heartbeat delivery independent from blocked job-log transport", async () => {
    let resolveLogRequest: (() => void) | null = null;
    const seenUrls: string[] = [];
    const transport = new WorkerServerTransport({
      server: "http://127.0.0.1:3001",
      headers: { "Content-Type": "application/json" },
      workerId: "workerpal-test",
      pollMs: 2_000,
      heartbeatMs: 5_000,
      staleClaimTtlMs: 120_000,
      fetchFn: ((input: RequestInfo | URL) => {
        const url = String(input);
        seenUrls.push(url);
        if (url.endsWith("/jobs/job-1/log")) {
          return new Promise<Response>((resolve) => {
            resolveLogRequest = () => resolve(new Response('{"ok":true}', { status: 200 }));
          });
        }
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      }) as typeof fetch,
    });

    void transport.queueJobLog("job-1", {
      stream: "stdout",
      seq: 1,
      message: "line 1",
      ts: new Date().toISOString(),
    });

    await Promise.resolve();

    const heartbeatOk = await transport.sendHeartbeat(heartbeatPayload());

    expect(heartbeatOk).toBe(true);
    expect(seenUrls).toContain("http://127.0.0.1:3001/workers/heartbeat");

    resolveLogRequest?.();
    await transport.flush();
  });

  test("drops low-priority job-log requests when the queue is saturated", async () => {
    let releaseBlockedLog: (() => void) | null = null;
    let nowMs = 10_000;
    const transport = new WorkerServerTransport({
      server: "http://127.0.0.1:3001",
      headers: { "Content-Type": "application/json" },
      workerId: "workerpal-test",
      pollMs: 2_000,
      heartbeatMs: 5_000,
      staleClaimTtlMs: 120_000,
      nowFn: () => nowMs,
      fetchFn: ((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/jobs/job-1/log")) {
          return new Promise<Response>((resolve) => {
            if (!releaseBlockedLog) {
              releaseBlockedLog = () => resolve(new Response('{"ok":true}', { status: 200 }));
              return;
            }
            resolve(new Response('{"ok":true}', { status: 200 }));
          });
        }
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      }) as typeof fetch,
    });

    void transport.queueJobLog("job-1", {
      stream: "stdout",
      seq: 1,
      message: "blocked",
      ts: new Date(nowMs).toISOString(),
    });
    await Promise.resolve();

    for (let index = 0; index < 300; index++) {
      nowMs += 1;
      void transport.queueJobLog("job-1", {
        stream: "stdout",
        seq: index + 2,
        message: `line ${index + 2}`,
        ts: new Date(nowMs).toISOString(),
      });
    }

    const snapshot = transport.getHealthSnapshot();
    expect(snapshot.droppedLogRequests).toBeGreaterThan(0);

    releaseBlockedLog?.();
    await transport.flush();
  });

  test("does not overlap heartbeat requests while one is already in flight", async () => {
    let resolveHeartbeat: (() => void) | null = null;
    let heartbeatRequests = 0;
    const transport = new WorkerServerTransport({
      server: "http://127.0.0.1:3001",
      headers: { "Content-Type": "application/json" },
      workerId: "workerpal-test",
      pollMs: 2_000,
      heartbeatMs: 5_000,
      staleClaimTtlMs: 120_000,
      fetchFn: ((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/workers/heartbeat")) {
          heartbeatRequests += 1;
          return new Promise<Response>((resolve) => {
            resolveHeartbeat = () => resolve(new Response('{"ok":true}', { status: 200 }));
          });
        }
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      }) as typeof fetch,
    });

    const firstHeartbeat = transport.sendHeartbeat(heartbeatPayload());
    const secondHeartbeat = await transport.sendHeartbeat(heartbeatPayload());

    expect(secondHeartbeat).toBe(false);
    expect(heartbeatRequests).toBe(1);

    resolveHeartbeat?.();
    expect(await firstHeartbeat).toBe(true);
  });

  test("bounds heartbeat delivery when headers arrive but the body never finishes", async () => {
    const warnings: string[] = [];
    const transport = new WorkerServerTransport({
      server: "http://127.0.0.1:3001",
      headers: { "Content-Type": "application/json" },
      workerId: "workerpal-test",
      pollMs: 2_000,
      heartbeatMs: 5_000,
      heartbeatTimeoutMs: 20,
      staleClaimTtlMs: 120_000,
      logWarn: (message) => warnings.push(message),
      fetchFn: (async () => neverEndingBodyResponse()) as typeof fetch,
    });

    const startedAt = Date.now();
    expect(await transport.sendHeartbeat(heartbeatPayload())).toBe(false);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(transport.getHealthSnapshot().heartbeatInFlight).toBe(false);
    expect(warnings.join("\n")).toContain("request timed out after 20ms (/workers/heartbeat)");
  });

  test("a stalled queued response body cannot block heartbeats or later requests indefinitely", async () => {
    const seenUrls: string[] = [];
    const transport = new WorkerServerTransport({
      server: "http://127.0.0.1:3001",
      headers: { "Content-Type": "application/json" },
      workerId: "workerpal-test",
      pollMs: 2_000,
      heartbeatMs: 5_000,
      heartbeatTimeoutMs: 50,
      requestTimeoutMs: 20,
      staleClaimTtlMs: 120_000,
      logWarn: () => undefined,
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input);
        seenUrls.push(url);
        if (url.endsWith("/jobs/job-1/log")) return neverEndingBodyResponse();
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch,
    });

    const stalledLog = transport.queueJobLog("job-1", {
      stream: "stdout",
      seq: 1,
      message: "line 1",
      ts: new Date().toISOString(),
    });
    await Promise.resolve();

    expect(await transport.sendHeartbeat(heartbeatPayload())).toBe(true);
    const laterCommand = transport.queueSessionCommand("session-1", {
      type: "job_progress",
      payload: { jobId: "job-1", message: "still working" },
      from: "worker:workerpal-test",
    });

    await Promise.all([stalledLog, laterCommand, transport.flush(1_000)]);

    expect(seenUrls).toContain("http://127.0.0.1:3001/workers/heartbeat");
    expect(seenUrls).toContain("http://127.0.0.1:3001/sessions/session-1/command");
    expect(transport.getHealthSnapshot().queuedRequests).toBe(0);
  });

  test("recycles after sustained heartbeat failures even before the first successful heartbeat", async () => {
    let nowMs = 0;
    const transport = new WorkerServerTransport({
      server: "http://127.0.0.1:3001",
      headers: { "Content-Type": "application/json" },
      workerId: "workerpal-test",
      pollMs: 2_000,
      heartbeatMs: 5_000,
      staleClaimTtlMs: 120_000,
      nowFn: () => nowMs,
      fetchFn: (() => Promise.reject(new Error("connection refused"))) as typeof fetch,
    });

    expect(await transport.sendHeartbeat(heartbeatPayload())).toBe(false);
    expect(transport.shouldRecycleBusyWorker()).toBe(false);

    nowMs = 91_000;
    expect(await transport.sendHeartbeat(heartbeatPayload())).toBe(false);
    expect(transport.shouldRecycleBusyWorker()).toBe(true);
  });
});
