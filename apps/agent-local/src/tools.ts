import { resolve, normalize, relative } from "path";

// ─── Tool definition ────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  requiresApproval: boolean;
  /** Max execution time in ms */
  timeout: number;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
}

export interface ToolContext {
  repoRoot: string;
}

export interface ToolOutput {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  artifacts?: Array<{ kind: string; uri?: string; text?: string }>;
}

// ─── Safety helpers ─────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB

function truncate(s: string | undefined, max = MAX_OUTPUT_BYTES): string | undefined {
  if (!s) return s;
  if (s.length > max) return s.substring(0, max) + "\n… (truncated)";
  return s;
}

/** Ensure path doesn't escape repo root via `..` */
function sanitizePath(repoRoot: string, filePath: string): string {
  const resolved = resolve(repoRoot, filePath);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..") || resolve(repoRoot, rel) !== resolved) {
    throw new Error(`Path escapes repo root: ${filePath}`);
  }
  return resolved;
}

/** Run a shell command with timeout and output size limits */
async function safeExec(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch (_e) {}
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timer);
  const exitCode = await proc.exited;

  return {
    stdout: truncate(stdout) ?? "",
    stderr: truncate(stderr) ?? "",
    exitCode,
  };
}

// ─── Tool implementations ───────────────────────────────────────────────────

const gitStatus: ToolDefinition = {
  name: "git.status",
  description: "Run `git status --porcelain` in the repo root",
  requiresApproval: false,
  timeout: 10_000,
  async execute(_args, ctx) {
    const r = await safeExec(["git", "status", "--porcelain"], ctx.repoRoot, this.timeout);
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },
};

const gitDiff: ToolDefinition = {
  name: "git.diff",
  description: "Run `git diff` (optionally staged) in the repo root",
  requiresApproval: false,
  timeout: 15_000,
  async execute(args, ctx) {
    const flags = args.staged ? ["git", "diff", "--staged"] : ["git", "diff"];
    const r = await safeExec(flags, ctx.repoRoot, this.timeout);
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },
};

const gitApplyPatch: ToolDefinition = {
  name: "git.applyPatch",
  description: "Apply a unified diff patch via `git apply`",
  requiresApproval: true, // ← Needs user approval
  timeout: 15_000,
  async execute(args, ctx) {
    const patch = args.patch as string;
    if (!patch) return { ok: false, stderr: "Missing patch argument", exitCode: 1 };

    // Write patch to a temp file
    const tmpPath = resolve(ctx.repoRoot, ".pushpals-patch.tmp");
    await Bun.write(tmpPath, patch);

    try {
      const r = await safeExec(["git", "apply", tmpPath], ctx.repoRoot, this.timeout);
      return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    } finally {
      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(tmpPath);
      } catch (_e) {}
    }
  },
};

const bunTest: ToolDefinition = {
  name: "bun.test",
  description: "Run `bun test` in the repo root",
  requiresApproval: false,
  timeout: 60_000,
  async execute(args, ctx) {
    const cmd = ["bun", "test"];
    if (args.filter) cmd.push("--filter", args.filter as string);
    const r = await safeExec(cmd, ctx.repoRoot, this.timeout);
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },
};

const bunLint: ToolDefinition = {
  name: "bun.lint",
  description: "Run linter (bun run lint) in the repo root",
  requiresApproval: false,
  timeout: 30_000,
  async execute(_args, ctx) {
    const r = await safeExec(["bun", "run", "lint"], ctx.repoRoot, this.timeout);
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },
};

const fileRead: ToolDefinition = {
  name: "file.read",
  description: "Read a file relative to repo root",
  requiresApproval: false,
  timeout: 5_000,
  async execute(args, ctx) {
    const filePath = args.path as string;
    if (!filePath) return { ok: false, stderr: "Missing path argument", exitCode: 1 };

    try {
      const resolved = sanitizePath(ctx.repoRoot, filePath);
      const content = await Bun.file(resolved).text();
      return { ok: true, stdout: truncate(content), exitCode: 0 };
    } catch (err) {
      return { ok: false, stderr: String(err), exitCode: 1 };
    }
  },
};

const fileSearch: ToolDefinition = {
  name: "file.search",
  description: "Search for a pattern using ripgrep (rg) or grep fallback",
  requiresApproval: false,
  timeout: 15_000,
  async execute(args, ctx) {
    const pattern = args.pattern as string;
    if (!pattern) return { ok: false, stderr: "Missing pattern argument", exitCode: 1 };

    const glob = (args.glob as string) ?? "";
    const cmd = glob
      ? ["rg", "--no-heading", "--line-number", "-g", glob, pattern]
      : ["rg", "--no-heading", "--line-number", pattern];

    try {
      const r = await safeExec(cmd, ctx.repoRoot, this.timeout);
      // rg exits 1 when no matches (not an error)
      return { ok: r.exitCode <= 1, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    } catch (_err) {
      // Fallback to grep
      const grepCmd = ["grep", "-rn", pattern, "."];
      const r = await safeExec(grepCmd, ctx.repoRoot, this.timeout);
      return { ok: r.exitCode <= 1, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    }
  },
};

// ─── Tool registry ──────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    // Register default tools
    for (const t of [gitStatus, gitDiff, gitApplyPatch, bunTest, bunLint, fileRead, fileSearch]) {
      this.tools.set(t.name, t);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Tools that should be dispatched to the worker queue instead of run locally */
  isHeavy(name: string): boolean {
    return name === "bun.test" || name === "bun.lint";
  }
}
