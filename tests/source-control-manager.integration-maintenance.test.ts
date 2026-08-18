import { describe, expect, test } from "bun:test";
import {
  IntegrationMaintenanceRunner,
  maintainIntegrationBeforeCompletionClaim,
  type IntegrationMaintenanceConfig,
  type IntegrationMaintenanceOutcome,
} from "../apps/source_control_manager/src/integration_maintenance";
import type { IntegrationBaseSyncResult } from "../apps/source_control_manager/src/git";

const INTEGRATION_SHA = "1111111111111111111111111111111111111111";
const BASE_SHA = "2222222222222222222222222222222222222222";
const MERGED_SHA = "3333333333333333333333333333333333333333";

function makeConfig(
  overrides: Partial<IntegrationMaintenanceConfig> = {},
): IntegrationMaintenanceConfig {
  return {
    remote: "origin",
    mainBranch: "main_agents",
    integrationBaseBranch: "main",
    pushMainAfterMerge: true,
    serverUrl: "http://127.0.0.1:3001",
    ...overrides,
  };
}

function successfulPush() {
  return { ok: true, stdout: "", stderr: "", exitCode: 0 };
}

function upToDateSync(): IntegrationBaseSyncResult {
  return {
    status: "up_to_date",
    integrationHeadSha: MERGED_SHA,
    baseHeadSha: BASE_SHA,
    conflictPaths: [],
  };
}

function updatedSync(): IntegrationBaseSyncResult {
  return {
    status: "updated",
    integrationHeadSha: INTEGRATION_SHA,
    baseHeadSha: BASE_SHA,
    mergedHeadSha: MERGED_SHA,
    conflictPaths: [],
  };
}

function conflictedSync(): IntegrationBaseSyncResult {
  return {
    status: "conflicted",
    integrationHeadSha: INTEGRATION_SHA,
    baseHeadSha: BASE_SHA,
    conflictPaths: ["src/conflict.ts"],
    detail: "CONFLICT (content): Merge conflict in src/conflict.ts",
  };
}

function noOpLogger() {
  return {
    log() {},
    warn() {},
  };
}

describe("SourceControlManager continuous integration maintenance", () => {
  test("reconciles divergence before an empty completion claim", async () => {
    const events: string[] = [];
    let outcome: IntegrationMaintenanceOutcome | null = null;
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 10_000,
      sessionId: "dev",
      now: () => 1_700_000_000_000,
      logger: noOpLogger(),
      gitOps: {
        async fetchPrune() {
          events.push("fetch");
        },
        async alignMainToRemote() {
          events.push("align");
          return INTEGRATION_SHA;
        },
        async checkoutMain() {
          events.push("checkout");
        },
        async pullMainFF() {
          events.push("pull");
        },
        async syncMainWithBaseBranch() {
          events.push("sync");
          return updatedSync();
        },
        async pushMain() {
          events.push("push");
          return successfulPush();
        },
        async resetToClean() {
          events.push("reset");
        },
      },
    });

    const claim = await maintainIntegrationBeforeCompletionClaim({
      maintain: async () => {
        outcome = await runner.run(makeConfig(), {});
      },
      claimCompletion: async () => {
        events.push("claim-empty");
        return { status: 404 };
      },
    });

    expect(outcome).toMatchObject({ status: "reconciled", mergedHeadSha: MERGED_SHA });
    expect(claim.status).toBe(404);
    expect(events).toEqual(["fetch", "align", "sync", "push", "fetch", "claim-empty"]);
  });

  test("realigns to the fetched remote head on every eligible maintenance cycle", async () => {
    let now = 10_000;
    let syncIndex = 0;
    const events: string[] = [];
    const syncs = [upToDateSync(), updatedSync()];
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => now,
      logger: noOpLogger(),
      gitOps: {
        async fetchPrune() {
          events.push("fetch");
        },
        async alignMainToRemote() {
          events.push("align");
          return syncIndex === 0 ? MERGED_SHA : INTEGRATION_SHA;
        },
        async checkoutMain() {
          throw new Error("checkout fallback should not run when the remote head exists");
        },
        async pullMainFF() {
          throw new Error("pull fallback should not run when the remote head exists");
        },
        async syncMainWithBaseBranch() {
          events.push("sync");
          const sync = syncs[Math.min(syncIndex, syncs.length - 1)] ?? upToDateSync();
          syncIndex += 1;
          return sync;
        },
        async pushMain() {
          events.push("push");
          return successfulPush();
        },
        async resetToClean() {
          events.push("reset");
        },
      },
    });

    expect((await runner.run(makeConfig(), {})).status).toBe("up_to_date");
    expect((await runner.run(makeConfig(), {})).status).toBe("skipped");

    now += 1_000;
    expect((await runner.run(makeConfig(), {})).status).toBe("reconciled");
    expect(events.filter((event) => event === "align")).toHaveLength(2);
    expect(events).toEqual(["fetch", "align", "sync", "fetch", "align", "sync", "push", "fetch"]);
  });

  test("deduplicates repeated conflict repair dispatch while maintenance keeps ticking", async () => {
    let now = 20_000;
    const payloads: Array<Record<string, unknown>> = [];
    let enqueueCount = 0;
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => now,
      logger: noOpLogger(),
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        enqueueCount += 1;
        payloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            ok: true,
            jobId: "job-integration-repair",
            deduped: enqueueCount > 1,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
      gitOps: {
        async fetchPrune() {},
        async alignMainToRemote() {
          return INTEGRATION_SHA;
        },
        async checkoutMain() {},
        async pullMainFF() {},
        async syncMainWithBaseBranch() {
          return conflictedSync();
        },
        async pushMain() {
          throw new Error("conflicts must dispatch repair instead of pushing");
        },
        async resetToClean() {},
      },
    });

    const first = await runner.run(makeConfig(), { Authorization: "Bearer test" });
    now += 1_000;
    const second = await runner.run(makeConfig(), { Authorization: "Bearer test" });

    expect(first.status).toBe("repair_dispatched");
    expect(second.status).toBe("repair_deduped");
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.dedupeKey).toBe(payloads[1]?.dedupeKey);
    expect(payloads[0]?.priority).toBe("interactive");
    expect(
      ((payloads[0]?.params as Record<string, unknown>).reviewAgent as Record<string, unknown>)
        .resolutionType,
    ).toBe("integration_reconcile");
  });

  test("turns transient maintenance failure into a bounded retry instead of freezing", async () => {
    let now = 30_000;
    let fetchAttempts = 0;
    let resets = 0;
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => now,
      logger: noOpLogger(),
      gitOps: {
        async fetchPrune() {
          fetchAttempts += 1;
          if (fetchAttempts === 1) throw new Error("temporary remote outage");
        },
        async alignMainToRemote() {
          return MERGED_SHA;
        },
        async checkoutMain() {},
        async pullMainFF() {},
        async syncMainWithBaseBranch() {
          return upToDateSync();
        },
        async pushMain() {
          return successfulPush();
        },
        async resetToClean() {
          resets += 1;
        },
      },
    });

    const failed = await runner.run(makeConfig(), {});
    const throttled = await runner.run(makeConfig(), {});
    now += 1_000;
    const recovered = await runner.run(makeConfig(), {});

    expect(failed).toMatchObject({
      status: "retry_scheduled",
      error: "temporary remote outage",
    });
    expect(throttled.status).toBe("skipped");
    expect(recovered.status).toBe("up_to_date");
    expect(fetchAttempts).toBe(2);
    expect(resets).toBe(1);
  });

  test("retries from the remote after a reconciled push fails", async () => {
    let now = 40_000;
    let pushAttempts = 0;
    let alignments = 0;
    let resets = 0;
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => now,
      logger: noOpLogger(),
      gitOps: {
        async fetchPrune() {},
        async alignMainToRemote() {
          alignments += 1;
          return INTEGRATION_SHA;
        },
        async checkoutMain() {},
        async pullMainFF() {},
        async syncMainWithBaseBranch() {
          return updatedSync();
        },
        async pushMain() {
          pushAttempts += 1;
          return pushAttempts === 1
            ? { ok: false, stdout: "", stderr: "non-fast-forward", exitCode: 1 }
            : successfulPush();
        },
        async resetToClean() {
          resets += 1;
        },
      },
    });

    expect((await runner.run(makeConfig(), {})).status).toBe("retry_scheduled");
    now += 1_000;
    expect((await runner.run(makeConfig(), {})).status).toBe("reconciled");
    expect(alignments).toBe(2);
    expect(pushAttempts).toBe(2);
    expect(resets).toBe(1);
  });

  test("falls back to checkout and fast-forward pull when the remote integration ref is absent", async () => {
    const events: string[] = [];
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => 50_000,
      logger: noOpLogger(),
      gitOps: {
        async fetchPrune() {
          events.push("fetch");
        },
        async alignMainToRemote() {
          events.push("align-missing");
          return null;
        },
        async checkoutMain() {
          events.push("checkout");
        },
        async pullMainFF() {
          events.push("pull");
        },
        async syncMainWithBaseBranch() {
          events.push("sync");
          return upToDateSync();
        },
        async pushMain() {
          return successfulPush();
        },
        async resetToClean() {},
      },
    });

    expect((await runner.run(makeConfig(), {})).status).toBe("up_to_date");
    expect(events).toEqual(["fetch", "align-missing", "checkout", "pull", "sync"]);
  });

  test("coalesces overlapping maintenance calls into one reconciliation operation", async () => {
    let releaseFetch: (() => void) | null = null;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetches = 0;
    let syncs = 0;
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => 60_000,
      logger: noOpLogger(),
      gitOps: {
        async fetchPrune() {
          fetches += 1;
          await fetchGate;
        },
        async alignMainToRemote() {
          return MERGED_SHA;
        },
        async checkoutMain() {},
        async pullMainFF() {},
        async syncMainWithBaseBranch() {
          syncs += 1;
          return upToDateSync();
        },
        async pushMain() {
          return successfulPush();
        },
        async resetToClean() {},
      },
    });

    const first = runner.run(makeConfig(), {});
    const overlapping = runner.run(makeConfig(), {});
    expect(fetches).toBe(1);
    releaseFetch?.();

    const [firstOutcome, overlappingOutcome] = await Promise.all([first, overlapping]);
    expect(firstOutcome.status).toBe("up_to_date");
    expect(overlappingOutcome.status).toBe("up_to_date");
    expect(fetches).toBe(1);
    expect(syncs).toBe(1);
  });

  test("runs immediately after a backward clock adjustment instead of waiting on a stale deadline", async () => {
    let now = 70_000;
    let fetches = 0;
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 10_000,
      sessionId: "dev",
      now: () => now,
      logger: noOpLogger(),
      gitOps: {
        async fetchPrune() {
          fetches += 1;
        },
        async alignMainToRemote() {
          return MERGED_SHA;
        },
        async checkoutMain() {},
        async pullMainFF() {},
        async syncMainWithBaseBranch() {
          return upToDateSync();
        },
        async pushMain() {
          return successfulPush();
        },
        async resetToClean() {},
      },
    });

    expect((await runner.run(makeConfig(), {})).status).toBe("up_to_date");
    now = 65_000;
    expect((await runner.run(makeConfig(), {})).status).toBe("up_to_date");
    expect(fetches).toBe(2);
  });

  test("continues to completion polling after maintenance schedules a retry", async () => {
    const events: string[] = [];
    let maintenanceOutcome: IntegrationMaintenanceOutcome | null = null;
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => 80_000,
      logger: noOpLogger(),
      gitOps: {
        async fetchPrune() {
          events.push("maintenance");
          throw new Error("remote temporarily unavailable");
        },
        async alignMainToRemote() {
          return MERGED_SHA;
        },
        async checkoutMain() {},
        async pullMainFF() {},
        async syncMainWithBaseBranch() {
          return upToDateSync();
        },
        async pushMain() {
          return successfulPush();
        },
        async resetToClean() {
          events.push("reset");
        },
      },
    });

    const claim = await maintainIntegrationBeforeCompletionClaim({
      maintain: async () => {
        maintenanceOutcome = await runner.run(makeConfig(), {});
      },
      claimCompletion: async () => {
        events.push("claim");
        return { ok: true, completion: null };
      },
    });

    expect(maintenanceOutcome?.status).toBe("retry_scheduled");
    expect(claim).toEqual({ ok: true, completion: null });
    expect(events).toEqual(["maintenance", "reset", "claim"]);
  });

  test("retries conflict dispatch after a transient enqueue outage", async () => {
    let now = 90_000;
    let enqueueAttempts = 0;
    let resets = 0;
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => now,
      logger: noOpLogger(),
      fetchImpl: (async () => {
        enqueueAttempts += 1;
        if (enqueueAttempts === 1) {
          return new Response(JSON.stringify({ message: "queue unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true, jobId: "job-recovered", deduped: false }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
      gitOps: {
        async fetchPrune() {},
        async alignMainToRemote() {
          return INTEGRATION_SHA;
        },
        async checkoutMain() {},
        async pullMainFF() {},
        async syncMainWithBaseBranch() {
          return conflictedSync();
        },
        async pushMain() {
          return successfulPush();
        },
        async resetToClean() {
          resets += 1;
        },
      },
    });

    const failed = await runner.run(makeConfig(), {});
    now += 1_000;
    const recovered = await runner.run(makeConfig(), {});

    expect(failed).toMatchObject({
      status: "retry_scheduled",
      error: "Failed to enqueue integration reconciliation job: HTTP 503 queue unavailable",
    });
    expect(recovered).toMatchObject({
      status: "repair_dispatched",
      jobId: "job-recovered",
    });
    expect(enqueueAttempts).toBe(2);
    expect(resets).toBe(1);
  });

  test("bounds a conflict-dispatch response body that never finishes", async () => {
    let resets = 0;
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => 95_000,
      logger: noOpLogger(),
      httpTimeoutMs: 20,
      fetchImpl: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Headers arrive, but the server never closes the JSON body.
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
      gitOps: {
        async fetchPrune() {},
        async alignMainToRemote() {
          return INTEGRATION_SHA;
        },
        async checkoutMain() {},
        async pullMainFF() {},
        async syncMainWithBaseBranch() {
          return conflictedSync();
        },
        async pushMain() {
          return successfulPush();
        },
        async resetToClean() {
          resets += 1;
        },
      },
    });

    const startedAt = Date.now();
    const outcome = await runner.run(makeConfig(), {});

    expect(outcome).toMatchObject({
      status: "retry_scheduled",
      error: "Integration reconciliation enqueue timed out after 20ms",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(resets).toBe(1);
  });

  test("keeps retrying even when cleanup of the failed maintenance attempt also fails", async () => {
    let now = 100_000;
    let fetchAttempts = 0;
    let resetAttempts = 0;
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => now,
      logger: noOpLogger(),
      gitOps: {
        async fetchPrune() {
          fetchAttempts += 1;
          if (fetchAttempts === 1) throw new Error("fetch failed");
        },
        async alignMainToRemote() {
          return MERGED_SHA;
        },
        async checkoutMain() {},
        async pullMainFF() {},
        async syncMainWithBaseBranch() {
          return upToDateSync();
        },
        async pushMain() {
          return successfulPush();
        },
        async resetToClean() {
          resetAttempts += 1;
          throw new Error("cleanup failed");
        },
      },
    });

    expect((await runner.run(makeConfig(), {})).status).toBe("retry_scheduled");
    now += 1_000;
    expect((await runner.run(makeConfig(), {})).status).toBe("up_to_date");
    expect(fetchAttempts).toBe(2);
    expect(resetAttempts).toBe(1);
  });

  test("reports local-only reconciliation without attempting a prohibited push", async () => {
    let pushes = 0;
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => 110_000,
      logger: noOpLogger(),
      gitOps: {
        async fetchPrune() {},
        async alignMainToRemote() {
          return INTEGRATION_SHA;
        },
        async checkoutMain() {},
        async pullMainFF() {},
        async syncMainWithBaseBranch() {
          return updatedSync();
        },
        async pushMain() {
          pushes += 1;
          return successfulPush();
        },
        async resetToClean() {},
      },
    });

    const outcome = await runner.run(makeConfig({ pushMainAfterMerge: false }), {});
    expect(outcome).toMatchObject({ status: "local_only", mergedHeadSha: MERGED_SHA });
    expect(pushes).toBe(0);
  });

  test("changes the conflict dedupe lease when either reconciled head changes", async () => {
    let now = 120_000;
    let baseHeadSha = BASE_SHA;
    const payloads: Array<Record<string, unknown>> = [];
    const runner = new IntegrationMaintenanceRunner({
      intervalMs: 1_000,
      sessionId: "dev",
      now: () => now,
      logger: noOpLogger(),
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            ok: true,
            jobId: `job-${payloads.length}`,
            deduped: false,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
      gitOps: {
        async fetchPrune() {},
        async alignMainToRemote() {
          return INTEGRATION_SHA;
        },
        async checkoutMain() {},
        async pullMainFF() {},
        async syncMainWithBaseBranch() {
          return {
            ...conflictedSync(),
            baseHeadSha,
          };
        },
        async pushMain() {
          return successfulPush();
        },
        async resetToClean() {},
      },
    });

    expect((await runner.run(makeConfig(), {})).status).toBe("repair_dispatched");
    baseHeadSha = "4444444444444444444444444444444444444444";
    now += 1_000;
    expect((await runner.run(makeConfig(), {})).status).toBe("repair_dispatched");

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.dedupeKey).not.toBe(payloads[1]?.dedupeKey);
  });
});
