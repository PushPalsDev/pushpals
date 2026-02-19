import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { DashboardTheme, FlowStep, Tone } from "./dashboardTypes";

function toneColor(theme: DashboardTheme, tone: Tone): string {
  if (tone === "positive") return theme.positive;
  if (tone === "warning") return theme.warning;
  if (tone === "danger") return theme.danger;
  return theme.accent;
}

export function FlowRibbon({ theme, steps }: { theme: DashboardTheme; steps: FlowStep[] }) {
  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: theme.panelAlt,
          borderColor: theme.border,
        },
      ]}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {steps.map((step, index) => {
          const color = toneColor(theme, step.tone);
          const showConnector = index < steps.length - 1;
          return (
            <View key={step.key} style={styles.stepOuter}>
              <View
                style={[
                  styles.step,
                  {
                    borderColor: `${color}66`,
                    backgroundColor: `${color}16`,
                  },
                ]}
              >
                <Text
                  style={[styles.label, { color, fontFamily: theme.fontSans }]}
                  numberOfLines={1}
                >
                  {step.label}
                </Text>
                <Text
                  style={[styles.detail, { color: theme.textMuted, fontFamily: theme.fontSans }]}
                  numberOfLines={2}
                >
                  {step.detail}
                </Text>
              </View>
              {showConnector ? (
                <View style={[styles.connector, { backgroundColor: `${theme.border}CC` }]} />
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 20,
    marginBottom: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  stepOuter: {
    flexDirection: "row",
    alignItems: "center",
  },
  step: {
    width: 172,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  label: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  detail: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 16,
  },
  connector: {
    width: 18,
    height: 1,
    marginHorizontal: 8,
  },
});
