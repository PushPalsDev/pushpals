import React, { useMemo, useRef } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { SystemStatusSummary, WorkerStatusRow } from "../lib/pushpalsApi";
import type { DashboardTheme } from "./dashboardTypes";
import {
  clip,
  formatDuration,
  formatPercent,
  prettyTs,
  queueValue,
  relativeMs,
  statusColor,
} from "./dashboardFormatters";
import { MetricTile } from "./MetricTile";

type SessionEvent = {
  id: string;
  ts: string;
  type: string;
  from?: string;
  payload?: Record<string, unknown>;
};

function summarizeEvent(event: SessionEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const preferredKeys = [
    "message",
    "summary",
    "title",
    "detail",
    "error",
    "status",
    "kind",
    "jobId",
    "taskId",
    "requestId",
  ] as const;

  for (const key of preferredKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return clip(value, 140);
  }

  if (typeof payload === "object" && payload && Object.keys(payload).length > 0) {
    return clip(JSON.stringify(payload), 140);
  }

  return "No payload details";
}

export function SystemPane({
  theme,
  events,
  connected,
  workers,
  systemSummary,
  lastRefresh,
}: {
  theme: DashboardTheme;
  events: SessionEvent[];
  connected: boolean;
  workers: WorkerStatusRow[];
  systemSummary: SystemStatusSummary;
  lastRefresh: string | null;
}) {
  const INITIALIZING_GRACE_MS = 90_000;
  const connectedSinceRef = useRef<number | null>(null);
  if (connected) {
    if (connectedSinceRef.current == null) {
      connectedSinceRef.current = Date.now();
    }
  } else {
    connectedSinceRef.current = null;
  }
  const withinInitializingGrace =
    connected &&
    connectedSinceRef.current != null &&
    Date.now() - connectedSinceRef.current < INITIALIZING_GRACE_MS;

  const latestEventByComponent = useMemo(() => {
    const byName: Record<string, string | undefined> = {
      LocalBuddy: undefined,
      RemoteBuddy: undefined,
      WorkerPals: undefined,
      SourceControlManager: undefined,
    };

    const hasAny = (value: string, needles: string[]): boolean =>
      needles.some((needle) => value.includes(needle));

    for (const event of events) {
      const from = (event.from ?? "").toLowerCase();
      const payload = event.payload as Record<string, unknown>;
      const payloadAgentId =
        typeof payload?.agentId === "string" ? (payload.agentId as string).toLowerCase() : "";
      const signal = `${from} ${payloadAgentId}`;

      if (hasAny(signal, ["localbuddy", "local_buddy", "local buddy"]))
        byName.LocalBuddy = event.ts;
      if (hasAny(signal, ["remotebuddy", "remote_buddy", "remote buddy"])) {
        byName.RemoteBuddy = event.ts;
      }
      if (hasAny(signal, ["workerpal", "workerpals", "worker_pal", "worker pals", "worker"])) {
        byName.WorkerPals = event.ts;
      }
      if (
        hasAny(signal, [
          "source_control_manager",
          "sourcecontrolmanager",
          "source control manager",
          "source-control-manager",
          "scm",
        ])
      ) {
        byName.SourceControlManager = event.ts;
      }
    }
    return byName;
  }, [events]);

  const onlineWorkers = workers.filter((worker) => worker.isOnline).length;
  const recentEvents = useMemo(() => events.slice(-40).reverse(), [events]);
  const requestSlo = systemSummary.slo?.requests;
  const jobSlo = systemSummary.slo?.jobs;

  const componentRows = [
    {
      name: "Server Stream",
      status: connected ? "connected" : "disconnected",
      detail: connected ? "session event stream live" : "not connected",
      ts: systemSummary.ts,
    },
    {
      name: "LocalBuddy",
      status: latestEventByComponent.LocalBuddy
        ? "active"
        : withinInitializingGrace
          ? "initializing"
          : "unknown",
      detail: latestEventByComponent.LocalBuddy
        ? `last event ${relativeMs(latestEventByComponent.LocalBuddy)}`
        : withinInitializingGrace
          ? "waiting for first status event"
          : "no events yet",
      ts: latestEventByComponent.LocalBuddy,
    },
    {
      name: "RemoteBuddy",
      status: latestEventByComponent.RemoteBuddy
        ? "active"
        : withinInitializingGrace
          ? "initializing"
          : "unknown",
      detail: latestEventByComponent.RemoteBuddy
        ? `last event ${relativeMs(latestEventByComponent.RemoteBuddy)}`
        : withinInitializingGrace
          ? "waiting for first status event"
          : "no events yet",
      ts: latestEventByComponent.RemoteBuddy,
    },
    {
      name: "WorkerPals",
      status: onlineWorkers > 0 ? "online" : "offline",
      detail: `${onlineWorkers}/${workers.length} online`,
      ts: workers[0]?.lastHeartbeat,
    },
    {
      name: "SourceControlManager",
      status: latestEventByComponent.SourceControlManager
        ? "active"
        : withinInitializingGrace
          ? "initializing"
          : "unknown",
      detail: latestEventByComponent.SourceControlManager
        ? `last event ${relativeMs(latestEventByComponent.SourceControlManager)}`
        : withinInitializingGrace
          ? "waiting for first status event"
          : "no events yet",
      ts: latestEventByComponent.SourceControlManager,
    },
  ];

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
      <View style={styles.metricRow}>
        <MetricTile
          title="Online Workers"
          value={String(systemSummary.workers?.online ?? onlineWorkers)}
          detail={`${systemSummary.workers?.busy ?? workers.filter((w) => w.status === "busy").length} busy`}
          tone="accent"
          theme={theme}
        />
        <MetricTile
          title="Pending Requests"
          value={String(queueValue(systemSummary.queues?.requests, "pending"))}
          tone="warning"
          theme={theme}
        />
        <MetricTile
          title="Pending Completions"
          value={String(queueValue(systemSummary.queues?.completions, "pending"))}
          tone="warning"
          theme={theme}
        />
        <MetricTile
          title="Refresh"
          value={lastRefresh ? relativeMs(lastRefresh) : "--"}
          detail={lastRefresh ? prettyTs(lastRefresh) : "no sync"}
          theme={theme}
        />
        <MetricTile
          title="Request SLO (24h)"
          value={formatPercent(requestSlo?.successRate)}
          detail={`p95 wait ${formatDuration(requestSlo?.queueWaitMs?.p95)}`}
          theme={theme}
        />
        <MetricTile
          title="Job SLO (24h)"
          value={formatPercent(jobSlo?.successRate)}
          detail={`timeout ${formatPercent(jobSlo?.timeoutRate)} | p95 run ${formatDuration(jobSlo?.durationMs?.p95)}`}
          theme={theme}
        />
      </View>

      <View style={styles.systemGrid}>
        {componentRows.map((row) => {
          const color = statusColor(theme, row.status);
          return (
            <View
              key={row.name}
              style={[
                styles.systemCard,
                { borderColor: theme.border, backgroundColor: theme.panel },
              ]}
            >
              <View style={styles.rowBetween}>
                <Text
                  style={[styles.systemTitle, { color: theme.text, fontFamily: theme.fontSans }]}
                >
                  {row.name}
                </Text>
                <View
                  style={[
                    styles.statusPill,
                    {
                      backgroundColor: `${color}22`,
                      borderColor: `${color}66`,
                    },
                  ]}
                >
                  <Text style={[styles.statusPillText, { color, fontFamily: theme.fontSans }]}>
                    {row.status}
                  </Text>
                </View>
              </View>
              <Text
                style={[
                  styles.systemDetail,
                  { color: theme.textMuted, fontFamily: theme.fontSans },
                ]}
              >
                {row.detail}
              </Text>
              <Text
                style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}
              >
                {row.ts ? `updated ${prettyTs(row.ts)}` : "no timestamp"}
              </Text>
            </View>
          );
        })}
      </View>

      <View
        style={[styles.workerPanel, { borderColor: theme.border, backgroundColor: theme.panel }]}
      >
        <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
          Worker Fleet
        </Text>
        {workers.length === 0 ? (
          <Text
            style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}
          >
            No workers reported yet.
          </Text>
        ) : (
          workers.map((worker) => {
            const color = statusColor(theme, worker.status);
            return (
              <View key={worker.workerId} style={[styles.workerRow, { borderColor: theme.border }]}>
                <View style={[styles.jobDot, { backgroundColor: color }]} />
                <View style={styles.workerTextCol}>
                  <Text
                    style={[styles.workerName, { color: theme.text, fontFamily: theme.fontSans }]}
                  >
                    {worker.workerId}
                  </Text>
                  <Text
                    style={[
                      styles.workerMeta,
                      { color: theme.textMuted, fontFamily: theme.fontSans },
                    ]}
                  >
                    {worker.status} | job {worker.currentJobId?.slice(0, 8) ?? "--"} | heartbeat{" "}
                    {relativeMs(worker.lastHeartbeat)}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </View>

      <View
        style={[styles.eventPanel, { borderColor: theme.border, backgroundColor: theme.panel }]}
      >
        <View style={styles.rowBetween}>
          <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
            Recent Event Stream
          </Text>
          <Text style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
            {recentEvents.length} latest
          </Text>
        </View>
        {recentEvents.length === 0 ? (
          <Text
            style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}
          >
            No events yet.
          </Text>
        ) : (
          recentEvents.map((event) => {
            const color = statusColor(theme, event.type);
            return (
              <View key={event.id} style={[styles.eventRow, { borderColor: theme.border }]}>
                <View style={styles.eventMain}>
                  <Text
                    style={[
                      styles.eventMeta,
                      { color: theme.textMuted, fontFamily: theme.fontMono },
                    ]}
                  >
                    {prettyTs(event.ts)} | {event.from ?? "unknown"}
                  </Text>
                  <Text
                    style={[styles.eventSummary, { color: theme.text, fontFamily: theme.fontSans }]}
                  >
                    {summarizeEvent(event)}
                  </Text>
                </View>
                <View
                  style={[
                    styles.statusPill,
                    {
                      backgroundColor: `${color}22`,
                      borderColor: `${color}66`,
                    },
                  ]}
                >
                  <Text style={[styles.statusPillText, { color, fontFamily: theme.fontSans }]}>
                    {event.type}
                  </Text>
                </View>
              </View>
            );
          })
        )}
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
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 8,
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
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
  emptySubtitle: { fontSize: 13, lineHeight: 19 },
  systemGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 6,
  },
  systemCard: {
    width: "48%",
    minWidth: 240,
    borderWidth: 1,
    borderRadius: 14,
    padding: 11,
    marginRight: 8,
    marginBottom: 8,
  },
  systemTitle: { fontSize: 14, fontWeight: "700" },
  systemDetail: { fontSize: 12, marginTop: 7 },
  systemMeta: { fontSize: 11, marginTop: 5 },
  workerPanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  workerRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    paddingVertical: 9,
  },
  jobDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  workerTextCol: { flex: 1 },
  workerName: { fontSize: 13, fontWeight: "700" },
  workerMeta: { fontSize: 12, marginTop: 2 },
  eventPanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  eventRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    paddingVertical: 8,
    gap: 8,
  },
  eventMain: { flex: 1 },
  eventMeta: { fontSize: 11 },
  eventSummary: { fontSize: 13, marginTop: 2, lineHeight: 18 },
});
