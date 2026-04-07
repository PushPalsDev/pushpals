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

describe("workerpals server transport", () => {
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
            resolveLogRequest = () => resolve(new Response("{}", { status: 200 }));
          });
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
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
              releaseBlockedLog = () => resolve(new Response("{}", { status: 200 }));
              return;
            }
            resolve(new Response("{}", { status: 200 }));
          });
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
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
            resolveHeartbeat = () => resolve(new Response("{}", { status: 200 }));
          });
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });

    const firstHeartbeat = transport.sendHeartbeat(heartbeatPayload());
    const secondHeartbeat = await transport.sendHeartbeat(heartbeatPayload());

    expect(secondHeartbeat).toBe(false);
    expect(heartbeatRequests).toBe(1);

    resolveHeartbeat?.();
    expect(await firstHeartbeat).toBe(true);
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
