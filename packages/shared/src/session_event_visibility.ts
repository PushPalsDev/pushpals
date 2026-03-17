type SessionEventLike = {
  type?: string | null;
  payload?: Record<string, unknown> | null;
};

const HEARTBEAT_STATUS_RE = /\bheartbeat\b/i;

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
