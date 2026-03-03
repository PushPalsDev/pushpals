import type { StartupChecklistResult } from "./checklist";
import {
  STARTUP_CHECK_STRUCTURE,
  runStartupPreflight,
  type RepoStatus,
  type StartupChecklistContext,
} from "./checklist";

type StartupChecklistConfig = {
  enabled: boolean;
  allowDirtyWorktree: boolean;
  alertsEndpoint: string;
  alertsLabelPrefix: string;
  syntheticUrl: string;
  syntheticTimeoutMs: number;
  syntheticProbeName: string;
};

export interface StartupChecklistRunOptions {
  repoPath: string;
  serverUrl: string;
  checklist: StartupChecklistConfig;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface StartupChecklistDeps {
  runGit: (args: string[], repoPath: string) => Promise<GitResult>;
  fetchImpl: typeof fetch;
  now: () => number;
  log: (line: string) => void;
}

const DEFAULT_DEPS: StartupChecklistDeps = {
  runGit: async (args, repoPath) => {
    const proc = Bun.spawn(["git", "-C", repoPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdout, stderr };
  },
  fetchImpl: fetch,
  now: () => Date.now(),
  log: (line) => console.log(line),
};

async function describeRepoState(
  repoPath: string,
  deps: StartupChecklistDeps,
): Promise<RepoStatus> {
  const statusResult = await deps.runGit(["status", "--short", "--branch"], repoPath);
  if (!statusResult.ok) {
    throw new Error(statusResult.stderr.trim() || "git status failed");
  }
  const lines = statusResult.stdout.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("##")) ?? "";
  const isDirty = lines.some((line) => !line.startsWith("##"));

  const branchResult = await deps.runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  if (!branchResult.ok) {
    throw new Error(branchResult.stderr.trim() || "git rev-parse failed");
  }
  const branch = branchResult.stdout.trim() || "unknown";

  const mergeResult = await deps.runGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], repoPath);

  return {
    isDirty,
    isMergeInProgress: mergeResult.ok,
    branch,
    detail: branchLine || `branch ${branch}`,
  };
}

function selectAlertsFromPayload(raw: unknown, labelPrefix: string): string[] {
  const alerts: Array<Record<string, unknown>> = [];
  if (Array.isArray(raw)) {
    alerts.push(...raw);
  } else if (raw && typeof raw === "object" && Array.isArray((raw as { alerts?: unknown }).alerts)) {
    alerts.push(...(((raw as { alerts?: unknown }).alerts as unknown[]) ?? []).filter((entry) => entry && typeof entry === "object"));
  }
  if (alerts.length === 0) return [];
  const prefix = labelPrefix.trim().toLowerCase();
  const out: string[] = [];
  for (const alert of alerts) {
    if (!alert || typeof alert !== "object") continue;
    const labels = (alert as { labels?: Record<string, unknown> }).labels;
    const alertName = labels && typeof labels.alertname === "string" ? labels.alertname : "";
    if (prefix && !alertName.toLowerCase().startsWith(prefix)) continue;
    const severity = labels && typeof labels.severity === "string" ? labels.severity : null;
    const annotations = (alert as { annotations?: Record<string, unknown> }).annotations;
    const summary = annotations && typeof annotations.summary === "string" ? annotations.summary : "";
    const descriptor = [alertName || "unknown", severity ? `(severity=${severity})` : null]
      .filter(Boolean)
      .join(" ");
    out.push(summary ? `${descriptor} ${summary}`.trim() : descriptor);
  }
  return out;
}

function resolveSyntheticUrl(serverUrl: string, configuredUrl: string): string {
  const trimmed = configuredUrl.trim();
  if (trimmed) return trimmed;
  const base = (serverUrl || "http://localhost:3001").trim();
  if (!base) return "http://localhost:3001/healthz";
  return `${base.replace(/\/+$/, "")}/healthz`;
}

export async function runStartupChecklist(
  options: StartupChecklistRunOptions,
  depsOverrides: Partial<StartupChecklistDeps> = {},
): Promise<StartupChecklistResult | null> {
  const deps: StartupChecklistDeps = { ...DEFAULT_DEPS, ...depsOverrides };
  if (!options.checklist.enabled) {
    deps.log("[RemoteBuddy] Startup checklist disabled via config; skipping.");
    return null;
  }

  const totalSteps = STARTUP_CHECK_STRUCTURE.length;
  const alertsLogged = { skipped: false };
  const syntheticUrl = resolveSyntheticUrl(options.serverUrl, options.checklist.syntheticUrl);

  const context: StartupChecklistContext = {
    describeRepo: () => describeRepoState(options.repoPath, deps),
    listFiringAlerts: async () => {
      if (!options.checklist.alertsEndpoint) {
        if (!alertsLogged.skipped) {
          deps.log(
            "[RemoteBuddy] Startup checklist: alerts check skipped (remotebuddy.startup.alerts_endpoint not configured).",
          );
          alertsLogged.skipped = true;
        }
        return [];
      }
      const response = await deps.fetchImpl(options.checklist.alertsEndpoint, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `failed to fetch alerts: HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
        );
      }
      const payload = await response.json().catch(() => null);
      return selectAlertsFromPayload(payload, options.checklist.alertsLabelPrefix);
    },
    syntheticTester: {
      runSyntheticJob: async () => {
        const started = deps.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), options.checklist.syntheticTimeoutMs);
        try {
          const response = await deps.fetchImpl(syntheticUrl, {
            method: "GET",
            signal: controller.signal,
          });
          const latencyMs = Math.max(0, deps.now() - started);
          if (!response.ok) {
            const detail = `HTTP ${response.status}`;
            return { ok: false, latencyMs, failureDetail: detail };
          }
          return { ok: true, latencyMs };
        } catch (err) {
          const latencyMs = Math.max(0, deps.now() - started);
          return {
            ok: false,
            latencyMs,
            failureDetail: err instanceof Error ? err.message : String(err),
          };
        } finally {
          clearTimeout(timeoutId);
        }
      },
    },
    log: (record) => {
      const icon = record.status === "pass" ? "✔" : "✖";
      deps.log(
        `[RemoteBuddy] [startup-check ${icon}] step ${record.step}/${totalSteps}: ${record.label} :: ${record.detail}`,
      );
    },
  };

  const result = await runStartupPreflight(context, {
    allowDirtyWorktree: options.checklist.allowDirtyWorktree,
  });

  if (!result.ok) {
    const failure = result.failure;
    const summary = failure
      ? `[RemoteBuddy] Startup checklist blocked launch: ${failure.detail} (code=${failure.code})`
      : "[RemoteBuddy] Startup checklist blocked launch.";
    deps.log(summary);
    throw new Error(summary);
  }

  deps.log(`[RemoteBuddy] Startup checklist passed (${result.history.length} steps).`);
  return result;
}
