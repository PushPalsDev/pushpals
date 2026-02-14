/**
 * Strict RemoteBuddy planner.
 *
 * Produces one canonical planning object that the orchestrator can execute
 * without heuristic fallbacks.
 */

import { loadPromptTemplate } from "shared";
import type { LLMClient, LLMMessage } from "./llm.js";

export type PlannerIntent = "chat" | "status" | "code_change" | "analysis" | "other";
export type PlannerRiskLevel = "low" | "medium" | "high";
export type PlannerLane = "deterministic" | "openhands";

export interface PlannerOutput {
  intent: PlannerIntent;
  requires_worker: boolean;
  job_kind: "task.execute" | "none";
  lane: PlannerLane;
  target_paths: string[];
  validation_steps: string[];
  risk_level: PlannerRiskLevel;
  assistant_message: string;
  worker_instruction: string;
}

const MAX_ASSISTANT_CHARS = 4000;
const MAX_WORKER_INSTRUCTION_CHARS = 12000;
const MAX_TARGET_PATHS = 16;
const MAX_VALIDATION_STEPS = 16;

const BASE_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/remotebuddy_system_prompt.md", {
  repo_root: process.cwd(),
  platform: process.platform,
});
const POST_SYSTEM_PROMPT = loadPromptTemplate("shared/post_system_prompt.md");
const SYSTEM_PROMPT =
  `${BASE_SYSTEM_PROMPT}\n\n${POST_SYSTEM_PROMPT}\n\nYou are a strict planning function.\nReturn only structured JSON that matches the required schema.`.trim();

const REPAIR_SYSTEM_PROMPT =
  `${SYSTEM_PROMPT}\n\nYour previous response was invalid. Repair it to valid schema-compliant JSON only.`.trim();

export const REMOTEBUDDY_PLANNER_JSON_SCHEMA: Record<string, unknown> = {
  name: "remotebuddy_planner",
  strict: false,
  schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: ["chat", "status", "code_change", "analysis", "other"],
      },
      requires_worker: { type: "boolean" },
      job_kind: {
        type: "string",
        enum: ["task.execute", "none"],
      },
      lane: {
        type: "string",
        enum: ["deterministic", "openhands"],
      },
      target_paths: {
        type: "array",
        items: { type: "string" },
      },
      validation_steps: {
        type: "array",
        items: { type: "string" },
      },
      risk_level: {
        type: "string",
        enum: ["low", "medium", "high"],
      },
      assistant_message: { type: "string" },
      worker_instruction: { type: "string" },
    },
    required: [
      "intent",
      "requires_worker",
      "job_kind",
      "lane",
      "target_paths",
      "validation_steps",
      "risk_level",
      "assistant_message",
      "worker_instruction",
    ],
    additionalProperties: false,
  },
};

function parseStructuredJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty model response");
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("response did not contain parseable JSON");
  }
}

function asIntent(value: unknown): PlannerIntent {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "chat" || text === "status" || text === "code_change" || text === "analysis") {
    return text;
  }
  return "other";
}

function asRisk(value: unknown): PlannerRiskLevel {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "low" || text === "high") return text;
  return "medium";
}

function asLane(value: unknown): PlannerLane {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text === "deterministic" ? "deterministic" : "openhands";
}

function dedupeStrings(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function sanitizePlannerOutput(raw: unknown, userText: string): PlannerOutput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("planner output is not an object");
  }
  const record = raw as Record<string, unknown>;
  const intent = asIntent(record.intent);
  const requiresWorker = Boolean(record.requires_worker);
  const lane = asLane(record.lane);
  const riskLevel = asRisk(record.risk_level);
  const targetPaths = dedupeStrings(record.target_paths, MAX_TARGET_PATHS);
  const validationSteps = dedupeStrings(record.validation_steps, MAX_VALIDATION_STEPS);

  const assistantMessage = String(record.assistant_message ?? "")
    .trim()
    .slice(0, MAX_ASSISTANT_CHARS);
  if (!assistantMessage) throw new Error("assistant_message is required");

  const fallbackWorkerInstruction = userText.trim().slice(0, MAX_WORKER_INSTRUCTION_CHARS);
  const workerInstruction = String(record.worker_instruction ?? "")
    .trim()
    .slice(0, MAX_WORKER_INSTRUCTION_CHARS);

  const requires_worker = requiresWorker;
  const job_kind: "task.execute" | "none" = requires_worker ? "task.execute" : "none";

  return {
    intent,
    requires_worker,
    job_kind,
    lane: requires_worker ? lane : "deterministic",
    target_paths: targetPaths,
    validation_steps: validationSteps,
    risk_level: riskLevel,
    assistant_message: assistantMessage,
    worker_instruction: workerInstruction || fallbackWorkerInstruction,
  };
}

export class AgentBrain {
  private llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  private buildMessages(userText: string, context?: string[]): LLMMessage[] {
    const messages: LLMMessage[] = [];
    if (Array.isArray(context) && context.length > 0) {
      messages.push({
        role: "user",
        content: `Recent session context:\n${context.join("\n")}\n\n---\n\nNew user request:\n${userText}`,
      });
    } else {
      messages.push({ role: "user", content: userText });
    }
    return messages;
  }

  private async generatePlanRaw(
    system: string,
    messages: LLMMessage[],
    maxTokens = 1600,
  ): Promise<string> {
    const result = await this.llm.generate({
      system,
      messages,
      json: true,
      jsonSchema: REMOTEBUDDY_PLANNER_JSON_SCHEMA,
      maxTokens,
      temperature: 0.1,
    });
    if (result.usage) {
      console.log(
        `[Brain] Tokens: ${result.usage.promptTokens} in, ${result.usage.completionTokens} out`,
      );
    }
    return result.text;
  }

  async think(userText: string, context?: string[]): Promise<PlannerOutput> {
    const messages = this.buildMessages(userText, context);
    const primaryRaw = await this.generatePlanRaw(SYSTEM_PROMPT, messages);

    try {
      const parsed = parseStructuredJson(primaryRaw);
      return sanitizePlannerOutput(parsed, userText);
    } catch (primaryErr) {
      console.warn(
        `[Brain] Invalid planner JSON; attempting strict repair (${String(primaryErr)}).`,
      );
      const repairMessages: LLMMessage[] = [
        {
          role: "user",
          content: [
            "Original request:",
            userText,
            "",
            "Invalid planner output to repair:",
            primaryRaw,
            "",
            "Return only valid schema-compliant JSON.",
          ].join("\n"),
        },
      ];

      const repairedRaw = await this.generatePlanRaw(REPAIR_SYSTEM_PROMPT, repairMessages, 1800);
      const repairedParsed = parseStructuredJson(repairedRaw);
      return sanitizePlannerOutput(repairedParsed, userText);
    }
  }
}
