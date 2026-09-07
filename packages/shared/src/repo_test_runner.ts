import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { basename, dirname, relative, resolve } from "path";
import { tokenizeTrustedValidationCommand } from "./trusted_validation.js";

type Runner = "vitest" | "jest" | "bun";
type PackageManager = "bun" | "npm" | "pnpm" | "yarn";
const MAX_EVIDENCE_BYTES = 256_000;

function within(root: string, path: string): boolean {
  const rel = relative(root, path).replace(/\\/g, "/");
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !/^(?:\/|[A-Za-z]:)/.test(rel));
}

function readEvidence(root: string, path: string): string | null {
  try {
    if (!within(root, path) || !within(realpathSync(root), realpathSync(path))) return null;
    const stat = statSync(path);
    return stat.isFile() && stat.size <= MAX_EVIDENCE_BYTES ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function readManifest(root: string, directory: string): Record<string, unknown> | null {
  const text = readEvidence(root, resolve(directory, "package.json"));
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function packageManager(root: string, directory: string): PackageManager {
  for (let cursor = directory; within(root, cursor); cursor = dirname(cursor)) {
    const declared = String(readManifest(root, cursor)?.packageManager ?? "").split("@")[0];
    if (["bun", "npm", "pnpm", "yarn"].includes(declared)) return declared as PackageManager;
    for (const [manager, lock] of [
      ["bun", "bun.lock"],
      ["bun", "bun.lockb"],
      ["pnpm", "pnpm-lock.yaml"],
      ["yarn", "yarn.lock"],
      ["npm", "package-lock.json"],
    ] as const) {
      if (existsSync(resolve(cursor, lock))) return manager;
    }
    if (cursor === root) break;
  }
  return "npm";
}

function packageScriptCommand(root: string, directory: string, name: string): string {
  const manager = packageManager(root, directory);
  const path = relative(root, directory).replace(/\\/g, "/");
  const option = manager === "npm" ? "--prefix" : manager === "pnpm" ? "--dir" : "--cwd";
  return `${manager}${path ? ` ${option} ${quote(path)}` : ""} run ${quote(name)}`;
}

function runnerForFile(text: string, path: string): Runner | null {
  // Imports are stronger evidence than file names or an installed dependency.
  for (const [module, runner] of [
    ["bun:test", "bun"],
    ["vitest", "vitest"],
    ["@jest/globals", "jest"],
  ] as const) {
    if (new RegExp(`(?:from\\s*|(?:require|import)\\s*\\(\\s*)["']${module}["']`).test(text))
      return runner;
  }
  return /\.vitest\.[cm]?[jt]sx?$/i.test(path) ? "vitest" : null;
}

type ConfigToken = { kind: "word" | "string" | "punctuation"; value: string; literal?: string };

/** A deliberately small lexer, not a JavaScript evaluator. Comments and quoted
 * text cannot manufacture selectors. Unsupported syntax remains unresolved. */
function configTokens(text: string): ConfigToken[] | null {
  const tokens: ConfigToken[] = [];
  for (let cursor = 0; cursor < text.length; ) {
    const char = text[cursor];
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      while (cursor < text.length && !/[\r\n\u2028\u2029]/.test(text[cursor])) cursor += 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      const end = text.indexOf("*/", cursor + 2);
      if (end < 0) return null;
      cursor = end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const start = ++cursor;
      let escaped = false;
      while (cursor < text.length && text[cursor] !== char) {
        if (/[\r\n\u2028\u2029]/.test(text[cursor])) return null;
        if (text[cursor] === "\\") {
          escaped = true;
          cursor += 1;
        }
        cursor += 1;
      }
      if (cursor >= text.length) return null;
      const value = text.slice(start, cursor++);
      // Escape sequences in selection values require semantics we do not
      // approximate. They are still opaque strings in unrelated config fields.
      tokens.push({ kind: "string", value, ...(escaped ? {} : { literal: value }) });
      continue;
    }
    if (char === "`" || char === "/" || char === "\\") return null;
    const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(cursor));
    if (word) {
      tokens.push({ kind: "word", value: word[0] });
      cursor += word[0].length;
    } else {
      tokens.push({ kind: "punctuation", value: char });
      cursor += 1;
    }
  }
  return tokens;
}

function punct(token: ConfigToken | undefined, value: string): boolean {
  return token?.kind === "punctuation" && token.value === value;
}

/** Inspect only direct properties of a literal object, never nested prose or
 * an unexported lookalike. Spreads, getters, computed/duplicate keys and aliases
 * make the effective object unknown, so they cannot supply ownership evidence. */
function literalObject(tokens: ConfigToken[]): Map<string, ConfigToken[]> | null {
  if (!punct(tokens[0], "{") || !punct(tokens.at(-1), "}")) return null;
  const fields = new Map<string, ConfigToken[]>();
  let cursor = 1;
  while (cursor < tokens.length - 1) {
    const token = tokens[cursor++];
    const key = token.kind === "word" ? token.value : token.literal;
    if (
      key === undefined ||
      key === "__proto__" ||
      fields.has(key) ||
      !punct(tokens[cursor++], ":")
    )
      return null;
    const start = cursor;
    const closing: string[] = [];
    for (; cursor < tokens.length - 1; cursor += 1) {
      const current = tokens[cursor];
      if (current.kind !== "punctuation") continue;
      if (current.value === "," && !closing.length) break;
      const end = ({ "{": "}", "[": "]", "(": ")" } as Record<string, string>)[current.value];
      if (end) closing.push(end);
      else if (["}", "]", ")"].includes(current.value) && closing.pop() !== current.value)
        return null;
    }
    if (closing.length || cursor === start) return null;
    fields.set(key, tokens.slice(start, cursor));
    if (cursor < tokens.length - 1) cursor += 1;
  }
  return fields;
}

function literalPatterns(tokens: ConfigToken[] | undefined): string[] | null | undefined {
  if (!tokens) return undefined;
  if (!punct(tokens[0], "[") || !punct(tokens.at(-1), "]")) return null;
  const patterns: string[] = [];
  for (let cursor = 1; cursor < tokens.length - 1; cursor += 2) {
    if (tokens[cursor].kind !== "string" || tokens[cursor].literal === undefined) return null;
    patterns.push(tokens[cursor].literal!);
    if (cursor + 1 < tokens.length - 1 && !punct(tokens[cursor + 1], ",")) return null;
  }
  return patterns;
}

function selectionPreservingPlugins(
  tokens: ConfigToken[] | undefined,
  helpers: Set<string>,
): boolean {
  if (!tokens) return true;
  if (!punct(tokens[0], "[") || !punct(tokens.at(-1), "]")) return false;
  let expression = tokens.slice(1, -1);
  if (!expression.length) return true;
  if (punct(expression.at(-1), ",")) expression = expression.slice(0, -1);
  // Arbitrary Vite config hooks can replace include/exclude after evaluation.
  // The documented Workers pool adapter changes execution/module resolution,
  // not discovery. Accept only its imported helper and literal options, never
  // an inline hook, additional plugin, factory callback or spread list.
  return (
    expression[0]?.kind === "word" &&
    helpers.has(expression[0].value) &&
    punct(expression[1], "(") &&
    punct(expression.at(-1), ")") &&
    literalObject(expression.slice(2, -1)) !== null
  );
}

function exportedConfig(text: string, json: boolean): Map<string, ConfigToken[]> | null {
  const tokens = configTokens(text);
  if (!tokens) return null;
  if (json) {
    try {
      JSON.parse(text);
    } catch {
      return null;
    }
    const object = literalObject(tokens);
    return object && selectionPreservingPlugins(object.get("plugins"), new Set()) ? object : null;
  }
  const wrappers = new Set<string>();
  const plugins = new Set<string>();
  let cursor = 0;
  // Recognize identity configuration helpers only from their actual imports,
  // not a local function with a familiar name. No statements may mutate the
  // exported object before or after its declaration.
  while (tokens[cursor]?.kind === "word" && tokens[cursor].value === "import") {
    const start = ++cursor;
    while (cursor < tokens.length && tokens[cursor].kind !== "string") cursor += 1;
    const source = tokens[cursor]?.literal;
    if (source === undefined) return null;
    if (cursor > start && tokens[cursor - 1]?.value !== "from") return null;
    const helper = ["vitest/config", "vite"].includes(source)
      ? "defineConfig"
      : source === "@cloudflare/vitest-pool-workers/config"
        ? "defineWorkersConfig"
        : null;
    const plugin = ["@cloudflare/vitest-pool-workers", "@cloudflare/vitest-plugin"].includes(source)
      ? "cloudflareTest"
      : null;
    const clause = tokens.slice(start, cursor - 1);
    if ((helper || plugin) && punct(clause[0], "{") && punct(clause.at(-1), "}")) {
      for (let index = 1; index < clause.length - 1; ) {
        const imported = clause[index++];
        if (imported.kind !== "word") return null;
        let local = imported.value;
        if (clause[index]?.value === "as") {
          index += 1;
          if (clause[index]?.kind !== "word") return null;
          local = clause[index++].value;
        }
        if (imported.value === helper) wrappers.add(local);
        if (imported.value === plugin) plugins.add(local);
        if (index < clause.length - 1 && !punct(clause[index++], ",")) return null;
      }
    }
    cursor += 1;
    if (punct(tokens[cursor], ";")) cursor += 1;
  }
  if (tokens[cursor]?.value === "export" && tokens[cursor + 1]?.value === "default") cursor += 2;
  else if (
    tokens[cursor]?.value === "module" &&
    punct(tokens[cursor + 1], ".") &&
    tokens[cursor + 2]?.value === "exports" &&
    punct(tokens[cursor + 3], "=")
  )
    cursor += 4;
  else return null;
  let expression = tokens.slice(cursor);
  if (punct(expression.at(-1), ";")) expression = expression.slice(0, -1);
  if (expression[0]?.kind === "word" && wrappers.has(expression[0].value)) {
    if (!punct(expression[1], "(") || !punct(expression.at(-1), ")")) return null;
    expression = expression.slice(2, -1);
  }
  const object = literalObject(expression);
  return object && selectionPreservingPlugins(object.get("plugins"), plugins) ? object : null;
}

function configSelection(text: string, path: string, runner: "vitest" | "jest") {
  const object = exportedConfig(text, path.endsWith(".json"));
  if (!object) return null;
  const selection =
    runner === "vitest" && object.has("test")
      ? literalObject(object.get("test")!)
      : runner === "vitest"
        ? new Map<string, ConfigToken[]>()
        : object;
  if (!selection) return null;
  const unsupported = [
    "projects",
    "workspace",
    "testRegex",
    "testPathIgnorePatterns",
    "rootDir",
    "roots",
    "preset",
    "testNamePattern",
    "dir",
    "includeSource",
    "shard",
    "changed",
    "related",
    "filter",
    "testSequencer",
    "modulePathIgnorePatterns",
    "moduleFileExtensions",
    "runner",
    "testRunner",
    "sequence",
    "extends",
  ];
  if (unsupported.some((key) => object.has(key) || selection.has(key))) return null;
  if (runner === "jest" && object.has("root")) return null;
  if (selection !== object && selection.has("plugins")) return null;
  const rootValues = [
    object.get("root"),
    selection === object ? undefined : selection.get("root"),
  ].filter((value): value is ConfigToken[] => value !== undefined);
  if (
    rootValues.length > 1 ||
    rootValues.some((value) => value.length !== 1 || value[0].literal === undefined)
  )
    return null;
  const includes = literalPatterns(selection.get(runner === "vitest" ? "include" : "testMatch"));
  const excludes = runner === "vitest" ? literalPatterns(selection.get("exclude")) : undefined;
  if (includes === null || excludes === null) return null;
  return { root: rootValues[0]?.[0].literal, includes, excludes };
}

function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.startsWith("!") || pattern.includes("<rootDir>")) return false;
  try {
    return new Bun.Glob(pattern.replace(/^\.\//, "")).match(path);
  } catch {
    return false;
  }
}

function scriptRunner(argv: string[]): { runner: Exclude<Runner, "bun">; index: number } | null {
  // Restrict inference to a known runner entrypoint, not prose/arguments of an
  // arbitrary script. Package scripts themselves retain their original flags.
  let index = 0;
  if (argv[0] === "bun" && argv[1] === "x") index = 2;
  else if (["bunx", "npx"].includes(argv[0])) index = 1;
  else if (["pnpm", "yarn"].includes(argv[0]) && argv[1] === "exec") index = 2;
  while (["--yes", "-y", "--no-install"].includes(argv[index])) index += 1;
  const runner = argv[index];
  if (runner !== "vitest" && runner !== "jest") return null;
  if (argv.some((arg) => /^(?:--watch(?:All)?(?:=true)?|-w)$/.test(arg))) return null;
  if (runner === "vitest" && !argv.slice(index + 1).some((arg) => arg === "run" || arg === "--run"))
    return null;
  // A pre-filtered script could validate only a different test. Accept only
  // options which cannot narrow discovery beyond the inspected config.
  const valueOptions = new Set([
    "--config",
    "-c",
    "--pool",
    "--maxWorkers",
    "--minWorkers",
    "--testTimeout",
    "--hookTimeout",
    "--reporter",
  ]);
  const booleanOptions = new Set([
    "run",
    "--run",
    "--runInBand",
    "--ci",
    "--silent",
    "--coverage",
    "--no-file-parallelism",
  ]);
  for (let cursor = index + 1; cursor < argv.length; cursor += 1) {
    const option = argv[cursor];
    if (booleanOptions.has(option)) continue;
    if (valueOptions.has(option)) {
      if (!argv[cursor + 1] || argv[cursor + 1].startsWith("-")) return null;
      cursor += 1;
      continue;
    }
    if (option.includes("=") && valueOptions.has(option.split("=", 1)[0])) continue;
    return null;
  }
  return { runner, index };
}

function commandsForTest(root: string, path: string): string[] {
  const source = readEvidence(root, path);
  if (source === null) return [];
  const requiredRunner = runnerForFile(source, path);
  if (requiredRunner === "bun") return [];
  for (let directory = dirname(path); within(root, directory); directory = dirname(directory)) {
    const manifest = readManifest(root, directory);
    if (!manifest) {
      // A malformed or unreadable owner is not permission to borrow an
      // unrelated parent package's tests.
      if (existsSync(resolve(directory, "package.json"))) return [];
      if (directory === root) break;
      continue;
    }
    const scripts = manifest.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
    const candidates: Array<{ command: string; score: number }> = [];
    for (const [name, script] of Object.entries(scripts)) {
      if (typeof script !== "string" || !/^[A-Za-z0-9_:@.-]+$/.test(name)) continue;
      const argv = tokenizeTrustedValidationCommand(script);
      if (!argv) continue;
      const runner = scriptRunner(argv);
      if (!runner || (requiredRunner && requiredRunner !== runner.runner)) continue;
      const configOptions = argv.filter(
        (arg) =>
          arg === "--config" ||
          arg === "-c" ||
          arg.startsWith("--config=") ||
          arg.startsWith("-c="),
      );
      if (configOptions.length > 1) continue;
      const configIndex = argv.findIndex((arg) => arg === "--config" || arg === "-c");
      const configArg =
        configIndex >= 0
          ? argv[configIndex + 1]
          : configOptions[0]?.slice(configOptions[0].indexOf("=") + 1);
      const configFiles = (base: string) =>
        ["ts", "mts", "js", "mjs", "cjs", "cts", "json"]
          .map((ext) => `${base}.config.${ext}`)
          .filter((file) => existsSync(resolve(directory, file)));
      let defaultConfigs = configFiles(runner.runner);
      if (runner.runner === "vitest" && defaultConfigs.length === 0)
        defaultConfigs = configFiles("vite");
      if (!configArg && (defaultConfigs.length > 1 || (runner.runner === "jest" && manifest.jest)))
        continue;
      const defaultConfig = defaultConfigs[0];
      const configPath = configArg ?? defaultConfig;
      // Jest unwraps the nested `jest` field when --config points at a package
      // manifest. Do not mistake that outer object for an empty runner config.
      if (
        runner.runner === "jest" &&
        configPath &&
        basename(configPath).toLowerCase() === "package.json"
      )
        continue;
      const config = configPath ? readEvidence(root, resolve(directory, configPath)) : null;
      if (configPath && config === null) continue;
      // A workspace may select projects instead of this package's default
      // discovery. Its executable/dynamic composition is not inferred here.
      if (
        runner.runner === "vitest" &&
        ["ts", "mts", "js", "mjs", "json"].some((extension) =>
          existsSync(resolve(directory, `vitest.workspace.${extension}`)),
        )
      )
        continue;
      const selection =
        config !== null
          ? configSelection(config, configPath!, runner.runner)
          : { root: undefined, includes: undefined, excludes: undefined };
      if (!selection) continue;
      // Jest defaults rootDir to the selected config file's directory, not the
      // package cwd. Its testMatch patterns inspect absolute test paths; Vitest
      // include patterns inspect paths relative to the configured root.
      const defaultRoot =
        runner.runner === "jest" && configPath
          ? dirname(resolve(directory, configPath))
          : directory;
      const testRoot =
        selection.root !== undefined ? resolve(directory, selection.root) : defaultRoot;
      if (!within(root, testRoot) || !within(testRoot, path)) continue;
      const relativePath = relative(testRoot, path).replace(/\\/g, "/");
      const selectedPath = runner.runner === "jest" ? path.replace(/\\/g, "/") : relativePath;
      const { includes, excludes } = selection;
      // Negated globs are order-sensitive in runners. Do not approximate their
      // selection semantics with independent positive matches.
      if ([...(includes ?? []), ...(excludes ?? [])].some((pattern) => pattern.startsWith("!")))
        continue;
      // Bun.Glob and runner glob engines disagree on character classes and
      // extglobs. Do not turn a match in our approximation into false coverage.
      if (
        [...(includes ?? []), ...(excludes ?? [])].some((pattern) =>
          /[\[\]]|[?*+@!]\(/.test(pattern),
        )
      )
        continue;
      if (excludes?.some((pattern) => matchesPattern(relativePath, pattern))) continue;
      // Without an explicit replacement, keep the conservative union of
      // discovery exclusions across supported runner generations. A false
      // negative leaves the original command intact; a false positive could
      // claim coverage from a suite that never collected this file.
      if (runner.runner === "jest" && /(?:^|\/)node_modules\//.test(relativePath)) continue;
      if (
        runner.runner === "vitest" &&
        excludes === undefined &&
        (/(?:^|\/)(?:node_modules|dist|cypress|\.idea|\.git|\.cache|\.output|\.temp)\//.test(
          relativePath,
        ) ||
          /(?:^|\/)(?:karma|rollup|webpack|vite|vitest|jest|ava|babel|nyc|cypress|tsup|build|eslint|prettier)\.config\./.test(
            relativePath,
          ))
      )
        continue;
      if (includes && !includes.some((pattern) => matchesPattern(selectedPath, pattern))) continue;
      if (!includes && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath)) continue;
      // A matching literal selector identifies its intended suite even in a
      // mixed-runner repo. Otherwise require explicit file-level runner evidence
      // and a unique compatible script; dependency presence is not ownership.
      const score = includes?.length ? 2 : requiredRunner ? 1 : 0;
      if (score) candidates.push({ command: packageScriptCommand(root, directory, name), score });
    }
    const strongest = Math.max(0, ...candidates.map((candidate) => candidate.score));
    const selected = candidates.filter((candidate) => candidate.score === strongest);
    if (strongest === 2 || selected.length === 1)
      return selected.map((candidate) => candidate.command);
    return []; // Ambiguous owning package: never borrow a parent/sibling suite.
  }
  return [];
}

/**
 * Replace synthesized direct Bun test-file commands with evidence-backed native
 * package scripts. Preserve unmatched files and never rewrite required gates.
 * Running the script unchanged retains pools, setup, environment, and config;
 * do not guess how an arbitrary script forwards appended file filters.
 */
export function routeRepositoryFocusedTestCommand(repoRoot: string, command: string): string[] {
  const root = resolve(repoRoot);
  const argv = tokenizeTrustedValidationCommand(command);
  if (!argv || argv[0] !== "bun") return [command];
  let index = 1;
  let cwd = root;
  if (argv[index] === "--cwd") {
    cwd = resolve(root, argv[index + 1] ?? ".");
    index += 2;
  }
  if (!within(root, cwd) || argv[index] !== "test") return [command];
  const tail = argv.slice(index + 1);
  const targets: Array<{ path: string; index: number }> = [];
  // The full configured suite covers Bun name filters/timeouts without
  // translating runner-specific flags. Preserve those flags on unmatched Bun
  // files and leave unknown options untouched instead of guessing semantics.
  const narrowOptions = new Set(["-t", "--test-name-pattern", "--timeout"]);
  for (let cursor = 0; cursor < tail.length; cursor += 1) {
    const token = tail[cursor];
    if (narrowOptions.has(token)) {
      if (!tail[cursor + 1]) return [command];
      cursor += 1;
      continue;
    }
    if (token.includes("=") && narrowOptions.has(token.split("=", 1)[0])) continue;
    if (token.startsWith("-") || !/\.[cm]?[jt]sx?$/i.test(token)) return [command];
    targets.push({ path: token, index: cursor });
  }
  if (!targets.length || targets.length > 16) return [command];
  const output: string[] = [];
  const routedIndexes = new Set<number>();
  for (const target of targets) {
    const resolved = resolve(cwd, target.path);
    const routed = within(root, resolved) ? commandsForTest(root, resolved) : [];
    if (routed.length) {
      output.push(...routed);
      routedIndexes.add(target.index);
    }
  }
  if (!output.length) return [command];
  if (routedIndexes.size < targets.length)
    output.push(
      [...argv.slice(0, index + 1), ...tail.filter((_, tailIndex) => !routedIndexes.has(tailIndex))]
        .map(quote)
        .join(" "),
    );
  return [...new Set(output)];
}
