const SECTION_HEADING_RE = /^##\s+(?:(\d+)[.)]\s*)?(.+?)\s*$/;
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
  testingCriteria: string[];
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

function toLines(markdown: string): string[] {
  return String(markdown ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");
}

function maskNonProseMarkdownLines(lines: string[]): string[] {
  let inFrontmatter = lines[0]?.trim() === "---";
  let inHtmlComment = false;
  let fenceCharacter = "";
  let fenceLength = 0;
  return lines.map((line, index) => {
    const trimmed = line.trim();
    if (inFrontmatter) {
      if (index > 0 && trimmed === "---") inFrontmatter = false;
      return "";
    }

    let visible = line;
    if (inHtmlComment) {
      const commentEnd = visible.indexOf("-->");
      if (commentEnd < 0) return "";
      visible = visible.slice(commentEnd + 3);
      inHtmlComment = false;
    }
    while (visible.includes("<!--")) {
      const commentStart = visible.indexOf("<!--");
      const commentEnd = visible.indexOf("-->", commentStart + 4);
      if (commentEnd < 0) {
        visible = visible.slice(0, commentStart);
        inHtmlComment = true;
        break;
      }
      visible = `${visible.slice(0, commentStart)}${visible.slice(commentEnd + 3)}`;
    }

    const fence = visible.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1];
      if (!fenceCharacter) {
        fenceCharacter = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = "";
        fenceLength = 0;
      }
      return "";
    }
    if (fenceCharacter) return "";
    return visible;
  });
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
  // Repositories commonly use a plain introductory paragraph rather than the
  // PushPals starter template's blockquote marker. Treat the first concise
  // prose line as the summary while ignoring headings, lists, and code fences.
  let inFrontmatter = lines[0]?.trim() === "---";
  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    if (inFrontmatter) {
      if (index > 0 && text === "---") inFrontmatter = false;
      continue;
    }
    if (
      !text ||
      /^(?:---|\*\*\*|___)$/.test(text) ||
      /^#{1,6}\s/.test(text) ||
      BULLET_RE.test(text) ||
      /^```/.test(text) ||
      /^<!--/.test(text) ||
      /^!\[/.test(text) ||
      /^\[!\[/.test(text) ||
      /^\|/.test(text)
    ) {
      continue;
    }
    return text;
  }
  return "";
}

function normalizeItem(value: string): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
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
  if (
    text.includes("priorit") ||
    text.includes("roadmap") ||
    text.includes("focus") ||
    text.includes("strategy") ||
    text.includes("what's next") ||
    text.includes("what is next")
  ) {
    return "priorities";
  }
  if (text.includes("objective") || text.includes("goal") || text.includes("outcome")) {
    return "objectives";
  }
  if (
    text.includes("who this is for") ||
    text.includes("target user") ||
    text.includes("intended user") ||
    text.includes("audience") ||
    text.includes("persona") ||
    /^(?:the\s+)?users?$/.test(text.trim())
  ) {
    return "targetUsers";
  }
  if (text.includes("principle") || text.includes("guardrail")) return "guardrails";
  if (text.includes("constraint")) return "constraints";
  if (text.includes("non-goal") || text.includes("out of scope") || text.includes("not ")) {
    return "nonGoals";
  }
  if (
    text.includes("testing criteria") ||
    text.includes("test criteria") ||
    text.includes("required tests") ||
    text.includes("required validation") ||
    text.includes("validation criteria")
  ) {
    return "testingCriteria";
  }
  if (
    text.includes("measure") ||
    text.includes("metric") ||
    text.includes("success") ||
    text.includes("good looks like")
  ) {
    return "metrics";
  }
  if (text.includes("risk") || text.includes("gate")) return "riskPolicy";
  if (text.includes("operating model") || text.includes("role")) return "operatingModel";
  if (text.includes("decision") || text.includes("governance")) return "governance";
  return null;
}

export function normalizeVisionSectionRef(value: string): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const match = text.match(/\d+/);
  if (!match) return "";
  const numeric = Number.parseInt(match[0], 10);
  return Number.isFinite(numeric) && numeric >= 0 ? String(numeric) : "";
}

export function normalizeVisionSectionRefs(
  values: string[],
  allowedSectionNumbers?: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeVisionSectionRef(value);
    if (!normalized) continue;
    if (allowedSectionNumbers && !allowedSectionNumbers.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function parseVisionDoc(markdown: string): ParsedVisionDoc {
  const lines = toLines(markdown);
  const proseLines = maskNonProseMarkdownLines(lines);
  const sections: VisionSection[] = [];
  let currentNumber = "";
  let currentTitle = "";
  let currentBody: string[] = [];
  const usedSectionNumbers = new Set(
    proseLines.map((line) => line.match(SECTION_HEADING_RE)?.[1] ?? "").filter(Boolean),
  );
  let nextSyntheticSectionNumber = 1;

  const allocateSectionNumber = (explicit: string | undefined): string => {
    if (explicit) {
      return explicit;
    }
    while (usedSectionNumbers.has(String(nextSyntheticSectionNumber))) {
      nextSyntheticSectionNumber += 1;
    }
    const generated = String(nextSyntheticSectionNumber);
    usedSectionNumbers.add(generated);
    nextSyntheticSectionNumber += 1;
    return generated;
  };

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

  for (const [index, line] of proseLines.entries()) {
    const heading = line.match(SECTION_HEADING_RE);
    if (heading) {
      flushCurrent();
      currentNumber = allocateSectionNumber(heading[1]);
      currentTitle = heading[2].trim();
      continue;
    }
    if (currentNumber) {
      currentBody.push(lines[index] ?? "");
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
    oneSentence: extractOneSentence(proseLines),
    sections,
    sectionByNumber,
  };
}

export function extractVisionKeyItems(markdown: string): VisionKeyItems {
  const lines = maskNonProseMarkdownLines(toLines(markdown));
  const buckets: VisionKeyItems = {
    targetUsers: [],
    priorities: [],
    objectives: [],
    guardrails: [],
    constraints: [],
    nonGoals: [],
    metrics: [],
    testingCriteria: [],
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
    testingCriteria: dedupeAndClamp(buckets.testingCriteria),
    riskPolicy: dedupeAndClamp(buckets.riskPolicy),
    operatingModel: dedupeAndClamp(buckets.operatingModel),
    governance: dedupeAndClamp(buckets.governance),
  };
}

export function validateVisionDocStructure(markdown: string): VisionDocValidation {
  const parsed = parseVisionDoc(markdown);
  const missingSectionNumbers: string[] = [];
  const errors: string[] = [];
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
