import React, { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { TasksJobsLogs } from "../lib/TasksJobsLogs";
import type { SessionState } from "../lib/eventReducer";
import type {
  CompletionSnapshotRow,
  JobSnapshotRow,
  PendingQueueSnapshot,
  QueueCounts,
} from "../lib/pushpalsApi";
import type { DashboardTheme } from "./dashboardTypes";
import {
  clip,
  formatDuration,
  formatEtaMs,
  prettyTs,
  queueValue,
  relativeMs,
  statusColor,
} from "./dashboardFormatters";
import { MetricTile } from "./MetricTile";

function parseJobParamsRequestId(params: string): string | null {
  if (!params) return null;
  try {
    const parsed = JSON.parse(params) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).requestId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveJobElapsedMs(job: JobSnapshotRow): number | null {
  if (typeof job.durationMs === "number" && Number.isFinite(job.durationMs) && job.durationMs >= 0) {
    return Math.floor(job.durationMs);
  }

  const end =
    parseIsoMs(job.completedAt) ??
    parseIsoMs(job.failedAt) ??
    (job.status === "completed" || job.status === "failed" ? parseIsoMs(job.updatedAt) : null);
  const start =
    parseIsoMs(job.startedAt) ?? parseIsoMs(job.claimedAt) ?? parseIsoMs(job.enqueuedAt);
  if (start == null || end == null || end < start) return null;
  return end - start;
}

export function JobsPane({
  theme,
  isWide,
  jobs,
  jobCounts,
  pendingSnapshot,
  completions,
  completionCounts,
  sessionState,
  requestFilterId,
  jobFilterId,
  onClearFilter,
}: {
  theme: DashboardTheme;
  isWide: boolean;
  jobs: JobSnapshotRow[];
  jobCounts: QueueCounts;
  pendingSnapshot: PendingQueueSnapshot[];
  completions: CompletionSnapshotRow[];
  completionCounts: QueueCounts;
  sessionState: SessionState;
  requestFilterId?: string | null;
  jobFilterId?: string | null;
  onClearFilter?: () => void;
}) {
  const filteredJobs = useMemo(() => {
    if (jobFilterId) return jobs.filter((job) => job.id === jobFilterId);
    if (requestFilterId) {
      return jobs.filter((job) => parseJobParamsRequestId(job.params) === requestFilterId);
    }
    return jobs;
  }, [jobs, requestFilterId, jobFilterId]);
  const recentJobs = filteredJobs.slice(0, 40);
  const filteredJobIds = useMemo(() => new Set(filteredJobs.map((job) => job.id)), [filteredJobs]);
  const visibleCompletions = useMemo(() => {
    if (filteredJobIds.size === 0 && (requestFilterId || jobFilterId)) return [];
    if (!requestFilterId && !jobFilterId) return completions;
    return completions.filter((completion) => filteredJobIds.has(completion.jobId));
  }, [completions, filteredJobIds, requestFilterId, jobFilterId]);
  const pendingById = useMemo(
    () => new Map(pendingSnapshot.map((snapshot) => [snapshot.id, snapshot])),
    [pendingSnapshot],
  );
  const hasFilter = Boolean(requestFilterId || jobFilterId);
  const focusJobId = jobFilterId ?? (filteredJobs[0]?.id ?? null);

  return (
    <View style={styles.fill}>
      <View style={styles.metricRow}>
        <MetricTile
          title="Queued Jobs"
          value={String(queueValue(jobCounts, "pending"))}
          tone="warning"
          theme={theme}
        />
        <MetricTile
          title="Running Jobs"
          value={String(queueValue(jobCounts, "claimed"))}
          tone="accent"
          theme={theme}
        />
        <MetricTile
          title="Completions"
          value={String(queueValue(completionCounts, "processed"))}
          tone="positive"
          theme={theme}
        />
        <MetricTile
          title="Failed Jobs"
          value={String(queueValue(jobCounts, "failed"))}
          tone="danger"
          theme={theme}
        />
      </View>

      <View style={[styles.jobsLayout, isWide && styles.jobsLayoutWide]}>
        <View
          style={[styles.jobsListPane, { borderColor: theme.border, backgroundColor: theme.panel }]}
        >
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
              Queue Activity
            </Text>
            {hasFilter && onClearFilter ? (
              <Pressable
                style={[
                  styles.clearFilterButton,
                  { borderColor: theme.border, backgroundColor: theme.panelAlt },
                ]}
                onPress={onClearFilter}
              >
                <Text
                  style={[styles.clearFilterLabel, { color: theme.accent, fontFamily: theme.fontSans }]}
                >
                  Clear Filter
                </Text>
              </Pressable>
            ) : null}
          </View>
          {hasFilter ? (
            <Text style={[styles.filterMeta, { color: theme.textMuted, fontFamily: theme.fontMono }]}>
              request {requestFilterId?.slice(0, 8) ?? "--"} | job {jobFilterId?.slice(0, 8) ?? "--"}
            </Text>
          ) : null}
          {recentJobs.length === 0 ? (
            <Text
              style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}
            >
              {hasFilter ? "No jobs matched the selected request/job." : "No job rows yet."}
            </Text>
          ) : (
            <FlatList
              data={recentJobs}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => {
                const color = statusColor(theme, item.status);
                const queueMeta = pendingById.get(item.id);
                const priority = item.priority ?? "normal";
                const elapsedMs = deriveJobElapsedMs(item);
                const phaseBits = [
                  item.enqueuedAt ? `enq ${prettyTs(item.enqueuedAt)}` : null,
                  item.claimedAt ? `claim ${prettyTs(item.claimedAt)}` : null,
                  item.startedAt ? `start ${prettyTs(item.startedAt)}` : null,
                  item.firstLogAt ? `first-log ${prettyTs(item.firstLogAt)}` : null,
                  item.completedAt ? `done ${prettyTs(item.completedAt)}` : null,
                  item.failedAt ? `fail ${prettyTs(item.failedAt)}` : null,
                ].filter(Boolean) as string[];
                const isTerminal = item.status === "completed" || item.status === "failed";
                if (isTerminal && elapsedMs != null) {
                  phaseBits.push(`elapsed ${formatDuration(elapsedMs)}`);
                }
                const lifecycleSummary =
                  item.status === "pending" && queueMeta
                    ? `queue #${queueMeta.position} (eta ${formatEtaMs(queueMeta.etaMs)})`
                    : item.status === "claimed"
                      ? "running"
                      : elapsedMs != null
                        ? `elapsed ${formatDuration(elapsedMs)}`
                        : "terminal";

                return (
                  <View style={[styles.jobRow, { borderColor: theme.border }]}>
                    <View style={[styles.jobDot, { backgroundColor: color }]} />
                    <View style={styles.jobTextCol}>
                      <Text
                        style={[styles.jobKind, { color: theme.text, fontFamily: theme.fontSans }]}
                      >
                        {item.kind}
                      </Text>
                      <Text
                        style={[
                          styles.jobMeta,
                          { color: theme.textMuted, fontFamily: theme.fontSans },
                        ]}
                      >
                        {item.id.slice(0, 8)} | worker {item.workerId ?? "--"} |{" "}
                        {relativeMs(item.updatedAt)}
                      </Text>
                      <Text
                        style={[
                          styles.jobMeta,
                          { color: theme.textMuted, fontFamily: theme.fontSans },
                        ]}
                      >
                        priority {priority} | {lifecycleSummary}
                      </Text>
                      {phaseBits.length > 0 ? (
                        <Text
                          style={[
                            styles.jobPhaseLine,
                            { color: theme.textMuted, fontFamily: theme.fontMono },
                          ]}
                        >
                          {phaseBits.join(" | ")}
                        </Text>
                      ) : null}
                      {item.executionBudgetMs != null || item.finalizationBudgetMs != null ? (
                        <Text
                          style={[
                            styles.jobMeta,
                            { color: theme.textMuted, fontFamily: theme.fontSans },
                          ]}
                        >
                          budget exec {formatDuration(item.executionBudgetMs)} | finalize{" "}
                          {formatDuration(item.finalizationBudgetMs)}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={[styles.jobStatus, { color, fontFamily: theme.fontSans }]}>
                      {item.status}
                    </Text>
                  </View>
                );
              }}
            />
          )}

          {visibleCompletions.length > 0 ? (
            <View style={styles.completionStrip}>
              <Text
                style={[styles.subSectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}
              >
                Recent Completions
              </Text>
              {visibleCompletions.slice(0, 16).map((completion) => {
                const color = statusColor(theme, completion.status);
                return (
                  <View
                    key={completion.id}
                    style={[styles.completionRow, { borderColor: theme.border }]}
                  >
                    <Text
                      style={[
                        styles.completionMeta,
                        { color: theme.text, fontFamily: theme.fontMono },
                      ]}
                    >
                      {completion.id.slice(0, 8)}
                    </Text>
                    <Text
                      style={[
                        styles.completionLine,
                        { color: theme.textMuted, fontFamily: theme.fontSans },
                      ]}
                    >
                      {clip(completion.message, 110)}
                    </Text>
                    <Text
                      style={[
                        styles.completionMeta,
                        { color: theme.textMuted, fontFamily: theme.fontSans },
                      ]}
                    >
                      {completion.branch ?? "--"} | {completion.commitSha?.slice(0, 8) ?? "--"}
                    </Text>
                    <Text style={[styles.completionStatus, { color, fontFamily: theme.fontSans }]}>
                      {completion.status}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>

        <View
          style={[
            styles.jobsTracePane,
            { borderColor: theme.border, backgroundColor: theme.panel },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
            Tasks and Traces
          </Text>
          <View style={styles.tracePanelBody}>
            <TasksJobsLogs
              state={sessionState}
              theme={{
                mode: theme.mode,
                fontSans: theme.fontSans,
                fontMono: theme.fontMono,
              }}
              focusJobId={focusJobId}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  metricRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
  emptySubtitle: { fontSize: 13, lineHeight: 19 },
  jobsLayout: {
    flex: 1,
    flexDirection: "column",
    paddingHorizontal: 20,
    paddingBottom: 14,
  },
  jobsLayoutWide: {
    flexDirection: "row",
  },
  jobsListPane: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
    minHeight: 220,
  },
  jobsTracePane: {
    flex: 1.25,
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    minHeight: 260,
  },
  tracePanelBody: { flex: 1, minHeight: 260 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 8,
  },
  filterMeta: {
    fontSize: 11,
    marginBottom: 8,
  },
  clearFilterButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 4,
    marginBottom: 8,
    marginLeft: 8,
  },
  clearFilterLabel: {
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.2,
  },
  subSectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 5,
  },
  jobRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    paddingVertical: 8,
  },
  jobDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  jobTextCol: { flex: 1 },
  jobKind: { fontSize: 13, fontWeight: "700" },
  jobMeta: { fontSize: 12, marginTop: 2 },
  jobPhaseLine: { fontSize: 11, marginTop: 4 },
  jobStatus: { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  completionStrip: { marginTop: 8 },
  completionRow: {
    borderTopWidth: 1,
    paddingTop: 8,
    marginTop: 7,
  },
  completionLine: { fontSize: 12, marginBottom: 3 },
  completionMeta: { fontSize: 11, marginBottom: 2 },
  completionStatus: { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
});
