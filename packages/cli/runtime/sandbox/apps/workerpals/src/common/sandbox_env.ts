import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";

function stringEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function pathListDelimiter(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ";" : ":";
}

function commandLeaf(value: string): string {
  return (value.trim().replace(/\\/g, "/").split("/").pop() ?? value).toLowerCase();
}

function isBunCommandPath(value: string): boolean {
  const leaf = commandLeaf(value);
  return leaf === "bun" || leaf === "bun.exe" || leaf === "bun.cmd" || leaf === "bun.bat";
}

function normalizePathEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out = { ...env };
  const pathValue =
    platform === "win32"
      ? String(out.PATH ?? out.Path ?? "").trim()
      : String(out.PATH ?? "").trim();
  if (pathValue) {
    out.PATH = pathValue;
    if (platform === "win32") out.Path = pathValue;
  }
  return out;
}

export function resolveBunExecutableFromEnv(
  sourceEnv: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  currentExecPathOverride = process.execPath,
): string {
  const env = normalizePathEnv(stringEnv(sourceEnv), platform);
  const explicit = String(env.PUSHPALS_BUN_BIN ?? "").trim();
  if (explicit && isBunCommandPath(explicit)) return explicit;

  const currentExecPath = String(currentExecPathOverride ?? "").trim();
  if (currentExecPath && isBunCommandPath(currentExecPath)) return currentExecPath;

  const pathValue =
    platform === "win32"
      ? String(env.PATH ?? env.Path ?? "").trim()
      : String(env.PATH ?? "").trim();
  if (!pathValue) return "";

  const candidates = platform === "win32" ? ["bun.exe", "bun", "bun.cmd", "bun.bat"] : ["bun"];
  for (const rawDir of pathValue.split(pathListDelimiter(platform))) {
    const dir = rawDir.trim();
    if (!dir) continue;
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }
  return "";
}

function commandDirectory(value: string): string {
  if (!/[\\/]/.test(value)) return "";
  return dirname(value);
}

export function withResolvedBunOnPath(
  sourceEnv: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  currentExecPathOverride = process.execPath,
): Record<string, string> {
  const env = normalizePathEnv(stringEnv(sourceEnv), platform);
  const bunBin = resolveBunExecutableFromEnv(env, platform, currentExecPathOverride);
  if (!bunBin) return env;

  const out: Record<string, string> = {
    ...env,
    PUSHPALS_BUN_BIN: bunBin,
  };
  const bunDir = commandDirectory(bunBin);
  if (!bunDir) return out;

  const delimiter = pathListDelimiter(platform);
  const existing = String(out.PATH ?? out.Path ?? "").trim();
  const existingParts = existing
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  const alreadyPresent = existingParts.some((part) =>
    platform === "win32" ? part.toLowerCase() === bunDir.toLowerCase() : part === bunDir,
  );
  const nextPath = alreadyPresent ? existing : [bunDir, ...existingParts].join(delimiter);
  out.PATH = nextPath;
  if (platform === "win32") out.Path = nextPath;
  return out;
}

function safeRepoSlug(repo: string): string {
  const leaf = basename(resolve(repo)).replace(/[^A-Za-z0-9_.-]+/g, "-") || "repo";
  const hash = createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 12);
  return `${leaf}-${hash}`;
}

function browserCacheRepoKey(repo: string): string {
  const normalized = resolve(repo).replace(/\\/g, "/");
  const marker = "/.worktrees/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return resolve(repo);
  return normalized.slice(0, markerIndex);
}

function defaultExpoPortForRepo(repo: string): string {
  const hashPrefix = createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 8);
  const offset = Number.parseInt(hashPrefix, 16) % 1_000;
  return String(19_006 + offset);
}

function resolveExpoRouterAppRoot(repo: string): string | undefined {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8")) as {
      main?: unknown;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const usesExpoRouter =
      (typeof packageJson.main === "string" && packageJson.main.includes("expo-router")) ||
      packageJson.dependencies?.["expo-router"] !== undefined ||
      packageJson.devDependencies?.["expo-router"] !== undefined;
    if (!usesExpoRouter) return undefined;

    for (const candidate of [resolve(repo, "src", "app"), resolve(repo, "app")]) {
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Not every repository has a readable Node package manifest.
  }
  return undefined;
}

function ensureDirs(paths: string[]): void {
  for (const path of paths) {
    try {
      mkdirSync(path, { recursive: true });
    } catch {
      // Best effort: command output will expose any remaining filesystem blocker.
    }
  }
}

function ensureSandboxGitConfig(homeDir: string): void {
  const gitConfigPath = resolve(homeDir, ".gitconfig");
  try {
    const existing = existsSync(gitConfigPath) ? readFileSync(gitConfigPath, "utf8") : "";
    if (/(^|\n)\s*directory\s*=\s*\*/.test(existing)) return;
    const prefix = existing.trim() ? `${existing.replace(/\s+$/, "")}\n\n` : "";
    writeFileSync(gitConfigPath, `${prefix}[safe]\n\tdirectory = *\n`, "utf8");
  } catch {
    // Best effort: git will surface any remaining safe.directory blocker.
  }
}

function withWorkerNodeOptions(value: string | undefined): string {
  const options = (value ?? "").trim().split(/\s+/).filter(Boolean);
  if (!options.some((option) => option.startsWith("--dns-result-order="))) {
    options.push("--dns-result-order=ipv4first");
  }
  return options.join(" ");
}

function withWorkerNodePath(
  repo: string,
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const delimiter = pathListDelimiter(platform);
  const jobNodeModules = resolve(repo, "node_modules");
  const existing = (value ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const remaining = existing.filter(
    (entry) =>
      !(
        platform === "win32"
          ? resolve(entry).toLowerCase() === jobNodeModules.toLowerCase()
          : resolve(entry) === jobNodeModules
      ),
  );
  return [jobNodeModules, ...remaining].join(delimiter);
}

function resolveOriginalHome(env: Record<string, string>): string {
  return env.HOME || env.USERPROFILE || homedir();
}

function resolveCodexHome(env: Record<string, string>, originalHome: string): string | undefined {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  const defaultCodexHome = resolve(originalHome, ".codex");
  return existsSync(defaultCodexHome) ? defaultCodexHome : undefined;
}

export function buildWorkerSandboxWritableEnv(
  repo: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = withResolvedBunOnPath(sourceEnv);
  const originalHome = resolveOriginalHome(env);
  const codexHome = resolveCodexHome(env, originalHome);
  const baseDir = resolve(tmpdir(), "pushpals-worker-env", safeRepoSlug(repo));
  const homeDir = resolve(baseDir, "home");
  const cacheDir = resolve(baseDir, "cache");
  const expoDir = resolve(baseDir, "expo");
  const tempDir = resolve(baseDir, "tmp");
  const playwrightBrowsersDir =
    env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0"
      ? env.PLAYWRIGHT_BROWSERS_PATH
      : resolve(
          tmpdir(),
          "pushpals-worker-env",
          safeRepoSlug(browserCacheRepoKey(repo)),
          "playwright-browsers",
        );
  const defaultExpoPort = defaultExpoPortForRepo(repo);
  const expoRouterAppRoot = resolveExpoRouterAppRoot(repo);
  ensureDirs([
    homeDir,
    cacheDir,
    expoDir,
    tempDir,
    resolve(cacheDir, "npm"),
    playwrightBrowsersDir,
  ]);
  ensureSandboxGitConfig(homeDir);

  return {
    ...env,
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CACHE_HOME: cacheDir,
    npm_config_cache: resolve(cacheDir, "npm"),
    PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH ?? playwrightBrowsersDir,
    EXPO_HOME: expoDir,
    EXPO_NO_TELEMETRY: env.EXPO_NO_TELEMETRY ?? "1",
    EXPO_NO_INTERACTIVE: env.EXPO_NO_INTERACTIVE ?? "1",
    CI: env.CI ?? "1",
    BROWSER: env.BROWSER ?? "none",
    // Windows dependency snapshots use directory junctions to the host
    // checkout. Expo Router otherwise resolves its package through the
    // junction target and can render the stock tutorial even when the
    // isolated worktree has valid routes.
    ...(expoRouterAppRoot
      ? {
          EXPO_ROUTER_APP_ROOT: expoRouterAppRoot,
          // Expo's Metro transform cache is rooted under os.tmpdir() and its
          // junctioned expo-router cache key does not include the worktree
          // project root. Keep that cache worktree-local so one checkout
          // cannot reuse another checkout's empty/stale route context.
          TEMP: tempDir,
          TMP: tempDir,
          TMPDIR: tempDir,
        }
      : {}),
    // Keep canonical realpaths for caches and singletons such as Vitest, while
    // still allowing junctioned packages to resolve platform-specific
    // dependencies that exist only in the job-local dependency snapshot.
    NODE_OPTIONS: withWorkerNodeOptions(env.NODE_OPTIONS),
    NODE_PATH: withWorkerNodePath(repo, env.NODE_PATH),
    REACT_NATIVE_PACKAGER_HOSTNAME: env.REACT_NATIVE_PACKAGER_HOSTNAME ?? "127.0.0.1",
    EXPO_DEV_SERVER_PORT: env.EXPO_DEV_SERVER_PORT ?? defaultExpoPort,
    RCT_METRO_PORT: env.RCT_METRO_PORT ?? defaultExpoPort,
    PUSHPALS_VALIDATION_REPO: repo,
  };
}
