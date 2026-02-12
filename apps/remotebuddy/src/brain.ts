/**
 * Agent "brain" — takes user messages + session context and produces
 * either a plain assistant_message or a structured action plan
 * (tasks + jobs) for the orchestrator to execute.
 *
 * Milestone A: chat-only response
 * Milestone B: structured JSON action plan (tasks + jobs)
 */

import { loadPromptTemplate } from "shared";
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
  "file.write",
  "file.patch",
  "file.rename",
  "file.delete",
  "file.copy",
  "file.append",
  "file.mkdir",
  "ci.status",
  "project.summary",
  "shell.exec",
  "web.fetch",
  "web.search",
]);
const FILE_MODIFYING_JOB_KINDS = new Set([
  "file.write",
  "file.patch",
  "file.rename",
  "file.delete",
  "file.copy",
  "file.append",
  "file.mkdir",
]);

function parseStructuredJson(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("empty model response");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Try fenced JSON block.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        // fall through
      }
    }

    // Last resort: parse the largest object-looking slice.
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }

    throw new Error("response did not contain parseable JSON");
  }
}

function tryParseStructuredJson(text: string): { parsed: any | null; error: string | null } {
  try {
    return { parsed: parseStructuredJson(text), error: null };
  } catch (err) {
    return { parsed: null, error: String(err) };
  }
}

function extractAssistantFallback(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  // If model wrapped plain text in fences, unwrap it.
  const fenced = trimmed.match(/^```(?:json|text|md|markdown)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  return trimmed;
}

function hasFileWriteIntent(text: string): boolean {
  const t = text.toLowerCase();
  const explicitWrite =
    /\b(create|write|add|generate|make|update|edit)\b/.test(t) &&
    /\b(file|doc|document|readme)\b/.test(t);
  const hasFileLikeToken =
    /\b[\w./-]+\.(md|txt|json|yaml|yml|ts|tsx|js|jsx|py|java|go|rs|c|cpp)\b/i.test(text);
  return explicitWrite || hasFileLikeToken;
}

function extractRequestedPath(text: string): string | null {
  const patterns = [
    /file\s+(?:called|named)\s+["'`]?([^"'`\s]+)["'`]?/i,
    /create\s+(?:a\s+)?file\s+["'`]?([^"'`\s]+)["'`]?/i,
    /write\s+(?:to|into)\s+["'`]?([^"'`\s]+)["'`]?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const raw = match[1]?.trim();
    if (!raw) continue;
    const cleaned = raw.replace(/[.,!?;:]+$/, "");
    if (cleaned.includes("/") || cleaned.includes("\\") || cleaned.includes(".")) {
      return cleaned;
    }
  }
  return null;
}

function hasMutatingJobs(tasks: ActionTask[]): boolean {
  return tasks.some((task) => task.jobs.some((job) => FILE_MODIFYING_JOB_KINDS.has(job.kind)));
}

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
    write: "file.write",
    create: "file.write",
    patch: "file.patch",
    edit: "file.patch",
    modify: "file.patch",
    rename: "file.rename",
    move: "file.rename",
    mv: "file.rename",
    delete: "file.delete",
    remove: "file.delete",
    rm: "file.delete",
    copy: "file.copy",
    cp: "file.copy",
    duplicate: "file.copy",
    append: "file.append",
    mkdir: "file.mkdir",
    directory: "file.mkdir",
    ci: "ci.status",
    summary: "project.summary",
    overview: "project.summary",
    shell: "shell.exec",
    exec: "shell.exec",
    run: "shell.exec",
    command: "shell.exec",
    cmd: "shell.exec",
    fetch: "web.fetch",
    url: "web.fetch",
    download: "web.fetch",
    websearch: "web.search",
    google: "web.search",
    lookup: "web.search",
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

const BASE_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/remotebuddy_system_prompt.md", {
  repo_root: process.cwd(),
  platform: process.platform,
});
const POST_SYSTEM_PROMPT = loadPromptTemplate("shared/post_system_prompt.md");
const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}\n\n${POST_SYSTEM_PROMPT}`.trim();

const BASE_FALLBACK_FILE_SYSTEM_PROMPT = loadPromptTemplate(
  "remotebuddy/fallback_file_system_prompt.md",
);
const FALLBACK_FILE_SYSTEM_PROMPT = `${BASE_FALLBACK_FILE_SYSTEM_PROMPT}\n\n${POST_SYSTEM_PROMPT}`.trim();

// ─── Brain class ────────────────────────────────────────────────────────────

export class AgentBrain {
  private llm: LLMClient;
  /** When true, include tasks in output. When false, chat-only. */
  private actionsEnabled: boolean;

  constructor(llm: LLMClient, opts?: { actionsEnabled?: boolean }) {
    this.llm = llm;
    this.actionsEnabled = opts?.actionsEnabled ?? true;
  }

  private async generateFallbackFileContent(
    userText: string,
    targetPath: string,
    context?: string[],
  ): Promise<string> {
    const contextBlock =
      context && context.length > 0 ? `Recent context:\n${context.slice(-10).join("\n")}` : "";
    const userPrompt = loadPromptTemplate("remotebuddy/fallback_file_user_prompt.md", {
      target_path: targetPath,
      user_request: userText,
      context_block: contextBlock,
    });

    const result = await this.llm.generate({
      system: FALLBACK_FILE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: userPrompt,
        },
      ],
      json: false,
      maxTokens: 2500,
      temperature: 0.3,
    });
    return result.text.trim();
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

      const parsedResult = tryParseStructuredJson(result.text);
      if (!parsedResult.parsed || typeof parsedResult.parsed !== "object") {
        if (parsedResult.error) {
          console.warn(
            `[Brain] Non-JSON LLM response; using text fallback (${parsedResult.error}).`,
          );
        }
        const fallback = extractAssistantFallback(result.text).slice(0, MAX_ASSISTANT_MSG_LEN);
        if (result.usage) {
          console.log(
            `[Brain] Tokens: ${result.usage.promptTokens} in, ${result.usage.completionTokens} out`,
          );
        }
        return {
          assistantMessage:
            fallback || "I received your message but couldn't formulate a response.",
        };
      }

      const parsed = parsedResult.parsed as {
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

      const requestedPath = extractRequestedPath(userText);
      const wantsFileWrite = hasFileWriteIntent(userText);
      const hasMutatingTask = output.tasks ? hasMutatingJobs(output.tasks) : false;

      // Safety net: this orchestrator is currently single-pass, so pure discovery jobs
      // (e.g. only file.list) can dead-end. Ensure write intents emit a file.write job.
      if (this.actionsEnabled && requestedPath && wantsFileWrite && !hasMutatingTask) {
        let fallbackContent = "";
        try {
          fallbackContent = await this.generateFallbackFileContent(
            userText,
            requestedPath,
            context,
          );
        } catch (err) {
          console.warn("[Brain] Fallback file-content generation failed:", err);
        }
        if (!fallbackContent) {
          fallbackContent = output.assistantMessage;
        }

        const fallbackTask: ActionTask = {
          taskId: `t-write-${Date.now().toString(36).slice(-6)}`,
          title: `Write ${requestedPath}`,
          description: `Create/update ${requestedPath} from user request`,
          jobs: [{ kind: "file.write", params: { path: requestedPath, content: fallbackContent } }],
        };

        const existing = output.tasks ?? [];
        output.tasks =
          existing.length < MAX_TASKS
            ? [...existing, fallbackTask]
            : [...existing.slice(0, MAX_TASKS - 1), fallbackTask];
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
