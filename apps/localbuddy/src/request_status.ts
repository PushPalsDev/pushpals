export type QueueStatus = "pending" | "claimed" | "completed" | "failed";

export interface RequestApiRow {
  id: string;
  sessionId: string;
  originalPrompt: string;
  status: QueueStatus;
  agentId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobApiRow {
  id: string;
  taskId: string;
  sessionId: string;
  status: QueueStatus;
  workerId: string | null;
  params: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
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

export function isStatusLookupPrompt(input: string): boolean {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text) return false;

  if (extractReferencedRequestToken(text)) return true;

  const hasEntity = /\b(request|job|workerpal|task)\b/.test(text);
  const hasStatusCue =
    /\b(status|progress|update|check|checking|doing|where|queue|queued|claimed|running|complete|completed|failed|stuck)\b/.test(
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

  if (request.status === "claimed" && request.agentId) {
    summary = `Request ${requestShort} is claimed by ${request.agentId} (updated ${requestTime}).`;
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
