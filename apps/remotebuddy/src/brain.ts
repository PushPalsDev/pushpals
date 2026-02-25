/**
 * Strict RemoteBuddy planner.
 *
 * Produces one canonical planning object that the orchestrator can execute
 * without heuristic fallbacks.
 */

import { loadPromptTemplate } from "shared";
import type { LLMClient, LLMMessage } from "./llm.js";
import { normalizeRepoPathHint } from "./path_targeting.js";

export type PlannerIntent = "chat" | "status" | "code_change" | "analysis" | "other";
export type PlannerRiskLevel = "low" | "medium" | "high";
export type PlannerLane = "deterministic" | "worker";

export interface PlannerOutput {
  intent: PlannerIntent; // this is the high level goal, e.g. "fix bug with login"
  requires_worker: boolean; // if false, the agent can do it themselves and doesn't need to delegate to a worker
  job_kind: "task.execute" | "none";
  lane: PlannerLane; // "deterministic" (fast path) or "worker" (agentic execution)
  // constraints + discovery hints
  scope: {
    read_anywhere: boolean; // usually true, default: true
    write_allowed: boolean; // often false unless requested, default: true
    write_globs?: string[]; // if you want to constrain edits, default: true
    forbidden_globs?: string[]; // never touch, default: none
    max_files_to_edit?: number; // blast radius cap, default: unlimited
  };
  discovery?: {
    ripgrep_queries: string[]; // worker uses these
    likely_dirs?: string[]; // hints only
    keywords?: string[]; // helps search
  };
  acceptance_criteria: string[]; // usually in prompt, but can be dynamically updated by the agent based on new info
  validation_steps: string[]; // usually in prompt, but can be dynamically updated by the agent based on new info
  risk_level: PlannerRiskLevel;
  assistant_message: string; // what the assistant will say to the user when presenting the plan
  worker_instruction: string; // instructions for the worker, can be more technical and detailed than assistant_message
  user_message: string; // what the user said to the assistant to trigger this plan, included for context but not always necessary
}

/**
 * Optional overrides that come from the request queue (LocalBuddy / API client).
 * These MUST take priority over model output.
 */
export interface PlannerOverrides {
  forceWorker?: boolean;
  forceLane?: PlannerLane;
}

const MAX_ASSISTANT_CHARS = 4000;
const MAX_WORKER_INSTRUCTION_CHARS = 12000;
const MAX_SCOPE_GLOBS = 24;
const MAX_DISCOVERY_ITEMS = 24;
const MAX_ACCEPTANCE_CRITERIA = 16;
const MAX_VALIDATION_STEPS = 16;

const BASE_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/remotebuddy_system_prompt.md", {
  repo_root: process.cwd(),
  platform: process.platform,
});
const POST_SYSTEM_PROMPT = loadPromptTemplate("shared/post_system_prompt.md");
const PLANNER_POST_SYSTEM_PROMPT = loadPromptTemplate(
  "remotebuddy/planner_post_system_prompt.md",
).trim();
const PLANNER_REPAIR_SUFFIX_PROMPT = loadPromptTemplate(
  "remotebuddy/planner_repair_suffix_prompt.md",
).trim();
const SYSTEM_PROMPT =
  `${BASE_SYSTEM_PROMPT}\n\n${POST_SYSTEM_PROMPT}\n\n${PLANNER_POST_SYSTEM_PROMPT}`.trim();

const REPAIR_SYSTEM_PROMPT = `${SYSTEM_PROMPT}\n\n${PLANNER_REPAIR_SUFFIX_PROMPT}`.trim();

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
        enum: ["deterministic", "worker"],
      },
      scope: {
        type: "object",
        properties: {
          read_anywhere: { type: "boolean" },
          write_allowed: { type: "boolean" },
          write_globs: { type: "array", items: { type: "string" } },
          forbidden_globs: { type: "array", items: { type: "string" } },
          max_files_to_edit: { type: "number" },
        },
        required: ["read_anywhere", "write_allowed"],
        additionalProperties: false,
      },
      discovery: {
        type: "object",
        properties: {
          ripgrep_queries: { type: "array", items: { type: "string" } },
          likely_dirs: { type: "array", items: { type: "string" } },
          keywords: { type: "array", items: { type: "string" } },
        },
        required: ["ripgrep_queries"],
        additionalProperties: false,
      },
      acceptance_criteria: {
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
      user_message: { type: "string" },
    },
    required: [
      "intent",
      "requires_worker",
      "job_kind",
      "lane",
      "scope",
      "acceptance_criteria",
      "validation_steps",
      "risk_level",
      "assistant_message",
      "worker_instruction",
      "user_message",
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
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        // fall through
      }
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const snippet = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(snippet);
      } catch {
        // fall through
      }
    }
    throw new Error("response did not contain parseable JSON");
  }
}

function normalizeJsonLikeText(input: string): string {
  return input
    .replace(/\uFEFF/g, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

function parseStructuredJsonWithLocalRepair(text: string): unknown {
  const repaired = normalizeJsonLikeText(text);
  return parseStructuredJson(repaired);
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
  return text === "deterministic" ? "deterministic" : "worker";
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

function dedupeRepoPathHints(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const normalized = normalizeRepoPathHint(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function hasActionableWorkerVerbs(text: string): boolean {
  return /\b(apply|append|add|edit|update|modify|change|replace|write|create|remove|run|verify|check|ensure)\b/i.test(
    text,
  );
}

function looksContradictoryWorkerInstruction(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("no worker instruction needed") ||
    normalized.includes("no additional instruction needed") ||
    normalized.includes("purely documentation update") ||
    normalized.includes("already updated") ||
    normalized.includes("nothing to do")
  );
}

function sanitizePlannerOutput(raw: unknown, userText: string): PlannerOutput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("planner output is not an object");
  }
  const record = raw as Record<string, unknown>;
  let intent = asIntent(record.intent);
  let requiresWorker = Boolean(record.requires_worker);

  // Safety override: LLM chose "other" (or "analysis") + requires_worker=false for what looks
  // like a coding task. Upgrade to code_change + requires_worker=true rather than silently
  // completing with no action.
  if (
    !requiresWorker &&
    (intent === "other" || intent === "analysis") &&
    looksCodeChangeRequest(userText)
  ) {
    console.warn(
      `[Brain] sanitize: upgraded intent "${intent}" → "code_change" (requires_worker=true) based on prompt heuristic`,
    );
    intent = "code_change";
    requiresWorker = true;
  }

  const lane = asLane(record.lane);
  const riskLevel = asRisk(record.risk_level);
  const scopeRecord =
    record.scope && typeof record.scope === "object" && !Array.isArray(record.scope)
      ? (record.scope as Record<string, unknown>)
      : {};
  const readAnywhere =
    typeof scopeRecord.read_anywhere === "boolean" ? scopeRecord.read_anywhere : true;
  const writeAllowedRaw =
    typeof scopeRecord.write_allowed === "boolean" ? scopeRecord.write_allowed : true;
  const writeGlobs = dedupeRepoPathHints(scopeRecord.write_globs, MAX_SCOPE_GLOBS);
  const forbiddenGlobs = dedupeRepoPathHints(scopeRecord.forbidden_globs, MAX_SCOPE_GLOBS);
  const maxFilesRaw = Number(scopeRecord.max_files_to_edit);
  const maxFilesToEdit =
    Number.isFinite(maxFilesRaw) && maxFilesRaw > 0 ? Math.floor(maxFilesRaw) : undefined;

  const discoveryRecord =
    record.discovery && typeof record.discovery === "object" && !Array.isArray(record.discovery)
      ? (record.discovery as Record<string, unknown>)
      : null;
  const ripgrepQueries = dedupeStrings(discoveryRecord?.ripgrep_queries, MAX_DISCOVERY_ITEMS);
  const likelyDirs = dedupeRepoPathHints(discoveryRecord?.likely_dirs, MAX_DISCOVERY_ITEMS);
  const keywords = dedupeStrings(discoveryRecord?.keywords, MAX_DISCOVERY_ITEMS);
  const acceptanceCriteria = dedupeStrings(record.acceptance_criteria, MAX_ACCEPTANCE_CRITERIA);
  const validationSteps = dedupeStrings(record.validation_steps, MAX_VALIDATION_STEPS);

  const fallbackWorkerInstruction = userText.trim().slice(0, MAX_WORKER_INSTRUCTION_CHARS);
  const assistantMessageRaw = String(record.assistant_message ?? "").trim();
  const workerInstructionRaw = String(record.worker_instruction ?? "")
    .trim()
    .slice(0, MAX_WORKER_INSTRUCTION_CHARS);
  const userMessage = String(record.user_message ?? userText)
    .trim()
    .slice(0, MAX_WORKER_INSTRUCTION_CHARS);
  const assistantMessage = (
    assistantMessageRaw ||
    userMessage ||
    workerInstructionRaw ||
    fallbackWorkerInstruction ||
    "Understood. I will proceed with this request."
  ).slice(0, MAX_ASSISTANT_CHARS);

  const requires_worker = requiresWorker;
  const workerInstruction =
    requires_worker &&
    workerInstructionRaw &&
    (!hasActionableWorkerVerbs(workerInstructionRaw) ||
      looksContradictoryWorkerInstruction(workerInstructionRaw))
      ? ""
      : workerInstructionRaw;
  const writeAllowed = requires_worker && intent === "code_change" ? true : writeAllowedRaw;
  const job_kind: "task.execute" | "none" = requires_worker ? "task.execute" : "none";

  return {
    intent,
    requires_worker,
    job_kind,
    lane: requires_worker ? lane : "deterministic",
    scope: {
      read_anywhere: readAnywhere,
      write_allowed: writeAllowed,
      ...(writeGlobs.length > 0 ? { write_globs: writeGlobs } : {}),
      ...(forbiddenGlobs.length > 0 ? { forbidden_globs: forbiddenGlobs } : {}),
      ...(maxFilesToEdit ? { max_files_to_edit: maxFilesToEdit } : {}),
    },
    ...(ripgrepQueries.length > 0 || likelyDirs.length > 0 || keywords.length > 0
      ? {
          discovery: {
            ripgrep_queries: ripgrepQueries,
            ...(likelyDirs.length > 0 ? { likely_dirs: likelyDirs } : {}),
            ...(keywords.length > 0 ? { keywords } : {}),
          },
        }
      : {}),
    acceptance_criteria: acceptanceCriteria,
    validation_steps: validationSteps,
    risk_level: riskLevel,
    assistant_message: assistantMessage,
    worker_instruction: workerInstruction || fallbackWorkerInstruction,
    user_message: userMessage || userText,
  };
}

function looksCodeChangeRequest(userText: string): boolean {
  const lower = userText.toLowerCase();
  return (
    /\b(add|append|implement|build|integrate|generate|setup|configure|improve|optimize|edit|update|modify|change|write|create|delete|remove|rename|refactor|fix|patch|test|run|apply|migrate|wire|hook|connect)\b/.test(
      lower,
    ) ||
    /\b(file|path|prompt|readme|config|test|tests|spec|coverage|feature|function|class|module|component|ts|js|py|md|toml|json|yaml|yml)\b/.test(
      lower,
    )
  );
}

function extractPromptPathHints(userText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeRepoPathHint(value);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };
  for (const match of userText.matchAll(/\b([A-Za-z0-9._/\-\\]+\.[A-Za-z0-9._-]+)\b/g)) {
    add(match[1]);
    if (out.length >= MAX_SCOPE_GLOBS) break;
  }
  if (out.length < MAX_SCOPE_GLOBS) {
    for (const match of userText.matchAll(/["'`]([^"'`\r\n]+)["'`]/g)) {
      const candidate = String(match[1] ?? "").trim();
      if (!(candidate.includes("/") || candidate.includes("\\") || candidate.includes("."))) {
        continue;
      }
      add(candidate);
      if (out.length >= MAX_SCOPE_GLOBS) break;
    }
  }
  return out;
}

function fallbackPlannerOutput(userText: string): PlannerOutput {
  const requiresWorker = looksCodeChangeRequest(userText);
  const targetPaths = extractPromptPathHints(userText).filter((entry) => entry !== ".");
  const likelyDirs = dedupeRepoPathHints(
    targetPaths
      .map((entry) => {
        const idx = entry.lastIndexOf("/");
        return idx > 0 ? entry.slice(0, idx) : ".";
      })
      .filter(Boolean),
    MAX_DISCOVERY_ITEMS,
  );
  const validation = targetPaths.length
    ? [`git diff -- ${targetPaths.slice(0, 4).join(" ")}`, "git status --porcelain"]
    : ["git status --porcelain"];
  return {
    intent: requiresWorker ? "code_change" : "chat",
    requires_worker: requiresWorker,
    job_kind: requiresWorker ? "task.execute" : "none",
    lane: requiresWorker ? "worker" : "deterministic",
    scope: {
      read_anywhere: true,
      write_allowed: requiresWorker,
      ...(targetPaths.length > 0 ? { write_globs: targetPaths } : {}),
      ...(targetPaths.length > 0 ? { max_files_to_edit: targetPaths.length } : {}),
    },
    ...(requiresWorker
      ? {
          discovery: {
            ripgrep_queries: targetPaths.length > 0 ? [...targetPaths] : ["README.md"],
            ...(likelyDirs.length > 0 ? { likely_dirs: likelyDirs } : {}),
          },
        }
      : {}),
    acceptance_criteria: [
      "Apply the requested update(s) exactly and keep unrelated content unchanged.",
    ],
    validation_steps: validation,
    risk_level: targetPaths.length <= 2 ? "low" : "medium",
    assistant_message:
      "Planner JSON was invalid; proceeding with a safe fallback execution plan derived from your request.",
    worker_instruction: userText.trim().slice(0, MAX_WORKER_INSTRUCTION_CHARS),
    user_message: userText.trim().slice(0, MAX_WORKER_INSTRUCTION_CHARS),
  };
}

function applyOverrides(plan: PlannerOutput, overrides?: PlannerOverrides): PlannerOutput {
  if (!overrides) return plan;

  const forceWorker = overrides.forceWorker === true;
  const forceLane =
    overrides.forceLane === "deterministic" || overrides.forceLane === "worker"
      ? overrides.forceLane
      : null;

  // If forceWorker is on, we *must* require a worker and ensure job_kind matches.
  if (forceWorker) {
    const lane = forceLane ?? plan.lane ?? "worker";
    return {
      ...plan,
      requires_worker: true,
      job_kind: "task.execute",
      lane,
    };
  }

  // If not forcing a worker, lane only matters if the plan already requires worker.
  if (forceLane) {
    if (plan.requires_worker) {
      return { ...plan, lane: forceLane };
    }
    // If no worker is required, lane should remain deterministic.
    return { ...plan, lane: "deterministic" };
  }

  return plan;
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
    maxTokens = 900,
  ): Promise<string> {
    const result = await this.llm.generate({
      system,
      messages,
      json: true,
      jsonSchema: REMOTEBUDDY_PLANNER_JSON_SCHEMA,
      maxTokens,
      temperature: 0,
    });
    if (result.usage) {
      console.log(
        `[Brain] Tokens: ${result.usage.promptTokens} in, ${result.usage.completionTokens} out`,
      );
    }
    return result.text;
  }

  async think(
    userText: string,
    context?: string[],
    overrides?: PlannerOverrides,
  ): Promise<PlannerOutput> {
    const messages = this.buildMessages(userText, context);
    const primaryRaw = await this.generatePlanRaw(SYSTEM_PROMPT, messages);

    try {
      const parsed = parseStructuredJson(primaryRaw);
      const plan = sanitizePlannerOutput(parsed, userText);
      return applyOverrides(plan, overrides);
    } catch (primaryErr) {
      try {
        const repairedParsed = parseStructuredJsonWithLocalRepair(primaryRaw);
        console.warn(
          `[Brain] Primary planner JSON was invalid; local deterministic repair succeeded (${String(primaryErr)}).`,
        );
        const plan = sanitizePlannerOutput(repairedParsed, userText);
        return applyOverrides(plan, overrides);
      } catch (localRepairErr) {
        console.warn(
          `[Brain] Primary planner JSON was invalid; local repair failed, sending to LLM strict repair (${String(localRepairErr)}).`,
        );
      }

      console.warn(
        `[Brain] Invalid planner JSON; attempting strict repair via LLM (${String(primaryErr)}).`,
      );
      const repairMessages: LLMMessage[] = [
        {
          role: "user",
          content: loadPromptTemplate("remotebuddy/planner_repair_user_prompt.md", {
            user_text: userText,
            primary_raw: primaryRaw,
          }),
        },
      ];

      try {
        const repairedRaw = await this.generatePlanRaw(REPAIR_SYSTEM_PROMPT, repairMessages, 1800);
        const repairedParsed = parseStructuredJson(repairedRaw);
        const plan = sanitizePlannerOutput(repairedParsed, userText);
        return applyOverrides(plan, overrides);
      } catch (repairErr) {
        console.warn(
          `[Brain] Planner repair failed; using deterministic fallback plan (${String(repairErr)}).`,
        );
        return applyOverrides(fallbackPlannerOutput(userText), overrides);
      }
    }
  }
}
