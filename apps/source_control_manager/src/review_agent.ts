import { existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { basename, delimiter, isAbsolute, join, resolve } from "path";
import { loadPromptTemplate } from "../../../packages/shared/src/prompts.js";
import {
  addPullRequestComment,
  closePullRequest,
  deleteBranchRef,
  type DeleteBranchRefResult,
  getCommitMessage,
  listPullRequestComments,
  getPullRequestCommitMessage,
  getPullRequestDiff,
  listOpenPullRequests,
  mergePullRequest,
  type GitHubPR,
  type PullRequestComment,
} from "./github_pr";
import type { ReviewAgentConfig as SourceControlManagerReviewAgentConfig } from "./config";

export type ReviewAgentConfig = SourceControlManagerReviewAgentConfig;

interface ReviewVerdict {
  score: number;
  summary: string;
  issues: string[];
  fix_instruction: string;
}

interface ReviewAgentDeps {
  listOpenPullRequests: typeof listOpenPullRequests;
  getPullRequestDiff: typeof getPullRequestDiff;
  getCommitMessage: typeof getCommitMessage;
  getPullRequestCommitMessage: typeof getPullRequestCommitMessage;
  listPullRequestComments: typeof listPullRequestComments;
  mergePullRequest: typeof mergePullRequest;
  closePullRequest: typeof closePullRequest;
  deleteBranchRef: typeof deleteBranchRef;
  addPullRequestComment: typeof addPullRequestComment;
  invokeCodexReview: (prompt: string, config: ReviewAgentConfig) => Promise<string>;
  fetchImpl: typeof fetch;
  now: () => number;
  logInfo: (line: string) => void;
  logWarn: (line: string) => void;
  logError: (line: string) => void;
}

const MAX_DIFF_BYTES = 150_000;
const MAX_PR_RE_REVIEW_ENQUEUES = 3;
const MAX_REVIEW_CONTEXT_COMMENTS = 8;
const MAX_REVIEW_CONTEXT_COMMENT_CHARS = 320;
const MAX_REVIEW_CONTEXT_TOTAL_CHARS = 3_000;
const MAX_AUTONOMY_FEEDBACK_COMMENTS = 12;
const MAX_AUTONOMY_FEEDBACK_COMMENT_CHARS = 500;
const MAX_AUTONOMY_FEEDBACK_SUMMARY_CHARS = 500;
const MAX_ACTIVE_FIX_JOB_SCAN = 500;
const REVIEW_FIX_JOB_DEDUPE_COOLDOWN_MS = 60_000;
const REVIEW_MERGE_CONFLICT_JOB_DEDUPE_COOLDOWN_MS = 30 * 60_000;
const MAX_MERGE_CONFLICT_ATTEMPTS_PER_FINGERPRINT = 2;
const MERGE_CONFLICT_COMPLETION_SETTLE_MS = 30 * 60_000;
const REPEATED_REVIEW_FINDING_MIN_PRIOR_COMMENTS = 3;
const PROTECTED_BRANCHES_FOR_AUTO_DELETE = new Set(["main", "main_agent", "main_agents"]);
const JOB_ID_MARKER = "pushpals-jobId";
const SESSION_ID_MARKER = "pushpals-sessionId";
const DEFAULT_WORKSPACE_ROOT = resolve(import.meta.dir, "..", "..", "..");

const ts = () => new Date().toISOString();

const DEFAULT_DEPS: ReviewAgentDeps = {
  listOpenPullRequests,
  getPullRequestDiff,
  getCommitMessage,
  getPullRequestCommitMessage,
  listPullRequestComments,
  mergePullRequest,
  closePullRequest,
  deleteBranchRef,
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
  const explicit = String(process.env.PUSHPALS_BUN_BIN ?? "").trim();
  if (explicit) {
    const leaf = basename(explicit).toLowerCase();
    if (leaf === "bun" || leaf === "bun.exe") return explicit;
  }
  const execPath = (process.execPath ?? "").trim();
  if (!execPath) return "";
  const leaf = basename(execPath).toLowerCase();
  if (leaf === "bun" || leaf === "bun.exe") return execPath;

  const pathValue =
    process.platform === "win32"
      ? String(process.env.PATH ?? process.env.Path ?? "").trim()
      : String(process.env.PATH ?? "").trim();
  if (!pathValue) return "";
  const candidates =
    process.platform === "win32" ? ["bun.exe", "bun", "bun.cmd", "bun.bat"] : ["bun"];
  for (const rawDir of pathValue.split(delimiter)) {
    const dir = rawDir.trim();
    if (!dir) continue;
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }
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

export function buildCodexExecArgs(codexCmd: string[], outputPath: string): string[] {
  return [
    ...codexCmd,
    "-c",
    "model_reasoning_effort=low",
    "-a",
    "never",
    "exec",
    "-s",
    "read-only",
    "--color",
    "never",
    "--output-last-message",
    outputPath,
    "-",
  ];
}

export function resolveReviewerMdPath(
  reviewerMdPath: string,
  options?: { workspaceRoot?: string; cwd?: string },
): string {
  const raw = reviewerMdPath.trim();
  if (!raw) return "";

  const promptRootOverride = String(process.env.PUSHPALS_PROMPTS_ROOT_OVERRIDE ?? "").trim();
  const workspaceRoot = resolve(
    promptRootOverride || options?.workspaceRoot || DEFAULT_WORKSPACE_ROOT,
  );
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
  const args = buildCodexExecArgs(codexCmd, tmpFile);

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
    if (score < 1 || score > 10) return null;

    const summary = typeof obj.summary === "string" ? obj.summary : "";
    const issues = Array.isArray(obj.issues)
      ? (obj.issues as unknown[]).filter((entry) => typeof entry === "string").map(String)
      : [];
    const fixInstruction = typeof obj.fix_instruction === "string" ? obj.fix_instruction : "";

    return {
      score,
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

export function extractPrMeta(body: string | null): {
  jobId: string | null;
  sessionId: string | null;
} {
  if (!body) return { jobId: null, sessionId: null };

  return {
    jobId: extractMetaMarker(body, JOB_ID_MARKER),
    sessionId: extractMetaMarker(body, SESSION_ID_MARKER),
  };
}

export function buildReviewPrompt(
  reviewerMd: string,
  pr: GitHubPR,
  diff: string,
  passThreshold: number,
): string {
  const truncatedDiff =
    diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n...(diff truncated)` : diff;
  const normalizedThreshold = Math.max(1, Math.min(10, passThreshold));
  return loadPromptTemplate("review_agent/review_prompt_template.md", {
    pass_threshold: normalizedThreshold.toFixed(1),
    reviewer_md: reviewerMd,
    pr_number: String(pr.number),
    pr_title: String(pr.title ?? ""),
    head_ref: String(pr.head?.ref ?? ""),
    base_ref: String(pr.base?.ref ?? ""),
    diff: truncatedDiff,
  });
}

function formatRejectionComment(verdict: ReviewVerdict): string {
  const reasoning = deriveReviewGuidance(verdict).items;
  const lines = [
    `## ReviewAgent: Changes Rejected (score ${verdict.score.toFixed(1)}/10)`,
    "",
    `**Verdict:** ${verdict.summary}`,
    "",
  ];

  if (reasoning.length > 0) {
    lines.push("**Why this was rejected:**");
    for (const issue of reasoning) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }

  lines.push(
    "_This PR has been re-queued for automated fixes. A worker will address the issues above._",
  );

  return lines.join("\n");
}

function formatGiveUpComment(verdict: ReviewVerdict, reason: string): string {
  const lines = [
    `## ReviewAgent: PR Closed Without Merge (score ${verdict.score.toFixed(1)}/10)`,
    "",
    `**Verdict:** ${verdict.summary}`,
    `**Reason:** ${reason}`,
    "",
    "_No additional auto-fix attempts will be made for this PR. The PR is being closed and its branch deleted._",
  ];
  return lines.join("\n");
}

function formatApprovalComment(verdict: ReviewVerdict, passThreshold: number): string {
  const normalizedThreshold = Math.max(1, Math.min(10, passThreshold));
  const guidance = deriveReviewGuidance(verdict);
  const lines = [
    `## ReviewAgent: Changes Approved (score ${verdict.score.toFixed(1)}/10)`,
    "",
    `**Verdict:** ${verdict.summary}`,
    `**Threshold:** ${normalizedThreshold.toFixed(1)}/10`,
    `**Why this passed:** Score ${verdict.score.toFixed(1)}/10 is >= ${normalizedThreshold.toFixed(1)}/10.`,
    "",
  ];

  if (guidance.items.length > 0) {
    lines.push(
      guidance.source === "summary" ? "**Reviewer Notes:**" : "**Potential Improvements:**",
    );
    for (const issue of guidance.items) {
      lines.push(`- ${issue}`);
    }
  } else {
    lines.push("**Potential Improvements:**");
    lines.push("- None noted by reviewer.");
  }

  lines.push(
    "",
    "_This PR met the configured review threshold and is approved for automated merge._",
  );

  return lines.join("\n");
}

function splitCommitTitleAndBody(message: string): { title: string; body: string } {
  const normalized = message.replace(/\r\n/g, "\n").trimEnd();
  if (!normalized) return { title: "", body: "" };
  const [firstLine, ...rest] = normalized.split("\n");
  return {
    title: firstLine.trim(),
    body: rest.join("\n").replace(/^\n+/, "").trimEnd(),
  };
}

function formatReviewAgentMergeSection(
  pr: GitHubPR,
  verdict: ReviewVerdict,
  passThreshold: number,
): string {
  const normalizedThreshold = Math.max(1, Math.min(10, passThreshold));
  return [
    "ReviewAgent:",
    `- Merged, passed threshold of ${normalizedThreshold.toFixed(1)}, commit rating ${verdict.score.toFixed(1)}/10.`,
    `- PR: ${pr.html_url}`,
  ].join("\n");
}

function buildMergeCommitText(args: {
  pr: GitHubPR;
  verdict: ReviewVerdict;
  passThreshold: number;
  sourceCommitMessage: string;
}): { commitTitle: string; commitMessage: string } {
  const parsed = splitCommitTitleAndBody(args.sourceCommitMessage);
  const commitTitle = parsed.title || `${args.pr.title} (#${args.pr.number})`;
  const reviewAgentSection = formatReviewAgentMergeSection(
    args.pr,
    args.verdict,
    args.passThreshold,
  );
  const commitMessage = parsed.body
    ? `${parsed.body}\n\n${reviewAgentSection}`
    : reviewAgentSection;
  return { commitTitle, commitMessage };
}

function buildFallbackFixInstruction(pr: GitHubPR, verdict: ReviewVerdict): string {
  const reasoning = deriveReviewGuidance(verdict).items;
  const issueBlock =
    reasoning.length > 0
      ? reasoning.map((issue, index) => `${index + 1}. ${issue}`).join("\n")
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

function normalizeCommentBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

function summarizeFeedbackText(value: string): string {
  return truncateText(collapseWhitespace(value), MAX_AUTONOMY_FEEDBACK_SUMMARY_CHARS);
}

function deriveReviewGuidance(verdict: ReviewVerdict): {
  items: string[];
  source: "issues" | "fix_instruction" | "summary" | "none";
} {
  const explicitIssues = verdict.issues
    .map((issue) => collapseWhitespace(String(issue ?? "")))
    .filter(Boolean);
  if (explicitIssues.length > 0) {
    return { items: explicitIssues, source: "issues" };
  }

  const instructionLines = String(verdict.fix_instruction ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => collapseWhitespace(line))
    .filter(Boolean)
    .filter(
      (line) =>
        !/^address reviewagent feedback\b/i.test(line) &&
        !/^fix all issues listed below\b/i.test(line) &&
        !/^run relevant tests\b/i.test(line),
    );
  if (instructionLines.length > 0) {
    return { items: instructionLines, source: "fix_instruction" };
  }

  const summary = collapseWhitespace(verdict.summary);
  if (summary) {
    return { items: [summary], source: "summary" };
  }

  return { items: [], source: "none" };
}

export function buildReviewFeedbackContext(
  comments: PullRequestComment[],
  excludedBodies: string[] = [],
): string[] {
  const excluded = new Set(
    excludedBodies.map((body) => normalizeCommentBody(body)).filter((body) => body.length > 0),
  );
  const lines: string[] = [];
  let usedChars = 0;

  for (const comment of comments) {
    if (lines.length >= MAX_REVIEW_CONTEXT_COMMENTS) break;
    const normalizedBody = normalizeCommentBody(comment.body);
    if (!normalizedBody || excluded.has(normalizedBody)) continue;

    const compactBody = truncateText(
      collapseWhitespace(normalizedBody),
      MAX_REVIEW_CONTEXT_COMMENT_CHARS,
    );
    if (!compactBody) continue;

    const author = comment.userLogin.trim() ? `@${comment.userLogin.trim()}` : "unknown";
    const line = `- ${author}: ${compactBody}`;
    if (usedChars + line.length > MAX_REVIEW_CONTEXT_TOTAL_CHARS) break;
    lines.push(line);
    usedChars += line.length;
  }

  if (lines.length === 0) return [];
  return ["Recent PR feedback comments:", ...lines];
}

const REVIEW_FINDING_THEMES: Array<{
  key: string;
  label: string;
  patterns: RegExp[];
}> = [
  {
    key: "gitignore-node-modules-noise",
    label: "unrelated .gitignore/node_modules noise",
    patterns: [/\.gitignore/i, /\bnode_modules\b/i],
  },
  {
    key: "unused-react-native-mock",
    label: "unused or unrelated React Native mock changes",
    patterns: [/reactnativemock/i],
  },
  {
    key: "deleted-existing-coverage",
    label: "deleted or weakened existing test coverage",
    patterns: [/\b(delet|remov)\w*\b.{0,80}\b(test|coverage|assertion|case)s?\b/i],
  },
  {
    key: "self-referential-tests",
    label: "self-referential or tautological tests",
    patterns: [
      /\b(self[- ]?referential|tautolog|only tests? the helper|duplicates? implementation)\b/i,
    ],
  },
  {
    key: "unintegrated-helper",
    label: "new helper is not integrated into runtime behavior",
    patterns: [
      /\b(unintegrated|not integrated|unused helper|dead helper|only referenced by tests?)\b/i,
    ],
  },
  {
    key: "hardcoded-diagnostics",
    label: "hard-coded or hidden diagnostics instead of product behavior",
    patterns: [/\b(hard[- ]?coded|hidden diagnostics?|static diagnostics?|debug-only)\b/i],
  },
  {
    key: "compile-or-validation-failure",
    label: "compile, typecheck, lint, or validation failure",
    patterns: [/\b(typecheck|tsc|lint|compile|validation|test)\b.{0,80}\b(fail|error|broken)\b/i],
  },
  {
    key: "duplicate-or-misplaced-tests",
    label: "duplicate or misplaced tests",
    patterns: [
      /\b(duplicate|misplaced|wrong file|wrong path)\b.{0,80}\b(test|coverage|assertion)s?\b/i,
    ],
  },
  {
    key: "pushpals-internal-leak",
    label: "PushPals-internal/autonomy concepts leaked into the user repo",
    patterns: [
      /\b(queue_health|workerpal|remotebuddy|sourcecontrolmanager|reviewagent|pushpals)\b/i,
    ],
  },
];

function reviewFindingThemeKeys(text: string): string[] {
  const normalized = String(text ?? "").replace(/[_-]+/g, " ");
  const keys = new Set<string>();
  for (const theme of REVIEW_FINDING_THEMES) {
    if (theme.patterns.some((pattern) => pattern.test(normalized))) {
      keys.add(theme.key);
    }
  }
  return [...keys];
}

function reviewFindingThemeLabel(key: string): string {
  return REVIEW_FINDING_THEMES.find((theme) => theme.key === key)?.label ?? key;
}

export function summarizeRepeatedReviewFindings(args: {
  currentFindings: string[];
  previousFeedback: string[];
  minPriorComments?: number;
}): { issues: string[]; repeatedThemeKeys: string[]; shouldGiveUp: boolean } {
  const currentKeys = new Set(
    args.currentFindings.flatMap((entry) => reviewFindingThemeKeys(String(entry ?? ""))),
  );
  if (currentKeys.size === 0) {
    return { issues: [], repeatedThemeKeys: [], shouldGiveUp: false };
  }

  const previousCounts = new Map<string, number>();
  for (const feedback of args.previousFeedback) {
    const keysInComment = new Set(reviewFindingThemeKeys(feedback));
    for (const key of keysInComment) {
      previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
    }
  }

  const repeatedThemeKeys = [...currentKeys].filter((key) => (previousCounts.get(key) ?? 0) >= 2);
  const issues = repeatedThemeKeys.map(
    (key) =>
      `Repeated unresolved ReviewAgent finding: ${reviewFindingThemeLabel(key)}. The next fix must directly remove this pattern instead of reworking adjacent code.`,
  );
  const minPriorComments = Math.max(
    1,
    Math.floor(args.minPriorComments ?? REPEATED_REVIEW_FINDING_MIN_PRIOR_COMMENTS),
  );
  return {
    issues,
    repeatedThemeKeys,
    shouldGiveUp: issues.length > 0 && args.previousFeedback.length >= minPriorComments,
  };
}

function uniqueNonEmptyLines(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const line = collapseWhitespace(String(value ?? ""));
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function testDeclarationCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (/^\+\s*(?:test|it|describe)\s*\(/.test(line)) added += 1;
    if (/^-\s*(?:test|it|describe)\s*\(/.test(line)) removed += 1;
  }
  return { added, removed };
}

function countDiffTokenOutsideFile(diff: string, token: RegExp, excludedPath: string): number {
  let currentPath = "";
  let count = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const parsed = parseDiffGitLinePaths(line);
      currentPath = normalizeDiffPath(parsed?.bPath ?? parsed?.aPath ?? "") ?? "";
      continue;
    }
    if (currentPath === excludedPath) continue;
    if (token.test(line)) count += 1;
  }
  return count;
}

export function collectReviewHygieneIssuesFromDiff(diff: string): string[] {
  const changedPaths = parseChangedPathsFromDiff(diff);
  const changedPathSet = new Set(changedPaths);
  const issues: string[] = [];

  if (changedPathSet.has(".gitignore") && /^\+node_modules\s*$/m.test(diff)) {
    issues.push(
      "PR adds bare node_modules noise to .gitignore. Keep dependency/cache hygiene out of feature PRs unless the task explicitly changes repo ignore policy.",
    );
  }

  if (
    changedPathSet.has("tests/reactNativeMock.ts") &&
    countDiffTokenOutsideFile(diff, /reactNativeMock/i, "tests/reactNativeMock.ts") === 0
  ) {
    issues.push(
      "PR adds or changes tests/reactNativeMock.ts without wiring it into a changed test. Remove the unrelated mock or add a focused consumer in the same PR.",
    );
  }

  const declarationCounts = testDeclarationCounts(diff);
  if (declarationCounts.removed >= 3 && declarationCounts.removed > declarationCounts.added) {
    issues.push(
      "PR removes multiple existing test declarations without replacing equivalent coverage. Preserve existing coverage unless the task is explicitly a test deletion/refactor.",
    );
  }

  const changedTestPaths = changedPaths.filter((path) =>
    /(^tests\/|__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$)/i.test(path),
  );
  const changedRuntimePaths = changedPaths.filter(
    (path) =>
      /\.(?:[cm]?[jt]sx?)$/i.test(path) &&
      !/(^tests\/|__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$)/i.test(path),
  );
  if (
    changedTestPaths.length > 0 &&
    changedRuntimePaths.length > 0 &&
    changedRuntimePaths.every((path) => /^utils\//i.test(path)) &&
    !changedRuntimePaths.some((path) =>
      /(?:index|route|screen|component|store|service)/i.test(path),
    )
  ) {
    issues.push(
      "PR adds utility/helper code with tests but no clear runtime integration point. Integrate the helper into behavior-owning code or keep it as a test fixture.",
    );
  }

  if (
    changedPaths.some((path) => /(^|\/)_layout\.autonomy\.test\.[cm]?[jt]sx?$/i.test(path)) &&
    /\b(queue_health|workerpal|remotebuddy|sourcecontrolmanager|reviewagent|pushpals)\b/i.test(diff)
  ) {
    issues.push(
      "Layout autonomy tests contain PushPals-internal orchestration concepts. Keep user-repo review coverage focused on app behavior and route/startup contracts.",
    );
  }

  return uniqueNonEmptyLines(issues);
}

function buildDeterministicReviewHygieneVerdict(
  issues: string[],
  passThreshold: number,
): ReviewVerdict {
  return {
    score: Math.max(1, Math.min(6, passThreshold - 1)),
    summary: "Deterministic PR hygiene gate rejected unrelated or risky changes before LLM review.",
    issues,
    fix_instruction:
      "Remove the hygiene violations first, keep the branch focused on the requested product behavior, preserve existing tests, and rerun the repo-native validation commands.",
  };
}

function normalizeDiffPath(value: string): string | null {
  const trimmed = value.trim().replace(/^"+|"+$/g, "");
  if (!trimmed || trimmed === "/dev/null") return null;
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function normalizeReviewPrHeadRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.replace(/^refs\/heads\//, "");
  const normalized = withoutPrefix
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized) return null;
  if (!normalized.startsWith("agent/")) return null;
  if (
    normalized.includes("..") ||
    normalized.includes("@{") ||
    normalized.endsWith(".") ||
    normalized.endsWith(".lock")
  ) {
    return null;
  }
  if (/[~^:?*\[\]\s]/.test(normalized)) return null;
  return normalized;
}

function normalizeBranchRef(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^heads\//, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function isSafeBranchRefForDelete(ref: string): boolean {
  const normalized = normalizeBranchRef(ref);
  if (!normalized) return false;
  if (normalized.includes("..")) return false;
  if (normalized.includes("@{")) return false;
  if (normalized.endsWith(".")) return false;
  if (normalized.endsWith(".lock")) return false;
  if (/[\s~^:?*\[\]\\]/.test(normalized)) return false;
  return true;
}

function resolveMergedBranchDeletionPlan(pr: GitHubPR): {
  shouldDelete: boolean;
  normalizedHeadRef: string;
  reason: string;
} {
  const normalizedHeadRef = normalizeBranchRef(pr.head.ref);
  if (!normalizedHeadRef) {
    return {
      shouldDelete: false,
      normalizedHeadRef: "",
      reason: "head ref missing or invalid",
    };
  }
  const headLower = normalizedHeadRef.toLowerCase();
  if (PROTECTED_BRANCHES_FOR_AUTO_DELETE.has(headLower)) {
    return {
      shouldDelete: false,
      normalizedHeadRef,
      reason: `protected branch (${normalizedHeadRef})`,
    };
  }
  const baseLower = normalizeBranchRef(pr.base.ref).toLowerCase();
  if (baseLower && baseLower === headLower) {
    return {
      shouldDelete: false,
      normalizedHeadRef,
      reason: "head branch matches base branch",
    };
  }
  if (!isSafeBranchRefForDelete(normalizedHeadRef)) {
    return {
      shouldDelete: false,
      normalizedHeadRef,
      reason: "head branch ref failed safety validation",
    };
  }
  return {
    shouldDelete: true,
    normalizedHeadRef,
    reason: "",
  };
}

function decodeQuotedGitPath(value: string): string {
  return value.replace(/\\([0-7]{1,3}|.)/g, (_match, token: string) => {
    if (/^[0-7]{1,3}$/.test(token)) {
      return String.fromCharCode(Number.parseInt(token, 8));
    }
    switch (token) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return token;
    }
  });
}

function parseDiffGitLinePaths(line: string): { aPath: string; bPath: string } | null {
  const body = line.slice("diff --git ".length).trim();
  // Supports both:
  // - diff --git a/path b/path
  // - diff --git "a/path with spaces" "b/path with spaces"
  const match = body.match(
    /^(?:"a\/((?:[^"\\]|\\.)+)"|a\/(\S+))\s+(?:"b\/((?:[^"\\]|\\.)+)"|b\/(\S+))$/,
  );
  if (!match) return null;
  const aRaw = match[1] ?? match[2] ?? "";
  const bRaw = match[3] ?? match[4] ?? "";
  return {
    aPath: decodeQuotedGitPath(aRaw),
    bPath: decodeQuotedGitPath(bRaw),
  };
}

function parseChangedPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith("diff --git ")) continue;
    const parsed = parseDiffGitLinePaths(line);
    if (!parsed) continue;
    const aPath = normalizeDiffPath(parsed.aPath);
    const bPath = normalizeDiffPath(parsed.bPath);
    const path = bPath ?? aPath;
    if (path) paths.add(path);
  }
  return [...paths];
}

function scopeGlobForPath(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return path;
  const [first, second] = parts;
  if (parts.length === 2 && second.includes(".")) {
    return `${first}/**`;
  }
  if ((first === "apps" || first === "packages" || first === "tests") && second) {
    return `${first}/${second}/**`;
  }
  return `${first}/**`;
}

export function deriveFixWriteGlobsFromDiff(diff: string): string[] {
  const changedPaths = parseChangedPathsFromDiff(diff);
  if (changedPaths.length === 0) {
    return ["apps/**", "packages/**", "tests/**", "configs/**", "scripts/**"];
  }
  const globs = new Set<string>();
  for (const path of changedPaths) globs.add(scopeGlobForPath(path));
  return [...globs].slice(0, 16);
}

function deriveReviewTaskTargetPathsFromDiff(diff: string): string[] {
  return parseChangedPathsFromDiff(diff).slice(0, 24);
}

function deriveReviewTaskLikelyDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/");
    const slash = normalized.lastIndexOf("/");
    if (slash <= 0) continue;
    dirs.add(normalized.slice(0, slash));
    if (dirs.size >= 12) break;
  }
  return [...dirs];
}

function deriveReviewTaskValidationSteps(paths: string[]): string[] {
  const targeted = paths
    .filter((path) =>
      /(^tests\/|__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$)/i.test(path),
    )
    .slice(0, 4)
    .map((path) => `bun test ${formatBunTestPathArg(path)}`);
  return targeted.length > 0 ? targeted : ["bun test"];
}

function formatBunTestPathArg(path: string): string {
  const normalized = String(path ?? "")
    .replace(/\\/g, "/")
    .trim();
  if (!normalized) return normalized;
  const pathArg =
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
      ? normalized
      : `./${normalized}`;
  return quoteValidationCommandArg(pathArg);
}

function quoteValidationCommandArg(arg: string): string {
  if (!/[\s"\\]/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildReviewFixPlannerWorkerInstruction(options: {
  prNumber: number;
  prUrl: string;
  prHeadRef: string;
  prBaseRef: string;
  reviewScore: number;
  reviewThreshold: number;
  reviewerFindings: string[];
  changedPaths: string[];
  feedbackHighlights: string[];
}): string {
  const lines = [
    "Rejected PR revision brief:",
    `- PR: #${options.prNumber} (${options.prUrl})`,
    `- Existing PR branch: ${options.prHeadRef}`,
    `- Base branch: ${options.prBaseRef}`,
    `- Previous ReviewAgent score: ${options.reviewScore.toFixed(1)} / 10`,
    `- Required approval threshold: ${options.reviewThreshold.toFixed(1)} / 10`,
    `- Minimum score improvement needed: +${Math.max(0, options.reviewThreshold - options.reviewScore).toFixed(1)}`,
    "- Make at least one concrete repo change that addresses reviewer feedback, or explicitly document why a finding is invalid in a committed code/test/docs update.",
    "- Do not return an unchanged branch: PushPals refuses unchanged review-fix re-reviews.",
    `- The prepared checkout is the exact leased head of ${options.prHeadRef}. Edit and validate only; do not checkout, switch, reset, merge, rebase, stage, commit, or push.`,
    `- SourceControlManager publication target after host finalization: ${options.prHeadRef} (update the existing PR branch only).`,
  ];
  if (options.reviewerFindings.length > 0) {
    lines.push("- Current reviewer must-fix items:");
    for (const finding of options.reviewerFindings.slice(0, 6)) {
      lines.push(`  - ${finding}`);
    }
  }
  if (options.changedPaths.length > 0) {
    lines.push(`- Candidate changed paths from the current PR: ${options.changedPaths.join(", ")}`);
  }
  if (options.feedbackHighlights.length > 0) {
    lines.push("- Recent reviewer comment excerpts:");
    for (const item of options.feedbackHighlights.slice(0, 4)) {
      lines.push(`  - ${item}`);
    }
  }
  lines.push(
    "- Keep the patch focused on the rejected areas, preserve already accepted behavior, and prefer targeted validation before broader test runs.",
  );
  return lines.join("\n").slice(0, 6000);
}

function buildMergeConflictPlannerWorkerInstruction(options: {
  prNumber: number;
  prUrl: string;
  prHeadRef: string;
  prBaseRef: string;
  prHeadSha: string;
  mergeErrorSummary: string;
  changedPaths: string[];
}): string {
  const lines = [
    "Merge-conflict resolution brief:",
    `- PR: #${options.prNumber} (${options.prUrl})`,
    `- Existing PR branch: ${options.prHeadRef}`,
    `- Deterministic orchestration rebase target: ${options.prBaseRef}`,
    `- SourceControlManager publication target: ${options.prHeadRef} (update the existing PR branch only).`,
    `- Expected remote lease SHA: ${options.prHeadSha}`,
  ];
  if (options.mergeErrorSummary) {
    lines.push(`- GitHub mergeability error: ${options.mergeErrorSummary}`);
  }
  if (options.changedPaths.length > 0) {
    lines.push(
      `- Candidate changed paths from the approved PR: ${options.changedPaths.join(", ")}`,
    );
  }
  lines.push(
    "- Treat the prepared checkout and any in-progress rebase state as authoritative. The worker edits and validates file content only; it must not checkout, switch, reset, merge, rebase, stage, commit, or push.",
  );
  lines.push(
    `- Resolve conflict markers and run focused validation. Deterministic orchestration continues the rebase onto ${options.prBaseRef}, and SourceControlManager alone publishes ${options.prHeadRef}.`,
  );
  return lines.join("\n");
}

function normalizeReviewFixHeadSha(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function reviewFixDedupeKey(prNumber: number, headSha: string): string {
  return `${prNumber}:${normalizeReviewFixHeadSha(headSha)}`;
}

export function mergeConflictDedupeKey(prNumber: number, headSha: string, baseSha: string): string {
  return [
    "merge-conflict",
    Math.floor(prNumber),
    normalizeReviewFixHeadSha(headSha),
    normalizeReviewFixHeadSha(baseSha),
  ].join(":");
}

function extractGitHubApiStatus(error: unknown): number | null {
  const message = String((error as { message?: unknown })?.message ?? error ?? "");
  const match = message.match(/\bGitHub API\s+(\d{3})\b/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUnmergeablePullRequestError(error: unknown): boolean {
  const status = extractGitHubApiStatus(error);
  if (status !== 405 && status !== 409 && status !== 422) return false;
  const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("not mergeable") ||
    message.includes("cannot be merged") ||
    message.includes("merge conflict") ||
    message.includes("has conflicts")
  );
}

type ActiveJobLike = {
  id?: string;
  kind?: string;
  status?: string;
  createdAt?: string;
  created_at?: string;
  completedAt?: string;
  completed_at?: string;
  updatedAt?: string;
  updated_at?: string;
  params?: string | Record<string, unknown> | null;
};

type ActiveReviewJobContext = {
  dedupeKey: string;
  resolutionType: "review_fix" | "merge_conflict" | string;
  prNumber: number;
  headSha: string;
  baseSha: string;
};

function extractActiveReviewJobContextFromJob(job: ActiveJobLike): ActiveReviewJobContext | null {
  if (String(job.kind ?? "").trim() !== "task.execute") return null;
  const rawParams = job.params;
  let params: Record<string, unknown> = {};
  if (typeof rawParams === "string") {
    try {
      const parsed = JSON.parse(rawParams) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  } else if (rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)) {
    params = rawParams as Record<string, unknown>;
  } else {
    return null;
  }
  const reviewAgent = params.reviewAgent;
  if (!reviewAgent || typeof reviewAgent !== "object" || Array.isArray(reviewAgent)) return null;
  const reviewAgentRecord = reviewAgent as Record<string, unknown>;
  const prNumber = Number(reviewAgentRecord.prNumber);
  const prHeadSha = normalizeReviewFixHeadSha(String(reviewAgentRecord.prHeadSha ?? ""));
  if (!Number.isFinite(prNumber) || prNumber <= 0 || !prHeadSha) return null;
  const rawResolutionType = String(reviewAgentRecord.resolutionType ?? "")
    .trim()
    .toLowerCase();
  const resolutionType = rawResolutionType || "review_fix";
  const prBaseSha = normalizeReviewFixHeadSha(String(reviewAgentRecord.prBaseSha ?? ""));
  return {
    dedupeKey:
      resolutionType === "merge_conflict"
        ? mergeConflictDedupeKey(Math.floor(prNumber), prHeadSha, prBaseSha)
        : reviewFixDedupeKey(Math.floor(prNumber), prHeadSha),
    resolutionType,
    prNumber: Math.floor(prNumber),
    headSha: prHeadSha,
    baseSha: prBaseSha,
  };
}

export class ReviewAgent {
  private reviewed = new Map<number, string>();
  private forceReReview = new Map<number, string>();
  private reReviewEnqueueCounts = new Map<number, number>();
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

  requestReReview(prNumber: number, sha: string): void {
    const normalizedSha = String(sha ?? "").trim();
    if (!normalizedSha) return;
    this.forceReReview.set(prNumber, normalizedSha);
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
    const reviewedSha = this.reviewed.get(pr.number);
    const forcedSha = this.forceReReview.get(pr.number);
    if (reviewedSha !== sha && forcedSha) {
      // Clear stale forced re-review markers when the PR head has advanced.
      this.forceReReview.delete(pr.number);
    }
    if (reviewedSha === sha) {
      if (forcedSha !== sha) return;
      this.forceReReview.delete(pr.number);
      this.deps.logInfo(
        `[${ts()}] [ReviewAgent] Re-reviewing PR #${pr.number} at unchanged head ${sha.slice(0, 8)} (forced re-review).`,
      );
    }

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

    const deterministicHygieneIssues = collectReviewHygieneIssuesFromDiff(diff);
    if (deterministicHygieneIssues.length > 0) {
      const verdict = buildDeterministicReviewHygieneVerdict(
        deterministicHygieneIssues,
        this.config.passThreshold,
      );
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] PR #${pr.number} failed deterministic hygiene gate (${deterministicHygieneIssues.length} issue(s)); skipping Codex review.`,
      );
      const finalized = await this.rejectPr(pr, verdict, diff);
      if (finalized) {
        this.reviewed.set(pr.number, sha);
      }
      return;
    }

    const reviewerMd = this.loadReviewerMd();
    const prompt = buildReviewPrompt(reviewerMd, pr, diff, this.config.passThreshold);

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

    const approved = verdict.score >= this.config.passThreshold;
    this.deps.logInfo(
      `[${ts()}] [ReviewAgent] PR #${pr.number} score: ${verdict.score.toFixed(1)}/10 - ${approved ? "APPROVED" : "REJECTED"} (threshold ${this.config.passThreshold.toFixed(1)}/10) - ${verdict.summary}`,
    );

    const finalized = approved
      ? await this.approvePr(pr, verdict, diff)
      : await this.rejectPr(pr, verdict, diff);

    if (finalized) {
      this.reviewed.set(pr.number, sha);
    }
  }

  private async approvePr(pr: GitHubPR, verdict: ReviewVerdict, diff: string): Promise<boolean> {
    const { jobId, sessionId } = extractPrMeta(pr.body);
    try {
      await this.deps.addPullRequestComment({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
        body: formatApprovalComment(verdict, this.config.passThreshold),
      });
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Failed to post approval comment on PR #${pr.number}: ${err?.message ?? err}`,
      );
      return false;
    }

    let commitTitle = `${pr.title} (#${pr.number})`;
    let commitMessage = formatReviewAgentMergeSection(pr, verdict, this.config.passThreshold);
    try {
      let sourceCommitMessage = "";
      try {
        sourceCommitMessage = await this.deps.getCommitMessage({
          token: this.githubToken,
          remoteUrl: this.remoteUrl,
          sha: pr.head.sha,
        });
      } catch (primaryErr: any) {
        this.deps.logWarn(
          `[${ts()}] [ReviewAgent] Failed to fetch head commit message for PR #${pr.number} (${pr.head.sha.slice(0, 8)}): ${primaryErr?.message ?? primaryErr}. Trying PR commit fallback...`,
        );
        sourceCommitMessage = await this.deps.getPullRequestCommitMessage({
          token: this.githubToken,
          remoteUrl: this.remoteUrl,
          prNumber: pr.number,
          sha: pr.head.sha,
        });
      }

      const composed = buildMergeCommitText({
        pr,
        verdict,
        passThreshold: this.config.passThreshold,
        sourceCommitMessage,
      });
      commitTitle = composed.commitTitle;
      commitMessage = composed.commitMessage;
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Failed to resolve source commit message for PR #${pr.number}; using PR metadata fallback: ${err?.message ?? err}`,
      );
    }

    try {
      const result = await this.deps.mergePullRequest({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
        mergeMethod: this.config.mergeMethod,
        commitTitle,
        commitMessage,
      });
      this.deps.logInfo(
        `[${ts()}] [ReviewAgent] PR #${pr.number} merged (score ${verdict.score.toFixed(1)}/10, sha ${result.sha.slice(0, 8)})`,
      );
      await this.deleteMergedPrHeadBranch(pr);
      this.reReviewEnqueueCounts.delete(pr.number);
      this.forceReReview.delete(pr.number);
      this.reviewed.delete(pr.number);
      const comments = await this.listRecentPrComments(pr.number);
      await this.postAutonomyPrFeedback({
        pr,
        verdict: "approved_merged",
        verdictSummary: verdict.summary,
        reviewScore: verdict.score,
        jobId,
        sessionId,
        comments,
      });
      return true;
    } catch (err: any) {
      if (isUnmergeablePullRequestError(err)) {
        this.deps.logWarn(
          `[${ts()}] [ReviewAgent] PR #${pr.number} is approved but not mergeable at ${pr.head.sha.slice(0, 8)}. Enqueueing merge-conflict resolution job.`,
        );
        const handled = await this.handleApprovedMergeConflict(pr, verdict, diff, err);
        if (handled) return true;
      }
      this.deps.logError(
        `[${ts()}] [ReviewAgent] Failed to merge PR #${pr.number}: ${err?.message ?? err}`,
      );
      return false;
    }
  }

  private async handleApprovedMergeConflict(
    pr: GitHubPR,
    verdict: ReviewVerdict,
    diff: string,
    mergeError: unknown,
  ): Promise<boolean> {
    const { jobId, sessionId } = extractPrMeta(pr.body);
    if (!sessionId) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] PR #${pr.number} merge conflict handler requires pushpals-sessionId metadata; cannot enqueue resolution job.`,
      );
      return false;
    }

    const existingReviewJobId = await this.findActiveReviewJobIdForPrHead(
      pr.number,
      pr.head.sha,
      "merge_conflict",
      pr.base.sha,
    );
    if (existingReviewJobId) {
      this.deps.logInfo(
        `[${ts()}] [ReviewAgent] PR #${pr.number} already has active merge-conflict job ${existingReviewJobId} for fingerprint ${pr.head.sha.slice(0, 8)}:${pr.base.sha.slice(0, 8)}; skipping duplicate merge-conflict enqueue.`,
      );
      return true;
    }

    const circuit = await this.inspectMergeConflictCircuit(pr);
    if (circuit.state !== "closed") {
      const reason =
        circuit.state === "settling"
          ? `a completed resolution job is still inside the ${Math.round(MERGE_CONFLICT_COMPLETION_SETTLE_MS / 60_000)} minute SourceControlManager settle window`
          : `${circuit.failedAttempts} failed attempts reached the per-fingerprint limit of ${MAX_MERGE_CONFLICT_ATTEMPTS_PER_FINGERPRINT}`;
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Merge-conflict circuit ${circuit.state} for PR #${pr.number} fingerprint ${circuit.fingerprint}: ${reason}. Waiting for the PR head or base SHA to change before another attempt.`,
      );
      return true;
    }

    const handled = await this.enqueueMergeConflictJob(
      pr,
      verdict,
      sessionId,
      jobId,
      diff,
      mergeError,
    );
    if (handled) {
      const comments = await this.listRecentPrComments(pr.number);
      await this.postAutonomyPrFeedback({
        pr,
        verdict: "approved_unmergeable",
        verdictSummary:
          `${verdict.summary} merge blocked: ${String((mergeError as { message?: unknown })?.message ?? mergeError ?? "")}`.trim(),
        reviewScore: verdict.score,
        jobId,
        sessionId,
        comments,
      });
    }
    return handled;
  }

  private async rejectPr(pr: GitHubPR, verdict: ReviewVerdict, diff: string): Promise<boolean> {
    const maxPrCommentsBeforeGiveUp = Math.max(
      1,
      Math.floor(this.config.maxPrCommentsBeforeGiveUp),
    );
    const { jobId, sessionId } = extractPrMeta(pr.body);
    const recentComments = await this.listRecentPrComments(
      pr.number,
      Math.max(MAX_REVIEW_CONTEXT_COMMENTS * 3, maxPrCommentsBeforeGiveUp),
    );
    if (recentComments.length >= maxPrCommentsBeforeGiveUp) {
      return await this.giveUpOnRejectedPr(pr, verdict, {
        jobId,
        sessionId,
        recentComments,
        maxPrCommentsBeforeGiveUp,
      });
    }

    const repeatedReviewFindings = summarizeRepeatedReviewFindings({
      currentFindings: [verdict.summary, verdict.fix_instruction, ...verdict.issues],
      previousFeedback: recentComments.map((comment) => comment.body),
    });
    const effectiveVerdict =
      repeatedReviewFindings.issues.length > 0
        ? {
            ...verdict,
            summary: `${verdict.summary} Persistent unresolved review findings remain.`,
            issues: uniqueNonEmptyLines([...verdict.issues, ...repeatedReviewFindings.issues]),
            fix_instruction: uniqueNonEmptyLines([
              verdict.fix_instruction,
              ...repeatedReviewFindings.issues,
            ]).join("\n"),
          }
        : verdict;
    if (repeatedReviewFindings.shouldGiveUp) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] PR #${pr.number} repeated unresolved findings (${repeatedReviewFindings.repeatedThemeKeys.join(", ")}); closing instead of enqueueing another low-signal review-fix job.`,
      );
      return await this.giveUpOnRejectedPr(pr, effectiveVerdict, {
        jobId,
        sessionId,
        recentComments,
        maxPrCommentsBeforeGiveUp,
      });
    }

    const rejectionComment = formatRejectionComment(effectiveVerdict);
    try {
      await this.deps.addPullRequestComment({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
        body: rejectionComment,
      });
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Failed to comment on PR #${pr.number}: ${err?.message ?? err}`,
      );
    }
    await this.postAutonomyPrFeedback({
      pr,
      verdict: "rejected",
      verdictSummary: effectiveVerdict.summary,
      reviewScore: effectiveVerdict.score,
      jobId,
      sessionId,
      comments: recentComments,
    });

    // Always return true here so the SHA is cached and we don't post duplicate
    // rejection comments if the enqueue below fails. Enqueue errors are logged.
    if (!sessionId) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] PR #${pr.number} has no pushpals-sessionId in body - cannot re-queue`,
      );
      return true;
    }

    const priorReReviewEnqueues = this.reReviewEnqueueCounts.get(pr.number) ?? 0;
    if (priorReReviewEnqueues >= MAX_PR_RE_REVIEW_ENQUEUES) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] PR #${pr.number} reached max re-review cap (${MAX_PR_RE_REVIEW_ENQUEUES}); closing instead of enqueueing another fix job.`,
      );
      return await this.giveUpOnRejectedPr(pr, effectiveVerdict, {
        jobId,
        sessionId,
        recentComments,
        maxPrCommentsBeforeGiveUp,
        reason: `Reached automated review-fix retry cap (${MAX_PR_RE_REVIEW_ENQUEUES}).`,
        feedbackVerdict: "rejected_re_review_cap_closed",
        feedbackSummarySuffix: `closed after reaching automated review-fix retry cap (${MAX_PR_RE_REVIEW_ENQUEUES}).`,
      });
    }

    const existingFixJobId = await this.findActiveReviewJobIdForPrHead(
      pr.number,
      pr.head.sha,
      "review_fix",
    );
    if (existingFixJobId) {
      this.deps.logInfo(
        `[${ts()}] [ReviewAgent] PR #${pr.number} already has active fix job ${existingFixJobId} for head ${pr.head.sha.slice(0, 8)}; skipping duplicate enqueue.`,
      );
      return true;
    }

    const nextReReviewEnqueues = priorReReviewEnqueues + 1;
    this.reReviewEnqueueCounts.set(pr.number, nextReReviewEnqueues);
    const enqueued = await this.enqueueFixJob(
      pr,
      effectiveVerdict,
      sessionId,
      jobId,
      diff,
      [rejectionComment],
      recentComments,
    );
    if (enqueued) {
      if (nextReReviewEnqueues === MAX_PR_RE_REVIEW_ENQUEUES) {
        this.deps.logWarn(
          `[${ts()}] [ReviewAgent] PR #${pr.number} hit max re-review cap (${MAX_PR_RE_REVIEW_ENQUEUES}); future rejections will not auto-enqueue fix jobs.`,
        );
      }
    } else if (priorReReviewEnqueues > 0) {
      this.reReviewEnqueueCounts.set(pr.number, priorReReviewEnqueues);
    } else {
      this.reReviewEnqueueCounts.delete(pr.number);
    }
    return true;
  }

  private async giveUpOnRejectedPr(
    pr: GitHubPR,
    verdict: ReviewVerdict,
    context: {
      jobId: string | null;
      sessionId: string | null;
      recentComments: PullRequestComment[];
      maxPrCommentsBeforeGiveUp: number;
      reason?: string;
      feedbackVerdict?: "rejected_comment_cap_closed" | "rejected_re_review_cap_closed";
      feedbackSummarySuffix?: string;
    },
  ): Promise<boolean> {
    const reason =
      context.reason ??
      `Reached PR feedback comment cap (${context.recentComments.length}/${context.maxPrCommentsBeforeGiveUp}).`;
    this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} ${reason} Closing without merge.`);

    try {
      const result = await this.deps.closePullRequest({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
      });
      if (!result.closed) {
        this.deps.logWarn(
          `[${ts()}] [ReviewAgent] Close PR #${pr.number} request returned state=${result.state || "(unknown)"}; will retry on next poll.`,
        );
        return false;
      }
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Failed to close PR #${pr.number} after give-up condition: ${err?.message ?? err}`,
      );
      return false;
    }

    const giveUpComment = formatGiveUpComment(verdict, reason);
    try {
      await this.deps.addPullRequestComment({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
        body: giveUpComment,
      });
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Closed PR #${pr.number} but failed to post give-up comment: ${err?.message ?? err}`,
      );
    }

    await this.postAutonomyPrFeedback({
      pr,
      verdict: context.feedbackVerdict ?? "rejected_comment_cap_closed",
      verdictSummary: `${verdict.summary} | ${
        context.feedbackSummarySuffix ??
        `closed after reaching PR comment cap (${context.maxPrCommentsBeforeGiveUp}).`
      }`,
      reviewScore: verdict.score,
      jobId: context.jobId,
      sessionId: context.sessionId,
      comments: context.recentComments,
    });

    await this.deletePrHeadBranch(pr, "closed");
    this.reReviewEnqueueCounts.delete(pr.number);
    this.forceReReview.delete(pr.number);
    this.reviewed.delete(pr.number);
    return true;
  }

  private async deleteMergedPrHeadBranch(pr: GitHubPR): Promise<void> {
    await this.deletePrHeadBranch(pr, "merged");
  }

  private async deletePrHeadBranch(pr: GitHubPR, mode: "merged" | "closed"): Promise<void> {
    const plan = resolveMergedBranchDeletionPlan(pr);
    if (!plan.shouldDelete) {
      this.deps.logInfo(
        `[${ts()}] [ReviewAgent] Skipping branch delete for ${mode} PR #${pr.number}: ${plan.reason}`,
      );
      return;
    }
    try {
      const result: DeleteBranchRefResult = await this.deps.deleteBranchRef({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        branchRef: plan.normalizedHeadRef,
      });
      if (result.deleted) {
        this.deps.logInfo(
          `[${ts()}] [ReviewAgent] Deleted ${mode} PR head branch ${plan.normalizedHeadRef} for PR #${pr.number}`,
        );
      } else {
        this.deps.logInfo(
          `[${ts()}] [ReviewAgent] Branch ${plan.normalizedHeadRef} already absent after ${mode} for PR #${pr.number}`,
        );
      }
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Failed to delete ${mode} branch ${plan.normalizedHeadRef} for PR #${pr.number}: ${err?.message ?? err}`,
      );
    }
  }

  private async sendSessionCommand(
    sessionId: string,
    headers: Record<string, string>,
    command: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.deps.fetchImpl(
      `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/command`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(command),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`session command failed: HTTP ${response.status}${text ? `: ${text}` : ""}`);
    }
  }

  private async findActiveReviewJobIdForPrHead(
    prNumber: number,
    headSha: string,
    resolutionType?: "review_fix" | "merge_conflict",
    baseSha = "",
  ): Promise<string | null> {
    const normalizedHeadSha = normalizeReviewFixHeadSha(headSha);
    const normalizedBaseSha = normalizeReviewFixHeadSha(baseSha);
    const headers: Record<string, string> = {};
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    for (const status of ["pending", "claimed"] as const) {
      try {
        const url = `${this.serverUrl}/jobs?status=${status}&limit=${MAX_ACTIVE_FIX_JOB_SCAN}`;
        const response = await this.deps.fetchImpl(url, { headers });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          this.deps.logWarn(
            `[${ts()}] [ReviewAgent] Failed active-fix dedupe scan (${status}) for PR #${prNumber}: HTTP ${response.status}${text ? `: ${text}` : ""}`,
          );
          continue;
        }
        const payload = (await response.json().catch(() => null)) as { jobs?: unknown } | null;
        const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
        for (const rawJob of jobs) {
          if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) continue;
          const job = rawJob as ActiveJobLike;
          const context = extractActiveReviewJobContextFromJob(job);
          if (
            !context ||
            context.prNumber !== Math.floor(prNumber) ||
            context.headSha !== normalizedHeadSha
          ) {
            continue;
          }
          if (resolutionType && context.resolutionType !== resolutionType) continue;
          if (
            resolutionType === "merge_conflict" &&
            normalizedBaseSha &&
            context.baseSha &&
            context.baseSha !== normalizedBaseSha
          ) {
            continue;
          }
          const jobId =
            typeof job.id === "string" && job.id.trim().length > 0 ? job.id.trim() : "(unknown)";
          return jobId;
        }
      } catch (err: any) {
        this.deps.logWarn(
          `[${ts()}] [ReviewAgent] Active-fix dedupe scan failed for PR #${prNumber} (${status}): ${err?.message ?? err}`,
        );
      }
    }
    return null;
  }

  private async inspectMergeConflictCircuit(pr: GitHubPR): Promise<{
    state: "closed" | "settling" | "open";
    fingerprint: string;
    failedAttempts: number;
  }> {
    const fingerprint = mergeConflictDedupeKey(pr.number, pr.head.sha, pr.base.sha);
    const headers: Record<string, string> = {};
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    let failedAttempts = 0;
    let newestCompletedAt = 0;

    for (const status of ["failed", "publish_blocked", "completed"] as const) {
      try {
        const url = `${this.serverUrl}/jobs?status=${status}&limit=${MAX_ACTIVE_FIX_JOB_SCAN}`;
        const response = await this.deps.fetchImpl(url, { headers });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          this.deps.logWarn(
            `[${ts()}] [ReviewAgent] Failed merge-conflict circuit scan (${status}) for PR #${pr.number}: HTTP ${response.status}${text ? `: ${text}` : ""}`,
          );
          continue;
        }
        const payload = (await response.json().catch(() => null)) as { jobs?: unknown } | null;
        const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
        for (const rawJob of jobs) {
          if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) continue;
          const job = rawJob as ActiveJobLike;
          const context = extractActiveReviewJobContextFromJob(job);
          if (
            !context ||
            context.resolutionType !== "merge_conflict" ||
            context.dedupeKey !== fingerprint
          ) {
            continue;
          }
          if (status === "completed") {
            const completedAt = Date.parse(
              String(
                job.completedAt ??
                  job.completed_at ??
                  job.updatedAt ??
                  job.updated_at ??
                  job.createdAt ??
                  job.created_at ??
                  "",
              ),
            );
            if (Number.isFinite(completedAt)) {
              newestCompletedAt = Math.max(newestCompletedAt, completedAt);
            }
          } else {
            failedAttempts += 1;
          }
        }
      } catch (err: any) {
        this.deps.logWarn(
          `[${ts()}] [ReviewAgent] Merge-conflict circuit scan failed for PR #${pr.number} (${status}): ${err?.message ?? err}`,
        );
      }
    }

    if (failedAttempts >= MAX_MERGE_CONFLICT_ATTEMPTS_PER_FINGERPRINT) {
      return { state: "open", fingerprint, failedAttempts };
    }
    if (
      newestCompletedAt > 0 &&
      this.deps.now() - newestCompletedAt < MERGE_CONFLICT_COMPLETION_SETTLE_MS
    ) {
      return { state: "settling", fingerprint, failedAttempts };
    }
    return { state: "closed", fingerprint, failedAttempts };
  }

  private async emitFixJobQueuedEvents(args: {
    sessionId: string;
    taskId: string;
    jobId: string;
    kind: string;
    params: Record<string, unknown>;
    pr: GitHubPR;
    verdict: ReviewVerdict;
    headers: Record<string, string>;
    taskTitle?: string;
    taskDescription?: string;
    taskTags?: string[];
  }): Promise<void> {
    // Ensure the target session exists before posting task/job events.
    const ensureSessionResponse = await this.deps.fetchImpl(`${this.serverUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: args.sessionId }),
    });
    if (!ensureSessionResponse.ok) {
      const text = await ensureSessionResponse.text().catch(() => "");
      throw new Error(
        `failed to ensure session ${args.sessionId}: HTTP ${ensureSessionResponse.status}${text ? `: ${text}` : ""}`,
      );
    }

    const from = "agent:source_control_manager/review_agent";
    const defaultTaskDescription =
      args.verdict.summary.trim() ||
      `Address ReviewAgent feedback and update PR #${args.pr.number} (${args.pr.html_url}).`;
    const taskDescription = args.taskDescription?.trim() || defaultTaskDescription;
    const shortHeadSha = normalizeReviewFixHeadSha(args.pr.head.sha).slice(0, 8) || "unknown";
    const taskTitle =
      args.taskTitle?.trim() ||
      `Address ReviewAgent feedback for PR #${args.pr.number} @ ${shortHeadSha}`;
    const taskTags =
      Array.isArray(args.taskTags) && args.taskTags.length > 0
        ? args.taskTags
        : ["review-agent", "pr-fix"];
    await this.sendSessionCommand(args.sessionId, args.headers, {
      type: "task_created",
      from,
      correlationId: args.taskId,
      payload: {
        taskId: args.taskId,
        title: taskTitle,
        description: taskDescription,
        createdBy: "review_agent",
        priority: "normal",
        tags: taskTags,
      },
    });
    await this.sendSessionCommand(args.sessionId, args.headers, {
      type: "task_started",
      from,
      correlationId: args.taskId,
      payload: {
        taskId: args.taskId,
      },
    });
    await this.sendSessionCommand(args.sessionId, args.headers, {
      type: "job_enqueued",
      from,
      correlationId: args.taskId,
      payload: {
        jobId: args.jobId,
        taskId: args.taskId,
        kind: args.kind,
        params: args.params,
        origin: "autonomy",
      },
    });
  }

  private async listRecentPrComments(
    prNumber: number,
    maxComments: number = MAX_REVIEW_CONTEXT_COMMENTS * 3,
  ): Promise<PullRequestComment[]> {
    try {
      return await this.deps.listPullRequestComments({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber,
        maxComments: Math.max(1, Math.floor(maxComments)),
      });
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Failed to load comments for PR #${prNumber}: ${err?.message ?? err}`,
      );
      return [];
    }
  }

  private async getRecentFeedbackContext(
    pr: GitHubPR,
    excludedBodies: string[] = [],
    prefetchedComments?: PullRequestComment[],
  ): Promise<string[]> {
    const comments =
      Array.isArray(prefetchedComments) && prefetchedComments.length > 0
        ? prefetchedComments
        : await this.listRecentPrComments(pr.number);
    if (comments.length === 0) return [];
    return buildReviewFeedbackContext(comments, excludedBodies);
  }

  private async postAutonomyPrFeedback(args: {
    pr: GitHubPR;
    verdict: string;
    verdictSummary: string;
    reviewScore: number;
    jobId: string | null;
    sessionId: string | null;
    comments?: PullRequestComment[];
  }): Promise<void> {
    const normalizedVerdict = String(args.verdict ?? "")
      .trim()
      .toLowerCase();
    if (!normalizedVerdict) return;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;

    const normalizedHeadSha = normalizeReviewFixHeadSha(args.pr.head.sha) || "unknown";
    const feedbackKey = `review_agent:pr:${args.pr.number}:head:${normalizedHeadSha}:verdict:${normalizedVerdict}`;
    const comments = (Array.isArray(args.comments) ? args.comments : [])
      .slice(0, MAX_AUTONOMY_FEEDBACK_COMMENTS)
      .map((comment) => ({
        body: truncateText(normalizeCommentBody(comment.body), MAX_AUTONOMY_FEEDBACK_COMMENT_CHARS),
        userLogin: String(comment.userLogin ?? "").trim(),
        createdAt: String(comment.createdAt ?? "").trim(),
        htmlUrl: String(comment.htmlUrl ?? "").trim(),
      }))
      .filter((row) => row.body.length > 0);

    const payload = {
      source: "review_agent",
      feedbackKey,
      jobId: args.jobId ?? undefined,
      sessionId: args.sessionId ?? undefined,
      prNumber: args.pr.number,
      prUrl: args.pr.html_url,
      verdict: normalizedVerdict,
      reviewScore: Number.isFinite(args.reviewScore) ? args.reviewScore : undefined,
      reviewThreshold: this.config.passThreshold,
      summary: summarizeFeedbackText(args.verdictSummary || args.pr.title || normalizedVerdict),
      commentCount: comments.length,
      comments,
    };

    try {
      const response = await this.deps.fetchImpl(`${this.serverUrl}/autonomy/pr-feedback`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        this.deps.logWarn(
          `[${ts()}] [ReviewAgent] Failed to post autonomy PR feedback for PR #${args.pr.number}: HTTP ${response.status}${text ? `: ${text}` : ""}`,
        );
      }
    } catch (err: any) {
      this.deps.logWarn(
        `[${ts()}] [ReviewAgent] Failed to post autonomy PR feedback for PR #${args.pr.number}: ${err?.message ?? err}`,
      );
    }
  }

  private async enqueueFixJob(
    pr: GitHubPR,
    verdict: ReviewVerdict,
    sessionId: string,
    jobId: string | null,
    diff: string,
    excludedBodies: string[] = [],
    prefetchedComments?: PullRequestComment[],
  ): Promise<boolean> {
    const taskId = `review-fix-pr${pr.number}-${this.deps.now()}`;
    const reviewGuidance = deriveReviewGuidance(verdict);
    const rejectionReasoning = reviewGuidance.items;
    const issuesSummary =
      rejectionReasoning.length > 0 ? rejectionReasoning.join("; ") : "see summary";
    const fixInstruction =
      verdict.fix_instruction.trim() || buildFallbackFixInstruction(pr, verdict);
    const writeGlobs = deriveFixWriteGlobsFromDiff(diff);
    const changedPaths = deriveReviewTaskTargetPathsFromDiff(diff);
    const likelyDirs = deriveReviewTaskLikelyDirs(changedPaths);
    const validationSteps = deriveReviewTaskValidationSteps(changedPaths);
    const prHeadRef = normalizeReviewPrHeadRef(pr.head.ref);
    const feedbackContext = await this.getRecentFeedbackContext(
      pr,
      excludedBodies,
      prefetchedComments,
    );
    const feedbackHighlights = feedbackContext
      .filter((line) => line.trim().startsWith("- "))
      .map((line) => line.trim().replace(/^- /, ""))
      .slice(0, 4);
    const plannerWorkerInstruction = buildReviewFixPlannerWorkerInstruction({
      prNumber: pr.number,
      prUrl: pr.html_url,
      prHeadRef: prHeadRef ?? pr.head.ref,
      prBaseRef: pr.base.ref,
      reviewScore: verdict.score,
      reviewThreshold: this.config.passThreshold,
      reviewerFindings: rejectionReasoning,
      changedPaths,
      feedbackHighlights,
    });
    const discoveryKeywords = [...new Set([...rejectionReasoning, ...feedbackHighlights])]
      .map((entry) => truncateText(collapseWhitespace(entry), 180))
      .filter(Boolean)
      .slice(0, 8);

    const payload = {
      taskId,
      sessionId,
      kind: "task.execute",
      prUrl: pr.html_url,
      dedupeKey: reviewFixDedupeKey(pr.number, pr.head.sha),
      dedupeCooldownMs: REVIEW_FIX_JOB_DEDUPE_COOLDOWN_MS,
      params: {
        schemaVersion: 2,
        origin: "autonomy",
        instruction: fixInstruction,
        plannerWorkerInstruction,
        recentContext: [
          loadPromptTemplate("review_agent/fix_job_intro_line.md", {
            pr_number: String(pr.number),
            pr_url: pr.html_url,
            pr_head_ref: String(pr.head?.ref ?? ""),
          }),
          "The host prepared the exact leased PR-head checkout. Edit and validate only; deterministic finalization creates the completion commit and SourceControlManager owns publication.",
          "Review-fix jobs must produce at least one concrete committed change. If a reviewer finding is invalid, make a small code/test/docs update that documents the reason; unchanged branch re-review is refused.",
          `Raise this PR from ${verdict.score.toFixed(1)}/10 to at least ${this.config.passThreshold.toFixed(1)}/10 without reopening already accepted behavior.`,
          `Reviewer score was ${verdict.score.toFixed(1)}/10. Issues: ${issuesSummary}`,
          ...feedbackContext,
        ],
        planning: {
          intent: "code_change",
          riskLevel: "medium",
          ...(changedPaths.length > 0 ? { targetPaths: changedPaths } : {}),
          acceptanceCriteria: [
            `Reviewer scores >= ${this.config.passThreshold}/10`,
            "Address the latest reviewer must-fix items without regressing accepted behavior",
            "All relevant tests pass",
          ],
          validationSteps,
          queuePriority: "normal",
          queueWaitBudgetMs: 90_000,
          executionBudgetMs: 1_200_000,
          finalizationBudgetMs: 120_000,
          scope: { readAnywhere: true, writeAllowed: true, writeGlobs },
          discovery: {
            ripgrepQueries: [...changedPaths.slice(0, 6), ...rejectionReasoning.slice(0, 2)],
            likelyDirs,
            keywords: discoveryKeywords,
          },
        },
        completionBranch: prHeadRef ?? undefined,
        reviewAgent: {
          prNumber: pr.number,
          prUrl: pr.html_url,
          prHeadSha: normalizeReviewFixHeadSha(pr.head.sha),
          prHeadRef: prHeadRef ?? pr.head.ref,
          prBaseRef: pr.base.ref,
          resolutionType: "review_fix",
          previousReviewScore: verdict.score,
          reviewThreshold: this.config.passThreshold,
          previousReviewSummary: verdict.summary,
          reviewerFindings: rejectionReasoning.slice(0, 8),
          reviewerFindingsSource: reviewGuidance.source,
          rejectedAt: new Date().toISOString(),
          sourceJobId: jobId,
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
      const responseBody = (await response.json().catch(() => null)) as {
        jobId?: unknown;
        deduped?: unknown;
        message?: unknown;
      } | null;
      const enqueuedJobId =
        responseBody && typeof responseBody.jobId === "string" ? responseBody.jobId : "";
      const deduped = responseBody?.deduped === true;
      const dedupeMessage =
        responseBody && typeof responseBody.message === "string" ? responseBody.message : "";
      if (enqueuedJobId && !deduped) {
        try {
          await this.emitFixJobQueuedEvents({
            sessionId,
            taskId,
            jobId: enqueuedJobId,
            kind: "task.execute",
            params: payload.params,
            pr,
            verdict,
            headers,
            taskDescription: `Raise PR #${pr.number} from ${verdict.score.toFixed(1)}/10 to >= ${this.config.passThreshold.toFixed(1)}/10 on the existing branch.`,
            taskTags: ["review-agent", "review-fix"],
          });
        } catch (emitErr: any) {
          this.deps.logWarn(
            `[${ts()}] [ReviewAgent] Fix job ${enqueuedJobId} enqueued for PR #${pr.number}, but failed to emit session task/job events: ${emitErr?.message ?? emitErr}`,
          );
        }
      }
      if (deduped) {
        this.deps.logInfo(
          `[${ts()}] [ReviewAgent] PR #${pr.number} fix request deduped to existing active job ${enqueuedJobId || "(unknown)"} for head ${pr.head.sha.slice(0, 8)}${dedupeMessage ? ` (${dedupeMessage})` : ""}; skipping duplicate task events.`,
        );
        return true;
      }

      this.deps.logInfo(
        `[${ts()}] [ReviewAgent] PR #${pr.number} rejected (score ${verdict.score.toFixed(1)}/10) - fix job ${taskId}${enqueuedJobId ? ` (${enqueuedJobId})` : ""} enqueued`,
      );
      return true;
    } catch (err: any) {
      this.deps.logError(
        `[${ts()}] [ReviewAgent] Failed to enqueue fix job for PR #${pr.number}: ${err?.message ?? err}`,
      );
      return false;
    }
  }

  private async enqueueMergeConflictJob(
    pr: GitHubPR,
    verdict: ReviewVerdict,
    sessionId: string,
    jobId: string | null,
    diff: string,
    mergeError: unknown,
  ): Promise<boolean> {
    const taskId = `review-merge-conflict-pr${pr.number}-${this.deps.now()}`;
    const writeGlobs = deriveFixWriteGlobsFromDiff(diff);
    const changedPaths = deriveReviewTaskTargetPathsFromDiff(diff);
    const likelyDirs = deriveReviewTaskLikelyDirs(changedPaths);
    const validationSteps = deriveReviewTaskValidationSteps(changedPaths);
    const prHeadRef = normalizeReviewPrHeadRef(pr.head.ref);
    const mergeErrorSummary = truncateText(
      collapseWhitespace(
        String((mergeError as { message?: unknown })?.message ?? mergeError ?? ""),
      ),
      360,
    );
    const plannerWorkerInstruction = buildMergeConflictPlannerWorkerInstruction({
      prNumber: pr.number,
      prUrl: pr.html_url,
      prHeadRef: prHeadRef ?? pr.head.ref,
      prBaseRef: pr.base.ref,
      prHeadSha: normalizeReviewFixHeadSha(pr.head.sha),
      mergeErrorSummary,
      changedPaths,
    });
    const instruction = loadPromptTemplate("review_agent/merge_conflict_instruction.md", {
      pr_number: String(pr.number),
      pr_url: pr.html_url,
      pr_head_ref: String(pr.head?.ref ?? ""),
      pr_base_ref: String(pr.base?.ref ?? ""),
      review_score: verdict.score.toFixed(1),
    });

    const payload = {
      taskId,
      sessionId,
      kind: "task.execute",
      prUrl: pr.html_url,
      dedupeKey: mergeConflictDedupeKey(pr.number, pr.head.sha, pr.base.sha),
      dedupeCooldownMs: REVIEW_MERGE_CONFLICT_JOB_DEDUPE_COOLDOWN_MS,
      params: {
        schemaVersion: 2,
        origin: "autonomy",
        instruction,
        plannerWorkerInstruction,
        recentContext: [
          loadPromptTemplate("review_agent/merge_conflict_context_intro_line.md", {
            pr_number: String(pr.number),
            pr_url: pr.html_url,
          }),
          `Approved score: ${verdict.score.toFixed(1)}/10`,
          mergeErrorSummary
            ? `GitHub merge error: ${mergeErrorSummary}`
            : "GitHub merge error: (unavailable)",
        ],
        planning: {
          intent: "code_change",
          riskLevel: "medium",
          ...(changedPaths.length > 0 ? { targetPaths: changedPaths } : {}),
          acceptanceCriteria: [
            `Branch ${pr.head.ref} rebases cleanly onto ${pr.base.ref} with conflicts resolved.`,
            `PR #${pr.number} becomes mergeable without manual GitHub conflict edits.`,
            "Validation commands relevant to changed files pass.",
          ],
          validationSteps,
          queuePriority: "normal",
          queueWaitBudgetMs: 90_000,
          executionBudgetMs: 1_200_000,
          finalizationBudgetMs: 120_000,
          scope: { readAnywhere: true, writeAllowed: true, writeGlobs },
          discovery: {
            ripgrepQueries: changedPaths.slice(0, 8),
            likelyDirs,
            keywords: ["merge conflict", pr.head.ref, pr.base.ref],
          },
        },
        completionBranch: prHeadRef ?? undefined,
        reviewAgent: {
          prNumber: pr.number,
          prUrl: pr.html_url,
          prHeadSha: normalizeReviewFixHeadSha(pr.head.sha),
          prBaseSha: normalizeReviewFixHeadSha(pr.base.sha),
          prHeadRef: prHeadRef ?? pr.head.ref,
          prBaseRef: pr.base.ref,
          resolutionType: "merge_conflict",
          previousReviewScore: verdict.score,
          previousReviewSummary: verdict.summary,
          mergeError: mergeErrorSummary,
          requestedAt: new Date().toISOString(),
          sourceJobId: jobId,
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
      const responseBody = (await response.json().catch(() => null)) as {
        jobId?: unknown;
        deduped?: unknown;
        message?: unknown;
      } | null;
      const enqueuedJobId =
        responseBody && typeof responseBody.jobId === "string" ? responseBody.jobId : "";
      const deduped = responseBody?.deduped === true;
      const dedupeMessage =
        responseBody && typeof responseBody.message === "string" ? responseBody.message : "";
      if (enqueuedJobId && !deduped) {
        try {
          const shortHeadSha = normalizeReviewFixHeadSha(pr.head.sha).slice(0, 8) || "unknown";
          await this.emitFixJobQueuedEvents({
            sessionId,
            taskId,
            jobId: enqueuedJobId,
            kind: "task.execute",
            params: payload.params,
            pr,
            verdict,
            headers,
            taskTitle: `Resolve merge conflicts for PR #${pr.number} @ ${shortHeadSha}`,
            taskDescription:
              mergeErrorSummary ||
              `Resolve merge conflicts on ${pr.head.ref} so PR #${pr.number} can be merged.`,
            taskTags: ["review-agent", "merge-conflict"],
          });
        } catch (emitErr: any) {
          this.deps.logWarn(
            `[${ts()}] [ReviewAgent] Merge-conflict job ${enqueuedJobId} enqueued for PR #${pr.number}, but failed to emit session task/job events: ${emitErr?.message ?? emitErr}`,
          );
        }
      }
      if (deduped) {
        this.deps.logInfo(
          `[${ts()}] [ReviewAgent] PR #${pr.number} merge-conflict request deduped to existing active job ${enqueuedJobId || "(unknown)"} for head ${pr.head.sha.slice(0, 8)}${dedupeMessage ? ` (${dedupeMessage})` : ""}; skipping duplicate task events.`,
        );
        return true;
      }

      this.deps.logInfo(
        `[${ts()}] [ReviewAgent] PR #${pr.number} approved but unmergeable; merge-conflict job ${taskId}${enqueuedJobId ? ` (${enqueuedJobId})` : ""} enqueued`,
      );
      return true;
    } catch (err: any) {
      this.deps.logError(
        `[${ts()}] [ReviewAgent] Failed to enqueue merge-conflict job for PR #${pr.number}: ${err?.message ?? err}`,
      );
      return false;
    }
  }
}
