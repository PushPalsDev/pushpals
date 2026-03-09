import { createHash } from "crypto";
import {
  containsGlobMeta,
  normalizeRepoRelativePath,
  normalizeWriteGlob,
  type AutonomyComponentArea,
  type AutonomyObjectiveType,
} from "shared";

const OBJECTIVE_TYPES: AutonomyObjectiveType[] = [
  "flaky_test",
  "lint_fix",
  "type_fix",
  "small_refactor",
  "feature_small",
  "feature_medium",
  "feature_large",
  "docs",
  "dep_bump",
];

const TRIGGER_TYPES = ["test_failure", "lint_failure", "typecheck_failure", "queue_health", "regret_signal"] as const;

type TriggerType = (typeof TRIGGER_TYPES)[number];

const COMPONENT_AREAS: AutonomyComponentArea[] = [
  "apps/server",
  "apps/remotebuddy",
  "apps/workerpals",
  "apps/client",
  "packages/protocol",
  "packages/shared",
  "tests/integration",
  "tests/unit",
];

function slugify(value: string, { keepSlash = false }: { keepSlash?: boolean } = {}): string {
  const replaced = value
    .toLowerCase()
    .replace(keepSlash ? /[^a-z0-9/]+/g : /[^a-z0-9]+/g, keepSlash ? "/" : "_")
    .replace(keepSlash ? /\/+/g : /_+/g, keepSlash ? "/" : "_")
    .replace(/^[/_]+|[/_]+$/g, "");
  return replaced;
}

const OBJECTIVE_LOOKUP = new Map<string, AutonomyObjectiveType>();
for (const objective of OBJECTIVE_TYPES) {
  const slug = slugify(objective);
  OBJECTIVE_LOOKUP.set(slug, objective);
  OBJECTIVE_LOOKUP.set(slug.replace(/_/g, ""), objective);
}

const TRIGGER_LOOKUP = new Map<string, TriggerType>();
for (const trigger of TRIGGER_TYPES) {
  const slug = slugify(trigger);
  TRIGGER_LOOKUP.set(slug, trigger);
  TRIGGER_LOOKUP.set(slug.replace(/_/g, ""), trigger);
}

const COMPONENT_LOOKUP = new Map<string, AutonomyComponentArea>();
for (const area of COMPONENT_AREAS) {
  const slashSlug = slugify(area, { keepSlash: true });
  const underscoreSlug = slugify(area);
  COMPONENT_LOOKUP.set(slashSlug, area);
  COMPONENT_LOOKUP.set(underscoreSlug, area);
  COMPONENT_LOOKUP.set(underscoreSlug.replace(/_/g, ""), area);
  const tokens = area.split("/");
  if (tokens.length > 1) {
    COMPONENT_LOOKUP.set(tokens.at(-1) ?? area, area);
  }
}
COMPONENT_LOOKUP.set("integration", "tests/integration");
COMPONENT_LOOKUP.set("unit", "tests/unit");
COMPONENT_LOOKUP.set("server", "apps/server");

export interface GraphTelemetryEvent {
  step: "pattern_key_parse" | "dependency_normalization" | "dependency_resolution";
  accepted: boolean;
  reason?: string;
  pattern_key?: string;
  dependency_raw?: string;
  canonical?: string;
  detail?: string;
}

export interface GraphTelemetryOptions {
  telemetry?: GraphTelemetryEvent[];
  recordTelemetry?: (event: GraphTelemetryEvent) => void;
}

function emitTelemetry(options: GraphTelemetryOptions | undefined, event: GraphTelemetryEvent): void {
  if (options?.telemetry) options.telemetry.push(event);
  options?.recordTelemetry?.(event);
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asStringList(value: unknown, options?: { preserveEmpty?: boolean }): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asString(entry))
      .filter((entry) => (options?.preserveEmpty ? true : Boolean(entry)));
  }
  const text = asString(value);
  if (!text) return [];
  return text
    .split(/[\n,]+/)
    .map((segment) => segment.trim())
    .filter((segment) => (options?.preserveEmpty ? true : Boolean(segment)));
}

function normalizeObjectiveSegment(segment: string | null): AutonomyObjectiveType | null {
  if (!segment) return null;
  const slug = slugify(segment);
  if (!slug) return null;
  return OBJECTIVE_LOOKUP.get(slug) ?? OBJECTIVE_LOOKUP.get(slug.replace(/_/g, "")) ?? null;
}

function normalizeComponentSegment(segment: string | null): AutonomyComponentArea | null {
  if (!segment) return null;
  const slug = slugify(segment, { keepSlash: true });
  if (slug && COMPONENT_LOOKUP.has(slug)) return COMPONENT_LOOKUP.get(slug) ?? null;
  const fallback = slugify(segment);
  if (fallback && COMPONENT_LOOKUP.has(fallback)) return COMPONENT_LOOKUP.get(fallback) ?? null;
  const compact = fallback.replace(/_/g, "");
  if (compact && COMPONENT_LOOKUP.has(compact)) return COMPONENT_LOOKUP.get(compact) ?? null;
  return null;
}

function normalizeTriggerSegment(segment: string | null): TriggerType | null {
  if (!segment) return null;
  const slug = slugify(segment);
  if (!slug) return null;
  return TRIGGER_LOOKUP.get(slug) ?? TRIGGER_LOOKUP.get(slug.replace(/_/g, "")) ?? null;
}

export interface PatternKeyShape {
  objective_type: AutonomyObjectiveType | null;
  component_area: AutonomyComponentArea | null;
  trigger_type: TriggerType | null;
  segments: string[];
  raw: string;
}

const SEGMENT_SPLIT_RE = /[|>\n\r,\t]+/;
const SEGMENT_PAIR_RE =
  /^(objective(?:[_\-\s]?type)?|component(?:[_\-\s]?area)?|trigger(?:[_\-\s]?type)?)\s*[:=\-]\s*(.+)$/i;

export function parsePatternKeyShape(
  rawPatternKey: unknown,
  options?: GraphTelemetryOptions,
): PatternKeyShape | null {
  const patternKey = asString(rawPatternKey);
  if (!patternKey) {
    emitTelemetry(options, {
      step: "pattern_key_parse",
      accepted: false,
      reason: "pattern_key_missing",
    });
    return null;
  }
  const sanitized = patternKey.replace(/[`"\u201c\u201d]/g, "");
  const segments = sanitized
    .split(SEGMENT_SPLIT_RE)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    emitTelemetry(options, {
      step: "pattern_key_parse",
      accepted: false,
      reason: "pattern_key_unparseable",
      pattern_key: patternKey,
    });
    return null;
  }
  let objectiveSegment: string | null = null;
  let componentSegment: string | null = null;
  let triggerSegment: string | null = null;
  const fallbackSegments: string[] = [];
  for (const segment of segments) {
    const match = segment.match(SEGMENT_PAIR_RE);
    if (match) {
      const [, key, value] = match;
      if (!value) continue;
      const normalizedValue = value.trim();
      const keyLower = key.toLowerCase();
      if (!objectiveSegment && keyLower.startsWith("objective")) objectiveSegment = normalizedValue;
      else if (!componentSegment && keyLower.startsWith("component")) componentSegment = normalizedValue;
      else if (!triggerSegment && keyLower.startsWith("trigger")) triggerSegment = normalizedValue;
      continue;
    }
    fallbackSegments.push(segment);
  }
  if (!objectiveSegment && fallbackSegments.length > 0) objectiveSegment = fallbackSegments.shift() ?? null;
  if (!componentSegment && fallbackSegments.length > 0) componentSegment = fallbackSegments.shift() ?? null;
  if (!triggerSegment && fallbackSegments.length > 0) triggerSegment = fallbackSegments.shift() ?? null;

  const objective = normalizeObjectiveSegment(objectiveSegment);
  const component = normalizeComponentSegment(componentSegment);
  const trigger = normalizeTriggerSegment(triggerSegment);

  if (!objective && objectiveSegment) {
    emitTelemetry(options, {
      step: "pattern_key_parse",
      accepted: false,
      reason: "unknown_objective_segment",
      pattern_key: patternKey,
      detail: objectiveSegment,
    });
  }
  if (!component && componentSegment) {
    emitTelemetry(options, {
      step: "pattern_key_parse",
      accepted: false,
      reason: "unknown_component_segment",
      pattern_key: patternKey,
      detail: componentSegment,
    });
  }
  if (!trigger && triggerSegment) {
    emitTelemetry(options, {
      step: "pattern_key_parse",
      accepted: false,
      reason: "unknown_trigger_segment",
      pattern_key: patternKey,
      detail: triggerSegment,
    });
  }

  if (!objective && !component && !trigger) {
    emitTelemetry(options, {
      step: "pattern_key_parse",
      accepted: false,
      reason: "pattern_key_unparseable",
      pattern_key: patternKey,
    });
    return null;
  }

  return {
    objective_type: objective,
    component_area: component,
    trigger_type: trigger,
    segments,
    raw: patternKey,
  };
}

const DEPENDENCY_KEY_LIMIT = 160;
const DEFAULT_MAX_DEPENDENCIES = 12;

export interface GraphDependencyKey {
  raw: string;
  canonical: string;
  truncated: string;
  fingerprint: string;
}

function formatDependencyKey(canonical: string, raw: string): GraphDependencyKey {
  const truncationNeeded = canonical.length > DEPENDENCY_KEY_LIMIT;
  const truncated = truncationNeeded ? `${canonical.slice(0, DEPENDENCY_KEY_LIMIT)}...` : canonical;
  const fingerprint = `dep_${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
  return { raw, canonical, truncated, fingerprint };
}

function refineGlobSegments(value: string): string | null {
  const segments = value.split("/");
  const refined: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed || trimmed === ".") continue;
    if (trimmed === "..") return null;
    if ((trimmed === "*" || trimmed === "**") && refined.length > 0) {
      const prev = refined[refined.length - 1];
      if (prev === "**") continue;
      if (prev === "*" && trimmed === "*") continue;
      refined.push(trimmed);
      continue;
    }
    refined.push(trimmed);
  }
  while (refined.length > 0) {
    const last = refined[refined.length - 1];
    if (last === "*" || last === "**") refined.pop();
    else break;
  }
  if (refined.length === 0) return "global";
  return refined.join("/");
}

export function canonicalizeDependencyKey(value: unknown): string | null {
  const rawValue = asString(value);
  if (!rawValue) return null;
  let normalized = rawValue
    .replace(/[`"\u201c\u201d]/g, "")
    .replace(/\\/g, "/")
    .trim();
  if (!normalized) return null;
  normalized = normalized.replace(/^\.\/+/, "");
  normalized = normalized.replace(/^\/+/g, "");
  normalized = normalized.replace(/\/+/g, "/");
  const lowered = normalized.toLowerCase();
  if (lowered === "global" || lowered === "repo" || lowered === "workspace") return "global";
  if (/^(?:\.\.(?:\/.+)?)$/.test(normalized) || normalized.includes("/../")) return null;
  const hasGlob = containsGlobMeta(normalized);
  const base = hasGlob ? normalizeWriteGlob(normalized) : normalizeRepoRelativePath(normalized);
  if (!base) return null;
  return refineGlobSegments(base);
}

function collectDependencyInputs(candidate: Record<string, unknown>): string[] {
  const sources = [
    candidate.dependencies,
    candidate.dependency_paths,
    candidate.dependencyPaths,
    candidate.dependency_globs,
    candidate.dependencyGlobs,
    candidate.dependency_keys,
    candidate.dependencyKeys,
  ];
  const out: string[] = [];
  for (const source of sources) {
    out.push(...asStringList(source, { preserveEmpty: true }));
  }
  return out;
}

function deriveFallbackCanonical(
  candidate: Record<string, unknown>,
  shape: PatternKeyShape | null,
): string | null {
  const targetSources = [candidate.target_paths, candidate.targetPaths, candidate.targets];
  for (const source of targetSources) {
    for (const entry of asStringList(source)) {
      const canonical = canonicalizeDependencyKey(entry);
      if (canonical) return canonical;
    }
  }
  if (shape?.component_area) return shape.component_area;
  if (shape?.objective_type) return `objective/${shape.objective_type}`;
  const component = normalizeComponentSegment(asString(candidate.component_area));
  if (component) return component;
  return "global";
}

export interface NormalizedGraphCandidate {
  pattern_key: string | null;
  shape: PatternKeyShape | null;
  dependency_keys: GraphDependencyKey[];
  fallback_applied: boolean;
}

export function normalizeOpportunityGraphCandidate(
  rawCandidate: unknown,
  options?: GraphTelemetryOptions & { maxDependencies?: number },
): NormalizedGraphCandidate {
  const candidate =
    rawCandidate && typeof rawCandidate === "object" && !Array.isArray(rawCandidate)
      ? (rawCandidate as Record<string, unknown>)
      : {};
  const patternKey = asString(candidate.pattern_key ?? candidate.patternKey);
  const shape = parsePatternKeyShape(patternKey, options);
  const dependencyInputs = collectDependencyInputs(candidate);
  const dependencyKeys: GraphDependencyKey[] = [];
  const seen = new Set<string>();
  for (const rawEntry of dependencyInputs) {
    const trimmed = rawEntry.trim();
    if (!trimmed) {
      emitTelemetry(options, {
        step: "dependency_normalization",
        accepted: false,
        reason: "dependency_entry_blank",
        pattern_key: patternKey || undefined,
      });
      continue;
    }
    const canonical = canonicalizeDependencyKey(trimmed);
    if (!canonical) {
      emitTelemetry(options, {
        step: "dependency_normalization",
        accepted: false,
        reason: "dependency_entry_invalid",
        dependency_raw: trimmed,
        pattern_key: patternKey || undefined,
      });
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    dependencyKeys.push(formatDependencyKey(canonical, trimmed));
  }
  const maxDependencies = Number.isFinite(options?.maxDependencies)
    ? Math.max(0, Math.floor(Number(options?.maxDependencies)))
    : DEFAULT_MAX_DEPENDENCIES;
  if (dependencyKeys.length > maxDependencies) {
    const dropped = dependencyKeys.length - maxDependencies;
    dependencyKeys.length = maxDependencies;
    emitTelemetry(options, {
      step: "dependency_normalization",
      accepted: false,
      reason: "dependency_truncated",
      detail: String(dropped),
      pattern_key: patternKey || undefined,
    });
  }
  let fallbackApplied = false;
  if (dependencyKeys.length === 0) {
    const fallbackCanonical = deriveFallbackCanonical(candidate, shape);
    if (fallbackCanonical) {
      dependencyKeys.push(formatDependencyKey(fallbackCanonical, fallbackCanonical));
      fallbackApplied = true;
      emitTelemetry(options, {
        step: "dependency_resolution",
        accepted: true,
        reason: "dependency_fallback_applied",
        canonical: fallbackCanonical,
        pattern_key: patternKey || undefined,
      });
    } else {
      emitTelemetry(options, {
        step: "dependency_resolution",
        accepted: false,
        reason: "dependency_unresolved",
        pattern_key: patternKey || undefined,
      });
    }
  }
  return {
    pattern_key: patternKey || null,
    shape,
    dependency_keys: dependencyKeys,
    fallback_applied: fallbackApplied,
  };
}
