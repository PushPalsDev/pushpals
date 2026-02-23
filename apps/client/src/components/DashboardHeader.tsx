import React from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import type { SystemRepoSummary } from "../lib/pushpalsApi";
import type { DashboardTheme } from "./dashboardTypes";
import { ModeSwitcher, type ThemeModeOption } from "./ModeSwitcher";

export function DashboardHeader({
  theme,
  mode,
  repo,
  onChangeMode,
}: {
  theme: DashboardTheme;
  mode: ThemeModeOption;
  repo?: SystemRepoSummary;
  onChangeMode: (mode: ThemeModeOption) => void;
}) {
  const repoText = repo?.remoteUrl?.trim() || "unavailable";
  const repoLink = repo?.provider === "github" ? repo.browserUrl : null;
  const openRepoLink = React.useCallback(async () => {
    if (!repoLink) return;
    try {
      const supported = await Linking.canOpenURL(repoLink);
      if (!supported) return;
      await Linking.openURL(repoLink);
    } catch (err) {
      console.error(`[DashboardHeader] Failed to open repo URL: ${repoLink}`, err);
    }
  }, [repoLink]);

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
        <Text style={[styles.repoLine, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
          Current repo:{" "}
          <Text
            style={[
              styles.repoValue,
              { color: repoLink ? theme.accent : theme.textMuted, fontFamily: theme.fontMono },
              repoLink ? styles.repoLink : null,
            ]}
            onPress={repoLink ? () => void openRepoLink() : undefined}
          >
            {repoText}
          </Text>
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
  repoLine: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 17,
  },
  repoValue: {
    fontSize: 12,
  },
  repoLink: {
    textDecorationLine: "underline",
  },
});
