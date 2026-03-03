import type { Artifact } from "protocol";

export const TASK_EXECUTE_SCHEMA_VERSION = 2 as const;

export type TaskExecuteLane = "deterministic" | "worker";
export type TaskExecuteOrigin = "user" | "autonomy";
export type TaskExecutePriority = "interactive" | "normal" | "background";
export type TaskExecuteIntent = "chat" | "status" | "code_change" | "analysis" | "other";
export type TaskExecuteRisk = "low" | "medium" | "high";

export interface TaskExecuteScope {
  readAnywhere: boolean;
  writeAllowed: boolean;
  writeGlobs?: string[];
  forbiddenGlobs?: string[];
  maxFilesToEdit?: number;
}

export interface TaskExecuteDiscovery {
  ripgrepQueries: string[];
  likelyDirs?: string[];
  keywords?: string[];
}

export interface TaskExecutePlanning {
  intent: TaskExecuteIntent;
  riskLevel: TaskExecuteRisk;
  targetPaths?: string[];
  scope: TaskExecuteScope;
  discovery?: TaskExecuteDiscovery;
  acceptanceCriteria: string[];
  validationSteps: string[];
  queuePriority: TaskExecutePriority;
  queueWaitBudgetMs: number;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
}

export interface TaskExecuteAutonomyMetadata {
  origin: "autonomy";
  objectiveId?: string;
  runId?: string;
  snapshotId?: string;
  patternKey?: string;
  componentArea?: string;
}

export interface TaskExecuteJobParams {
  schemaVersion: typeof TASK_EXECUTE_SCHEMA_VERSION;
  requestId: string;
  sessionId: string;
  origin?: TaskExecuteOrigin;
  autonomy?: TaskExecuteAutonomyMetadata;
  instruction: string;
  plannerWorkerInstruction?: string;
  lane: TaskExecuteLane;
  paths?: string[];
  planning: TaskExecutePlanning;
  targetPath?: string;
  recentContext: string[];
  recentJobs: Array<Record<string, unknown>>;
  qualityRevisionHint?: string;
  qualityRevisionAttempt?: number;
}

export interface TaskExecuteJobResult {
  ok: boolean;
  summary: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  artifacts?: Artifact[];
  commit?: TaskExecuteJobResultCommit;
}

export interface TaskExecuteJobCompletionPayload {
  jobId: string;
  summary?: string;
  artifacts?: Artifact[];
}

export interface TaskExecuteJobPayload {
  kind: "task.execute";
  params: TaskExecuteJobParams;
}

export interface TaskExecuteJobRequest {
  taskId: string;
  sessionId: string;
  kind: "task.execute";
  params: TaskExecuteJobParams;
  targetWorkerId?: string;
}

export interface TaskExecuteJobResultCommit {
  branch: string;
  sha: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const VALID_LANES: readonly TaskExecuteLane[] = ["deterministic", "worker"];
const VALID_ORIGINS: readonly TaskExecuteOrigin[] = ["user", "autonomy"];
const VALID_PRIORITIES: readonly TaskExecutePriority[] = ["interactive", "normal", "background"];
const VALID_INTENTS: readonly TaskExecuteIntent[] = [
  "chat",
  "status",
  "code_change",
  "analysis",
  "other",
];
const VALID_RISKS: readonly TaskExecuteRisk[] = ["low", "medium", "high"];

export function validateTaskExecuteJobParams(raw: unknown): ValidationResult<TaskExecuteJobParams> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["task.execute params must be an object"] };
  }
  const errors: string[] = [];
  const record = raw as Record<string, unknown>;
  asNumber(record.schemaVersion, "schemaVersion", errors, {
    required: true,
    exact: TASK_EXECUTE_SCHEMA_VERSION,
  });

  const requestId = asString(record.requestId, "requestId", errors, { required: true });
  const sessionId = asString(record.sessionId, "sessionId", errors, { required: true });
  const instruction = asString(record.instruction, "instruction", errors, { required: true });
  const lane = asEnum(record.lane, VALID_LANES, "lane", errors);

  const origin =
    record.origin === undefined
      ? undefined
      : asEnum(record.origin, VALID_ORIGINS, "origin", errors);
  const autonomy = normalizeAutonomy(record.autonomy, origin, errors);

  const plannerInstruction = asString(
    record.plannerWorkerInstruction,
    "plannerWorkerInstruction",
    errors,
    {
      trimOnly: true,
    },
  );

  const paths = normalizeOptionalStringArray(record.paths, "paths", errors);
  const planning = normalizePlanning(record.planning, errors);
  const targetPath = asString(record.targetPath, "targetPath", errors, { trimOnly: true });
  const recentContext = normalizeStringArray(record.recentContext, "recentContext", errors, {
    allowEmpty: true,
  });
  const recentJobs = normalizeRecentJobs(record.recentJobs, errors);

  const qualityRevisionHint = asString(
    record.qualityRevisionHint,
    "qualityRevisionHint",
    errors,
    { trimOnly: true },
  );
  const qualityRevisionAttempt =
    record.qualityRevisionAttempt === undefined
      ? undefined
      : asNumber(
          record.qualityRevisionAttempt,
          "qualityRevisionAttempt",
          errors,
          { integer: true, min: 1 },
        );

  if (qualityRevisionHint && typeof qualityRevisionAttempt !== "number") {
    errors.push("qualityRevisionAttempt is required when qualityRevisionHint is provided");
  } else if (!qualityRevisionHint && typeof qualityRevisionAttempt === "number") {
    errors.push("qualityRevisionHint is required when qualityRevisionAttempt is provided");
  }

  if (
    !requestId ||
    !sessionId ||
    !instruction ||
    !lane ||
    !planning ||
    recentContext === null ||
    recentJobs === null
  ) {
    return { ok: false, errors };
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const normalized: TaskExecuteJobParams = {
    schemaVersion: TASK_EXECUTE_SCHEMA_VERSION,
    requestId,
    sessionId,
    instruction,
    lane,
    planning,
    recentContext,
    recentJobs,
  };

  if (origin) normalized.origin = origin;
  if (autonomy) normalized.autonomy = autonomy;
  if (plannerInstruction) normalized.plannerWorkerInstruction = plannerInstruction;
  if (paths !== undefined) normalized.paths = paths;
  if (targetPath) normalized.targetPath = targetPath;
  if (qualityRevisionHint) normalized.qualityRevisionHint = qualityRevisionHint;
  if (typeof qualityRevisionAttempt === "number") {
    normalized.qualityRevisionAttempt = qualityRevisionAttempt;
  }

  return { ok: true, value: normalized };
}

export function assertTaskExecuteJobParams(raw: unknown): TaskExecuteJobParams {
  const result = validateTaskExecuteJobParams(raw);
  if (!result.ok) {
    throw new Error(`Invalid task.execute params: ${result.errors.join("; ")}`);
  }
  return result.value;
}

export function isTaskExecuteJobParams(raw: unknown): raw is TaskExecuteJobParams {
  return validateTaskExecuteJobParams(raw).ok;
}

export function validateTaskExecuteJobResult(raw: unknown): ValidationResult<TaskExecuteJobResult> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["task.execute result must be an object"] };
  }
  const errors: string[] = [];
  const record = raw as Record<string, unknown>;
  const ok = asBoolean(record.ok, "ok", errors);
  const summary = asString(record.summary, "summary", errors, { required: true });
  const stdout = asString(record.stdout, "stdout", errors, { trimOnly: true });
  const stderr = asString(record.stderr, "stderr", errors, { trimOnly: true });
  const exitCode = asNumber(record.exitCode, "exitCode", errors, { integer: true });
  const artifacts = normalizeArtifacts(record.artifacts, "artifacts", errors);
  const commit = normalizeCommitMetadata(record.commit, errors);

  if (ok === null || !summary) {
    return { ok: false, errors };
  }

  const result: TaskExecuteJobResult = {
    ok,
    summary,
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
    ...(exitCode !== null && exitCode !== undefined ? { exitCode } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(commit ? { commit } : {}),
  };

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: result };
}

export function assertTaskExecuteJobResult(raw: unknown): TaskExecuteJobResult {
  const result = validateTaskExecuteJobResult(raw);
  if (!result.ok) {
    throw new Error(`Invalid task.execute result: ${result.errors.join("; ")}`);
  }
  return result.value;
}

export function validateTaskExecuteJobCompletionPayload(
  raw: unknown,
): ValidationResult<TaskExecuteJobCompletionPayload> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["job completion payload must be an object"] };
  }

  const errors: string[] = [];
  const record = raw as Record<string, unknown>;
  const jobId = asString(record.jobId, "jobId", errors, { required: true });
  const summary = asString(record.summary, "summary", errors, { trimOnly: true });
  const artifacts = normalizeArtifacts(record.artifacts, "artifacts", errors);

  if (!jobId || errors.length > 0) {
    return { ok: false, errors };
  }

  const payload: TaskExecuteJobCompletionPayload = { jobId };
  if (summary) payload.summary = summary;
  if (artifacts) payload.artifacts = artifacts;

  return {
    ok: true,
    value: payload,
  };
}

export function assertTaskExecuteJobCompletionPayload(
  raw: unknown,
): TaskExecuteJobCompletionPayload {
  const result = validateTaskExecuteJobCompletionPayload(raw);
  if (!result.ok) {
    throw new Error(`Invalid task.execute completion payload: ${result.errors.join("; ")}`);
  }
  return result.value;
}

export function validateTaskExecuteJobPayload(raw: unknown): ValidationResult<TaskExecuteJobPayload> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["task.execute payload must be an object"] };
  }
  const errors: string[] = [];
  const record = raw as Record<string, unknown>;
  const kind = asString(record.kind, "kind", errors, { required: true });
  if (kind && kind !== "task.execute") {
    errors.push('kind must equal "task.execute"');
  }
  const paramsResult = validateTaskExecuteJobParams(record.params);
  if (!paramsResult.ok) {
    for (const message of paramsResult.errors) {
      errors.push(`params: ${message}`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      kind: "task.execute",
      params: paramsResult.value,
    },
  };
}

export function assertTaskExecuteJobPayload(raw: unknown): TaskExecuteJobPayload {
  const result = validateTaskExecuteJobPayload(raw);
  if (!result.ok) {
    throw new Error(`Invalid task.execute payload: ${result.errors.join("; ")}`);
  }
  return result.value;
}

export function validateTaskExecuteJobRequest(
  raw: unknown,
): ValidationResult<TaskExecuteJobRequest> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["task.execute job request must be an object"] };
  }

  const errors: string[] = [];
  const record = raw as Record<string, unknown>;
  const taskId = asString(record.taskId, "taskId", errors, { required: true });
  const sessionId = asString(record.sessionId, "sessionId", errors, { required: true });
  const kind = asString(record.kind, "kind", errors, { required: true });
  if (kind && kind !== "task.execute") {
    errors.push('kind must equal "task.execute"');
  }
  const targetWorkerId = asString(record.targetWorkerId, "targetWorkerId", errors, {
    trimOnly: true,
  });
  const paramsResult = validateTaskExecuteJobParams(record.params);
  if (!paramsResult.ok) {
    for (const message of paramsResult.errors) {
      errors.push(`params: ${message}`);
    }
  }

  if (errors.length > 0 || !taskId || !sessionId || kind !== "task.execute") {
    return { ok: false, errors };
  }

  const request: TaskExecuteJobRequest = {
    taskId,
    sessionId,
    kind: "task.execute",
    params: paramsResult.value,
  };
  if (targetWorkerId) request.targetWorkerId = targetWorkerId;

  return { ok: true, value: request };
}

export function assertTaskExecuteJobRequest(raw: unknown): TaskExecuteJobRequest {
  const result = validateTaskExecuteJobRequest(raw);
  if (!result.ok) {
    throw new Error(`Invalid task.execute job request: ${result.errors.join("; ")}`);
  }
  return result.value;
}

export function isTaskExecuteJobRequest(raw: unknown): raw is TaskExecuteJobRequest {
  return validateTaskExecuteJobRequest(raw).ok;
}

function normalizePlanning(value: unknown, errors: string[]): TaskExecutePlanning | null {
  if (!isPlainObject(value)) {
    errors.push("planning must be an object");
    return null;
  }
  const record = value as Record<string, unknown>;
  const intent = asEnum(record.intent, VALID_INTENTS, "planning.intent", errors);
  const riskLevel = asEnum(record.riskLevel, VALID_RISKS, "planning.riskLevel", errors);
  const queuePriority = asEnum(
    record.queuePriority,
    VALID_PRIORITIES,
    "planning.queuePriority",
    errors,
  );
  const queueWaitBudgetMs = asNumber(
    record.queueWaitBudgetMs,
    "planning.queueWaitBudgetMs",
    errors,
    { min: 0 },
  );
  const executionBudgetMs = asNumber(
    record.executionBudgetMs,
    "planning.executionBudgetMs",
    errors,
    { min: 0 },
  );
  const finalizationBudgetMs = asNumber(
    record.finalizationBudgetMs,
    "planning.finalizationBudgetMs",
    errors,
    { min: 0 },
  );
  const scope = normalizeScope(record.scope, errors);
  const acceptanceCriteria = normalizeStringArray(
    record.acceptanceCriteria,
    "planning.acceptanceCriteria",
    errors,
  );
  const validationSteps = normalizeStringArray(
    record.validationSteps,
    "planning.validationSteps",
    errors,
  );
  const targetPaths = normalizeOptionalStringArray(
    record.targetPaths,
    "planning.targetPaths",
    errors,
  );
  const discovery = normalizeDiscovery(record.discovery, errors);

  if (
    !intent ||
    !riskLevel ||
    !scope ||
    !acceptanceCriteria ||
    !validationSteps ||
    !queuePriority ||
    queueWaitBudgetMs === null ||
    executionBudgetMs === null ||
    finalizationBudgetMs === null
  ) {
    return null;
  }

  const planning: TaskExecutePlanning = {
    intent,
    riskLevel,
    scope,
    acceptanceCriteria,
    validationSteps,
    queuePriority,
    queueWaitBudgetMs,
    executionBudgetMs,
    finalizationBudgetMs,
  };

  if (targetPaths) planning.targetPaths = targetPaths;
  if (discovery) planning.discovery = discovery;

  return planning;
}

function normalizeScope(value: unknown, errors: string[]): TaskExecuteScope | null {
  if (!isPlainObject(value)) {
    errors.push("planning.scope must be an object");
    return null;
  }
  const record = value as Record<string, unknown>;
  const readAnywhere = asBoolean(record.readAnywhere, "planning.scope.readAnywhere", errors);
  const writeAllowed = asBoolean(record.writeAllowed, "planning.scope.writeAllowed", errors);
  const writeGlobs = normalizeOptionalStringArray(
    record.writeGlobs,
    "planning.scope.writeGlobs",
    errors,
  );
  const forbiddenGlobs = normalizeOptionalStringArray(
    record.forbiddenGlobs,
    "planning.scope.forbiddenGlobs",
    errors,
  );
  const maxFilesToEdit =
    record.maxFilesToEdit === undefined
      ? null
      : asNumber(record.maxFilesToEdit, "planning.scope.maxFilesToEdit", errors, {
          min: 1,
          integer: true,
        });

  if (readAnywhere === null || writeAllowed === null) {
    return null;
  }

  const scope: TaskExecuteScope = { readAnywhere, writeAllowed };
  if (writeGlobs) scope.writeGlobs = writeGlobs;
  if (forbiddenGlobs) scope.forbiddenGlobs = forbiddenGlobs;
  if (maxFilesToEdit !== null && maxFilesToEdit !== undefined) {
    scope.maxFilesToEdit = maxFilesToEdit;
  }
  return scope;
}

function normalizeDiscovery(
  value: unknown,
  errors: string[],
): TaskExecuteDiscovery | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push("planning.discovery must be an object when provided");
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const ripgrepQueries = normalizeStringArray(
    record.ripgrepQueries,
    "planning.discovery.ripgrepQueries",
    errors,
    { allowEmpty: true },
  );
  if (!ripgrepQueries) return undefined;
  const discovery: TaskExecuteDiscovery = { ripgrepQueries };
  const likelyDirs = normalizeOptionalStringArray(
    record.likelyDirs,
    "planning.discovery.likelyDirs",
    errors,
  );
  const keywords = normalizeOptionalStringArray(
    record.keywords,
    "planning.discovery.keywords",
    errors,
  );
  if (likelyDirs) discovery.likelyDirs = likelyDirs;
  if (keywords) discovery.keywords = keywords;
  return discovery;
}

function normalizeAutonomy(
  value: unknown,
  origin: TaskExecuteOrigin | undefined,
  errors: string[],
): TaskExecuteAutonomyMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push("autonomy must be an object when provided");
    return undefined;
  }
  if (origin && origin !== "autonomy") {
    errors.push("autonomy metadata requires origin \"autonomy\"");
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const nestedOrigin = asString(record.origin, "autonomy.origin", errors, { trimOnly: true });
  if (nestedOrigin && nestedOrigin !== "autonomy") {
    errors.push('autonomy.origin must equal "autonomy" when provided');
    return undefined;
  }
  const normalized: TaskExecuteAutonomyMetadata = { origin: "autonomy" };
  const data: Array<[keyof Omit<TaskExecuteAutonomyMetadata, "origin">, unknown]> = [
    ["objectiveId", record.objectiveId],
    ["runId", record.runId],
    ["snapshotId", record.snapshotId],
    ["patternKey", record.patternKey],
    ["componentArea", record.componentArea],
  ];
  for (const [key, raw] of data) {
    const valueStr = asString(raw, `autonomy.${key}`, errors, { trimOnly: true });
    if (valueStr) normalized[key] = valueStr;
  }
  return normalized;
}

function normalizeRecentJobs(
  value: unknown,
  errors: string[],
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) {
    errors.push("recentJobs must be an array");
    return null;
  }
  const jobs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (!isPlainObject(entry)) {
      errors.push(`recentJobs[${i}] must be an object`);
      continue;
    }
    jobs.push(entry as Record<string, unknown>);
  }
  return jobs;
}

function normalizeArtifacts(
  value: unknown,
  label: string,
  errors: string[],
): Artifact[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array when provided`);
    return undefined;
  }
  const artifacts: Artifact[] = [];
  let artifactError = false;
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (!isPlainObject(entry)) {
      errors.push(`${label}[${i}] must be an object`);
      artifactError = true;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const kind = asString(record.kind, `${label}[${i}].kind`, errors, { required: true });
    if (!kind) {
      artifactError = true;
      continue;
    }
    const artifact: Artifact = { kind };
    const uri = asString(record.uri, `${label}[${i}].uri`, errors, { trimOnly: true });
    if (uri) artifact.uri = uri;
    const text = asString(record.text, `${label}[${i}].text`, errors, { trimOnly: true });
    if (text) artifact.text = text;
    artifacts.push(artifact);
  }
  return artifactError ? undefined : artifacts;
}

function normalizeCommitMetadata(
  value: unknown,
  errors: string[],
): TaskExecuteJobResultCommit | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push("commit must be an object when provided");
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const branch = asString(record.branch, "commit.branch", errors, { required: true });
  const sha = asString(record.sha, "commit.sha", errors, { required: true });
  if (!branch || !sha) {
    return undefined;
  }
  return { branch, sha };
}

function normalizeOptionalStringArray(
  value: unknown,
  label: string,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  return normalizeStringArray(value, label, errors, { allowEmpty: true }) ?? undefined;
}

function normalizeStringArray(
  value: unknown,
  label: string,
  errors: string[],
  options?: { allowEmpty?: boolean },
): string[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return null;
  }
  const normalized: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = asString(value[i], `${label}[${i}]`, errors, { trimOnly: true });
    if (!entry) continue;
    normalized.push(entry);
  }
  if (!options?.allowEmpty && normalized.length === 0) {
    errors.push(`${label} must include at least one entry`);
    return null;
  }
  return normalized;
}

function asEnum<T extends string>(
  value: unknown,
  valid: readonly T[],
  label: string,
  errors: string[],
): T | null {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string literal`);
    return null;
  }
  const text = value.trim();
  if (valid.includes(text as T)) {
    return text as T;
  }
  errors.push(`${label} must be one of: ${valid.join(", ")}`);
  return null;
}

function asString(
  value: unknown,
  label: string,
  errors: string[],
  options?: { required?: boolean; trimOnly?: boolean },
): string | null {
  if (value === undefined || value === null) {
    if (options?.required) errors.push(`${label} is required`);
    return null;
  }
  if (typeof value !== "string") {
    errors.push(`${label} must be a string`);
    return null;
  }
  const trimmed = options?.trimOnly ? value.trim() : value.trim();
  if (!trimmed && options?.required) {
    errors.push(`${label} cannot be empty`);
    return null;
  }
  return trimmed || null;
}

function asBoolean(value: unknown, label: string, errors: string[]): boolean | null {
  if (typeof value === "boolean") return value;
  errors.push(`${label} must be boolean`);
  return null;
}

function asNumber(
  value: unknown,
  label: string,
  errors: string[],
  options?: { required?: boolean; min?: number; integer?: boolean; exact?: number },
): number | null {
  if (value === undefined || value === null) {
    if (options?.required) errors.push(`${label} is required`);
    return null;
  }
  if (typeof value !== "number") {
    errors.push(`${label} must be a number`);
    return null;
  }
  if (!Number.isFinite(value)) {
    errors.push(`${label} must be a finite number`);
    return null;
  }
  if (options?.integer && Math.floor(value) !== value) {
    errors.push(`${label} must be an integer`);
    return null;
  }
  if (options?.min !== undefined && value < options.min) {
    errors.push(`${label} must be >= ${options.min}`);
    return null;
  }
  if (options?.exact !== undefined && value !== options.exact) {
    errors.push(`${label} must equal ${options.exact}`);
    return null;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

if (typeof process !== "undefined" && process.env?.NODE_ENV === "test") {
  void import("bun:test").then(({ describe, expect, test }) => {
    const createValidJobParams = (): Record<string, unknown> => ({
      schemaVersion: TASK_EXECUTE_SCHEMA_VERSION,
      requestId: "req-123",
      sessionId: "sess-456",
      instruction: "Summarize the repository",
      lane: "deterministic",
      planning: {
        intent: "analysis",
        riskLevel: "low",
        scope: {
          readAnywhere: true,
          writeAllowed: false,
        },
        acceptanceCriteria: ["Return a concise summary."],
        validationSteps: ["bun test apps/remotebuddy --filter task.execute"],
        queuePriority: "normal",
        queueWaitBudgetMs: 60_000,
        executionBudgetMs: 120_000,
        finalizationBudgetMs: 60_000,
      },
      recentContext: [],
      recentJobs: [],
    });

    describe("task.execute contract validation", () => {
      test("requires qualityRevisionAttempt when qualityRevisionHint is provided", () => {
        const params = createValidJobParams();
        params.qualityRevisionHint = "Address failing validation steps.";
        const result = validateTaskExecuteJobParams(params);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(
            result.errors.some((message) =>
              message.includes("qualityRevisionAttempt"),
            ),
          ).toBe(true);
        }
      });

      test("requires qualityRevisionHint when qualityRevisionAttempt is provided", () => {
        const params = createValidJobParams();
        params.qualityRevisionAttempt = 1;
        const result = validateTaskExecuteJobParams(params);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(
            result.errors.some((message) =>
              message.includes("qualityRevisionHint"),
            ),
          ).toBe(true);
        }
      });

      test("accepts paired quality revision metadata", () => {
        const params = createValidJobParams();
        params.qualityRevisionHint = "Tighten up acceptance criteria references.";
        params.qualityRevisionAttempt = 2;
        const result = validateTaskExecuteJobParams(params);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.qualityRevisionHint).toBe(params.qualityRevisionHint);
          expect(result.value.qualityRevisionAttempt).toBe(2);
        }
      });

      test("retains empty arrays for context metadata", () => {
        const params = createValidJobParams();
        const result = validateTaskExecuteJobParams(params);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(Array.isArray(result.value.recentContext)).toBe(true);
          expect(result.value.recentContext.length).toBe(0);
          expect(Array.isArray(result.value.recentJobs)).toBe(true);
          expect(result.value.recentJobs.length).toBe(0);
        }
      });

      test("validates the job payload envelope", () => {
        const params = createValidJobParams();
        const result = validateTaskExecuteJobPayload({ kind: "task.execute", params });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.kind).toBe("task.execute");
          expect(result.value.params.instruction).toBe(params.instruction);
        }
      });

      test("rejects envelopes with wrong kind or malformed params", () => {
        const invalid = validateTaskExecuteJobPayload({
          kind: "warmup.execute",
          params: { schemaVersion: 1 },
        });
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
          expect(
            invalid.errors.some((message) => message.includes("kind must equal")),
          ).toBe(true);
        }
      });

      test("validates the job enqueue request payload", () => {
        const params = createValidJobParams();
        const request = validateTaskExecuteJobRequest({
          taskId: "task-123",
          sessionId: "sess-123",
          kind: "task.execute",
          params,
          targetWorkerId: "worker-42",
        });
        expect(request.ok).toBe(true);
        if (request.ok) {
          expect(request.value.targetWorkerId).toBe("worker-42");
          expect(request.value.params.requestId).toBe(params.requestId);
        }
      });

      test("rejects enqueue requests with invalid metadata", () => {
        const invalid = validateTaskExecuteJobRequest({
          taskId: "",
          sessionId: 42,
          kind: "warmup.execute",
          params: { schemaVersion: 1 },
        });
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
          expect(
            invalid.errors.some((message) => message.includes('kind must equal "task.execute"')),
          ).toBe(true);
          expect(
            invalid.errors.some((message) => message.includes("taskId cannot be empty")),
          ).toBe(true);
        }
      });

      test("allows completion payloads without summary text", () => {
        const completion = validateTaskExecuteJobCompletionPayload({
          jobId: "job-123",
          artifacts: [{ kind: "log", text: "finished" }],
        });
        expect(completion.ok).toBe(true);
        if (completion.ok) {
          expect(completion.value.summary).toBeUndefined();
          expect(completion.value.artifacts?.[0]?.kind).toBe("log");
        }
      });

      test("rejects params with non-string textual fields", () => {
        const params = createValidJobParams();
        params.instruction = 42;
        params.recentContext = [42];
        const result = validateTaskExecuteJobParams(params);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(
            result.errors.some((message) => message.includes("instruction must be a string")),
          ).toBe(true);
          expect(
            result.errors.some((message) => message.includes("recentContext[0] must be a string")),
          ).toBe(true);
        }
      });

      test("rejects params with non-numeric planning budgets", () => {
        const params = createValidJobParams();
        const planning = params.planning as Record<string, unknown>;
        planning.queueWaitBudgetMs = "60000";
        const result = validateTaskExecuteJobParams(params);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(
            result.errors.some((message) =>
              message.includes("planning.queueWaitBudgetMs must be a number"),
            ),
          ).toBe(true);
        }
      });

      test("rejects job results with incorrect primitive types", () => {
        const invalid = validateTaskExecuteJobResult({
          ok: "yes",
          summary: 99,
        });
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
          expect(invalid.errors).toEqual(
            expect.arrayContaining(["ok must be boolean", "summary must be a string"]),
          );
        }
      });

      test("rejects job results with malformed artifact entries", () => {
        const invalid = validateTaskExecuteJobResult({
          ok: true,
          summary: "done",
          artifacts: [{ kind: 123 }],
        });
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
          expect(
            invalid.errors.some((message) =>
              message.includes("artifacts[0].kind must be a string"),
            ),
          ).toBe(true);
        }
      });

      test("accepts job results that include commit metadata", () => {
        const result = validateTaskExecuteJobResult({
          ok: true,
          summary: "complete",
          commit: { branch: "agent/foo", sha: "abc123" },
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.commit?.branch).toBe("agent/foo");
          expect(result.value.commit?.sha).toBe("abc123");
        }
      });

      test("rejects job results with malformed commit metadata", () => {
        const invalid = validateTaskExecuteJobResult({
          ok: true,
          summary: "complete",
          commit: { branch: "", sha: 42 },
        });
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
          expect(
            invalid.errors.some((message) => message.includes("commit.branch cannot be empty")),
          ).toBe(true);
          expect(
            invalid.errors.some((message) => message.includes("commit.sha must be a string")),
          ).toBe(true);
        }
      });
    });
  });
}
