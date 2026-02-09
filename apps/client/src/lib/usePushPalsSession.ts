import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import type { EventEnvelope, EventType } from "protocol/browser";
import { CompanionModel, RemoteCompanionModel } from "./companion";
import {
  subscribeEvents,
  createSession,
  sendMessage,
  submitApprovalDecision,
  sendCommand,
} from "./pushpalsApi";

// ─── Extended event type that may include local errors ──────────────────────
export type SessionEvent = EventEnvelope | { type: "_error"; message: string };

export function isEnvelope(e: SessionEvent): e is EventEnvelope {
  return (e as any).id !== undefined;
}

// ─── Task grouping ──────────────────────────────────────────────────────────
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

  // Computed
  tasks: TaskGroup[];
  agents: string[];
  turnIds: string[];

  // Filter
  filters: EventFilters;
  setFilters: (f: EventFilters) => void;
}

/**
 * Hook to manage a PushPals session with grouping, filtering, and approval actions
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

  const [filters, setFilters] = useState<EventFilters>({});

  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Initialize session on mount
  useEffect(() => {
    const init = async () => {
      try {
        const sessionId = await createSession(baseUrl);
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

        // Subscribe to events
        const unsubscribe = subscribeEvents(baseUrl, sessionId, (event) => {
          setSession((s) => ({
            ...s,
            events: [...s.events, event],
          }));
        });

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
  const send = useCallback(
    async (text: string) => {
      if (!session.sessionId) return false;
      const companion: CompanionModel = new RemoteCompanionModel();
      try {
        const intent = await companion.summarizeAndPlan({
          userText: text,
          history: session.events,
        });
        return sendMessage(baseUrl, session.sessionId, text, intent as any);
      } catch (_err) {
        return sendMessage(baseUrl, session.sessionId, text);
      }
    },
    [session.sessionId, baseUrl, session.events],
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
  };
}
