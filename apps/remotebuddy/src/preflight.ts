#!/usr/bin/env bun
import { existsSync } from "fs";
import { resolve } from "path";

export const REMOTEBUDDY_DEPENDENCY_POLICY_VERSION = "remotebuddy-preflight/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const REQUIRED_ENV_VARS = [
  "PUSHPALS_AUTH_TOKEN",
  "REMOTE_STABLE_ID",
  "WORKERPALS_API_URL",
  "SERVER_BASE_URL",
] as const;

type PushPalsConfig = {
  server: { url: string };
};

type SharedModule = {
  detectRepoRoot: (cwd: string) => string;
  loadPushPalsConfig: () => PushPalsConfig;
};

async function loadSharedModule(): Promise<SharedModule | null> {
  try {
    const mod = await import("shared");
    return mod as SharedModule;
  } catch {
    return null;
  }
}

type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ExecFn = (cmd: string[], opts?: { cwd?: string }) => Promise<ExecResult>;

type FetchLike = typeof fetch;

type EnvMap = Record<string, string | undefined>;

type PreflightStatus = "pass" | "fail";

export interface PreflightCheckResult {
  id: string;
  name: string;
  status: PreflightStatus;
  details: string;
  remediation?: string;
  meta?: Record<string, unknown>;
}

export interface PreflightReport {
  ok: boolean;
  policyVersion: string;
  expectedPolicyVersion?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  repoRoot: string;
  checks: PreflightCheckResult[];
}

export type DependencySnapshot = {
  policyVersion: string;
  generatedAt: string;
  checks: Array<{
    id: string;
    name: string;
    status: PreflightStatus;
    details: string;
    remediation?: string;
  }>;
};

interface PreflightRuntime {
  repoRoot: string;
  config: PushPalsConfig;
  env: EnvMap;
  exec: ExecFn;
  fetchImpl: FetchLike;
  fsExists: (path: string) => boolean;
  now: () => number;
  requestTimeoutMs: number;
  policyVersion: string;
  expectedPolicyVersion: string;
}

export interface PreflightOptions {
  repoRoot?: string;
  config?: PushPalsConfig;
  env?: EnvMap;
  exec?: ExecFn;
  fetchImpl?: FetchLike;
  fsExists?: (path: string) => boolean;
  now?: () => number;
  requestTimeoutMs?: number;
  expectedPolicyVersion?: string;
}

interface PreflightCheckDefinition {
  id: string;
  name: string;
  run: (ctx: PreflightRuntime) => Promise<PreflightCheckResult>;
  remediation: string;
}

const POLICY_ENV_KEY = "REMOTEBUDDY_DEPENDENCY_POLICY_VERSION";

const CHECKS: PreflightCheckDefinition[] = [
  {
    id: "policy.version_match",
    name: "Dependency policy compatibility",
    remediation: `Set ${POLICY_ENV_KEY}=${REMOTEBUDDY_DEPENDENCY_POLICY_VERSION} (or upgrade RemoteBuddy) so dependency checks and job dispatch enforce the same policy before starting RemoteBuddy.`,
    async run(ctx) {
      if (ctx.expectedPolicyVersion === ctx.policyVersion) {
        return {
          id: this.id,
          name: this.name,
          status: "pass",
          details: `Policy ${ctx.policyVersion} matches expected.`,
        };
      }
      return {
        id: this.id,
        name: this.name,
        status: "fail",
        details: `Expected ${ctx.expectedPolicyVersion}, but dependency checks are on ${ctx.policyVersion}.`,
        remediation: this.remediation,
      };
    },
  },
  {
    id: "repo.git_clean",
    name: "Git worktree clean",
    remediation: "Commit/stash local edits or run `git status --short` until clean before starting RemoteBuddy.",
    async run(ctx) {
      const result = await ctx.exec(["git", "status", "--porcelain"], { cwd: ctx.repoRoot });
      if (result.exitCode !== 0) {
        return {
          id: this.id,
          name: this.name,
          status: "fail",
          details: `Could not read git status (exit ${result.exitCode}).`,
          remediation: this.remediation,
        };
      }
      const dirty = result.stdout.trim().length > 0;
      return dirty
        ? {
            id: this.id,
            name: this.name,
            status: "fail",
            details: "Working tree has uncommitted changes.",
            remediation: this.remediation,
          }
        : {
            id: this.id,
            name: this.name,
            status: "pass",
            details: "Working tree is clean.",
          };
    },
  },
  {
    id: "repo.merge_conflict",
    name: "No merge/rebase in progress",
    remediation: "Complete or abort any merge/rebase (`git merge --abort`) before launching RemoteBuddy.",
    async run(ctx) {
      const result = await ctx.exec([
        "git",
        "rev-parse",
        "-q",
        "--verify",
        "MERGE_HEAD",
      ], {
        cwd: ctx.repoRoot,
      });
      if (result.exitCode === 0) {
        return {
          id: this.id,
          name: this.name,
          status: "fail",
          details: "MERGE_HEAD present; merge or rebase still running.",
          remediation: this.remediation,
        };
      }
      return {
        id: this.id,
        name: this.name,
        status: "pass",
        details: "No merge/rebase detected.",
      };
    },
  },
  {
    id: "deps.node_modules",
    name: "Node modules installed",
    remediation: "Run `bun install` at the repo root so node_modules is populated before startup.",
    async run(ctx) {
      const hasModules = ctx.fsExists(resolve(ctx.repoRoot, "node_modules"));
      return hasModules
        ? {
            id: this.id,
            name: this.name,
            status: "pass",
            details: "node_modules present.",
          }
        : {
            id: this.id,
            name: this.name,
            status: "fail",
            details: "node_modules missing at repo root.",
            remediation: this.remediation,
          };
    },
  },
  {
    id: "env.required",
    name: "Required environment configured",
    remediation: "Export all required env vars (PUSHPALS_AUTH_TOKEN, REMOTE_STABLE_ID, WORKERPALS_API_URL, SERVER_BASE_URL) before running RemoteBuddy.",
    async run(ctx) {
      const missing = REQUIRED_ENV_VARS.filter((key) => !ctx.env[key]);
      if (missing.length > 0) {
        return {
          id: this.id,
          name: this.name,
          status: "fail",
          details: `Missing env vars: ${missing.join(", ")}`,
          remediation: this.remediation,
        };
      }
      return {
        id: this.id,
        name: this.name,
        status: "pass",
        details: "All required env vars present.",
      };
    },
  },
  {
    id: "server.healthz",
    name: "Server /healthz reachable",
    remediation: "Start apps/server (`bun run server:only`) and ensure it listens on CONFIG.server.url before retrying RemoteBuddy.",
    async run(ctx) {
      const startedAt = ctx.now();
      try {
        const res = await timedFetch(ctx.fetchImpl, `${ctx.config.server.url}/healthz`, {
          method: "GET",
        }, ctx.requestTimeoutMs);
        if (!res.ok) {
          return {
            id: this.id,
            name: this.name,
            status: "fail",
            details: `/healthz responded with ${res.status} ${res.statusText}.`,
            remediation: this.remediation,
          };
        }
        const elapsed = ctx.now() - startedAt;
        return {
          id: this.id,
          name: this.name,
          status: "pass",
          details: `/healthz responded ${res.status} in ${elapsed}ms`,
          meta: { status: res.status, durationMs: elapsed },
        };
      } catch (err) {
        return {
          id: this.id,
          name: this.name,
          status: "fail",
          details: `/healthz fetch failed: ${String(err)}`,
          remediation: this.remediation,
        };
      }
    },
  },
  {
    id: "server.system_status",
    name: "System status reports healthy workers",
    remediation: "Confirm WorkerPals lanes are running (`bun run workerpals:only`) and server auth token is valid.",
    async run(ctx) {
      const token = ctx.env.PUSHPALS_AUTH_TOKEN;
      if (!token) {
        return {
          id: this.id,
          name: this.name,
          status: "fail",
          details: "PUSHPALS_AUTH_TOKEN missing; cannot call /system/status.",
          remediation: this.remediation,
        };
      }
      try {
        const res = await timedFetch(
          ctx.fetchImpl,
          `${ctx.config.server.url}/system/status`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          },
          ctx.requestTimeoutMs,
        );
        if (!res.ok) {
          return {
            id: this.id,
            name: this.name,
            status: "fail",
            details: `/system/status responded ${res.status} ${res.statusText}.`,
            remediation: this.remediation,
          };
        }
        const body = (await res.json()) as any;
        const pendingInteractive = Number(body?.queues?.requests?.pending?.interactive ?? 0);
        const idleSlots = Number(body?.workers?.idle ?? 0);
        if (!Number.isFinite(idleSlots)) {
          return {
            id: this.id,
            name: this.name,
            status: "fail",
            details: "Worker idle slot count missing in /system/status payload.",
            remediation: this.remediation,
          };
        }
        if (idleSlots <= 0) {
          return {
            id: this.id,
            name: this.name,
            status: "fail",
            details: "All WorkerPals busy/offline (idle slots <= 0).",
            remediation: this.remediation,
            meta: { pendingInteractive, idleSlots },
          };
        }
        return {
          id: this.id,
          name: this.name,
          status: "pass",
          details: `Idle slots=${idleSlots}, pending(interactive)=${pendingInteractive}`,
          meta: { pendingInteractive, idleSlots },
        };
      } catch (err) {
        return {
          id: this.id,
          name: this.name,
          status: "fail",
          details: `/system/status fetch failed: ${String(err)}`,
          remediation: this.remediation,
        };
      }
    },
  },
];

async function defaultExec(cmd: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (err) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: String(err ?? "unknown error"),
    };
  }
}

async function timedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as NodeJS.Timeout).unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sanitizePolicyVersion(value: string | undefined | null): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text;
}

async function buildRuntime(options: PreflightOptions = {}): Promise<PreflightRuntime> {
  const shared = !options.repoRoot || !options.config ? await loadSharedModule() : null;
  const repoRoot =
    options.repoRoot ??
    (shared?.detectRepoRoot ? shared.detectRepoRoot(process.cwd()) : process.cwd());
  const config =
    options.config ??
    shared?.loadPushPalsConfig?.() ?? { server: { url: "http://localhost:3001" } };
  const env = options.env ?? process.env;
  const expectedPolicyVersion =
    sanitizePolicyVersion(options.expectedPolicyVersion) ??
    sanitizePolicyVersion(env?.[POLICY_ENV_KEY]) ??
    REMOTEBUDDY_DEPENDENCY_POLICY_VERSION;
  return {
    repoRoot,
    config,
    env,
    exec: options.exec ?? defaultExec,
    fetchImpl: options.fetchImpl ?? fetch,
    fsExists: options.fsExists ?? existsSync,
    now: options.now ?? (() => Date.now()),
    requestTimeoutMs: Math.max(1_000, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    policyVersion: REMOTEBUDDY_DEPENDENCY_POLICY_VERSION,
    expectedPolicyVersion,
  };
}

export async function runPreflightChecks(options: PreflightOptions = {}): Promise<PreflightReport> {
  const ctx = await buildRuntime(options);
  const started = ctx.now();
  const startedIso = new Date(started).toISOString();
  const checks: PreflightCheckResult[] = [];
  for (const check of CHECKS) {
    try {
      const result = await check.run(ctx);
      checks.push(result);
    } catch (err) {
      checks.push({
        id: check.id,
        name: check.name,
        status: "fail",
        details: `Check errored: ${String(err)}`,
        remediation: check.remediation,
      });
    }
  }
  const finished = ctx.now();
  return {
    ok: checks.every((entry) => entry.status === "pass"),
    policyVersion: ctx.policyVersion,
    expectedPolicyVersion: ctx.expectedPolicyVersion,
    startedAt: startedIso,
    finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started),
    repoRoot: ctx.repoRoot,
    checks,
  };
}

export function toDependencySnapshot(report: PreflightReport): DependencySnapshot {
  return {
    policyVersion: report.policyVersion,
    generatedAt: report.finishedAt,
    checks: report.checks.map((check) => ({
      id: check.id,
      name: check.name,
      status: check.status,
      details: check.details,
      ...(check.remediation ? { remediation: check.remediation } : {}),
    })),
  };
}

export function formatPreflightText(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push(`RemoteBuddy preflight (${report.policyVersion})`);
  lines.push(`Repo: ${report.repoRoot}`);
  lines.push(`Started: ${report.startedAt}`);
  lines.push(`Finished: ${report.finishedAt} (duration ${report.durationMs}ms)`);
  lines.push("");
  for (const check of report.checks) {
    const status = check.status === "pass" ? "PASS" : "FAIL";
    lines.push(`[${status}] ${check.id} – ${check.name}`);
    lines.push(`        ${check.details}`);
    if (check.status === "fail" && check.remediation) {
      lines.push(`        Remediation: ${check.remediation}`);
    }
  }
  lines.push("");
  lines.push(report.ok ? "All prerequisites satisfied." : "Preflight failed; see remediation above.");
  return lines.join("\n");
}

export function summarizePreflightFailure(report: PreflightReport): string {
  const failed = report.checks.filter((entry) => entry.status === "fail");
  if (failed.length === 0) {
    return "All prerequisites satisfied.";
  }
  const first = failed[0];
  const suffix = first.remediation ? ` Remediation: ${first.remediation}` : "";
  return `${failed.length} prerequisite${failed.length === 1 ? "" : "s"} failing. First: ${first.name} – ${first.details}.${suffix}`;
}

export class DependencyPreflightCache {
  private readonly ttlMs: number;
  private readonly options: PreflightOptions;
  private readonly runner: (opts: PreflightOptions) => Promise<PreflightReport>;
  private lastReport: PreflightReport | null = null;
  private lastRanAt = 0;

  constructor(opts: {
    ttlMs?: number;
    options?: PreflightOptions;
    runner?: (opts: PreflightOptions) => Promise<PreflightReport>;
  } = {}) {
    this.ttlMs = Math.max(5_000, opts.ttlMs ?? 60_000);
    this.options = opts.options ?? {};
    this.runner = opts.runner ?? runPreflightChecks;
  }

  async ensureFresh(): Promise<PreflightReport> {
    const now = Date.now();
    if (this.lastReport && now - this.lastRanAt < this.ttlMs) {
      return this.lastReport;
    }
    this.lastReport = await this.runner(this.options);
    this.lastRanAt = now;
    return this.lastReport;
  }

  async healthy(): Promise<
    | { ok: true; report: PreflightReport }
    | { ok: false; report: PreflightReport; failed: PreflightCheckResult[] }
  > {
    const report = await this.ensureFresh();
    const failed = report.checks.filter((entry) => entry.status === "fail");
    if (failed.length === 0) {
      return { ok: true, report };
    }
    return { ok: false, report, failed };
  }
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const wantsJson = args.includes("--json");
  try {
    const report = await runPreflightChecks();
    if (wantsJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatPreflightText(report));
    }
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`[RemoteBuddyPreflight] Fatal: ${String(err)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  void runCli();
}
