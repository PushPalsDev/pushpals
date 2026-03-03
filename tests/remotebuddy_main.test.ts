import { describe, expect, test } from "bun:test";

import {
  PREFLIGHT_SCHEMA_VERSION,
  buildPreflightReport,
  formatPreflightReport,
} from "../apps/remotebuddy/src/startup/preflight_report";
import type { PreflightCheckResult } from "../apps/remotebuddy/src/startup/preflight_report";

const buildSampleChecks = (): PreflightCheckResult[] => [
  {
    code: "dependencies.healthy",
    label: "Workspace dependency manifest is present.",
    category: "dependencies",
    step: 1,
    status: "pass",
    detail: "package.json and bun.lock detected.",
    elapsedMs: 3,
  },
  {
    code: "startup.repo_dirty",
    label: "Worktree must be clean.",
    category: "repo",
    step: 2,
    status: "fail",
    detail: "Dirty worktree",
    action: "Commit changes before dispatch.",
    elapsedMs: 2,
  },
];

const buildSampleFailure = () => ({
  code: "startup.repo_dirty",
  detail: "Dirty worktree",
  action: "Commit changes before dispatch.",
  category: "repo",
  step: 2,
});

describe("remotebuddy preflight report formatting", () => {
  test("produces stable output without legacy schema fields", () => {
    const checks = buildSampleChecks();
    const report = buildPreflightReport({ repoRoot: "/tmp/repo", checks, failure: buildSampleFailure() });
    const lines = formatPreflightReport(report);
    expect(lines[0]).toContain("repo=/tmp/repo");
    expect(lines.some((line) => line.includes("[FAIL]"))).toBe(true);
    for (const line of lines) {
      expect(line.includes("legacy_"), "legacy field leaked into output").toBe(false);
    }
  });

  test("buildPreflightReport emits canonical schema", () => {
    const checks = buildSampleChecks();
    const report = buildPreflightReport({
      repoRoot: "/tmp/repo",
      checks,
      failure: buildSampleFailure(),
    });
    expect(report.schemaVersion).toBe(PREFLIGHT_SCHEMA_VERSION);
    expect(report.repoRoot).toBe("/tmp/repo");
    expect(report.ok).toBe(false);
    expect(report.summary).toEqual({ totalChecks: 2, failedChecks: 1 });
    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);

    const allowedTopLevelKeys = [
      "checks",
      "failure",
      "generatedAt",
      "ok",
      "repoRoot",
      "schemaVersion",
      "summary",
    ];
    expect(Object.keys(report).sort()).toEqual(allowedTopLevelKeys);

    const allowedCheckKeys = new Set([
      "action",
      "category",
      "code",
      "detail",
      "elapsedMs",
      "label",
      "status",
      "step",
    ]);
    for (const entry of report.checks) {
      expect(entry.category).toBeDefined();
      expect(entry.step).toBeGreaterThan(0);
      expect(entry.status === "pass" || entry.status === "fail").toBe(true);
      expect(
        Object.keys(entry).every((key) => allowedCheckKeys.has(key)),
      ).toBe(true);
    }

    expect(report.failure).toMatchObject({
      code: "startup.repo_dirty",
      action: "Commit changes before dispatch.",
      category: "repo",
      step: 2,
    });
    const allowedFailureKeys = ["action", "category", "code", "detail", "step"];
    expect(Object.keys(report.failure ?? {}).sort()).toEqual(allowedFailureKeys);
  });
});
