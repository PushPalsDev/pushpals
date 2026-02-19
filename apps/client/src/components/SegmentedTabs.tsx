import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DashboardTheme } from "./dashboardTypes";

interface SegmentedTabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
}

export function SegmentedTabs<T extends string>({
  tabs,
  active,
  onSelect,
  theme,
}: {
  tabs: SegmentedTabItem<T>[];
  active: T;
  onSelect: (tab: T) => void;
  theme: DashboardTheme;
}) {
  return (
    <View
      style={[styles.segmentWrap, { backgroundColor: theme.panelAlt, borderColor: theme.border }]}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <Pressable
            key={tab.id}
            onPress={() => onSelect(tab.id)}
            style={[
              styles.segmentBtn,
              selected && { backgroundColor: theme.accent, borderColor: theme.accent },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`${tab.label} tab`}
            accessibilityHint="Switches dashboard section."
            accessibilityState={{ selected }}
          >
            <Text
              style={[
                styles.segmentText,
                {
                  color: selected ? "#FFFFFF" : theme.textMuted,
                  fontFamily: theme.fontSans,
                },
              ]}
              numberOfLines={1}
            >
              {tab.label}
              {typeof tab.count === "number" ? ` (${tab.count})` : ""}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  segmentWrap: {
    marginHorizontal: 20,
    marginBottom: 10,
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: "row",
    padding: 3,
  },
  segmentBtn: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "transparent",
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentText: {
    fontSize: 12,
    fontWeight: "700",
  },
});
