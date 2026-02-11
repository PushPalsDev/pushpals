import { readFileSync } from "fs";
import { join } from "path";
import { detectRepoRoot } from "./repo.js";

const TEMPLATE_TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const promptTemplateCache = new Map<string, string>();

function resolvePromptPath(relativePath: string): string {
  const repoRoot = detectRepoRoot(process.cwd());
  return join(repoRoot, "prompts", relativePath);
}

export function loadPromptTemplate(
  relativePath: string,
  replacements?: Record<string, string>,
): string {
  const promptPath = resolvePromptPath(relativePath);
  let template = promptTemplateCache.get(promptPath);

  if (template === undefined) {
    template = readFileSync(promptPath, "utf8");
    promptTemplateCache.set(promptPath, template);
  }

  if (!replacements || Object.keys(replacements).length === 0) {
    return template;
  }

  return template.replace(TEMPLATE_TOKEN, (_match: string, token: string) => {
    const value = replacements[token];
    if (value === undefined) {
      throw new Error(`[prompts] Missing replacement for "{{${token}}}" in ${promptPath}`);
    }
    return value;
  });
}
