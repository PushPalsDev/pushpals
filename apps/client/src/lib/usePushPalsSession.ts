import { useEffect, useState, useCallback, useRef } from "react";
import type { EventEnvelope } from "protocol/browser";
import { CompanionModel, RemoteCompanionModel } from "./companion";
import { subscribeEvents, createSession, sendMessage } from "./pushpalsApi";

export interface PushPalsSession {
  sessionId: string | null;
  events: (EventEnvelope | { type: "_error"; message: string })[];
  isConnected: boolean;
  error: string | null;
}

/**
 * Hook to manage a PushPals session and subscribe to events
 */
export function usePushPalsSession(baseUrl: string = "http://localhost:3001") {
  const [session, setSession] = useState<PushPalsSession>({
    sessionId: null,
    events: [],
    isConnected: false,
    error: null,
  });

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

  const send = useCallback(
    async (text: string) => {
      if (!session.sessionId) return false;

      // Use companion to generate intent before sending
      const companion: CompanionModel = new RemoteCompanionModel();
      try {
        const intent = await companion.summarizeAndPlan({
          userText: text,
          history: session.events,
        });
        return sendMessage(baseUrl, session.sessionId, text, intent as any);
      } catch (_err) {
        // Fallback: send without intent
        return sendMessage(baseUrl, session.sessionId, text);
      }
    },
    [session.sessionId, baseUrl],
  );

  return { ...session, send };
}
