import React, { useMemo, useState } from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform } from "react-native";
import type { SessionState, Task, Job, LogLine } from "./eventReducer";

const STATUS_COLOR: Record<string, string> = {
  created: "#94a3b8",
  started: "#6366f1",
  in_progress: "#8b5cf6",
  completed: "#22c55e",
  failed: "#ef4444",
  enqueued: "#a855f7",
  claimed: "#7c3aed",
};

const OPENHANDS_RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ ";
const JOB_RUNNER_RESULT_PREFIX = "___RESULT___ ";
const MAX_TRACE_LINES = 220;
const MAX_TRACE_LINE_LENGTH = 500;
const ANSI_COLOR_REGEX = /\x1b\[[0-9;]*m/g;

type TraceTone = "reasoning" | "action" | "info" | "error";

interface TraceEntry {
  key: string;
  source: string;
  line: string;
  tone: TraceTone;
}

function statusColor(s: string): string {
  return STATUS_COLOR[s] ?? "#94a3b8";
}

function cleanLine(raw: string): string {
  return raw.replace(ANSI_COLOR_REGEX, "").replace(/\s+/g, " ").trim();
}

function clampLine(raw: string): string {
  if (raw.length <= MAX_TRACE_LINE_LENGTH) return raw;
  return `${raw.slice(0, MAX_TRACE_LINE_LENGTH - 3)}...`;
}

function toLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => clampLine(cleanLine(line)))
    .filter(Boolean);
}

function classifyTraceTone(line: string, stream?: "stdout" | "stderr"): TraceTone {
  const value = line.toLowerCase();
  if (stream === "stderr") return "error";
  if (
    value.includes("error") ||
    value.includes("failed") ||
    value.includes("traceback") ||
    value.includes("exception")
  ) {
    return "error";
  }
  if (/\b(think|reason|analysis|plan|decide|why|because|approach|strategy)\b/i.test(value)) {
    return "reasoning";
  }
  if (
    /\b(run|running|execute|executing|write|patch|edit|search|read|fetch|merge|commit|push|claim)\b/i.test(
      value,
    )
  ) {
    return "action";
  }
  return "info";
}

function pushTraceEntry(
  entries: TraceEntry[],
  seen: Set<string>,
  source: string,
  line: string,
  tone: TraceTone,
): void {
  const normalized = line.trim();
  if (!normalized) return;
  const dedupeKey = `${source}|${normalized}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  entries.push({
    key: `${source}:${entries.length}`,
    source,
    line: normalized,
    tone,
  });
}

function appendTraceFromText(
  entries: TraceEntry[],
  seen: Set<string>,
  source: string,
  text: string,
  tone: TraceTone,
): void {
  for (const line of toLines(text)) {
    if (entries.length >= MAX_TRACE_LINES) return;
    pushTraceEntry(entries, seen, source, line, tone);
  }
}

function extractTrace(job: Job, logs: LogLine[]): TraceEntry[] {
  const entries: TraceEntry[] = [];
  const seen = new Set<string>();

  if (job.summary) appendTraceFromText(entries, seen, "summary", job.summary, "reasoning");
  if (job.message) appendTraceFromText(entries, seen, "failure", job.message, "error");
  if (job.detail) appendTraceFromText(entries, seen, "detail", job.detail, "error");

  if (job.params && typeof job.params === "object") {
    const instruction = typeof job.params.instruction === "string" ? job.params.instruction : "";
    const targetPath = typeof job.params.targetPath === "string" ? job.params.targetPath : "";
    if (instruction) {
      appendTraceFromText(entries, seen, "request", `Instruction: ${instruction}`, "reasoning");
    }
    if (targetPath) {
      appendTraceFromText(entries, seen, "request", `Target path: ${targetPath}`, "action");
    }
  }

  if (Array.isArray(job.artifacts)) {
    for (const artifact of job.artifacts) {
      if (!artifact?.text) continue;
      const source = `artifact.${artifact.kind || "text"}`;
      const tone = artifact.kind === "stderr" ? "error" : "info";
      appendTraceFromText(entries, seen, source, artifact.text, tone);
      if (entries.length >= MAX_TRACE_LINES) break;
    }
  }

  for (const log of logs) {
    if (entries.length >= MAX_TRACE_LINES) break;
    const line = cleanLine(log.line || "");
    if (!line) continue;
    if (line.startsWith(JOB_RUNNER_RESULT_PREFIX)) continue;

    if (line.startsWith(OPENHANDS_RESULT_PREFIX)) {
      const raw = line.slice(OPENHANDS_RESULT_PREFIX.length).trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.summary === "string") {
          appendTraceFromText(entries, seen, "openhands.summary", parsed.summary, "reasoning");
        }
        if (typeof parsed.stdout === "string") {
          appendTraceFromText(entries, seen, "openhands.stdout", parsed.stdout, "info");
        }
        if (typeof parsed.stderr === "string") {
          appendTraceFromText(entries, seen, "openhands.stderr", parsed.stderr, "error");
        }
      } catch {
        appendTraceFromText(entries, seen, "openhands", raw, classifyTraceTone(raw, log.stream));
      }
      continue;
    }

    appendTraceFromText(
      entries,
      seen,
      `log.${log.stream}`,
      line,
      classifyTraceTone(line, log.stream),
    );
  }

  if (entries.length >= MAX_TRACE_LINES) {
    pushTraceEntry(entries, seen, "trace", "...trace truncated...", "info");
  }

  return entries;
}

function traceToneStyle(tone: TraceTone) {
  switch (tone) {
    case "reasoning":
      return s.traceReasoning;
    case "action":
      return s.traceAction;
    case "error":
      return s.traceError;
    default:
      return s.traceInfo;
  }
}

function TaskRow({
  task,
  jobs,
  logs,
  expanded,
  onToggle,
}: {
  task: Task;
  jobs: Job[];
  logs: Map<string, LogLine[]>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const c = statusColor(task.status);

  return (
    <View style={s.taskCard}>
      <TouchableOpacity onPress={onToggle} style={s.taskHeader}>
        <View style={[s.dot, { backgroundColor: c }]} />
        <Text style={s.taskTitle} numberOfLines={1}>
          {task.title}
        </Text>
        <Text style={[s.statusBadge, { color: c }]}>{task.status}</Text>
        <Text style={s.chevron}>{expanded ? "v" : ">"}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={s.taskBody}>
          {task.description ? <Text style={s.desc}>{task.description}</Text> : null}
          {task.latestProgress ? <Text style={s.progressMsg}>{task.latestProgress}</Text> : null}
          {jobs.length === 0 && <Text style={s.muted}>No jobs yet</Text>}
          {jobs.map((job) => (
            <JobRow key={job.jobId} job={job} logs={logs.get(job.jobId) ?? []} />
          ))}
        </View>
      )}
    </View>
  );
}

function JobRow({ job, logs }: { job: Job; logs: LogLine[] }) {
  const [expanded, setExpanded] = useState(false);
  const [showRawLogs, setShowRawLogs] = useState(false);
  const c = statusColor(job.status);

  const stdoutLines = useMemo(
    () => logs.filter((l) => l.stream === "stdout").sort((a, b) => a.seq - b.seq),
    [logs],
  );
  const stderrLines = useMemo(
    () => logs.filter((l) => l.stream === "stderr").sort((a, b) => a.seq - b.seq),
    [logs],
  );
  const trace = useMemo(() => extractTrace(job, logs), [job, logs]);
  const totalLines = stdoutLines.length + stderrLines.length;

  return (
    <View style={s.jobCard}>
      <TouchableOpacity onPress={() => setExpanded(!expanded)} style={s.jobHeader}>
        <View style={[s.dot, { backgroundColor: c }]} />
        <Text style={s.jobKind}>{job.kind}</Text>
        <Text style={[s.statusBadge, { color: c }]}>{job.status}</Text>
        {job.workerId && <Text style={s.workerId}>@{job.workerId}</Text>}
        {(trace.length > 0 || totalLines > 0) && (
          <Text style={s.logCount}>
            {trace.length} trace / {totalLines} raw
          </Text>
        )}
        <Text style={s.chevron}>{expanded ? "v" : ">"}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={s.jobBody}>
          {job.summary ? <Text style={s.jobSummary}>{job.summary}</Text> : null}
          {job.message ? <Text style={s.jobError}>{job.message}</Text> : null}
          {job.detail ? <Text style={s.jobErrorDetail}>{job.detail}</Text> : null}

          {trace.length > 0 ? (
            <View style={s.traceSection}>
              <Text style={s.streamLabel}>Trace</Text>
              <ScrollView style={s.traceScroll} nestedScrollEnabled>
                {trace.map((entry) => (
                  <Text
                    key={entry.key}
                    style={[s.traceLine, traceToneStyle(entry.tone)]}
                    selectable
                  >
                    [{entry.source}] {entry.line}
                  </Text>
                ))}
              </ScrollView>
            </View>
          ) : (
            <Text style={s.muted}>No trace output captured for this job.</Text>
          )}

          {totalLines > 0 && (
            <TouchableOpacity style={s.rawToggle} onPress={() => setShowRawLogs(!showRawLogs)}>
              <Text style={s.rawToggleText}>
                {showRawLogs ? "Hide raw logs" : `Show raw logs (${totalLines})`}
              </Text>
            </TouchableOpacity>
          )}

          {showRawLogs && totalLines > 0 && (
            <View style={s.logSections}>
              {stdoutLines.length > 0 && (
                <View>
                  <Text style={s.streamLabel}>STDOUT</Text>
                  <ScrollView style={s.logScroll} nestedScrollEnabled>
                    {stdoutLines.map((line) => (
                      <Text key={`stdout-${line.seq}`} style={[s.logLine, s.logStdout]} selectable>
                        {line.line}
                      </Text>
                    ))}
                  </ScrollView>
                </View>
              )}
              {stderrLines.length > 0 && (
                <View>
                  <Text style={s.streamLabel}>STDERR</Text>
                  <ScrollView style={s.logScroll} nestedScrollEnabled>
                    {stderrLines.map((line) => (
                      <Text key={`stderr-${line.seq}`} style={[s.logLine, s.logStderr]} selectable>
                        {line.line}
                      </Text>
                    ))}
                  </ScrollView>
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function OrphanJobs({
  jobs,
  logs,
  taskJobIds,
}: {
  jobs: Map<string, Job>;
  logs: Map<string, LogLine[]>;
  taskJobIds: Set<string>;
}) {
  const orphans = Array.from(jobs.values())
    .filter((j) => !taskJobIds.has(j.jobId))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (orphans.length === 0) return null;

  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Standalone Jobs</Text>
      {orphans.map((job) => (
        <JobRow key={job.jobId} job={job} logs={logs.get(job.jobId) ?? []} />
      ))}
    </View>
  );
}

export function TasksJobsLogs({ state }: { state: SessionState }) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const tasksArr = Array.from(state.tasks.values()).sort((a, b) => a.ts.localeCompare(b.ts));
  const taskJobIds = new Set<string>();
  for (const t of tasksArr) {
    for (const jid of t.jobIds) taskJobIds.add(jid);
  }

  if (tasksArr.length === 0 && state.jobs.size === 0) {
    return (
      <View style={s.emptyContainer}>
        <Text style={s.muted}>No tasks or jobs yet</Text>
      </View>
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {tasksArr.length > 0 && (
        <View style={s.section}>
          <Text style={s.sectionTitle}>Tasks</Text>
          {tasksArr.map((task) => {
            const taskJobs = task.jobIds.map((id) => state.jobs.get(id)).filter(Boolean) as Job[];
            const JOB_ORDER: Record<string, number> = {
              claimed: 0,
              enqueued: 1,
              completed: 2,
              failed: 3,
            };
            taskJobs.sort((a, b) => {
              const oa = JOB_ORDER[a.status] ?? 9;
              const ob = JOB_ORDER[b.status] ?? 9;
              return oa !== ob ? oa - ob : a.ts.localeCompare(b.ts);
            });

            return (
              <TaskRow
                key={task.taskId}
                task={task}
                jobs={taskJobs}
                logs={state.logs}
                expanded={expandedTaskId === task.taskId}
                onToggle={() =>
                  setExpandedTaskId(expandedTaskId === task.taskId ? null : task.taskId)
                }
              />
            );
          })}
        </View>
      )}

      <OrphanJobs jobs={state.jobs} logs={state.logs} taskJobIds={taskJobIds} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  content: { padding: 12, paddingBottom: 16 },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },

  section: { marginBottom: 16 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#475569",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },

  taskCard: {
    backgroundColor: "#fff",
    borderRadius: 8,
    marginBottom: 8,
    borderLeftWidth: 3,
    borderLeftColor: "#e2e8f0",
    ...Platform.select({
      web: { boxShadow: "0 1px 3px rgba(0,0,0,0.06)" },
      default: { elevation: 1 },
    }),
  },
  taskHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    gap: 8,
  },
  taskTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: "#1e293b",
  },
  taskBody: {
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  desc: {
    fontSize: 12,
    color: "#64748b",
    marginBottom: 4,
  },
  progressMsg: {
    fontSize: 12,
    color: "#8b5cf6",
    fontStyle: "italic",
    marginBottom: 8,
  },

  jobCard: {
    backgroundColor: "#f8fafc",
    borderRadius: 6,
    marginTop: 6,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  jobHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 8,
    gap: 6,
    flexWrap: "wrap",
  },
  jobBody: {
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingBottom: 8,
  },
  jobKind: {
    fontSize: 13,
    fontWeight: "500",
    color: "#334155",
  },
  workerId: {
    fontSize: 11,
    color: "#7c3aed",
    fontFamily: Platform.OS === "web" ? "monospace" : undefined,
  },
  logCount: {
    fontSize: 11,
    color: "#94a3b8",
    marginLeft: "auto",
  },
  jobSummary: {
    fontSize: 12,
    color: "#334155",
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 4,
  },
  jobError: {
    fontSize: 12,
    color: "#dc2626",
    paddingHorizontal: 8,
    paddingTop: 4,
  },
  jobErrorDetail: {
    fontSize: 11,
    color: "#b91c1c",
    paddingHorizontal: 8,
    paddingTop: 2,
  },

  traceSection: {
    marginTop: 4,
  },
  traceScroll: {
    maxHeight: 220,
  },
  traceLine: {
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontFamily: Platform.OS === "web" ? "monospace" : undefined,
  },
  traceReasoning: {
    color: "#4c1d95",
    backgroundColor: "#f5f3ff",
  },
  traceAction: {
    color: "#14532d",
    backgroundColor: "#f0fdf4",
  },
  traceInfo: {
    color: "#334155",
    backgroundColor: "#f8fafc",
  },
  traceError: {
    color: "#b91c1c",
    backgroundColor: "#fef2f2",
  },

  rawToggle: {
    marginTop: 6,
    marginHorizontal: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#fff",
    alignSelf: "flex-start",
  },
  rawToggleText: {
    fontSize: 11,
    color: "#334155",
    fontWeight: "600",
  },

  logSections: {
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    marginTop: 6,
  },
  streamLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#94a3b8",
    textTransform: "uppercase",
    paddingHorizontal: 8,
    paddingTop: 6,
    letterSpacing: 0.5,
  },
  logScroll: {
    maxHeight: 200,
  },
  logLine: {
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 1,
    fontFamily: Platform.OS === "web" ? "monospace" : undefined,
  },
  logStdout: {
    color: "#334155",
    backgroundColor: "#f0fdf4",
  },
  logStderr: {
    color: "#dc2626",
    backgroundColor: "#fef2f2",
  },

  dot: { width: 8, height: 8, borderRadius: 4 },
  statusBadge: { fontSize: 11, fontWeight: "600" },
  chevron: { fontSize: 12, color: "#94a3b8" },
  muted: { fontSize: 12, color: "#94a3b8", fontStyle: "italic", paddingHorizontal: 8 },
});
