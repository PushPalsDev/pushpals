import type { PlannerOutput } from "./brain.js";

export type TaskExecutionLane = "deterministic" | "worker";
export type RequestPriority = "interactive" | "normal" | "background";

export interface RequestAutonomyMetadata {
  origin: "autonomy";
  objectiveId?: string;
  runId?: string;
  snapshotId?: string;
  patternKey?: string;
  componentArea?: string;
  targetPaths: string[];
  writeGlobs: string[];
}

export interface TaskExecuteJobParams {
  schemaVersion: 2;
  requestId: string;
  sessionId: string;
  origin: "user" | "autonomy";
  autonomy?: {
    origin: "autonomy";
    objectiveId?: string;
    runId?: string;
    snapshotId?: string;
    patternKey?: string;
    componentArea?: string;
  };
  instruction: string;
  plannerWorkerInstruction?: string;
  lane: TaskExecutionLane;
  paths?: string[];
  planning: {
    intent: PlannerOutput["intent"];
    riskLevel: PlannerOutput["risk_level"];
    targetPaths?: string[];
    scope: {
      readAnywhere: boolean;
      writeAllowed: boolean;
      writeGlobs?: string[];
      forbiddenGlobs?: string[];
      maxFilesToEdit?: number;
    };
    discovery?: {
      ripgrepQueries: string[];
      likelyDirs?: string[];
      keywords?: string[];
    };
    acceptanceCriteria: string[];
    validationSteps: string[];
    queuePriority: RequestPriority;
    queueWaitBudgetMs: number;
    executionBudgetMs: number;
    finalizationBudgetMs: number;
  };
  targetPath?: string;
  recentContext: string[];
  recentJobs: Array<Record<string, unknown>>;
}

export interface CreateTaskExecuteJobParamsInput {
  requestId: string;
  sessionId: string;
  plan: PlannerOutput;
  priority: RequestPriority;
  lane: TaskExecutionLane;
  canonicalInstruction: string;
  plannerWorkerInstruction?: string;
  targetPaths: unknown[];
  targetPath?: string | null;
  queueWaitBudgetMs: number;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
  autonomyMetadata?: RequestAutonomyMetadata | null;
  recentContext: string[];
  recentJobs: Array<Record<string, unknown>>;
  onWarning?: (message: string) => void;
}

const TRUE_STRINGS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_STRINGS = new Set(["false", "0", "no", "n", "off"]);

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return `"${value}"`;
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

function normalizeStrictBoolean(
  value: unknown,
  field: string,
  defaultValue: boolean,
  onWarning?: (message: string) => void,
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(normalized)) return true;
    if (FALSE_STRINGS.has(normalized)) return false;
    if (normalized.length === 0) {
      onWarning?.(
        `[TaskExecuteJobParams] ${field} received blank string; defaulting to ${defaultValue}.`,
      );
      return defaultValue;
    }
  }
  onWarning?.(
    `[TaskExecuteJobParams] ${field} expected boolean but got ${describeValue(value)}; defaulting to ${defaultValue}.`,
  );
  return defaultValue;
}

function sanitizeStringList(
  value: unknown,
  { allowDot = false }: { allowDot?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = typeof entry === "string" ? entry.trim() : String(entry ?? "").trim();
    if (!text && !(allowDot && text === ".")) continue;
    if (text === "." && !allowDot) continue;
    out.push(text);
  }
  return out;
}

function sanitizeAcceptanceList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : String(entry ?? "").trim()))
    .filter((entry) => entry.length > 0);
}

export function createTaskExecuteJobParams(
  input: CreateTaskExecuteJobParamsInput,
): TaskExecuteJobParams {
  const {
    requestId,
    sessionId,
    plan,
    priority,
    lane,
    canonicalInstruction,
    plannerWorkerInstruction,
    targetPaths,
    targetPath,
    queueWaitBudgetMs,
    executionBudgetMs,
    finalizationBudgetMs,
    autonomyMetadata,
    recentContext,
    recentJobs,
    onWarning,
  } = input;

  const normalizedPaths = sanitizeStringList(targetPaths, { allowDot: true });
  const strictTargetPaths = normalizedPaths.filter((entry) => entry !== ".");

  const normalizedInstruction = canonicalInstruction.trim();
  const normalizedPlannerInstruction = (plannerWorkerInstruction ?? "").trim();
  const plannerInstruction =
    normalizedPlannerInstruction && normalizedPlannerInstruction !== normalizedInstruction
      ? normalizedPlannerInstruction
      : undefined;

  const readAnywhere = normalizeStrictBoolean(
    plan.scope.read_anywhere,
    "planning.scope.read_anywhere",
    false,
    onWarning,
  );
  const writeAllowed = normalizeStrictBoolean(
    plan.scope.write_allowed,
    "planning.scope.write_allowed",
    false,
    onWarning,
  );
  const writeGlobs = sanitizeStringList(plan.scope.write_globs, { allowDot: true });
  const forbiddenGlobs = sanitizeStringList(plan.scope.forbidden_globs);
  const maxFilesRaw = Number(plan.scope.max_files_to_edit);
  const maxFilesToEdit = Number.isFinite(maxFilesRaw) && maxFilesRaw > 0 ? Math.floor(maxFilesRaw) : undefined;

  const discovery = (() => {
    if (!plan.discovery) return undefined;
    const ripgrepQueries = sanitizeStringList(plan.discovery.ripgrep_queries);
    const likelyDirs = sanitizeStringList(plan.discovery.likely_dirs, { allowDot: true });
    const keywords = sanitizeStringList(plan.discovery.keywords);
    const payload: {
      ripgrepQueries: string[];
      likelyDirs?: string[];
      keywords?: string[];
    } = { ripgrepQueries };
    if (likelyDirs.length > 0) payload.likelyDirs = likelyDirs;
    if (keywords.length > 0) payload.keywords = keywords;
    return payload;
  })();

  const acceptanceCriteria = sanitizeAcceptanceList(plan.acceptance_criteria);
  const validationSteps = sanitizeAcceptanceList(plan.validation_steps);
  const normalizedTargetPath = typeof targetPath === "string" ? targetPath.trim() : undefined;

  const origin = autonomyMetadata ? "autonomy" : "user";

  return {
    schemaVersion: 2,
    requestId,
    sessionId,
    origin,
    ...(autonomyMetadata
      ? {
          autonomy: {
            origin: "autonomy" as const,
            ...(autonomyMetadata.objectiveId ? { objectiveId: autonomyMetadata.objectiveId } : {}),
            ...(autonomyMetadata.runId ? { runId: autonomyMetadata.runId } : {}),
            ...(autonomyMetadata.snapshotId ? { snapshotId: autonomyMetadata.snapshotId } : {}),
            ...(autonomyMetadata.patternKey ? { patternKey: autonomyMetadata.patternKey } : {}),
            ...(autonomyMetadata.componentArea ? { componentArea: autonomyMetadata.componentArea } : {}),
          },
        }
      : {}),
    instruction: normalizedInstruction,
    plannerWorkerInstruction: plannerInstruction,
    lane,
    ...(normalizedPaths.length > 0 ? { paths: normalizedPaths } : {}),
    planning: {
      intent: plan.intent,
      riskLevel: plan.risk_level,
      ...(strictTargetPaths.length > 0 ? { targetPaths: strictTargetPaths } : {}),
      scope: {
        readAnywhere,
        writeAllowed,
        ...(writeGlobs.length > 0 ? { writeGlobs } : {}),
        ...(forbiddenGlobs.length > 0 ? { forbiddenGlobs } : {}),
        ...(maxFilesToEdit ? { maxFilesToEdit } : {}),
      },
      ...(discovery ? { discovery } : {}),
      acceptanceCriteria,
      validationSteps,
      queuePriority: priority,
      queueWaitBudgetMs,
      executionBudgetMs,
      finalizationBudgetMs,
    },
    ...(normalizedTargetPath ? { targetPath: normalizedTargetPath } : {}),
    recentContext,
    recentJobs,
  };
}
