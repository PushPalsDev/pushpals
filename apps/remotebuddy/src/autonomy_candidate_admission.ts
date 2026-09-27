/** Pure structural admission; callers retain all scope and current eligibility gates. */
export type AutonomyInternalWorkCandidate = {
  title?: unknown;
  problem_statement?: unknown;
  vision_alignment_reason?: unknown;
  feature_hypotheses?: unknown;
  target_paths?: unknown;
  component_area?: unknown;
};

export type AutonomyAdmissionRepository = {
  identity: string;
  revision: string;
  tree: string;
};

export type AutonomyInternalWorkProvenance = {
  /** A host-established repository identity, never a model-supplied ownership hint. */
  allowInternalRepository?: boolean;
  currentRepository?: AutonomyAdmissionRepository;
  evidenceRepository?: AutonomyAdmissionRepository;
  /** Only evidence whose excerpts and coordinates the host has already verified. */
  evidence?: readonly {
    path: string;
    revision: string;
    blobHash?: string;
    startLine?: number;
    endLine?: number;
    excerpt?: string;
  }[];
  /** Current host-verified target coordinates; do not construct these from raw model output. */
  verifiedTargetPaths?: readonly { path: string; blobHash: string }[];
};

export type AutonomyInternalWorkAdmission = {
  ok: boolean;
  reason: "pushpals_internal_leak" | null;
  groundedQuotedSource: boolean;
  /** Safe planning text; only admitted, verified observation quotations may differ. */
  repositoryNativeProblemStatement: string;
};

const INTERNAL_TEXT_PATTERNS = [
  /\b(workerpals?|remotebuddy|localbuddy|pushpals?)\b/i,
  /\bartifact[_-]?only[_-]?no[_-]?publishable[_-]?patch\b/i,
  /\bno[-_\s]?reviewable[-_\s]?patch\b/i,
  /\bno[-_\s]?publishable[-_\s]?(?:patch|changes?|progress)\b/i,
  /\bautonomy[-_\s]?internal\b/i,
];

export function containsPushPalsInternalUserRepoText(text: string): boolean {
  return INTERNAL_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const blobOid = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);

function relativePath(value: string): string | null {
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || /[\0\r\n]/.test(path)) return null;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return path;
}

function sameRepository(provenance: AutonomyInternalWorkProvenance): boolean {
  const current = provenance.currentRepository;
  const evidence = provenance.evidenceRepository;
  return Boolean(
    current &&
    evidence &&
    current.identity.trim() &&
    current.revision.trim() &&
    current.tree.trim() &&
    current.identity === evidence.identity &&
    current.revision === evidence.revision &&
    current.tree === evidence.tree,
  );
}

function quotedStrings(value: string): Array<{ value: string; index: number; length: number }> {
  const pattern =
    /"([^"\r\n]{1,512})"|'([^'\r\n]{1,512})'|`([^`\r\n]{1,512})`|“([^”\r\n]{1,512})”|‘([^’\r\n]{1,512})’/g;
  return [...value.matchAll(pattern)].slice(0, 64).map((match) => ({
    value: match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "",
    index: match.index ?? 0,
    length: match[0].length,
  }));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A quoted contamination already present in a target file is evidence of a
 * product-naming defect, not a request to implement orchestration internals.
 * This exception is deliberately narrower than allowing an internal word
 * anywhere in a candidate merely because some repository file contains it.
 */
function maskGroundedSourceQuotations(
  candidate: AutonomyInternalWorkCandidate,
  provenance: AutonomyInternalWorkProvenance,
): { problem: string; masked: boolean } {
  const problem = text(candidate.problem_statement);
  const title = text(candidate.title);
  if (
    problem.length > 32_000 ||
    !sameRepository(provenance) ||
    !/\b(correct|fix|repair|replace|remove|rename|eliminate|align|update|clean\s*up)\b/i.test(
      title,
    ) ||
    !/\b(name|names|naming|label|labels|landmark|brand|branding|text|string|literal|copy)\b/i.test(
      title,
    )
  ) {
    return { problem, masked: false };
  }

  const targets = new Set(strings(candidate.target_paths).map(relativePath).filter(Boolean));
  const currentBlobs = new Map(
    (provenance.verifiedTargetPaths ?? []).slice(0, 128).flatMap((entry) => {
      const path = relativePath(entry.path);
      return path && targets.has(path) && blobOid(entry.blobHash)
        ? [[path, entry.blobHash] as const]
        : [];
    }),
  );
  const sources = (provenance.evidence ?? []).slice(0, 64).flatMap((entry) => {
    const path = relativePath(entry.path);
    if (
      !path ||
      !targets.has(path) ||
      entry.revision !== provenance.currentRepository!.revision ||
      !blobOid(entry.blobHash) ||
      currentBlobs.get(path) !== entry.blobHash ||
      !entry.excerpt ||
      entry.excerpt.length > 4_000 ||
      !Number.isInteger(entry.startLine) ||
      entry.startLine! < 1 ||
      (entry.endLine !== undefined &&
        (!Number.isInteger(entry.endLine) || entry.endLine < entry.startLine!))
    ) {
      return [];
    }
    // Only an observation attributed to this exact source path can consume
    // its quotation. Imperatives such as "replace with 'WorkerPal...'" cannot.
    const observation = new RegExp(
      `(?:^|[.!?;\\n]\\s*|,\\s*(?:and\\s+)?)` +
        `\x60?${escapeRegex(path)}\x60?(?::([1-9]\\d*)(?:-([1-9]\\d*))?)?\\s+` +
        `(?:(?:currently|still)\\s+)?(?:exports?|declares?|contains?|defines?|uses?|reads?)\\s+` +
        `(?:(?:the|a|an|shared|user-visible|constant|string|literal|value|label|as|named)\\s+){0,6}$`,
    );
    return [
      {
        observation,
        startLine: entry.startLine!,
        endLine: entry.endLine ?? entry.startLine!,
        literals: new Set(quotedStrings(entry.excerpt).map((quote) => quote.value)),
      },
    ];
  });

  let output = "";
  let copiedThrough = 0;
  let masked = false;
  for (const quote of quotedStrings(problem)) {
    if (!containsPushPalsInternalUserRepoText(quote.value)) continue;
    const prefix = problem.slice(Math.max(0, quote.index - 1_000), quote.index);
    const grounded = sources.some((source) => {
      if (!source.literals.has(quote.value)) return false;
      const match = source.observation.exec(prefix);
      if (!match) return false;
      if (!match[1]) return true;
      const startLine = Number(match[1]);
      const endLine = Number(match[2] ?? match[1]);
      return startLine >= source.startLine && endLine >= startLine && endLine <= source.endLine;
    });
    if (!grounded) continue;
    output +=
      problem.slice(copiedThrough, quote.index) + "[existing source literal; see cited location]";
    copiedThrough = quote.index + quote.length;
    masked = true;
  }
  return { problem: output + problem.slice(copiedThrough), masked };
}

export function evaluateAutonomyInternalWork(
  candidate: AutonomyInternalWorkCandidate,
  provenance: AutonomyInternalWorkProvenance = {},
): AutonomyInternalWorkAdmission {
  if (provenance.allowInternalRepository === true) {
    return {
      ok: true,
      reason: null,
      groundedQuotedSource: false,
      repositoryNativeProblemStatement: text(candidate.problem_statement),
    };
  }
  const grounded = maskGroundedSourceQuotations(candidate, provenance);
  const publicText = [
    text(candidate.title),
    grounded.problem,
    text(candidate.vision_alignment_reason),
    ...strings(candidate.feature_hypotheses),
    ...strings(candidate.target_paths),
    text(candidate.component_area),
  ].join("\n");
  const rejected = containsPushPalsInternalUserRepoText(publicText);
  return {
    ok: !rejected,
    reason: rejected ? "pushpals_internal_leak" : null,
    groundedQuotedSource: !rejected && grounded.masked,
    repositoryNativeProblemStatement: rejected
      ? text(candidate.problem_statement)
      : grounded.problem,
  };
}
