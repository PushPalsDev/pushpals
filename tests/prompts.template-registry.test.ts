import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { collectPromptTemplateReferences } from "./helpers/promptTemplates";

const REPO_ROOT = process.cwd();

describe("prompt template registry", () => {
  test("every referenced prompt template is readable", () => {
    const references = collectPromptTemplateReferences();
    const grouped = new Map<string, { files: string[] }>();

    for (const ref of references) {
      const entry = grouped.get(ref.promptPath);
      if (entry) {
        entry.files.push(`${ref.file}:${ref.line}`);
      } else {
        grouped.set(ref.promptPath, { files: [`${ref.file}:${ref.line}`] });
      }
    }

    const failures: Array<{ promptPath: string; locations: string[]; error: string }> = [];
    for (const [promptPath, meta] of grouped.entries()) {
      const absPromptPath = join(REPO_ROOT, "prompts", promptPath);
      try {
        readFileSync(absPromptPath, "utf8");
      } catch (err) {
        failures.push({ promptPath, locations: meta.files, error: String(err) });
      }
    }

    if (failures.length > 0) {
      const details = failures
        .map(
          (failure) =>
            `- prompts/${failure.promptPath} (${failure.error})\n  referenced by ${failure.locations.join(", ")}`,
        )
        .join("\n");
      throw new Error(`Prompt template references missing or unreadable:\n${details}`);
    }

    expect(failures.length).toBe(0);
  });
});
