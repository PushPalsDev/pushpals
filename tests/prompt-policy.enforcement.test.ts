import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "fs";
import { join, relative } from "path";
import {
  collectCodeFiles,
  collectPromptTemplateReferences,
  lineNumberAt,
} from "./helpers/promptTemplates";

const REPO_ROOT = process.cwd();

const DISALLOWED_PROMPT_FRAGMENTS = [
  "You are PushPals",
  "Planner-specific output contract:",
  "Respond in strict JSON with this shape:",
  "Return JSON only.",
  "Invalid planner output to repair:",
  "Canonical task instruction (do not change user intent):",
  "Runtime policy guardrails (mandatory):",
  "Supplemental execution guidance (do not change canonical user intent):",
  "Start now. Output STRICT JSON only.",
  "CRITICAL: You must use tools to make progress.",
];

function toRepoPath(path: string): string {
  return path.replace(/\\/g, "/");
}

describe("prompt policy enforcement", () => {
  test("runtime source code does not embed prompt text fragments", () => {
    const violations: Array<{ file: string; line: number; fragment: string }> = [];

    for (const file of collectCodeFiles()) {
      const relPath = toRepoPath(relative(REPO_ROOT, file));
      const content = readFileSync(file, "utf8");

      for (const fragment of DISALLOWED_PROMPT_FRAGMENTS) {
        const index = content.indexOf(fragment);
        if (index === -1) continue;
        violations.push({
          file: relPath,
          line: lineNumberAt(content, index),
          fragment,
        });
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map((v) => `- ${v.file}:${v.line} contains disallowed prompt fragment "${v.fragment}"`)
        .join("\n");
      throw new Error(
        `Hardcoded prompt text detected in source code.\n` +
          `Move prompt text into prompts/** and load via prompt template helpers.\n${details}`,
      );
    }

    expect(violations.length).toBe(0);
  });

  test("all prompt template paths referenced in code exist under prompts/", () => {
    const missing: Array<{ file: string; line: number; promptPath: string }> = [];

    for (const ref of collectPromptTemplateReferences()) {
      const absPromptPath = join(REPO_ROOT, "prompts", ref.promptPath);
      try {
        const st = statSync(absPromptPath);
        if (!st.isFile()) {
          missing.push(ref);
        }
      } catch {
        missing.push(ref);
      }
    }

    if (missing.length > 0) {
      const details = missing
        .map((m) => `- ${m.file}:${m.line} references missing prompts/${m.promptPath}`)
        .join("\n");
      throw new Error(`Prompt template path(s) missing under prompts/.\n${details}`);
    }

    expect(missing.length).toBe(0);
  });
});
