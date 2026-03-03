import { detectRepoRoot } from "shared";

import type {
  RepoStatus,
  SyntheticStartupTestOptions,
  SyntheticStartupTestResult,
  SyntheticStartupTester,
} from "./checklist.js";

const ALERT_ENV_KEYS = ["PUSHPALS_ACTIVE_ALERTS", "REMOTEBUDDY_ACTIVE_ALERTS"] as const;

export interface DescribeRepoStatusOptions {
  repoRoot?: string;
  tolerateGitErrors?: boolean;
}

export async function describeRepoStatus(
  options: DescribeRepoStatusOptions = {},
): Promise<RepoStatus> {
  const repoRoot = options.repoRoot ?? detectRepoRoot(process.cwd());
  const tolerant = Boolean(options.tolerateGitErrors);

  const [porcelainRaw, branchRaw] = await Promise.all([
    runGitCommand(repoRoot, ["status", "--porcelain"], { tolerateErrors: tolerant }),
    runGitCommand(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { tolerateErrors: tolerant }),
  ]);

  const porcelain = porcelainRaw.trim();
  const branch = branchRaw.trim() || undefined;
  const firstDirty = porcelain
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const mergeHead = Boolean(
    await runGitCommand(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      tolerateErrors: true,
      allowFailure: true,
    }),
  );
  const rebaseHead = Boolean(
    await runGitCommand(repoRoot, ["rev-parse", "-q", "--verify", "REBASE_HEAD"], {
      tolerateErrors: true,
      allowFailure: true,
    }),
  );
  const cherryPickHead = Boolean(
    await runGitCommand(repoRoot, ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], {
      tolerateErrors: true,
      allowFailure: true,
    }),
  );

  const isDirty = porcelain.length > 0;
  const detail = isDirty
    ? firstDirty ?? "Worktree has pending changes."
    : branch
      ? `Worktree is clean (${branch}).`
      : "Worktree is clean.";

  return {
    isDirty,
    isMergeInProgress: mergeHead || rebaseHead || cherryPickHead,
    branch,
    detail,
  };
}

export async function listFiringAlertsFromEnv(): Promise<string[]> {
  for (const key of ALERT_ENV_KEYS) {
    const raw = process.env[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return parseAlertList(raw);
    }
  }
  return [];
}

export function createServerSyntheticTester(serverUrl: string): SyntheticStartupTester {
  const normalized = normalizeServerUrl(serverUrl);
  return {
    async runSyntheticJob(
      options: SyntheticStartupTestOptions,
    ): Promise<SyntheticStartupTestResult> {
      const started = Date.now();
      const timeoutMs = Math.max(100, Math.floor(options.maxLatencyMs ?? 1000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const res = await fetch(`${normalized}/healthz`, {
          method: "GET",
          signal: controller.signal,
        });
        const latencyMs = Date.now() - started;
        if (!res.ok) {
          return { ok: false, latencyMs, failureDetail: `HTTP ${res.status}` };
        }
        return { ok: true, latencyMs };
      } catch (error) {
        const latencyMs = Date.now() - started;
        return {
          ok: false,
          latencyMs,
          failureDetail:
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "Synthetic probe failed",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function runGitCommand(
  repoRoot: string,
  args: string[],
  options: { allowFailure?: boolean; tolerateErrors?: boolean } = {},
): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    if (options.allowFailure || options.tolerateErrors) {
      return "";
    }
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return stdout.trim();
}

function parseAlertList(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => String(value).trim()).filter((value) => value.length > 0);
      }
    } catch {
      // fall through to delimiter parsing
    }
  }
  return text
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizeServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (!trimmed) return "http://localhost:3001";
  return trimmed.replace(/\/+$/, "");
}
