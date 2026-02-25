import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { collectPromptTemplateReferences } from "./helpers/promptTemplates";

const REPO_ROOT = process.cwd();
const REGISTRY_PATH = join(REPO_ROOT, "tests", "fixtures", "prompt_template_registry.json");

describe("prompt template registry drift", () => {
  test("new prompt references are tracked and readable", () => {
    const registryRaw = readFileSync(REGISTRY_PATH, "utf8");
    const registered = new Set(
      (JSON.parse(registryRaw) as unknown[]).map((entry) => String(entry).trim()).filter(Boolean),
    );
    const references = collectPromptTemplateReferences();
    const newRefs = Array.from(
      new Set(
        references
          .map((ref) => ref.promptPath.trim())
          .filter((path) => path && !registered.has(path)),
      ),
    ).sort();

    if (newRefs.length === 0) {
      expect(newRefs.length).toBe(0);
      return;
    }

    const unreadable: string[] = [];
    for (const promptPath of newRefs) {
      const absPromptPath = join(REPO_ROOT, "prompts", promptPath);
      try {
        readFileSync(absPromptPath, "utf8");
      } catch {
        unreadable.push(promptPath);
      }
    }

    if (unreadable.length > 0) {
      const details = unreadable.map((path) => `- prompts/${path} (missing or unreadable)`).join("\n");
      throw new Error(
        `New prompt template references are missing files:\n${details}\nRegister or remove the references before continuing.`,
      );
    }

    const listing = newRefs.map((path) => `- ${path}`).join("\n");
    throw new Error(
      `New prompt template references detected:\n${listing}\nAdd them to tests/fixtures/prompt_template_registry.json to acknowledge the addition.`,
    );
  });
});
