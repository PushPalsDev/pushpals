/**
 * Agent "brain" — takes user messages + session context and produces
 * either a plain assistant_message or a structured action plan
 * (tasks + jobs) for the orchestrator to execute.
 *
 * Milestone A: chat-only response
 * Milestone B: structured JSON action plan (tasks + jobs)
 */

import type { LLMClient, LLMMessage } from "./llm.js";

// ─── Validation limits ─────────────────────────────────────────────────────────────

const MAX_TASKS = 3;
const MAX_JOBS_PER_TASK = 5;
const MAX_TITLE_LEN = 80;
const MAX_DESC_LEN = 500;
const MAX_ASSISTANT_MSG_LEN = 4000;
const ALLOWED_JOB_KINDS = new Set([
  "bun.test",
  "bun.lint",
  "git.status",
  "git.diff",
  "git.log",
  "git.branch",
  "file.read",
  "file.search",
  "file.list",
  "ci.status",
  "project.summary",
]);

/** Best-effort normalization for LLM outputs that are close but not exact */
function normalizeJobKind(raw: string): string | null {
  // Exact match first
  if (ALLOWED_JOB_KINDS.has(raw)) return raw;

  // Case-insensitive exact match
  const lower = raw.toLowerCase().trim();
  for (const k of ALLOWED_JOB_KINDS) {
    if (k === lower) return k;
  }

  // Common LLM mistakes: "Git" → "git.status", "git_status" → "git.status",
  // "gitStatus" → "git.status", "test" → "bun.test", etc.
  const normalized = lower.replace(/[_\s]/g, ".");
  if (ALLOWED_JOB_KINDS.has(normalized)) return normalized;

  // Keyword heuristic for single-word outputs
  const KEYWORD_MAP: Record<string, string> = {
    git: "git.status",
    status: "git.status",
    diff: "git.diff",
    log: "git.log",
    branch: "git.branch",
    test: "bun.test",
    tests: "bun.test",
    lint: "bun.lint",
    read: "file.read",
    search: "file.search",
    list: "file.list",
    files: "file.list",
    ci: "ci.status",
    summary: "project.summary",
    overview: "project.summary",
  };
  if (KEYWORD_MAP[lower]) return KEYWORD_MAP[lower];

  return null;
}

// ─── Output types ───────────────────────────────────────────────────────────

export interface ActionJobSpec {
  kind: string;
  params: Record<string, unknown>;
}

export interface ActionTask {
  taskId: string;
  title: string;
  description: string;
  jobs: ActionJobSpec[];
}

export interface BrainOutput {
  assistantMessage: string;
  tasks?: ActionTask[];
}

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are PushPals agent-remote — an AI assistant embedded in a developer workflow system.
The local agent specializes in repo-level work: git operations, testing, CI/CD, code reading, and project-management style status reporting.

You receive the user's message and optional recent session context.

You MUST respond with a JSON object matching this schema:
{
  "assistant_message": "string — your response text to the user",
  "tasks": [                  // optional — omit for simple chat responses
    {
      "taskId": "string — unique id, e.g. t-<uuid-prefix>",
      "title": "string — short task title",
      "description": "string — what the task does",
      "jobs": [
        { "kind": "string — one of the available job kinds", "params": {} }
      ]
    }
  ]
}

The ONLY valid job kind values are (use these EXACT strings):
  "git.status"
  "git.diff"
  "git.log"
  "git.branch"
  "bun.test"
  "bun.lint"
  "file.read"  (params: {"path": "relative/path"})
  "file.search" (params: {"pattern": "search term"})
  "file.list"
  "ci.status"
  "project.summary"

Guidelines:
- For simple greetings or questions, respond with just assistant_message (no tasks).
- For actionable requests like "run tests", "lint the code", "check git status", create tasks with jobs using the EXACT kind strings above.
- For status/overview requests, use "project.summary" or combine "git.log" + "git.status".
- For branch management questions, use "git.branch".
- For CI/CD inquiries, use "ci.status".
- The kind field MUST be one of the exact strings listed above. Do NOT use category names like "Git" or "Quality".
- Generate short unique taskId values like "t-abc123".
- Keep assistant_message concise and helpful.
- Always respond with valid JSON. No markdown, no code fences.`;

// ─── Brain class ────────────────────────────────────────────────────────────

export class AgentBrain {
  private llm: LLMClient;
  /** When true, include tasks in output. When false, chat-only. */
  private actionsEnabled: boolean;

  constructor(llm: LLMClient, opts?: { actionsEnabled?: boolean }) {
    this.llm = llm;
    this.actionsEnabled = opts?.actionsEnabled ?? true;
  }

  async think(userText: string, context?: string[]): Promise<BrainOutput> {
    const messages: LLMMessage[] = [];

    // Add recent context if available
    if (context && context.length > 0) {
      messages.push({
        role: "user",
        content: `Recent session context:\n${context.join("\n")}\n\n---\n\nNew user message: ${userText}`,
      });
    } else {
      messages.push({ role: "user", content: userText });
    }

    try {
      const result = await this.llm.generate({
        system: SYSTEM_PROMPT,
        messages,
        json: true,
        maxTokens: 2048,
        temperature: 0.3,
      });

      const parsed = JSON.parse(result.text) as {
        assistant_message?: string;
        tasks?: Array<{
          taskId: string;
          title: string;
          description: string;
          jobs?: Array<{ kind: string; params?: Record<string, unknown> }>;
        }>;
      };

      const output: BrainOutput = {
        assistantMessage: (
          parsed.assistant_message ?? "I received your message but couldn't formulate a response."
        ).slice(0, MAX_ASSISTANT_MSG_LEN),
      };

      // Only include tasks if actions are enabled and the model produced them
      if (this.actionsEnabled && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
        const validated: ActionTask[] = [];

        for (const t of parsed.tasks.slice(0, MAX_TASKS)) {
          // Skip if missing required fields
          if (!t.taskId || !t.title) continue;

          const jobs: ActionJobSpec[] = [];
          for (const j of (t.jobs ?? []).slice(0, MAX_JOBS_PER_TASK)) {
            const resolved = normalizeJobKind(j.kind);
            if (!resolved) {
              console.warn(`[Brain] Ignoring unknown job kind: ${j.kind}`);
              continue;
            }
            if (resolved !== j.kind) {
              console.log(`[Brain] Normalized job kind: "${j.kind}" → "${resolved}"`);
            }
            jobs.push({ kind: resolved, params: j.params ?? {} });
          }

          if (jobs.length === 0) continue; // no valid jobs → skip task

          validated.push({
            taskId: t.taskId.slice(0, 64),
            title: t.title.slice(0, MAX_TITLE_LEN),
            description: (t.description ?? "").slice(0, MAX_DESC_LEN),
            jobs,
          });
        }

        if (validated.length > 0) {
          output.tasks = validated;
        }
      }

      if (result.usage) {
        console.log(
          `[Brain] Tokens: ${result.usage.promptTokens} in, ${result.usage.completionTokens} out`,
        );
      }

      return output;
    } catch (err) {
      console.error("[Brain] LLM error:", err);
      // Graceful fallback — still respond to user
      return {
        assistantMessage: `I encountered an error processing your request: ${String(err)}. Please try again.`,
      };
    }
  }
}
