import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ScrollView,
} from "react-native";
import {
  usePushPalsSession,
  isEnvelope,
  type SessionEvent,
  type EventFilters,
} from "../src/lib/usePushPalsSession";
import { TasksJobsLogs } from "../src/lib/TasksJobsLogs";
import type { EventEnvelope, EventType } from "protocol/browser";

const uuidv4 = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const DEFAULT_BASE = process.env.EXPO_PUBLIC_PUSHPALS_URL ?? "http://localhost:3001";

// ─── Color coding by event category ─────────────────────────────────────────
const EVENT_COLORS: Record<string, string> = {
  // task lifecycle
  task_created: "#3b82f6",
  task_started: "#6366f1",
  task_progress: "#8b5cf6",
  task_completed: "#22c55e",
  task_failed: "#ef4444",
  // tools
  tool_call: "#f59e0b",
  tool_result: "#d97706",
  // approvals
  approval_required: "#f97316",
  approved: "#22c55e",
  denied: "#ef4444",
  // agent
  agent_status: "#06b6d4",
  assistant_message: "#64748b",
  // jobs
  job_enqueued: "#a855f7",
  job_claimed: "#7c3aed",
  job_completed: "#22c55e",
  job_failed: "#ef4444",
  // other
  error: "#dc2626",
  log: "#94a3b8",
  diff_ready: "#14b8a6",
};

function getEventColor(type: string): string {
  return EVENT_COLORS[type] ?? "#94a3b8";
}

// ─── Agent badge ─────────────────────────────────────────────────────────────
function AgentBadge({ from, to }: { from?: string; to?: string }) {
  if (!from && !to) return null;
  return (
    <View style={styles.agentBadgeRow}>
      {from && (
        <View style={[styles.badge, { backgroundColor: "#e0f2fe" }]}>
          <Text style={[styles.badgeText, { color: "#0369a1" }]}>{from}</Text>
        </View>
      )}
      {to && to !== "broadcast" && (
        <>
          <Text style={styles.arrowText}>{"->"}</Text>
          <View style={[styles.badge, { backgroundColor: "#fce7f3" }]}>
            <Text style={[styles.badgeText, { color: "#be185d" }]}>{to}</Text>
          </View>
        </>
      )}
    </View>
  );
}

// ─── Progress bar ────────────────────────────────────────────────────────────
function ProgressBar({ percent }: { percent: number }) {
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${Math.min(100, percent)}%` }]} />
      <Text style={styles.progressLabel}>{percent}%</Text>
    </View>
  );
}

// ─── Approval buttons ───────────────────────────────────────────────────────
function ApprovalActions({
  approvalId,
  onApprove,
  onDeny,
}: {
  approvalId: string;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const [decided, setDecided] = useState<"approve" | "deny" | null>(null);

  if (decided) {
    return (
      <View
        style={[styles.decisionBadge, decided === "approve" ? styles.approvedBg : styles.deniedBg]}
      >
        <Text style={styles.decisionText}>{decided === "approve" ? "Approved" : "Denied"}</Text>
      </View>
    );
  }

  return (
    <View style={styles.approvalRow}>
      <TouchableOpacity
        style={[styles.approvalBtn, styles.approveBtn]}
        onPress={() => {
          setDecided("approve");
          onApprove(approvalId);
        }}
      >
        <Text style={styles.approveBtnText}>Approve</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.approvalBtn, styles.denyBtn]}
        onPress={() => {
          setDecided("deny");
          onDeny(approvalId);
        }}
      >
        <Text style={styles.denyBtnText}>Deny</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Diff preview ────────────────────────────────────────────────────────────
function DiffPreview({ diff, stat }: { diff: string; stat: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = diff.substring(0, 300);

  return (
    <View style={styles.diffContainer}>
      <Text style={styles.diffStat}>{stat}</Text>
      <TouchableOpacity onPress={() => setExpanded(!expanded)}>
        <Text style={styles.diffToggle}>{expanded ? "- Collapse" : "+ Show diff"}</Text>
      </TouchableOpacity>
      {expanded && (
        <ScrollView horizontal style={styles.diffScroll}>
          <Text style={styles.diffCode}>{diff}</Text>
        </ScrollView>
      )}
    </View>
  );
}

// ─── Task status indicator ───────────────────────────────────────────────────
const TASK_STATUS_LABEL: Record<string, string> = {
  created: "[new]",
  started: "[run]",
  in_progress: "[...]",
  completed: "[ok]",
  failed: "[err]",
};

// ─── Single event card renderer ──────────────────────────────────────────────
function EventCard({
  event,
  onApprove,
  onDeny,
}: {
  event: EventEnvelope;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const p = event.payload as any;
  const color = getEventColor(event.type);

  const renderPayload = () => {
    switch (event.type) {
      case "assistant_message":
        return <Text style={styles.messageText}>{p.text}</Text>;

      case "agent_status":
        return (
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor:
                    p.status === "idle" ? "#22c55e" : p.status === "busy" ? "#f59e0b" : "#ef4444",
                },
              ]}
            />
            <Text style={styles.statusText}>
              {p.agentId}: {p.status}
              {p.message ? ` — ${p.message}` : ""}
            </Text>
          </View>
        );

      case "task_created":
        return (
          <View>
            <Text style={styles.taskTitle}>{p.title}</Text>
            <Text style={styles.taskDesc}>{p.description}</Text>
            {p.priority && <Text style={styles.metaText}>Priority: {p.priority}</Text>}
            {p.tags?.length > 0 && <Text style={styles.metaText}>Tags: {p.tags.join(", ")}</Text>}
          </View>
        );

      case "task_started":
        return <Text style={styles.infoText}>Task started: {p.taskId?.substring(0, 8)}</Text>;

      case "task_progress":
        return (
          <View>
            <Text style={styles.infoText}>{p.message}</Text>
            {p.percent !== undefined && <ProgressBar percent={p.percent} />}
          </View>
        );

      case "task_completed":
        return (
          <View>
            <Text style={styles.successText}>{p.summary}</Text>
            {p.artifacts?.map((a: any, i: number) => (
              <Text key={i} style={styles.artifactText}>
                [{a.kind}]{a.uri ? `: ${a.uri}` : ""}
                {a.text ? ` -- ${a.text.substring(0, 80)}...` : ""}
              </Text>
            ))}
          </View>
        );

      case "task_failed":
        return (
          <View>
            <Text style={styles.errorText}>{p.message}</Text>
            {p.detail && <Text style={styles.detailText}>{p.detail}</Text>}
          </View>
        );

      case "tool_call":
        return (
          <View>
            <Text style={styles.toolName}>[tool] {p.tool}</Text>
            <Text style={styles.toolArgs}>{JSON.stringify(p.args, null, 2)}</Text>
            {p.requiresApproval && (
              <ApprovalActions approvalId={p.toolCallId} onApprove={onApprove} onDeny={onDeny} />
            )}
          </View>
        );

      case "tool_result":
        return (
          <View>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: p.ok ? "#22c55e" : "#ef4444" }]} />
              <Text style={styles.statusText}>{p.ok ? "Success" : "Failed"}</Text>
              {p.exitCode !== undefined && (
                <Text style={styles.metaText}> (exit: {p.exitCode})</Text>
              )}
            </View>
            {p.stdout && (
              <ScrollView horizontal style={styles.outputScroll}>
                <Text style={styles.outputText}>{p.stdout.substring(0, 500)}</Text>
              </ScrollView>
            )}
            {p.stderr && <Text style={styles.stderrText}>{p.stderr.substring(0, 200)}</Text>}
          </View>
        );

      case "approval_required":
        return (
          <View>
            <Text style={styles.approvalSummary}>{p.summary}</Text>
            <Text style={styles.metaText}>Action: {p.action}</Text>
            <ApprovalActions approvalId={p.approvalId} onApprove={onApprove} onDeny={onDeny} />
          </View>
        );

      case "approved":
        return <Text style={styles.successText}>Approved: {p.approvalId?.substring(0, 8)}</Text>;
      case "denied":
        return <Text style={styles.errorText}>Denied: {p.approvalId?.substring(0, 8)}</Text>;

      case "diff_ready":
        return <DiffPreview diff={p.unifiedDiff} stat={p.diffStat} />;

      case "committed":
        return (
          <Text style={styles.successText}>
            Committed {p.commitHash?.substring(0, 8)} on {p.branch}: {p.message}
          </Text>
        );

      case "job_enqueued":
        return (
          <Text style={styles.infoText}>
            Job queued: {p.kind} (task {p.taskId?.substring(0, 8)})
          </Text>
        );

      case "job_claimed":
        return <Text style={styles.infoText}>Job claimed by worker {p.workerId}</Text>;

      case "job_completed":
        return (
          <View>
            <Text style={styles.successText}>Job complete{p.summary ? `: ${p.summary}` : ""}</Text>
            {p.artifacts?.map((a: any, i: number) => (
              <Text key={i} style={styles.artifactText}>
                [{a.kind}]{a.text ? ` -- ${a.text.substring(0, 80)}...` : ""}
              </Text>
            ))}
          </View>
        );

      case "job_failed":
        return (
          <View>
            <Text style={styles.errorText}>Job failed: {p.message}</Text>
            {p.detail && <Text style={styles.detailText}>{p.detail}</Text>}
          </View>
        );

      case "log":
        return (
          <Text style={[styles.logText, p.level === "error" ? styles.errorText : null]}>
            [{p.level}] {p.message}
          </Text>
        );

      case "error":
        return (
          <View>
            <Text style={styles.errorText}>{p.message}</Text>
            {p.detail && <Text style={styles.detailText}>{p.detail}</Text>}
          </View>
        );

      default:
        return <Text style={styles.metaText}>{JSON.stringify(p, null, 2).substring(0, 200)}</Text>;
    }
  };

  return (
    <View style={[styles.card, { borderLeftColor: color }]}>
      <View style={styles.cardHeader}>
        <View style={[styles.eventTypeBadge, { backgroundColor: color + "20" }]}>
          <Text style={[styles.eventTypeText, { color }]}>{event.type}</Text>
        </View>
        <AgentBadge from={event.from} to={event.to} />
        <Text style={styles.ts}>{new Date(event.ts).toLocaleTimeString()}</Text>
      </View>
      <View style={styles.cardBody}>{renderPayload()}</View>
    </View>
  );
}

// ─── Filter bar ──────────────────────────────────────────────────────────────
function FilterBar({
  agents,
  tasks,
  turnIds,
  filters,
  setFilters,
}: {
  agents: string[];
  tasks: { taskId: string; title: string; status: string }[];
  turnIds: string[];
  filters: EventFilters;
  setFilters: (f: EventFilters) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasFilters =
    filters.agentFrom || filters.taskId || filters.turnId || (filters.eventTypes?.length ?? 0) > 0;

  return (
    <View style={styles.filterContainer}>
      <TouchableOpacity style={styles.filterToggle} onPress={() => setExpanded(!expanded)}>
        <Text style={styles.filterToggleText}>Filters{hasFilters ? " (active)" : ""}</Text>
        {hasFilters && (
          <TouchableOpacity onPress={() => setFilters({})}>
            <Text style={styles.clearFilterText}>Clear</Text>
          </TouchableOpacity>
        )}
      </TouchableOpacity>

      {expanded && (
        <View style={styles.filterBody}>
          {/* Agent filter */}
          {agents.length > 0 && (
            <View style={styles.filterRow}>
              <Text style={styles.filterLabel}>Agent:</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <TouchableOpacity
                  style={[styles.filterChip, !filters.agentFrom && styles.filterChipActive]}
                  onPress={() => setFilters({ ...filters, agentFrom: undefined })}
                >
                  <Text style={styles.filterChipText}>All</Text>
                </TouchableOpacity>
                {agents.map((a) => (
                  <TouchableOpacity
                    key={a}
                    style={[styles.filterChip, filters.agentFrom === a && styles.filterChipActive]}
                    onPress={() => setFilters({ ...filters, agentFrom: a })}
                  >
                    <Text style={styles.filterChipText}>{a}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Task filter */}
          {tasks.length > 0 && (
            <View style={styles.filterRow}>
              <Text style={styles.filterLabel}>Task:</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <TouchableOpacity
                  style={[styles.filterChip, !filters.taskId && styles.filterChipActive]}
                  onPress={() => setFilters({ ...filters, taskId: undefined })}
                >
                  <Text style={styles.filterChipText}>All</Text>
                </TouchableOpacity>
                {tasks.map((t) => (
                  <TouchableOpacity
                    key={t.taskId}
                    style={[
                      styles.filterChip,
                      filters.taskId === t.taskId && styles.filterChipActive,
                    ]}
                    onPress={() => setFilters({ ...filters, taskId: t.taskId })}
                  >
                    <Text style={styles.filterChipText}>
                      {TASK_STATUS_LABEL[t.status] ?? ""} {t.title.substring(0, 20)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Turn filter */}
          {turnIds.length > 1 && (
            <View style={styles.filterRow}>
              <Text style={styles.filterLabel}>Turn:</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <TouchableOpacity
                  style={[styles.filterChip, !filters.turnId && styles.filterChipActive]}
                  onPress={() => setFilters({ ...filters, turnId: undefined })}
                >
                  <Text style={styles.filterChipText}>All</Text>
                </TouchableOpacity>
                {turnIds.map((t, i) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.filterChip, filters.turnId === t && styles.filterChipActive]}
                    onPress={() => setFilters({ ...filters, turnId: t })}
                  >
                    <Text style={styles.filterChipText}>Turn {i + 1}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Task summary strip ─────────────────────────────────────────────────────
function TaskStrip({ tasks }: { tasks: { taskId: string; title: string; status: string }[] }) {
  if (tasks.length === 0) return null;
  return (
    <ScrollView horizontal style={styles.taskStrip} showsHorizontalScrollIndicator={false}>
      {tasks.map((t) => (
        <View key={t.taskId} style={styles.taskChip}>
          <Text style={styles.taskChipText}>
            {TASK_STATUS_LABEL[t.status] ?? "[?]"} {t.title.substring(0, 24)}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────
export default function ChatScreen() {
  const session = usePushPalsSession(DEFAULT_BASE);
  const [input, setInput] = useState("");
  const [activeTab, setActiveTab] = useState<"messages" | "events" | "tasks">("messages");
  const flatRef = useRef<FlatList<SessionEvent> | null>(null);
  const messagesEndRef = useRef<ScrollView | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const handleSendRef = useRef<() => void>(() => {});

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    try {
      await session.send(text);
    } catch (_err) {
      // error events will arrive via the stream
    }
  };
  handleSendRef.current = handleSend;

  const handleApprove = useCallback(
    (id: string) => {
      session.approve(id);
    },
    [session.approve],
  );
  const handleDeny = useCallback(
    (id: string) => {
      session.deny(id);
    },
    [session.deny],
  );

  useEffect(() => {
    if (activeTab === "events") {
      flatRef.current?.scrollToEnd({ animated: true });
    }
  }, [session.filteredEvents.length, activeTab]);

  // Auto-scroll messages tab
  useEffect(() => {
    if (activeTab === "messages") {
      messagesEndRef.current?.scrollToEnd({ animated: true });
    }
  }, [session.state.messages.length, activeTab]);

  // Keyboard shortcut: Alt+Enter (Win/Linux) or Cmd+Enter (Mac)
  // Attached directly to the input element so it works while focused.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = (inputRef.current as any)?._node ?? (inputRef.current as any);
    const dom: HTMLElement | null = el instanceof HTMLElement ? el : (el?.getHostNode?.() ?? null);
    if (!dom) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.altKey || e.metaKey)) {
        e.preventDefault();
        handleSendRef.current();
      }
    };
    dom.addEventListener("keydown", onKeyDown);
    return () => dom.removeEventListener("keydown", onKeyDown);
  }, []);

  const renderItem = ({ item }: { item: SessionEvent }) => {
    if (!isEnvelope(item)) {
      // Local error
      return (
        <View style={[styles.card, { borderLeftColor: "#dc2626" }]}>
          <Text style={styles.errorText}>[warn] {(item as any).message}</Text>
        </View>
      );
    }
    return <EventCard event={item} onApprove={handleApprove} onDeny={handleDeny} />;
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>PushPals</Text>
        <View style={styles.headerRight}>
          <Text style={styles.eventCount}>{session.events.length} events</Text>
          <View
            style={[
              styles.connDot,
              {
                backgroundColor: session.isConnected ? "#22c55e" : "#ef4444",
              },
            ]}
          />
        </View>
      </View>

      {session.error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{session.error}</Text>
        </View>
      )}

      {/* Task summary strip */}
      <TaskStrip tasks={session.tasks} />

      {/* Filter bar */}
      <FilterBar
        agents={session.agents}
        tasks={session.tasks}
        turnIds={session.turnIds}
        filters={session.filters}
        setFilters={session.setFilters}
      />

      {/* Tab switcher */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, activeTab === "messages" && styles.tabActive]}
          onPress={() => setActiveTab("messages")}
        >
          <Text style={[styles.tabText, activeTab === "messages" && styles.tabTextActive]}>
            Messages
            {session.state.messages.length > 0 ? ` (${session.state.messages.length})` : ""}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === "events" && styles.tabActive]}
          onPress={() => setActiveTab("events")}
        >
          <Text style={[styles.tabText, activeTab === "events" && styles.tabTextActive]}>
            Events
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === "tasks" && styles.tabActive]}
          onPress={() => setActiveTab("tasks")}
        >
          <Text style={[styles.tabText, activeTab === "tasks" && styles.tabTextActive]}>
            Tasks & Jobs
            {session.state.tasks.size > 0 ? ` (${session.state.tasks.size})` : ""}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {activeTab === "messages" ? (
        <ScrollView
          ref={(r) => {
            messagesEndRef.current = r;
          }}
          style={styles.chatScroll}
          contentContainerStyle={styles.chatContent}
        >
          {session.state.messages.length === 0 && (
            <View style={styles.emptyChat}>
              <Text style={styles.emptyChatText}>No messages yet. Say something!</Text>
            </View>
          )}
          {session.state.messages.map((msg) => {
            const isUser = msg.from === "client";
            return (
              <View
                key={msg.id}
                style={[styles.chatBubble, isUser ? styles.chatBubbleUser : styles.chatBubbleAgent]}
              >
                {!isUser && msg.from && <Text style={styles.chatFrom}>{msg.from}</Text>}
                <Text
                  style={[styles.chatText, isUser ? styles.chatTextUser : styles.chatTextAgent]}
                >
                  {msg.text}
                </Text>
                <Text style={styles.chatTs}>{new Date(msg.ts).toLocaleTimeString()}</Text>
              </View>
            );
          })}
        </ScrollView>
      ) : activeTab === "events" ? (
        <FlatList
          ref={(r) => {
            flatRef.current = r;
          }}
          data={session.filteredEvents}
          renderItem={renderItem}
          keyExtractor={(item, idx) => (isEnvelope(item) ? item.id : `err-${idx}`)}
          contentContainerStyle={styles.listContent}
        />
      ) : (
        <TasksJobsLogs state={session.state} />
      )}

      {/* Composer */}
      <View style={styles.composerRow}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder="Type a message..."
          value={input}
          onChangeText={setInput}
          multiline
          onSubmitEditing={handleSend}
        />
        <TouchableOpacity
          style={[styles.sendButton, !input.trim() && styles.sendDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || !session.isConnected}
        >
          <Text style={styles.sendText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },

  // Header
  header: {
    height: 56,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    backgroundColor: "#fff",
  },
  headerTitle: { fontSize: 18, fontWeight: "700", color: "#0f172a" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  eventCount: { fontSize: 12, color: "#64748b" },
  connDot: { width: 8, height: 8, borderRadius: 4 },

  // Error banner
  errorBanner: {
    backgroundColor: "#fef2f2",
    padding: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#fecaca",
  },
  errorBannerText: { color: "#dc2626", fontSize: 13 },

  // Task strip
  taskStrip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    backgroundColor: "#fff",
    maxHeight: 40,
  },
  taskChip: {
    backgroundColor: "#f1f5f9",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginRight: 6,
  },
  taskChipText: { fontSize: 12, color: "#334155" },

  // Filter bar
  filterContainer: {
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    backgroundColor: "#fff",
  },
  filterToggle: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filterToggleText: { fontSize: 13, color: "#475569", fontWeight: "500" },
  clearFilterText: { fontSize: 12, color: "#3b82f6" },
  filterBody: { paddingHorizontal: 12, paddingBottom: 8 },
  filterRow: { flexDirection: "row", alignItems: "center", marginBottom: 4 },
  filterLabel: { fontSize: 12, color: "#64748b", width: 48 },
  filterChip: {
    backgroundColor: "#f1f5f9",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    marginRight: 4,
    borderWidth: 1,
    borderColor: "transparent",
  },
  filterChipActive: {
    backgroundColor: "#dbeafe",
    borderColor: "#3b82f6",
  },
  filterChipText: { fontSize: 11, color: "#334155" },

  // Tab bar
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    backgroundColor: "#fff",
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: "#3b82f6",
  },
  tabText: {
    fontSize: 13,
    fontWeight: "500",
    color: "#94a3b8",
  },
  tabTextActive: {
    color: "#3b82f6",
    fontWeight: "600",
  },

  // List
  listContent: { padding: 12, paddingBottom: 8 },

  // Card
  card: {
    backgroundColor: "#fff",
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: "#94a3b8",
    marginBottom: 8,
    padding: 10,
    ...Platform.select({
      web: { boxShadow: "0 1px 3px rgba(0,0,0,0.06)" },
      default: { elevation: 1 },
    }),
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
    flexWrap: "wrap",
  },
  cardBody: {},

  // Event type badge
  eventTypeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  eventTypeText: { fontSize: 11, fontWeight: "600" },

  // Agent badge
  agentBadgeRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  badge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  badgeText: { fontSize: 10, fontWeight: "500" },
  arrowText: { fontSize: 10, color: "#94a3b8" },

  // Timestamp
  ts: { fontSize: 10, color: "#94a3b8", marginLeft: "auto" },

  // Content styles
  messageText: { fontSize: 14, color: "#1e293b", lineHeight: 20 },
  infoText: { fontSize: 13, color: "#475569" },
  successText: { fontSize: 13, color: "#16a34a", fontWeight: "500" },
  errorText: { fontSize: 13, color: "#dc2626" },
  detailText: { fontSize: 12, color: "#94a3b8", marginTop: 2 },
  logText: {
    fontSize: 12,
    color: "#64748b",
    fontFamily: Platform.OS === "web" ? "monospace" : undefined,
  },
  metaText: { fontSize: 11, color: "#94a3b8" },

  // Task
  taskTitle: { fontSize: 14, fontWeight: "600", color: "#1e293b" },
  taskDesc: { fontSize: 13, color: "#475569", marginTop: 2 },

  // Status
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, color: "#475569" },

  // Tool
  toolName: { fontSize: 13, fontWeight: "600", color: "#92400e" },
  toolArgs: {
    fontSize: 11,
    color: "#64748b",
    backgroundColor: "#f8fafc",
    padding: 6,
    borderRadius: 4,
    marginTop: 4,
    fontFamily: Platform.OS === "web" ? "monospace" : undefined,
  },

  // Approval
  approvalRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  approvalBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6 },
  approveBtn: { backgroundColor: "#dcfce7" },
  denyBtn: { backgroundColor: "#fee2e2" },
  approveBtnText: { color: "#16a34a", fontWeight: "600", fontSize: 13 },
  denyBtnText: { color: "#dc2626", fontWeight: "600", fontSize: 13 },
  approvalSummary: { fontSize: 13, color: "#1e293b", fontWeight: "500" },
  decisionBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginTop: 6,
    alignSelf: "flex-start",
  },
  approvedBg: { backgroundColor: "#dcfce7" },
  deniedBg: { backgroundColor: "#fee2e2" },
  decisionText: { fontSize: 12, fontWeight: "600" },

  // Artifacts
  artifactText: { fontSize: 12, color: "#6366f1", marginTop: 4 },

  // Diff
  diffContainer: { marginTop: 4 },
  diffStat: { fontSize: 12, color: "#475569", fontWeight: "500" },
  diffToggle: { fontSize: 12, color: "#3b82f6", marginTop: 4 },
  diffScroll: { maxHeight: 200, marginTop: 4 },
  diffCode: {
    fontSize: 11,
    color: "#334155",
    backgroundColor: "#f8fafc",
    padding: 8,
    fontFamily: Platform.OS === "web" ? "monospace" : undefined,
  },

  // Progress
  progressTrack: {
    height: 18,
    backgroundColor: "#e2e8f0",
    borderRadius: 9,
    marginTop: 6,
    overflow: "hidden",
    justifyContent: "center",
  },
  progressFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "#3b82f6",
    borderRadius: 9,
  },
  progressLabel: { fontSize: 10, color: "#475569", textAlign: "center" },

  // Output
  outputScroll: { maxHeight: 120, marginTop: 4 },
  outputText: {
    fontSize: 11,
    color: "#334155",
    backgroundColor: "#f0fdf4",
    padding: 6,
    borderRadius: 4,
    fontFamily: Platform.OS === "web" ? "monospace" : undefined,
  },
  stderrText: {
    fontSize: 11,
    color: "#dc2626",
    backgroundColor: "#fef2f2",
    padding: 6,
    borderRadius: 4,
    marginTop: 4,
  },

  // Composer
  composerRow: {
    flexDirection: "row",
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    alignItems: "flex-end",
    backgroundColor: "#fff",
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    padding: 8,
    backgroundColor: "#f8fafc",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    fontSize: 14,
  },
  sendButton: {
    marginLeft: 8,
    backgroundColor: "#3b82f6",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: "#fff", fontWeight: "600" },

  // Chat messages tab
  chatScroll: { flex: 1, backgroundColor: "#f8fafc" },
  chatContent: { padding: 12, paddingBottom: 8 },
  emptyChat: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80 },
  emptyChatText: { fontSize: 14, color: "#94a3b8" },
  chatBubble: {
    maxWidth: "75%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    marginBottom: 8,
  },
  chatBubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: "#3b82f6",
    borderBottomRightRadius: 4,
  },
  chatBubbleAgent: {
    alignSelf: "flex-start",
    backgroundColor: "#fff",
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  chatFrom: {
    fontSize: 10,
    color: "#64748b",
    fontWeight: "600",
    marginBottom: 2,
  },
  chatText: {
    fontSize: 14,
    lineHeight: 20,
  },
  chatTextUser: { color: "#fff" },
  chatTextAgent: { color: "#1e293b" },
  chatTs: {
    fontSize: 10,
    color: "#94a3b8",
    marginTop: 4,
    alignSelf: "flex-end",
  },
});
