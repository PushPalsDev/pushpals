import type {
  StartupCheckCategory,
  StartupChecklistFailure,
  StartupCheckRecord,
  StartupCheckStatus,
} from "./checklist.js";

export const PREFLIGHT_SCHEMA_VERSION = 1;

export type PreflightCheckCategory = StartupCheckCategory | "dependencies";
export type PreflightCheckStatus = StartupCheckStatus;

export interface PreflightCheckResult {
  code: string;
  label: string;
  category: PreflightCheckCategory;
  step: number;
  status: PreflightCheckStatus;
  detail: string;
  action?: string;
  elapsedMs: number;
}

export interface PreflightFailure {
  code: string;
  detail: string;
  action: string;
  category: PreflightCheckCategory;
  step: number;
}

export interface PreflightReportSummary {
  totalChecks: number;
  failedChecks: number;
}

export interface PreflightReport {
  schemaVersion: number;
  generatedAt: string;
  repoRoot: string;
  ok: boolean;
  failure?: PreflightFailure;
  checks: PreflightCheckResult[];
  summary: PreflightReportSummary;
}

export function convertStartupRecord(
  record: StartupCheckRecord,
  stepOffset = 0,
): PreflightCheckResult {
  return {
    code: record.code,
    label: record.label,
    category: record.category,
    step: record.step + stepOffset,
    status: record.status,
    detail: record.detail,
    action: record.action,
    elapsedMs: record.elapsedMs,
  };
}

export function convertStartupFailure(
  failure: StartupChecklistFailure,
  stepOffset = 0,
): PreflightFailure {
  return {
    code: failure.code,
    detail: failure.detail,
    action: failure.action,
    category: failure.category,
    step: failure.step + stepOffset,
  };
}

export function withCheckStep(
  record: PreflightCheckResult,
  step: number,
): PreflightCheckResult {
  return {
    ...record,
    step,
  };
}

export function withFailureStep(failure: PreflightFailure, step: number): PreflightFailure {
  return {
    ...failure,
    step,
  };
}

export function buildPreflightReport(options: {
  repoRoot: string;
  checks: PreflightCheckResult[];
  failure?: PreflightFailure;
}): PreflightReport {
  const { repoRoot, checks, failure } = options;
  const failedChecks = checks.filter((entry) => entry.status === "fail").length;
  const summary: PreflightReportSummary = {
    totalChecks: checks.length,
    failedChecks,
  };
  return {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    repoRoot,
    ok: failedChecks === 0,
    failure,
    checks,
    summary,
  };
}

export function formatPreflightReport(report: PreflightReport): string[] {
  const lines: string[] = [];
  lines.push(`[preflight] repo=${report.repoRoot}`);
  for (const check of report.checks) {
    const status = check.status === "pass" ? "PASS" : "FAIL";
    const actionSuffix = check.status === "fail" && check.action ? ` | action: ${check.action}` : "";
    lines.push(
      `[preflight] [${status}] step=${check.step} code=${check.code} :: ${check.detail}${actionSuffix}`,
    );
  }
  const suffix = report.ok ? "PASSED" : "FAILED";
  lines.push(
    `[preflight] ${suffix} (${report.summary.totalChecks} checks, ${report.summary.failedChecks} failed)`,
  );
  if (!report.ok && report.failure) {
    lines.push(
      `[preflight] failure=${report.failure.code} step=${report.failure.step} detail=${report.failure.detail}`,
    );
    lines.push(`[preflight] action=${report.failure.action}`);
  }
  return lines;
}
