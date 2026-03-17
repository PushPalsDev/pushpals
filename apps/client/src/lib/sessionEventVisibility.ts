import type { EventEnvelope } from "protocol/browser";

const HEARTBEAT_STATUS_RE = /\bheartbeat\b/i;

type SessionEventLike = Pick<EventEnvelope, "type" | "payload"> | null | undefined;

export function isHeartbeatStatusSessionEvent(event: SessionEventLike): boolean {
  const type = String(event?.type ?? "")
    .trim()
    .toLowerCase();
  if (type !== "status") return false;

  const payload = event?.payload ?? {};
  const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";

  return HEARTBEAT_STATUS_RE.test(detail) || HEARTBEAT_STATUS_RE.test(message);
}

export function shouldDisplayInteractiveSessionEvent(event: SessionEventLike): boolean {
  return !isHeartbeatStatusSessionEvent(event);
}
