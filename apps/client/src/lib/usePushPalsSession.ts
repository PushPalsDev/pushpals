import { useEffect, useState, useCallback, useRef, useMemo, useReducer } from "react";
import type { EventEnvelope, EventType } from "protocol/browser";
import { CompanionModel, RemoteCompanionModel } from "./companion";
import {
  subscribeEvents,
  createSession,
  sendMessage,
  submitApprovalDecision,
  sendCommand,
} from "./pushpalsApi";
import {
  eventReducer,
  initialState,
  type SessionState,
  type Task,
  type Job,
  type LogLine,
  type ChatMessage,
} from "./eventReducer";
import { getItem, setItem } from "./storage";

// Metro compile-time replaces EXPO_PUBLIC_* — falls back to "dev" so all apps
// share the same session out of the box with zero config.
const DEFAULT_SESSION_ID = process.env.EXPO_PUBLIC_PUSHPALS_SESSION_ID ?? "dev";

// Local Agent URL for sending messages (new architecture)
const LOCAL_AGENT_URL = process.env.EXPO_PUBLIC_LOCAL_AGENT_URL ?? "http://localhost:3003";

// ─── Extended event type that may include local errors ──────────────────────
export type SessionEvent = EventEnvelope | { type: "_error"; message: string };

export function isEnvelope(e: SessionEvent): e is EventEnvelope {
  return (e as any).id !== undefined;
}

// ─── Re-export reducer types for consumers ──────────────────────────────────
export type { Task, Job, LogLine, ChatMessage, SessionState };

// ─── Task grouping (legacy compat, now derived from reducer) ────────────────
export interface TaskGroup {
  taskId: string;
  title: string;
  status: "created" | "started" | "in_progress" | "completed" | "failed";
  events: EventEnvelope[];
}

// ─── Filter state ───────────────────────────────────────────────────────────
export interface EventFilters {
  agentFrom?: string;
  taskId?: string;
  eventTypes?: EventType[];
  turnId?: string;
}

export interface PushPalsSession {
  sessionId: string | null;
  events: SessionEvent[];
  isConnected: boolean;
  error: string | null;
}

export interface PushPalsSessionActions {
  sessionId: string | null;
  events: SessionEvent[];
  filteredEvents: SessionEvent[];
  isConnected: boolean;
  error: string | null;

  // Actions
  send: (text: string) => Promise<boolean>;
  approve: (approvalId: string) => Promise<boolean>;
  deny: (approvalId: string) => Promise<boolean>;

  // Computed (legacy)
  tasks: TaskGroup[];
  agents: string[];
  turnIds: string[];

  // Filter
  filters: EventFilters;
  setFilters: (f: EventFilters) => void;

  // PR4: structured state from reducer
  state: SessionState;
}

// ─── Cursor persistence helpers (web: localStorage, native: AsyncStorage) ───
async function loadCursor(sessionId: string): Promise<number> {
  const raw = await getItem(`pushpals:cursor:${sessionId}`);
  return raw ? Number(raw) || 0 : 0;
}

/**
 * Hook to manage a PushPals session with grouping, filtering, and approval actions.
 * Uses an event reducer for structured state (tasks, jobs, logs) and persists the
 * last cursor so reconnections replay only new events.
 */
export function usePushPalsSession(
  baseUrl: string = "http://localhost:3001",
): PushPalsSessionActions {
  const [session, setSession] = useState<PushPalsSession>({
    sessionId: null,
    events: [],
    isConnected: false,
    error: null,
  });

  const [state, dispatch] = useReducer(eventReducer, initialState());

  const [filters, setFilters] = useState<EventFilters>({});

  const unsubscribeRef = useRef<(() => void) | null>(null);
  /** In-memory max-wins guard — authoritative during runtime, avoids async read races */
  const persistedCursorRef = useRef(0);

  // Initialize session on mount
  useEffect(() => {
    const init = async () => {
      try {
        const sessionId = await createSession(baseUrl, DEFAULT_SESSION_ID);
        if (!sessionId) {
          setSession((s) => ({
            ...s,
            error: "Failed to create session",
          }));
          return;
        }

        setSession((s) => ({
          ...s,
          sessionId,
          isConnected: true,
        }));

        // Restore cursor for reconnect / replay
        const afterCursor = await loadCursor(sessionId);
        persistedCursorRef.current = afterCursor;

        // Subscribe to events with cursor-aware callback
        const unsubscribe = subscribeEvents(
          baseUrl,
          sessionId,
          (event, cursor) => {
            // Feed legacy flat event list
            setSession((s) => ({
              ...s,
              events: [...s.events, event],
            }));

            // Feed structured reducer (skip error sentinels)
            if ("id" in event) {
              dispatch({ type: "event", envelope: event as EventEnvelope, cursor });
              // In-memory max-wins guard — no async storage read per event
              if (cursor > persistedCursorRef.current) {
                persistedCursorRef.current = cursor;
                void setItem(`pushpals:cursor:${sessionId}`, String(cursor));
              }
            }
          },
          undefined, // transport
          afterCursor,
        );

        unsubscribeRef.current = unsubscribe;
      } catch (err) {
        setSession((s) => ({
          ...s,
          error: String(err),
        }));
      }
    };

    init();

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, [baseUrl]);

  // ─── Send message (with companion intent) ──────────────────────────────
  // Note: Messages now go to Local Agent (not directly to server)
  const send = useCallback(
    async (text: string) => {
      if (!session.sessionId) return false;
      const companion: CompanionModel = new RemoteCompanionModel();
      try {
        const intent = await companion.summarizeAndPlan({
          userText: text,
          history: session.events,
        });
        return sendMessage(LOCAL_AGENT_URL, session.sessionId, text, intent as any);
      } catch (_err) {
        return sendMessage(LOCAL_AGENT_URL, session.sessionId, text);
      }
    },
    [session.sessionId, session.events],
  );

  // ─── Approve / Deny ────────────────────────────────────────────────────
  const approve = useCallback(
    async (approvalId: string) => {
      return submitApprovalDecision(baseUrl, approvalId, "approve");
    },
    [baseUrl],
  );

  const deny = useCallback(
    async (approvalId: string) => {
      return submitApprovalDecision(baseUrl, approvalId, "deny");
    },
    [baseUrl],
  );

  // ─── Computed: unique agent names ──────────────────────────────────────
  const agents = useMemo(() => {
    const set = new Set<string>();
    for (const ev of session.events) {
      if (isEnvelope(ev) && ev.from) set.add(ev.from);
    }
    return Array.from(set).sort();
  }, [session.events]);

  // ─── Computed: unique turnIds ──────────────────────────────────────────
  const turnIds = useMemo(() => {
    const set = new Set<string>();
    for (const ev of session.events) {
      if (isEnvelope(ev) && ev.turnId) set.add(ev.turnId);
    }
    return Array.from(set);
  }, [session.events]);

  // ─── Computed: task groups ─────────────────────────────────────────────
  const tasks = useMemo(() => {
    const map = new Map<string, TaskGroup>();
    for (const ev of session.events) {
      if (!isEnvelope(ev)) continue;
      const p = ev.payload as any;
      const taskId: string | undefined = p?.taskId;
      if (!taskId) continue;

      if (!map.has(taskId)) {
        map.set(taskId, {
          taskId,
          title: p.title ?? taskId,
          status: "created",
          events: [],
        });
      }
      const group = map.get(taskId)!;
      group.events.push(ev);

      // Update status based on lifecycle events
      if (ev.type === "task_started") group.status = "started";
      else if (ev.type === "task_progress") group.status = "in_progress";
      else if (ev.type === "task_completed") group.status = "completed";
      else if (ev.type === "task_failed") group.status = "failed";
    }
    return Array.from(map.values());
  }, [session.events]);

  // ─── Filtered events ──────────────────────────────────────────────────
  const filteredEvents = useMemo(() => {
    return session.events.filter((ev) => {
      if (!isEnvelope(ev)) return true; // always show errors
      if (filters.agentFrom && ev.from !== filters.agentFrom) return false;
      if (filters.turnId && ev.turnId !== filters.turnId) return false;
      if (filters.taskId) {
        const p = ev.payload as any;
        if (p?.taskId !== filters.taskId) return false;
      }
      if (filters.eventTypes && filters.eventTypes.length > 0) {
        if (!filters.eventTypes.includes(ev.type as EventType)) return false;
      }
      return true;
    });
  }, [session.events, filters]);

  return {
    sessionId: session.sessionId,
    events: session.events,
    filteredEvents,
    isConnected: session.isConnected,
    error: session.error,
    send,
    approve,
    deny,
    tasks,
    agents,
    turnIds,
    filters,
    setFilters,
    state,
  };
}
