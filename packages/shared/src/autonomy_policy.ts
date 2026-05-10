import { createHash } from "crypto";

// Deterministic autonomy policy primitives shared across server/remotebuddy/worker.
export type AutonomyObjectiveType =
  | "flaky_test"
  | "lint_fix"
  | "type_fix"
  | "small_refactor"
  | "feature_small"
  | "feature_medium"
  | "feature_large"
  | "docs"
  | "dep_bump";

export type AutonomyRiskLevel = "low" | "medium" | "high";
export type AutonomyGlobBreadth = "narrow" | "medium" | "broad";
export type AutonomyComponentArea = string;

export type AutonomyPenaltyKind =
  | "duplicate_pattern"
  | "cooldown_active"
  | "budget_exceeded"
  | "scope_violation"
  | "policy_violation"
  | "preflight_blocked"
  | "low_confidence";

export interface AutonomyPenalty {
  kind: AutonomyPenaltyKind;
  weight: number;
  reason: string;
  evidence_ids: string[];
}

export interface ScopeValidationResult {
  ok: boolean;
  componentArea: string | null;
  normalizedTargetPaths: string[];
  normalizedWriteGlobs: string[];
  breadth: AutonomyGlobBreadth;
  errors: string[];
}

const GLOB_META_RE = /[*?\[\]{}()!]/;
const PATH_META_RE = /[*?\[\]{}()!]/;
const DRIVE_RE = /^[A-Za-z]:\//;
const SLASH_RE = /\/+/g;

function parentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return path;
  return path.slice(0, idx);
}

function isProbablyFilePath(path: string): boolean {
  const lastSegment = path.split("/").at(-1) ?? "";
  return lastSegment.includes(".");
}

function scopeSeedPath(path: string): string {
  return isProbablyFilePath(path) ? parentPath(path) : path;
}

function commonRepoAncestor(paths: string[]): string | null {
  const normalized = paths
    .map((entry) => normalizeRepoRelativePath(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (normalized.length === 0) return null;
  if (normalized.length === 1) return normalized[0] ?? null;
  const segments = normalized.map((entry) => entry.split("/"));
  const shared: string[] = [];
  const first = segments[0] ?? [];
  for (let idx = 0; idx < first.length; idx += 1) {
    const segment = first[idx];
    if (!segment) break;
    if (segments.every((parts) => parts[idx] === segment)) {
      shared.push(segment);
      continue;
    }
    break;
  }
  if (shared.length === 0) return null;
  return shared.join("/");
}

export function normalizeAutonomyComponentArea(value: unknown): string | null {
  const normalized = normalizeRepoRelativePath(value);
  if (!normalized) return null;
  return normalized;
}

export function deriveAutonomyComponentArea(
  targetPathsInput: unknown[],
  writeGlobsInput?: unknown[],
): string | null {
  const writePrefixes = Array.isArray(writeGlobsInput)
    ? writeGlobsInput
        .map((entry) => normalizeWriteGlob(entry))
        .filter((entry): entry is string => Boolean(entry))
        .map((entry) => literalPrefix(entry))
        .map((entry) => scopeSeedPath(entry))
        .filter(Boolean)
    : [];
  if (writePrefixes.length > 0) {
    return commonRepoAncestor(writePrefixes);
  }
  const targetSeeds = Array.isArray(targetPathsInput)
    ? targetPathsInput
        .map((entry) => normalizeTargetPath(entry))
        .filter((entry): entry is string => Boolean(entry))
        .map((entry) => scopeSeedPath(entry))
        .filter(Boolean)
    : [];
  if (targetSeeds.length === 0) return null;
  return commonRepoAncestor(targetSeeds);
}

function collectScopeSeedPaths(targetPathsInput: unknown[], writeGlobsInput?: unknown[]): string[] {
  const seeds = new Set<string>();
  if (Array.isArray(writeGlobsInput)) {
    for (const raw of writeGlobsInput) {
      const normalized = normalizeWriteGlob(raw);
      if (!normalized) continue;
      const prefix = literalPrefix(normalized);
      if (!prefix) continue;
      const seed = scopeSeedPath(prefix);
      if (seed) seeds.add(seed);
    }
  }
  if (Array.isArray(targetPathsInput)) {
    for (const raw of targetPathsInput) {
      const normalized = normalizeTargetPath(raw);
      if (!normalized) continue;
      const seed = scopeSeedPath(normalized);
      if (seed) seeds.add(seed);
    }
  }
  return [...seeds];
}

export function componentRootPrefix(area: AutonomyComponentArea): string {
  const normalized = normalizeAutonomyComponentArea(area);
  if (!normalized) return "";
  return `${normalized}/`;
}

export function containsGlobMeta(value: string): boolean {
  return GLOB_META_RE.test(value);
}

export function normalizeRepoRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (!path) return null;
  path = path.normalize("NFC").replace(/\\/g, "/");
  if (path.startsWith("/")) return null;
  if (DRIVE_RE.test(path)) return null;
  path = path.replace(SLASH_RE, "/");

  const out: string[] = [];
  for (const rawSegment of path.split("/")) {
    const segment = rawSegment.trim();
    if (!segment || segment === ".") continue;
    if (segment === "..") return null;
    out.push(segment);
  }
  if (out.length === 0) return null;
  return out.join("/");
}

export function normalizeTargetPath(value: unknown): string | null {
  const normalized = normalizeRepoRelativePath(value);
  if (!normalized) return null;
  if (PATH_META_RE.test(normalized)) return null;
  return normalized;
}

export function isSupportedGlobSyntax(glob: string): boolean {
  if (!glob) return false;
  if (glob.includes("\\")) return false;
  if (/[{}\[\]()!]/.test(glob)) return false;
  const segments = glob.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".") return false;
    if (segment === "..") return false;
    const idx = segment.indexOf("**");
    if (idx >= 0 && segment !== "**") return false;
  }
  return true;
}

export function normalizeWriteGlob(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let glob = value.trim();
  if (!glob) return null;
  glob = glob.normalize("NFC").replace(/\\/g, "/");
  if (glob.startsWith("/")) return null;
  if (DRIVE_RE.test(glob)) return null;
  while (glob.startsWith("./")) glob = glob.slice(2);
  glob = glob.replace(SLASH_RE, "/").replace(/\/+$/, "");
  if (!glob) return null;
  if (!isSupportedGlobSyntax(glob)) return null;
  return glob;
}

export function literalPrefix(glob: string): string {
  const segments = glob.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "**" || segment.includes("*") || segment.includes("?")) break;
    out.push(segment);
  }
  return out.join("/");
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesSegment(pathSegment: string, globSegment: string): boolean {
  const regexSource = `^${escapeRegex(globSegment).replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`;
  return new RegExp(regexSource).test(pathSegment);
}

export function matchesGlob(path: string, glob: string): boolean {
  const pathSegs = path.split("/");
  const globSegs = glob.split("/");

  const walk = (pi: number, gi: number): boolean => {
    if (gi >= globSegs.length) return pi >= pathSegs.length;
    const g = globSegs[gi];
    if (g === "**") {
      if (gi === globSegs.length - 1) return true;
      for (let k = pi; k <= pathSegs.length; k++) {
        if (walk(k, gi + 1)) return true;
      }
      return false;
    }
    if (pi >= pathSegs.length) return false;
    if (!matchesSegment(pathSegs[pi], g)) return false;
    return walk(pi + 1, gi + 1);
  };

  return walk(0, 0);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function normalizePenalties(values: AutonomyPenalty[]): AutonomyPenalty[] {
  const map = new Map<string, AutonomyPenalty>();
  for (const value of values) {
    const reason = String(value.reason ?? "").trim();
    const kind = value.kind;
    if (!kind || !reason) continue;
    const key = `${kind}\u241f${reason}`;
    if (map.has(key)) continue;
    map.set(key, {
      kind,
      reason,
      weight: clamp01(Number(value.weight)),
      evidence_ids: Array.isArray(value.evidence_ids)
        ? value.evidence_ids
            .map((entry) => String(entry ?? "").trim())
            .filter(Boolean)
            .slice(0, 24)
        : [],
    });
  }
  return [...map.values()].sort((a, b) => {
    if (a.kind === b.kind) return a.reason.localeCompare(b.reason);
    return a.kind.localeCompare(b.kind);
  });
}

export function penaltyTotal(values: AutonomyPenalty[]): number {
  return normalizePenalties(values).reduce((sum, value) => sum + clamp01(value.weight), 0);
}

export function globBreadthScore(glob: string): number {
  const hasGlobStar = glob.includes("**") ? 1 : 0;
  const wildcardCount = (glob.match(/[\*\?]/g) ?? []).length;
  const rootWide = /^[\*]/.test(glob) || glob.startsWith("**/") ? 1 : 0;
  const literalSegments = glob
    .split("/")
    .filter(
      (segment) => segment.length > 0 && !segment.includes("*") && !segment.includes("?"),
    ).length;
  const shallowPenalty = Math.max(0, 2 - Math.min(literalSegments, 2));
  return 4 * hasGlobStar + 2 * rootWide + Math.min(4, wildcardCount) + shallowPenalty;
}

export function classifyGlobBreadth(writeGlobs: string[]): AutonomyGlobBreadth {
  const scores = writeGlobs.map(globBreadthScore);
  const total = scores.reduce((sum, score) => sum + score, 0);
  const max = Math.max(...scores, 0);
  if (max <= 3 && total <= 6 && writeGlobs.length <= 3) return "narrow";
  if (max <= 6 && total <= 12 && writeGlobs.length <= 5) return "medium";
  return "broad";
}

function underRoot(path: string, rootPrefix: string): boolean {
  if (path.startsWith(rootPrefix)) return true;
  return rootPrefix.endsWith("/") && path === rootPrefix.slice(0, -1);
}

function hasForbiddenBroadGlob(glob: string): boolean {
  if (glob === "." || glob === "**") return true;
  if (glob === "*" || glob === "*/**") return true;
  if (glob === "**/*" || glob === "**/**") return true;
  return false;
}

export function validateScopeInvariants(
  componentArea: AutonomyComponentArea | null | undefined,
  targetPathsInput: unknown[],
  writeGlobsInput: unknown[],
  options?: { requireWriteGlobs?: boolean; allowMultipleComponentRoots?: boolean },
): ScopeValidationResult {
  const errors: string[] = [];
  const scopeSeeds = collectScopeSeedPaths(targetPathsInput, writeGlobsInput);
  const normalizedComponentArea =
    normalizeAutonomyComponentArea(componentArea) ??
    deriveAutonomyComponentArea(targetPathsInput, writeGlobsInput);
  const allowMultipleComponentRoots = options?.allowMultipleComponentRoots === true;
  if (!normalizedComponentArea && scopeSeeds.length > 1 && !allowMultipleComponentRoots) {
    errors.push(
      `scope spans multiple component roots: ${scopeSeeds.slice(0, 6).join(", ")}`,
    );
  }
  const rootPrefix = normalizedComponentArea ? componentRootPrefix(normalizedComponentArea) : "";
  const normalizedTargetPaths: string[] = [];
  const targetSeen = new Set<string>();
  for (const raw of targetPathsInput) {
    const normalized = normalizeTargetPath(raw);
    if (!normalized) {
      errors.push(`invalid target_path: ${String(raw ?? "")}`);
      continue;
    }
    if (rootPrefix && !underRoot(normalized, rootPrefix)) {
      errors.push(`target_path outside component root: ${normalized}`);
      continue;
    }
    if (targetSeen.has(normalized)) continue;
    targetSeen.add(normalized);
    normalizedTargetPaths.push(normalized);
  }
  normalizedTargetPaths.sort();
  if (normalizedTargetPaths.length === 0) {
    errors.push("target_paths must contain at least one literal path");
  }

  const normalizedWriteGlobs: string[] = [];
  const writeSeen = new Set<string>();
  for (const raw of writeGlobsInput) {
    const normalized = normalizeWriteGlob(raw);
    if (!normalized) {
      errors.push(`invalid write_glob: ${String(raw ?? "")}`);
      continue;
    }
    if (hasForbiddenBroadGlob(normalized)) {
      errors.push(`forbidden broad write_glob: ${normalized}`);
      continue;
    }
    const prefix = literalPrefix(normalized);
    if (!prefix) {
      errors.push(`write_glob literal prefix cannot be empty: ${normalized}`);
      continue;
    }
    if (rootPrefix && !underRoot(prefix, rootPrefix)) {
      errors.push(`write_glob outside component root: ${normalized}`);
      continue;
    }
    if (
      !normalizedTargetPaths.some(
        (targetPath) => targetPath === prefix || targetPath.startsWith(`${prefix}/`),
      )
    ) {
      errors.push(`write_glob prefix does not align with target_paths: ${normalized}`);
      continue;
    }
    if (writeSeen.has(normalized)) continue;
    writeSeen.add(normalized);
    normalizedWriteGlobs.push(normalized);
  }
  normalizedWriteGlobs.sort();

  if ((options?.requireWriteGlobs ?? true) && normalizedWriteGlobs.length === 0) {
    errors.push("write_globs must be provided and non-empty");
  }

  if (normalizedTargetPaths.length > 0 && normalizedWriteGlobs.length > 0) {
    for (const targetPath of normalizedTargetPaths) {
      const covered = normalizedWriteGlobs.some((glob) => matchesGlob(targetPath, glob));
      if (!covered) errors.push(`target_path not covered by write_globs: ${targetPath}`);
    }
  }
  if (!normalizedComponentArea && !allowMultipleComponentRoots) {
    errors.push("component_area could not be derived from scope");
  }

  const breadth = classifyGlobBreadth(normalizedWriteGlobs);
  return {
    ok: errors.length === 0,
    componentArea: normalizedComponentArea,
    normalizedTargetPaths,
    normalizedWriteGlobs,
    breadth,
    errors,
  };
}

export function makePatternKey(
  objectiveType: string,
  targetPaths: string[],
  triggerType: string,
  componentArea: string,
): string {
  const normalizedTargets = [...targetPaths]
    .map((entry) => normalizeTargetPath(entry))
    .filter((entry): entry is string => Boolean(entry))
    .filter((entry, index, array) => array.indexOf(entry) === index)
    .sort();
  const payload = [
    String(objectiveType ?? "").trim(),
    normalizedTargets.join(","),
    String(triggerType ?? "").trim(),
    String(componentArea ?? "").trim(),
  ].join("|");
  const digest = createHash("sha256").update(payload).digest("hex");
  return `pk_${digest}`;
}
