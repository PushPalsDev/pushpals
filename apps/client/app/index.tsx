import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from "react-native";
import { usePushPalsSession } from "../src/lib/usePushPalsSession";
import type { EventEnvelope } from "protocol/browser";

const uuidv4 = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  eventType?: string;
};

const DEFAULT_BASE = process.env.EXPO_PUBLIC_PUSHPALS_URL ?? "http://localhost:3001";

export default function ChatScreen() {
  const session = usePushPalsSession(DEFAULT_BASE);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const [input, setInput] = useState("");
  const flatRef = useRef<FlatList<ChatMessage> | null>(null);

  // Append incoming events as assistant/system messages
  useEffect(() => {
    for (const ev of session.events) {
      // event may be an _error shaped object
      const id = (ev as any).id ?? `evt-${(ev as any).type}-${Math.random()}`;
      if (seen.current.has(id)) continue;
      seen.current.add(id);

      const envelope = ev as EventEnvelope;
      const role: ChatRole = envelope.type === "error" ? "system" : "assistant";
      const text = envelope.payload ? JSON.stringify(envelope.payload) : envelope.type;
      const createdAt = Date.parse((envelope as any).ts) || Date.now();

      setMessages((m) => [
        ...m,
        {
          id: id.toString(),
          role,
          text,
          createdAt,
          eventType: envelope.type,
        },
      ]);
    }
  }, [session.events]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;

    const msg: ChatMessage = {
      id: uuidv4(),
      role: "user",
      text,
      createdAt: Date.now(),
    };

    setMessages((m) => [...m, msg]);
    setInput("");

    try {
      await session.send(text);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          id: uuidv4(),
          role: "system",
          text: `Send failed: ${String(err)}`,
          createdAt: Date.now(),
        },
      ]);
    }
  };

  useEffect(() => {
    // Auto-scroll to bottom when messages change
    flatRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  const renderItem = ({ item }: { item: ChatMessage }) => (
    <View
      style={[
        styles.bubbleContainer,
        item.role === "user" ? styles.bubbleRight : styles.bubbleLeft,
      ]}
    >
      <View
        style={[styles.bubble, item.role === "user" ? styles.userBubble : styles.assistantBubble]}
      >
        <Text style={styles.bubbleText}>{item.text}</Text>
      </View>
      <Text style={styles.ts}>{new Date(item.createdAt).toLocaleTimeString()}</Text>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>PushPals</Text>
        <Text style={styles.connection}>
          {session.isConnected ? "● Connected" : "○ Disconnected"}
        </Text>
      </View>

      <FlatList
        ref={(r) => {
          flatRef.current = r;
        }}
        data={messages}
        renderItem={renderItem}
        keyExtractor={(it) => it.id}
        contentContainerStyle={styles.listContent}
      />

      <View style={styles.composerRow}>
        <TextInput
          style={styles.input}
          placeholder="Type a message..."
          value={input}
          onChangeText={setInput}
          multiline
        />
        <TouchableOpacity
          style={[styles.sendButton, !input.trim() && styles.sendDisabled]}
          onPress={handleSend}
          disabled={!input.trim()}
        >
          <Text style={styles.sendText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f7f7f8" },
  header: {
    height: 56,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  headerTitle: { fontSize: 18, fontWeight: "600" },
  connection: { fontSize: 12, color: "#666" },
  listContent: { padding: 12, paddingBottom: 8 },
  bubbleContainer: { marginVertical: 6, maxWidth: "80%" },
  bubbleLeft: { alignSelf: "flex-start" },
  bubbleRight: { alignSelf: "flex-end" },
  bubble: { padding: 10, borderRadius: 12 },
  userBubble: { backgroundColor: "#0b84ff" },
  assistantBubble: { backgroundColor: "#e5e7eb" },
  bubbleText: { color: "#111" },
  ts: { fontSize: 10, color: "#999", marginTop: 4 },
  composerRow: {
    flexDirection: "row",
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: "#eee",
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    padding: 8,
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ececec",
  },
  sendButton: {
    marginLeft: 8,
    backgroundColor: "#0b84ff",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: "#fff", fontWeight: "600" },
});
