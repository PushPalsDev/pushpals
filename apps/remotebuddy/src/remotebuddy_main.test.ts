import { describe, expect, mock, test } from "bun:test";
import {
  ensureDependencySnapshot,
  notifyDependencyPreflightBlock,
  type DependencyPreflightCacheLike,
} from "./dependency_gate.js";
import type { PreflightReport } from "./preflight.js";

const healthyReport: PreflightReport = {
  ok: true,
  policyVersion: "policy-a",
  expectedPolicyVersion: "policy-a",
  startedAt: "2026-03-02T00:00:00.000Z",
  finishedAt: "2026-03-02T00:00:03.000Z",
  durationMs: 3,
  repoRoot: "/repo",
  checks: [
    {
      id: "policy.version_match",
      name: "Policy",
      status: "pass",
      details: "match",
    },
  ],
};

describe("ensureDependencySnapshot", () => {
  test("returns dependency snapshot when cache is healthy", async () => {
    const cache: DependencyPreflightCacheLike = {
      healthy: async () => ({ ok: true, report: healthyReport }),
    };
    const onFailure = mock(async () => {});

    const snapshot = await ensureDependencySnapshot(cache, onFailure);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.policyVersion).toBe("policy-a");
    expect(snapshot?.checks).toEqual([
      {
        id: "policy.version_match",
        name: "Policy",
        status: "pass",
        details: "match",
      },
    ]);
    expect(onFailure.mock.calls.length).toBe(0);
  });

  test("invokes failure callback and halts dispatch when cache reports failure", async () => {
    const failingReport: PreflightReport = {
      ...healthyReport,
      ok: false,
      checks: [
        {
          id: "policy.version_match",
          name: "Policy",
          status: "fail",
          details: "mismatch",
          remediation: "fix it",
        },
      ],
    };
    const cache: DependencyPreflightCacheLike = {
      healthy: async () => ({ ok: false, report: failingReport, failed: failingReport.checks }),
    };
    const onFailure = mock(async () => {});

    const snapshot = await ensureDependencySnapshot(cache, onFailure);
    expect(snapshot).toBeNull();
    expect(onFailure.mock.calls.length).toBe(1);
    expect(onFailure.mock.calls[0]?.[0]).toBe(failingReport);
  });
});

describe("notifyDependencyPreflightBlock", () => {
  test("sends assistant message, posts failure detail, and remembers block", async () => {
    const failingReport: PreflightReport = {
      ...healthyReport,
      ok: false,
      checks: [
        {
          id: "env.required",
          name: "Env",
          status: "fail",
          details: "missing config",
          remediation: "set vars",
        },
      ],
    };
    const assistantMessage = mock(async () => {});
    const fetchImpl = mock(async () => new Response("ok", { status: 200 }));
    const remember = mock(() => {});

    await notifyDependencyPreflightBlock({
      requestId: "req-123",
      turnId: "turn-456",
      report: failingReport,
      comm: { assistantMessage },
      server: "http://localhost:3001",
      authHeaders: () => ({ Authorization: "Bearer token" }),
      fetchImpl,
      remember,
      logger: { error: () => {} },
    });

    expect(assistantMessage.mock.calls.length).toBe(1);
    const [message, meta] = assistantMessage.mock.calls[0]!;
    expect(message).toContain("Cannot dispatch a WorkerPal yet");
    expect(message).toContain("missing config");
    expect(meta).toEqual({ turnId: "turn-456", correlationId: "req-123" });

    expect(fetchImpl.mock.calls.length).toBe(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost:3001/requests/req-123/fail");
    expect(remember.mock.calls.length).toBe(1);
    expect(remember.mock.calls[0]?.[0]).toBe("dependency_block");
  });
});
