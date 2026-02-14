export type QueueStatus = "pending" | "claimed" | "completed" | "failed";

export interface RequestApiRow {
  id: string;
  sessionId: string;
  prompt: string;
  priority?: "interactive" | "normal" | "background";
  queueWaitBudgetMs?: number | null;
  status: QueueStatus;
  agentId: string | null;
  error: string | null;
  enqueuedAt?: string;
  claimedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  durationMs?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobApiRow {
  id: string;
  taskId: string;
  sessionId: string;
  kind?: string;
  priority?: "interactive" | "normal" | "background";
  status: QueueStatus;
  workerId: string | null;
  params: string;
  error: string | null;
  queueWaitBudgetMs?: number | null;
  executionBudgetMs?: number | null;
  finalizationBudgetMs?: number | null;
  enqueuedAt?: string;
  durationMs?: number | null;
  claimedAt?: string | null;
  startedAt?: string | null;
  firstLogAt?: string | null;
  failedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobLogApiRow {
  id: number;
  jobId: string;
  ts: string;
  message: string;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse failure
  }
  return null;
}

export function extractReferencedRequestToken(input: string): string | null {
  const text = String(input ?? "").trim();
  if (!text) return null;

  const fullId = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  if (fullId) return fullId[0].toLowerCase();

  const contextualShort = text.match(
    /\b(?:request|req|job)(?:\s+id)?\s*(?:is|=|:)?\s*([0-9a-f]{8})\b/i,
  );
  if (contextualShort) return contextualShort[1].toLowerCase();

  const bareShort = text.match(/\b[0-9a-f]{8}\b/i);
  if (
    bareShort &&
    /\b(request|req|job|status|progress|update|check|doing|queue|queued)\b/i.test(text)
  ) {
    return bareShort[0].toLowerCase();
  }
  return null;
}

export function extractReferencedJobToken(input: string): string | null {
  const text = String(input ?? "").trim();
  if (!text) return null;

  const contextualFull = text.match(
    /\b(?:job|workerpal\s+job|task)(?:\s+id)?\s*(?:is|=|:)?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  );
  if (contextualFull) return contextualFull[1].toLowerCase();

  const contextualShort = text.match(
    /\b(?:job|workerpal\s+job|task)(?:\s+id)?\s*(?:is|=|:)?\s*([0-9a-f]{8})\b/i,
  );
  if (contextualShort) return contextualShort[1].toLowerCase();

  return null;
}

function isJobStatusPrompt(input: string): boolean {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text) return false;
  if (extractReferencedJobToken(text)) return true;

  const hasEntity = /\b(job|workerpal|task)\b/.test(text);
  const hasStatusCue =
    /\b(status|progress|update|check|checking|doing|where|queued|claimed|running|in progress|complete|completed|failed|stuck)\b/.test(
      text,
    );
  return hasEntity && hasStatusCue;
}

export function isStatusLookupPrompt(input: string): boolean {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text) return false;

  if (extractReferencedRequestToken(text)) return true;

  const hasEntity = /\b(request|job|workerpal|task)\b/.test(text);
  const hasStatusCue =
    /\b(status|progress|update|check|checking|doing|where|queue|queued|claimed|running|complete|completed|failed|stuck|happened|happen|why|terminated|termination|killed|outcome|result)\b/.test(
      text,
    );
  if (hasEntity && hasStatusCue) return true;

  return /\b(how(?:'s| is)?\s+my\s+status|what(?:'s| is)\s+my\s+status)\b/.test(text);
}

export function formatClockTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDuration(durationMs: number | null | undefined): string {
  if (!Number.isFinite(durationMs as number) || (durationMs as number) < 0) return "";
  const ms = Math.floor(durationMs as number);
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${totalSeconds}s`;
  return `${minutes}m ${seconds}s`;
}

function parseExecutionBudgetMs(job: JobApiRow): number | null {
  if (Number.isFinite(job.executionBudgetMs as number) && (job.executionBudgetMs as number) > 0) {
    return Number(job.executionBudgetMs);
  }
  const parsed = tryParseJsonObject(job.params);
  const planning = parsed?.planning;
  if (!planning || typeof planning !== "object" || Array.isArray(planning)) return null;
  const value = (planning as Record<string, unknown>).executionBudgetMs;
  if (!Number.isFinite(value as number) || (value as number) <= 0) return null;
  return Number(value);
}

function startedIsoForJob(job: JobApiRow): string | null {
  return job.startedAt ?? job.claimedAt ?? job.enqueuedAt ?? job.createdAt ?? null;
}

function parseStructuredError(raw: string | null, summarizeFailure: (value: unknown) => string): string {
  if (!raw) return "";
  const parsed = tryParseJsonObject(raw);
  if (parsed) {
    const message = typeof parsed.message === "string" ? parsed.message : "";
    const detail = typeof parsed.detail === "string" ? parsed.detail : "";
    const combined = [message, detail].filter(Boolean).join(" | ");
    if (combined) return summarizeFailure(combined);
  }
  return summarizeFailure(raw);
}

function extractJobRequestId(job: JobApiRow): string | null {
  const parsed = tryParseJsonObject(job.params);
  if (!parsed) return null;
  const requestId = parsed.requestId;
  if (typeof requestId !== "string") return null;
  const normalized = requestId.trim();
  return normalized || null;
}

function selectRelevantJobForPrompt(args: {
  userPrompt: string;
  sessionId: string;
  jobs: JobApiRow[];
}): {
  isJobQuery: boolean;
  requestedToken: string | null;
  selectedJob: JobApiRow | null;
} {
  const requestedToken = extractReferencedJobToken(args.userPrompt);
  const isJobQuery = isJobStatusPrompt(args.userPrompt);
  const jobs = (args.jobs ?? []).filter((row) => row.sessionId === args.sessionId);
  if (!isJobQuery) {
    return { isJobQuery: false, requestedToken, selectedJob: null };
  }
  if (jobs.length === 0) {
    return { isJobQuery: true, requestedToken, selectedJob: null };
  }

  if (requestedToken) {
    const token = requestedToken.toLowerCase();
    const exact = jobs.find((row) => row.id.toLowerCase() === token);
    if (exact) return { isJobQuery: true, requestedToken, selectedJob: exact };

    const prefix = jobs.find((row) => row.id.toLowerCase().startsWith(token));
    if (prefix) return { isJobQuery: true, requestedToken, selectedJob: prefix };

    return { isJobQuery: true, requestedToken, selectedJob: null };
  }

  const prioritized =
    jobs.find((row) => row.status === "claimed") ??
    jobs.find((row) => row.status === "pending") ??
    jobs[0] ??
    null;
  return { isJobQuery: true, requestedToken, selectedJob: prioritized };
}

function buildJobLogTail(logs: JobLogApiRow[], maxLines = 8): string {
  if (!logs.length) return "";
  const lines = logs
    .map((row) => String(row.message ?? "").trim())
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(10, maxLines)));
  if (!lines.length) return "";
  return lines.join("\n");
}

function extractThinkingHint(logs: JobLogApiRow[]): string {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const line = String(logs[i]?.message ?? "").trim();
    if (!line) continue;
    if (/\b(thinking|thought|analyze|analysis)\b[:\s-]/i.test(line)) {
      return line.length > 180 ? `${line.slice(0, 177)}...` : line;
    }
  }
  return "";
}

export function buildJobStatusReply(args: {
  userPrompt: string;
  sessionId: string;
  jobs: JobApiRow[];
  logs?: JobLogApiRow[];
  summarizeFailure: (value: unknown) => string;
  formatTime?: (iso: string) => string;
}): string | null {
  const { userPrompt, sessionId, summarizeFailure } = args;
  const formatTime = args.formatTime ?? formatClockTime;
  const selection = selectRelevantJobForPrompt({
    userPrompt,
    sessionId,
    jobs: args.jobs,
  });
  if (!selection.isJobQuery) return null;

  const jobs = (args.jobs ?? []).filter((row) => row.sessionId === sessionId);
  if (jobs.length === 0) {
    return "I don't see any jobs in this session yet.";
  }

  if (!selection.selectedJob) {
    if (selection.requestedToken) {
      const latest = jobs
        .slice(0, 3)
        .map((row) => row.id.slice(0, 8))
        .join(", ");
      return latest
        ? `I couldn't find job ${selection.requestedToken}. Recent job IDs: ${latest}.`
        : `I couldn't find job ${selection.requestedToken}.`;
    }
    return "I couldn't resolve which job to check.";
  }

  const job = selection.selectedJob;
  const shortId = job.id.slice(0, 8);
  const updated = formatTime(job.updatedAt);
  let summary = `Job ${shortId} is ${job.status} (updated ${updated})`;
  if (job.workerId) summary += ` on ${job.workerId}`;
  summary += ".";

  if (job.status === "claimed") {
    summary += " It is currently in progress.";
    const startedIso = startedIsoForJob(job);
    const startedMs = startedIso ? Date.parse(startedIso) : NaN;
    if (Number.isFinite(startedMs)) {
      const elapsedMs = Math.max(0, Date.now() - startedMs);
      const elapsedText = formatDuration(elapsedMs);
      if (elapsedText) summary += ` Elapsed: ${elapsedText}.`;
      const budgetMs = parseExecutionBudgetMs(job);
      if (budgetMs && budgetMs > 0) {
        const timeoutAt = new Date(startedMs + budgetMs).toISOString();
        summary += ` Timeout target: ${formatTime(timeoutAt)}.`;
      }
    }
  } else if (job.status === "pending") {
    summary += " It is queued and waiting for a WorkerPal.";
    const enqueuedMs = Date.parse(job.enqueuedAt ?? job.createdAt);
    if (Number.isFinite(enqueuedMs)) {
      const queueElapsedText = formatDuration(Date.now() - enqueuedMs);
      if (queueElapsedText) summary += ` Queue wait so far: ${queueElapsedText}.`;
    }
  }

  if (job.status === "completed" || job.status === "failed") {
    const durationText = formatDuration(job.durationMs);
    if (durationText) {
      summary += ` Runtime: ${durationText}.`;
    }
  }

  if (job.status === "failed") {
    const jobError = parseStructuredError(job.error, summarizeFailure);
    if (jobError) summary += ` Failure: ${jobError}`;
  }

  const logs = (args.logs ?? []).filter((row) => row.jobId === job.id);
  if (logs.length > 0) {
    const tail = buildJobLogTail(logs, 8);
    if (tail) {
      summary += `\nLatest logs:\n\`\`\`\n${tail}\n\`\`\``;
    }
    const hint = extractThinkingHint(logs);
    if (hint) {
      summary += `\nModel hint: ${hint}`;
    }
  }

  return summary;
}

export function buildRequestStatusReply(args: {
  userPrompt: string;
  sessionId: string;
  requests: RequestApiRow[];
  jobs: JobApiRow[];
  summarizeFailure: (value: unknown) => string;
  formatTime?: (iso: string) => string;
}): string | null {
  const { userPrompt, sessionId, summarizeFailure } = args;
  if (!isStatusLookupPrompt(userPrompt)) return null;

  const formatTime = args.formatTime ?? formatClockTime;
  const requestedToken = extractReferencedRequestToken(userPrompt);
  const requests = (args.requests ?? []).filter((row) => row.sessionId === sessionId);
  const jobs = (args.jobs ?? []).filter((row) => row.sessionId === sessionId);

  if (requests.length === 0) {
    return "I don't see any requests in this session yet.";
  }

  let request: RequestApiRow | undefined;
  if (requestedToken) {
    const token = requestedToken.toLowerCase();
    request = requests.find((row) => row.id.toLowerCase() === token);
    if (!request) {
      request = requests.find((row) => row.id.toLowerCase().startsWith(token));
    }
    if (!request) {
      const latest = requests
        .slice(0, 3)
        .map((row) => row.id.slice(0, 8))
        .join(", ");
      return latest
        ? `I couldn't find request ${requestedToken}. Recent request IDs: ${latest}.`
        : `I couldn't find request ${requestedToken}.`;
    }
  } else {
    request = requests.find((row) => row.status === "pending" || row.status === "claimed") ?? requests[0];
  }

  if (!request) {
    return "I couldn't resolve which request to check.";
  }

  const requestId = request.id;
  const relatedJobs = jobs.filter((job) => extractJobRequestId(job) === requestId);
  relatedJobs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const requestShort = requestId.slice(0, 8);
  const requestTime = formatTime(request.updatedAt);
  let summary = `Request ${requestShort} is ${request.status} (updated ${requestTime}).`;
  if (request.priority) {
    summary = `${summary} Priority: ${request.priority}.`;
  }

  if (request.status === "claimed" && request.agentId) {
    summary = `Request ${requestShort} is claimed by ${request.agentId} (updated ${requestTime}).`;
    if (request.priority) {
      summary += ` Priority: ${request.priority}.`;
    }
  }
  if (request.status === "failed") {
    const requestError = parseStructuredError(request.error, summarizeFailure);
    if (requestError) {
      summary = `${summary} Failure: ${requestError}`;
    }
  }

  if (relatedJobs.length === 0) {
    if (request.status === "pending") {
      return `${summary} It is waiting for RemoteBuddy to claim it.`;
    }
    if (request.status === "claimed") {
      return `${summary} RemoteBuddy is still planning and has not enqueued a WorkerPal job yet.`;
    }
    if (request.status === "completed") {
      return `${summary} RemoteBuddy finished orchestration; no WorkerPal job is linked yet.`;
    }
    return summary;
  }

  const latestJob = relatedJobs[0];
  const latestJobShort = latestJob.id.slice(0, 8);
  const latestJobTime = formatTime(latestJob.updatedAt);
  let jobSummary = `Latest WorkerPal job ${latestJobShort} is ${latestJob.status} (updated ${latestJobTime})`;
  if (latestJob.workerId) {
    jobSummary += ` on ${latestJob.workerId}`;
  }
  jobSummary += ".";

  if (latestJob.status === "failed") {
    const jobError = parseStructuredError(latestJob.error, summarizeFailure);
    if (jobError) {
      jobSummary += ` Failure: ${jobError}`;
    }
  }

  if (relatedJobs.length > 1) {
    const counts: Record<QueueStatus, number> = {
      pending: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
    };
    for (const row of relatedJobs) counts[row.status] += 1;
    const countsText = `Jobs: ${relatedJobs.length} total (${counts.pending} pending, ${counts.claimed} claimed, ${counts.completed} completed, ${counts.failed} failed).`;
    return `${summary} ${jobSummary} ${countsText}`;
  }

  return `${summary} ${jobSummary}`;
}
