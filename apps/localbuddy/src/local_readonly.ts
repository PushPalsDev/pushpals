type QueueCounts = {
  pending: number;
  claimed: number;
  completed: number;
  failed: number;
};

type CompletionCounts = {
  pending: number;
  claimed: number;
  processed: number;
  failed: number;
};

type SystemStatusPayload = {
  ok: boolean;
  workers?: {
    total: number;
    online: number;
    busy: number;
    idle: number;
  };
  queues?: {
    requests: QueueCounts;
    jobs: QueueCounts;
    completions: CompletionCounts;
  };
  message?: string;
};

export interface LocalReadonlyContext {
  repoRoot: string;
  serverUrl: string;
  authHeaders: Record<string, string>;
}

const READONLY_COMMAND_TIMEOUT_MS = 8_000;
const MAX_STATUS_LINES = 60;

function truncateLines(lines: string[], maxLines: number): { text: string; hidden: number } {
  const trimmed = lines.map((line) => line.trimEnd()).filter((line) => line.length > 0);
  const shown = trimmed.slice(0, maxLines);
  const hidden = Math.max(0, trimmed.length - shown.length);
  return {
    text: shown.join("\n"),
    hidden,
  };
}

async function runReadOnlyCommand(
  command: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore kill failures
    }
  }, READONLY_COMMAND_TIMEOUT_MS);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return {
    ok: exitCode === 0,
    stdout: String(stdout ?? ""),
    stderr: String(stderr ?? ""),
  };
}

export function isGitStatusPrompt(input: string): boolean {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text) return false;
  if (/\bgit\s+status\b/.test(text)) return true;
  if (/\bstatus\b/.test(text) && /\b(repo|repository)\b/.test(text) && /\bgit\b/.test(text)) {
    return true;
  }
  return false;
}

export function isSystemStatusPrompt(input: string): boolean {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text) return false;
  const mentionsSystem =
    /\b(system|database|db|queue|worker|workers|request|requests|job|jobs|health)\b/.test(text);
  const asksStatus = /\b(status|check|snapshot|overview|how.*doing|doing)\b/.test(text);
  return mentionsSystem && asksStatus;
}

export function isLocalReadonlyQueryPrompt(input: string): boolean {
  return isGitStatusPrompt(input) || isSystemStatusPrompt(input);
}

async function buildGitStatusReply(repoRoot: string): Promise<string> {
  const result = await runReadOnlyCommand(["git", "status", "--short", "--branch"], repoRoot);
  if (!result.ok) {
    const reason = result.stderr.trim() || "git status failed";
    return `I couldn't run git status locally (${reason}).`;
  }

  const allLines = result.stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  if (allLines.length === 0) {
    return "Git status is clean.";
  }

  const headerLine = allLines[0].startsWith("## ") ? allLines[0].slice(3).trim() : "unknown branch";
  const changeLines =
    allLines.length > 1 && allLines[0].startsWith("## ") ? allLines.slice(1) : allLines;

  if (changeLines.length === 0) {
    return `Git status: clean working tree on ${headerLine}.`;
  }

  const compact = truncateLines(changeLines, MAX_STATUS_LINES);
  const overflow = compact.hidden > 0 ? `\n... (${compact.hidden} more)` : "";
  return `Git status on ${headerLine}:\n\`\`\`\n${compact.text}${overflow}\n\`\`\``;
}

async function buildSystemStatusReply(ctx: LocalReadonlyContext): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${ctx.serverUrl}/system/status`, {
      headers: ctx.authHeaders,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `I couldn't check system/database status right now (${reason}).`;
  }

  if (!response.ok) {
    return `I couldn't check system/database status right now (API ${response.status}).`;
  }

  const payload = (await response.json()) as SystemStatusPayload;
  if (!payload.ok || !payload.workers || !payload.queues) {
    return `I couldn't check system/database status right now (${payload.message ?? "invalid response"}).`;
  }

  const workers = payload.workers;
  const requests = payload.queues.requests;
  const jobs = payload.queues.jobs;
  const completions = payload.queues.completions;

  return (
    `System status: workers online ${workers.online}/${workers.total} ` +
    `(busy ${workers.busy}, idle ${workers.idle}). ` +
    `Requests p/c/d/f: ${requests.pending}/${requests.claimed}/${requests.completed}/${requests.failed}. ` +
    `Jobs p/c/d/f: ${jobs.pending}/${jobs.claimed}/${jobs.completed}/${jobs.failed}. ` +
    `Completions p/c/pr/f: ${completions.pending}/${completions.claimed}/${completions.processed}/${completions.failed}.`
  );
}

export async function answerLocalReadonlyQuery(
  userPrompt: string,
  ctx: LocalReadonlyContext,
): Promise<string | null> {
  if (isGitStatusPrompt(userPrompt)) {
    return buildGitStatusReply(ctx.repoRoot);
  }

  if (isSystemStatusPrompt(userPrompt)) {
    return buildSystemStatusReply(ctx);
  }

  return null;
}
