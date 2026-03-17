const HEARTBEAT_STATUS_RE = /\bheartbeat\b/i;

type SessionEventLike = {
  type?: string;
  payload?: Record<string, unknown>;
};

export function isHeartbeatStatusSessionEvent(event: SessionEventLike | null | undefined): boolean {
  const type = String(event?.type ?? "")
    .trim()
    .toLowerCase();
  if (type !== "status") return false;

  const payload = event?.payload ?? {};
  const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";

  return HEARTBEAT_STATUS_RE.test(detail) || HEARTBEAT_STATUS_RE.test(message);
}

export function shouldDisplayInteractiveSessionEvent(
  event: SessionEventLike | null | undefined,
): boolean {
  return !isHeartbeatStatusSessionEvent(event);
}
