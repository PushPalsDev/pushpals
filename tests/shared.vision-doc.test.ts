import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  extractVisionKeyItems,
  normalizeVisionSectionRef,
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

  test("parseVisionDoc normalizes zero-padded section numbers", () => {
    const markdown = [
      "# Vision",
      "> **One sentence:** Example.",
      "",
      "## 01) Who this is for",
      "Content.",
      "",
      "## 002) The problem we solve",
      "More content.",
    ].join("\n");
    const parsed = parseVisionDoc(markdown);
    expect(parsed.sections.map((section) => section.number)).toEqual(["1", "2"]);
  });

  test("parseVisionDoc ignores headings that appear inside fenced code blocks", () => {
    const markdown = [
      "# Vision",
      "> **One sentence:** Ignore code fences.",
      "",
      "```markdown",
      "## 1) Fake heading inside fence",
      "```",
      "",
      "## 1) Who this is for",
      "Builders.",
      "",
      "## 2) The problem we solve",
      "Their blockers.",
    ].join("\n");
    const parsed = parseVisionDoc(markdown);
    expect(parsed.sections.map((section) => `${section.number}) ${section.title}`)).toEqual([
      "1) Who this is for",
      "2) The problem we solve",
    ]);
  });

  test("validateVisionDocStructure accepts populated vision.md template", () => {
    const markdown = readFileSync(join(repoRoot, "vision.md"), "utf8");
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(true);
    expect(validation.sectionCount).toBeGreaterThan(0);
    expect(validation.hasOneSentence).toBe(true);
    expect(validation.missingSectionNumbers).toEqual([]);
  });

  test("validateVisionDocStructure reports missing required section numbers", () => {
    const markdown = [
      "# Vision",
      "> **One sentence:** Keep this short.",
      "",
      "## 1) Who this is for",
      "Required content.",
    ].join("\n");
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(false);
    expect(validation.missingSectionNumbers).toEqual(["2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  });

  test("validateVisionDocStructure rejects malformed numbered headings", () => {
    const template = readFileSync(join(repoRoot, "vision.example.md"), "utf8");
    const markdown = template.replace("## 1) Who this is for", "## 1. Who this is for");
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(false);
    expect(validation.missingSectionNumbers).toContain("1");
    expect(
      validation.errors.some((error) => error.includes("Malformed top-level section heading")),
    ).toBe(
      true,
    );
  });

  test("validateVisionDocStructure rejects unnumbered top-level sections", () => {
    const markdown = [
      "# Vision",
      "> **One sentence:** This explains the mission.",
      "",
      "## Overview and goals",
      "Extra preface content.",
      "",
      "## 1) Who this is for",
      "Required content.",
    ].join("\n");
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(false);
    expect(
      validation.errors.some((error) =>
        error.includes('Malformed top-level section heading "## Overview and goals"'),
      ),
    ).toBe(true);
  });

  test("validateVisionDocStructure rejects headings missing required spacing", () => {
    const markdown = [
      "# Vision",
      '> **One sentence:** This explains the mission.',
      "",
      "##1) Who this is for",
      "Required content.",
      "",
      "## 2) The problem we solve",
      "More content.",
    ].join("\n");
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(false);
    expect(validation.missingSectionNumbers).toContain("1");
    expect(
      validation.errors.some((error) =>
        error.includes('Malformed top-level section heading "##1) Who this is for"'),
      ),
    ).toBe(true);
  });

  test("validateVisionDocStructure allows numbered subheadings that are not top-level sections", () => {
    const template = readFileSync(join(repoRoot, "vision.example.md"), "utf8");
    const markdown = template.replace(
      "## 3) Product principles (decision rules)",
      [
        "## 3) Product principles (decision rules)",
        "",
        "### 3.1) Example subheading",
        "Example detail.",
      ].join("\n"),
    );
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(true);
    expect(validation.errors.some((error) => error.includes("Malformed top-level section"))).toBe(
      false,
    );
  });

  test("validateVisionDocStructure detects duplicate section numbers", () => {
    const template = readFileSync(join(repoRoot, "vision.example.md"), "utf8");
    const markdown = template.replace(
      "## 2) The problem we solve",
      ["## 2) The problem we solve", "", "## 2) Duplicate Problem Section", "Extra content."].join(
        "\n",
      ),
    );
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(false);
    expect(validation.missingSectionNumbers).toEqual([]);
    expect(validation.errors.some((error) => error.includes("Duplicate section number 2"))).toBe(
      true,
    );
  });

  test("validateVisionDocStructure ignores fenced code block headings when checking duplicates", () => {
    const template = readFileSync(join(repoRoot, "vision.example.md"), "utf8");
    const markdown = template.replace(
      "## 4) What \"good\" looks like (measures)",
      [
        "```markdown",
        "## 4) Fake heading inside fence",
        "```",
        "",
        "## 4) What \"good\" looks like (measures)",
      ].join("\n"),
    );
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(true);
    expect(validation.errors.some((error) => error.includes("Duplicate section number 4"))).toBe(
      false,
    );
  });

  test("validateVisionDocStructure ignores headings wrapped in HTML comments", () => {
    const template = readFileSync(join(repoRoot, "vision.example.md"), "utf8");
    const markdown = template.replace(
      "## 6) Current priorities",
      ["<!-- ## 6) Hidden heading -->", "## 6) Current priorities"].join("\n"),
    );
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(true);
    expect(
      validation.errors.some((error) => error.includes("Malformed top-level section heading")),
    ).toBe(false);
  });

  test("validateVisionDocStructure requires the one-sentence vision line", () => {
    const sections: string[] = [];
    for (let number = 1; number <= 10; number += 1) {
      sections.push(`## ${number}) Section ${number}`, "Content.", "");
    }
    const markdown = ["# Vision", "", ...sections].join("\n");
    const validation = validateVisionDocStructure(markdown);
    expect(validation.ok).toBe(false);
    expect(validation.hasOneSentence).toBe(false);
    expect(
      validation.errors.some((error) => error.includes("Missing one-sentence vision line")),
    ).toBe(true);
  });

  test("normalizeVisionSectionRefs normalizes and filters references", () => {
    const allowed = new Set(["1", "3", "10"]);
    const refs = normalizeVisionSectionRefs(["01", "section 3", "10)", "9", "3"], allowed);
    expect(refs).toEqual(["1", "10", "3"]);
  });

  test("normalizeVisionSectionRefs supports section 0 and drops non-numeric references", () => {
    const allowed = new Set(["0", "2", "5"]);
    const refs = normalizeVisionSectionRefs(
      [
        "0",
        "0)",
        "## 0) Optional operating model",
        "Appendix",
        "2)",
        "005",
      ],
      allowed,
    );
    expect(refs).toEqual(["0", "2", "5"]);
  });

  test("normalizeVisionSectionRef only accepts section 0 when explicitly allowed", () => {
    expect(normalizeVisionSectionRef("0")).toBe("");
    expect(normalizeVisionSectionRef("0)")).toBe("");
    expect(normalizeVisionSectionRef("## 0) Optional operating model")).toBe("");
    expect(normalizeVisionSectionRef("0", { allowZero: true })).toBe("0");
    expect(normalizeVisionSectionRef("0)", { allowZero: true })).toBe("0");
    expect(normalizeVisionSectionRef("## 0) Optional operating model", { allowZero: true })).toBe(
      "0",
    );
  });

  test("normalizeVisionSectionRef parses numbered headings consistently with parseVisionDoc", () => {
    expect(normalizeVisionSectionRef("## 003) Sample section title")).toBe("3");
    expect(normalizeVisionSectionRef("## 0) Optional operating model", { allowZero: true })).toBe(
      "0",
    );
  });

  test("normalizeVisionSectionRef rejects embedded numeric references", () => {
    expect(normalizeVisionSectionRef("section 3")).toBe("");
    expect(normalizeVisionSectionRef("Plan 5) - extra text")).toBe("");
    expect(normalizeVisionSectionRef("Operating model (0)", { allowZero: true })).toBe("");
  });

  test("extractVisionKeyItems maps key bullets from template sections", () => {
    const markdown = readFileSync(join(repoRoot, "vision.example.md"), "utf8");
    const items = extractVisionKeyItems(markdown);
    expect(items.priorities.length).toBeGreaterThan(0);
    expect(items.objectives.length).toBeGreaterThan(0);
    expect(items.guardrails.length).toBeGreaterThan(0);
    expect(items.constraints.length).toBeGreaterThan(0);
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
});
