import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import type { TextInputKeyPressEventData, NativeSyntheticEvent } from "react-native";
import type { EventEnvelope } from "protocol/browser";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { TasksJobsLogs } from "../src/lib/TasksJobsLogs";
import { usePushPalsSession } from "../src/lib/usePushPalsSession";
import {
  type CompletionSnapshotRow,
  type JobSnapshotRow,
  type PendingQueueSnapshot,
  type QueueCounts,
  type RequestSnapshotRow,
  type SystemStatusSummary,
  type WorkerStatusRow,
  fetchCompletionsSnapshot,
  fetchJobsSnapshot,
  fetchRequestsSnapshot,
  fetchSystemStatus,
  fetchWorkers,
} from "../src/lib/pushpalsApi";

const DEFAULT_BASE = process.env.EXPO_PUBLIC_PUSHPALS_URL ?? "http://localhost:3001";
const AUTH_TOKEN = process.env.EXPO_PUBLIC_PUSHPALS_AUTH_TOKEN;
const POLL_INTERVAL_MS = 4000;

type UiTab = "chat" | "requests" | "jobs" | "system";
type ThemeMode = "auto" | "light" | "dark";
type ResolvedMode = "light" | "dark";

interface DashboardTheme {
  mode: ResolvedMode;
  background: string;
  shell: string;
  panel: string;
  panelAlt: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  positive: string;
  warning: string;
  danger: string;
  bubbleUser: string;
  bubbleAgent: string;
  bubbleAgentBorder: string;
  inputBg: string;
  fontSans: string;
  fontMono: string;
}

interface ChatSpeakerPresentation {
  label: string;
  bubbleBg: string;
  bubbleBorder: string;
  labelColor: string;
}

function createTheme(mode: ResolvedMode): DashboardTheme {
  if (mode === "dark") {
    return {
      mode,
      background: "#0E151B",
      shell: "#121C23",
      panel: "#16222B",
      panelAlt: "#1B2A35",
      border: "#284050",
      text: "#EAF3F6",
      textMuted: "#97B3C2",
      accent: "#2FD6C8",
      accentSoft: "#173A3A",
      accentText: "#A6FFF6",
      positive: "#5DDD8B",
      warning: "#FFB95A",
      danger: "#FF6B72",
      bubbleUser: "#0F8A81",
      bubbleAgent: "#1B2A35",
      bubbleAgentBorder: "#32566A",
      inputBg: "#102029",
      fontSans: Platform.select({
        web: "'Space Grotesk', 'Avenir Next', 'Trebuchet MS', sans-serif",
        ios: "Avenir Next",
        android: "sans-serif-medium",
        default: "sans-serif",
      })!,
      fontMono: Platform.select({
        web: "'IBM Plex Mono', 'JetBrains Mono', monospace",
        ios: "Menlo",
        android: "monospace",
        default: "monospace",
      })!,
    };
  }

  return {
    mode,
    background: "#ECF2F5",
    shell: "#F7FAFC",
    panel: "#FFFFFF",
    panelAlt: "#F4F8FB",
    border: "#CFDAE2",
    text: "#112230",
    textMuted: "#547086",
    accent: "#007E77",
    accentSoft: "#D9F4F1",
    accentText: "#025C56",
    positive: "#169A58",
    warning: "#C7851E",
    danger: "#D64553",
    bubbleUser: "#06796F",
    bubbleAgent: "#FFFFFF",
    bubbleAgentBorder: "#D2E0E8",
    inputBg: "#EFF5F8",
    fontSans: Platform.select({
      web: "'Space Grotesk', 'Avenir Next', 'Trebuchet MS', sans-serif",
      ios: "Avenir Next",
      android: "sans-serif-medium",
      default: "sans-serif",
    })!,
    fontMono: Platform.select({
      web: "'IBM Plex Mono', 'JetBrains Mono', monospace",
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    })!,
  };
}

function prettyTs(iso?: string): string {
  if (!iso) return "--";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "--";
  return new Date(ts).toLocaleTimeString();
}

function relativeMs(iso?: string): string {
  if (!iso) return "unknown";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "unknown";
  const delta = Date.now() - ts;
  if (delta < 10_000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function clip(value: string | undefined | null, limit = 180): string {
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}...`;
}

function localBuddyMessageAlreadyRoutedRemote(text: string | undefined): boolean {
  const normalized = String(text ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("/ask_remote_buddy")) return true;
  if (!normalized.includes("remotebuddy")) return false;

  return (
    normalized.includes("queueing this to remotebuddy") ||
    normalized.includes("routing this to remotebuddy") ||
    normalized.includes("request queued") ||
    normalized.includes("is planning and will assign a workerpal") ||
    normalized.includes("delegating this to a workerpal") ||
    normalized.includes("assigned this request to workerpal") ||
    normalized.includes("no idle workerpal")
  );
}

function parseJsonText(value: string | null): string {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "string") return parsed;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

function statusColor(theme: DashboardTheme, status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("complete") || normalized.includes("processed")) return theme.positive;
  if (normalized.includes("fail") || normalized.includes("error") || normalized.includes("offline")) {
    return theme.danger;
  }
  if (normalized.includes("initializing")) return theme.warning;
  if (normalized.includes("busy") || normalized.includes("claim")) return theme.warning;
  if (normalized.includes("progress") || normalized.includes("start")) return theme.warning;
  return theme.accent;
}

function parseWorkerSuffix(raw: string): string | null {
  const match = raw.match(/workerpal-([a-z0-9]+)/i);
  return match?.[1] ? match[1].slice(0, 8) : null;
}

function resolveChatSpeaker(from: string | undefined, theme: DashboardTheme): ChatSpeakerPresentation {
  const raw = (from ?? "").trim();
  const normalized = raw.toLowerCase();

  const palette =
    theme.mode === "dark"
      ? {
          local: { bg: "#1A3342", border: "#2B6984", label: "#93D5FF" },
          remote: { bg: "#222C48", border: "#4F66D9", label: "#B6C5FF" },
          worker: { bg: "#213628", border: "#4D9F67", label: "#A4E2BA" },
          scm: { bg: "#352919", border: "#B88949", label: "#FFD4A2" },
          server: { bg: "#2A2638", border: "#7D6BB3", label: "#D4C5FF" },
          agent: { bg: theme.bubbleAgent, border: theme.bubbleAgentBorder, label: theme.accent },
        }
      : {
          local: { bg: "#E9F6FF", border: "#9CCBF0", label: "#165B86" },
          remote: { bg: "#EEF0FF", border: "#AAB8F8", label: "#35449A" },
          worker: { bg: "#EAF8EC", border: "#9CD2AE", label: "#1E6C40" },
          scm: { bg: "#FFF4E7", border: "#E1B67A", label: "#8A5D1D" },
          server: { bg: "#F0EDFA", border: "#B8AFE5", label: "#5C4DA5" },
          agent: { bg: theme.bubbleAgent, border: theme.bubbleAgentBorder, label: theme.accentText },
        };

  if (normalized.includes("localbuddy")) {
    return {
      label: "Local Buddy",
      bubbleBg: palette.local.bg,
      bubbleBorder: palette.local.border,
      labelColor: palette.local.label,
    };
  }
  if (normalized.includes("remotebuddy")) {
    return {
      label: "Remote Buddy",
      bubbleBg: palette.remote.bg,
      bubbleBorder: palette.remote.border,
      labelColor: palette.remote.label,
    };
  }
  if (normalized.includes("workerpal") || normalized.includes("workerpals")) {
    const suffix = parseWorkerSuffix(normalized);
    return {
      label: suffix ? `WorkerPal ${suffix}` : "WorkerPal",
      bubbleBg: palette.worker.bg,
      bubbleBorder: palette.worker.border,
      labelColor: palette.worker.label,
    };
  }
  if (
    normalized.includes("source_control_manager") ||
    normalized.includes("sourcecontrolmanager") ||
    normalized.includes("scm")
  ) {
    return {
      label: "Source Control Manager",
      bubbleBg: palette.scm.bg,
      bubbleBorder: palette.scm.border,
      labelColor: palette.scm.label,
    };
  }
  if (normalized.includes("server")) {
    return {
      label: "Server",
      bubbleBg: palette.server.bg,
      bubbleBorder: palette.server.border,
      labelColor: palette.server.label,
    };
  }

  if (!raw) {
    return {
      label: "Agent",
      bubbleBg: palette.agent.bg,
      bubbleBorder: palette.agent.border,
      labelColor: palette.agent.label,
    };
  }

  const simple = raw.replace(/^agent:/i, "").replace(/[-_]+/g, " ").trim();
  const pretty = simple.replace(/\b\w/g, (ch) => ch.toUpperCase());
  return {
    label: pretty || "Agent",
    bubbleBg: palette.agent.bg,
    bubbleBorder: palette.agent.border,
    labelColor: palette.agent.label,
  };
}

function summarizeEvent(event: EventEnvelope): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const preferredKeys = [
    "message",
    "summary",
    "title",
    "detail",
    "error",
    "status",
    "kind",
    "jobId",
    "taskId",
    "requestId",
  ] as const;

  for (const key of preferredKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return clip(value, 140);
  }

  if (typeof payload === "object" && payload && Object.keys(payload).length > 0) {
    return clip(JSON.stringify(payload), 140);
  }

  return "No payload details";
}

function queueValue(counts: QueueCounts | undefined, key: string): number {
  return Number(counts?.[key] ?? 0);
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${Math.round(value * 100)}%`;
}

function formatDuration(valueMs: number | null | undefined): string {
  if (typeof valueMs !== "number" || !Number.isFinite(valueMs) || valueMs < 0) return "--";
  if (valueMs < 1000) return `${Math.round(valueMs)}ms`;
  if (valueMs < 60_000) return `${(valueMs / 1000).toFixed(1)}s`;
  return `${Math.round(valueMs / 1000)}s`;
}

function formatEtaMs(valueMs: number | null | undefined): string {
  if (typeof valueMs !== "number" || !Number.isFinite(valueMs) || valueMs <= 0) return "now";
  if (valueMs < 1_000) return `${Math.round(valueMs)}ms`;
  const seconds = Math.ceil(valueMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
}

function SegmentedTabs({
  tabs,
  active,
  onSelect,
  theme,
}: {
  tabs: { id: UiTab; label: string; count?: number }[];
  active: UiTab;
  onSelect: (tab: UiTab) => void;
  theme: DashboardTheme;
}) {
  return (
    <View style={[styles.segmentWrap, { backgroundColor: theme.panelAlt, borderColor: theme.border }]}>
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

function ModeSwitcher({
  mode,
  onChange,
  theme,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  theme: DashboardTheme;
}) {
  const modes: ThemeMode[] = ["auto", "light", "dark"];
  return (
    <View style={[styles.modeWrap, { borderColor: theme.border, backgroundColor: theme.panelAlt }]}>
      {modes.map((item) => {
        const selected = mode === item;
        return (
          <Pressable
            key={item}
            style={[styles.modeBtn, selected && { backgroundColor: theme.accentSoft }]}
            onPress={() => onChange(item)}
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

function MetricTile({
  title,
  value,
  detail,
  theme,
  tone = "accent",
}: {
  title: string;
  value: string;
  detail?: string;
  theme: DashboardTheme;
  tone?: "accent" | "positive" | "warning" | "danger";
}) {
  const color =
    tone === "positive"
      ? theme.positive
      : tone === "warning"
        ? theme.warning
        : tone === "danger"
          ? theme.danger
          : theme.accent;
  return (
    <View style={[styles.metricTile, { borderColor: theme.border, backgroundColor: theme.panelAlt }]}>
      <Text style={[styles.metricTitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>{title}</Text>
      <Text style={[styles.metricValue, { color, fontFamily: theme.fontSans }]}>{value}</Text>
      {detail ? (
        <Text style={[styles.metricDetail, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

function CollapsibleMessage({ text, theme }: { text: string; theme: DashboardTheme }) {
  const [expanded, setExpanded] = useState(false);
  const threshold = 360;
  const needsCollapse = text.length > threshold;
  const display = needsCollapse && !expanded ? `${text.slice(0, threshold)}...` : text;
  return (
    <View>
      <Text style={[styles.chatText, { color: theme.text, fontFamily: theme.fontSans }]}>{display}</Text>
      {needsCollapse ? (
        <Pressable onPress={() => setExpanded((prev) => !prev)}>
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

function ChatPane({
  theme,
  messages,
  input,
  setInput,
  onSend,
  onEscalate,
  connected,
  localBuddyThinking,
}: {
  theme: DashboardTheme;
  messages: { id: string; from?: string; text: string; ts: string }[];
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  onEscalate: (text: string) => void;
  connected: boolean;
  localBuddyThinking: boolean;
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
  }, [messages.length, localBuddyThinking]);

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
            <Text style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
              Start with a task. LocalBuddy will enqueue and RemoteBuddy will coordinate execution.
            </Text>
          </View>
        ) : (
          messages.map((message, index) => {
            const isUser = (message.from ?? "").toLowerCase().includes("client");
            const speaker = resolveChatSpeaker(message.from, theme);
            const isLocalBuddy = !isUser && (message.from ?? "").toLowerCase().includes("localbuddy");
            const priorUserMessage = isLocalBuddy
              ? [...messages.slice(0, index)]
                  .reverse()
                  .find((entry) => (entry.from ?? "").toLowerCase().includes("client"))
              : null;
            const showEscalateButton =
              isLocalBuddy &&
              Boolean(priorUserMessage?.text) &&
              !localBuddyMessageAlreadyRoutedRemote(message.text);
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
                  <Text style={[styles.chatFrom, { color: speaker.labelColor, fontFamily: theme.fontSans }]}>
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
                {showEscalateButton ? (
                  <Pressable
                    onPress={() => onEscalate(priorUserMessage.text)}
                    style={[styles.escalateButton, { borderColor: theme.accent }]}
                  >
                    <Text style={[styles.escalateButtonLabel, { color: theme.accent, fontFamily: theme.fontSans }]}>
                      Send This To RemoteBuddy
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })
        )}
        {localBuddyThinking ? (
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
            <Text style={[styles.chatFrom, { color: theme.accent, fontFamily: theme.fontSans }]}>Local Buddy</Text>
            <View style={styles.typingLine}>
              <Text style={[styles.typingLabel, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                Thinking
              </Text>
              <TypingDots theme={theme} />
            </View>
          </View>
        ) : null}
      </ScrollView>

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
          onKeyPress={handleComposerKeyPress}
        />
        <View style={styles.sendWrap}>
          <Pressable
            onPress={onSend}
            disabled={!connected || !input.trim()}
            style={[
              styles.sendButton,
              {
                backgroundColor: theme.accent,
                opacity: !connected || !input.trim() ? 0.45 : 1,
              },
            ]}
          >
            <Text style={[styles.sendLabel, { fontFamily: theme.fontSans }]}>Send</Text>
          </Pressable>
          <Text style={[styles.shortcutHint, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
            Alt+Enter / Cmd+Enter
          </Text>
        </View>
      </View>
    </View>
  );
}
function RequestsPane({
  theme,
  rows,
  counts,
  pendingSnapshot,
}: {
  theme: DashboardTheme;
  rows: RequestSnapshotRow[];
  counts: QueueCounts;
  pendingSnapshot: PendingQueueSnapshot[];
}) {
  const pendingById = useMemo(
    () => new Map(pendingSnapshot.map((snapshot) => [snapshot.id, snapshot])),
    [pendingSnapshot],
  );

  return (
    <ScrollView style={styles.tabFill} contentContainerStyle={styles.scrollContent}>
      <View style={styles.metricRow}>
        <MetricTile title="Pending" value={String(queueValue(counts, "pending"))} tone="warning" theme={theme} />
        <MetricTile title="Claimed" value={String(queueValue(counts, "claimed"))} tone="accent" theme={theme} />
        <MetricTile
          title="Completed"
          value={String(queueValue(counts, "completed"))}
          tone="positive"
          theme={theme}
        />
        <MetricTile title="Failed" value={String(queueValue(counts, "failed"))} tone="danger" theme={theme} />
      </View>

      {rows.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: theme.text, fontFamily: theme.fontSans }]}>No requests yet</Text>
          <Text style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
            Requests from LocalBuddy will appear here with full lifecycle status.
          </Text>
        </View>
      ) : (
        rows.map((request) => {
          const rowColor = statusColor(theme, request.status);
          const resultText = parseJsonText(request.result);
          const errorText = parseJsonText(request.error);
          const queueMeta = pendingById.get(request.id);
          const priority = request.priority ?? "normal";
          const phaseBits = [
            request.enqueuedAt ? `enq ${prettyTs(request.enqueuedAt)}` : null,
            request.claimedAt ? `claim ${prettyTs(request.claimedAt)}` : null,
            request.completedAt ? `done ${prettyTs(request.completedAt)}` : null,
            request.failedAt ? `fail ${prettyTs(request.failedAt)}` : null,
          ].filter(Boolean) as string[];
          const lifecycleSummary =
            request.status === "pending" && queueMeta
              ? `queue #${queueMeta.position} (eta ${formatEtaMs(queueMeta.etaMs)})`
              : request.durationMs != null
                ? `elapsed ${formatDuration(request.durationMs)}`
                : "in progress";

          return (
            <View
              key={request.id}
              style={[styles.requestCard, { borderColor: theme.border, backgroundColor: theme.panel }]}
            >
              <View style={styles.rowBetween}>
                <Text style={[styles.requestId, { color: theme.text, fontFamily: theme.fontMono }]}>
                  {request.id.slice(0, 8)}
                </Text>
                <View style={[styles.statusPill, { backgroundColor: `${rowColor}22`, borderColor: `${rowColor}66` }]}>
                  <Text style={[styles.statusPillText, { color: rowColor, fontFamily: theme.fontSans }]}>
                    {request.status}
                  </Text>
                </View>
              </View>
              <Text style={[styles.requestPrompt, { color: theme.text, fontFamily: theme.fontSans }]}>
                {clip(request.prompt, 260)}
              </Text>
              <Text style={[styles.requestSubline, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                priority {priority} | {lifecycleSummary}
              </Text>
              <Text style={[styles.requestSubline, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                agent {request.agentId ?? "--"} | created {prettyTs(request.createdAt)} | updated {relativeMs(request.updatedAt)}
              </Text>
              {phaseBits.length > 0 ? (
                <Text style={[styles.requestPhaseLine, { color: theme.textMuted, fontFamily: theme.fontMono }]}>
                  {phaseBits.join(" | ")}
                </Text>
              ) : null}
              {request.queueWaitBudgetMs != null ? (
                <Text style={[styles.requestSubline, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                  queue budget {formatDuration(request.queueWaitBudgetMs)}
                </Text>
              ) : null}
              {request.durationMs != null ? (
                <Text style={[styles.requestSubline, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                  request duration {formatDuration(request.durationMs)}
                </Text>
              ) : null}
              {resultText ? (
                <View style={[styles.codeBlock, { borderColor: theme.border, backgroundColor: theme.panelAlt }]}>
                  <Text style={[styles.codeBlockLabel, { color: theme.positive, fontFamily: theme.fontSans }]}>result</Text>
                  <Text style={[styles.codeBlockText, { color: theme.text, fontFamily: theme.fontMono }]}>
                    {clip(resultText, 600)}
                  </Text>
                </View>
              ) : null}
              {errorText ? (
                <View style={[styles.codeBlock, { borderColor: `${theme.danger}77`, backgroundColor: `${theme.danger}14` }]}>
                  <Text style={[styles.codeBlockLabel, { color: theme.danger, fontFamily: theme.fontSans }]}>error</Text>
                  <Text style={[styles.codeBlockText, { color: theme.text, fontFamily: theme.fontMono }]}>
                    {clip(errorText, 600)}
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

function JobsPane({
  theme,
  isWide,
  jobs,
  jobCounts,
  pendingSnapshot,
  completions,
  completionCounts,
  sessionState,
}: {
  theme: DashboardTheme;
  isWide: boolean;
  jobs: JobSnapshotRow[];
  jobCounts: QueueCounts;
  pendingSnapshot: PendingQueueSnapshot[];
  completions: CompletionSnapshotRow[];
  completionCounts: QueueCounts;
  sessionState: ReturnType<typeof usePushPalsSession>["state"];
}) {
  const recentJobs = jobs.slice(0, 40);
  const pendingById = useMemo(
    () => new Map(pendingSnapshot.map((snapshot) => [snapshot.id, snapshot])),
    [pendingSnapshot],
  );

  return (
    <View style={styles.tabFill}>
      <View style={styles.metricRow}>
        <MetricTile title="Queued Jobs" value={String(queueValue(jobCounts, "pending"))} tone="warning" theme={theme} />
        <MetricTile title="Running Jobs" value={String(queueValue(jobCounts, "claimed"))} tone="accent" theme={theme} />
        <MetricTile
          title="Completions"
          value={String(queueValue(completionCounts, "processed"))}
          tone="positive"
          theme={theme}
        />
        <MetricTile title="Failed Jobs" value={String(queueValue(jobCounts, "failed"))} tone="danger" theme={theme} />
      </View>

      <View style={[styles.jobsLayout, isWide && styles.jobsLayoutWide]}>
        <View style={[styles.jobsListPane, { borderColor: theme.border, backgroundColor: theme.panel }]}>
          <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>Queue Activity</Text>
          {recentJobs.length === 0 ? (
            <Text style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>No job rows yet.</Text>
          ) : (
            <FlatList
              data={recentJobs}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => {
                const color = statusColor(theme, item.status);
                const queueMeta = pendingById.get(item.id);
                const priority = item.priority ?? "normal";
                const phaseBits = [
                  item.enqueuedAt ? `enq ${prettyTs(item.enqueuedAt)}` : null,
                  item.claimedAt ? `claim ${prettyTs(item.claimedAt)}` : null,
                  item.startedAt ? `start ${prettyTs(item.startedAt)}` : null,
                  item.firstLogAt ? `first-log ${prettyTs(item.firstLogAt)}` : null,
                  item.completedAt ? `done ${prettyTs(item.completedAt)}` : null,
                  item.failedAt ? `fail ${prettyTs(item.failedAt)}` : null,
                ].filter(Boolean) as string[];
                const lifecycleSummary =
                  item.status === "pending" && queueMeta
                    ? `queue #${queueMeta.position} (eta ${formatEtaMs(queueMeta.etaMs)})`
                    : item.status === "claimed"
                      ? "running"
                      : item.durationMs != null
                        ? `elapsed ${formatDuration(item.durationMs)}`
                        : "terminal";

                return (
                  <View style={[styles.jobRow, { borderColor: theme.border }]}>
                    <View style={[styles.jobDot, { backgroundColor: color }]} />
                    <View style={styles.jobTextCol}>
                      <Text style={[styles.jobKind, { color: theme.text, fontFamily: theme.fontSans }]}>{item.kind}</Text>
                      <Text style={[styles.jobMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                        {item.id.slice(0, 8)} | worker {item.workerId ?? "--"} | {relativeMs(item.updatedAt)}
                      </Text>
                      <Text style={[styles.jobMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                        priority {priority} | {lifecycleSummary}
                      </Text>
                      {phaseBits.length > 0 ? (
                        <Text style={[styles.jobPhaseLine, { color: theme.textMuted, fontFamily: theme.fontMono }]}>
                          {phaseBits.join(" | ")}
                        </Text>
                      ) : null}
                      {item.executionBudgetMs != null || item.finalizationBudgetMs != null ? (
                        <Text style={[styles.jobMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                          budget exec {formatDuration(item.executionBudgetMs)} | finalize {formatDuration(item.finalizationBudgetMs)}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={[styles.jobStatus, { color, fontFamily: theme.fontSans }]}>{item.status}</Text>
                  </View>
                );
              }}
            />
          )}

          {completions.length > 0 ? (
            <View style={styles.completionStrip}>
              <Text style={[styles.subSectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>Recent Completions</Text>
              {completions.slice(0, 16).map((completion) => {
                const color = statusColor(theme, completion.status);
                return (
                  <View key={completion.id} style={[styles.completionRow, { borderColor: theme.border }]}>
                    <Text style={[styles.completionMeta, { color: theme.text, fontFamily: theme.fontMono }]}>
                      {completion.id.slice(0, 8)}
                    </Text>
                    <Text style={[styles.completionLine, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                      {clip(completion.message, 110)}
                    </Text>
                    <Text style={[styles.completionMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                      {completion.branch ?? "--"} | {completion.commitSha?.slice(0, 8) ?? "--"}
                    </Text>
                    <Text style={[styles.completionStatus, { color, fontFamily: theme.fontSans }]}>
                      {completion.status}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>

        <View style={[styles.jobsTracePane, { borderColor: theme.border, backgroundColor: theme.panel }]}>
          <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>Tasks and Traces</Text>
          <View style={styles.tracePanelBody}>
            <TasksJobsLogs
              state={sessionState}
              theme={{
                mode: theme.mode,
                fontSans: theme.fontSans,
                fontMono: theme.fontMono,
              }}
            />
          </View>
        </View>
      </View>
    </View>
  );
}
function SystemPane({
  theme,
  events,
  connected,
  workers,
  systemSummary,
  lastRefresh,
}: {
  theme: DashboardTheme;
  events: ReturnType<typeof usePushPalsSession>["events"][number][];
  connected: boolean;
  workers: WorkerStatusRow[];
  systemSummary: SystemStatusSummary;
  lastRefresh: string | null;
}) {
  const INITIALIZING_GRACE_MS = 90_000;
  const connectedSinceRef = useRef<number | null>(null);
  if (connected) {
    if (connectedSinceRef.current == null) {
      connectedSinceRef.current = Date.now();
    }
  } else {
    connectedSinceRef.current = null;
  }
  const withinInitializingGrace =
    connected &&
    connectedSinceRef.current != null &&
    Date.now() - connectedSinceRef.current < INITIALIZING_GRACE_MS;

  const envelopes = useMemo(() => events as EventEnvelope[], [events]);

  const latestEventByComponent = useMemo(() => {
    const byName: Record<string, string | undefined> = {
      LocalBuddy: undefined,
      RemoteBuddy: undefined,
      WorkerPals: undefined,
      SourceControlManager: undefined,
    };

    const hasAny = (value: string, needles: string[]): boolean => needles.some((needle) => value.includes(needle));

    for (const event of envelopes) {
      const from = (event.from ?? "").toLowerCase();
      const payload = event.payload as Record<string, unknown>;
      const payloadAgentId =
        typeof payload?.agentId === "string" ? (payload.agentId as string).toLowerCase() : "";
      const signal = `${from} ${payloadAgentId}`;

      if (hasAny(signal, ["localbuddy", "local_buddy", "local buddy"])) byName.LocalBuddy = event.ts;
      if (hasAny(signal, ["remotebuddy", "remote_buddy", "remote buddy"])) {
        byName.RemoteBuddy = event.ts;
      }
      if (hasAny(signal, ["workerpal", "workerpals", "worker_pal", "worker pals", "worker"])) {
        byName.WorkerPals = event.ts;
      }
      if (
        hasAny(signal, [
          "source_control_manager",
          "sourcecontrolmanager",
          "source control manager",
          "source-control-manager",
          "scm",
        ])
      ) {
        byName.SourceControlManager = event.ts;
      }
    }
    return byName;
  }, [envelopes]);

  const onlineWorkers = workers.filter((worker) => worker.isOnline).length;
  const recentEvents = useMemo(() => envelopes.slice(-40).reverse(), [envelopes]);
  const requestSlo = systemSummary.slo?.requests;
  const jobSlo = systemSummary.slo?.jobs;

  const componentRows = [
    {
      name: "Server Stream",
      status: connected ? "connected" : "disconnected",
      detail: connected ? "session event stream live" : "not connected",
      ts: systemSummary.ts,
    },
    {
      name: "LocalBuddy",
      status: latestEventByComponent.LocalBuddy
        ? "active"
        : withinInitializingGrace
          ? "initializing"
          : "unknown",
      detail: latestEventByComponent.LocalBuddy
        ? `last event ${relativeMs(latestEventByComponent.LocalBuddy)}`
        : withinInitializingGrace
          ? "waiting for first status event"
          : "no events yet",
      ts: latestEventByComponent.LocalBuddy,
    },
    {
      name: "RemoteBuddy",
      status: latestEventByComponent.RemoteBuddy
        ? "active"
        : withinInitializingGrace
          ? "initializing"
          : "unknown",
      detail: latestEventByComponent.RemoteBuddy
        ? `last event ${relativeMs(latestEventByComponent.RemoteBuddy)}`
        : withinInitializingGrace
          ? "waiting for first status event"
          : "no events yet",
      ts: latestEventByComponent.RemoteBuddy,
    },
    {
      name: "WorkerPals",
      status: onlineWorkers > 0 ? "online" : "offline",
      detail: `${onlineWorkers}/${workers.length} online`,
      ts: workers[0]?.lastHeartbeat,
    },
    {
      name: "SourceControlManager",
      status: latestEventByComponent.SourceControlManager
        ? "active"
        : withinInitializingGrace
          ? "initializing"
          : "unknown",
      detail: latestEventByComponent.SourceControlManager
        ? `last event ${relativeMs(latestEventByComponent.SourceControlManager)}`
        : withinInitializingGrace
          ? "waiting for first status event"
          : "no events yet",
      ts: latestEventByComponent.SourceControlManager,
    },
  ];

  return (
    <ScrollView style={styles.tabFill} contentContainerStyle={styles.scrollContent}>
      <View style={styles.metricRow}>
        <MetricTile
          title="Online Workers"
          value={String(systemSummary.workers?.online ?? onlineWorkers)}
          detail={`${systemSummary.workers?.busy ?? workers.filter((w) => w.status === "busy").length} busy`}
          tone="accent"
          theme={theme}
        />
        <MetricTile
          title="Pending Requests"
          value={String(queueValue(systemSummary.queues?.requests, "pending"))}
          tone="warning"
          theme={theme}
        />
        <MetricTile
          title="Pending Completions"
          value={String(queueValue(systemSummary.queues?.completions, "pending"))}
          tone="warning"
          theme={theme}
        />
        <MetricTile
          title="Refresh"
          value={lastRefresh ? relativeMs(lastRefresh) : "--"}
          detail={lastRefresh ? prettyTs(lastRefresh) : "no sync"}
          theme={theme}
        />
        <MetricTile
          title="Request SLO (24h)"
          value={formatPercent(requestSlo?.successRate)}
          detail={`p95 wait ${formatDuration(requestSlo?.queueWaitMs?.p95)}`}
          theme={theme}
        />
        <MetricTile
          title="Job SLO (24h)"
          value={formatPercent(jobSlo?.successRate)}
          detail={`timeout ${formatPercent(jobSlo?.timeoutRate)} | p95 run ${formatDuration(jobSlo?.durationMs?.p95)}`}
          theme={theme}
        />
      </View>

      <View style={styles.systemGrid}>
        {componentRows.map((row) => {
          const color = statusColor(theme, row.status);
          return (
            <View key={row.name} style={[styles.systemCard, { borderColor: theme.border, backgroundColor: theme.panel }]}>
              <View style={styles.rowBetween}>
                <Text style={[styles.systemTitle, { color: theme.text, fontFamily: theme.fontSans }]}>{row.name}</Text>
                <View style={[styles.statusPill, { backgroundColor: `${color}22`, borderColor: `${color}66` }]}>
                  <Text style={[styles.statusPillText, { color, fontFamily: theme.fontSans }]}>{row.status}</Text>
                </View>
              </View>
              <Text style={[styles.systemDetail, { color: theme.textMuted, fontFamily: theme.fontSans }]}>{row.detail}</Text>
              <Text style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                {row.ts ? `updated ${prettyTs(row.ts)}` : "no timestamp"}
              </Text>
            </View>
          );
        })}
      </View>

      <View style={[styles.workerPanel, { borderColor: theme.border, backgroundColor: theme.panel }]}>
        <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>Worker Fleet</Text>
        {workers.length === 0 ? (
          <Text style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>No workers reported yet.</Text>
        ) : (
          workers.map((worker) => {
            const color = statusColor(theme, worker.status);
            return (
              <View key={worker.workerId} style={[styles.workerRow, { borderColor: theme.border }]}>
                <View style={[styles.jobDot, { backgroundColor: color }]} />
                <View style={styles.workerTextCol}>
                  <Text style={[styles.workerName, { color: theme.text, fontFamily: theme.fontSans }]}> {worker.workerId}</Text>
                  <Text style={[styles.workerMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                    {worker.status} | job {worker.currentJobId?.slice(0, 8) ?? "--"} | heartbeat {relativeMs(worker.lastHeartbeat)}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </View>

      <View style={[styles.eventPanel, { borderColor: theme.border, backgroundColor: theme.panel }]}>
        <View style={styles.rowBetween}>
          <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
            Recent Event Stream
          </Text>
          <Text style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
            {recentEvents.length} latest
          </Text>
        </View>
        {recentEvents.length === 0 ? (
          <Text style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
            No events yet.
          </Text>
        ) : (
          recentEvents.map((event) => {
            const color = statusColor(theme, event.type);
            return (
              <View key={event.id} style={[styles.eventRow, { borderColor: theme.border }]}>
                <View style={styles.eventMain}>
                  <Text style={[styles.eventMeta, { color: theme.textMuted, fontFamily: theme.fontMono }]}>
                    {prettyTs(event.ts)} | {event.from ?? "unknown"}
                  </Text>
                  <Text style={[styles.eventSummary, { color: theme.text, fontFamily: theme.fontSans }]}>
                    {summarizeEvent(event)}
                  </Text>
                </View>
                <View
                  style={[
                    styles.statusPill,
                    {
                      backgroundColor: `${color}22`,
                      borderColor: `${color}66`,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusPillText,
                      {
                        color,
                        fontFamily: theme.fontSans,
                      },
                    ]}
                  >
                    {event.type}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

export default function DashboardScreen() {
  const session = usePushPalsSession(DEFAULT_BASE);
  const colorScheme = useColorScheme();
  const { width } = useWindowDimensions();

  const [mode, setMode] = useState<ThemeMode>("auto");
  const resolvedMode: ResolvedMode =
    mode === "auto" ? ((colorScheme ?? "light") as ResolvedMode) : (mode as ResolvedMode);
  const theme = useMemo(() => createTheme(resolvedMode), [resolvedMode]);

  const [activeTab, setActiveTab] = useState<UiTab>("chat");
  const [input, setInput] = useState("");
  const [pendingLocalResponses, setPendingLocalResponses] = useState(0);
  const [workers, setWorkers] = useState<WorkerStatusRow[]>([]);
  const [requests, setRequests] = useState<RequestSnapshotRow[]>([]);
  const [requestCounts, setRequestCounts] = useState<QueueCounts>({});
  const [requestPendingSnapshot, setRequestPendingSnapshot] = useState<PendingQueueSnapshot[]>([]);
  const [jobs, setJobs] = useState<JobSnapshotRow[]>([]);
  const [jobCounts, setJobCounts] = useState<QueueCounts>({});
  const [jobPendingSnapshot, setJobPendingSnapshot] = useState<PendingQueueSnapshot[]>([]);
  const [completions, setCompletions] = useState<CompletionSnapshotRow[]>([]);
  const [completionCounts, setCompletionCounts] = useState<QueueCounts>({});
  const [systemSummary, setSystemSummary] = useState<SystemStatusSummary>({});
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const mountAnim = useRef(new Animated.Value(0)).current;
  const tabAnim = useRef(new Animated.Value(1)).current;

  const isWide = width >= 1060;

  useEffect(() => {
    Animated.spring(mountAnim, {
      toValue: 1,
      friction: 8,
      tension: 70,
      useNativeDriver: true,
    }).start();
  }, [mountAnim]);

  useEffect(() => {
    tabAnim.setValue(0.7);
    Animated.timing(tabAnim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [activeTab, tabAnim]);
  const refreshObservability = useCallback(async () => {
    const [workersData, requestData, jobData, completionData, systemData] = await Promise.all([
      fetchWorkers(DEFAULT_BASE, AUTH_TOKEN),
      fetchRequestsSnapshot(DEFAULT_BASE, AUTH_TOKEN),
      fetchJobsSnapshot(DEFAULT_BASE, AUTH_TOKEN),
      fetchCompletionsSnapshot(DEFAULT_BASE, AUTH_TOKEN),
      fetchSystemStatus(DEFAULT_BASE, AUTH_TOKEN),
    ]);

    setWorkers(workersData);
    setRequests(requestData.requests);
    setRequestCounts(requestData.counts);
    setRequestPendingSnapshot(requestData.pendingSnapshot);
    setJobs(jobData.jobs);
    setJobCounts(jobData.counts);
    setJobPendingSnapshot(jobData.pendingSnapshot);
    setCompletions(completionData.completions);
    setCompletionCounts(completionData.counts);
    setSystemSummary(systemData);
    setLastRefresh(new Date().toISOString());
  }, []);

  useEffect(() => {
    refreshObservability();
    const timer = setInterval(refreshObservability, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshObservability]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setPendingLocalResponses((count) => count + 1);
    try {
      await session.send(text);
    } finally {
      setPendingLocalResponses((count) => Math.max(0, count - 1));
    }
  }, [input, session]);

  const escalateToRemote = useCallback(
    async (text: string) => {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return;
      setPendingLocalResponses((count) => count + 1);
      try {
        await session.send(`/ask_remote_buddy ${trimmed}`);
      } finally {
        setPendingLocalResponses((count) => Math.max(0, count - 1));
      }
    },
    [session],
  );

  const tabs = useMemo(
    () => [
      { id: "chat" as const, label: "Chat", count: session.state.messages.length },
      { id: "requests" as const, label: "Requests", count: requests.length },
      { id: "jobs" as const, label: "Jobs & Traces", count: session.state.jobs.size },
      { id: "system" as const, label: "System", count: workers.length },
    ],
    [session.state.messages.length, requests.length, session.state.jobs.size, workers.length],
  );

  const totalEvents = session.events.length;
  const pendingWork = queueValue(requestCounts, "pending") + queueValue(jobCounts, "pending");

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.backdropBlob, styles.backdropBlobA, { backgroundColor: `${theme.accent}20` }]} />
      <View style={[styles.backdropBlob, styles.backdropBlobB, { backgroundColor: `${theme.warning}16` }]} />
      <View style={[styles.backdropBlob, styles.backdropBlobC, { backgroundColor: `${theme.positive}18` }]} />

      <Animated.View
        style={[
          styles.shell,
          {
            backgroundColor: theme.shell,
            borderColor: theme.border,
            opacity: mountAnim,
            transform: [
              {
                translateY: mountAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [18, 0],
                }),
              },
            ],
          },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={[styles.eyebrow, { color: theme.textMuted, fontFamily: theme.fontSans }]}>pushpals operations console</Text>
            <Text style={[styles.title, { color: theme.text, fontFamily: theme.fontSans }]}>Mission Control</Text>
            <Text style={[styles.subtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
              Real-time chat, orchestration, queue health, and execution trace visibility.
            </Text>
          </View>
          <ModeSwitcher mode={mode} onChange={setMode} theme={theme} />
        </View>

        {session.error ? (
          <View style={[styles.banner, { backgroundColor: `${theme.danger}22`, borderColor: `${theme.danger}55` }]}>
            <Text style={[styles.bannerText, { color: theme.danger, fontFamily: theme.fontSans }]}>{session.error}</Text>
          </View>
        ) : null}

        <View style={styles.metricRow}>
          <MetricTile
            title="Connection"
            value={session.isConnected ? "Live" : "Disconnected"}
            detail={`${totalEvents} events`}
            tone={session.isConnected ? "positive" : "danger"}
            theme={theme}
          />
          <MetricTile
            title="Pending Work"
            value={String(pendingWork)}
            detail={`${queueValue(requestCounts, "pending")} requests | ${queueValue(jobCounts, "pending")} jobs`}
            tone={pendingWork > 0 ? "warning" : "positive"}
            theme={theme}
          />
          <MetricTile
            title="Active Workers"
            value={String(systemSummary.workers?.online ?? workers.filter((w) => w.isOnline).length)}
            detail={`${systemSummary.workers?.busy ?? workers.filter((w) => w.status === "busy").length} busy`}
            theme={theme}
          />
          <MetricTile
            title="Last Sync"
            value={lastRefresh ? relativeMs(lastRefresh) : "--"}
            detail={lastRefresh ? prettyTs(lastRefresh) : "waiting"}
            theme={theme}
          />
        </View>

        <SegmentedTabs tabs={tabs} active={activeTab} onSelect={setActiveTab} theme={theme} />

        <Animated.View
          style={[
            styles.tabFill,
            {
              opacity: tabAnim,
              transform: [{ translateY: tabAnim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
            },
          ]}
        >
          {activeTab === "chat" ? (
            <ChatPane
              theme={theme}
              messages={session.state.messages}
              input={input}
              setInput={setInput}
              onSend={sendMessage}
              onEscalate={escalateToRemote}
              connected={session.isConnected}
              localBuddyThinking={pendingLocalResponses > 0}
            />
          ) : null}
          {activeTab === "requests" ? (
            <RequestsPane
              theme={theme}
              rows={requests}
              counts={requestCounts}
              pendingSnapshot={requestPendingSnapshot}
            />
          ) : null}
          {activeTab === "jobs" ? (
            <JobsPane
              theme={theme}
              isWide={isWide}
              jobs={jobs}
              jobCounts={jobCounts}
              pendingSnapshot={jobPendingSnapshot}
              completions={completions}
              completionCounts={completionCounts}
              sessionState={session.state}
            />
          ) : null}
          {activeTab === "system" ? (
            <SystemPane
              theme={theme}
              events={session.events}
              connected={session.isConnected}
              workers={workers}
              systemSummary={systemSummary}
              lastRefresh={lastRefresh}
            />
          ) : null}
        </Animated.View>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  shell: {
    flex: 1,
    margin: 12,
    borderRadius: 22,
    borderWidth: 1,
    overflow: "hidden",
  },
  backdropBlob: {
    position: "absolute",
    borderRadius: 999,
    transform: [{ scaleX: 1.2 }],
  },
  backdropBlobA: { width: 360, height: 360, top: -120, left: -120 },
  backdropBlobB: { width: 320, height: 320, top: "32%", right: -130 },
  backdropBlobC: { width: 280, height: 280, bottom: -90, left: "20%" },

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

  banner: {
    marginHorizontal: 20,
    marginBottom: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bannerText: { fontSize: 12, fontWeight: "600" },

  metricRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
  metricTile: {
    minWidth: 150,
    flexGrow: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginRight: 8,
    marginBottom: 8,
  },
  metricTitle: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7 },
  metricValue: { fontSize: 22, fontWeight: "700", marginTop: 3 },
  metricDetail: { fontSize: 12, marginTop: 3 },

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

  tabFill: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 18,
  },
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
  escalateButton: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    alignSelf: "flex-start",
  },
  escalateButtonLabel: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.2,
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
  sendButton: {
    height: 44,
    borderRadius: 12,
    paddingHorizontal: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  sendWrap: {
    marginLeft: 8,
    alignItems: "center",
  },
  sendLabel: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 13,
  },
  shortcutHint: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: "600",
  },

  requestCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  requestId: { fontSize: 12, fontWeight: "700" },
  requestPrompt: { fontSize: 14, lineHeight: 20, marginTop: 7 },
  requestSubline: { fontSize: 12, marginTop: 6 },
  requestPhaseLine: { fontSize: 11, marginTop: 6 },
  requestHint: { fontSize: 12, lineHeight: 18, marginTop: 6 },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  statusPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  codeBlock: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
    padding: 8,
  },
  codeBlockLabel: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    marginBottom: 4,
  },
  codeBlockText: {
    fontSize: 12,
    lineHeight: 17,
  },
  jobsLayout: {
    flex: 1,
    flexDirection: "column",
    paddingHorizontal: 20,
    paddingBottom: 14,
  },
  jobsLayoutWide: {
    flexDirection: "row",
  },
  jobsListPane: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
    minHeight: 220,
  },
  jobsTracePane: {
    flex: 1.25,
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    minHeight: 260,
  },
  tracePanelBody: { flex: 1, minHeight: 260 },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 8,
  },
  subSectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 5,
  },
  jobRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    paddingVertical: 8,
  },
  jobDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  jobTextCol: { flex: 1 },
  jobKind: { fontSize: 13, fontWeight: "700" },
  jobMeta: { fontSize: 12, marginTop: 2 },
  jobPhaseLine: { fontSize: 11, marginTop: 4 },
  jobStatus: { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  completionStrip: { marginTop: 8 },
  completionRow: {
    borderTopWidth: 1,
    paddingTop: 8,
    marginTop: 7,
  },
  completionLine: { fontSize: 12, marginBottom: 3 },
  completionMeta: { fontSize: 11, marginBottom: 2 },
  completionStatus: { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },

  systemGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 6,
  },
  systemCard: {
    width: "48%",
    minWidth: 240,
    borderWidth: 1,
    borderRadius: 14,
    padding: 11,
    marginRight: 8,
    marginBottom: 8,
  },
  systemTitle: { fontSize: 14, fontWeight: "700" },
  systemDetail: { fontSize: 12, marginTop: 7 },
  systemMeta: { fontSize: 11, marginTop: 5 },

  workerPanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  workerRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    paddingVertical: 9,
  },
  workerTextCol: { flex: 1 },
  workerName: { fontSize: 13, fontWeight: "700" },
  workerMeta: { fontSize: 12, marginTop: 2 },
  eventPanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  eventRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    paddingVertical: 8,
    gap: 8,
  },
  eventMain: { flex: 1 },
  eventMeta: { fontSize: 11 },
  eventSummary: { fontSize: 13, marginTop: 2, lineHeight: 18 },
});




