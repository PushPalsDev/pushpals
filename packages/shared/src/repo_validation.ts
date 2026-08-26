import { closeSync, existsSync, openSync, readSync, readdirSync } from "fs";
import { basename, dirname, extname, relative, resolve } from "path";
import { tokenizeTrustedValidationCommand } from "./trusted_validation.js";

export type RepositoryValidationEcosystem =
  | "package"
  | "python"
  | "go"
  | "rust"
  | "jvm"
  | "dotnet"
  | "ruby"
  | "php"
  | "native"
  | "protobuf"
  | "swift"
  | "dart"
  | "elixir"
  | "haskell"
  | "clojure"
  | "zig"
  | "terraform"
  | "r"
  | "lua";

export interface InferRepositoryValidationStepsOptions {
  repoRoot: string;
  changedPaths?: string[];
  maxSteps?: number;
}

export interface MergeRepositoryValidationStepsOptions extends InferRepositoryValidationStepsOptions {
  existingSteps?: unknown;
}

const FALLBACK_VALIDATION_STEP = "git diff --check";
const MAX_JSON_BYTES = 1_000_000;
const MAX_PROJECT_EVIDENCE_BYTES = 256_000;

function normalizeRepoPath(value: unknown): string {
  const normalized = String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === "..") ||
    !/^[\p{L}\p{N}_@+.,()[\]/ -]+$/u.test(normalized)
  ) {
    return "";
  }
  return normalized;
}

function commandPathArg(value: string, prefixRelative = false): string {
  const normalized = normalizeRepoPath(value);
  if (!normalized) return "";
  const optionSafe = normalized.startsWith("-")
    ? `./${normalized}`
    : prefixRelative && !normalized.startsWith("./")
      ? `./${normalized}`
      : normalized;
  return /\s/.test(optionSafe) ? `"${optionSafe}"` : optionSafe;
}

function dedupe(values: string[], maxItems: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) continue;
    const key = trimmed.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

function dedupeCompletePlans(plans: string[][], maxItems: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    const pending: Array<{ value: string; key: string }> = [];
    for (const rawValue of plan) {
      const value = String(rawValue ?? "").trim();
      if (!value) continue;
      const key = value.replace(/\s+/g, " ").toLowerCase();
      if (seen.has(key) || pending.some((entry) => entry.key === key)) continue;
      pending.push({ value, key });
    }
    // A multi-command gate (for example configure -> build -> test) is one
    // atomic plan. Never truncate it into a passing setup-only fragment.
    if (out.length + pending.length > maxItems) continue;
    for (const entry of pending) {
      seen.add(entry.key);
      out.push(entry.value);
    }
  }
  return out;
}

function readTextBounded(
  path: string,
  maxBytes = MAX_PROJECT_EVIDENCE_BYTES,
): { text: string; truncated: boolean } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return {
      text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
      truncated: bytesRead > maxBytes,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close after a failed read.
      }
    }
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const read = readTextBounded(path, MAX_JSON_BYTES);
  if (!read || read.truncated) return null;
  try {
    const parsed = JSON.parse(read.text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function ecosystemForPath(path: string): RepositoryValidationEcosystem | null {
  const filename = basename(path).toLowerCase();
  const extension = extname(path).toLowerCase();

  if (
    filename === "package.json" ||
    ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"].includes(filename)
  ) {
    return "package";
  }
  if (
    ["pyproject.toml", "setup.cfg", "setup.py", "pytest.ini", "tox.ini"].includes(filename) ||
    /^requirements(?:-[^.]+)?\.txt$/.test(filename)
  ) {
    return "python";
  }
  if (filename === "go.mod" || filename === "go.sum") return "go";
  if (filename === "cargo.toml" || filename === "cargo.lock") return "rust";
  if (
    [
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
    ].includes(filename)
  ) {
    return "jvm";
  }
  if (/\.(?:sln|csproj|fsproj)$/i.test(filename)) return "dotnet";
  if (["gemfile", "rakefile", ".rspec"].includes(filename)) return "ruby";
  if (filename === "composer.json" || filename === "composer.lock") return "php";
  if (
    filename === "cmakelists.txt" ||
    ["makefile", "gnumakefile"].includes(filename) ||
    ["build", "build.bazel", "module.bazel", "workspace", "workspace.bazel"].includes(filename)
  ) {
    return "native";
  }
  if (["buf.yaml", "buf.work.yaml", "buf.gen.yaml", "buf.lock"].includes(filename)) {
    return "protobuf";
  }
  if (filename === "package.swift" || filename === "package.resolved") return "swift";
  if (["pubspec.yaml", "pubspec.lock", "analysis_options.yaml"].includes(filename)) return "dart";
  if (filename === "mix.exs" || filename === "mix.lock") return "elixir";
  if (
    filename === "cabal.project" ||
    filename === "cabal.project.local" ||
    filename === "stack.yaml" ||
    extension === ".cabal"
  ) {
    return "haskell";
  }
  if (["deps.edn", "project.clj", "build.clj"].includes(filename)) return "clojure";
  if (["build.zig", "build.zig.zon"].includes(filename)) return "zig";
  if (filename === ".terraform.lock.hcl") return "terraform";

  if (
    [
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".mjs",
      ".cjs",
      ".vue",
      ".svelte",
      ".css",
      ".scss",
      ".less",
      ".html",
      ".htm",
    ].includes(extension)
  ) {
    return "package";
  }
  if (extension === ".py") return "python";
  if (extension === ".go") return "go";
  if (extension === ".rs") return "rust";
  if ([".java", ".kt", ".kts", ".scala"].includes(extension)) return "jvm";
  if ([".cs", ".fs", ".fsx"].includes(extension)) return "dotnet";
  if (extension === ".rb") return "ruby";
  if (extension === ".php") return "php";
  if ([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"].includes(extension)) {
    return "native";
  }
  if (extension === ".proto") return "protobuf";
  if (extension === ".swift") return "swift";
  if (extension === ".dart") return "dart";
  if ([".ex", ".exs"].includes(extension)) return "elixir";
  if ([".hs", ".lhs"].includes(extension)) return "haskell";
  if ([".clj", ".cljs", ".cljc", ".edn"].includes(extension)) return "clojure";
  if (extension === ".zig") return "zig";
  if ([".tf", ".tfvars"].includes(extension)) return "terraform";
  if (extension === ".r") return "r";
  if (extension === ".lua") return "lua";
  return null;
}

function pathsByEcosystem(
  paths: string[],
): Array<{ ecosystem: RepositoryValidationEcosystem; paths: string[] }> {
  const grouped = new Map<RepositoryValidationEcosystem, string[]>();
  for (const path of paths) {
    const ecosystem = ecosystemForPath(path);
    if (!ecosystem) continue;
    const existing = grouped.get(ecosystem);
    if (existing) existing.push(path);
    else grouped.set(ecosystem, [path]);
  }
  return [...grouped.entries()].map(([ecosystem, ecosystemPaths]) => ({
    ecosystem,
    paths: ecosystemPaths,
  }));
}

function validationSearchDirectories(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (directory: string): void => {
    const normalized = directory === "." ? "" : normalizeRepoPath(directory);
    if (directory && directory !== "." && !normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  for (const path of paths) {
    let directory = dirname(path).replace(/\\/g, "/");
    while (directory && directory !== ".") {
      add(directory);
      const parent = dirname(directory).replace(/\\/g, "/");
      if (parent === directory) break;
      directory = parent;
    }
  }
  add("");
  return out;
}

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

function packageManagerAt(directory: string): PackageManager | null {
  const manifest = readJson(resolve(directory, "package.json"));
  const declared = String(manifest?.packageManager ?? "")
    .trim()
    .split("@")[0]
    ?.toLowerCase();
  if (["bun", "pnpm", "yarn", "npm"].includes(declared)) {
    return declared as PackageManager;
  }
  if (existsSync(resolve(directory, "bun.lock")) || existsSync(resolve(directory, "bun.lockb"))) {
    return "bun";
  }
  if (existsSync(resolve(directory, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(directory, "yarn.lock"))) return "yarn";
  if (existsSync(resolve(directory, "package-lock.json"))) return "npm";
  return null;
}

function resolvePackageManager(repoRoot: string, manifestDirectory: string): PackageManager {
  const absoluteRoot = resolve(repoRoot);
  let cursor = resolve(manifestDirectory);
  while (true) {
    const manager = packageManagerAt(cursor);
    if (manager) return manager;
    if (cursor === absoluteRoot) break;
    const parent = dirname(cursor);
    const relativeParent = relative(absoluteRoot, parent).replace(/\\/g, "/");
    if (parent === cursor || relativeParent.startsWith("../")) break;
    cursor = parent;
  }
  return "npm";
}

function isJavaScriptTestPath(path: string): boolean {
  return /(^|\/)(?:__tests__|tests?)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function packageValidationSteps(
  repoRoot: string,
  directory: string,
  changedPaths: string[],
): string[] | null {
  const manifestDirectory = resolve(repoRoot, directory || ".");
  const manifest = readJson(resolve(manifestDirectory, "package.json"));
  if (!manifest) return null;
  const manager = resolvePackageManager(repoRoot, manifestDirectory);
  const scripts =
    manifest.scripts && typeof manifest.scripts === "object" && !Array.isArray(manifest.scripts)
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  const directoryArg = directory ? commandPathArg(directory) : "";
  if (directory && !directoryArg) return null;

  if (manager === "bun") {
    const focusedTests = changedPaths
      .filter(isJavaScriptTestPath)
      .map((path) => {
        const relativeTest = relative(manifestDirectory, resolve(repoRoot, path)).replace(
          /\\/g,
          "/",
        );
        if (!relativeTest || relativeTest.startsWith("../")) return "";
        return commandPathArg(relativeTest, true);
      })
      .filter(Boolean)
      .slice(0, 4);
    if (focusedTests.length > 0) {
      return [`${directory ? `bun --cwd ${directoryArg}` : "bun"} test ${focusedTests.join(" ")}`];
    }
  }

  const scriptName = ["test", "check", "lint"].find((name) => {
    const script = typeof scripts[name] === "string" ? scripts[name].trim() : "";
    return Boolean(
      script &&
      !(
        name === "test" &&
        (/no test specified/i.test(script) || /(?:^|[;&|])\s*exit\s+1(?:\s|$)/i.test(script))
      ),
    );
  });
  if (!scriptName) return null;
  if (manager === "bun") {
    return [directoryArg ? `bun --cwd ${directoryArg} run ${scriptName}` : `bun run ${scriptName}`];
  }
  if (manager === "pnpm") {
    return [
      directoryArg ? `pnpm --dir ${directoryArg} run ${scriptName}` : `pnpm run ${scriptName}`,
    ];
  }
  if (manager === "yarn") {
    return [
      directoryArg ? `yarn --cwd ${directoryArg} run ${scriptName}` : `yarn run ${scriptName}`,
    ];
  }
  return [
    directoryArg ? `npm --prefix ${directoryArg} run ${scriptName}` : `npm run ${scriptName}`,
  ];
}

function pythonValidationSteps(
  repoRoot: string,
  directory: string,
  paths: string[],
): string[] | null {
  const root = resolve(repoRoot, directory || ".");
  const manifestNames = [
    "pyproject.toml",
    "setup.cfg",
    "setup.py",
    "pytest.ini",
    "tox.ini",
    "requirements.txt",
  ];
  const hasManifest = manifestNames.some((name) => existsSync(resolve(root, name)));
  const pythonPaths = paths.filter((path) => extname(path).toLowerCase() === ".py");
  if (!hasManifest) return null;

  const testPaths = pythonPaths
    .filter((path) => /(^|\/)(?:tests?|specs?)(\/|$)|(^|\/)test_[^/]+\.py$|_test\.py$/i.test(path))
    .map((path) => commandPathArg(path))
    .filter(Boolean)
    .slice(0, 4);
  let evidence = "";
  for (const name of [...manifestNames, "requirements-dev.txt", "conftest.py"]) {
    const read = readTextBounded(resolve(root, name));
    if (read) evidence += `\n${read.text}`;
  }
  if (testPaths.length > 0 || /\bpytest\b/i.test(evidence)) {
    return [`python -m pytest${testPaths.length > 0 ? ` ${testPaths.join(" ")}` : ""}`];
  }
  if (existsSync(resolve(root, "manage.py"))) {
    const managePath = commandPathArg(directory ? `${directory}/manage.py` : "manage.py");
    return managePath ? [`python ${managePath} test`] : null;
  }
  const compileTargets = pythonPaths
    .map((path) => commandPathArg(path))
    .filter(Boolean)
    .slice(0, 4);
  return compileTargets.length > 0 ? [`python -m compileall ${compileTargets.join(" ")}`] : null;
}

function goValidationSteps(repoRoot: string, directory: string): string[] | null {
  if (!existsSync(resolve(repoRoot, directory || ".", "go.mod"))) return null;
  const directoryArg = directory ? commandPathArg(directory) : "";
  return [directoryArg ? `go -C ${directoryArg} test ./...` : "go test ./..."];
}

function rustValidationSteps(repoRoot: string, directory: string): string[] | null {
  if (!existsSync(resolve(repoRoot, directory || ".", "Cargo.toml"))) return null;
  if (!directory) return ["cargo test"];
  const manifestArg = commandPathArg(`${directory}/Cargo.toml`);
  return manifestArg ? [`cargo test --manifest-path ${manifestArg}`] : null;
}

function jvmValidationSteps(repoRoot: string, directory: string): string[] | null {
  const root = resolve(repoRoot, directory || ".");
  const directoryArg = directory ? commandPathArg(directory) : "";
  if (existsSync(resolve(root, "pom.xml"))) {
    const manifestArg = commandPathArg(directory ? `${directory}/pom.xml` : "pom.xml");
    return [directory && manifestArg ? `mvn -f ${manifestArg} test` : "mvn test"];
  }
  if (existsSync(resolve(root, "build.gradle")) || existsSync(resolve(root, "build.gradle.kts"))) {
    return [directoryArg ? `gradle -p ${directoryArg} test` : "gradle test"];
  }
  return null;
}

function dotnetValidationSteps(
  repoRoot: string,
  directory: string,
  paths: string[],
): string[] | null {
  const root = resolve(repoRoot, directory || ".");
  const explicitProject = paths.find((path) => /\.(?:sln|csproj|fsproj)$/i.test(path));
  let project = explicitProject ?? "";
  if (!project) {
    try {
      const filename = readdirSync(root)
        .filter((entry) => /\.(?:sln|csproj|fsproj)$/i.test(entry))
        .sort()[0];
      project = filename ? (directory ? `${directory}/${filename}` : filename) : "";
    } catch {
      project = "";
    }
  }
  const projectArg = commandPathArg(project);
  return projectArg ? [`dotnet test ${projectArg}`] : null;
}

function rubyValidationSteps(
  repoRoot: string,
  directory: string,
  paths: string[],
): string[] | null {
  const root = resolve(repoRoot, directory || ".");
  const rubyPaths = paths.filter((path) => extname(path).toLowerCase() === ".rb");
  const hasRubyProjectEvidence =
    existsSync(resolve(root, "Gemfile")) ||
    existsSync(resolve(root, "Rakefile")) ||
    existsSync(resolve(root, ".rspec"));
  if (directory && !hasRubyProjectEvidence) return null;
  if (!directory && existsSync(resolve(root, "Gemfile"))) {
    const tests = rubyPaths
      .filter((path) => /(^|\/)spec(s)?(\/|$)|_spec\.rb$/i.test(path))
      .map((path) => commandPathArg(path))
      .filter(Boolean)
      .slice(0, 4);
    if (
      tests.length > 0 ||
      existsSync(resolve(root, "spec")) ||
      existsSync(resolve(root, ".rspec"))
    ) {
      return [`bundle exec rspec${tests.length > 0 ? ` ${tests.join(" ")}` : ""}`];
    }
    if (existsSync(resolve(root, "Rakefile"))) return ["bundle exec rake test"];
  }
  const target = commandPathArg(rubyPaths[0] ?? "");
  return target ? [`ruby -c ${target}`] : null;
}

function phpValidationSteps(repoRoot: string, directory: string, paths: string[]): string[] | null {
  const root = resolve(repoRoot, directory || ".");
  const composer = readJson(resolve(root, "composer.json"));
  if (directory && !composer) return null;
  const scripts =
    composer?.scripts && typeof composer.scripts === "object" && !Array.isArray(composer.scripts)
      ? (composer.scripts as Record<string, unknown>)
      : null;
  if (scripts?.test != null) {
    const directoryArg = directory ? commandPathArg(directory) : "";
    return [directoryArg ? `composer --working-dir ${directoryArg} test` : "composer test"];
  }
  const phpPath = paths.find((path) => extname(path).toLowerCase() === ".php") ?? "";
  const target = commandPathArg(phpPath);
  return target ? [`php -l ${target}`] : null;
}

function changedManifestAt(paths: string[], directory: string, names: string[]): boolean {
  const expectedDir = directory || ".";
  const lowerNames = new Set(names.map((name) => name.toLowerCase()));
  return paths.some((path) => {
    const pathDirectory = dirname(path).replace(/\\/g, "/");
    return (pathDirectory || ".") === expectedDir && lowerNames.has(basename(path).toLowerCase());
  });
}

function makeValidationSteps(repoRoot: string, directory: string): string[] | null {
  const root = resolve(repoRoot, directory || ".");
  const makefile = ["Makefile", "makefile", "GNUmakefile"].find((name) =>
    existsSync(resolve(root, name)),
  );
  if (!makefile) return null;
  const evidence = readTextBounded(resolve(root, makefile));
  if (!evidence) return null;
  const target = ["test", "check"].find((name) =>
    new RegExp(`^${name}\\s*:(?![=])`, "m").test(evidence.text),
  );
  if (!target) return null;
  const directoryArg = directory ? commandPathArg(directory) : "";
  return [directoryArg ? `make -C ${directoryArg} ${target}` : `make ${target}`];
}

function cmakeValidationSteps(repoRoot: string, directory: string): string[] | null {
  if (!existsSync(resolve(repoRoot, directory || ".", "CMakeLists.txt"))) return null;
  const sourceArg = directory ? commandPathArg(directory) : ".";
  const buildPath = directory ? `${directory}/build` : "build";
  const buildArg = commandPathArg(buildPath);
  if (!sourceArg || !buildArg) return null;
  return [
    `cmake -S ${sourceArg} -B ${buildArg}`,
    `cmake --build ${buildArg}`,
    `ctest --test-dir ${buildArg} --output-on-failure`,
  ];
}

function hasBazelWorkspaceAt(repoRoot: string): boolean {
  return ["MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel"].some((name) =>
    existsSync(resolve(repoRoot, name)),
  );
}

function bazelValidationSteps(repoRoot: string, directory: string): string[] | null {
  if (!hasBazelWorkspaceAt(repoRoot)) return null;
  const root = resolve(repoRoot, directory || ".");
  const hasPackage = existsSync(resolve(root, "BUILD")) || existsSync(resolve(root, "BUILD.bazel"));
  if (directory && !hasPackage) return null;
  const target = directory ? `//${directory}/...` : "//...";
  return /^\/\/[A-Za-z0-9_@+.,/-]*\.\.\.$/.test(target) ? [`bazel test ${target}`] : null;
}

function nativeValidationSteps(
  repoRoot: string,
  directory: string,
  paths: string[],
): string[] | null {
  const directCMake = changedManifestAt(paths, directory, ["CMakeLists.txt"]);
  const directMake = changedManifestAt(paths, directory, ["Makefile", "makefile", "GNUmakefile"]);
  const directBazel = changedManifestAt(paths, directory, [
    "BUILD",
    "BUILD.bazel",
    "MODULE.bazel",
    "WORKSPACE",
    "WORKSPACE.bazel",
  ]);
  if (directCMake) return cmakeValidationSteps(repoRoot, directory);
  if (directBazel) return bazelValidationSteps(repoRoot, directory);
  if (directMake) return makeValidationSteps(repoRoot, directory);
  return (
    cmakeValidationSteps(repoRoot, directory) ??
    bazelValidationSteps(repoRoot, directory) ??
    makeValidationSteps(repoRoot, directory)
  );
}

function protobufValidationSteps(repoRoot: string, directory: string): string[] | null {
  const root = resolve(repoRoot, directory || ".");
  if (!existsSync(resolve(root, "buf.yaml")) && !existsSync(resolve(root, "buf.work.yaml"))) {
    return null;
  }
  const directoryArg = directory ? commandPathArg(directory) : "";
  return [directoryArg ? `buf lint ${directoryArg}` : "buf lint"];
}

function swiftValidationSteps(repoRoot: string, directory: string): string[] | null {
  if (!existsSync(resolve(repoRoot, directory || ".", "Package.swift"))) return null;
  const directoryArg = directory ? commandPathArg(directory) : "";
  return [directoryArg ? `swift test --package-path ${directoryArg}` : "swift test"];
}

function isDartTestPath(path: string): boolean {
  return /(^|\/)(?:test|integration_test)(\/|$)|_test\.dart$/i.test(path);
}

function withoutYamlComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$|\s+#.*$/, ""))
    .join("\n");
}

function dartValidationSteps(
  repoRoot: string,
  directory: string,
  paths: string[],
): string[] | null {
  const root = resolve(repoRoot, directory || ".");
  const pubspec = readTextBounded(resolve(root, "pubspec.yaml"));
  if (!pubspec) return null;
  const pubspecEvidence = withoutYamlComments(pubspec.text);
  const executable = /\bsdk\s*:\s*flutter\b|^flutter\s*:/m.test(pubspecEvidence)
    ? "flutter"
    : "dart";
  if (directory && executable === "flutter") {
    const rootPubspec = readTextBounded(resolve(repoRoot, "pubspec.yaml"));
    if (
      !rootPubspec ||
      !/^workspace\s*:/m.test(withoutYamlComments(rootPubspec.text)) ||
      !/^resolution\s*:\s*workspace\s*$/m.test(pubspecEvidence)
    ) {
      return null;
    }
  }
  if (directory && executable === "dart") {
    const directoryArg = commandPathArg(directory);
    return directoryArg ? [`dart --directory ${directoryArg} test`] : null;
  }
  const focusedTests = paths
    .filter(isDartTestPath)
    .map((path) => commandPathArg(path))
    .filter(Boolean)
    .slice(0, 4);
  if (focusedTests.length > 0) return [`${executable} test ${focusedTests.join(" ")}`];
  if (!directory) return [`${executable} test`];
  const relativeTests = existsSync(resolve(root, "test"))
    ? `${directory}/test`
    : existsSync(resolve(root, "integration_test"))
      ? `${directory}/integration_test`
      : "";
  const target = commandPathArg(relativeTests);
  return target ? [`${executable} test ${target}`] : null;
}

function elixirValidationSteps(
  repoRoot: string,
  directory: string,
  paths: string[],
): string[] | null {
  if (!existsSync(resolve(repoRoot, directory || ".", "mix.exs"))) return null;
  if (directory) {
    const directoryArg = commandPathArg(directory);
    return directoryArg ? [`mix --cd ${directoryArg} test`] : null;
  }
  const focusedTests = paths
    .filter((path) => /(^|\/)test(\/|$)|_test\.exs$/i.test(path))
    .map((path) => commandPathArg(path))
    .filter(Boolean)
    .slice(0, 4);
  return [`mix test${focusedTests.length > 0 ? ` ${focusedTests.join(" ")}` : ""}`];
}

function hasCabalManifest(directory: string): boolean {
  if (existsSync(resolve(directory, "cabal.project"))) return true;
  try {
    return readdirSync(directory).some((entry) => entry.toLowerCase().endsWith(".cabal"));
  } catch {
    return false;
  }
}

function haskellValidationSteps(repoRoot: string, directory: string): string[] | null {
  const root = resolve(repoRoot, directory || ".");
  if (existsSync(resolve(root, "stack.yaml"))) {
    if (!directory) return ["stack test"];
    const yamlArg = commandPathArg(`${directory}/stack.yaml`);
    return yamlArg ? [`stack --stack-yaml ${yamlArg} test`] : null;
  }
  if (!directory && hasCabalManifest(root)) return ["cabal test all"];
  return null;
}

function ednMapAfterKeyword(text: string, keyword: string): string {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const keywordIndex = text.indexOf(keyword, searchFrom);
    if (keywordIndex < 0) return "";
    const next = text[keywordIndex + keyword.length] ?? "";
    if (next && /[A-Za-z0-9_!?*+.-]/.test(next)) {
      searchFrom = keywordIndex + keyword.length;
      continue;
    }
    let cursor = keywordIndex + keyword.length;
    while (cursor < text.length && /[\s,]/.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] !== "{") {
      searchFrom = cursor + 1;
      continue;
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = cursor; index < text.length; index += 1) {
      const ch = text[index] ?? "";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quoted && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(cursor, index + 1);
      }
    }
    return "";
  }
  return "";
}

function clojureValidationSteps(repoRoot: string, directory: string): string[] | null {
  if (directory) return null;
  const deps = readTextBounded(resolve(repoRoot, "deps.edn"));
  if (deps) {
    const testAlias = ednMapAfterKeyword(deps.text, ":test");
    if (/:exec-fn\b/.test(testAlias)) return ["clojure -X:test"];
    if (/:main-opts\b/.test(testAlias)) return ["clojure -M:test"];
  }
  if (existsSync(resolve(repoRoot, "project.clj"))) return ["lein test"];
  return null;
}

function zigValidationSteps(repoRoot: string, directory: string): string[] | null {
  if (!existsSync(resolve(repoRoot, directory || ".", "build.zig"))) return null;
  if (!directory) return ["zig build test"];
  const buildFile = commandPathArg(`${directory}/build.zig`);
  return buildFile ? [`zig build --build-file ${buildFile} test`] : null;
}

function terraformValidationSteps(paths: string[]): string[] | null {
  const targets = paths
    .filter((path) => [".tf", ".tfvars"].includes(extname(path).toLowerCase()))
    .map((path) => commandPathArg(path))
    .filter(Boolean)
    .slice(0, 4);
  return targets.length > 0 ? [`terraform fmt -check ${targets.join(" ")}`] : null;
}

function validationForEcosystem(
  ecosystem: RepositoryValidationEcosystem,
  repoRoot: string,
  directory: string,
  paths: string[],
): string[] | null {
  if (ecosystem === "package") return packageValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "python") return pythonValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "go") return goValidationSteps(repoRoot, directory);
  if (ecosystem === "rust") return rustValidationSteps(repoRoot, directory);
  if (ecosystem === "jvm") return jvmValidationSteps(repoRoot, directory);
  if (ecosystem === "dotnet") return dotnetValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "ruby") return rubyValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "php") return phpValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "native") return nativeValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "protobuf") return protobufValidationSteps(repoRoot, directory);
  if (ecosystem === "swift") return swiftValidationSteps(repoRoot, directory);
  if (ecosystem === "dart") return dartValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "elixir") return elixirValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "haskell") return haskellValidationSteps(repoRoot, directory);
  if (ecosystem === "clojure") return clojureValidationSteps(repoRoot, directory);
  if (ecosystem === "zig") return zigValidationSteps(repoRoot, directory);
  if (ecosystem === "terraform") return terraformValidationSteps(paths);
  return null;
}

function syntaxFallbackForEcosystem(
  ecosystem: RepositoryValidationEcosystem,
  paths: string[],
): string[] | null {
  if (ecosystem === "python") {
    const targets = paths
      .filter((path) => extname(path).toLowerCase() === ".py")
      .map((path) => commandPathArg(path))
      .filter(Boolean)
      .slice(0, 4);
    return targets.length > 0 ? [`python -m compileall ${targets.join(" ")}`] : null;
  }
  if (ecosystem === "ruby") {
    const target = commandPathArg(
      paths.find((path) => extname(path).toLowerCase() === ".rb") ?? "",
    );
    return target ? [`ruby -c ${target}`] : null;
  }
  if (ecosystem === "php") {
    const target = commandPathArg(
      paths.find((path) => extname(path).toLowerCase() === ".php") ?? "",
    );
    return target ? [`php -l ${target}`] : null;
  }
  if (ecosystem === "r") {
    const target = normalizeRepoPath(
      paths.find((path) => extname(path).toLowerCase() === ".r") ?? "",
    );
    return target ? [`Rscript -e "parse(file='${target}')"`] : null;
  }
  if (ecosystem === "lua") {
    const target = commandPathArg(
      paths.find((path) => extname(path).toLowerCase() === ".lua") ?? "",
    );
    return target ? [`luac -p ${target}`] : null;
  }
  return null;
}

function isFallbackEligiblePath(path: string): boolean {
  const filename = basename(path).toLowerCase();
  const extension = extname(path).toLowerCase();
  if (
    /^(?:readme|license|licence|changelog|contributing|authors|notice)(?:\..*)?$/.test(filename)
  ) {
    return true;
  }
  return [
    ".md",
    ".mdx",
    ".rst",
    ".adoc",
    ".txt",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".xml",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".mp3",
    ".mp4",
    ".wav",
    ".webm",
  ].includes(extension);
}

/**
 * Infer focused repository-native validation from changed paths and each
 * path's nearest owning manifest. Every returned entry is a single executable
 * invocation: no shell, chaining, command substitution, or absolute paths.
 * Unknown source ecosystems return no command instead of presenting a
 * whitespace-only check as functional validation.
 */
export function inferRepositoryValidationSteps(
  options: InferRepositoryValidationStepsOptions,
): string[] {
  const maxSteps = Math.max(1, Math.min(8, Math.floor(options.maxSteps ?? 4)));
  const repoRoot = resolve(options.repoRoot || ".");
  const paths = (options.changedPaths ?? []).map(normalizeRepoPath).filter(Boolean);
  const plans: string[][] = [];

  for (const group of pathsByEcosystem(paths)) {
    const pathsByOwner = new Map<string, string[]>();
    const pathsWithoutOwner: string[] = [];

    // Resolve ownership per path before combining plans. Looking up one owner
    // for the whole ecosystem silently skipped later packages/modules in a
    // polyglot monorepo when more than one project used the same language.
    for (const path of group.paths) {
      const owner = validationSearchDirectories([path]).find((directory) =>
        Boolean(validationForEcosystem(group.ecosystem, repoRoot, directory, [path])?.length),
      );
      if (owner === undefined) {
        pathsWithoutOwner.push(path);
        continue;
      }
      const ownerPaths = pathsByOwner.get(owner) ?? [];
      ownerPaths.push(path);
      pathsByOwner.set(owner, ownerPaths);
    }

    for (const [directory, ownerPaths] of pathsByOwner) {
      const plan = validationForEcosystem(group.ecosystem, repoRoot, directory, ownerPaths);
      if (plan?.length) plans.push(plan);
    }
    const fallback = syntaxFallbackForEcosystem(group.ecosystem, pathsWithoutOwner);
    if (fallback?.length) plans.push(fallback);
  }

  if (plans.length > 0) return dedupeCompletePlans(plans, maxSteps);
  if (paths.length === 0 || paths.every(isFallbackEligiblePath)) {
    return [FALLBACK_VALIDATION_STEP];
  }
  return [];
}

/** Merge host-prepared conflict hints with inferred repo-native validation,
 * dropping unsafe commands and the historical Bun default for other stacks. */
export function mergeRepositoryValidationSteps(
  options: MergeRepositoryValidationStepsOptions,
): string[] {
  const maxSteps = Math.max(1, Math.min(8, Math.floor(options.maxSteps ?? 8)));
  const inferred = inferRepositoryValidationSteps(options);
  const inferredUsesBun = inferred.some((step) => /^bun\b/i.test(step));
  const existing = Array.isArray(options.existingSteps)
    ? options.existingSteps
        .map((entry) => String(entry ?? "").trim())
        .filter((step) => Boolean(step) && Boolean(tokenizeTrustedValidationCommand(step)))
    : [];
  const compatibleExisting = existing.filter((step) => inferredUsesBun || !/^bun\b/i.test(step));

  if (inferred.length === 0) return [];
  return dedupe([...inferred, ...compatibleExisting], maxSteps);
}
