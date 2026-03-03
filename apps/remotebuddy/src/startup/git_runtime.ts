export interface GitVersionInfo {
  raw: string;
  version: string;
  major: number;
  minor: number;
  patch: number;
}

export interface GitVersionRequirement {
  major: number;
  minor: number;
  patch: number;
}

export type DetectGitVersionFn = () => Promise<string | null>;

export const MIN_GIT_VERSION: GitVersionRequirement = {
  major: 2,
  minor: 39,
  patch: 0,
};

const GIT_VERSION_PREFIX = /^git version\s+/i;
const STRICT_SEMVER_CORE = /^(\d+)\.(\d+)\.(\d+)\b/;

export function parseGitVersion(raw: string | null | undefined): GitVersionInfo | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(GIT_VERSION_PREFIX, "").trim();
  if (!normalized) return null;
  const match = normalized.match(STRICT_SEMVER_CORE);
  if (!match) return null;
  const [, majorRaw, minorRaw, patchRaw] = match;
  const major = Number.parseInt(majorRaw, 10);
  const minor = Number.parseInt(minorRaw, 10);
  const patch = Number.parseInt(patchRaw, 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return {
    raw: trimmed,
    version: `${major}.${minor}.${patch}`,
    major,
    minor,
    patch,
  };
}

export function formatGitVersion(value: GitVersionRequirement | GitVersionInfo): string {
  return `${value.major}.${value.minor}.${value.patch}`;
}

export function compareGitVersions(
  info: GitVersionInfo,
  requirement: GitVersionRequirement,
): number {
  if (info.major !== requirement.major) {
    return info.major > requirement.major ? 1 : -1;
  }
  if (info.minor !== requirement.minor) {
    return info.minor > requirement.minor ? 1 : -1;
  }
  if (info.patch !== requirement.patch) {
    return info.patch > requirement.patch ? 1 : -1;
  }
  return 0;
}

export async function detectGitVersion(): Promise<string | null> {
  const proc = Bun.spawn(["git", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git --version exited with ${exitCode}`);
  }
  const output = (stdout || "").trim() || stderr.trim();
  return output || null;
}
