import React, { useMemo, useState } from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform } from "react-native";
import type { SessionState, Task, Job, LogLine } from "./eventReducer";

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

export type TasksJobsLogsThemeMode = "light" | "dark";

export interface TasksJobsLogsTheme {
  mode?: TasksJobsLogsThemeMode;
  fontSans?: string;
  fontMono?: string;
}

interface TracePalette {
  bg: string;
  panel: string;
  panelAlt: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  reasoningText: string;
  reasoningBg: string;
  actionText: string;
  actionBg: string;
  infoText: string;
  infoBg: string;
  errorText: string;
  errorBg: string;
}

const LIGHT_PALETTE: TracePalette = {
  bg: "#F4F8FB",
  panel: "#FFFFFF",
  panelAlt: "#EEF4F8",
  border: "#D2E0E8",
  text: "#112230",
  textMuted: "#547086",
  accent: "#007E77",
  success: "#169A58",
  warning: "#C7851E",
  danger: "#D64553",
  reasoningText: "#1D4E89",
  reasoningBg: "#EAF4FF",
  actionText: "#0F6C48",
  actionBg: "#E9FBF5",
  infoText: "#334155",
  infoBg: "#F4F8FB",
  errorText: "#A22A35",
  errorBg: "#FEECEF",
};

const DARK_PALETTE: TracePalette = {
  bg: "#14212A",
  panel: "#16222B",
  panelAlt: "#1B2A35",
  border: "#284050",
  text: "#EAF3F6",
  textMuted: "#97B3C2",
  accent: "#2FD6C8",
  success: "#5DDD8B",
  warning: "#FFB95A",
  danger: "#FF6B72",
  reasoningText: "#9BC6FF",
  reasoningBg: "#1D2A40",
  actionText: "#8EF5BD",
  actionBg: "#163628",
  infoText: "#D2E3ED",
  infoBg: "#1A2934",
  errorText: "#FFACB5",
  errorBg: "#3A1B22",
};

function paletteForMode(mode: TasksJobsLogsThemeMode): TracePalette {
  return mode === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
}

function statusColor(status: string, palette: TracePalette): string {
  switch (status) {
    case "completed":
      return palette.success;
    case "failed":
      return palette.danger;
    case "claimed":
    case "started":
    case "in_progress":
      return palette.warning;
    case "enqueued":
    case "created":
    default:
      return palette.accent;
  }
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

function createStyles(palette: TracePalette, theme?: TasksJobsLogsTheme) {
  const sans = theme?.fontSans;
  const mono = theme?.fontMono ?? (Platform.OS === "web" ? "monospace" : undefined);

  return StyleSheet.create({
    container: { flex: 1, backgroundColor: palette.bg },
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
      color: palette.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginBottom: 8,
      fontFamily: sans,
    },

    taskCard: {
      backgroundColor: palette.panel,
      borderRadius: 8,
      marginBottom: 8,
      borderLeftWidth: 3,
      borderLeftColor: palette.border,
      ...Platform.select({
        web: { boxShadow: "0 1px 3px rgba(0,0,0,0.12)" },
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
      color: palette.text,
      fontFamily: sans,
    },
    taskBody: {
      paddingHorizontal: 10,
      paddingBottom: 10,
    },
    desc: {
      fontSize: 12,
      color: palette.textMuted,
      marginBottom: 4,
      fontFamily: sans,
    },
    progressMsg: {
      fontSize: 12,
      color: palette.warning,
      fontStyle: "italic",
      marginBottom: 8,
      fontFamily: sans,
    },

    jobCard: {
      backgroundColor: palette.panelAlt,
      borderRadius: 6,
      marginTop: 6,
      borderWidth: 1,
      borderColor: palette.border,
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
      borderTopColor: palette.border,
      paddingBottom: 8,
    },
    jobKind: {
      fontSize: 13,
      fontWeight: "500",
      color: palette.text,
      fontFamily: sans,
    },
    workerId: {
      fontSize: 11,
      color: palette.accent,
      fontFamily: mono,
    },
    logCount: {
      fontSize: 11,
      color: palette.textMuted,
      marginLeft: "auto",
      fontFamily: sans,
    },
    jobSummary: {
      fontSize: 12,
      color: palette.text,
      paddingHorizontal: 8,
      paddingTop: 8,
      paddingBottom: 4,
      fontFamily: sans,
    },
    jobError: {
      fontSize: 12,
      color: palette.danger,
      paddingHorizontal: 8,
      paddingTop: 4,
      fontFamily: sans,
    },
    jobErrorDetail: {
      fontSize: 11,
      color: palette.danger,
      paddingHorizontal: 8,
      paddingTop: 2,
      fontFamily: mono,
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
      fontFamily: mono,
    },
    traceReasoning: {
      color: palette.reasoningText,
      backgroundColor: palette.reasoningBg,
    },
    traceAction: {
      color: palette.actionText,
      backgroundColor: palette.actionBg,
    },
    traceInfo: {
      color: palette.infoText,
      backgroundColor: palette.infoBg,
    },
    traceError: {
      color: palette.errorText,
      backgroundColor: palette.errorBg,
    },

    rawToggle: {
      marginTop: 6,
      marginHorizontal: 8,
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.panel,
      alignSelf: "flex-start",
    },
    rawToggleText: {
      fontSize: 11,
      color: palette.text,
      fontWeight: "600",
      fontFamily: sans,
    },

    logSections: {
      borderTopWidth: 1,
      borderTopColor: palette.border,
      marginTop: 6,
    },
    streamLabel: {
      fontSize: 10,
      fontWeight: "700",
      color: palette.textMuted,
      textTransform: "uppercase",
      paddingHorizontal: 8,
      paddingTop: 6,
      letterSpacing: 0.5,
      fontFamily: sans,
    },
    logScroll: {
      maxHeight: 200,
    },
    logLine: {
      fontSize: 11,
      paddingHorizontal: 8,
      paddingVertical: 1,
      fontFamily: mono,
    },
    logStdout: {
      color: palette.infoText,
      backgroundColor: palette.actionBg,
    },
    logStderr: {
      color: palette.errorText,
      backgroundColor: palette.errorBg,
    },

    dot: { width: 8, height: 8, borderRadius: 4 },
    statusBadge: { fontSize: 11, fontWeight: "600", fontFamily: sans },
    chevron: { fontSize: 12, color: palette.textMuted, fontFamily: sans },
    muted: { fontSize: 12, color: palette.textMuted, fontStyle: "italic", paddingHorizontal: 8, fontFamily: sans },
  });
}

type TraceStyles = ReturnType<typeof createStyles>;

function traceToneStyle(tone: TraceTone, styles: TraceStyles) {
  switch (tone) {
    case "reasoning":
      return styles.traceReasoning;
    case "action":
      return styles.traceAction;
    case "error":
      return styles.traceError;
    default:
      return styles.traceInfo;
  }
}

function TaskRow({
  task,
  jobs,
  logs,
  expanded,
  onToggle,
  styles,
  palette,
}: {
  task: Task;
  jobs: Job[];
  logs: Map<string, LogLine[]>;
  expanded: boolean;
  onToggle: () => void;
  styles: TraceStyles;
  palette: TracePalette;
}) {
  const color = statusColor(task.status, palette);

  return (
    <View style={styles.taskCard}>
      <TouchableOpacity onPress={onToggle} style={styles.taskHeader}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={styles.taskTitle} numberOfLines={1}>
          {task.title}
        </Text>
        <Text style={[styles.statusBadge, { color }]}>{task.status}</Text>
        <Text style={styles.chevron}>{expanded ? "v" : ">"}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.taskBody}>
          {task.description ? <Text style={styles.desc}>{task.description}</Text> : null}
          {task.latestProgress ? <Text style={styles.progressMsg}>{task.latestProgress}</Text> : null}
          {jobs.length === 0 && <Text style={styles.muted}>No jobs yet</Text>}
          {jobs.map((job) => (
            <JobRow
              key={job.jobId}
              job={job}
              logs={logs.get(job.jobId) ?? []}
              styles={styles}
              palette={palette}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function JobRow({
  job,
  logs,
  styles,
  palette,
}: {
  job: Job;
  logs: LogLine[];
  styles: TraceStyles;
  palette: TracePalette;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showRawLogs, setShowRawLogs] = useState(false);
  const color = statusColor(job.status, palette);

  const stdoutLines = useMemo(
    () => logs.filter((line) => line.stream === "stdout").sort((a, b) => a.seq - b.seq),
    [logs],
  );
  const stderrLines = useMemo(
    () => logs.filter((line) => line.stream === "stderr").sort((a, b) => a.seq - b.seq),
    [logs],
  );
  const trace = useMemo(() => extractTrace(job, logs), [job, logs]);
  const totalLines = stdoutLines.length + stderrLines.length;

  return (
    <View style={styles.jobCard}>
      <TouchableOpacity onPress={() => setExpanded(!expanded)} style={styles.jobHeader}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={styles.jobKind}>{job.kind}</Text>
        <Text style={[styles.statusBadge, { color }]}>{job.status}</Text>
        {job.workerId ? <Text style={styles.workerId}>@{job.workerId}</Text> : null}
        {trace.length > 0 || totalLines > 0 ? (
          <Text style={styles.logCount}>
            {trace.length} trace / {totalLines} raw
          </Text>
        ) : null}
        <Text style={styles.chevron}>{expanded ? "v" : ">"}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.jobBody}>
          {job.summary ? <Text style={styles.jobSummary}>{job.summary}</Text> : null}
          {job.message ? <Text style={styles.jobError}>{job.message}</Text> : null}
          {job.detail ? <Text style={styles.jobErrorDetail}>{job.detail}</Text> : null}

          {trace.length > 0 ? (
            <View style={styles.traceSection}>
              <Text style={styles.streamLabel}>Trace</Text>
              <ScrollView style={styles.traceScroll} nestedScrollEnabled>
                {trace.map((entry) => (
                  <Text
                    key={entry.key}
                    style={[styles.traceLine, traceToneStyle(entry.tone, styles)]}
                    selectable
                  >
                    [{entry.source}] {entry.line}
                  </Text>
                ))}
              </ScrollView>
            </View>
          ) : (
            <Text style={styles.muted}>No trace output captured for this job.</Text>
          )}

          {totalLines > 0 ? (
            <TouchableOpacity style={styles.rawToggle} onPress={() => setShowRawLogs(!showRawLogs)}>
              <Text style={styles.rawToggleText}>
                {showRawLogs ? "Hide raw logs" : `Show raw logs (${totalLines})`}
              </Text>
            </TouchableOpacity>
          ) : null}

          {showRawLogs && totalLines > 0 ? (
            <View style={styles.logSections}>
              {stdoutLines.length > 0 ? (
                <View>
                  <Text style={styles.streamLabel}>STDOUT</Text>
                  <ScrollView style={styles.logScroll} nestedScrollEnabled>
                    {stdoutLines.map((line) => (
                      <Text key={`stdout-${line.seq}`} style={[styles.logLine, styles.logStdout]} selectable>
                        {line.line}
                      </Text>
                    ))}
                  </ScrollView>
                </View>
              ) : null}
              {stderrLines.length > 0 ? (
                <View>
                  <Text style={styles.streamLabel}>STDERR</Text>
                  <ScrollView style={styles.logScroll} nestedScrollEnabled>
                    {stderrLines.map((line) => (
                      <Text key={`stderr-${line.seq}`} style={[styles.logLine, styles.logStderr]} selectable>
                        {line.line}
                      </Text>
                    ))}
                  </ScrollView>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

function OrphanJobs({
  jobs,
  logs,
  taskJobIds,
  styles,
  palette,
}: {
  jobs: Map<string, Job>;
  logs: Map<string, LogLine[]>;
  taskJobIds: Set<string>;
  styles: TraceStyles;
  palette: TracePalette;
}) {
  const orphanJobs = Array.from(jobs.values())
    .filter((job) => !taskJobIds.has(job.jobId))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (orphanJobs.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Standalone Jobs</Text>
      {orphanJobs.map((job) => (
        <JobRow key={job.jobId} job={job} logs={logs.get(job.jobId) ?? []} styles={styles} palette={palette} />
      ))}
    </View>
  );
}

export function TasksJobsLogs({
  state,
  theme,
}: {
  state: SessionState;
  theme?: TasksJobsLogsTheme;
}) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const mode = theme?.mode ?? "light";
  const palette = useMemo(() => paletteForMode(mode), [mode]);
  const styles = useMemo(() => createStyles(palette, theme), [palette, theme]);

  const tasks = Array.from(state.tasks.values()).sort((a, b) => a.ts.localeCompare(b.ts));
  const taskJobIds = new Set<string>();
  for (const task of tasks) {
    for (const jobId of task.jobIds) taskJobIds.add(jobId);
  }

  if (tasks.length === 0 && state.jobs.size === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.muted}>No tasks or jobs yet</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {tasks.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Tasks</Text>
          {tasks.map((task) => {
            const taskJobs = task.jobIds.map((jobId) => state.jobs.get(jobId)).filter(Boolean) as Job[];
            const jobOrder: Record<string, number> = {
              claimed: 0,
              enqueued: 1,
              completed: 2,
              failed: 3,
            };
            taskJobs.sort((a, b) => {
              const orderA = jobOrder[a.status] ?? 9;
              const orderB = jobOrder[b.status] ?? 9;
              return orderA !== orderB ? orderA - orderB : a.ts.localeCompare(b.ts);
            });

            return (
              <TaskRow
                key={task.taskId}
                task={task}
                jobs={taskJobs}
                logs={state.logs}
                expanded={expandedTaskId === task.taskId}
                onToggle={() => setExpandedTaskId(expandedTaskId === task.taskId ? null : task.taskId)}
                styles={styles}
                palette={palette}
              />
            );
          })}
        </View>
      ) : null}

      <OrphanJobs
        jobs={state.jobs}
        logs={state.logs}
        taskJobIds={taskJobIds}
        styles={styles}
        palette={palette}
      />
    </ScrollView>
  );
}
