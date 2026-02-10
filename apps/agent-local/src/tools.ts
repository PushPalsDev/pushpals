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

// ─── New repo-awareness tools ───────────────────────────────────────────────

const gitLog: ToolDefinition = {
  name: "git.log",
  description: "Show recent commit history",
  requiresApproval: false,
  timeout: 10_000,
  async execute(args, ctx) {
    const count = Math.min(Number(args.count) || 20, 100);
    const format = (args.format as string) || "%h %s (%an, %ar)";
    const cmd = ["git", "log", `--oneline`, `--format=${format}`, `-n`, String(count)];
    if (args.branch) cmd.push(args.branch as string);
    const r = await safeExec(cmd, ctx.repoRoot, this.timeout);
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },
};

const gitBranch: ToolDefinition = {
  name: "git.branch",
  description: "List branches and show current branch",
  requiresApproval: false,
  timeout: 10_000,
  async execute(args, ctx) {
    const showAll = args.all === true;
    const cmd = showAll ? ["git", "branch", "-a", "-v"] : ["git", "branch", "-v"];
    const r = await safeExec(cmd, ctx.repoRoot, this.timeout);
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },
};

const fileList: ToolDefinition = {
  name: "file.list",
  description: "List files/directories at a path (defaults to repo root)",
  requiresApproval: false,
  timeout: 10_000,
  async execute(args, ctx) {
    const targetPath = args.path as string | undefined;
    const dir = targetPath ? sanitizePath(ctx.repoRoot, targetPath) : ctx.repoRoot;
    const maxDepth = Math.min(Number(args.depth) || 2, 5);

    // Use git ls-tree for tracked files, or fall back to find
    try {
      const treeish = targetPath ? `HEAD:${targetPath}` : "HEAD";
      const cmd = ["git", "ls-tree", "--name-only", "-r", treeish];
      const r = await safeExec(cmd, ctx.repoRoot, this.timeout);
      if (r.exitCode === 0) {
        // Limit output lines
        const lines = r.stdout.split("\n").filter(Boolean);
        const limited = lines.slice(0, 200);
        const output =
          limited.join("\n") + (lines.length > 200 ? `\n… (${lines.length - 200} more)` : "");
        return { ok: true, stdout: output, exitCode: 0 };
      }
    } catch (_e) {}

    // Fallback: simple directory listing
    const { readdirSync, statSync } = await import("fs");
    const { join, relative } = await import("path");

    function walk(d: string, depth: number): string[] {
      if (depth <= 0) return [];
      const entries: string[] = [];
      try {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const full = join(d, e.name);
          const rel = relative(ctx.repoRoot, full);
          if (e.isDirectory()) {
            entries.push(rel + "/");
            entries.push(...walk(full, depth - 1));
          } else {
            entries.push(rel);
          }
        }
      } catch (_e) {}
      return entries;
    }

    const files = walk(dir, maxDepth).slice(0, 300);
    return {
      ok: true,
      stdout: files.join("\n") + (files.length >= 300 ? "\n… (truncated)" : ""),
      exitCode: 0,
    };
  },
};

const ciStatus: ToolDefinition = {
  name: "ci.status",
  description: "Check GitHub Actions CI status for the current branch or a commit",
  requiresApproval: false,
  timeout: 15_000,
  async execute(args, ctx) {
    // Try `gh` CLI first (GitHub CLI)
    const ref = (args.ref as string) || "HEAD";
    try {
      const cmd = [
        "gh",
        "run",
        "list",
        "--limit",
        "5",
        "--json",
        "status,conclusion,name,headBranch,createdAt,url",
      ];
      const r = await safeExec(cmd, ctx.repoRoot, this.timeout);
      if (r.exitCode === 0) {
        return { ok: true, stdout: r.stdout, exitCode: 0 };
      }
    } catch (_e) {}

    // Fallback: try gh api for check runs on ref
    try {
      const cmd = [
        "gh",
        "api",
        `repos/{owner}/{repo}/commits/${ref}/check-runs`,
        "--jq",
        ".check_runs[] | {name, status, conclusion, started_at}",
      ];
      const r = await safeExec(cmd, ctx.repoRoot, this.timeout);
      if (r.exitCode === 0) {
        return { ok: true, stdout: r.stdout || "(no check runs found)", exitCode: 0 };
      }
      return {
        ok: false,
        stderr: r.stderr || "gh CLI not available or not authenticated",
        exitCode: r.exitCode,
      };
    } catch (_e) {
      return {
        ok: false,
        stderr:
          "GitHub CLI (gh) not installed or not authenticated. Install from https://cli.github.com",
        exitCode: 1,
      };
    }
  },
};

const projectSummary: ToolDefinition = {
  name: "project.summary",
  description: "Generate a high-level project overview: languages, structure, recent activity",
  requiresApproval: false,
  timeout: 20_000,
  async execute(_args, ctx) {
    const sections: string[] = [];

    // 1. Current branch
    const branch = await safeExec(["git", "rev-parse", "--abbrev-ref", "HEAD"], ctx.repoRoot, 5000);
    if (branch.exitCode === 0) sections.push(`Branch: ${branch.stdout.trim()}`);

    // 2. Recent commits (last 5)
    const log = await safeExec(
      ["git", "log", "--oneline", "-n", "5", "--format=%h %s (%ar)"],
      ctx.repoRoot,
      5000,
    );
    if (log.exitCode === 0) sections.push(`Recent commits:\n${log.stdout.trim()}`);

    // 3. Working tree status
    const status = await safeExec(["git", "status", "--porcelain"], ctx.repoRoot, 5000);
    if (status.exitCode === 0) {
      const lines = status.stdout.trim().split("\n").filter(Boolean);
      sections.push(
        lines.length === 0
          ? "Working tree: clean"
          : `Working tree: ${lines.length} changed file(s)\n${lines.slice(0, 10).join("\n")}${lines.length > 10 ? "\n…" : ""}`,
      );
    }

    // 4. Package info (if package.json exists)
    try {
      const { readFileSync } = await import("fs");
      const pkg = JSON.parse(readFileSync(resolve(ctx.repoRoot, "package.json"), "utf-8"));
      const info = [`Name: ${pkg.name ?? "(unnamed)"}`, `Version: ${pkg.version ?? "?"}`];
      if (pkg.workspaces) info.push(`Workspaces: ${JSON.stringify(pkg.workspaces)}`);
      const depCount = Object.keys(pkg.dependencies ?? {}).length;
      const devDepCount = Object.keys(pkg.devDependencies ?? {}).length;
      info.push(`Dependencies: ${depCount} prod, ${devDepCount} dev`);
      sections.push(info.join("\n"));
    } catch (_e) {
      sections.push("(no package.json found)");
    }

    // 5. Top-level directory structure
    try {
      const { readdirSync } = await import("fs");
      const entries = readdirSync(ctx.repoRoot, { withFileTypes: true })
        .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .slice(0, 30);
      sections.push(`Structure:\n${entries.join("\n")}`);
    } catch (_e) {}

    return { ok: true, stdout: sections.join("\n\n"), exitCode: 0 };
  },
};

// ─── Tool registry ──────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    // Register default tools
    for (const t of [
      gitStatus,
      gitDiff,
      gitApplyPatch,
      gitLog,
      gitBranch,
      bunTest,
      bunLint,
      fileRead,
      fileSearch,
      fileList,
      ciStatus,
      projectSummary,
    ]) {
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
