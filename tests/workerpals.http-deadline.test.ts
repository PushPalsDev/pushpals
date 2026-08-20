import { describe, expect, test } from "bun:test";
import { WorkerServerTransport } from "../apps/workerpals/src/common/server_transport";
import { fetchWorkerCriticResponseWithHardDeadline } from "../apps/workerpals/src/execute_job";
import { postJsonWithTimeout } from "../apps/workerpals/src/workerpals_main";

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

describe("workerpals control-plane HTTP deadlines", () => {
  test("bounds a control-plane POST when response headers never arrive", async () => {
    const fetchFn = (() => new Promise<Response>(() => {})) as typeof fetch;
    const startedAt = Date.now();

    await expect(
      postJsonWithTimeout(
        "http://127.0.0.1:3001/jobs/claim",
        { "Content-Type": "application/json" },
        { workerId: "workerpal-test" },
        20,
        fetchFn,
      ),
    ).rejects.toThrow("request timed out after 20ms: http://127.0.0.1:3001/jobs/claim");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("bounds completion, terminal, diagnostics, and telemetry bodies", async () => {
    const fetchFn = (async () => neverEndingBodyResponse()) as typeof fetch;
    const startedAt = Date.now();
    const paths = [
      "/completions/enqueue",
      "/jobs/job-1/complete",
      "/jobs/job-1/fail",
      "/jobs/job-1/publish-blocked",
      "/jobs/job-1/diagnostics",
      "/telemetry/llm-usage",
      "/tool-runs",
    ];

    for (const path of paths) {
      await expect(
        postJsonWithTimeout(
          `http://127.0.0.1:3001${path}`,
          { "Content-Type": "application/json" },
          { jobId: "job-1" },
          20,
          fetchFn,
        ),
      ).rejects.toThrow(`request timed out after 20ms: http://127.0.0.1:3001${path}`);
    }

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("preserves status, detail text, and JSON payload semantics after buffering", async () => {
    const detailResponse = await postJsonWithTimeout(
      "http://127.0.0.1:3001/jobs/job-1/fail",
      { "Content-Type": "application/json" },
      { message: "failed" },
      100,
      (async () => new Response("terminal detail", { status: 409 })) as typeof fetch,
    );
    expect(detailResponse.ok).toBe(false);
    expect(detailResponse.status).toBe(409);
    expect(await detailResponse.text()).toBe("terminal detail");

    const diagnosticResponse = await postJsonWithTimeout(
      "http://127.0.0.1:3001/jobs/job-1/diagnostics",
      { "Content-Type": "application/json" },
      { diagnostics: {} },
      100,
      (async () =>
        new Response(JSON.stringify({ ok: true, counts: { validationRuns: 1 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
    );
    expect(await diagnosticResponse.json()).toEqual({
      ok: true,
      counts: { validationRuns: 1 },
    });
  });

  test("a stalled claim body does not prevent the independent heartbeat channel", async () => {
    const stalledClaim = postJsonWithTimeout(
      "http://127.0.0.1:3001/jobs/claim",
      { "Content-Type": "application/json" },
      { workerId: "workerpal-test" },
      40,
      (async () => neverEndingBodyResponse()) as typeof fetch,
    );
    const stalledClaimError = stalledClaim.then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    const transport = new WorkerServerTransport({
      server: "http://127.0.0.1:3001",
      headers: { "Content-Type": "application/json" },
      workerId: "workerpal-test",
      pollMs: 2_000,
      heartbeatMs: 5_000,
      heartbeatTimeoutMs: 20,
      staleClaimTtlMs: 120_000,
      fetchFn: (async () => Response.json({ ok: true }, { status: 200 })) as typeof fetch,
    });

    expect(await transport.sendHeartbeat({ status: "idle", currentJobId: null })).toBe(true);
    expect((await stalledClaimError)?.message).toContain("request timed out after 40ms");
  });

  test("preserves critic timeout semantics when fetch ignores abort during body consumption", async () => {
    const startedAt = Date.now();
    const result = await fetchWorkerCriticResponseWithHardDeadline({
      endpoint: "http://127.0.0.1:1234/v1/chat/completions",
      init: { method: "POST", body: "{}" },
      timeoutMs: 20,
      fetchFn: (async () => neverEndingBodyResponse()) as typeof fetch,
    });

    expect(result.timedOut).toBeTrue();
    if (result.timedOut) {
      expect(result.err.message).toBe("quality-critic HTTP request timed out after 20ms");
    }
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
