import React, { useState } from "react";
import { View, Text, ScrollView, TextInput, Button } from "react-native";
import { usePushPalsSession } from "./usePushPalsSession.js";
import { EventEnvelope } from "protocol";

/**
 * Example component demonstrating PushPals API usage
 */
export function PushPalsDemo() {
  const session = usePushPalsSession("http://localhost:3001");
  const [messageText, setMessageText] = useState("");

  const handleSendMessage = async () => {
    if (!messageText.trim()) return;
    await session.send(messageText);
    setMessageText("");
  };

  const isError = (
    event: EventEnvelope | { type: "_error"; message: string }
  ): event is { type: "_error"; message: string } => {
    return (event as any).type === "_error";
  };

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 18, fontWeight: "bold", marginBottom: 8 }}>
        PushPals Session: {session.sessionId?.substring(0, 8)}...
      </Text>

      {session.error && (
        <View style={{ backgroundColor: "#ffcccc", padding: 8, marginBottom: 8 }}>
          <Text style={{ color: "#cc0000" }}>Error: {session.error}</Text>
        </View>
      )}

      <Text style={{ fontSize: 16, fontWeight: "bold", marginBottom: 8 }}>
        Events ({session.events.length})
      </Text>

      <ScrollView
        style={{ flex: 1, marginBottom: 16, backgroundColor: "#f5f5f5", padding: 8 }}
      >
        {session.events.map((event, idx) => (
          <View key={idx} style={{ marginBottom: 8, paddingBottom: 8, borderBottomWidth: 1 }}>
            {isError(event) ? (
                <Text style={{ color: "red", fontSize: 12 }}>
                  Warning: {event.message}
                </Text>
            ) : (
              <>
                <Text style={{ fontWeight: "bold", color: "#333" }}>
                  {event.type}
                </Text>
                <Text style={{ fontSize: 12, color: "#666" }}>
                  {new Date(event.ts).toLocaleTimeString()}
                </Text>
                <Text style={{ fontSize: 11, color: "#999", marginTop: 4 }}>
                  {JSON.stringify(event.payload, null, 2).substring(0, 100)}...
                </Text>
              </>
            )}
          </View>
        ))}
      </ScrollView>

      <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
        <TextInput
          style={{
            flex: 1,
            borderWidth: 1,
            borderColor: "#ccc",
            padding: 8,
            borderRadius: 4,
          }}
          placeholder="Enter message..."
          value={messageText}
          onChangeText={setMessageText}
        />
        <Button title="Send" onPress={handleSendMessage} disabled={!session.isConnected} />
      </View>

      <Text style={{ fontSize: 12, color: "#666" }}>
        Status: {session.isConnected ? "Connected" : "Disconnected"}
      </Text>
    </View>
  );
}
