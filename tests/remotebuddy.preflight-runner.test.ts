import { describe, expect, spyOn, test } from "bun:test";

import type { StartupChecklistContext } from "../apps/remotebuddy/src/startup/checklist";
import type {
  DependencyCheckOutcome,
  DependencyCheckIssue,
} from "../apps/remotebuddy/src/startup/dependency_check";
import type {
  PreflightCheckResult,
  PreflightFailure,
} from "../apps/remotebuddy/src/startup/preflight_report";
import { runRemotebuddyPreflight } from "../apps/remotebuddy/src/startup/preflight_runner";

const buildContext = (overrides: Partial<StartupChecklistContext> = {}) => ({
  describeRepo: async () => ({
    isDirty: false,
    isMergeInProgress: false,
    branch: "main",
    detail: "clean",
  }),
  listFiringAlerts: async () => [],
  syntheticTester: {
    runSyntheticJob: async () => ({ ok: true, latencyMs: 42 }),
  },
  ...overrides,
});

const dependencyRecord = (status: "pass" | "fail"): PreflightCheckResult => ({
  code: status === "pass" ? "dependencies.healthy" : "dependencies.lockfile_missing",
  label:
    status === "pass"
      ? "Workspace dependency manifest is present."
      : "Workspace dependencies must be installed.",
  category: "dependencies",
  step: 0,
  status,
  detail:
    status === "pass"
      ? "package.json, bun.lock, and configs/default.toml detected."
      : "bun.lock is missing",
  action: status === "fail" ? "Run `bun install` from the repo root." : undefined,
  elapsedMs: 3,
});

describe("runRemotebuddyPreflight", () => {
  test("invokes the default dependency notifier on failure", async () => {
    const failure: PreflightFailure = {
      code: "dependencies.lockfile_missing",
      detail: "bun.lock is missing",
      action: "Run `bun install` from the repo root.",
      category: "dependencies",
      step: 0,
    };
    const issues: DependencyCheckIssue[] = [
      {
        code: failure.code,
        label: "bun.lock",
        path: "/tmp/repo/bun.lock",
        detail: "bun.lock is missing",
      },
    ];
    const dependencyOutcome: DependencyCheckOutcome = {
      ok: false,
      record: dependencyRecord("fail"),
      failure,
      issues,
    };
    const ctx = buildContext();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const result = await runRemotebuddyPreflight(ctx, {
      repoRoot: "/tmp/repo",
      dependencyCheck: async () => dependencyOutcome,
    });
    expect(result.report.ok).toBe(false);
    expect(result.report.summary.failedChecks).toBe(1);
    expect(result.report.checks[0]?.category).toBe("dependencies");
    expect(result.report.checks[0]?.status).toBe("fail");
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      "Dependency check blocked startup",
    );
    expect(
      errorSpy.mock.calls.some(([line]) => line.includes("bun install")),
    ).toBe(true);
    errorSpy.mockRestore();
  });

  test("aggregates dependency and startup checks when everything passes", async () => {
    const ctx = buildContext();
    const dependencyOutcome: DependencyCheckOutcome = {
      ok: true,
      record: dependencyRecord("pass"),
      issues: [],
    };
    const result = await runRemotebuddyPreflight(ctx, {
      repoRoot: "/tmp/preflight",
      dependencyCheck: async () => dependencyOutcome,
    });
    expect(result.report.ok).toBe(true);
    expect(result.report.checks.length).toBeGreaterThan(2);
    expect(result.report.checks[0]?.category).toBe("dependencies");
    expect(result.report.checks[0]?.step).toBe(1);
    expect(result.report.summary.totalChecks).toBe(
      result.report.checks.length,
    );
    expect(result.report.summary.failedChecks).toBe(0);
    expect(result.checklistResult?.history.length).toBe(
      result.report.checks.length - 1,
    );
    const codes = result.report.checks.map((entry) => entry.code);
    expect(codes).toContain("startup.merge_in_progress");
    expect(codes).toContain("startup.synthetic_failed");
  });
});
