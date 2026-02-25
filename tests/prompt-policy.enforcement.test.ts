import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { extname, join, relative } from "path";
import { PROMPT_MANIFEST } from "../configs/prompt_manifest";

const REPO_ROOT = process.cwd();
const SOURCE_ROOTS = ["apps", "packages", "scripts"];
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".py", ".js", ".mjs", ".cjs"]);
const PROMPT_STATUS_CACHE = new Map<string, { missing: boolean; empty: boolean }>();

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

function collectCodeFiles(): string[] {
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

function resolvePromptStatus(promptPath: string): { missing: boolean; empty: boolean } {
  const cached = PROMPT_STATUS_CACHE.get(promptPath);
  if (cached) return cached;
  const absPromptPath = join(REPO_ROOT, "prompts", promptPath);
  let status: { missing: boolean; empty: boolean };
  try {
    const st = statSync(absPromptPath);
    if (!st.isFile()) {
      status = { missing: true, empty: true };
    } else {
      const content = readFileSync(absPromptPath, "utf8").trim();
      status = { missing: false, empty: content.length === 0 };
    }
  } catch {
    status = { missing: true, empty: true };
  }
  PROMPT_STATUS_CACHE.set(promptPath, status);
  return status;
}

function lineAt(content: string, index: number): number {
  if (index <= 0) return 1;
  return content.slice(0, index).split(/\r?\n/).length;
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
          line: lineAt(content, index),
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

test("prompt manifest covers runtime references and files exist", () => {
  const manifest = [...PROMPT_MANIFEST];
  const sortedManifest = [...manifest].sort();
  if (sortedManifest.join("\n") !== manifest.join("\n")) {
    throw new Error("Prompt manifest must remain sorted for readability.");
  }
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const entry of manifest) {
    if (seen.has(entry)) duplicates.push(entry);
    seen.add(entry);
  }
  if (duplicates.length > 0) {
    throw new Error(`Duplicate prompt manifest entries detected:\n- ${duplicates.join("\n- ")}`);
  }

  const manifestSet = new Set(manifest);
  const loaderRegexes = [
    /loadPromptTemplate\(\s*["']([^"']+)["']/g,
    /_load_prompt_template\(\s*["']([^"']+)["']/g,
  ];

  const missingManifestEntries: Array<{ file: string; line: number; promptPath: string }> = [];
  for (const file of collectCodeFiles()) {
    const relPath = toRepoPath(relative(REPO_ROOT, file));
    const content = readFileSync(file, "utf8");
    for (const loaderRegex of loaderRegexes) {
      let match: RegExpExecArray | null;
      while ((match = loaderRegex.exec(content)) !== null) {
        const promptPath = match[1].trim();
        if (!promptPath || manifestSet.has(promptPath)) continue;
        missingManifestEntries.push({
          file: relPath,
          line: lineAt(content, match.index),
          promptPath,
        });
      }
    }
  }

  if (missingManifestEntries.length > 0) {
    const details = missingManifestEntries
      .map(
        (entry) =>
          `- ${entry.file}:${entry.line} references prompts/${entry.promptPath}, which is not listed in configs/prompt_manifest.ts`,
      )
      .join("\n");
    throw new Error(
      `Prompt manifest is missing ${missingManifestEntries.length} referenced path(s).\n${details}`,
    );
  }

  const fileIssues: Array<{ promptPath: string; reason: "missing" | "empty" }> = [];
  for (const promptPath of manifest) {
    const status = resolvePromptStatus(promptPath);
    if (status.missing) {
      fileIssues.push({ promptPath, reason: "missing" });
    } else if (status.empty) {
      fileIssues.push({ promptPath, reason: "empty" });
    }
  }

  if (fileIssues.length > 0) {
    const details = fileIssues
      .map((issue) => `- prompts/${issue.promptPath} is ${issue.reason}`)
      .join("\n");
    throw new Error(`Prompt manifest contains invalid entries:\n${details}`);
  }

  expect(fileIssues.length).toBe(0);
});
});
