export class BoundedJsonBodyError extends Error {
  readonly status: 400 | 413;

  constructor(status: 400 | 413, message: string) {
    super(message);
    this.name = "BoundedJsonBodyError";
    this.status = status;
  }
}

const REJECTED_BODY_DRAIN_TIMEOUT_MS = 250;
const REJECTED_BODY_EXTRA_BYTES = 64 * 1024;

/**
 * Finish small, already-arriving uploads before replying early. Bun 1.3.14 can
 * reuse a connection despite a response's Connection: close header; replying
 * mid-chunk can make its fetch client omit the upload terminator and poison the
 * next request. Discard without retaining bytes, with both time and byte bounds.
 * An unfinished sender must abandon its connection; critical health probes use
 * their own connections and never depend on the rejected sender's socket.
 */
export async function drainRejectedJsonBody(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel">,
  maxDiscardBytes: number,
  timeoutMs = REJECTED_BODY_DRAIN_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  let complete = false;
  let discardedBytes = 0;
  try {
    while (performance.now() < deadline) {
      const next = await Promise.race([reader.read(), expired]);
      if (!next) break;
      if (next.done) {
        complete = true;
        break;
      }
      discardedBytes += next.value?.byteLength ?? 0;
      if (discardedBytes > maxDiscardBytes) break;
    }
  } catch {
    // A disconnected sender cannot complete its upload; rejection still wins.
  } finally {
    clearTimeout(timer);
    if (!complete) {
      // Cancellation itself is not a deadline: a custom source can refuse to
      // settle it. Do not hold the response or control-plane event loop on it.
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        /* best effort */
      }
    }
  }
  return complete;
}

/** Read bounded control-plane JSON without trusting Content-Length. */
export async function readBoundedJsonObject(
  req: Request,
  maxBytes: number,
  label: string,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(req.headers.get("content-length"));
  const declaredTooLarge = Number.isFinite(declaredLength) && declaredLength > maxBytes;
  if (!req.body) {
    if (declaredTooLarge) throw new BoundedJsonBodyError(413, `${label} body is too large`);
    throw new BoundedJsonBodyError(400, `Valid JSON ${label} body is required`);
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    if (declaredTooLarge) {
      await drainRejectedJsonBody(reader, maxBytes + REJECTED_BODY_EXTRA_BYTES);
      throw new BoundedJsonBodyError(413, `${label} body is too large`);
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await drainRejectedJsonBody(reader, REJECTED_BODY_EXTRA_BYTES);
        throw new BoundedJsonBodyError(413, `${label} body is too large`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } catch {
    throw new BoundedJsonBodyError(400, `Valid JSON ${label} body is required`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BoundedJsonBodyError(400, `${label} body must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
