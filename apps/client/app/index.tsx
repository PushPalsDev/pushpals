import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { ChatPane } from "../src/components/ChatPane";
import { CoordinationPane } from "../src/components/CoordinationPane";
import { deriveCoordinationRows } from "../src/components/coordinationModel";
import type {
  CoordinationRow,
  DashboardTheme,
  FlowStep,
  ResolvedMode,
} from "../src/components/dashboardTypes";
import { prettyTs, queueValue, relativeMs } from "../src/components/dashboardFormatters";
import { FlowRibbon } from "../src/components/FlowRibbon";
import { JobsPane } from "../src/components/JobsPane";
import { DashboardHeader } from "../src/components/DashboardHeader";
import { DashboardMetrics } from "../src/components/DashboardMetrics";
import type { ThemeModeOption } from "../src/components/ModeSwitcher";
import { RequestsPane } from "../src/components/RequestsPane";
import { SegmentedTabs } from "../src/components/SegmentedTabs";
import { SystemPane } from "../src/components/SystemPane";
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

type UiTab = "coordination" | "chat" | "requests" | "jobs" | "system";

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

export default function DashboardScreen() {
  const session = usePushPalsSession(DEFAULT_BASE);
  const colorScheme = useColorScheme();
  const { width } = useWindowDimensions();

  const [mode, setMode] = useState<ThemeModeOption>("auto");
  const resolvedMode: ResolvedMode =
    mode === "auto" ? ((colorScheme ?? "light") as ResolvedMode) : (mode as ResolvedMode);
  const theme = useMemo(() => createTheme(resolvedMode), [resolvedMode]);

  const [activeTab, setActiveTab] = useState<UiTab>("coordination");
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
  const [jobsFilter, setJobsFilter] = useState<{
    requestId: string | null;
    jobId: string | null;
  }>({ requestId: null, jobId: null });

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

  const sendDirectRemote = useCallback(
    async (text: string) => {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return;
      const command = trimmed.startsWith("/ask_remote_buddy")
        ? trimmed
        : `/ask_remote_buddy ${trimmed}`;
      setInput("");
      setPendingLocalResponses((count) => count + 1);
      try {
        await session.send(command);
      } finally {
        setPendingLocalResponses((count) => Math.max(0, count - 1));
      }
    },
    [session],
  );

  const coordinationRows = useMemo(
    () =>
      deriveCoordinationRows(requests, jobs, completions).sort((a, b) =>
        b.request.updatedAt.localeCompare(a.request.updatedAt),
      ),
    [requests, jobs, completions],
  );

  const reusePromptInComposer = useCallback((prompt: string) => {
    setInput(prompt);
    setActiveTab("chat");
  }, []);

  const openLogsForCoordination = useCallback((row: CoordinationRow) => {
    const preferredJob =
      row.jobs.find((job) => job.status === "claimed") ??
      [...row.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
      null;
    setJobsFilter({
      requestId: row.request.id,
      jobId: preferredJob?.id ?? null,
    });
    setActiveTab("jobs");
  }, []);

  const lastClientMessageTs = useMemo(() => {
    const latest = [...session.state.messages]
      .reverse()
      .find((message) => (message.from ?? "").toLowerCase().includes("client"));
    return latest?.ts;
  }, [session.state.messages]);
  const lastLocalBuddyTs = useMemo(() => {
    const latest = [...session.state.messages]
      .reverse()
      .find((message) => (message.from ?? "").toLowerCase().includes("localbuddy"));
    return latest?.ts;
  }, [session.state.messages]);

  const flowSteps = useMemo<FlowStep[]>(
    () => [
      {
        key: "user",
        label: "1. You",
        detail: lastClientMessageTs
          ? `Last ask ${relativeMs(lastClientMessageTs)}`
          : "Awaiting input",
        tone: lastClientMessageTs ? "accent" : "warning",
      },
      {
        key: "local",
        label: "2. LocalBuddy",
        detail:
          pendingLocalResponses > 0
            ? "Drafting or routing request"
            : lastLocalBuddyTs
              ? `Last reply ${relativeMs(lastLocalBuddyTs)}`
              : "Idle",
        tone: pendingLocalResponses > 0 ? "warning" : lastLocalBuddyTs ? "positive" : "accent",
      },
      {
        key: "remote",
        label: "3. RemoteBuddy",
        detail: `${queueValue(requestCounts, "pending")} pending, ${queueValue(requestCounts, "claimed")} claimed`,
        tone:
          queueValue(requestCounts, "claimed") > 0
            ? "warning"
            : queueValue(requestCounts, "pending") > 0
              ? "accent"
              : "positive",
      },
      {
        key: "worker",
        label: "4. WorkerPals",
        detail: `${queueValue(jobCounts, "claimed")} running, ${queueValue(jobCounts, "pending")} queued`,
        tone:
          queueValue(jobCounts, "claimed") > 0
            ? "warning"
            : queueValue(jobCounts, "failed") > 0
              ? "danger"
              : "positive",
      },
      {
        key: "scm",
        label: "5. SCM",
        detail: `${queueValue(completionCounts, "processed")} ready, ${queueValue(completionCounts, "pending")} pending`,
        tone:
          queueValue(completionCounts, "failed") > 0
            ? "danger"
            : queueValue(completionCounts, "processed") > 0
              ? "positive"
              : "accent",
      },
    ],
    [
      lastClientMessageTs,
      pendingLocalResponses,
      lastLocalBuddyTs,
      requestCounts,
      jobCounts,
      completionCounts,
    ],
  );

  const tabs = useMemo(
    () => [
      { id: "coordination" as const, label: "Coordination", count: coordinationRows.length },
      { id: "chat" as const, label: "Chat", count: session.state.messages.length },
      { id: "requests" as const, label: "Requests", count: requests.length },
      { id: "jobs" as const, label: "Jobs & Traces", count: session.state.jobs.size },
      { id: "system" as const, label: "System", count: workers.length },
    ],
    [
      coordinationRows.length,
      session.state.messages.length,
      requests.length,
      session.state.jobs.size,
      workers.length,
    ],
  );

  const totalEvents = session.events.length;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View
        style={[
          styles.backdropBlob,
          styles.backdropBlobA,
          { backgroundColor: `${theme.accent}20` },
        ]}
      />
      <View
        style={[
          styles.backdropBlob,
          styles.backdropBlobB,
          { backgroundColor: `${theme.warning}16` },
        ]}
      />
      <View
        style={[
          styles.backdropBlob,
          styles.backdropBlobC,
          { backgroundColor: `${theme.positive}18` },
        ]}
      />

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
        <DashboardHeader
          theme={theme}
          mode={mode}
          repo={systemSummary.repo}
          onChangeMode={setMode}
        />

        {session.error ? (
          <View
            style={[
              styles.banner,
              { backgroundColor: `${theme.danger}22`, borderColor: `${theme.danger}55` },
            ]}
          >
            <Text style={[styles.bannerText, { color: theme.danger, fontFamily: theme.fontSans }]}>
              {session.error}
            </Text>
          </View>
        ) : null}

        <FlowRibbon theme={theme} steps={flowSteps} />

        <DashboardMetrics
          theme={theme}
          connected={session.isConnected}
          totalEvents={totalEvents}
          pendingRequests={queueValue(requestCounts, "pending")}
          pendingJobs={queueValue(jobCounts, "pending")}
          onlineWorkers={systemSummary.workers?.online ?? workers.filter((w) => w.isOnline).length}
          busyWorkers={
            systemSummary.workers?.busy ?? workers.filter((w) => w.status === "busy").length
          }
          lastRefresh={lastRefresh}
          formatRelativeTime={relativeMs}
          formatAbsoluteTime={prettyTs}
        />

        <SegmentedTabs tabs={tabs} active={activeTab} onSelect={setActiveTab} theme={theme} />

        <Animated.View
          style={[
            styles.tabFill,
            {
              opacity: tabAnim,
              transform: [
                { translateY: tabAnim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
              ],
            },
          ]}
        >
          {activeTab === "coordination" ? (
            <CoordinationPane
              theme={theme}
              isWide={isWide}
              rows={coordinationRows}
              requestCounts={requestCounts}
              jobCounts={jobCounts}
              completionCounts={completionCounts}
              onReusePrompt={reusePromptInComposer}
              onOpenLogs={openLogsForCoordination}
            />
          ) : null}
          {activeTab === "chat" ? (
            <ChatPane
              theme={theme}
              messages={session.state.messages}
              input={input}
              setInput={setInput}
              onSend={sendMessage}
              onSendRemote={sendDirectRemote}
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
              requestFilterId={jobsFilter.requestId}
              jobFilterId={jobsFilter.jobId}
              onClearFilter={() => setJobsFilter({ requestId: null, jobId: null })}
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
  banner: {
    marginHorizontal: 20,
    marginBottom: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bannerText: { fontSize: 12, fontWeight: "600" },
  tabFill: { flex: 1 },
});
