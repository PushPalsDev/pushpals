import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  normalizeVisionSectionRefs,
  parseVisionDoc,
  REQUIRED_VISION_SECTION_NUMBERS,
  validateVisionDocStructure,
} from "../packages/shared/src/vision";

const repoRoot = process.cwd();

describe("shared vision doc parsing", () => {
  test("parseVisionDoc extracts one-sentence vision and numbered sections", () => {
    const markdown = readFileSync(join(repoRoot, "vision.example.md"), "utf8");
    const parsed = parseVisionDoc(markdown);

    expect(parsed.oneSentence.length).toBeGreaterThan(0);
    expect(parsed.sections.length).toBeGreaterThanOrEqual(10);
    expect(parsed.sectionByNumber["1"]?.title.toLowerCase()).toContain("who this is for");
    expect(parsed.sectionByNumber["10"]?.title.toLowerCase()).toContain("how decisions get made");
  });

  test("validateVisionDocStructure accepts populated vision.md template", () => {
    const markdown = readFileSync(join(repoRoot, "vision.md"), "utf8");
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(true);
    expect(validation.sectionCount).toBeGreaterThanOrEqual(REQUIRED_VISION_SECTION_NUMBERS.length);
    expect(validation.missingSectionNumbers.length).toBe(0);
    expect(validation.hasOneSentence).toBe(true);
  });

  test("validateVisionDocStructure rejects missing required sections", () => {
    const markdown = [
      "# Vision",
      "> **One sentence:** Keep this short.",
      "",
      "## 1) Who this is for",
      "Example content.",
    ].join("\n");
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(false);
    expect(validation.missingSectionNumbers.length).toBeGreaterThan(0);
    expect(validation.missingSectionNumbers).toContain("2");
  });

  test("normalizeVisionSectionRefs normalizes and filters references", () => {
    const allowed = new Set(["1", "3", "10"]);
    const refs = normalizeVisionSectionRefs(["01", "section 3", "10)", "9", "3"], allowed);
    expect(refs).toEqual(["1", "3", "10"]);
  });
});
