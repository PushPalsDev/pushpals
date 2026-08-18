export type VscodeFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Bound response headers and body parsing even when a transport ignores abort. */
export async function fetchVscodeResponseWithDeadline(
  input: string | URL | Request,
  init: RequestInit = {},
  options: {
    timeoutMs: number;
    maxResponseBytes?: number;
    fetchImpl?: VscodeFetchLike;
  },
): Promise<Response> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const maxResponseBytes = Math.max(
    0,
    Math.floor(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES),
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  let rejectUpstreamAbort: ((reason: unknown) => void) | null = null;
  const upstreamAbort = new Promise<never>((_resolve, reject) => {
    rejectUpstreamAbort = reject;
  });
  const abortFromUpstream = () => {
    controller.abort(upstreamSignal?.reason);
    rejectUpstreamAbort?.(
      upstreamSignal?.reason instanceof Error
        ? upstreamSignal.reason
        : new Error("VS Code HTTP request was aborted"),
    );
  };
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const operation = Promise.resolve().then(async () => {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    const responseInit: ResponseInit = {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    };
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      const error = new Error(`VS Code HTTP response exceeded ${maxResponseBytes} byte limit`);
      await response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxResponseBytes) {
        throw new Error(`VS Code HTTP response exceeded ${maxResponseBytes} byte limit`);
      }
      return new Response(bytes.byteLength > 0 ? bytes : null, responseInit);
    }

    const reader = response.body.getReader();
    const cancelReader = () => {
      try {
        void reader.cancel(controller.signal.reason).catch(() => undefined);
      } catch {
        // The stream may already have completed.
      }
    };
    controller.signal.addEventListener("abort", cancelReader, { once: true });
    if (controller.signal.aborted) cancelReader();
    try {
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > maxResponseBytes) {
          const error = new Error(`VS Code HTTP response exceeded ${maxResponseBytes} byte limit`);
          await reader.cancel(error).catch(() => undefined);
          throw error;
        }
        chunks.push(chunk.value);
      }
      if (totalBytes === 0) return new Response(null, responseInit);
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(bytes, responseInit);
    } finally {
      controller.signal.removeEventListener("abort", cancelReader);
      try {
        reader.releaseLock();
      } catch {
        // A cancelled transport can leave a read pending.
      }
    }
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`VS Code HTTP request timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race(
      upstreamSignal ? [operation, deadline, upstreamAbort] : [operation, deadline],
    );
  } finally {
    if (timer) clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}
