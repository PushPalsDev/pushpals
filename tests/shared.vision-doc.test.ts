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

  test.each(["Non-goals", "Non goals", "Out of scope / non-goals", "Not priorities"])(
    "keeps %s and its nested goal headings out of the positive backlog",
    (heading) => {
      const items = extractVisionKeyItems(
        [
          "## Current priorities",
          "1. Improve document search relevance",
          `## ${heading}`,
          "- Add unrelated billing features",
          "### Goals for a future product",
          "- Introduce a new social network",
          "## Near-term objectives",
          "- Make search results explain their sources",
        ].join("\n"),
      );

      expect(items.priorities).toEqual(["Improve document search relevance"]);
      expect(items.objectives).toEqual(["Make search results explain their sources"]);
      expect(items.nonGoals).toEqual([
        "Add unrelated billing features",
        "Introduce a new social network",
      ]);
    },
  );

  test("keeps early success outcomes from crowding out the near-term objectives", () => {
    const items = extractVisionKeyItems(
      [
        "## What good looks like",
        "### User-facing outcomes",
        ...Array.from({ length: 12 }, (_, index) => `- Desired outcome ${index}`),
        "## Near-term objectives",
        "- Reduce search query latency",
      ].join("\n"),
    );

    expect(items.objectives).toEqual(["Reduce search query latency"]);
    expect(items.metrics).toHaveLength(8);
  });

  test("unclassified subsections inherit priorities but sibling sections reset their scope", () => {
    const items = extractVisionKeyItems(
      [
        "# Product vision",
        "## Priorities",
        "### User experience",
        "- Make search filters easier to discover",
        "#### Keyboard behavior",
        "- Preserve focus when submitting a search",
        "### Success criteria",
        "- Search interactions remain accessible",
        "## Background",
        "### Design notes",
        "- Historical observations are not new priorities",
        "## Near-term objectives",
        "### Import workflow",
        "- Recover interrupted imports safely",
        "## Architecture",
        "- This sibling must not inherit the objective bucket",
      ].join("\n"),
    );
    expect(items.priorities).toEqual([
      "Make search filters easier to discover",
      "Preserve focus when submitting a search",
    ]);
    expect(items.metrics).toEqual(["Search interactions remain accessible"]);
    expect(items.objectives).toEqual(["Recover interrupted imports safely"]);
  });

  test("preserves wrapped ordered priorities and validation commands without merging siblings", () => {
    const items = extractVisionKeyItems(
      [
        "## Priorities",
        "1. Make account setup clear so it matches the",
        "   rest of the product's quality bar.",
        "2) Preserve fast search",
        "   during large imports.",
        "",
        "Unrelated explanatory prose must not join the last priority.",
        "## Required validation",
        "+ `npm run verify --",
        "  --project search`",
        "- `npm run lint`",
        "### Notes",
        "  This is not a command continuation.",
      ].join("\r\n"),
    );

    expect(items.priorities).toEqual([
      "Make account setup clear so it matches the rest of the product's quality bar.",
      "Preserve fast search during large imports.",
    ]);
    expect(items.testingCriteria).toEqual([
      "`npm run verify -- --project search`",
      "`npm run lint`",
    ]);
  });
});
