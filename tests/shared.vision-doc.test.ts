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
      "---",
      "title: Recovery vision",
      "---",
      "",
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
    const allowed = new Set(["0", "1", "3", "10"]);
    const refs = normalizeVisionSectionRefs(
      ["section 0", "01", "section 3", "10)", "9", "3"],
      allowed,
    );
    expect(refs).toEqual(["0", "1", "3", "10"]);
  });

  test("parses ordinary unnumbered vision headings and plain-language summaries", () => {
    const markdown = [
      "---",
      "title: Recovery vision",
      "---",
      "",
      "<!--",
      "This commented sentence must not become the vision summary.",
      "## Commented priorities",
      "- Ship commented behavior",
      "-->",
      "",
      "```markdown",
      "## Example goals",
      "- Ship sample-only behavior",
      "```",
      "",
      "# Vision",
      "Help operations teams recover interrupted imports without duplicate work.",
      "",
      "## Goals",
      "- Recover interrupted imports safely",
      "- Keep progress visible",
      "",
      "## User experience priorities",
      "- Improve recovery before adding new import formats",
      "",
      "### Design notes",
      "Nested headings stay inside their parent section.",
      "",
      "## Success criteria",
      "- Recovery completes without duplicate writes",
    ].join("\n");

    const parsed = parseVisionDoc(markdown);
    const items = extractVisionKeyItems(markdown);
    expect(parsed.oneSentence).toBe(
      "Help operations teams recover interrupted imports without duplicate work.",
    );
    expect(parsed.sections.map((section) => section.title)).toEqual([
      "Goals",
      "User experience priorities",
      "Success criteria",
    ]);
    expect(items.objectives).toContain("Recover interrupted imports safely");
    expect(items.priorities).toContain("Improve recovery before adding new import formats");
    expect(items.metrics).toContain("Recovery completes without duplicate writes");
    expect(items.priorities).not.toContain("Ship commented behavior");
    expect(items.objectives).not.toContain("Ship sample-only behavior");
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
