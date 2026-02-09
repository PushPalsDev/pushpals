import React, { useState } from "react";
import { View, Text, ScrollView, TextInput, Button, TouchableOpacity } from "react-native";
import { usePushPalsSession, isEnvelope, type SessionEvent } from "./usePushPalsSession.js";
import type { EventEnvelope } from "protocol/browser";

/**
 * Example component demonstrating PushPals API usage with
 * multi-agent events, task grouping, approval actions, and filters.
 */
export function PushPalsDemo() {
  const session = usePushPalsSession("http://localhost:3001");
  const [messageText, setMessageText] = useState("");

  const handleSendMessage = async () => {
    if (!messageText.trim()) return;
    await session.send(messageText);
    setMessageText("");
  };

  const renderEvent = (event: SessionEvent, idx: number) => {
    if (!isEnvelope(event)) {
      return (
        <View
          key={`err-${idx}`}
          style={{ marginBottom: 8, paddingBottom: 8, borderBottomWidth: 1 }}
        >
          <Text style={{ color: "red", fontSize: 12 }}>Warning: {(event as any).message}</Text>
        </View>
      );
    }

    const p = event.payload as any;

    return (
      <View key={event.id} style={{ marginBottom: 8, paddingBottom: 8, borderBottomWidth: 1 }}>
        {/* Type + agent attribution */}
        <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Text style={{ fontWeight: "bold", color: "#333" }}>{event.type}</Text>
          {event.from && (
            <Text
              style={{
                fontSize: 10,
                color: "#0369a1",
                backgroundColor: "#e0f2fe",
                paddingHorizontal: 4,
                borderRadius: 3,
              }}
            >
              {event.from}
            </Text>
          )}
          {event.to && event.to !== "broadcast" && (
            <Text
              style={{
                fontSize: 10,
                color: "#be185d",
                backgroundColor: "#fce7f3",
                paddingHorizontal: 4,
                borderRadius: 3,
              }}
            >
              {"->"} {event.to}
            </Text>
          )}
        </View>

        <Text style={{ fontSize: 12, color: "#666" }}>
          {new Date(event.ts).toLocaleTimeString()}
          {event.turnId ? ` | turn: ${event.turnId.substring(0, 8)}` : ""}
        </Text>

        {/* Payload rendering by type */}
        {event.type === "assistant_message" && (
          <Text style={{ fontSize: 13, marginTop: 4 }}>{p.text}</Text>
        )}

        {event.type === "task_created" && (
          <View style={{ marginTop: 4 }}>
            <Text style={{ fontWeight: "600" }}>{p.title}</Text>
            <Text style={{ fontSize: 12, color: "#555" }}>{p.description}</Text>
          </View>
        )}

        {(event.type === "task_completed" || event.type === "task_failed") && (
          <Text
            style={{
              marginTop: 4,
              fontSize: 12,
              color: event.type === "task_completed" ? "#16a34a" : "#dc2626",
            }}
          >
            {p.summary ?? p.message}
          </Text>
        )}

        {event.type === "tool_call" && (
          <View style={{ marginTop: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: "#92400e" }}>
              [tool] {p.tool}
            </Text>
            {p.requiresApproval && (
              <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                <TouchableOpacity
                  style={{
                    backgroundColor: "#dcfce7",
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 4,
                  }}
                  onPress={() => session.approve(p.toolCallId)}
                >
                  <Text style={{ color: "#16a34a", fontWeight: "600", fontSize: 12 }}>Approve</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{
                    backgroundColor: "#fee2e2",
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 4,
                  }}
                  onPress={() => session.deny(p.toolCallId)}
                >
                  <Text style={{ color: "#dc2626", fontWeight: "600", fontSize: 12 }}>Deny</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {event.type === "tool_result" && (
          <Text style={{ fontSize: 11, color: p.ok ? "#16a34a" : "#dc2626", marginTop: 4 }}>
            {p.ok ? "OK" : "FAILED"}
            {p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ""}
          </Text>
        )}

        {event.type === "approval_required" && (
          <View style={{ marginTop: 4 }}>
            <Text style={{ fontSize: 12 }}>{p.summary}</Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
              <TouchableOpacity
                style={{
                  backgroundColor: "#dcfce7",
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 4,
                }}
                onPress={() => session.approve(p.approvalId)}
              >
                <Text style={{ color: "#16a34a", fontWeight: "600", fontSize: 12 }}>Approve</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{
                  backgroundColor: "#fee2e2",
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 4,
                }}
                onPress={() => session.deny(p.approvalId)}
              >
                <Text style={{ color: "#dc2626", fontWeight: "600", fontSize: 12 }}>Deny</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {event.type === "diff_ready" && (
          <View style={{ marginTop: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: "500" }}>{p.diffStat}</Text>
            <Text style={{ fontSize: 11, color: "#555", marginTop: 2 }}>
              {p.unifiedDiff.substring(0, 200)}…
            </Text>
          </View>
        )}

        {/* Fallback for unhandled types */}
        {![
          "assistant_message",
          "task_created",
          "task_completed",
          "task_failed",
          "tool_call",
          "tool_result",
          "approval_required",
          "diff_ready",
        ].includes(event.type) && (
          <Text style={{ fontSize: 11, color: "#999", marginTop: 4 }}>
            {JSON.stringify(p, null, 2).substring(0, 120)}…
          </Text>
        )}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 18, fontWeight: "bold", marginBottom: 8 }}>
        PushPals Session: {session.sessionId?.substring(0, 8)}…
      </Text>

      {session.error && (
        <View style={{ backgroundColor: "#ffcccc", padding: 8, marginBottom: 8 }}>
          <Text style={{ color: "#cc0000" }}>Error: {session.error}</Text>
        </View>
      )}

      {/* Task summary */}
      {session.tasks.length > 0 && (
        <View style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", marginBottom: 4 }}>
            Tasks ({session.tasks.length})
          </Text>
          {session.tasks.map((t) => (
            <Text key={t.taskId} style={{ fontSize: 12, color: "#555" }}>
              {t.status === "completed" ? "[ok]" : t.status === "failed" ? "[err]" : "[...]"}{" "}
              {t.title}
            </Text>
          ))}
        </View>
      )}

      <Text style={{ fontSize: 16, fontWeight: "bold", marginBottom: 8 }}>
        Events ({session.filteredEvents.length}
        {session.filteredEvents.length !== session.events.length
          ? ` / ${session.events.length}`
          : ""}
        )
      </Text>

      <ScrollView style={{ flex: 1, marginBottom: 16, backgroundColor: "#f5f5f5", padding: 8 }}>
        {session.filteredEvents.map((event, idx) => renderEvent(event, idx))}
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
        {session.agents.length > 0 ? ` | Agents: ${session.agents.join(", ")}` : ""}
      </Text>
    </View>
  );
}
