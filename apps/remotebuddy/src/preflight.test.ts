import { describe, expect, mock, test } from "bun:test";
import {
  DependencyPreflightCache,
  REMOTEBUDDY_DEPENDENCY_POLICY_VERSION,
  runPreflightChecks,
  summarizePreflightFailure,
  toDependencySnapshot,
  type PreflightReport,
} from "./preflight.js";

describe("runPreflightChecks", () => {
  const config = { server: { url: "http://localhost:3001" } };

  test("emits deterministic order with actionable data", async () => {
    let now = 1_700_000_000_000;
    const execCalls: string[] = [];
    const report = await runPreflightChecks({
      repoRoot: "/repo",
      config,
      env: {
        PUSHPALS_AUTH_TOKEN: "token",
        REMOTE_STABLE_ID: "stable",
        WORKERPALS_API_URL: "http://localhost:4000",
        SERVER_BASE_URL: "http://localhost:4001",
      },
      exec: async (cmd) => {
        execCalls.push(cmd.join(" "));
        if (cmd[1] === "status") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd[1] === "rev-parse") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command ${cmd.join(" ")}`);
      },
      fsExists: () => true,
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.endsWith("/healthz")) {
          return new Response("ok", { status: 200 });
        }
        if (target.endsWith("/system/status")) {
          return new Response(
            JSON.stringify({
              queues: { requests: { pending: { interactive: 0 } } },
              workers: { idle: 5 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch ${target}`);
      },
      now: () => {
        now += 10;
        return now;
      },
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual([
      "policy.version_match",
      "repo.git_clean",
      "repo.merge_conflict",
      "deps.node_modules",
      "env.required",
      "server.healthz",
      "server.system_status",
    ]);
    expect(execCalls).toEqual([
      "git status --porcelain",
      "git rev-parse -q --verify MERGE_HEAD",
    ]);
  });

  test("summarizes missing env vars with remediation", async () => {
    const execStub = async (cmd: string[]) => {
      if (cmd[1] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd[1] === "rev-parse") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const report = await runPreflightChecks({
      repoRoot: "/repo",
      config,
      env: {},
      exec: execStub,
      fsExists: () => true,
      fetchImpl: mock(async () => new Response("ok", { status: 200 })),
      now: () => 0,
    });

    expect(report.ok).toBe(false);
    const envCheck = report.checks.find((c) => c.id === "env.required");
    expect(envCheck?.status).toBe("fail");
    expect(envCheck?.remediation).toContain("Export");
    expect(summarizePreflightFailure(report)).toContain("Missing env vars");
  });

  test("fails fast when dependency policy mismatches expected value", async () => {
    const execStub = async (cmd: string[]) => {
      if (cmd[1] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd[1] === "rev-parse") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const report = await runPreflightChecks({
      repoRoot: "/repo",
      config,
      env: {
        REMOTEBUDDY_DEPENDENCY_POLICY_VERSION: "policy-v2",
        PUSHPALS_AUTH_TOKEN: "token",
        REMOTE_STABLE_ID: "stable",
        WORKERPALS_API_URL: "http://localhost:4000",
        SERVER_BASE_URL: "http://localhost:4001",
      },
      exec: execStub,
      fsExists: () => true,
      fetchImpl: mock(async (url: string | URL) => {
        const target = String(url);
        return target.endsWith("/system/status")
          ? new Response('{"workers":{"idle":5},"queues":{"requests":{"pending":{"interactive":0}}}}', {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          : new Response("ok", { status: 200 });
      }),
      now: () => 0,
    });

    expect(report.ok).toBe(false);
    const policyCheck = report.checks[0];
    expect(policyCheck.id).toBe("policy.version_match");
    expect(policyCheck.status).toBe("fail");
    expect(policyCheck.details).toContain("policy-v2");
    expect(report.expectedPolicyVersion).toBe("policy-v2");
  });
});

describe("DependencyPreflightCache", () => {
  const buildReport = (ok: boolean): PreflightReport => ({
    ok,
    policyVersion: "test-policy",
    expectedPolicyVersion: REMOTEBUDDY_DEPENDENCY_POLICY_VERSION,
    startedAt: "2026-03-02T00:00:00.000Z",
    finishedAt: "2026-03-02T00:00:10.000Z",
    durationMs: 10,
    repoRoot: "/repo",
    checks: [
      {
        id: "sample",
        name: "Sample",
        status: ok ? "pass" : "fail",
        details: ok ? "ready" : "blocked",
        remediation: ok ? undefined : "run preflight",
      },
    ],
  });

  test("caches successful reports", async () => {
    let runs = 0;
    const cache = new DependencyPreflightCache({
      ttlMs: 60_000,
      runner: async () => {
        runs += 1;
        return buildReport(true);
      },
    });

    const first = await cache.healthy();
    const second = await cache.healthy();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(runs).toBe(1);
  });

  test("surfaces failures with summaries", async () => {
    const cache = new DependencyPreflightCache({
      ttlMs: 60_000,
      runner: async () => buildReport(false),
    });

    const result = await cache.healthy();
    expect(result.ok).toBe(false);
    expect(result.failed[0].status).toBe("fail");
    expect(summarizePreflightFailure(result.report)).toContain("run preflight");
  });
});

describe("toDependencySnapshot", () => {
  test("converts report into stable snapshot payload", () => {
    const report: PreflightReport = {
      ok: true,
      policyVersion: "policy-a",
      expectedPolicyVersion: "policy-a",
      startedAt: "2026-03-02T00:00:00.000Z",
      finishedAt: "2026-03-02T00:00:05.000Z",
      durationMs: 5,
      repoRoot: "/repo",
      checks: [
        {
          id: "one",
          name: "One",
          status: "pass",
          details: "good",
        },
      ],
    };

    const snapshot = toDependencySnapshot(report);
    expect(snapshot.policyVersion).toBe("policy-a");
    expect(snapshot.generatedAt).toBe("2026-03-02T00:00:05.000Z");
    expect(snapshot.checks).toEqual([
      {
        id: "one",
        name: "One",
        status: "pass",
        details: "good",
      },
    ]);
  });
});
