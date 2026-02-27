import { readFileSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { detectRepoRoot } from "./repo.js";

const TEMPLATE_TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const promptTemplateCache = new Map<string, string>();
const repoDocCache = new Map<string, string>();

function resolvePromptPath(relativePath: string): string {
  const repoRoot = detectRepoRoot(process.cwd());
  return join(repoRoot, "prompts", relativePath);
}

type RepoDocOptions = {
  cache?: boolean;
  allowAbsolutePath?: boolean;
};

export function resolveRepoDocPath(pathValue: string, opts?: RepoDocOptions): string {
  const repoRoot = detectRepoRoot(process.cwd());
  const repoRootResolved = resolve(repoRoot);
  const normalizedPath = isAbsolute(pathValue)
    ? resolve(pathValue)
    : resolve(repoRootResolved, pathValue);

  if (isAbsolute(pathValue) && !opts?.allowAbsolutePath) {
    throw new Error(
      `[docs] Absolute repo doc paths ("${pathValue}") require allowAbsolutePath=true and must remain inside the repository root.`,
    );
  }

  const relativePath = relative(repoRootResolved, normalizedPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(
      `[docs] Refusing to read repo doc outside repo root (${normalizedPath}). Provide a path within ${repoRootResolved}.`,
    );
  }

  return normalizedPath;
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

export function loadRepoDocText(relativePath: string, opts?: RepoDocOptions): string {
  const pathValue = String(relativePath ?? "").trim();
  if (!pathValue) {
    throw new Error("[docs] relativePath is required");
  }

  const docPath = resolveRepoDocPath(pathValue, opts);
  const shouldCache = opts?.cache !== false;

  if (!shouldCache) {
    repoDocCache.delete(docPath);
  } else {
    const cached = repoDocCache.get(docPath);
    if (cached !== undefined) return cached;
  }

  const text = readFileSync(docPath, "utf8");
  if (shouldCache) {
    repoDocCache.set(docPath, text);
  }
  return text;
}
