import { describe, expect, test } from "bun:test";
import { SessionManager } from "../apps/server/src/events";
import { emitQuestionAnsweredEvent } from "../apps/server/src/server_main";

describe("server autonomy question events", () => {
  test("emitQuestionAnsweredEvent preserves legacy question_answered type", () => {
    const sessionManager = new SessionManager(":memory:");
    const sessionId = "session-question-test";
    sessionManager.createSession(sessionId);
    const session = sessionManager.getSession(sessionId);
    expect(session).not.toBeNull();
    const events: any[] = [];
    const unsubscribe = session?.subscribe((envelope) => events.push(envelope));

    emitQuestionAnsweredEvent({
      sessionManager,
      sessionId,
      questionId: "q-test-123",
      objectiveId: "obj-test-123",
      status: "valid",
      answerSummary: "Clarified queue priorities.",
    });

    unsubscribe?.();
    expect(events).toHaveLength(1);
    const envelope = events[0];
    expect(envelope.type).toBe("question_answered");
    expect(envelope.payload.questionId).toBe("q-test-123");
    expect(envelope.payload.objectiveId).toBe("obj-test-123");
    expect(envelope.payload.status).toBe("valid");
    expect(envelope.payload.answerSummary).toContain("Clarified");
    sessionManager.store.close();
  });
});
