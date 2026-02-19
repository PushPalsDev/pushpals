import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { DashboardTheme } from "./dashboardTypes";
import { ModeSwitcher, type ThemeModeOption } from "./ModeSwitcher";

export function DashboardHeader({
  theme,
  mode,
  onChangeMode,
}: {
  theme: DashboardTheme;
  mode: ThemeModeOption;
  onChangeMode: (mode: ThemeModeOption) => void;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerLeft}>
        <Text style={[styles.eyebrow, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
          pushpals operations console
        </Text>
        <Text style={[styles.title, { color: theme.text, fontFamily: theme.fontSans }]}>
          Mission Control
        </Text>
        <Text style={[styles.subtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
          Coordinate your edits with autonomous buddy execution across planning, jobs, and
          integration in one live board.
        </Text>
      </View>
      <ModeSwitcher mode={mode} onChange={onChangeMode} theme={theme} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
  },
  headerLeft: { flex: 1, paddingRight: 12 },
  eyebrow: {
    fontSize: 11,
    letterSpacing: 1.3,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  title: {
    fontSize: 30,
    fontWeight: "700",
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 19,
    maxWidth: 640,
  },
});
