import { isAbsolute, relative, resolve } from "path";

/** All paths received by inference are absolute. Implementations must never fall back to host I/O. */
export interface RepoValidationFileSystem {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  fileNames(directory: string): string[];
  readText(path: string, maxBytes: number): { text: string; truncated: boolean };
}

/** Metadata and bounded contents of an already host-verified regular repository file. */
export type ValidationSnapshotFile = {
  path: string;
  text?: string;
  truncated?: boolean;
};

/** Loading failed/incomplete is not evidence that a repository lacks validation. */
export class ValidationSnapshotUnavailableError extends Error {
  constructor() {
    super("Required validation snapshot content is unavailable or truncated");
    this.name = "ValidationSnapshotUnavailableError";
  }
}

/** The only manifest contents consulted by the shared inference rules. Other markers need metadata only. */
export function validationManifestReadLimit(path: string): number | null {
  const segments = path.replace(/\\/g, "/").split("/");
  const name = segments[segments.length - 1] ?? "";
  if (["package.json", "composer.json"].includes(name)) return 512 * 1024;
  if (name === "Makefile") return 300_000;
  if (
    [
      "pyproject.toml",
      "setup.cfg",
      "setup.py",
      "pytest.ini",
      "tox.ini",
      "requirements.txt",
      "requirements-dev.txt",
      "dev-requirements.txt",
      "Rakefile",
      "pubspec.yaml",
      "deps.edn",
    ].includes(name)
  )
    return 200_000;
  return null;
}

/**
 * An immutable in-memory view, not a checkout. The caller supplies only regular
 * files verified against its current Git snapshot, excluding symlinks, gitlinks,
 * ignored/untracked files and special files before invoking this constructor.
 * Missing content is an error, never permission to read from the host worktree.
 */
export function createValidationSnapshotFileSystem(
  repoRoot: string,
  entries: readonly ValidationSnapshotFile[],
): RepoValidationFileSystem {
  const root = resolve(repoRoot);
  const files = new Map<string, { text?: string; truncated: boolean }>();
  const directories = new Set<string>([""]);
  const children = new Map<string, string[]>();
  const relativeKey = (path: string): string | null => {
    if (!isAbsolute(path)) return null;
    const key = relative(root, resolve(path)).replace(/\\/g, "/");
    return key === ".." || key.startsWith("../") || isAbsolute(key) ? null : key;
  };
  for (const entry of entries) {
    const path = entry.path.replace(/\\/g, "/");
    if (
      !path ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      /[\0\r\n]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new TypeError("Validation snapshot requires exact repository-relative file paths");
    }
    if (files.has(path)) throw new TypeError(`Duplicate validation snapshot path: ${path}`);
    files.set(path, {
      ...(entry.text === undefined ? {} : { text: entry.text }),
      truncated: entry.truncated === true,
    });
    const parts = path.split("/");
    const name = parts.pop()!;
    const parent = parts.join("/");
    const names = children.get(parent) ?? [];
    names.push(name);
    children.set(parent, names);
    while (parts.length) {
      directories.add(parts.join("/"));
      parts.pop();
    }
  }
  for (const names of children.values()) names.sort();
  return {
    exists(path) {
      const key = relativeKey(path);
      return key !== null && (files.has(key) || directories.has(key));
    },
    isDirectory(path) {
      const key = relativeKey(path);
      return key !== null && directories.has(key);
    },
    fileNames(directory) {
      const key = relativeKey(directory);
      return key === null ? [] : [...(children.get(key) ?? [])];
    },
    readText(path, maxBytes) {
      const key = relativeKey(path);
      const file = key === null ? undefined : files.get(key);
      if (!file) throw new Error("Validation snapshot path is absent");
      if (file.text === undefined || file.truncated) throw new ValidationSnapshotUnavailableError();
      const limit = Math.max(1, Math.floor(maxBytes));
      if (!Number.isFinite(limit)) throw new TypeError("Validation read limit must be finite");
      const bytes = Buffer.from(file.text, "utf8");
      if (bytes.length > limit) throw new ValidationSnapshotUnavailableError();
      return { text: file.text, truncated: false };
    },
  };
}
