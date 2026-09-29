import { createHash } from "crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "fs";
import { basename, resolve } from "path";
import { homedir } from "os";
import { resolveGitMetadataDir } from "../../../packages/shared/src/repo.js";

const MAX_INSTALL_CONFIG_BYTES = 128 * 1024;

/** Optional optimization must not block on special files or read unbounded configuration. */
function readInstallConfig(path: string): { text: string } | "missing" | "unsafe" {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_INSTALL_CONFIG_BYTES)
    return "unsafe";
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.size > MAX_INSTALL_CONFIG_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      return "unsafe";
    const buffer = Buffer.alloc(MAX_INSTALL_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > MAX_INSTALL_CONFIG_BYTES) return "unsafe";
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)) };
  } catch {
    return "unsafe";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Cache inspection must not disrupt validation. */
      }
    }
  }
}

/** Detect operator cache ownership, not evaluate npm config or expand credentials. */
function npmrcOwnsCache(text: string): boolean {
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const declaration = line.trim();
    if (!declaration || /^[#;]/.test(declaration)) continue;
    const equals = declaration.indexOf("=");
    const rawKey = (equals < 0 ? declaration : declaration.slice(0, equals)).trim();
    const key = rawKey.replace(/^(["'])(.*)\1$/, "$2").toLowerCase();
    if (/^cache(?:\[\])?$/.test(key)) return true;
    // Unfamiliar/sectioned/escaped INI syntax cannot prove cache independence.
    // Leave Bun in charge instead of guessing and replacing an offline cache.
    if (!/^[a-z0-9_@/.:~-]+(?:\[\])?$/.test(key)) return true;
  }
  return false;
}

/**
 * Reuse Bun's native package artifacts, never a previous candidate's mutable
 * node_modules or install-hook outputs. The parent is already preserved by
 * normal CLI --clear and explicitly removed by --clear --include-caches.
 */
export function resolveTrustedDependencyArtifactCache(options: {
  repoRoot: string;
  platform?: string;
  arch?: string;
  bunVersion?: string;
  bunExecutable?: string;
  env?: Record<string, string | undefined>;
  /** The candidate checkout owns install configuration, not the planning root. */
  configRoot?: string;
  globalConfigPaths?: readonly string[];
  /** Test seam for home-level .npmrc; candidate and explicit XDG config are always checked. */
  globalNpmrcPaths?: readonly string[];
}): string | null {
  // An operator-selected cache remains operator-owned; don't silently replace
  // it, or make CLI cleanup responsible for an arbitrary external directory.
  const env = options.env ?? process.env;
  // Bun already reuses native artifacts. Do not discard an operator's warm
  // default cache or change its backend without explicit opt-in: a new scoped
  // cache and physical copies are not a proven install-speed improvement.
  if (env.PUSHPALS_TRUSTED_ISOLATED_ARTIFACT_CACHE !== "1") return null;
  if (String(env.BUN_INSTALL_CACHE_DIR ?? "").trim()) return null;
  // Preserve explicit npm compatibility configuration without assuming that a
  // particular Bun version resolves these overrides in the same way as npm.
  if (
    Object.entries(env).some(
      ([key, value]) =>
        /^npm_config_(?:cache|userconfig|globalconfig)$/i.test(key) && String(value ?? "").trim(),
    )
  )
    return null;
  const npmrcPaths = [
    resolve(options.configRoot ?? options.repoRoot, ".npmrc"),
    ...(options.globalNpmrcPaths ?? [resolve(homedir(), ".npmrc")]),
    ...(env.XDG_CONFIG_HOME ? [resolve(env.XDG_CONFIG_HOME, ".npmrc")] : []),
  ];
  for (const path of npmrcPaths) {
    const config = readInstallConfig(path);
    if (config === "unsafe" || (config !== "missing" && npmrcOwnsCache(config.text))) return null;
  }
  const configPaths = [
    resolve(options.configRoot ?? options.repoRoot, "bunfig.toml"),
    ...(options.globalConfigPaths ?? [
      resolve(homedir(), ".bunfig.toml"),
      ...(env.XDG_CONFIG_HOME ? [resolve(env.XDG_CONFIG_HOME, ".bunfig.toml")] : []),
    ]),
  ];
  for (const path of configPaths) {
    try {
      const read = readInstallConfig(path);
      if (read === "missing") continue;
      if (read === "unsafe") return null;
      const config = Bun.TOML.parse(read.text) as Record<string, any>;
      const install = config.install;
      // Preserve operator-defined/offline caches and backend choices. Malformed
      // config disables this optimization; Bun still reports the real error.
      if (install?.cache !== undefined || install?.backend !== undefined) return null;
    } catch {
      return null;
    }
  }
  const gitDir = resolveGitMetadataDir(options.repoRoot);
  if (!gitDir) return null;
  const executable =
    options.bunExecutable ||
    String(env.PUSHPALS_BUN_BIN ?? "").trim() ||
    (/^bun(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "bun");
  let executableStat: { size: number; mtimeMs: number } | null = null;
  try {
    const stat = statSync(executable);
    executableStat = { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    // PATH-resolved tools are partitioned by PATH below. This is an artifact
    // namespace, not evidence that a specific runtime passed validation.
  }
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        platform: options.platform ?? process.platform,
        arch: options.arch ?? process.arch,
        bun: options.bunVersion ?? (executable === process.execPath ? Bun.version : "external"),
        executable,
        executableStat,
        searchPath: executableStat ? null : (env.PATH ?? env.Path ?? ""),
      }),
    )
    .digest("hex");
  const cacheDir = resolve(gitDir, "pushpals", "dependencies", "trusted-packages", identity);
  try {
    mkdirSync(cacheDir, { recursive: true });
    accessSync(cacheDir, constants.W_OK);
    return cacheDir;
  } catch {
    // Cache availability is a performance concern, not validation authority.
    return null;
  }
}

export function withTrustedDependencyArtifacts(
  argv: readonly string[],
  cacheDir?: string | null,
): string[] {
  if (!cacheDir) return [...argv];
  // Lifecycle scripts still run in the exact candidate. Copying instead of
  // hardlinking prevents a hook that patches a package from changing the
  // reusable cache inode subsequently used by another candidate.
  return [...argv, "--cache-dir", resolve(cacheDir), "--backend", "copyfile"];
}
