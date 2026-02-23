import { existsSync, rmSync } from "fs";

export type WorktreeCleanupOptions = {
  retries?: number;
  delayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  removeFn?: (targetPath: string) => void;
  existsFn?: (targetPath: string) => boolean;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function windowsDeletionCandidates(worktreePath: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (value: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  add(worktreePath);

  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(worktreePath)) {
    // Long-path literal to avoid MAX_PATH cleanup failures.
    add(`\\\\?\\${worktreePath}`);
  }

  return out;
}

export async function forceDeleteWorktreePath(
  worktreePath: string,
  options: WorktreeCleanupOptions = {},
): Promise<{ removed: boolean; lastError?: string }> {
  const retries = Math.max(1, Math.floor(options.retries ?? 5));
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 120));
  const sleep = options.sleepFn ?? defaultSleep;
  const removePath = options.removeFn ?? ((targetPath: string) => rmSync(targetPath, { recursive: true, force: true }));
  const pathExists = options.existsFn ?? ((targetPath: string) => existsSync(targetPath));
  let lastError = "";

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (!pathExists(worktreePath)) return { removed: true };

    for (const candidate of windowsDeletionCandidates(worktreePath)) {
      try {
        removePath(candidate);
      } catch (error) {
        lastError = String(error);
      }
    }

    if (!pathExists(worktreePath)) return { removed: true };
    if (attempt < retries) await sleep(delayMs * attempt);
  }

  return {
    removed: !pathExists(worktreePath),
    ...(lastError ? { lastError } : {}),
  };
}

