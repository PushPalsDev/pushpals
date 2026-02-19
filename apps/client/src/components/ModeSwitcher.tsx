import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DashboardTheme } from "./dashboardTypes";

export type ThemeModeOption = "auto" | "light" | "dark";

export function ModeSwitcher({
  mode,
  onChange,
  theme,
}: {
  mode: ThemeModeOption;
  onChange: (mode: ThemeModeOption) => void;
  theme: DashboardTheme;
}) {
  const modes: ThemeModeOption[] = ["auto", "light", "dark"];
  return (
    <View style={[styles.modeWrap, { borderColor: theme.border, backgroundColor: theme.panelAlt }]}>
      {modes.map((item) => {
        const selected = mode === item;
        return (
          <Pressable
            key={item}
            style={[styles.modeBtn, selected && { backgroundColor: theme.accentSoft }]}
            onPress={() => onChange(item)}
            accessibilityRole="button"
            accessibilityLabel={`Set theme mode to ${item}`}
            accessibilityState={{ selected }}
          >
            <Text
              style={[
                styles.modeText,
                {
                  color: selected ? theme.accentText : theme.textMuted,
                  fontFamily: theme.fontSans,
                },
              ]}
            >
              {item}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  modeWrap: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
    alignSelf: "flex-start",
  },
  modeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  modeText: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "capitalize",
  },
});
