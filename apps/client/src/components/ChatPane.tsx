import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { ChatComposer } from "./ChatComposer";
import type { DashboardTheme } from "./dashboardTypes";
import { resolveChatSpeaker } from "./chatSpeaker";

interface ChatPaneMessage {
  id: string;
  from?: string;
  text: string;
  ts: string;
}

function prettyTs(iso?: string): string {
  if (!iso) return "--";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "--";
  return new Date(ts).toLocaleTimeString();
}

function CollapsibleMessage({ text, theme }: { text: string; theme: DashboardTheme }) {
  const [expanded, setExpanded] = useState(false);
  const threshold = 360;
  const needsCollapse = text.length > threshold;
  const display = needsCollapse && !expanded ? `${text.slice(0, threshold)}...` : text;
  return (
    <View>
      <Text style={[styles.chatText, { color: theme.text, fontFamily: theme.fontSans }]}>
        {display}
      </Text>
      {needsCollapse ? (
        <Pressable
          onPress={() => setExpanded((prev) => !prev)}
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Collapse message text" : "Expand message text"}
        >
          <Text style={[styles.showMore, { color: theme.accent, fontFamily: theme.fontSans }]}>
            {expanded ? "Show less" : "Show more"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function TypingDots({ theme }: { theme: DashboardTheme }) {
  const [activeCount, setActiveCount] = useState(1);

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveCount((prev) => ((prev % 3) + 1) as 1 | 2 | 3);
    }, 360);
    return () => clearInterval(timer);
  }, []);

  return (
    <View style={styles.typingDotsRow}>
      {[1, 2, 3].map((dot) => (
        <View
          key={dot}
          style={[
            styles.typingDot,
            {
              backgroundColor: dot <= activeCount ? theme.accent : `${theme.textMuted}55`,
            },
          ]}
        />
      ))}
    </View>
  );
}

export function ChatPane({
  theme,
  messages,
  input,
  setInput,
  onSend,
  connected,
  pendingResponse,
}: {
  theme: DashboardTheme;
  messages: ChatPaneMessage[];
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  onSend: () => void;
  connected: boolean;
  pendingResponse: boolean;
}) {
  const scrollRef = useRef<ScrollView | null>(null);
  const handleComposerKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const nativeEvent = event.nativeEvent as TextInputKeyPressEventData & {
        altKey?: boolean;
        metaKey?: boolean;
      };
      const key = (nativeEvent.key ?? "").toLowerCase();
      const hasShortcutModifier = Boolean(nativeEvent.altKey || nativeEvent.metaKey);
      if (key === "enter" && hasShortcutModifier) {
        event.preventDefault?.();
        event.stopPropagation?.();
        onSend();
      }
    },
    [onSend],
  );

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length, pendingResponse]);

  return (
    <View style={styles.tabFill}>
      <ScrollView
        ref={scrollRef}
        style={styles.tabFill}
        contentContainerStyle={styles.chatContent}
        showsVerticalScrollIndicator={false}
      >
        {messages.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
              No conversation yet
            </Text>
            <Text
              style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}
            >
              Start with a task. PushPals will route it through the local server and RemoteBuddy will coordinate execution.
            </Text>
          </View>
        ) : (
          messages.map((message, index) => {
            const isUser = (message.from ?? "").toLowerCase().includes("client");
            const speaker = resolveChatSpeaker(message.from, theme);
            return (
              <View
                key={message.id}
                style={[
                  styles.chatBubble,
                  isUser ? styles.chatBubbleUser : styles.chatBubbleAgent,
                  {
                    backgroundColor: isUser ? theme.bubbleUser : speaker.bubbleBg,
                    borderColor: isUser ? theme.bubbleUser : speaker.bubbleBorder,
                  },
                ]}
              >
                {!isUser ? (
                  <Text
                    style={[
                      styles.chatFrom,
                      { color: speaker.labelColor, fontFamily: theme.fontSans },
                    ]}
                  >
                    {speaker.label}
                  </Text>
                ) : null}
                <CollapsibleMessage text={message.text} theme={theme} />
                <Text
                  style={[
                    styles.chatTs,
                    {
                      color: isUser ? "rgba(255,255,255,0.8)" : theme.textMuted,
                      fontFamily: theme.fontSans,
                    },
                  ]}
                >
                  {prettyTs(message.ts)}
                </Text>
              </View>
            );
          })
        )}
        {pendingResponse ? (
          <View
            style={[
              styles.chatBubble,
              styles.chatBubbleAgent,
              {
                backgroundColor: theme.bubbleAgent,
                borderColor: theme.bubbleAgentBorder,
              },
            ]}
          >
            <Text style={[styles.chatFrom, { color: theme.accent, fontFamily: theme.fontSans }]}>
              PushPals
            </Text>
            <View style={styles.typingLine}>
              <Text
                style={[styles.typingLabel, { color: theme.textMuted, fontFamily: theme.fontSans }]}
              >
                Thinking
              </Text>
              <TypingDots theme={theme} />
            </View>
          </View>
        ) : null}
      </ScrollView>

      <ChatComposer
        theme={theme}
        input={input}
        setInput={setInput}
        connected={connected}
        onSend={onSend}
        onComposerKeyPress={handleComposerKeyPress}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tabFill: { flex: 1 },
  emptyState: {
    borderRadius: 16,
    padding: 16,
    alignItems: "flex-start",
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  emptySubtitle: { fontSize: 13, lineHeight: 19 },
  chatContent: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  chatBubble: {
    maxWidth: "78%",
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 9,
  },
  chatBubbleUser: {
    alignSelf: "flex-end",
    borderBottomRightRadius: 5,
  },
  chatBubbleAgent: {
    alignSelf: "flex-start",
    borderBottomLeftRadius: 5,
  },
  chatFrom: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.25,
    marginBottom: 4,
  },
  chatText: {
    fontSize: 14,
    lineHeight: 21,
  },
  chatTs: {
    fontSize: 11,
    marginTop: 6,
    alignSelf: "flex-end",
  },
  showMore: {
    fontSize: 12,
    fontWeight: "700",
    marginTop: 6,
  },
  typingLine: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 2,
  },
  typingLabel: {
    fontSize: 14,
    lineHeight: 20,
    marginRight: 8,
  },
  typingDotsRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    marginRight: 5,
  },
});
