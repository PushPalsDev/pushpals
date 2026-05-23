import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, resolve } from "path";

function stringEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
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
  const env = stringEnv(sourceEnv);
  const originalHome = resolveOriginalHome(env);
  const codexHome = resolveCodexHome(env, originalHome);
  const baseDir = resolve(tmpdir(), "pushpals-worker-env", safeRepoSlug(repo));
  const homeDir = resolve(baseDir, "home");
  const cacheDir = resolve(baseDir, "cache");
  const expoDir = resolve(baseDir, "expo");
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
  ensureDirs([homeDir, cacheDir, expoDir, resolve(cacheDir, "npm"), playwrightBrowsersDir]);
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
    EXPO_DEV_SERVER_PORT: env.EXPO_DEV_SERVER_PORT ?? defaultExpoPort,
    RCT_METRO_PORT: env.RCT_METRO_PORT ?? defaultExpoPort,
    PUSHPALS_VALIDATION_REPO: repo,
  };
}
