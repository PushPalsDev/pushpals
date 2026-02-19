import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { QueueCounts } from "../lib/pushpalsApi";
import type { CoordinationRow, CoordinationStage, DashboardTheme, Tone } from "./dashboardTypes";
import {
  clip,
  prettyTs,
  queueValue,
  relativeMs,
  toneColor,
} from "./dashboardFormatters";
import { MetricTile } from "./MetricTile";

function stageLabel(stage: CoordinationStage): string {
  if (stage === "awaiting_remote") return "Awaiting Remote";
  if (stage === "planning") return "Planning";
  if (stage === "executing") return "Executing";
  if (stage === "ready_for_review") return "Ready For Review";
  return "Failed";
}

function stageTone(stage: CoordinationStage): Tone {
  if (stage === "ready_for_review") return "positive";
  if (stage === "failed") return "danger";
  if (stage === "planning" || stage === "executing") return "warning";
  return "accent";
}

export function CoordinationPane({
  theme,
  isWide,
  rows,
  requestCounts,
  jobCounts,
  completionCounts,
  onReusePrompt,
}: {
  theme: DashboardTheme;
  isWide: boolean;
  rows: CoordinationRow[];
  requestCounts: QueueCounts;
  jobCounts: QueueCounts;
  completionCounts: QueueCounts;
  onReusePrompt: (text: string) => void;
}) {
  const readyCount = rows.filter((row) => row.stage === "ready_for_review").length;
  const failedCount = rows.filter((row) => row.stage === "failed").length;
  const activeCount = rows.filter(
    (row) => row.stage === "planning" || row.stage === "executing",
  ).length;
  const awaitingCount = rows.filter((row) => row.stage === "awaiting_remote").length;
  const reviewRows = rows.filter((row) => row.stage === "ready_for_review").slice(0, 8);
  const blockedRows = rows.filter((row) => row.stage === "failed").slice(0, 8);
  const latestRows = rows.slice(0, 24);

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
      <View style={styles.metricRow}>
        <MetricTile
          title="Ready For Review"
          value={String(readyCount)}
          detail={`${queueValue(completionCounts, "processed")} processed completions`}
          tone={readyCount > 0 ? "positive" : "accent"}
          theme={theme}
        />
        <MetricTile
          title="Active Handoffs"
          value={String(activeCount)}
          detail={`${queueValue(jobCounts, "claimed")} running jobs`}
          tone={activeCount > 0 ? "warning" : "accent"}
          theme={theme}
        />
        <MetricTile
          title="Awaiting Remote"
          value={String(awaitingCount)}
          detail={`${queueValue(requestCounts, "pending")} pending requests`}
          tone={awaitingCount > 0 ? "warning" : "positive"}
          theme={theme}
        />
        <MetricTile
          title="Blocked"
          value={String(failedCount)}
          detail={`${queueValue(jobCounts, "failed")} failed jobs`}
          tone={failedCount > 0 ? "danger" : "positive"}
          theme={theme}
        />
      </View>

      <View style={[styles.grid, isWide && styles.gridWide]}>
        <View
          style={[styles.mainPanel, { borderColor: theme.border, backgroundColor: theme.panel }]}
        >
          <View style={styles.rowBetween}>
            <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
              Change Coordination Board
            </Text>
            <Text
              style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}
            >
              {latestRows.length} latest requests
            </Text>
          </View>
          {latestRows.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={[styles.emptyTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
                Nothing to coordinate yet
              </Text>
              <Text
                style={[
                  styles.emptySubtitle,
                  { color: theme.textMuted, fontFamily: theme.fontSans },
                ]}
              >
                Send a task from chat and this board will trace the full handoff from request to
                integration.
              </Text>
            </View>
          ) : (
            latestRows.map((row) => {
              const tone = stageTone(row.stage);
              const color = toneColor(theme, tone);
              const latestCompletion = row.completions[0];
              const reviewRef =
                latestCompletion && latestCompletion.status === "processed"
                  ? `${latestCompletion.branch ?? "branch"} @ ${latestCompletion.commitSha?.slice(0, 8) ?? "--"}`
                  : null;
              return (
                <View
                  key={row.request.id}
                  style={[
                    styles.card,
                    { borderColor: theme.border, backgroundColor: theme.panelAlt },
                  ]}
                >
                  <View style={styles.rowBetween}>
                    <Text
                      style={[styles.requestId, { color: theme.text, fontFamily: theme.fontMono }]}
                    >
                      {row.request.id.slice(0, 8)}
                    </Text>
                    <View
                      style={[
                        styles.statusPill,
                        {
                          borderColor: `${color}66`,
                          backgroundColor: `${color}22`,
                        },
                      ]}
                    >
                      <Text style={[styles.statusPillText, { color, fontFamily: theme.fontSans }]}>
                        {stageLabel(row.stage)}
                      </Text>
                    </View>
                  </View>
                  <Text
                    style={[
                      styles.requestPrompt,
                      { color: theme.text, fontFamily: theme.fontSans },
                    ]}
                  >
                    {clip(row.request.prompt, 280)}
                  </Text>
                  <Text
                    style={[
                      styles.requestSubline,
                      { color: theme.textMuted, fontFamily: theme.fontSans },
                    ]}
                  >
                    priority {row.request.priority ?? "normal"} | created{" "}
                    {prettyTs(row.request.createdAt)} | updated {relativeMs(row.request.updatedAt)}
                  </Text>
                  <Text
                    style={[
                      styles.stageDetail,
                      { color: theme.textMuted, fontFamily: theme.fontSans },
                    ]}
                  >
                    {row.stageDetail}
                  </Text>

                  <View style={styles.laneRow}>
                    <View
                      style={[
                        styles.laneChip,
                        { borderColor: theme.border, backgroundColor: theme.panel },
                      ]}
                    >
                      <Text
                        style={[
                          styles.laneLabel,
                          { color: theme.textMuted, fontFamily: theme.fontSans },
                        ]}
                      >
                        User
                      </Text>
                      <Text
                        style={[
                          styles.laneValue,
                          { color: theme.text, fontFamily: theme.fontSans },
                        ]}
                      >
                        Requested
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.laneChip,
                        { borderColor: theme.border, backgroundColor: theme.panel },
                      ]}
                    >
                      <Text
                        style={[
                          styles.laneLabel,
                          { color: theme.textMuted, fontFamily: theme.fontSans },
                        ]}
                      >
                        Remote
                      </Text>
                      <Text
                        style={[
                          styles.laneValue,
                          { color: theme.text, fontFamily: theme.fontSans },
                        ]}
                      >
                        {row.jobs.length > 0 ? `${row.jobs.length} job(s)` : "Waiting"}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.laneChip,
                        { borderColor: theme.border, backgroundColor: theme.panel },
                      ]}
                    >
                      <Text
                        style={[
                          styles.laneLabel,
                          { color: theme.textMuted, fontFamily: theme.fontSans },
                        ]}
                      >
                        Worker
                      </Text>
                      <Text
                        style={[
                          styles.laneValue,
                          { color: theme.text, fontFamily: theme.fontSans },
                        ]}
                      >
                        {row.jobs.some((job) => job.status === "claimed") ? "Running" : "Idle"}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.laneChip,
                        { borderColor: theme.border, backgroundColor: theme.panel },
                      ]}
                    >
                      <Text
                        style={[
                          styles.laneLabel,
                          { color: theme.textMuted, fontFamily: theme.fontSans },
                        ]}
                      >
                        SCM
                      </Text>
                      <Text
                        style={[
                          styles.laneValue,
                          { color: theme.text, fontFamily: theme.fontSans },
                        ]}
                      >
                        {reviewRef ? "Ready" : "Pending"}
                      </Text>
                    </View>
                  </View>

                  {reviewRef ? (
                    <Text
                      style={[
                        styles.reviewRef,
                        { color: theme.positive, fontFamily: theme.fontMono },
                      ]}
                    >
                      review {reviewRef}
                    </Text>
                  ) : null}
                  <Pressable
                    style={[
                      styles.reuseButton,
                      { borderColor: theme.border, backgroundColor: theme.panel },
                    ]}
                    onPress={() => onReusePrompt(row.request.prompt)}
                    accessibilityRole="button"
                    accessibilityLabel={`Reuse request ${row.request.id.slice(0, 8)} prompt`}
                    accessibilityHint="Moves this prompt back into chat composer for edits or retry."
                  >
                    <Text
                      style={[
                        styles.reuseLabel,
                        { color: theme.accent, fontFamily: theme.fontSans },
                      ]}
                    >
                      Reuse Prompt In Chat
                    </Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </View>

        <View
          style={[
            styles.sidePanel,
            isWide && styles.sidePanelWide,
            { borderColor: theme.border, backgroundColor: theme.panel },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
            Review Queue
          </Text>
          {reviewRows.length === 0 ? (
            <Text
              style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}
            >
              No processed completions yet.
            </Text>
          ) : (
            reviewRows.map((row) => {
              const completion = row.completions.find((entry) => entry.status === "processed");
              return (
                <View
                  key={`review-${row.request.id}`}
                  style={[
                    styles.sideCard,
                    { borderColor: theme.border, backgroundColor: theme.panelAlt },
                  ]}
                >
                  <Text
                    style={[styles.requestId, { color: theme.text, fontFamily: theme.fontMono }]}
                  >
                    {row.request.id.slice(0, 8)}
                  </Text>
                  <Text
                    style={[styles.sidePrompt, { color: theme.text, fontFamily: theme.fontSans }]}
                  >
                    {clip(row.request.prompt, 110)}
                  </Text>
                  <Text
                    style={[styles.sideMeta, { color: theme.positive, fontFamily: theme.fontMono }]}
                  >
                    {completion?.branch ?? "--"} | {completion?.commitSha?.slice(0, 8) ?? "--"}
                  </Text>
                </View>
              );
            })
          )}

          <Text
            style={[
              styles.sectionTitle,
              { color: theme.text, fontFamily: theme.fontSans, marginTop: 14 },
            ]}
          >
            Needs Attention
          </Text>
          {blockedRows.length === 0 ? (
            <Text
              style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}
            >
              No failed coordination chains.
            </Text>
          ) : (
            blockedRows.map((row) => (
              <View
                key={`blocked-${row.request.id}`}
                style={[
                  styles.sideCard,
                  { borderColor: `${theme.danger}66`, backgroundColor: `${theme.danger}14` },
                ]}
              >
                <Text style={[styles.requestId, { color: theme.text, fontFamily: theme.fontMono }]}>
                  {row.request.id.slice(0, 8)}
                </Text>
                <Text
                  style={[styles.sidePrompt, { color: theme.text, fontFamily: theme.fontSans }]}
                >
                  {clip(row.request.prompt, 110)}
                </Text>
                <Text
                  style={[styles.sideMeta, { color: theme.danger, fontFamily: theme.fontSans }]}
                >
                  {row.stageDetail}
                </Text>
              </View>
            ))
          )}
        </View>
      </View>
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
  grid: {
    flexDirection: "column",
  },
  gridWide: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  mainPanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
    flex: 1.35,
  },
  sidePanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
    flex: 0.85,
    marginLeft: 0,
  },
  sidePanelWide: {
    marginLeft: 10,
  },

  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 8,
  },
  systemMeta: { fontSize: 11, marginTop: 5 },

  emptyState: {
    borderRadius: 16,
    padding: 16,
    alignItems: "flex-start",
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  emptySubtitle: { fontSize: 13, lineHeight: 19 },

  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
  },
  requestId: { fontSize: 12, fontWeight: "700" },
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
  requestPrompt: { fontSize: 14, lineHeight: 20, marginTop: 7 },
  requestSubline: { fontSize: 12, marginTop: 6 },
  stageDetail: {
    fontSize: 12,
    marginTop: 6,
    lineHeight: 18,
  },
  laneRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 8,
  },
  laneChip: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 7,
    marginRight: 6,
    marginBottom: 6,
    minWidth: 92,
  },
  laneLabel: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  laneValue: {
    marginTop: 3,
    fontSize: 12,
    fontWeight: "700",
  },
  reviewRef: {
    marginTop: 6,
    fontSize: 11,
  },
  reuseButton: {
    borderWidth: 1,
    borderRadius: 10,
    marginTop: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  reuseLabel: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.2,
  },

  sideCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
  },
  sidePrompt: {
    marginTop: 5,
    fontSize: 12,
    lineHeight: 18,
  },
  sideMeta: {
    marginTop: 5,
    fontSize: 11,
  },
});
