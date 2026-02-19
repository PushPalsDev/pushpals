import React from "react";
import { StyleSheet, View } from "react-native";
import type { DashboardTheme } from "./dashboardTypes";
import { MetricTile } from "./MetricTile";

export function DashboardMetrics({
  theme,
  connected,
  totalEvents,
  pendingRequests,
  pendingJobs,
  onlineWorkers,
  busyWorkers,
  lastRefresh,
  formatRelativeTime,
  formatAbsoluteTime,
}: {
  theme: DashboardTheme;
  connected: boolean;
  totalEvents: number;
  pendingRequests: number;
  pendingJobs: number;
  onlineWorkers: number;
  busyWorkers: number;
  lastRefresh: string | null;
  formatRelativeTime: (iso?: string) => string;
  formatAbsoluteTime: (iso?: string) => string;
}) {
  const pendingWork = pendingRequests + pendingJobs;
  return (
    <View style={styles.metricRow}>
      <MetricTile
        title="Connection"
        value={connected ? "Live" : "Disconnected"}
        detail={`${totalEvents} events`}
        tone={connected ? "positive" : "danger"}
        theme={theme}
      />
      <MetricTile
        title="Pending Work"
        value={String(pendingWork)}
        detail={`${pendingRequests} requests | ${pendingJobs} jobs`}
        tone={pendingWork > 0 ? "warning" : "positive"}
        theme={theme}
      />
      <MetricTile
        title="Active Workers"
        value={String(onlineWorkers)}
        detail={`${busyWorkers} busy`}
        theme={theme}
      />
      <MetricTile
        title="Last Sync"
        value={lastRefresh ? formatRelativeTime(lastRefresh) : "--"}
        detail={lastRefresh ? formatAbsoluteTime(lastRefresh) : "waiting"}
        theme={theme}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  metricRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
});
