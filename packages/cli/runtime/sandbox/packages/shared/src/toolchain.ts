import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { isAbsolute, join, normalize } from "path";

export type ToolchainEnvironmentSource =
  | "devcontainer"
  | "dockerfile"
  | "mise"
  | "asdf"
  | "nix"
  | "pushpals-default-sandbox";

export interface ToolRequirement {
  tool: string;
  candidates: string[];
  reason: string;
  detectedFrom: string;
  requiredFor: string[];
  optional?: boolean;
}

export interface ToolchainPlan {
  requirements: ToolRequirement[];
  environmentSource: ToolchainEnvironmentSource;
}

export interface BuildToolchainPlanOptions {
  repoRoot: string;
  validationCommands: string[];
  maxNativeScanEntries?: number;
  maxScriptScanChars?: number;
}

const SHELL_CONTROL_TOKENS = new Set(["|", "||", "&", "&&", ";", ">", ">>", "<", "<<"]);

const NODE_BACKED_CLI_NAMES = new Set([
  "astro",
  "babel",
  "cypress",
  "eslint",
  "expo",
  "jest",
  "metro",
  "next",
  "nuxt",
  "playwright",
  "react-native",
  "rollup",
  "tsc",
  "tsx",
  "vite",
  "vitest",
  "webpack",
]);

const DIRECT_TOOL_CANDIDATES: Record<string, string[]> = {
  bash: ["bash"],
  bun: ["bun"],
  bunx: ["bun"],
  cargo: ["cargo"],
  cc: ["cc"],
  clang: ["clang"],
  "clang++": ["clang++"],
  cmake: ["cmake"],
  cypress: ["cypress"],
  docker: ["docker"],
  eslint: ["eslint"],
  expo: ["expo"],
  gcc: ["gcc"],
  "g++": ["g++"],
  gh: ["gh"],
  go: ["go"],
  java: ["java"],
  javac: ["javac"],
  make: ["make"],
  mvn: ["mvn"],
  next: ["next"],
  ninja: ["ninja"],
  node: ["node"],
  npm: ["npm"],
  npx: ["npx"],
  playwright: ["playwright"],
  pnpm: ["pnpm"],
  powershell: ["powershell"],
  pwsh: ["pwsh"],
  python: ["python3", "python", "py"],
  python3: ["python3", "python"],
  pytest: ["python3", "python", "py"],
  rustc: ["rustc"],
  sh: ["sh"],
  tsc: ["tsc"],
  vite: ["vite"],
  vitest: ["vitest"],
  yarn: ["yarn"],
};

interface NativeSignals {
  hasC: boolean;
  hasCxx: boolean;
  hasMakefile: boolean;
  hasCMake: boolean;
}

export function tokenizeToolchainCommand(command: string): string[] | null {
  const input = command.trim();
  if (!input) return null;
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) out.push(trimmed);
    current = "";
  };

  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index] ?? "";
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  pushCurrent();
  if (out.length === 0) return null;
  if (out.some((token) => SHELL_CONTROL_TOKENS.has(token))) return null;
  return out;
}

export function buildToolchainPlan(options: BuildToolchainPlanOptions): ToolchainPlan {
  const repoRoot = options.repoRoot;
  const nativeSignals = detectNativeSignals(repoRoot, options.maxNativeScanEntries ?? 1_000);
  const requirements: ToolRequirement[] = [];
  for (const command of options.validationCommands) {
    requirements.push(
      ...inferToolRequirementsForValidationCommand(
        repoRoot,
        command,
        nativeSignals,
        options.maxScriptScanChars ?? 64_000,
      ),
    );
  }
  return {
    requirements: dedupeToolRequirements(requirements),
    environmentSource: detectToolchainEnvironmentSource(repoRoot),
  };
}

export function inferToolRequirementsForValidationCommand(
  repoRoot: string,
  command: string,
  nativeSignals: NativeSignals = detectNativeSignals(repoRoot),
  maxScriptScanChars = 64_000,
): ToolRequirement[] {
  const tokens = tokenizeToolchainCommand(command);
  if (!tokens) return [];
  const requirements: ToolRequirement[] = [];
  const first = normalizeToolToken(tokens[0] ?? "");

  addDirectExecutableRequirement(requirements, first, command);
  addNodeBackedCliRequirement(requirements, first, `validation command "${command}"`, command);

  const bunSubcommand = resolveBunSubcommand(tokens);
  if (bunSubcommand?.kind === "x") {
    addNodeBackedCliRequirement(
      requirements,
      normalizeToolToken(bunSubcommand.value),
      `bun x package "${bunSubcommand.value}"`,
      command,
    );
  }

  const script = resolvePackageScript(repoRoot, tokens);
  if (script) {
    addScriptRequirements(
      requirements,
      repoRoot,
      script.scriptCwd,
      script.script,
      script.detectedFrom,
      command,
      {
        maxScriptScanChars,
        depth: 0,
      },
    );
  }

  if (usesNativeBuildCommand(tokens)) {
    if (nativeSignals.hasC) {
      requirements.push({
        tool: "c-compiler",
        candidates: ["cc", "gcc", "clang"],
        reason: "native C sources may be compiled by this validation command",
        detectedFrom: nativeSignals.hasCMake
          ? "CMakeLists.txt/native source scan"
          : "Makefile/native source scan",
        requiredFor: [command],
      });
    }
    if (nativeSignals.hasCxx) {
      requirements.push({
        tool: "cxx-compiler",
        candidates: ["c++", "g++", "clang++"],
        reason: "native C++ sources may be compiled by this validation command",
        detectedFrom: nativeSignals.hasCMake
          ? "CMakeLists.txt/native source scan"
          : "Makefile/native source scan",
        requiredFor: [command],
      });
    }
  }

  return dedupeToolRequirements(requirements);
}

export function requirementsForValidationCommand(
  plan: ToolchainPlan,
  command: string,
): ToolRequirement[] {
  return plan.requirements.filter((requirement) => requirement.requiredFor.includes(command));
}

export function formatToolRequirement(requirement: ToolRequirement): string {
  const candidates =
    requirement.candidates.length === 1
      ? requirement.candidates[0]
      : `${requirement.tool} (${requirement.candidates.join(" or ")})`;
  return `${candidates} from ${requirement.detectedFrom}`;
}

function addDirectExecutableRequirement(
  requirements: ToolRequirement[],
  tool: string,
  command: string,
): void {
  const candidates = DIRECT_TOOL_CANDIDATES[tool];
  if (!candidates) return;
  requirements.push({
    tool: canonicalToolName(tool),
    candidates,
    reason: `validation command invokes ${tool}`,
    detectedFrom: `validation command "${command}"`,
    requiredFor: [command],
  });
}

function addNodeBackedCliRequirement(
  requirements: ToolRequirement[],
  cliName: string,
  detectedFrom: string,
  command: string,
): void {
  if (!NODE_BACKED_CLI_NAMES.has(cliName)) return;
  requirements.push({
    tool: "node",
    candidates: ["node"],
    reason: `${cliName} is normally distributed as a Node.js CLI`,
    detectedFrom,
    requiredFor: [command],
  });
}

function addScriptRequirements(
  requirements: ToolRequirement[],
  repoRoot: string,
  scriptCwd: string,
  script: string,
  detectedFrom: string,
  command: string,
  options: { maxScriptScanChars: number; depth: number },
): void {
  const tokens = tokenizeToolchainCommand(script) ?? script.split(/\s+/).filter(Boolean);
  const first = normalizeToolToken(tokens[0] ?? "");
  // Package-manager scripts resolve Node CLIs from local node_modules/.bin. Requiring a
  // global expo/vite/tsc binary creates false environment blockers for normal JS repos.
  if (!NODE_BACKED_CLI_NAMES.has(first)) {
    addDirectExecutableRequirement(requirements, first, command);
  }
  addNodeBackedCliRequirement(requirements, first, detectedFrom, command);
  for (const token of tokens) {
    addNodeBackedCliRequirement(requirements, normalizeToolToken(token), detectedFrom, command);
  }
  for (const scriptPath of inferReferencedScriptPaths(repoRoot, scriptCwd, tokens)) {
    const scanned = scanScriptFileForToolRequirements(
      requirements,
      repoRoot,
      scriptPath,
      command,
      options,
    );
    if (scanned) continue;
  }
  if (/\bnode\b/.test(script)) {
    requirements.push({
      tool: "node",
      candidates: ["node"],
      reason: "package script invokes node directly",
      detectedFrom,
      requiredFor: [command],
    });
  }
  if (/\bbun\b/.test(script)) {
    requirements.push({
      tool: "bun",
      candidates: ["bun"],
      reason: "package script invokes bun",
      detectedFrom,
      requiredFor: [command],
    });
  }
}

function scanScriptFileForToolRequirements(
  requirements: ToolRequirement[],
  repoRoot: string,
  scriptPath: string,
  command: string,
  options: { maxScriptScanChars: number; depth: number },
): boolean {
  if (options.depth > 2 || !existsSync(scriptPath)) return false;
  let text = "";
  try {
    const stats = statSync(scriptPath);
    if (!stats.isFile() || stats.size > options.maxScriptScanChars) return false;
    text = readFileSync(scriptPath, "utf8");
  } catch {
    return false;
  }
  const detectedFrom = `${repoRelativePath(repoRoot, scriptPath)} referenced by validation command "${command}"`;
  for (const cliName of NODE_BACKED_CLI_NAMES) {
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegExp(cliName)}(?:$|[^A-Za-z0-9_-])`);
    if (pattern.test(text)) {
      addNodeBackedCliRequirement(requirements, cliName, detectedFrom, command);
    }
  }
  if (/\bnode\b/.test(text)) {
    requirements.push({
      tool: "node",
      candidates: ["node"],
      reason: "referenced validation script invokes node directly",
      detectedFrom,
      requiredFor: [command],
    });
  }
  if (/\bbun\b/.test(text)) {
    requirements.push({
      tool: "bun",
      candidates: ["bun"],
      reason: "referenced validation script invokes bun",
      detectedFrom,
      requiredFor: [command],
    });
  }
  return true;
}

function resolveBunSubcommand(tokens: string[]): { kind: "run" | "x"; value: string } | null {
  if (normalizeToolToken(tokens[0] ?? "") !== "bun") return null;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "--cwd" || token === "-C") {
      index += 2;
      continue;
    }
    if (token.startsWith("--")) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = normalizeToolToken(tokens[index] ?? "");
  if ((subcommand === "run" || subcommand === "x") && tokens[index + 1]) {
    return { kind: subcommand, value: tokens[index + 1] ?? "" };
  }
  return null;
}

function resolvePackageScript(
  repoRoot: string,
  tokens: string[],
): { script: string; scriptCwd: string; detectedFrom: string } | null {
  const first = normalizeToolToken(tokens[0] ?? "");
  let cwd = repoRoot;
  let scriptName = "";
  if (first === "bun") {
    let index = 1;
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      if ((token === "--cwd" || token === "-C") && tokens[index + 1]) {
        cwd = join(repoRoot, tokens[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (token.startsWith("--")) {
        index += 1;
        continue;
      }
      break;
    }
    if (normalizeToolToken(tokens[index] ?? "") === "run") {
      scriptName = tokens[index + 1] ?? "";
    } else {
      const candidate = tokens[index] ?? "";
      if (candidate && !["install", "test", "x"].includes(normalizeToolToken(candidate))) {
        scriptName = candidate;
      }
    }
  } else if (first === "npm" || first === "pnpm" || first === "yarn") {
    let index = 1;
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      const normalized = normalizeToolToken(token);
      if (
        (token === "--prefix" ||
          token === "--dir" ||
          token === "--cwd" ||
          token === "-C") &&
        tokens[index + 1]
      ) {
        cwd = join(repoRoot, tokens[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (normalized === "run") {
        scriptName = tokens[index + 1] ?? "";
        break;
      }
      if (!token.startsWith("-")) {
        scriptName = normalized;
        break;
      }
      index += 1;
    }
  }
  if (!scriptName) return null;

  const packagePath = join(cwd, "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const script = parsed.scripts?.[scriptName];
    if (typeof script !== "string" || !script.trim()) return null;
    return {
      script,
      scriptCwd: cwd,
      detectedFrom: `${repoRelativePath(repoRoot, packagePath)} script "${scriptName}"`,
    };
  } catch {
    return null;
  }
}

function inferReferencedScriptPaths(repoRoot: string, scriptCwd: string, tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const normalized = normalizeReferencedScriptToken(token);
    if (!normalized) continue;
    const resolved = isAbsolute(normalized) ? normalized : join(scriptCwd, normalized);
    const key = normalize(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function normalizeReferencedScriptToken(token: string): string | null {
  let normalized = token.replace(/\\/g, "/");
  if (normalized.startsWith("-")) {
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex === -1) return null;
    normalized = normalized.slice(equalsIndex + 1);
  }
  if (!/\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i.test(normalized)) return null;
  if (normalized.includes("://")) return null;
  return normalized;
}

function detectToolchainEnvironmentSource(repoRoot: string): ToolchainEnvironmentSource {
  if (existsSync(join(repoRoot, ".devcontainer", "devcontainer.json"))) return "devcontainer";
  if (existsSync(join(repoRoot, "devcontainer.json"))) return "devcontainer";
  if (existsSync(join(repoRoot, "Dockerfile"))) return "dockerfile";
  if (existsSync(join(repoRoot, "mise.toml")) || existsSync(join(repoRoot, ".mise.toml"))) {
    return "mise";
  }
  if (existsSync(join(repoRoot, ".tool-versions"))) return "asdf";
  if (existsSync(join(repoRoot, "flake.nix")) || existsSync(join(repoRoot, "shell.nix"))) {
    return "nix";
  }
  return "pushpals-default-sandbox";
}

function detectNativeSignals(repoRoot: string, maxEntries = 1_000): NativeSignals {
  const signals: NativeSignals = {
    hasC: false,
    hasCxx: false,
    hasMakefile:
      existsSync(join(repoRoot, "Makefile")) ||
      existsSync(join(repoRoot, "makefile")) ||
      existsSync(join(repoRoot, "GNUmakefile")),
    hasCMake: existsSync(join(repoRoot, "CMakeLists.txt")),
  };
  const ignored = new Set([
    ".git",
    ".worktrees",
    "node_modules",
    "outputs",
    "dist",
    "build",
    ".next",
    ".expo",
  ]);
  let visited = 0;
  const scan = (dir: string, depth: number) => {
    if (visited >= maxEntries || depth > 4 || (signals.hasC && signals.hasCxx)) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxEntries) return;
      if (ignored.has(entry)) continue;
      const fullPath = join(dir, entry);
      visited += 1;
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        scan(fullPath, depth + 1);
        continue;
      }
      const lower = entry.toLowerCase();
      if (/\.(c|h)$/.test(lower)) signals.hasC = true;
      if (/\.(cc|cpp|cxx|hpp|hh|hxx)$/.test(lower)) signals.hasCxx = true;
      if (lower === "cmakelists.txt") signals.hasCMake = true;
    }
  };
  scan(repoRoot, 0);
  return signals;
}

function usesNativeBuildCommand(tokens: string[]): boolean {
  return tokens.some((token) => {
    const normalized = normalizeToolToken(token);
    return normalized === "make" || normalized === "cmake" || normalized === "ninja";
  });
}

function dedupeToolRequirements(requirements: ToolRequirement[]): ToolRequirement[] {
  const merged = new Map<string, ToolRequirement>();
  for (const requirement of requirements) {
    const key = requirement.tool;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...requirement,
        candidates: Array.from(new Set(requirement.candidates)),
        requiredFor: Array.from(new Set(requirement.requiredFor)),
      });
      continue;
    }
    for (const candidate of requirement.candidates) {
      if (!existing.candidates.includes(candidate)) existing.candidates.push(candidate);
    }
    for (const command of requirement.requiredFor) {
      if (!existing.requiredFor.includes(command)) existing.requiredFor.push(command);
    }
    if (!existing.detectedFrom.includes(requirement.detectedFrom)) {
      existing.detectedFrom = `${existing.detectedFrom}; ${requirement.detectedFrom}`;
    }
    if (!existing.reason.includes(requirement.reason)) {
      existing.reason = `${existing.reason}; ${requirement.reason}`;
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.tool.localeCompare(b.tool));
}

function canonicalToolName(tool: string): string {
  if (tool === "bunx") return "bun";
  if (tool === "python3" || tool === "pytest") return "python";
  return tool;
}

function normalizeToolToken(token: string): string {
  const normalizedToken = token.trim().replace(/\\/g, "/").split("/").pop() ?? token;
  return normalizedToken.toLowerCase().replace(/\.(cmd|exe|ps1)$/i, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function repoRelativePath(repoRoot: string, pathValue: string): string {
  const root = normalize(repoRoot).replace(/\\/g, "/").replace(/\/+$/, "");
  const path = normalize(pathValue).replace(/\\/g, "/");
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}
