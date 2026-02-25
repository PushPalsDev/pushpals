import { readdirSync, readFileSync, statSync } from "fs";
import { extname, join, relative } from "path";

const REPO_ROOT = process.cwd();
const SOURCE_ROOTS = ["apps", "packages", "scripts"];
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".py", ".js", ".mjs", ".cjs"]);
const PROMPT_LOADER_REGEXES = [
  /loadPromptTemplate\(\s*["']([^"']+)["']/g,
  /_load_prompt_template\(\s*["']([^"']+)["']/g,
];

function toRepoPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isGeneratedOrIgnored(relPath: string): boolean {
  return (
    relPath.includes("/node_modules/") ||
    relPath.includes("/dist/") ||
    relPath.includes("/build/") ||
    relPath.includes("/coverage/") ||
    relPath.includes("/.worktrees/") ||
    relPath.includes("/prompts/")
  );
}

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("/tests/") ||
    relPath.endsWith(".test.ts") ||
    relPath.endsWith(".spec.ts") ||
    /\/test_[^/]+\.py$/i.test(relPath) ||
    /\/tests?\/.+\.py$/i.test(relPath)
  );
}

export function collectCodeFiles(): string[] {
  const files: string[] = [];

  const visit = (absPath: string): void => {
    const relPath = toRepoPath(relative(REPO_ROOT, absPath));
    if (!relPath || relPath.startsWith("..")) return;
    if (isGeneratedOrIgnored(relPath)) return;

    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absPath)) {
        visit(join(absPath, entry));
      }
      return;
    }

    if (!CODE_EXTENSIONS.has(extname(absPath).toLowerCase())) return;
    if (isTestFile(relPath)) return;
    files.push(absPath);
  };

  for (const root of SOURCE_ROOTS) {
    const absRoot = join(REPO_ROOT, root);
    try {
      if (statSync(absRoot).isDirectory()) visit(absRoot);
    } catch {
      // Optional root; ignore when absent.
    }
  }

  return files;
}

export function lineNumberAt(content: string, index: number): number {
  if (index <= 0) return 1;
  return content.slice(0, index).split(/\r?\n/).length;
}

export interface PromptReference {
  file: string;
  line: number;
  promptPath: string;
}

export function collectPromptTemplateReferences(): PromptReference[] {
  const references: PromptReference[] = [];

  for (const file of collectCodeFiles()) {
    const relPath = toRepoPath(relative(REPO_ROOT, file));
    const content = readFileSync(file, "utf8");
    for (const loaderRegex of PROMPT_LOADER_REGEXES) {
      let match: RegExpExecArray | null;
      while ((match = loaderRegex.exec(content)) !== null) {
        const promptPath = match[1].trim();
        if (!promptPath) continue;
        references.push({
          file: relPath,
          line: lineNumberAt(content, match.index),
          promptPath,
        });
      }
    }
  }

  return references;
}
