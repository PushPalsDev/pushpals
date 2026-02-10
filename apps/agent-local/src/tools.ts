import { resolve, normalize, relative, dirname, join } from "path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  rmSync,
  copyFileSync,
  statSync,
  appendFileSync,
} from "fs";

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

// ─── General-purpose tools ──────────────────────────────────────────────────

const shellExec: ToolDefinition = {
  name: "shell.exec",
  description:
    "Run any shell command in the repo root. Use for anything not covered by other tools.",
  requiresApproval: true, // ← destructive by default, requires user approval
  timeout: 60_000,
  async execute(args, ctx) {
    let command = args.command as string;
    if (!command) return { ok: false, stderr: "Missing 'command' argument", exitCode: 1 };

    const isWindows = process.platform === "win32";
    const shell = isWindows ? ["cmd", "/c", command] : ["bash", "-c", command];
    const cwd = (args.cwd as string)
      ? sanitizePath(ctx.repoRoot, args.cwd as string)
      : ctx.repoRoot;

    const r = await safeExec(shell, cwd, this.timeout);
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },
};

const fileWrite: ToolDefinition = {
  name: "file.write",
  description: "Create or overwrite a file relative to repo root",
  requiresApproval: true, // ← destructive, requires approval
  timeout: 5_000,
  async execute(args, ctx) {
    const filePath = args.path as string;
    const content = args.content as string;
    if (!filePath) return { ok: false, stderr: "Missing 'path' argument", exitCode: 1 };
    if (content === undefined || content === null)
      return { ok: false, stderr: "Missing 'content' argument", exitCode: 1 };

    try {
      const resolved = sanitizePath(ctx.repoRoot, filePath);
      // Ensure parent directory exists
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, content, "utf-8");
      return {
        ok: true,
        stdout: `Wrote ${content.length} bytes to ${filePath}`,
        exitCode: 0,
      };
    } catch (err) {
      return { ok: false, stderr: String(err), exitCode: 1 };
    }
  },
};

const filePatch: ToolDefinition = {
  name: "file.patch",
  description: "Apply a text replacement to a file: replace 'oldText' with 'newText'",
  requiresApproval: true,
  timeout: 5_000,
  async execute(args, ctx) {
    const filePath = args.path as string;
    const oldText = args.oldText as string;
    const newText = args.newText as string;
    if (!filePath) return { ok: false, stderr: "Missing 'path' argument", exitCode: 1 };
    if (oldText === undefined)
      return { ok: false, stderr: "Missing 'oldText' argument", exitCode: 1 };
    if (newText === undefined)
      return { ok: false, stderr: "Missing 'newText' argument", exitCode: 1 };

    try {
      const resolved = sanitizePath(ctx.repoRoot, filePath);
      const current = readFileSync(resolved, "utf-8");
      if (!current.includes(oldText)) {
        return { ok: false, stderr: `oldText not found in ${filePath}`, exitCode: 1 };
      }
      const updated = current.replace(oldText, newText);
      writeFileSync(resolved, updated, "utf-8");
      return {
        ok: true,
        stdout: `Patched ${filePath}: replaced ${oldText.length} chars with ${newText.length} chars`,
        exitCode: 0,
      };
    } catch (err) {
      return { ok: false, stderr: String(err), exitCode: 1 };
    }
  },
};

const fileRename: ToolDefinition = {
  name: "file.rename",
  description: "Rename or move a file/directory relative to repo root",
  requiresApproval: true,
  timeout: 5_000,
  async execute(args, ctx) {
    const from = args.from as string;
    const to = args.to as string;
    if (!from) return { ok: false, stderr: "Missing 'from' argument", exitCode: 1 };
    if (!to) return { ok: false, stderr: "Missing 'to' argument", exitCode: 1 };

    try {
      const resolvedFrom = sanitizePath(ctx.repoRoot, from);
      const resolvedTo = sanitizePath(ctx.repoRoot, to);
      mkdirSync(dirname(resolvedTo), { recursive: true });
      renameSync(resolvedFrom, resolvedTo);
      return { ok: true, stdout: `Renamed ${from} → ${to}`, exitCode: 0 };
    } catch (err) {
      return { ok: false, stderr: String(err), exitCode: 1 };
    }
  },
};

const fileDelete: ToolDefinition = {
  name: "file.delete",
  description: "Delete a file or directory (recursive) relative to repo root",
  requiresApproval: true,
  timeout: 5_000,
  async execute(args, ctx) {
    const filePath = args.path as string;
    if (!filePath) return { ok: false, stderr: "Missing 'path' argument", exitCode: 1 };

    try {
      const resolved = sanitizePath(ctx.repoRoot, filePath);
      const stat = statSync(resolved);
      if (stat.isDirectory()) {
        rmSync(resolved, { recursive: true });
        return { ok: true, stdout: `Deleted directory ${filePath}`, exitCode: 0 };
      } else {
        unlinkSync(resolved);
        return { ok: true, stdout: `Deleted ${filePath}`, exitCode: 0 };
      }
    } catch (err) {
      return { ok: false, stderr: String(err), exitCode: 1 };
    }
  },
};

const fileCopy: ToolDefinition = {
  name: "file.copy",
  description: "Copy a file relative to repo root",
  requiresApproval: true,
  timeout: 5_000,
  async execute(args, ctx) {
    const from = args.from as string;
    const to = args.to as string;
    if (!from) return { ok: false, stderr: "Missing 'from' argument", exitCode: 1 };
    if (!to) return { ok: false, stderr: "Missing 'to' argument", exitCode: 1 };

    try {
      const resolvedFrom = sanitizePath(ctx.repoRoot, from);
      const resolvedTo = sanitizePath(ctx.repoRoot, to);
      mkdirSync(dirname(resolvedTo), { recursive: true });
      copyFileSync(resolvedFrom, resolvedTo);
      return { ok: true, stdout: `Copied ${from} → ${to}`, exitCode: 0 };
    } catch (err) {
      return { ok: false, stderr: String(err), exitCode: 1 };
    }
  },
};

const fileAppend: ToolDefinition = {
  name: "file.append",
  description: "Append text to the end of a file",
  requiresApproval: true,
  timeout: 5_000,
  async execute(args, ctx) {
    const filePath = args.path as string;
    const content = args.content as string;
    if (!filePath) return { ok: false, stderr: "Missing 'path' argument", exitCode: 1 };
    if (content === undefined || content === null)
      return { ok: false, stderr: "Missing 'content' argument", exitCode: 1 };

    try {
      const resolved = sanitizePath(ctx.repoRoot, filePath);
      mkdirSync(dirname(resolved), { recursive: true });
      appendFileSync(resolved, content, "utf-8");
      return { ok: true, stdout: `Appended ${content.length} bytes to ${filePath}`, exitCode: 0 };
    } catch (err) {
      return { ok: false, stderr: String(err), exitCode: 1 };
    }
  },
};

const fileMkdir: ToolDefinition = {
  name: "file.mkdir",
  description: "Create a directory (and all parent directories) relative to repo root",
  requiresApproval: true,
  timeout: 5_000,
  async execute(args, ctx) {
    const dirPath = args.path as string;
    if (!dirPath) return { ok: false, stderr: "Missing 'path' argument", exitCode: 1 };

    try {
      const resolved = sanitizePath(ctx.repoRoot, dirPath);
      mkdirSync(resolved, { recursive: true });
      return { ok: true, stdout: `Created directory ${dirPath}`, exitCode: 0 };
    } catch (err) {
      return { ok: false, stderr: String(err), exitCode: 1 };
    }
  },
};

const webFetch: ToolDefinition = {
  name: "web.fetch",
  description: "Fetch the content of a URL and return the response body (text/HTML/JSON)",
  requiresApproval: false,
  timeout: 30_000,
  async execute(args, _ctx) {
    const url = args.url as string;
    if (!url) return { ok: false, stderr: "Missing 'url' argument", exitCode: 1 };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      const res = await fetch(url, {
        headers: { "User-Agent": "PushPals/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();

      // For HTML, strip tags to extract readable text
      let output: string;
      if (contentType.includes("html")) {
        output = body
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      } else {
        output = body;
      }

      return {
        ok: res.ok,
        stdout: truncate(output),
        stderr: res.ok ? undefined : `HTTP ${res.status} ${res.statusText}`,
        exitCode: res.ok ? 0 : 1,
      };
    } catch (err) {
      return { ok: false, stderr: String(err), exitCode: 1 };
    }
  },
};

const webSearch: ToolDefinition = {
  name: "web.search",
  description: "Search the web using DuckDuckGo Lite and return results",
  requiresApproval: false,
  timeout: 20_000,
  async execute(args, _ctx) {
    const query = args.query as string;
    if (!query) return { ok: false, stderr: "Missing 'query' argument", exitCode: 1 };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "PushPals/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const html = await res.text();

      // Extract search result links and snippets from DDG Lite HTML
      const results: string[] = [];
      const linkRegex = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
      const snippetRegex = /<td class="result-snippet">([^<]+)<\/td>/gi;

      const links: { url: string; title: string }[] = [];
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        links.push({ url: match[1], title: match[2].trim() });
      }

      const snippets: string[] = [];
      while ((match = snippetRegex.exec(html)) !== null) {
        snippets.push(match[1].trim());
      }

      for (let i = 0; i < Math.min(links.length, 10); i++) {
        const snippet = snippets[i] ? `\n  ${snippets[i]}` : "";
        results.push(`${i + 1}. ${links[i].title}\n  ${links[i].url}${snippet}`);
      }

      if (results.length === 0) {
        // Fallback: extract any links from the page
        const anyLink = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
        const fallback: string[] = [];
        while ((match = anyLink.exec(html)) !== null && fallback.length < 10) {
          if (!match[1].includes("duckduckgo.com")) {
            fallback.push(`- ${match[2].trim()}: ${match[1]}`);
          }
        }
        return {
          ok: true,
          stdout: fallback.length > 0 ? fallback.join("\n") : "No results found.",
          exitCode: 0,
        };
      }

      return { ok: true, stdout: results.join("\n\n"), exitCode: 0 };
    } catch (err) {
      return { ok: false, stderr: String(err), exitCode: 1 };
    }
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
      fileWrite,
      filePatch,
      fileRename,
      fileDelete,
      fileCopy,
      fileAppend,
      fileMkdir,
      ciStatus,
      projectSummary,
      shellExec,
      webFetch,
      webSearch,
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
    return name === "bun.test" || name === "bun.lint" || name === "shell.exec";
  }
}
