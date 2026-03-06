import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type {
  ActOnAutonomyQuestionResult,
  AutonomyInsightsSummary,
  AutonomyQuestionRow,
  AnswerAutonomyQuestionResult,
  SystemStatusSummary,
  WorkerStatusRow,
} from "../lib/pushpalsApi";
import type { DashboardTheme } from "./dashboardTypes";
import {
  clip,
  formatDuration,
  formatPercent,
  prettyTs,
  queueValue,
  relativeMs,
  statusColor,
} from "./dashboardFormatters";
import { MetricTile } from "./MetricTile";

type SessionEvent = {
  id: string;
  ts: string;
  type: string;
  from?: string;
  payload?: Record<string, unknown>;
};

function summarizeEvent(event: SessionEvent): string {
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

function serializeUnknown(value: unknown, maxChars = 320): string {
  if (value == null) return "";
  if (typeof value === "string") return clip(value, maxChars);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return clip(JSON.stringify(value), maxChars);
  } catch {
    return clip(String(value), maxChars);
  }
}

function initialDraftForQuestion(question: AutonomyQuestionRow): string {
  const schema = question.expectedAnswerSchema ?? {};
  if (question.questionType === "single_choice") {
    const choices = Array.isArray(schema.choices) ? schema.choices : [];
    const first = choices.find((entry) => typeof entry === "string" && entry.trim());
    return typeof first === "string" ? first : "";
  }
  if (question.questionType === "multi_choice") {
    const choices = Array.isArray(schema.choices) ? schema.choices : [];
    const first = choices.find((entry) => typeof entry === "string" && entry.trim());
    return typeof first === "string" ? JSON.stringify([first]) : "[]";
  }
  if (question.questionType === "json_payload") {
    const required = Array.isArray(schema.required_keys) ? schema.required_keys : [];
    const payload: Record<string, string> = {};
    for (const key of required) {
      if (typeof key !== "string" || !key.trim()) continue;
      payload[key] = "";
    }
    return Object.keys(payload).length > 0 ? JSON.stringify(payload, null, 2) : "{}";
  }
  return "";
}

export function SystemPane({
  theme,
  events,
  connected,
  workers,
  systemSummary,
  autonomyInsights,
  autonomyQuestions,
  autonomyAnswerResults,
  autonomyAnswerInFlight,
  onSubmitAutonomyAnswer,
  autonomyActionResults,
  autonomyActionInFlight,
  onApplyAutonomyQuestionAction,
  autonomySafetyInFlight,
  onUpdateAutonomySafety,
  lastRefresh,
}: {
  theme: DashboardTheme;
  events: SessionEvent[];
  connected: boolean;
  workers: WorkerStatusRow[];
  systemSummary: SystemStatusSummary;
  autonomyInsights: AutonomyInsightsSummary;
  autonomyQuestions: AutonomyQuestionRow[];
  autonomyAnswerResults: Record<string, AnswerAutonomyQuestionResult>;
  autonomyAnswerInFlight: Record<string, boolean>;
  onSubmitAutonomyAnswer: (
    question: Pick<AutonomyQuestionRow, "id" | "sessionId">,
    answerText: string,
  ) => Promise<AnswerAutonomyQuestionResult>;
  autonomyActionResults: Record<string, ActOnAutonomyQuestionResult>;
  autonomyActionInFlight: Record<string, boolean>;
  onApplyAutonomyQuestionAction: (
    question: Pick<AutonomyQuestionRow, "id" | "sessionId">,
    action: "skip" | "close" | "escalate",
    note?: string,
  ) => Promise<ActOnAutonomyQuestionResult>;
  autonomySafetyInFlight: boolean;
  onUpdateAutonomySafety: (update: {
    killSwitchEnabled?: boolean;
    freezeForMs?: number;
    freezeUntil?: string;
    freezeReason?: string;
    unfreeze?: boolean;
  }) => Promise<{ ok: boolean; reason?: string }>;
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

  const latestEventByComponent = useMemo(() => {
    const byName: Record<string, string | undefined> = {
      LocalBuddy: undefined,
      RemoteBuddy: undefined,
      WorkerPals: undefined,
      SourceControlManager: undefined,
    };

    const hasAny = (value: string, needles: string[]): boolean =>
      needles.some((needle) => value.includes(needle));

    for (const event of events) {
      const from = (event.from ?? "").toLowerCase();
      const payload = event.payload as Record<string, unknown>;
      const payloadAgentId =
        typeof payload?.agentId === "string" ? (payload.agentId as string).toLowerCase() : "";
      const signal = `${from} ${payloadAgentId}`;

      if (hasAny(signal, ["localbuddy", "local_buddy", "local buddy"]))
        byName.LocalBuddy = event.ts;
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
  }, [events]);

  const onlineWorkers = workers.filter((worker) => worker.isOnline).length;
  const recentEvents = useMemo(() => events.slice(-40).reverse(), [events]);
  const requestSlo = systemSummary.slo?.requests;
  const jobSlo = systemSummary.slo?.jobs;
  const autonomyOps = systemSummary.autonomy ?? autonomyInsights.opsSummary;
  const safety = autonomyOps?.safetyState ?? null;
  const evaluator = autonomyOps?.latestEvaluatorScorecard ?? autonomyInsights.latestEvaluatorScorecard;
  const recentAlerts = autonomyOps?.recentAlerts ?? [];
  const trustedSources = autonomyInsights.trustedInspirationShortlist.slice(0, 6);
  const archivedSources = autonomyInsights.archivedInspirationSources.slice(0, 4);
  const watchlistCount = autonomyInsights.engineSourceStats.filter(
    (row) => row.curationStatus === "watchlist",
  ).length;
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const actionableQuestionCount = autonomyQuestions.filter(
    (question) => question.status === "open" || question.status === "invalid",
  ).length;
  const invalidQuestionCount = autonomyQuestions.filter(
    (question) => question.status === "invalid",
  ).length;
  const visibleQuestions = useMemo(
    () =>
      [...autonomyQuestions]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20),
    [autonomyQuestions],
  );

  useEffect(() => {
    setQuestionDrafts((prev) => {
      const next: Record<string, string> = {};
      for (const question of autonomyQuestions) {
        if (typeof prev[question.id] === "string") {
          next[question.id] = prev[question.id];
          continue;
        }
        if (question.status === "invalid" && question.answer != null) {
          next[question.id] = serializeUnknown(question.answer, 2000);
          continue;
        }
        if (question.status === "open") next[question.id] = initialDraftForQuestion(question);
      }
      return next;
    });
  }, [autonomyQuestions]);

  const submitQuestionAnswer = useCallback(
    async (question: AutonomyQuestionRow) => {
      const draft = questionDrafts[question.id] ?? "";
      const result = await onSubmitAutonomyAnswer(
        { id: question.id, sessionId: question.sessionId },
        draft,
      );
      if (result.ok && result.status === "valid") {
        setQuestionDrafts((prev) => ({ ...prev, [question.id]: "" }));
      }
    },
    [onSubmitAutonomyAnswer, questionDrafts],
  );

  const applyQuestionAction = useCallback(
    async (question: AutonomyQuestionRow, action: "skip" | "close" | "escalate") => {
      const note = (questionDrafts[question.id] ?? "").trim();
      await onApplyAutonomyQuestionAction(
        { id: question.id, sessionId: question.sessionId },
        action,
        note || undefined,
      );
      if (action !== "escalate") {
        setQuestionDrafts((prev) => ({ ...prev, [question.id]: "" }));
      }
    },
    [onApplyAutonomyQuestionAction, questionDrafts],
  );

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
    <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
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
          title="Trusted Sources"
          value={String(autonomyInsights.trustedInspirationShortlist.length)}
          detail={`watchlist ${watchlistCount} | archived ${autonomyInsights.archivedInspirationSources.length}`}
          tone="positive"
          theme={theme}
        />
        <MetricTile
          title="Actionable Questions"
          value={String(actionableQuestionCount)}
          detail={`invalid ${invalidQuestionCount} | tracked ${autonomyQuestions.length}`}
          tone={actionableQuestionCount > 0 ? "warning" : "positive"}
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

      <View
        style={[styles.safetyPanel, { borderColor: theme.border, backgroundColor: theme.panel }]}
      >
        <View style={styles.rowBetween}>
          <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
            Autonomy Safety Controls
          </Text>
          <Text style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
            alerts {recentAlerts.length}
          </Text>
        </View>
        <Text style={[styles.systemDetail, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
          kill switch {safety?.killSwitchEnabled ? "enabled" : "disabled"} | frozen{" "}
          {safety?.isFrozen ? "yes" : "no"}
          {safety?.freezeUntil ? ` until ${prettyTs(safety.freezeUntil)}` : ""}
        </Text>
        {safety?.freezeReason ? (
          <Text style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
            freeze reason: {safety.freezeReason}
          </Text>
        ) : null}
        <Text style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
          evaluator {evaluator?.recommendation ?? "unknown"} | success{" "}
          {typeof evaluator?.successRate === "number" ? `${(evaluator.successRate * 100).toFixed(1)}%` : "--"} |
          regret{" "}
          {typeof evaluator?.regretRate === "number" ? `${(evaluator.regretRate * 100).toFixed(1)}%` : "--"} | samples{" "}
          {evaluator?.sampleCount ?? 0}
        </Text>
        <View style={styles.safetyActionsRow}>
          <Pressable
            style={[
              styles.answerButton,
              {
                borderColor: theme.border,
                backgroundColor: autonomySafetyInFlight ? theme.panelAlt : safety?.killSwitchEnabled ? `${theme.warning}33` : theme.accentSoft,
                opacity: autonomySafetyInFlight ? 0.7 : 1,
              },
            ]}
            disabled={autonomySafetyInFlight}
            onPress={() => {
              void onUpdateAutonomySafety({
                killSwitchEnabled: !Boolean(safety?.killSwitchEnabled),
              });
            }}
          >
            <Text style={[styles.answerButtonText, { color: theme.accentText, fontFamily: theme.fontSans }]}>
              {safety?.killSwitchEnabled ? "Disable Kill Switch" : "Enable Kill Switch"}
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.answerButton,
              {
                borderColor: theme.border,
                backgroundColor: autonomySafetyInFlight ? theme.panelAlt : safety?.isFrozen ? `${theme.positive}22` : `${theme.warning}22`,
                opacity: autonomySafetyInFlight ? 0.7 : 1,
              },
            ]}
            disabled={autonomySafetyInFlight}
            onPress={() => {
              void onUpdateAutonomySafety(
                safety?.isFrozen
                  ? { unfreeze: true }
                  : { freezeForMs: 30 * 60 * 1000, freezeReason: "manual_freeze_ui" },
              );
            }}
          >
            <Text style={[styles.answerButtonText, { color: theme.accentText, fontFamily: theme.fontSans }]}>
              {safety?.isFrozen ? "Unfreeze" : "Freeze 30m"}
            </Text>
          </Pressable>
        </View>
        {recentAlerts.slice(0, 3).map((alert) => (
          <Text
            key={alert.id}
            style={[
              styles.systemMeta,
              {
                color:
                  alert.severity === "critical"
                    ? theme.danger
                    : alert.severity === "warning"
                      ? theme.warning
                      : theme.textMuted,
                fontFamily: theme.fontSans,
              },
            ]}
          >
            {prettyTs(alert.createdAt)} | {alert.alertType}: {clip(alert.message, 180)}
          </Text>
        ))}
      </View>

      <View style={styles.systemGrid}>
        {componentRows.map((row) => {
          const color = statusColor(theme, row.status);
          return (
            <View
              key={row.name}
              style={[
                styles.systemCard,
                { borderColor: theme.border, backgroundColor: theme.panel },
              ]}
            >
              <View style={styles.rowBetween}>
                <Text
                  style={[styles.systemTitle, { color: theme.text, fontFamily: theme.fontSans }]}
                >
                  {row.name}
                </Text>
                <View
                  style={[
                    styles.statusPill,
                    {
                      backgroundColor: `${color}22`,
                      borderColor: `${color}66`,
                    },
                  ]}
                >
                  <Text style={[styles.statusPillText, { color, fontFamily: theme.fontSans }]}>
                    {row.status}
                  </Text>
                </View>
              </View>
              <Text
                style={[
                  styles.systemDetail,
                  { color: theme.textMuted, fontFamily: theme.fontSans },
                ]}
              >
                {row.detail}
              </Text>
              <Text
                style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}
              >
                {row.ts ? `updated ${prettyTs(row.ts)}` : "no timestamp"}
              </Text>
            </View>
          );
        })}
      </View>

      <View
        style={[styles.insightPanel, { borderColor: theme.border, backgroundColor: theme.panel }]}
      >
        <View style={styles.rowBetween}>
          <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
            Autonomy Source Curation
          </Text>
          <Text style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
            {autonomyInsights.engineSourceStats.length} tracked
          </Text>
        </View>
        <View style={styles.insightColumns}>
          <View style={styles.insightCol}>
            <Text style={[styles.insightSectionTitle, { color: theme.positive, fontFamily: theme.fontSans }]}>
              Trusted Shortlist
            </Text>
            {trustedSources.length === 0 ? (
              <Text style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                No trusted sources yet.
              </Text>
            ) : (
              trustedSources.map((row) => (
                <View key={`trusted-${row.sourceKey}`} style={[styles.insightRow, { borderColor: theme.border }]}>
                  <Text style={[styles.insightLabel, { color: theme.text, fontFamily: theme.fontSans }]}>
                    {row.sourceLabel || row.algorithm}
                  </Text>
                  <Text style={[styles.insightMeta, { color: theme.textMuted, fontFamily: theme.fontMono }]}>
                    trust {row.trustScore.toFixed(2)} | fresh {row.freshnessScore.toFixed(2)} | samples{" "}
                    {row.sampleCount}
                  </Text>
                  {row.curationReason ? (
                    <Text style={[styles.insightReason, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                      {row.curationReason}
                    </Text>
                  ) : null}
                </View>
              ))
            )}
          </View>
          <View style={styles.insightCol}>
            <Text style={[styles.insightSectionTitle, { color: theme.warning, fontFamily: theme.fontSans }]}>
              Archived Sources
            </Text>
            {archivedSources.length === 0 ? (
              <Text style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                No archived sources.
              </Text>
            ) : (
              archivedSources.map((row) => (
                <View key={`archived-${row.sourceKey}`} style={[styles.insightRow, { borderColor: theme.border }]}>
                  <Text style={[styles.insightLabel, { color: theme.text, fontFamily: theme.fontSans }]}>
                    {row.sourceLabel || row.algorithm}
                  </Text>
                  <Text style={[styles.insightMeta, { color: theme.textMuted, fontFamily: theme.fontMono }]}>
                    trust {row.trustScore.toFixed(2)} | fresh {row.freshnessScore.toFixed(2)} | samples{" "}
                    {row.sampleCount}
                  </Text>
                  {row.curationReason ? (
                    <Text style={[styles.insightReason, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
                      {row.curationReason}
                    </Text>
                  ) : null}
                </View>
              ))
            )}
          </View>
        </View>
      </View>

      <View
        style={[styles.questionPanel, { borderColor: theme.border, backgroundColor: theme.panel }]}
      >
        <View style={styles.rowBetween}>
          <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
            Autonomy Questions
          </Text>
          <Text style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
            {actionableQuestionCount} actionable / {autonomyQuestions.length} total
          </Text>
        </View>
        {visibleQuestions.length === 0 ? (
          <Text style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
            No autonomy questions available yet.
          </Text>
        ) : (
          visibleQuestions.map((question) => {
            const isActionable = question.status === "open" || question.status === "invalid";
            const statusTone =
              question.status === "answered"
                ? theme.positive
                : question.status === "invalid"
                  ? theme.warning
                  : question.status === "closed"
                    ? theme.textMuted
                    : theme.accent;
            const result = autonomyAnswerResults[question.id];
            const submitting = Boolean(autonomyAnswerInFlight[question.id]);
            const actionResult = autonomyActionResults[question.id];
            const actionBusy = Boolean(autonomyActionInFlight[question.id]);
            const schemaText = serializeUnknown(question.expectedAnswerSchema, 260);
            const contextText = serializeUnknown(question.context, 260);
            const answerText = serializeUnknown(question.answer, 260);
            const expiresInMs =
              typeof question.expiresInMs === "number" && Number.isFinite(question.expiresInMs)
                ? question.expiresInMs
                : (() => {
                    const ms = Date.parse(question.expiresAt);
                    if (!Number.isFinite(ms)) return null;
                    return Math.max(0, ms - Date.now());
                  })();
            const isExpired = Boolean(question.isExpired) || (typeof expiresInMs === "number" && expiresInMs <= 0);
            const expiringSoon = !isExpired && typeof expiresInMs === "number" && expiresInMs <= 15 * 60 * 1000;
            const expiryTone = isExpired ? theme.danger : expiringSoon ? theme.warning : theme.textMuted;
            return (
              <View key={question.id} style={[styles.questionRow, { borderColor: theme.border }]}>
                <View style={styles.rowBetween}>
                  <Text
                    style={[styles.questionTitle, { color: theme.text, fontFamily: theme.fontSans }]}
                  >
                    {question.question || "Untitled question"}
                  </Text>
                  <View
                    style={[
                      styles.statusPill,
                      {
                        backgroundColor: `${statusTone}22`,
                        borderColor: `${statusTone}66`,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.statusPillText, { color: statusTone, fontFamily: theme.fontSans }]}
                    >
                      {question.status}
                    </Text>
                  </View>
                </View>
                <Text
                  style={[styles.questionMeta, { color: theme.textMuted, fontFamily: theme.fontMono }]}
                >
                  {question.id.slice(0, 8)} | type {question.questionType || "unknown"} | objective{" "}
                  {question.objectiveId.slice(0, 8) || "--"}
                </Text>
                <Text
                  style={[styles.questionMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}
                >
                  created {prettyTs(question.createdAt)} | expires{" "}
                  {question.expiresAt ? prettyTs(question.expiresAt) : "--"}
                </Text>
                <Text
                  style={[styles.questionMeta, { color: expiryTone, fontFamily: theme.fontSans }]}
                >
                  {isExpired
                    ? "expired"
                    : expiringSoon
                      ? `expires soon (${formatDuration(expiresInMs)})`
                      : typeof expiresInMs === "number"
                        ? `expires in ${formatDuration(expiresInMs)}`
                        : "expiry unknown"}
                </Text>
                {schemaText ? (
                  <Text
                    style={[
                      styles.questionDetail,
                      { color: theme.textMuted, fontFamily: theme.fontSans },
                    ]}
                  >
                    expected: {schemaText}
                  </Text>
                ) : null}
                {contextText && contextText !== "{}" ? (
                  <Text
                    style={[
                      styles.questionDetail,
                      { color: theme.textMuted, fontFamily: theme.fontSans },
                    ]}
                  >
                    context: {contextText}
                  </Text>
                ) : null}
                {question.validationError ? (
                  <Text
                    style={[
                      styles.questionValidation,
                      { color: theme.warning, fontFamily: theme.fontSans },
                    ]}
                  >
                    validation: {question.validationError}
                  </Text>
                ) : null}
                {answerText ? (
                  <Text
                    style={[
                      styles.questionDetail,
                      { color: theme.textMuted, fontFamily: theme.fontSans },
                    ]}
                  >
                    answer: {answerText}
                  </Text>
                ) : null}

                {isActionable ? (
                  <View style={styles.questionActionRow}>
                    <TextInput
                      style={[
                        styles.questionInput,
                        {
                          borderColor: theme.border,
                          backgroundColor: theme.panelAlt,
                          color: theme.text,
                          fontFamily: theme.fontMono,
                        },
                      ]}
                      multiline
                      placeholder="Answer as plain text or JSON"
                      placeholderTextColor={theme.textMuted}
                      value={questionDrafts[question.id] ?? ""}
                      onChangeText={(value) =>
                        setQuestionDrafts((prev) => ({ ...prev, [question.id]: value }))
                      }
                    />
                    <Pressable
                      style={[
                        styles.answerButton,
                        {
                          borderColor: theme.border,
                          backgroundColor: submitting ? theme.panelAlt : theme.accentSoft,
                          opacity: submitting ? 0.7 : 1,
                        },
                      ]}
                      disabled={submitting}
                      onPress={() => {
                        void submitQuestionAnswer(question);
                      }}
                    >
                      <Text
                        style={[
                          styles.answerButtonText,
                          { color: theme.accentText, fontFamily: theme.fontSans },
                        ]}
                      >
                        {submitting ? "Submitting..." : "Submit Answer"}
                      </Text>
                    </Pressable>
                    <View style={styles.questionSecondaryActions}>
                      <Pressable
                        style={[
                          styles.miniActionButton,
                          {
                            borderColor: theme.border,
                            backgroundColor: actionBusy ? theme.panelAlt : `${theme.warning}22`,
                            opacity: actionBusy ? 0.7 : 1,
                          },
                        ]}
                        disabled={actionBusy}
                        onPress={() => {
                          void applyQuestionAction(question, "skip");
                        }}
                      >
                        <Text style={[styles.miniActionText, { color: theme.warning, fontFamily: theme.fontSans }]}>
                          Skip
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[
                          styles.miniActionButton,
                          {
                            borderColor: theme.border,
                            backgroundColor: actionBusy ? theme.panelAlt : `${theme.textMuted}22`,
                            opacity: actionBusy ? 0.7 : 1,
                          },
                        ]}
                        disabled={actionBusy}
                        onPress={() => {
                          void applyQuestionAction(question, "close");
                        }}
                      >
                        <Text
                          style={[styles.miniActionText, { color: theme.textMuted, fontFamily: theme.fontSans }]}
                        >
                          Close
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[
                          styles.miniActionButton,
                          {
                            borderColor: theme.border,
                            backgroundColor: actionBusy ? theme.panelAlt : `${theme.danger}22`,
                            opacity: actionBusy ? 0.7 : 1,
                          },
                        ]}
                        disabled={actionBusy}
                        onPress={() => {
                          void applyQuestionAction(question, "escalate");
                        }}
                      >
                        <Text style={[styles.miniActionText, { color: theme.danger, fontFamily: theme.fontSans }]}>
                          Escalate
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}

                {result ? (
                  <View
                    style={[
                      styles.answerResult,
                      {
                        borderColor: theme.border,
                        backgroundColor: result.ok
                          ? result.status === "invalid"
                            ? `${theme.warning}22`
                            : `${theme.positive}22`
                          : `${theme.danger}22`,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.answerResultLine,
                        { color: result.ok ? theme.text : theme.danger, fontFamily: theme.fontSans },
                      ]}
                    >
                      {result.ok
                        ? `answer ${result.status ?? "accepted"}`
                        : `answer failed: ${result.reason ?? "unknown error"}`}
                    </Text>
                    {result.reason && result.ok ? (
                      <Text
                        style={[
                          styles.answerResultLine,
                          { color: theme.textMuted, fontFamily: theme.fontSans },
                        ]}
                      >
                        {result.reason}
                      </Text>
                    ) : null}
                    {result.resumedRequestId ? (
                      <Text
                        style={[
                          styles.answerResultLine,
                          { color: theme.textMuted, fontFamily: theme.fontMono },
                        ]}
                      >
                        resumed request {result.resumedRequestId}
                      </Text>
                    ) : null}
                    {result.resumeError ? (
                      <Text
                        style={[
                          styles.answerResultLine,
                          { color: theme.danger, fontFamily: theme.fontSans },
                        ]}
                      >
                        resume error: {result.resumeError}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
                {actionResult ? (
                  <View
                    style={[
                      styles.answerResult,
                      {
                        borderColor: theme.border,
                        backgroundColor: actionResult.ok ? `${theme.positive}22` : `${theme.danger}22`,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.answerResultLine,
                        { color: actionResult.ok ? theme.text : theme.danger, fontFamily: theme.fontSans },
                      ]}
                    >
                      {actionResult.ok
                        ? `action ${actionResult.action ?? "applied"}`
                        : `action failed: ${actionResult.reason ?? "unknown error"}`}
                    </Text>
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </View>

      <View
        style={[styles.workerPanel, { borderColor: theme.border, backgroundColor: theme.panel }]}
      >
        <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
          Worker Fleet
        </Text>
        {workers.length === 0 ? (
          <Text
            style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}
          >
            No workers reported yet.
          </Text>
        ) : (
          workers.map((worker) => {
            const color = statusColor(theme, worker.status);
            return (
              <View key={worker.workerId} style={[styles.workerRow, { borderColor: theme.border }]}>
                <View style={[styles.jobDot, { backgroundColor: color }]} />
                <View style={styles.workerTextCol}>
                  <Text
                    style={[styles.workerName, { color: theme.text, fontFamily: theme.fontSans }]}
                  >
                    {worker.workerId}
                  </Text>
                  <Text
                    style={[
                      styles.workerMeta,
                      { color: theme.textMuted, fontFamily: theme.fontSans },
                    ]}
                  >
                    {worker.status} | job {worker.currentJobId?.slice(0, 8) ?? "--"} | heartbeat{" "}
                    {relativeMs(worker.lastHeartbeat)}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </View>

      <View
        style={[styles.eventPanel, { borderColor: theme.border, backgroundColor: theme.panel }]}
      >
        <View style={styles.rowBetween}>
          <Text style={[styles.sectionTitle, { color: theme.text, fontFamily: theme.fontSans }]}>
            Recent Event Stream
          </Text>
          <Text style={[styles.systemMeta, { color: theme.textMuted, fontFamily: theme.fontSans }]}>
            {recentEvents.length} latest
          </Text>
        </View>
        {recentEvents.length === 0 ? (
          <Text
            style={[styles.emptySubtitle, { color: theme.textMuted, fontFamily: theme.fontSans }]}
          >
            No events yet.
          </Text>
        ) : (
          recentEvents.map((event) => {
            const color = statusColor(theme, event.type);
            return (
              <View key={event.id} style={[styles.eventRow, { borderColor: theme.border }]}>
                <View style={styles.eventMain}>
                  <Text
                    style={[
                      styles.eventMeta,
                      { color: theme.textMuted, fontFamily: theme.fontMono },
                    ]}
                  >
                    {prettyTs(event.ts)} | {event.from ?? "unknown"}
                  </Text>
                  <Text
                    style={[styles.eventSummary, { color: theme.text, fontFamily: theme.fontSans }]}
                  >
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
                  <Text style={[styles.statusPillText, { color, fontFamily: theme.fontSans }]}>
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 18,
  },
  metricRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingBottom: 10,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 8,
  },
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
  emptySubtitle: { fontSize: 13, lineHeight: 19 },
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
  insightPanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  safetyPanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  questionPanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  insightColumns: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  insightCol: {
    flex: 1,
    minWidth: 280,
  },
  insightSectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 6,
  },
  insightRow: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  insightLabel: {
    fontSize: 13,
    fontWeight: "700",
  },
  insightMeta: {
    fontSize: 11,
    marginTop: 3,
  },
  insightReason: {
    fontSize: 12,
    marginTop: 5,
    lineHeight: 17,
  },
  questionRow: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginBottom: 8,
  },
  questionTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
    marginRight: 8,
  },
  questionMeta: {
    fontSize: 11,
    marginTop: 3,
  },
  questionDetail: {
    fontSize: 12,
    marginTop: 4,
    lineHeight: 17,
  },
  questionValidation: {
    fontSize: 12,
    marginTop: 4,
    lineHeight: 17,
    fontWeight: "600",
  },
  questionActionRow: {
    marginTop: 7,
  },
  questionSecondaryActions: {
    marginTop: 7,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  questionInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 70,
    textAlignVertical: "top",
    fontSize: 12,
  },
  answerButton: {
    marginTop: 7,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  answerButtonText: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  miniActionButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  miniActionText: {
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  safetyActionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  answerResult: {
    marginTop: 7,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  answerResultLine: {
    fontSize: 11,
    lineHeight: 16,
  },
  workerRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    paddingVertical: 9,
  },
  jobDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
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
