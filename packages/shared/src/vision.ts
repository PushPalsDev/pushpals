const SECTION_HEADING_RE = /^##\s+(\d+)\)\s+(.+?)\s*$/;
const ONE_SENTENCE_PROMPT_RE = /^\>\s*\*\*One sentence:\*\*\s*(.+)\s*$/i;
const BLOCKQUOTE_RE = /^\>\s*(.+?)\s*$/;

export const REQUIRED_VISION_SECTION_NUMBERS = Object.freeze([
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
]);

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

export type VisionDocValidation = {
  ok: boolean;
  sectionCount: number;
  hasOneSentence: boolean;
  missingSectionNumbers: string[];
  errors: string[];
};

function toLines(markdown: string): string[] {
  return String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
}

function extractOneSentence(lines: string[]): string {
  for (const line of lines) {
    const marker = line.match(ONE_SENTENCE_PROMPT_RE);
    if (marker) return marker[1].trim();
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

export function normalizeVisionSectionRef(value: string): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const match = text.match(/\d+/);
  if (!match) return "";
  const numeric = Number.parseInt(match[0], 10);
  return Number.isFinite(numeric) && numeric > 0 ? String(numeric) : "";
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
  const sections: VisionSection[] = [];
  let currentNumber = "";
  let currentTitle = "";
  let currentBody: string[] = [];

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
    const heading = line.match(SECTION_HEADING_RE);
    if (heading) {
      flushCurrent();
      currentNumber = heading[1];
      currentTitle = heading[2].trim();
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

export function validateVisionDocStructure(markdown: string): VisionDocValidation {
  const parsed = parseVisionDoc(markdown);
  const missingSectionNumbers = REQUIRED_VISION_SECTION_NUMBERS.filter(
    (number) => !parsed.sectionByNumber[number],
  );
  const errors: string[] = [];
  if (!parsed.oneSentence) {
    errors.push(
      'Missing one-sentence vision line (expected near the top as a blockquote after "**One sentence:**").',
    );
  }
  if (missingSectionNumbers.length > 0) {
    errors.push(`Missing required sections: ${missingSectionNumbers.join(", ")}`);
  }
  return {
    ok: errors.length === 0,
    sectionCount: parsed.sections.length,
    hasOneSentence: Boolean(parsed.oneSentence),
    missingSectionNumbers,
    errors,
  };
}
