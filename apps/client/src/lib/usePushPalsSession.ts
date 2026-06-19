import { useEffect, useState, useCallback, useRef, useMemo, useReducer } from "react";
import type { EventEnvelope, EventType } from "protocol/browser";
import {
  subscribeEvents,
  createSession,
  sendSessionMessage,
  submitApprovalDecision,
  type ClientRegistration,
} from "./pushpalsApi";
import { resolveClientRegistration } from "./clientIdentity";
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
import { shouldDisplayInteractiveSessionEvent } from "./sessionEventVisibility";
import { buildTaskGroupsFromEvents } from "./taskGroups";

// Metro compile-time replaces EXPO_PUBLIC_* — falls back to "dev" so all apps
// share the same session out of the box with zero config.

// ─── Re-export reducer types for consumers ──────────────────────────────────
export type { Task, Job, LogLine, ChatMessage, SessionState };
export { buildTaskGroupsFromEvents };

// ─── Task grouping derived from reducer/event stream ────────────────
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
  events: EventEnvelope[];
  isConnected: boolean;
  error: string | null;
}

export interface PushPalsSessionActions {
  sessionId: string | null;
  events: EventEnvelope[];
  filteredEvents: EventEnvelope[];
  isConnected: boolean;
  error: string | null;

  // Actions
  send: (text: string) => Promise<boolean>;
  approve: (approvalId: string) => Promise<boolean>;
  deny: (approvalId: string) => Promise<boolean>;

  // Computed convenience values
  tasks: TaskGroup[];
  agents: string[];
  turnIds: string[];

  // Filter
  filters: EventFilters;
  setFilters: (f: EventFilters) => void;

  // PR4: structured state from reducer
  state: SessionState;
}

export interface PushPalsSessionOptions {
  baseUrl?: string;
  sessionId?: string;
  authToken?: string | null;
  clientInfo?: Partial<ClientRegistration>;
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
  options: string | PushPalsSessionOptions = "http://localhost:3001",
): PushPalsSessionActions {
  const normalizedOptions = typeof options === "string" ? { baseUrl: options } : (options ?? {});
  const baseUrl = String(normalizedOptions.baseUrl ?? "http://localhost:3001")
    .trim()
    .replace(/\/+$/, "");
  const defaultSessionId = String(normalizedOptions.sessionId ?? "dev").trim() || "dev";
  const authToken = String(normalizedOptions.authToken ?? "").trim() || undefined;
  const clientInfo = normalizedOptions.clientInfo;
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
  const clientRef = useRef<ClientRegistration | null>(null);

  // Initialize session on mount
  useEffect(() => {
    const init = async () => {
      try {
        const client = await resolveClientRegistration(clientInfo, defaultSessionId);
        clientRef.current = client;
        const session = await createSession(baseUrl, defaultSessionId, authToken, client);
        if (!session) {
          setSession((s) => ({
            ...s,
            error: "Failed to create session",
          }));
          return;
        }
        const sessionId = session.sessionId;

        setSession((s) => ({
          ...s,
          sessionId,
          isConnected: true,
        }));

        // Restore cursor for reconnect / replay
        const afterCursor = session.created ? 0 : await loadCursor(sessionId);
        persistedCursorRef.current = afterCursor;
        if (session.created) {
          void setItem(`pushpals:cursor:${sessionId}`, "0");
        }

        // Subscribe to events with cursor-aware callback
        const unsubscribe = subscribeEvents(
          baseUrl,
          sessionId,
          (event, cursor) => {
            // Feed flat event list for chat timeline rendering
            setSession((s) => ({
              ...s,
              events: [...s.events, event],
            }));

            // Feed structured reducer
            dispatch({ type: "event", envelope: event, cursor });
            // In-memory max-wins guard - no async storage read per event
            if (cursor > persistedCursorRef.current) {
              persistedCursorRef.current = cursor;
              void setItem(`pushpals:cursor:${sessionId}`, String(cursor));
            }
          },
          undefined, // transport
          afterCursor,
          authToken,
          client,
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
  }, [authToken, baseUrl, defaultSessionId]);

  // ─── Send message via the local server session ─────────────────
  const send = useCallback(
    async (text: string) => {
      if (!session.sessionId) return false;
      return sendSessionMessage(baseUrl, session.sessionId, text);
    },
    [baseUrl, session.sessionId],
  );

  // ─── Approve / Deny ────────────────────────────────────────────────────
  const approve = useCallback(
    async (approvalId: string) => {
      return submitApprovalDecision(baseUrl, approvalId, "approve", authToken);
    },
    [authToken, baseUrl],
  );

  const deny = useCallback(
    async (approvalId: string) => {
      return submitApprovalDecision(baseUrl, approvalId, "deny", authToken);
    },
    [authToken, baseUrl],
  );

  // ─── Computed: unique agent names ──────────────────────────────────────
  const agents = useMemo(() => {
    const set = new Set<string>();
    for (const ev of session.events) {
      if (ev.from) set.add(ev.from);
    }
    return Array.from(set).sort();
  }, [session.events]);

  // ─── Computed: unique turnIds ──────────────────────────────────────────
  const turnIds = useMemo(() => {
    const set = new Set<string>();
    for (const ev of session.events) {
      if (ev.turnId) set.add(ev.turnId);
    }
    return Array.from(set);
  }, [session.events]);

  // ─── Computed: task groups ─────────────────────────────────────────────
  const tasks = useMemo(() => buildTaskGroupsFromEvents(session.events), [session.events]);

  // ─── Filtered events ──────────────────────────────────────────────────
  const filteredEvents = useMemo(() => {
    return session.events.filter((ev) => {
      if (!shouldDisplayInteractiveSessionEvent(ev)) return false;
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
