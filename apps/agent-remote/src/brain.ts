/**
 * Agent "brain" — takes user messages + session context and produces
 * either a plain assistant_message or a structured action plan
 * (tasks + jobs) for the orchestrator to execute.
 *
 * Milestone A: chat-only response
 * Milestone B: structured JSON action plan (tasks + jobs)
 */

import type { LLMClient, LLMMessage } from "./llm.js";

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
        { "kind": "string — job kind (bun.test, bun.lint, git.status)", "params": {} }
      ]
    }
  ]
}

Guidelines:
- For simple greetings or questions, respond with just assistant_message (no tasks).
- For actionable requests like "run tests", "lint the code", "check git status", create appropriate tasks with jobs.
- Available job kinds: bun.test, bun.lint, git.status
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
        assistantMessage:
          parsed.assistant_message ?? "I received your message but couldn't formulate a response.",
      };

      // Only include tasks if actions are enabled and the model produced them
      if (this.actionsEnabled && parsed.tasks && parsed.tasks.length > 0) {
        output.tasks = parsed.tasks.map((t) => ({
          taskId: t.taskId,
          title: t.title,
          description: t.description,
          jobs: (t.jobs ?? []).map((j) => ({
            kind: j.kind,
            params: j.params ?? {},
          })),
        }));
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
