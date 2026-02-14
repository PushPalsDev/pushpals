/**
 * Event reducer: applies EventEnvelopes to structured state.
 *
 * Maintains:
 *   messages  — assistant_message / message events
 *   tasks     — task lifecycle (created → started → progress → completed | failed)
 *   jobs      — job lifecycle (enqueued → claimed → completed | failed), keyed by jobId
 *   logs      — job_log lines grouped by jobId, ordered by (stream, seq)
 *   lastCursor — highest cursor seen (for reconnect with ?after=)
 */

import type { EventEnvelope } from "protocol/browser";

// ─── State shapes ───────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  ts: string;
  from?: string;
  turnId?: string;
  text: string;
}

export type TaskStatus = "created" | "started" | "in_progress" | "completed" | "failed";

export interface Task {
  taskId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdBy?: string;
  summary?: string;
  message?: string; // failure message
  latestProgress?: string; // most recent task_progress message
  jobIds: string[];
  ts: string;
}

export type JobStatus = "enqueued" | "claimed" | "completed" | "failed";

export interface Job {
  jobId: string;
  taskId: string;
  kind: string;
  params?: Record<string, unknown>;
  status: JobStatus;
  workerId?: string;
  summary?: string;
  message?: string; // failure message
  detail?: string; // failure detail
  artifacts?: {
    kind: string;
    uri?: string;
    text?: string;
  }[];
  ts: string;
}

export interface LogLine {
  jobId: string;
  stream: "stdout" | "stderr";
  seq: number;
  line: string;
}

export interface SessionState {
  messages: ChatMessage[];
  tasks: Map<string, Task>;
  jobs: Map<string, Job>;
  logs: Map<string, LogLine[]>; // jobId → log lines (append-order)
  /** Per-job set of seen "stream:seq" keys for O(1) log dedup */
  logSeenKeys: Map<string, Set<string>>;
  lastCursor: number;
  /** Global dedup set — bounded to MAX_SEEN_IDS entries */
  seenIds: Set<string>;
}

// ─── Actions ────────────────────────────────────────────────────────────────

export type ReducerAction =
  | { type: "event"; envelope: EventEnvelope; cursor: number }
  | { type: "reset" };

// ─── Initial state ──────────────────────────────────────────────────────────

const MAX_SEEN_IDS = 5000;
const MAX_LOG_LINES_PER_JOB = 2000;

export function initialState(): SessionState {
  return {
    messages: [],
    tasks: new Map(),
    jobs: new Map(),
    logs: new Map(),
    logSeenKeys: new Map(),
    lastCursor: 0,
    seenIds: new Set(),
  };
}

// ─── Reducer ────────────────────────────────────────────────────────────────

export function eventReducer(state: SessionState, action: ReducerAction): SessionState {
  if (action.type === "reset") return initialState();

  const { envelope, cursor } = action;

  // Track highest cursor
  const lastCursor = Math.max(state.lastCursor, cursor);

  const eventId = envelope.id;

  // ── Global dedup: skip any event we've already applied ───────────────
  if (state.seenIds.has(eventId)) {
    return { ...state, lastCursor };
  }

  // Clone + add to seenIds (cap at MAX_SEEN_IDS by evicting oldest)
  const seenIds = new Set(state.seenIds);
  seenIds.add(eventId);
  if (seenIds.size > MAX_SEEN_IDS) {
    // Delete the first (oldest) entry
    const first = seenIds.values().next().value;
    if (first !== undefined) seenIds.delete(first);
  }

  const p = envelope.payload as Record<string, unknown>;

  switch (envelope.type) {
    // ── Messages ──────────────────────────────────────────────────────────
    case "message":
    case "assistant_message": {
      const msg: ChatMessage = {
        id: eventId,
        ts: envelope.ts,
        from: envelope.from,
        turnId: envelope.turnId,
        text: (p.text as string) ?? "",
      };
      return { ...state, messages: [...state.messages, msg], lastCursor, seenIds };
    }

    // ── Task lifecycle ────────────────────────────────────────────────────
    case "task_created": {
      const taskId = p.taskId as string;
      if (!taskId) return { ...state, lastCursor, seenIds };
      const tasks = new Map(state.tasks);

      // Backfill: collect any jobs already created for this taskId (#8)
      const backfilledJobIds: string[] = [];
      for (const job of state.jobs.values()) {
        if (job.taskId === taskId) backfilledJobIds.push(job.jobId);
      }

      const existing = tasks.get(taskId);
      if (existing) {
        // Task already exists (out-of-order replay) — merge non-destructively (#5)
        // Keep the later status; fill missing fields; union jobIds
        const mergedJobIds = Array.from(new Set([...existing.jobIds, ...backfilledJobIds]));
        tasks.set(taskId, {
          ...existing,
          // "Don't overwrite" — keep existing title unless empty/missing (|| catches "" and undefined)
          title: existing.title || ((p.title as string) ?? taskId),
          description: existing.description ?? (p.description as string | undefined),
          createdBy: existing.createdBy ?? (p.createdBy as string | undefined),
          jobIds: mergedJobIds,
          // Don't overwrite status — existing has progressed past "created"
        });
      } else {
        tasks.set(taskId, {
          taskId,
          title: (p.title as string) ?? taskId,
          description: p.description as string | undefined,
          status: "created",
          createdBy: p.createdBy as string | undefined,
          jobIds: backfilledJobIds,
          ts: envelope.ts,
        });
      }
      return { ...state, tasks, lastCursor, seenIds };
    }

    case "task_started": {
      const taskId = p.taskId as string;
      if (!taskId) return { ...state, lastCursor, seenIds };
      const tasks = new Map(state.tasks);
      const existing = tasks.get(taskId);
      if (existing) tasks.set(taskId, { ...existing, status: "started" });
      return { ...state, tasks, lastCursor, seenIds };
    }

    case "task_progress": {
      const taskId = p.taskId as string;
      if (!taskId) return { ...state, lastCursor, seenIds };
      const tasks = new Map(state.tasks);
      const existing = tasks.get(taskId);
      if (existing) {
        tasks.set(taskId, {
          ...existing,
          status: "in_progress",
          latestProgress: (p.message as string) ?? existing.latestProgress,
        });
      }
      return { ...state, tasks, lastCursor, seenIds };
    }

    case "task_completed": {
      const taskId = p.taskId as string;
      if (!taskId) return { ...state, lastCursor, seenIds };
      const tasks = new Map(state.tasks);
      const existing = tasks.get(taskId);
      if (existing) {
        tasks.set(taskId, {
          ...existing,
          status: "completed",
          summary: (p.summary as string) ?? undefined,
        });
      }
      return { ...state, tasks, lastCursor, seenIds };
    }

    case "task_failed": {
      const taskId = p.taskId as string;
      if (!taskId) return { ...state, lastCursor, seenIds };
      const tasks = new Map(state.tasks);
      const existing = tasks.get(taskId);
      if (existing) {
        tasks.set(taskId, {
          ...existing,
          status: "failed",
          message: (p.message as string) ?? undefined,
        });
      }
      return { ...state, tasks, lastCursor, seenIds };
    }

    // ── Job lifecycle ─────────────────────────────────────────────────────
    case "job_enqueued": {
      const jobId = p.jobId as string;
      const taskId = p.taskId as string;
      if (!jobId) return { ...state, lastCursor, seenIds };

      const jobs = new Map(state.jobs);
      jobs.set(jobId, {
        jobId,
        taskId,
        kind: (p.kind as string) ?? "unknown",
        params:
          p.params && typeof p.params === "object"
            ? (p.params as Record<string, unknown>)
            : undefined,
        status: "enqueued",
        ts: envelope.ts,
      });

      // Link job to task (if task exists; otherwise backfill on task_created)
      const tasks = new Map(state.tasks);
      const task = tasks.get(taskId);
      if (task && !task.jobIds.includes(jobId)) {
        tasks.set(taskId, { ...task, jobIds: [...task.jobIds, jobId] });
      }

      return { ...state, jobs, tasks, lastCursor, seenIds };
    }

    case "job_claimed": {
      const jobId = p.jobId as string;
      if (!jobId) return { ...state, lastCursor, seenIds };
      const jobs = new Map(state.jobs);
      const existing = jobs.get(jobId);
      if (existing) {
        jobs.set(jobId, {
          ...existing,
          status: "claimed",
          workerId: (p.workerId as string) ?? undefined,
        });
      }
      return { ...state, jobs, lastCursor, seenIds };
    }

    case "job_completed": {
      const jobId = p.jobId as string;
      if (!jobId) return { ...state, lastCursor, seenIds };
      const jobs = new Map(state.jobs);
      const tasks = new Map(state.tasks);
      const existing = jobs.get(jobId);
      if (existing) {
        const artifacts = Array.isArray(p.artifacts)
          ? p.artifacts
              .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
              .map((a) => ({
                kind: String(a.kind ?? "artifact"),
                uri: typeof a.uri === "string" ? a.uri : undefined,
                text: typeof a.text === "string" ? a.text : undefined,
              }))
          : undefined;
        jobs.set(jobId, {
          ...existing,
          status: "completed",
          summary: (p.summary as string) ?? undefined,
          artifacts,
        });

        // Promote the parent task to completed when all known sibling jobs are terminal
        // and none failed. This keeps task cards in sync even if no explicit
        // task_completed event is emitted.
        const task = tasks.get(existing.taskId);
        if (task && task.status !== "failed") {
          const siblingJobs = Array.from(jobs.values()).filter((job) => job.taskId === existing.taskId);
          const hasActiveSibling = siblingJobs.some(
            (job) => job.status === "enqueued" || job.status === "claimed",
          );
          const hasFailedSibling = siblingJobs.some((job) => job.status === "failed");
          if (!hasActiveSibling && !hasFailedSibling) {
            tasks.set(existing.taskId, {
              ...task,
              status: "completed",
              summary: task.summary ?? ((p.summary as string) || undefined),
            });
          }
        }
      }
      // Terminal status — free dedup memory (no more logs expected)
      const logSeenKeys = new Map(state.logSeenKeys);
      logSeenKeys.delete(jobId);
      return { ...state, jobs, tasks, logSeenKeys, lastCursor, seenIds };
    }

    case "job_failed": {
      const jobId = p.jobId as string;
      if (!jobId) return { ...state, lastCursor, seenIds };
      const jobs = new Map(state.jobs);
      const tasks = new Map(state.tasks);
      const existing = jobs.get(jobId);
      if (existing) {
        const failedMessage = (p.message as string) ?? undefined;
        jobs.set(jobId, {
          ...existing,
          status: "failed",
          message: failedMessage,
          detail: (p.detail as string) ?? undefined,
        });

        const task = tasks.get(existing.taskId);
        if (task && task.status !== "completed") {
          const hasActiveSiblingJob = Array.from(jobs.values()).some(
            (job) => job.taskId === existing.taskId && (job.status === "enqueued" || job.status === "claimed"),
          );
          if (!hasActiveSiblingJob) {
            tasks.set(existing.taskId, {
              ...task,
              status: "failed",
              message: failedMessage ?? task.message,
            });
          }
        }
      }
      // Terminal status — free dedup memory (no more logs expected)
      const logSeenKeys = new Map(state.logSeenKeys);
      logSeenKeys.delete(jobId);
      return { ...state, jobs, tasks, logSeenKeys, lastCursor, seenIds };
    }

    // ── Streaming logs ────────────────────────────────────────────────────
    case "job_log": {
      const jobId = p.jobId as string;
      if (!jobId) return { ...state, lastCursor, seenIds };

      // Drop log lines with missing/invalid seq (schema requires >= 1) (#4)
      const rawSeq = p.seq as number | undefined;
      if (rawSeq == null || rawSeq < 1) return { ...state, lastCursor, seenIds };

      const stream = (p.stream as "stdout" | "stderr") ?? "stdout";
      const dedupKey = `${stream}:${rawSeq}`;

      // O(1) dedup via per-job seen Set (#2)
      const logSeenKeys = new Map(state.logSeenKeys);
      const jobSeen = logSeenKeys.get(jobId) ?? new Set<string>();
      if (jobSeen.has(dedupKey)) {
        return { ...state, lastCursor, seenIds };
      }

      const logLine: LogLine = {
        jobId,
        stream,
        seq: rawSeq,
        line: (p.line as string) ?? "",
      };

      const logs = new Map(state.logs);
      const jobLogs = [...(logs.get(jobId) ?? []), logLine];

      // Cap per-job log lines — drop oldest, rebuild seen keys from survivors
      if (jobLogs.length > MAX_LOG_LINES_PER_JOB) {
        const trimmed = jobLogs.slice(-MAX_LOG_LINES_PER_JOB);
        logs.set(jobId, trimmed);
        const rebuiltSeen = new Set<string>();
        for (const l of trimmed) rebuiltSeen.add(`${l.stream}:${l.seq}`);
        logSeenKeys.set(jobId, rebuiltSeen);
      } else {
        logs.set(jobId, jobLogs);
        const newJobSeen = new Set(jobSeen);
        newJobSeen.add(dedupKey);
        logSeenKeys.set(jobId, newJobSeen);
      }

      return { ...state, logs, logSeenKeys, lastCursor, seenIds };
    }

    default:
      // Unknown event type — still track cursor + seenIds
      return { ...state, lastCursor, seenIds };
  }
}
