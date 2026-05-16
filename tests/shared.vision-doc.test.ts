import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  extractVisionKeyItems,
  normalizeVisionSectionRefs,
  parseVisionDoc,
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
    expect(validation.sectionCount).toBeGreaterThan(0);
    expect(validation.hasOneSentence).toBe(true);
  });

  test("validateVisionDocStructure allows flexible section numbering", () => {
    const markdown = [
      "# Vision",
      "> **One sentence:** Keep this short.",
      "",
      "## 0) Custom Section",
      "Custom content.",
      "",
      "## 42) Another Section",
      "More content.",
    ].join("\n");
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(true);
    expect(validation.sectionCount).toBe(2);
    expect(validation.missingSectionNumbers).toEqual([]);
  });

  test("normalizeVisionSectionRefs normalizes and filters references", () => {
    const allowed = new Set(["1", "3", "10"]);
    const refs = normalizeVisionSectionRefs(["01", "section 3", "10)", "9", "3"], allowed);
    expect(refs).toEqual(["1", "3", "10"]);
  });

  test("extractVisionKeyItems maps key bullets from template sections", () => {
    const markdown = readFileSync(join(repoRoot, "vision.example.md"), "utf8");
    const items = extractVisionKeyItems(markdown);
    expect(items.priorities.length).toBeGreaterThan(0);
    expect(items.objectives.length).toBeGreaterThan(0);
    expect(items.guardrails.length).toBeGreaterThan(0);
    expect(items.constraints.length).toBeGreaterThan(0);
    expect(items.testingCriteria.length).toBeGreaterThan(0);
  });

  test("extractVisionKeyItems captures PushPals-specific priorities and guardrails", () => {
    const markdown = readFileSync(join(repoRoot, "vision.md"), "utf8");
    const items = extractVisionKeyItems(markdown);
    expect(items.priorities.length).toBeGreaterThan(0);
    expect(items.objectives.length).toBeGreaterThan(0);
    expect(items.nonGoals.length).toBeGreaterThan(0);
    expect(items.guardrails.length).toBeGreaterThan(0);
    expect(items.riskPolicy.length).toBeGreaterThan(0);
  });

  test("extractVisionKeyItems captures testing criteria as its own bucket", () => {
    const markdown = [
      "# Vision",
      "> **One sentence:** Keep required validation visible.",
      "",
      "## 8) Metrics",
      "- Test pass rate improves",
      "",
      "## 12) Testing criteria",
      "- `bun run test:root`",
      "- `bun run smoke:web`",
      "",
      "## 13) Risk policy",
      "- Validation failures block release",
    ].join("\n");
    const items = extractVisionKeyItems(markdown);
    expect(items.testingCriteria).toEqual(["`bun run test:root`", "`bun run smoke:web`"]);
    expect(items.metrics).toEqual(["Test pass rate improves"]);
    expect(items.riskPolicy).toEqual(["Validation failures block release"]);
  });
});
