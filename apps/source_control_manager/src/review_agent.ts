import { existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { basename, isAbsolute, join, resolve } from "path";
import {
  addPullRequestComment,
  getPullRequestDiff,
  listOpenPullRequests,
  mergePullRequest,
  type GitHubPR,
} from "./github_pr";

export interface ReviewAgentConfig {
  enabled: boolean;
  pollIntervalMs: number;
  reviewerMdPath: string;
  passThreshold: number;
  mergeMethod: "squash" | "merge" | "rebase";
  codexBin: string;
  codexAuthMode: string;
  codexHomeDir: string;
  codexTimeoutMs: number;
}

interface ReviewVerdict {
  score: number;
  approved: boolean;
  summary: string;
  issues: string[];
  fix_instruction: string;
}

interface ReviewAgentDeps {
  listOpenPullRequests: typeof listOpenPullRequests;
  getPullRequestDiff: typeof getPullRequestDiff;
  mergePullRequest: typeof mergePullRequest;
  addPullRequestComment: typeof addPullRequestComment;
  invokeCodexReview: (prompt: string, config: ReviewAgentConfig) => Promise<string>;
  fetchImpl: typeof fetch;
  now: () => number;
  logInfo: (line: string) => void;
  logWarn: (line: string) => void;
  logError: (line: string) => void;
}

const MAX_DIFF_BYTES = 150_000;
const JOB_ID_MARKER = "pushpals-jobId";
const SESSION_ID_MARKER = "pushpals-sessionId";
const DEFAULT_WORKSPACE_ROOT = resolve(import.meta.dir, "..", "..", "..");

const ts = () => new Date().toISOString();

const DEFAULT_DEPS: ReviewAgentDeps = {
  listOpenPullRequests,
  getPullRequestDiff,
  mergePullRequest,
  addPullRequestComment,
  invokeCodexReview,
  fetchImpl: fetch,
  now: () => Date.now(),
  logInfo: (line) => console.log(line),
  logWarn: (line) => console.warn(line),
  logError: (line) => console.error(line),
};

function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of raw.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (current.length > 0) out.push(current);
  return out;
}

function currentBunExecPath(): string {
  const execPath = (process.execPath ?? "").trim();
  if (!execPath) return "";
  const leaf = basename(execPath).toLowerCase();
  if (leaf === "bun" || leaf === "bun.exe") return execPath;
  return "";
}

export function resolveCodexCmd(codexBin: string): string[] {
  const bunExec = currentBunExecPath();
  const overrideParts = splitArgs(codexBin);
  const parts =
    overrideParts.length > 0
      ? overrideParts
      : bunExec
        ? [bunExec, "x", "--yes", "@openai/codex"]
        : ["bun", "x", "--yes", "@openai/codex"];

  const first = (parts[0] ?? "").trim().toLowerCase();
  if (!first) return parts;
  if (first === "bunx" && bunExec) {
    return [bunExec, "x", ...parts.slice(1)];
  }
  if (first === "bun" && bunExec) {
    return [bunExec, ...parts.slice(1)];
  }
  return parts;
}

export function resolveReviewerMdPath(
  reviewerMdPath: string,
  options?: { workspaceRoot?: string; cwd?: string },
): string {
  const raw = reviewerMdPath.trim();
  if (!raw) return "";

  const workspaceRoot = resolve(options?.workspaceRoot || DEFAULT_WORKSPACE_ROOT);
  const cwd = resolve(options?.cwd || process.cwd());
  if (isAbsolute(raw)) return raw;

  const candidates = new Set<string>();
  candidates.add(resolve(workspaceRoot, raw));
  candidates.add(resolve(cwd, raw));

  let cursor = cwd;
  for (let i = 0; i < 6; i += 1) {
    const parent = resolve(cursor, "..");
    if (parent === cursor) break;
    candidates.add(resolve(parent, raw));
    cursor = parent;
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return resolve(workspaceRoot, raw);
}

export function buildCodexEnv(config: ReviewAgentConfig): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (config.codexAuthMode === "chatgpt" && config.codexHomeDir) {
    env.CODEX_HOME = config.codexHomeDir;
    env.HOME = config.codexHomeDir;
  }
  return env;
}

async function invokeCodexReview(prompt: string, config: ReviewAgentConfig): Promise<string> {
  const tmpFile = join(tmpdir(), `review-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const codexCmd = resolveCodexCmd(config.codexBin);
  const args = [
    ...codexCmd,
    "exec",
    "--color",
    "never",
    "--approval-policy",
    "never",
    "--sandbox",
    "read-only",
    "-c",
    "model_reasoning_effort=low",
    "--output-last-message",
    tmpFile,
    "-",
  ];

  const proc = Bun.spawn(args, {
    stdin: new Blob([prompt]),
    stdout: "ignore",
    stderr: "pipe",
    env: buildCodexEnv(config),
  });

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, config.codexTimeoutMs);

  try {
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    if (timedOut) {
      throw new Error(`Codex review timed out after ${config.codexTimeoutMs}ms`);
    }
    if (exitCode !== 0) {
      const detail = stderr.trim().slice(0, 800);
      throw new Error(`Codex review failed (exit ${exitCode}): ${detail || "no stderr"}`);
    }

    return (await Bun.file(tmpFile).text()).trim();
  } finally {
    clearTimeout(killTimer);
    await Bun.file(tmpFile)
      .delete()
      .catch(() => {});
  }
}

export function parseReviewVerdict(raw: string): ReviewVerdict | null {
  const stripped = raw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const obj = parsed as Record<string, unknown>;
    const score = typeof obj.score === "number" ? obj.score : Number.parseFloat(String(obj.score));
    if (!Number.isFinite(score)) return null;

    const approved = typeof obj.approved === "boolean" ? obj.approved : score >= 9.5;
    const summary = typeof obj.summary === "string" ? obj.summary : "";
    const issues = Array.isArray(obj.issues)
      ? (obj.issues as unknown[]).filter((entry) => typeof entry === "string").map(String)
      : [];
    const fixInstruction =
      typeof obj.fix_instruction === "string" ? obj.fix_instruction : "";

    return {
      score,
      approved,
      summary,
      issues,
      fix_instruction: fixInstruction,
    };
  } catch {
    return null;
  }
}

function extractMetaMarker(body: string, markerName: string): string | null {
  const escaped = markerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<!--\\s*${escaped}:\\s*([^\\s>]+)\\s*-->`);
  const match = body.match(re);
  return match ? match[1] : null;
}

export function extractPrMeta(body: string | null): { jobId: string | null; sessionId: string | null } {
  if (!body) return { jobId: null, sessionId: null };

  return {
    jobId: extractMetaMarker(body, JOB_ID_MARKER),
    sessionId: extractMetaMarker(body, SESSION_ID_MARKER),
  };
}

export function buildReviewPrompt(reviewerMd: string, pr: GitHubPR, diff: string): string {
  const truncatedDiff =
    diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n...(diff truncated)` : diff;

  return [
    "You are a Distinguished Engineer performing a code review for the PushPals project.",
    "",
    "Review Criteria:",
    reviewerMd,
    "",
    "---",
    "",
    `Pull Request: #${pr.number} - ${pr.title}`,
    `Branch: ${pr.head.ref} -> ${pr.base.ref}`,
    "",
    "Diff:",
    "```diff",
    truncatedDiff,
    "```",
    "",
    "Respond with a JSON verdict object only. No markdown, no explanation outside the JSON.",
  ].join("\n");
}

function formatRejectionComment(verdict: ReviewVerdict): string {
  const lines = [
    `## ReviewAgent: Changes Rejected (score ${verdict.score.toFixed(1)}/10)`,
    "",
    `**Verdict:** ${verdict.summary}`,
    "",
  ];

  if (verdict.issues.length > 0) {
    lines.push("**Issues:**");
    for (const issue of verdict.issues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }

  lines.push(
    "_This PR has been re-queued for automated fixes. A worker will address the issues above._",
  );

  return lines.join("\n");
}

function buildFallbackFixInstruction(pr: GitHubPR, verdict: ReviewVerdict): string {
  const issueBlock =
    verdict.issues.length > 0
      ? verdict.issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")
      : verdict.summary || "Address all review issues and raise quality to the required threshold.";

  return [
    `Address ReviewAgent feedback for PR #${pr.number} (${pr.html_url}) on branch ${pr.head.ref}.`,
    "Fix all issues listed below while preserving intended behavior.",
    "",
    issueBlock,
    "",
    "Run relevant tests and ensure both positive and negative/edge cases are covered.",
  ].join("\n");
}

export class ReviewAgent {
  private reviewed = new Map<number, string>();
  private reviewerMd = "";
  private pollInFlight = false;
  private readonly deps: ReviewAgentDeps;

  constructor(
    private config: ReviewAgentConfig,
    private serverUrl: string,
    private githubToken: string,
    private remoteUrl: string,
    private prBaseBranch: string,
    private authToken?: string,
    deps?: Partial<ReviewAgentDeps>,
  ) {
    this.deps = { ...DEFAULT_DEPS, ...(deps ?? {}) };
  }

  private loadReviewerMd(): string {
    if (this.reviewerMd) return this.reviewerMd;

    try {
      const mdPath = resolveReviewerMdPath(this.config.reviewerMdPath);
      this.reviewerMd = readFileSync(mdPath, "utf-8");
      return this.reviewerMd;
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Could not load reviewer.md from ${this.config.reviewerMdPath} (cwd=${process.cwd()}): ${err?.message ?? err}`,
      );
      return "";
    }
  }

  async poll(): Promise<void> {
    if (this.pollInFlight) {
      this.deps.logInfo("[ReviewAgent] Poll already in progress, skipping overlapping tick.");
      return;
    }

    this.pollInFlight = true;
    try {
      let prs: GitHubPR[];
      try {
        prs = await this.deps.listOpenPullRequests({
          token: this.githubToken,
          remoteUrl: this.remoteUrl,
          headPrefix: "agent/",
          base: this.prBaseBranch,
        });
      } catch (err: any) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to list PRs: ${err?.message ?? err}`);
        return;
      }

      for (const pr of prs) {
        await this.reviewPr(pr);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async reviewPr(pr: GitHubPR): Promise<void> {
    const sha = pr.head.sha;
    if (this.reviewed.get(pr.number) === sha) return;

    this.deps.logInfo(
      `[${ts()}] [ReviewAgent] Reviewing PR #${pr.number} (${pr.head.ref} @ ${sha.slice(0, 8)})`,
    );

    let diff: string;
    try {
      diff = await this.deps.getPullRequestDiff({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
      });
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Failed to get diff for PR #${pr.number}: ${err?.message ?? err}`,
      );
      return;
    }

    if (!diff.trim()) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} has an empty diff - skipping`);
      this.reviewed.set(pr.number, sha);
      return;
    }

    if (diff.length > MAX_DIFF_BYTES * 2) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] PR #${pr.number} diff is too large (${diff.length} bytes) - skipping`,
      );
      this.reviewed.set(pr.number, sha);
      return;
    }

    const reviewerMd = this.loadReviewerMd();
    const prompt = buildReviewPrompt(reviewerMd, pr, diff);

    let raw: string;
    try {
      this.deps.logInfo(`[${ts()}] [ReviewAgent] Invoking Codex review for PR #${pr.number}...`);
      raw = await this.deps.invokeCodexReview(prompt, this.config);
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Codex invocation failed for PR #${pr.number}: ${err?.message ?? err}`,
      );
      return;
    }

    const verdict = parseReviewVerdict(raw);
    if (!verdict) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Could not parse Codex verdict for PR #${pr.number}. Raw output:\n${raw.slice(0, 500)}`,
      );
      return;
    }

    this.deps.logInfo(
      `[${ts()}] [ReviewAgent] PR #${pr.number} score: ${verdict.score.toFixed(1)}/10 - ${verdict.approved ? "APPROVED" : "REJECTED"} - ${verdict.summary}`,
    );

    const approved = verdict.approved && verdict.score >= this.config.passThreshold;
    const finalized = approved
      ? await this.approvePr(pr, verdict)
      : await this.rejectPr(pr, verdict);

    if (finalized) {
      this.reviewed.set(pr.number, sha);
    }
  }

  private async approvePr(pr: GitHubPR, verdict: ReviewVerdict): Promise<boolean> {
    try {
      const result = await this.deps.mergePullRequest({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
        mergeMethod: this.config.mergeMethod,
        commitTitle: `${pr.title} (#${pr.number})`,
        commitMessage: `Reviewed by ReviewAgent - score ${verdict.score.toFixed(1)}/10\n\n${verdict.summary}`,
      });
      this.deps.logInfo(
        `[${ts()}] [ReviewAgent] PR #${pr.number} merged (score ${verdict.score.toFixed(1)}/10, sha ${result.sha.slice(0, 8)})`,
      );
      return true;
    } catch (err: any) {
      this.deps.logError(
        `[${ts()}] [ReviewAgent] Failed to merge PR #${pr.number}: ${err?.message ?? err}`,
      );
      return false;
    }
  }

  private async rejectPr(pr: GitHubPR, verdict: ReviewVerdict): Promise<boolean> {
    try {
      await this.deps.addPullRequestComment({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
        body: formatRejectionComment(verdict),
      });
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Failed to comment on PR #${pr.number}: ${err?.message ?? err}`,
      );
    }

    // Always return true here so the SHA is cached and we don't post duplicate
    // rejection comments if the enqueue below fails. Enqueue errors are logged.
    const { jobId, sessionId } = extractPrMeta(pr.body);
    if (!sessionId) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] PR #${pr.number} has no pushpals-sessionId in body - cannot re-queue`,
      );
      return true;
    }

    void this.enqueueFixJob(pr, verdict, sessionId, jobId);
    return true;
  }

  private async enqueueFixJob(
    pr: GitHubPR,
    verdict: ReviewVerdict,
    sessionId: string,
    _jobId: string | null,
  ): Promise<boolean> {
    const taskId = `review-fix-pr${pr.number}-${this.deps.now()}`;
    const issuesSummary = verdict.issues.length > 0 ? verdict.issues.join("; ") : "see summary";
    const fixInstruction = verdict.fix_instruction.trim() || buildFallbackFixInstruction(pr, verdict);

    const payload = {
      taskId,
      sessionId,
      kind: "task.execute",
      params: {
        schemaVersion: 2,
        origin: "autonomy",
        instruction: fixInstruction,
        recentContext: [
          `You are fixing PR #${pr.number} (${pr.html_url}) on branch ${pr.head.ref}.`,
          "The branch already exists on the remote. Checkout the branch, make required fixes, and push.",
          `Reviewer score was ${verdict.score.toFixed(1)}/10. Issues: ${issuesSummary}`,
        ],
        planning: {
          intent: "code_change",
          riskLevel: "medium",
          acceptanceCriteria: [
            `Reviewer scores >= ${this.config.passThreshold}/10`,
            "All relevant tests pass",
          ],
          validationSteps: ["bun test"],
          queuePriority: "normal",
          queueWaitBudgetMs: 90_000,
          executionBudgetMs: 1_800_000,
          finalizationBudgetMs: 120_000,
          scope: { readAnywhere: true, writeAllowed: true },
        },
        lane: "worker",
        recentJobs: [],
      },
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;

    try {
      const response = await this.deps.fetchImpl(`${this.serverUrl}/jobs/enqueue`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      this.deps.logInfo(
        `[${ts()}] [ReviewAgent] PR #${pr.number} rejected (score ${verdict.score.toFixed(1)}/10) - fix job ${taskId} enqueued`,
      );
      return true;
    } catch (err: any) {
      this.deps.logError(
        `[${ts()}] [ReviewAgent] Failed to enqueue fix job for PR #${pr.number}: ${err?.message ?? err}`,
      );
      return false;
    }
  }
}
