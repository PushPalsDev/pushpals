const HEARTBEAT_STATUS_RE = /\bheartbeat\b/i;
const ALWAYS_VISIBLE_EVENT_TYPES = new Set(["question_asked"]);

type SessionEventLike = { type?: unknown; payload?: unknown; from?: unknown } | null | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isAutonomyMarker(value: unknown): boolean {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "autonomy"
  );
}

function hasAutonomyPayloadMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (isAutonomyMarker(value.origin)) return true;
  if (isAutonomyMarker(value.createdBy)) return true;
  if (isRecord(value.autonomy)) return true;
  if (Array.isArray(value.tags) && value.tags.some(isAutonomyMarker)) return true;
  if (isRecord(value.params) && hasAutonomyPayloadMarker(value.params)) return true;
  return false;
}

export function isHeartbeatStatusSessionEvent(event: SessionEventLike): boolean {
  const type = String(event?.type ?? "")
    .trim()
    .toLowerCase();
  if (type !== "status") return false;

  const payload = isRecord(event?.payload) ? event.payload : {};
  const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";

  return HEARTBEAT_STATUS_RE.test(detail) || HEARTBEAT_STATUS_RE.test(message);
}

export function shouldDisplayInteractiveSessionEvent(event: SessionEventLike): boolean {
  const type = String(event?.type ?? "")
    .trim()
    .toLowerCase();
  if (ALWAYS_VISIBLE_EVENT_TYPES.has(type)) return true;
  if (isAutonomyOriginSessionEvent(event)) return false;
  return !isHeartbeatStatusSessionEvent(event);
}

export function isAutonomyOriginSessionEvent(event: SessionEventLike): boolean {
  const from = String(event?.from ?? "").toLowerCase();
  if (/(^|[/:._-])autonomy($|[/:._-])/.test(from)) return true;
  return hasAutonomyPayloadMarker(event?.payload);
}
