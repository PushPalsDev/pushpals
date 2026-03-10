import { readFileSync } from "fs";
import { join, resolve } from "path";
import { detectRepoRoot } from "./repo.js";

const TEMPLATE_TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const promptTemplateCache = new Map<string, string>();
const repoDocCache = new Map<string, string>();

function resolvePromptPath(relativePath: string): string {
  const promptRootOverride = String(process.env.PUSHPALS_PROMPTS_ROOT_OVERRIDE ?? "").trim();
  const repoRoot = promptRootOverride ? resolve(promptRootOverride) : detectRepoRoot(process.cwd());
  return join(repoRoot, "prompts", relativePath);
}

function resolveRepoDocPath(relativePath: string): string {
  const repoRoot = detectRepoRoot(process.cwd());
  return join(repoRoot, relativePath);
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

export function loadRepoDocText(relativePath: string, opts?: { cache?: boolean }): string {
  const pathValue = String(relativePath ?? "").trim();
  if (!pathValue) {
    throw new Error("[docs] relativePath is required");
  }

  const docPath = resolveRepoDocPath(pathValue);
  const shouldCache = opts?.cache !== false;

  if (shouldCache) {
    const cached = repoDocCache.get(docPath);
    if (cached !== undefined) return cached;
  }

  const text = readFileSync(docPath, "utf8");
  if (shouldCache) {
    repoDocCache.set(docPath, text);
  }
  return text;
}
