import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { DashboardTheme, Tone } from "./dashboardTypes";

export function MetricTile({
  title,
  value,
  detail,
  theme,
  tone = "accent",
}: {
  title: string;
  value: string;
  detail?: string;
  theme: DashboardTheme;
  tone?: Tone;
}) {
  const color =
    tone === "positive"
      ? theme.positive
      : tone === "warning"
        ? theme.warning
        : tone === "danger"
          ? theme.danger
          : theme.accent;
  return (
    <View
      style={[styles.metricTile, { borderColor: theme.border, backgroundColor: theme.panelAlt }]}
    >
      <Text style={[styles.metricTitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
        {title}
      </Text>
      <Text style={[styles.metricValue, { color, fontFamily: theme.fontSans }]}>{value}</Text>
      {detail ? (
        <Text style={[styles.metricDetail, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  metricTile: {
    minWidth: 150,
    flexGrow: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginRight: 8,
    marginBottom: 8,
  },
  metricTitle: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7 },
  metricValue: { fontSize: 22, fontWeight: "700", marginTop: 3 },
  metricDetail: { fontSize: 12, marginTop: 3 },
});
