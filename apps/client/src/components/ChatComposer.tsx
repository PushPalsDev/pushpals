import React, { useCallback } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import type { DashboardTheme } from "./dashboardTypes";

const QUICK_PROMPT_TEMPLATES = [
  {
    label: "Plan & Scope",
    text: "Plan this change with explicit file targets, acceptance criteria, and validation steps before execution:",
  },
  {
    label: "Remote Execute",
    text: "/ask_remote_buddy Implement this task and include a concise progress summary every major step:",
  },
  {
    label: "Status Digest",
    text: "Summarize active requests, running jobs, and what I should review next.",
  },
  {
    label: "Autonomy Sync",
    text: "Compare my current request queue with autonomous objectives and flag overlap or conflicts.",
  },
] as const;

export function ChatComposer({
  theme,
  input,
  setInput,
  connected,
  onSendLocal,
  onSendRemote,
  onComposerKeyPress,
}: {
  theme: DashboardTheme;
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  connected: boolean;
  onSendLocal: () => void;
  onSendRemote: (text: string) => void;
  onComposerKeyPress: (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => void;
}) {
  const applyTemplate = useCallback(
    (value: string) => {
      setInput((current) => {
        const existing = String(current ?? "").trim();
        if (!existing) return value;
        if (existing.toLowerCase().includes(value.toLowerCase())) return current;
        return `${existing}\n\n${value}`;
      });
    },
    [setInput],
  );

  return (
    <>
      <View style={styles.quickPromptContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {QUICK_PROMPT_TEMPLATES.map((template) => (
            <Pressable
              key={template.label}
              style={[
                styles.quickPromptChip,
                {
                  borderColor: theme.border,
                  backgroundColor: theme.panelAlt,
                },
              ]}
              onPress={() => applyTemplate(template.text)}
              accessibilityRole="button"
              accessibilityLabel={`Apply ${template.label} prompt template`}
              accessibilityHint="Adds this template text into the composer."
            >
              <Text
                style={[
                  styles.quickPromptLabel,
                  { color: theme.textMuted, fontFamily: theme.fontSans },
                ]}
              >
                {template.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      <View style={[styles.composer, { borderColor: theme.border, backgroundColor: theme.panel }]}>
        <TextInput
          style={[
            styles.composerInput,
            {
              color: theme.text,
              borderColor: theme.border,
              backgroundColor: theme.inputBg,
              fontFamily: theme.fontSans,
            },
          ]}
          value={input}
          onChangeText={setInput}
          placeholder="Ask PushPals anything..."
          placeholderTextColor={theme.textMuted}
          multiline
          onKeyPress={onComposerKeyPress}
          accessibilityLabel="Chat composer input"
        />
        <View style={styles.sendWrap}>
          <Pressable
            onPress={onSendLocal}
            disabled={!connected || !input.trim()}
            style={[
              styles.sendButton,
              {
                backgroundColor: theme.accent,
                opacity: !connected || !input.trim() ? 0.45 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send message to LocalBuddy"
            accessibilityHint="Submits the current prompt through local routing first."
          >
            <Text style={[styles.sendLabel, { fontFamily: theme.fontSans }]}>Send Local</Text>
          </Pressable>
          <Pressable
            onPress={() => onSendRemote(input)}
            disabled={!connected || !input.trim()}
            style={[
              styles.sendButtonSecondary,
              {
                borderColor: theme.accent,
                backgroundColor: `${theme.accent}18`,
                opacity: !connected || !input.trim() ? 0.45 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send message directly to RemoteBuddy"
            accessibilityHint="Submits this prompt as an immediate remote request."
          >
            <Text
              style={[
                styles.sendSecondaryLabel,
                { color: theme.accent, fontFamily: theme.fontSans },
              ]}
            >
              Send Remote
            </Text>
          </Pressable>
          <Text
            style={[styles.shortcutHint, { color: theme.textMuted, fontFamily: theme.fontSans }]}
          >
            Alt+Enter / Cmd+Enter
          </Text>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  quickPromptContainer: {
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  quickPromptChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
  },
  quickPromptLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 130,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 11,
    paddingVertical: 8,
    fontSize: 14,
  },
  sendWrap: {
    marginLeft: 8,
    alignItems: "center",
  },
  sendButton: {
    height: 44,
    borderRadius: 12,
    paddingHorizontal: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  sendLabel: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 13,
  },
  sendButtonSecondary: {
    marginTop: 6,
    minHeight: 36,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  sendSecondaryLabel: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.25,
  },
  shortcutHint: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: "600",
  },
});
