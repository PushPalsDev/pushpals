import React, { useState } from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform } from "react-native";
import type { SessionState, Task, Job, LogLine } from "./eventReducer";

// ─── Status colours ──────────────────────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = {
  created: "#94a3b8",
  started: "#6366f1",
  in_progress: "#8b5cf6",
  completed: "#22c55e",
  failed: "#ef4444",
  enqueued: "#a855f7",
  claimed: "#7c3aed",
};

function statusColor(s: string): string {
  return STATUS_COLOR[s] ?? "#94a3b8";
}

// ─── Task row ────────────────────────────────────────────────────────────────
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
        <Text style={s.chevron}>{expanded ? "▾" : "▸"}</Text>
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

// ─── Job row ─────────────────────────────────────────────────────────────────
function JobRow({ job, logs }: { job: Job; logs: LogLine[] }) {
  const [showLogs, setShowLogs] = useState(false);
  const c = statusColor(job.status);

  // Split logs by stream, sort each by seq (#3)
  const stdoutLines = logs.filter((l) => l.stream === "stdout").sort((a, b) => a.seq - b.seq);
  const stderrLines = logs.filter((l) => l.stream === "stderr").sort((a, b) => a.seq - b.seq);
  const totalLines = stdoutLines.length + stderrLines.length;

  return (
    <View style={s.jobCard}>
      <TouchableOpacity onPress={() => setShowLogs(!showLogs)} style={s.jobHeader}>
        <View style={[s.dot, { backgroundColor: c }]} />
        <Text style={s.jobKind}>{job.kind}</Text>
        <Text style={[s.statusBadge, { color: c }]}>{job.status}</Text>
        {job.workerId && <Text style={s.workerId}>@{job.workerId}</Text>}
        {totalLines > 0 && (
          <Text style={s.logCount}>
            {totalLines} line{totalLines !== 1 ? "s" : ""}
          </Text>
        )}
        <Text style={s.chevron}>{showLogs ? "▾" : "▸"}</Text>
      </TouchableOpacity>

      {showLogs && totalLines > 0 && (
        <View style={s.logSections}>
          {/* STDOUT section */}
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
          {/* STDERR section */}
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

      {showLogs && totalLines === 0 && <Text style={s.muted}>No log output</Text>}
    </View>
  );
}

// ─── Standalone jobs (no parent task) ────────────────────────────────────────
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

// ─── Main component ─────────────────────────────────────────────────────────
export function TasksJobsLogs({ state }: { state: SessionState }) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  // Sort tasks by timestamp (#5)
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
      {/* Tasks */}
      {tasksArr.length > 0 && (
        <View style={s.section}>
          <Text style={s.sectionTitle}>Tasks</Text>
          {tasksArr.map((task) => {
            const taskJobs = task.jobIds.map((id) => state.jobs.get(id)).filter(Boolean) as Job[];

            // Sort jobs: active first, then by timestamp (#5)
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

      {/* Orphan jobs */}
      <OrphanJobs jobs={state.jobs} logs={state.logs} taskJobIds={taskJobIds} />
    </ScrollView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
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

  // Task
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

  // Job
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

  // Log viewer
  logSections: {
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
  },
  streamLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#94a3b8",
    textTransform: "uppercase",
    paddingHorizontal: 8,
    paddingTop: 4,
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

  // Shared
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusBadge: { fontSize: 11, fontWeight: "600" },
  chevron: { fontSize: 12, color: "#94a3b8" },
  muted: { fontSize: 12, color: "#94a3b8", fontStyle: "italic" },
});
