import { resolveRepoDocPath } from "./prompts.js";

const SECTION_HEADING_RE = /^##\s+(\d+)\)\s+(.+?)\s*$/;
const SECTION_REFERENCE_NUMERIC_RE = /^\s*(\d+)\s*$/;
const SECTION_REFERENCE_PARENS_RE = /^\s*(\d+)\)\s*$/;
const SECTION_REFERENCE_MATCHERS = [SECTION_REFERENCE_NUMERIC_RE, SECTION_REFERENCE_PARENS_RE];
const TOP_LEVEL_HEADING_PREFIX_RE = /^##(?!#)/;
const ANY_HEADING_RE = /^##+\s+(.+?)\s*$/;
const ONE_SENTENCE_PROMPT_RE = /^\>\s*\*\*One sentence:\*\*\s*(.+)\s*$/i;
const BLOCKQUOTE_RE = /^\>\s*(.+?)\s*$/;
const BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;

export type VisionSection = {
  number: string;
  title: string;
  markdown: string;
};

export type ParsedVisionDoc = {
  oneSentence: string;
  sections: VisionSection[];
  sectionByNumber: Record<string, VisionSection>;
};

export type VisionKeyItems = {
  targetUsers: string[];
  priorities: string[];
  objectives: string[];
  guardrails: string[];
  constraints: string[];
  nonGoals: string[];
  metrics: string[];
  riskPolicy: string[];
  operatingModel: string[];
  governance: string[];
};

export type VisionDocValidation = {
  ok: boolean;
  sectionCount: number;
  hasOneSentence: boolean;
  missingSectionNumbers: string[];
  errors: string[];
};

const MAX_KEY_ITEMS_PER_BUCKET = 8;
const DEFAULT_VISION_DOC_PATH = "vision.md";

type VisionSectionRule = {
  number: string;
  label: string;
  optional?: boolean;
};

const VISION_SECTION_RULES: VisionSectionRule[] = [
  { number: "0", label: "Operating model", optional: true },
  { number: "1", label: "Who this is for" },
  { number: "2", label: "The problem we solve" },
  { number: "3", label: "Product principles" },
  { number: "4", label: 'What "good" looks like' },
  { number: "5", label: "Scope and boundaries" },
  { number: "6", label: "Current priorities" },
  { number: "7", label: "Near-term objectives" },
  { number: "8", label: "Long-term direction" },
  { number: "9", label: "Guardrails and constraints" },
  { number: "10", label: "How decisions get made" },
];

const REQUIRED_VISION_SECTION_NUMBERS = VISION_SECTION_RULES.filter((rule) => !rule.optional).map(
  (rule) => rule.number,
);
const VISION_SECTION_RULE_MAP = new Map(
  VISION_SECTION_RULES.map((rule) => [rule.number, rule] as const),
);

type SectionHeadingParts = {
  rawNumber: string;
  title: string;
};

type SectionNumberOptions = {
  allowZero?: boolean;
};

type MarkdownHeadingState = {
  inCodeFence: boolean;
  fenceChar: string;
  fenceLength: number;
  inHtmlComment: boolean;
};

function createMarkdownHeadingState(): MarkdownHeadingState {
  return {
    inCodeFence: false,
    fenceChar: "",
    fenceLength: 0,
    inHtmlComment: false,
  };
}

function stripHtmlComments(line: string, state: MarkdownHeadingState): string {
  const text = String(line ?? "");
  if (!state.inHtmlComment && !text.includes("<!--")) {
    return text;
  }

  let result = "";
  let idx = 0;
  while (idx < text.length) {
    if (state.inHtmlComment) {
      const commentEnd = text.indexOf("-->", idx);
      if (commentEnd === -1) {
        idx = text.length;
        break;
      }
      state.inHtmlComment = false;
      idx = commentEnd + 3;
      continue;
    }
    const commentStart = text.indexOf("<!--", idx);
    if (commentStart === -1) {
      result += text.slice(idx);
      break;
    }
    result += text.slice(idx, commentStart);
    idx = commentStart + 4;
    state.inHtmlComment = true;
  }
  return result;
}

function isFenceDelimiter(line: string, fenceChar: string, fenceLength: number): boolean {
  if (!fenceChar || fenceLength <= 0) return false;
  const normalized = line.replace(/^\s{0,3}/, "");
  if (!normalized) return false;
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i] !== fenceChar) {
      return false;
    }
  }
  return normalized.length >= fenceLength;
}

function shouldSkipHeadingDetection(line: string, state: MarkdownHeadingState): {
  candidate: string;
  skip: boolean;
} {
  const raw = String(line ?? "");
  const trimmedRaw = raw.trim();

  if (state.inCodeFence) {
    if (isFenceDelimiter(trimmedRaw, state.fenceChar, state.fenceLength)) {
      state.inCodeFence = false;
      state.fenceChar = "";
      state.fenceLength = 0;
    }
    return { candidate: "", skip: true };
  }

  const withoutComments = stripHtmlComments(raw, state);
  const trimmed = withoutComments.trim();

  const fenceMatch = trimmed.match(/^\s{0,3}(```+|~~~+)/);
  if (fenceMatch) {
    state.inCodeFence = true;
    state.fenceChar = fenceMatch[1][0];
    state.fenceLength = fenceMatch[1].length;
    return { candidate: "", skip: true };
  }

  const skipDueToComment = state.inHtmlComment && !trimmed;
  return { candidate: trimmed, skip: skipDueToComment };
}

function canonicalizeSectionNumber(rawNumber: string, opts?: SectionNumberOptions): string {
  const numericText = String(rawNumber ?? "").trim();
  if (!numericText) return "";
  const numericValue = Number.parseInt(numericText, 10);
  if (!Number.isFinite(numericValue)) return "";
  if (numericValue < 0) return "";
  if (numericValue === 0 && !opts?.allowZero) return "";
  return String(numericValue);
}

function parseSectionHeading(line: string): SectionHeadingParts | null {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return null;
  const match = trimmed.match(SECTION_HEADING_RE);
  if (!match) return null;
  const title = match[2].trim();
  if (!title) return null;
  return { rawNumber: match[1], title };
}

function normalizeSectionRefValue(value: string, opts?: SectionNumberOptions): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const heading = parseSectionHeading(text);
  if (heading) {
    return canonicalizeSectionNumber(heading.rawNumber, opts);
  }
  for (const pattern of SECTION_REFERENCE_MATCHERS) {
    const match = text.match(pattern);
    if (match) {
      return canonicalizeSectionNumber(match[1], opts);
    }
  }
  return "";
}

function toLines(markdown: string): string[] {
  return String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
}

function extractOneSentence(lines: string[]): string {
  let expectNextBlockquoteSentence = false;
  for (const line of lines) {
    const marker = line.match(ONE_SENTENCE_PROMPT_RE);
    if (marker) {
      const inline = marker[1].trim();
      if (inline) return inline;
      expectNextBlockquoteSentence = true;
      continue;
    }
    const block = line.match(BLOCKQUOTE_RE);
    if (expectNextBlockquoteSentence) {
      if (!block) continue;
      const text = block[1].trim();
      if (!text) continue;
      if (/^Example:/i.test(text)) continue;
      return text;
    }
  }
  for (const line of lines) {
    const block = line.match(BLOCKQUOTE_RE);
    if (!block) continue;
    const text = block[1].trim();
    if (!text) continue;
    if (/^\*\*One sentence:\*\*/i.test(text)) continue;
    if (/^Example:/i.test(text)) continue;
    return text;
  }
  return "";
}

function normalizeItem(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function dedupeAndClamp(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = normalizeItem(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_KEY_ITEMS_PER_BUCKET) break;
  }
  return out;
}

function classifyHeadingBucket(heading: string): keyof VisionKeyItems | null {
  const text = heading.toLowerCase();
  if (text.includes("who this is for") || text.includes("user")) return "targetUsers";
  if (text.includes("priorit")) return "priorities";
  if (text.includes("objective")) return "objectives";
  if (text.includes("principle") || text.includes("guardrail")) return "guardrails";
  if (text.includes("constraint")) return "constraints";
  if (text.includes("non-goal") || text.includes("out of scope") || text.includes("not ")) {
    return "nonGoals";
  }
  if (text.includes("measure") || text.includes("metric") || text.includes("good looks like")) {
    return "metrics";
  }
  if (text.includes("risk") || text.includes("gate")) return "riskPolicy";
  if (text.includes("operating model") || text.includes("role")) return "operatingModel";
  if (text.includes("decision") || text.includes("governance")) return "governance";
  return null;
}

type NormalizeVisionSectionRefOptions = {
  allowZero?: boolean;
};

export function normalizeVisionSectionRef(
  value: string,
  opts?: NormalizeVisionSectionRefOptions,
): string {
  return normalizeSectionRefValue(value, opts);
}

type NormalizeVisionSectionRefsOptions = {
  allowZero?: boolean;
};

export function normalizeVisionSectionRefs(
  values: string[],
  allowedSectionNumbers?: ReadonlySet<string>,
  opts?: NormalizeVisionSectionRefsOptions,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const allowZero = opts?.allowZero ?? (allowedSectionNumbers?.has("0") ?? false);
  for (const value of values) {
    const normalized = normalizeVisionSectionRef(value, { allowZero });
    if (!normalized) continue;
    if (allowedSectionNumbers && !allowedSectionNumbers.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

type ResolveVisionDocPathOptions = {
  allowAbsolutePath?: boolean;
};

export function resolveVisionDocPath(
  pathValue?: string,
  opts?: ResolveVisionDocPathOptions,
): string {
  const candidate = String(pathValue ?? "").trim() || DEFAULT_VISION_DOC_PATH;
  return resolveRepoDocPath(candidate, {
    allowAbsolutePath: opts?.allowAbsolutePath ?? true,
  });
}

export function parseVisionDoc(markdown: string): ParsedVisionDoc {
  const lines = toLines(markdown);
  const sections: VisionSection[] = [];
  let currentNumber = "";
  let currentTitle = "";
  let currentBody: string[] = [];
  const headingState = createMarkdownHeadingState();

  const flushCurrent = (): void => {
    if (!currentNumber) return;
    sections.push({
      number: currentNumber,
      title: currentTitle,
      markdown: currentBody.join("\n").trim(),
    });
    currentNumber = "";
    currentTitle = "";
    currentBody = [];
  };

  for (const line of lines) {
    const { candidate, skip } = shouldSkipHeadingDetection(line, headingState);
    const heading = skip ? null : parseSectionHeading(candidate);
    if (heading) {
      flushCurrent();
      const normalizedNumber = canonicalizeSectionNumber(heading.rawNumber, { allowZero: true });
      if (!normalizedNumber) continue;
      currentNumber = normalizedNumber;
      currentTitle = heading.title;
      continue;
    }
    if (currentNumber) {
      currentBody.push(line);
    }
  }
  flushCurrent();

  const sectionByNumber: Record<string, VisionSection> = {};
  for (const section of sections) {
    if (!sectionByNumber[section.number]) {
      sectionByNumber[section.number] = section;
    }
  }

  return {
    oneSentence: extractOneSentence(lines),
    sections,
    sectionByNumber,
  };
}

export function extractVisionKeyItems(markdown: string): VisionKeyItems {
  const lines = toLines(markdown);
  const buckets: VisionKeyItems = {
    targetUsers: [],
    priorities: [],
    objectives: [],
    guardrails: [],
    constraints: [],
    nonGoals: [],
    metrics: [],
    riskPolicy: [],
    operatingModel: [],
    governance: [],
  };

  let activeBucket: keyof VisionKeyItems | null = null;
  for (const line of lines) {
    const heading = line.match(ANY_HEADING_RE);
    if (heading) {
      activeBucket = classifyHeadingBucket(heading[1]);
      continue;
    }

    const bullet = line.match(BULLET_RE);
    if (!bullet) continue;
    if (!activeBucket) continue;
    buckets[activeBucket].push(bullet[1]);
  }

  return {
    targetUsers: dedupeAndClamp(buckets.targetUsers),
    priorities: dedupeAndClamp(buckets.priorities),
    objectives: dedupeAndClamp(buckets.objectives),
    guardrails: dedupeAndClamp(buckets.guardrails),
    constraints: dedupeAndClamp(buckets.constraints),
    nonGoals: dedupeAndClamp(buckets.nonGoals),
    metrics: dedupeAndClamp(buckets.metrics),
    riskPolicy: dedupeAndClamp(buckets.riskPolicy),
    operatingModel: dedupeAndClamp(buckets.operatingModel),
    governance: dedupeAndClamp(buckets.governance),
  };
}

export function validateVisionDocStructure(markdown: string): VisionDocValidation {
  const lines = toLines(markdown);
  const parsed = parseVisionDoc(markdown);
  const missingSectionNumbers: string[] = [];
  const errors: string[] = [];
  const seenNumbers = new Set<string>();
  const titlesByNumber = new Map<string, string>();
  const expectedSectionsDescription = VISION_SECTION_RULES.map(
    (rule) => `${rule.number}${rule.optional ? " (optional)" : ""}`,
  ).join(", ");
  const headingState = createMarkdownHeadingState();

  for (const rawLine of lines) {
    const originalTrimmed = rawLine.trim();
    const { candidate, skip } = shouldSkipHeadingDetection(rawLine, headingState);
    if (skip) continue;
    if (!candidate) continue;
    if (!TOP_LEVEL_HEADING_PREFIX_RE.test(candidate)) continue;
    if (candidate.startsWith("###")) continue;
    if (parseSectionHeading(candidate)) continue;
    const display = originalTrimmed || candidate;
    errors.push(
      `Malformed top-level section heading "${display}": expected format "## N) Title" (example: "## 3) Product principles").`,
    );
  }

  for (const section of parsed.sections) {
    if (seenNumbers.has(section.number)) {
      const firstTitle = titlesByNumber.get(section.number);
      const detail = firstTitle ? ` (first heading "${firstTitle}")` : "";
      errors.push(`Duplicate section number ${section.number}) "${section.title}"${detail}.`);
      continue;
    }
    seenNumbers.add(section.number);
    titlesByNumber.set(section.number, section.title);

    const rule = VISION_SECTION_RULE_MAP.get(section.number);
    if (!rule) {
      errors.push(
        `Unexpected section number ${section.number}) "${section.title}". Expected sections: ${expectedSectionsDescription}.`,
      );
    }
  }

  for (const number of REQUIRED_VISION_SECTION_NUMBERS) {
    if (!seenNumbers.has(number)) {
      missingSectionNumbers.push(number);
      const label = VISION_SECTION_RULE_MAP.get(number)?.label ?? "";
      const labelSuffix = label ? ` (${label})` : "";
      errors.push(`Missing required section ${number})${labelSuffix}.`);
    }
  }

  if (!parsed.oneSentence) {
    errors.push(
      'Missing one-sentence vision line (expected near the top as a blockquote after "**One sentence:**").',
    );
  }

  return {
    ok: errors.length === 0,
    sectionCount: parsed.sections.length,
    hasOneSentence: Boolean(parsed.oneSentence),
    missingSectionNumbers,
    errors,
  };
}
