export type ValidationWorktreeGitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ValidationWorktreeGitCommand = (args: string[]) => Promise<ValidationWorktreeGitResult>;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function exactSha(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SHA_RE.test(normalized) ? normalized : "";
}

export class ValidationWorktreeInvariantError extends Error {
  readonly status: string;

  constructor(message: string, status = "") {
    super(message);
    this.name = "ValidationWorktreeInvariantError";
    this.status = status;
  }
}

/**
 * Validation must execute the immutable commit that publication will use. A
 * passing formatter, code generator, snapshot update, or nested git command
 * must not silently validate a dirty tree or a replacement HEAD.
 */
export async function assertExactCleanValidationWorktree(options: {
  expectedSha: string;
  phase: string;
  git: ValidationWorktreeGitCommand;
}): Promise<void> {
  const expectedSha = exactSha(options.expectedSha);
  if (!expectedSha) {
    throw new ValidationWorktreeInvariantError(
      `Trusted-validation ${options.phase} requires an exact candidate SHA.`,
    );
  }
  const head = await options.git(["rev-parse", "--verify", "HEAD^{commit}"]);
  const actualSha = head.ok ? exactSha(head.stdout) : "";
  if (actualSha !== expectedSha) {
    throw new ValidationWorktreeInvariantError(
      `Trusted-validation ${options.phase} moved HEAD from ${expectedSha} to ${actualSha || "unavailable"}; refusing publication.`,
    );
  }
  const status = await options.git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) {
    throw new ValidationWorktreeInvariantError(
      `Trusted-validation ${options.phase} could not verify worktree cleanliness: ${status.stderr || status.stdout || "git status failed"}.`,
    );
  }
  const dirty = status.stdout.trim();
  if (dirty) {
    throw new ValidationWorktreeInvariantError(
      `Trusted-validation ${options.phase} mutated the candidate worktree; refusing to publish a different tree than ${expectedSha}.\n${dirty}`,
      dirty,
    );
  }
}
