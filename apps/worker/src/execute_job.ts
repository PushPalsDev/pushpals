/**
 * Extracted job execution logic.
 * Used by both the host Worker (direct mode) and the Docker job runner.
 */

import { existsSync } from "fs";
import { resolve } from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Job kinds that modify files and should trigger commits */
export const FILE_MODIFYING_JOBS = new Set([
  "file.write",
  "file.patch",
  "file.delete",
  "file.rename",
  "file.copy",
  "file.append",
  "file.mkdir",
]);

const MAX_OUTPUT = 256 * 1024;
const OPENHANDS_RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ ";

// ─── Utilities ───────────────────────────────────────────────────────────────

export function shouldCommit(kind: string): boolean {
  return FILE_MODIFYING_JOBS.has(kind);
}

export function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.substring(0, MAX_OUTPUT) + "\n… (truncated)" : s;
}

function useOpenHandsExecutor(): boolean {
  const executor = (process.env.WORKER_EXECUTOR ?? "openhands").trim().toLowerCase();
  return !(executor === "native" || executor === "builtin" || executor === "legacy");
}

async function executeWithOpenHands(
  kind: string,
  params: Record<string, unknown>,
  repo: string,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<JobResult> {
  const pythonBin = process.env.WORKER_OPENHANDS_PYTHON ?? "python";
  const scriptPath = resolve(import.meta.dir, "..", "scripts", "openhands_executor.py");
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      summary: `OpenHands wrapper script not found: ${scriptPath}`,
      exitCode: 1,
    };
  }

  const timeoutMs = Math.max(
    10_000,
    parseInt(process.env.WORKER_OPENHANDS_TIMEOUT_MS ?? "120000", 10) || 120_000,
  );
  const payload = Buffer.from(
    JSON.stringify({
      kind,
      params,
      repo,
      timeoutMs,
    }),
    "utf-8",
  ).toString("base64");

  try {
    const proc = Bun.spawn([pythonBin, scriptPath, payload], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch (_e) {}
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      onLog ? streamLines(proc.stdout, "stdout", onLog) : new Response(proc.stdout).text(),
      onLog ? streamLines(proc.stderr, "stderr", onLog) : new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);
    const exitCode = await proc.exited;

    const lines = stdout.split(/\r?\n/);
    let parsed: Record<string, unknown> | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith(OPENHANDS_RESULT_PREFIX)) continue;
      const raw = line.slice(OPENHANDS_RESULT_PREFIX.length).trim();
      if (!raw) continue;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (_e) {
        parsed = null;
      }
      break;
    }

    const filteredStdout = lines
      .filter((line) => !line.trim().startsWith(OPENHANDS_RESULT_PREFIX))
      .join("\n")
      .trim();

    if (!parsed) {
      return {
        ok: false,
        summary: `OpenHands wrapper did not return a structured result for ${kind}`,
        stdout: truncate(filteredStdout),
        stderr: truncate(stderr),
        exitCode,
      };
    }

    const summary =
      typeof parsed.summary === "string"
        ? parsed.summary
        : exitCode === 0
          ? `${kind} passed via OpenHands`
          : `${kind} failed via OpenHands (exit ${exitCode})`;
    const parsedStdout = typeof parsed.stdout === "string" ? parsed.stdout : filteredStdout;
    const parsedStderr = typeof parsed.stderr === "string" ? parsed.stderr : stderr;
    const parsedExitCode =
      typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode)
        ? parsed.exitCode
        : exitCode;
    const parsedOk = typeof parsed.ok === "boolean" ? parsed.ok : parsedExitCode === 0;

    return {
      ok: parsedOk,
      summary,
      stdout: truncate(parsedStdout ?? ""),
      stderr: truncate(parsedStderr ?? ""),
      exitCode: parsedExitCode,
    };
  } catch (err) {
    return {
      ok: false,
      summary: `OpenHands wrapper execution error for ${kind}: ${String(err)}`,
      exitCode: 1,
    };
  }
}

/** Execute a git command and return stdout */
export async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err) };
  }
}

// ─── Stream helper ───────────────────────────────────────────────────────────

/**
 * Read a process stream line-by-line, calling onLine for each.
 * Returns the full concatenated output.
 */
export async function streamLines(
  readable: ReadableStream<Uint8Array>,
  streamName: "stdout" | "stderr",
  onLine: (stream: "stdout" | "stderr", line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = readable.getReader();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    buffer += chunk;

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      onLine(streamName, clean);
    }
  }

  // Flush remaining buffer
  if (buffer.length > 0) {
    const clean = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    onLine(streamName, clean);
  }

  return full;
}

// ─── Git commit creation ─────────────────────────────────────────────────────

/** Create commit for job result and return commit info */
export async function createJobCommit(
  repo: string,
  workerId: string,
  job: { id: string; taskId: string; kind: string },
): Promise<{ ok: boolean; branch?: string; sha?: string; error?: string }> {
  const truthy = new Set(["1", "true", "yes", "on"]);
  const requirePush = truthy.has((process.env.WORKER_REQUIRE_PUSH ?? "").toLowerCase());
  const pushAgentBranch =
    requirePush || truthy.has((process.env.WORKER_PUSH_AGENT_BRANCH ?? "").toLowerCase());
  const branchName = `agent/${workerId}/${job.id}`;
  const commitMsg = `${job.kind}: ${job.taskId}\n\nJob: ${job.id}\nWorker: ${workerId}`;

  try {
    // Create/reset and checkout branch in this workspace
    let result = await git(repo, ["checkout", "-B", branchName]);
    if (!result.ok) {
      return { ok: false, error: `Failed to create branch: ${result.stderr}` };
    }

    // Stage all changes
    result = await git(repo, ["add", "-A"]);
    if (!result.ok) {
      return { ok: false, error: `Failed to stage changes: ${result.stderr}` };
    }

    // Check if there are changes to commit
    result = await git(repo, ["diff", "--cached", "--quiet"]);
    if (result.ok) {
      // No changes to commit (diff exited 0)
      console.log(`[Worker] No changes to commit for job ${job.id}`);
      // Clean up branch in detached state (safe for worktrees and direct checkouts)
      const detachResult = await git(repo, ["checkout", "--detach"]);
      if (!detachResult.ok) {
        return {
          ok: false,
          error: `No changes found, but failed to detach before branch cleanup: ${detachResult.stderr}`,
        };
      }
      const deleteResult = await git(repo, ["branch", "-D", branchName]);
      if (!deleteResult.ok) {
        return { ok: false, error: `Failed to delete empty branch: ${deleteResult.stderr}` };
      }
      return { ok: true, branch: branchName, sha: "no-changes" };
    }

    // Commit changes
    result = await git(repo, ["commit", "-m", commitMsg]);
    if (!result.ok) {
      return { ok: false, error: `Failed to commit: ${result.stderr}` };
    }

    // Get commit SHA
    result = await git(repo, ["rev-parse", "HEAD"]);
    if (!result.ok) {
      return { ok: false, error: `Failed to get commit SHA: ${result.stderr}` };
    }
    const sha = result.stdout;

    // Push branch to origin (optional; disabled by default for shared-.git workflows)
    if (pushAgentBranch) {
      result = await git(repo, ["push", "origin", branchName]);
      if (!result.ok) {
        const pushError = `Failed to push branch: ${result.stderr || result.stdout}`;
        if (requirePush) {
          return { ok: false, error: pushError };
        }
        console.warn(
          `[Worker] ${pushError}. Continuing with local branch only (set WORKER_REQUIRE_PUSH=1 to enforce push).`,
        );
        return { ok: true, branch: branchName, sha };
      }
    } else {
      console.log(
        `[Worker] Skipping push for ${branchName} (WORKER_PUSH_AGENT_BRANCH is disabled).`,
      );
    }

    console.log(`[Worker] Created commit ${sha} on branch ${branchName}`);
    return { ok: true, branch: branchName, sha };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Job execution ───────────────────────────────────────────────────────────

export interface JobResult {
  ok: boolean;
  summary: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export async function executeJob(
  kind: string,
  params: Record<string, unknown>,
  repo: string,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<JobResult> {
  if (useOpenHandsExecutor()) {
    return executeWithOpenHands(kind, params, repo, onLog);
  }

  let cmd: string[];

  switch (kind) {
    case "bun.test": {
      cmd = ["bun", "test"];
      if (params.filter) cmd.push("--filter", params.filter as string);
      break;
    }
    case "bun.lint": {
      cmd = ["bun", "run", "lint"];
      break;
    }
    case "git.status": {
      cmd = ["git", "status", "--porcelain"];
      break;
    }
    case "git.log": {
      const count = Math.min(Number(params.count) || 20, 100);
      cmd = ["git", "log", "--oneline", `--format=%h %s (%an, %ar)`, `-n`, String(count)];
      if (params.branch) cmd.push(params.branch as string);
      break;
    }
    case "git.branch": {
      cmd = params.all === true ? ["git", "branch", "-a", "-v"] : ["git", "branch", "-v"];
      break;
    }
    case "git.diff": {
      cmd = ["git", "diff"];
      break;
    }
    case "file.read": {
      const filePath = params.path as string;
      if (!filePath) return { ok: false, summary: "file.read requires a 'path' param" };
      cmd = ["cat", filePath];
      break;
    }
    case "file.search": {
      const pattern = params.pattern as string;
      if (!pattern) return { ok: false, summary: "file.search requires a 'pattern' param" };
      cmd = ["grep", "-rn", pattern, "."];
      break;
    }
    case "file.list": {
      cmd = ["git", "ls-tree", "--name-only", "-r", "HEAD"];
      break;
    }
    case "ci.status": {
      cmd = [
        "gh",
        "run",
        "list",
        "--limit",
        "5",
        "--json",
        "status,conclusion,name,headBranch,createdAt,url",
      ];
      break;
    }
    case "project.summary": {
      cmd = ["git", "log", "--oneline", "-n", "5"];
      break;
    }
    case "shell.exec": {
      let command = params.command as string;
      if (!command) return { ok: false, summary: "shell.exec requires a 'command' param" };
      const isWindows = process.platform === "win32";
      cmd = isWindows ? ["cmd", "/c", command] : ["bash", "-c", command];
      break;
    }
    case "file.write": {
      const filePath = params.path as string;
      const content = params.content as string;
      if (!filePath) return { ok: false, summary: "file.write requires a 'path' param" };
      if (content === undefined)
        return { ok: false, summary: "file.write requires a 'content' param" };
      try {
        const { mkdirSync, writeFileSync } = await import("fs");
        const { dirname, resolve } = await import("path");
        const resolved = resolve(repo, filePath);
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, content, "utf-8");
        return {
          ok: true,
          summary: `Wrote ${content.length} bytes to ${filePath}`,
          stdout: `Wrote ${content.length} bytes to ${filePath}`,
        };
      } catch (err) {
        return { ok: false, summary: `file.write error: ${err}` };
      }
    }
    case "file.patch": {
      const filePath = params.path as string;
      const oldText = params.oldText as string;
      const newText = params.newText as string;
      if (!filePath) return { ok: false, summary: "file.patch requires a 'path' param" };
      if (oldText === undefined)
        return { ok: false, summary: "file.patch requires an 'oldText' param" };
      if (newText === undefined)
        return { ok: false, summary: "file.patch requires a 'newText' param" };
      try {
        const { readFileSync, writeFileSync } = await import("fs");
        const { resolve } = await import("path");
        const resolved = resolve(repo, filePath);
        const current = readFileSync(resolved, "utf-8");
        if (!current.includes(oldText)) {
          return { ok: false, summary: `oldText not found in ${filePath}` };
        }
        const updated = current.replace(oldText, newText);
        writeFileSync(resolved, updated, "utf-8");
        return {
          ok: true,
          summary: `Patched ${filePath}`,
          stdout: `Replaced ${oldText.length} chars with ${newText.length} chars in ${filePath}`,
        };
      } catch (err) {
        return { ok: false, summary: `file.patch error: ${err}` };
      }
    }
    case "file.rename": {
      const from = params.from as string;
      const to = params.to as string;
      if (!from) return { ok: false, summary: "file.rename requires a 'from' param" };
      if (!to) return { ok: false, summary: "file.rename requires a 'to' param" };
      try {
        const { renameSync, mkdirSync } = await import("fs");
        const { resolve, dirname } = await import("path");
        const resolvedFrom = resolve(repo, from);
        const resolvedTo = resolve(repo, to);
        mkdirSync(dirname(resolvedTo), { recursive: true });
        renameSync(resolvedFrom, resolvedTo);
        return {
          ok: true,
          summary: `Renamed ${from} → ${to}`,
          stdout: `Renamed ${from} → ${to}`,
        };
      } catch (err) {
        return { ok: false, summary: `file.rename error: ${err}` };
      }
    }
    case "file.delete": {
      const filePath = params.path as string;
      if (!filePath) return { ok: false, summary: "file.delete requires a 'path' param" };
      try {
        const { statSync, unlinkSync, rmSync } = await import("fs");
        const { resolve } = await import("path");
        const resolved = resolve(repo, filePath);
        const stat = statSync(resolved);
        if (stat.isDirectory()) {
          rmSync(resolved, { recursive: true });
          return {
            ok: true,
            summary: `Deleted directory ${filePath}`,
            stdout: `Deleted directory ${filePath}`,
          };
        } else {
          unlinkSync(resolved);
          return { ok: true, summary: `Deleted ${filePath}`, stdout: `Deleted ${filePath}` };
        }
      } catch (err) {
        return { ok: false, summary: `file.delete error: ${err}` };
      }
    }
    case "file.copy": {
      const from = params.from as string;
      const to = params.to as string;
      if (!from) return { ok: false, summary: "file.copy requires a 'from' param" };
      if (!to) return { ok: false, summary: "file.copy requires a 'to' param" };
      try {
        const { copyFileSync, mkdirSync } = await import("fs");
        const { resolve, dirname } = await import("path");
        const resolvedFrom = resolve(repo, from);
        const resolvedTo = resolve(repo, to);
        mkdirSync(dirname(resolvedTo), { recursive: true });
        copyFileSync(resolvedFrom, resolvedTo);
        return {
          ok: true,
          summary: `Copied ${from} → ${to}`,
          stdout: `Copied ${from} → ${to}`,
        };
      } catch (err) {
        return { ok: false, summary: `file.copy error: ${err}` };
      }
    }
    case "file.append": {
      const filePath = params.path as string;
      const content = params.content as string;
      if (!filePath) return { ok: false, summary: "file.append requires a 'path' param" };
      if (content === undefined)
        return { ok: false, summary: "file.append requires a 'content' param" };
      try {
        const { appendFileSync, mkdirSync } = await import("fs");
        const { resolve, dirname } = await import("path");
        const resolved = resolve(repo, filePath);
        mkdirSync(dirname(resolved), { recursive: true });
        appendFileSync(resolved, content, "utf-8");
        return {
          ok: true,
          summary: `Appended ${content.length} bytes to ${filePath}`,
          stdout: `Appended ${content.length} bytes to ${filePath}`,
        };
      } catch (err) {
        return { ok: false, summary: `file.append error: ${err}` };
      }
    }
    case "file.mkdir": {
      const dirPath = params.path as string;
      if (!dirPath) return { ok: false, summary: "file.mkdir requires a 'path' param" };
      try {
        const { mkdirSync } = await import("fs");
        const { resolve } = await import("path");
        const resolved = resolve(repo, dirPath);
        mkdirSync(resolved, { recursive: true });
        return {
          ok: true,
          summary: `Created directory ${dirPath}`,
          stdout: `Created directory ${dirPath}`,
        };
      } catch (err) {
        return { ok: false, summary: `file.mkdir error: ${err}` };
      }
    }
    case "web.fetch": {
      const url = params.url as string;
      if (!url) return { ok: false, summary: "web.fetch requires a 'url' param" };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25_000);
        const res = await fetch(url, {
          headers: { "User-Agent": "PushPals/1.0" },
          signal: controller.signal,
        });
        clearTimeout(timer);
        const body = await res.text();
        const contentType = res.headers.get("content-type") ?? "";
        let output = body;
        if (contentType.includes("html")) {
          output = body
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }
        return {
          ok: res.ok,
          summary: res.ok ? `Fetched ${url} (${output.length} chars)` : `HTTP ${res.status}`,
          stdout: truncate(output),
        };
      } catch (err) {
        return { ok: false, summary: `web.fetch error: ${err}` };
      }
    }
    case "web.search": {
      const query = params.query as string;
      if (!query) return { ok: false, summary: "web.search requires a 'query' param" };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
        const res = await fetch(searchUrl, {
          headers: { "User-Agent": "PushPals/1.0" },
          signal: controller.signal,
        });
        clearTimeout(timer);
        const html = await res.text();
        const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
        const results: string[] = [];
        let match;
        while ((match = linkRegex.exec(html)) !== null && results.length < 10) {
          if (!match[1].includes("duckduckgo.com")) {
            results.push(`${results.length + 1}. ${match[2].trim()}\n  ${match[1]}`);
          }
        }
        return {
          ok: true,
          summary: `${results.length} search results for "${query}"`,
          stdout: results.length > 0 ? results.join("\n\n") : "No results found.",
        };
      } catch (err) {
        return { ok: false, summary: `web.search error: ${err}` };
      }
    }
    default:
      return { ok: false, summary: `Unknown job kind: ${kind}` };
  }

  try {
    const proc = Bun.spawn(cmd, {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch (_e) {}
    }, 60_000); // 60s timeout

    const [stdout, stderr] = await Promise.all([
      onLog ? streamLines(proc.stdout, "stdout", onLog) : new Response(proc.stdout).text(),
      onLog ? streamLines(proc.stderr, "stderr", onLog) : new Response(proc.stderr).text(),
    ]);

    clearTimeout(timer);
    const exitCode = await proc.exited;

    return {
      ok: exitCode === 0,
      summary: exitCode === 0 ? `${kind} passed` : `${kind} failed (exit ${exitCode})`,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      exitCode,
    };
  } catch (err) {
    return { ok: false, summary: `Error executing ${kind}: ${err}` };
  }
}
