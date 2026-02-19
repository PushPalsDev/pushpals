import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { PendingQueueSnapshot, QueueCounts, RequestSnapshotRow } from "../lib/pushpalsApi";
import type { DashboardTheme } from "./dashboardTypes";
import {
  clip,
  formatDuration,
  formatEtaMs,
  parseJsonText,
  prettyTs,
  queueValue,
  relativeMs,
  statusColor,
} from "./dashboardFormatters";
import { MetricTile } from "./MetricTile";

export function RequestsPane({
  theme,
  rows,
  counts,
  pendingSnapshot,
}: {
  theme: DashboardTheme;
  rows: RequestSnapshotRow[];
  counts: QueueCounts;
  pendingSnapshot: PendingQueueSnapshot[];
}) {
  const pendingById = useMemo(
    () => new Map(pendingSnapshot.map((snapshot) => [snapshot.id, snapshot])),
    [pendingSnapshot],
  );

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
      <View style={styles.metricRow}>
        <MetricTile
          title="Pending"
          value={String(queueValue(counts, "pending"))}
          tone="warning"
          theme={theme}
        />
        <MetricTile
          title="Claimed"
          value={String(queueValue(counts, "claimed"))}
          tone="accent"
          theme={theme}
        />
        <MetricTile
          title="Completed"
          value={String(queueValue(counts, "completed"))}
          tone="positive"
          theme={theme}
        />
        <MetricTile
          title="Failed"
          value={String(queueValue(counts, "failed"))}
          tone="danger"
          theme={theme}
        />
      </View>

      {rows.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
            No requests yet
          </Text>
          <Text
            style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}
          >
            Requests from LocalBuddy will appear here with full lifecycle status.
          </Text>
        </View>
      ) : (
        rows.map((request) => {
          const rowColor = statusColor(theme, request.status);
          const resultText = parseJsonText(request.result);
          const errorText = parseJsonText(request.error);
          const queueMeta = pendingById.get(request.id);
          const priority = request.priority ?? "normal";
          const phaseBits = [
            request.enqueuedAt ? `enq ${prettyTs(request.enqueuedAt)}` : null,
            request.claimedAt ? `claim ${prettyTs(request.claimedAt)}` : null,
            request.completedAt ? `done ${prettyTs(request.completedAt)}` : null,
            request.failedAt ? `fail ${prettyTs(request.failedAt)}` : null,
          ].filter(Boolean) as string[];
          const lifecycleSummary =
            request.status === "pending" && queueMeta
              ? `queue #${queueMeta.position} (eta ${formatEtaMs(queueMeta.etaMs)})`
              : request.durationMs != null
                ? `elapsed ${formatDuration(request.durationMs)}`
                : "in progress";

          return (
            <View
              key={request.id}
              style={[
                styles.card,
                {
                  borderColor: theme.border,
                  backgroundColor: theme.panel,
                },
              ]}
            >
              <View style={styles.rowBetween}>
                <Text style={[styles.requestId, { color: theme.text, fontFamily: theme.fontMono }]}>
                  {request.id.slice(0, 8)}
                </Text>
                <View
                  style={[
                    styles.statusPill,
                    {
                      backgroundColor: `${rowColor}22`,
                      borderColor: `${rowColor}66`,
                    },
                  ]}
                >
                  <Text
                    style={[styles.statusPillText, { color: rowColor, fontFamily: theme.fontSans }]}
                  >
                    {request.status}
                  </Text>
                </View>
              </View>
              <Text
                style={[styles.requestPrompt, { color: theme.text, fontFamily: theme.fontSans }]}
              >
                {clip(request.prompt, 260)}
              </Text>
              <Text
                style={[
                  styles.requestSubline,
                  { color: theme.textMuted, fontFamily: theme.fontSans },
                ]}
              >
                priority {priority} | {lifecycleSummary}
              </Text>
              <Text
                style={[
                  styles.requestSubline,
                  { color: theme.textMuted, fontFamily: theme.fontSans },
                ]}
              >
                agent {request.agentId ?? "--"} | created {prettyTs(request.createdAt)} | updated{" "}
                {relativeMs(request.updatedAt)}
              </Text>
              {phaseBits.length > 0 ? (
                <Text
                  style={[
                    styles.requestPhaseLine,
                    { color: theme.textMuted, fontFamily: theme.fontMono },
                  ]}
                >
                  {phaseBits.join(" | ")}
                </Text>
              ) : null}
              {request.queueWaitBudgetMs != null ? (
                <Text
                  style={[
                    styles.requestSubline,
                    { color: theme.textMuted, fontFamily: theme.fontSans },
                  ]}
                >
                  queue budget {formatDuration(request.queueWaitBudgetMs)}
                </Text>
              ) : null}
              {request.durationMs != null ? (
                <Text
                  style={[
                    styles.requestSubline,
                    { color: theme.textMuted, fontFamily: theme.fontSans },
                  ]}
                >
                  request duration {formatDuration(request.durationMs)}
                </Text>
              ) : null}
              {resultText ? (
                <View
                  style={[
                    styles.codeBlock,
                    {
                      borderColor: theme.border,
                      backgroundColor: theme.panelAlt,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.codeBlockLabel,
                      { color: theme.positive, fontFamily: theme.fontSans },
                    ]}
                  >
                    result
                  </Text>
                  <Text
                    style={[
                      styles.codeBlockText,
                      { color: theme.text, fontFamily: theme.fontMono },
                    ]}
                  >
                    {clip(resultText, 600)}
                  </Text>
                </View>
              ) : null}
              {errorText ? (
                <View
                  style={[
                    styles.codeBlock,
                    {
                      borderColor: `${theme.danger}77`,
                      backgroundColor: `${theme.danger}14`,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.codeBlockLabel,
                      { color: theme.danger, fontFamily: theme.fontSans },
                    ]}
                  >
                    error
                  </Text>
                  <Text
                    style={[
                      styles.codeBlockText,
                      { color: theme.text, fontFamily: theme.fontMono },
                    ]}
                  >
                    {clip(errorText, 600)}
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 18,
  },
  metricRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingBottom: 10,
  },
  emptyState: {
    borderRadius: 16,
    padding: 16,
    alignItems: "flex-start",
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  emptySubtitle: { fontSize: 13, lineHeight: 19 },
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  requestId: { fontSize: 12, fontWeight: "700" },
  requestPrompt: { fontSize: 14, lineHeight: 20, marginTop: 7 },
  requestSubline: { fontSize: 12, marginTop: 6 },
  requestPhaseLine: { fontSize: 11, marginTop: 6 },
  statusPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  codeBlock: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
    padding: 8,
  },
  codeBlockLabel: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    marginBottom: 4,
  },
  codeBlockText: {
    fontSize: 12,
    lineHeight: 17,
  },
});
