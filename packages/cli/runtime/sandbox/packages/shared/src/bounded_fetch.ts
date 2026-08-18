export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type FetchWithHardDeadlineOptions<T> = {
  input: string | URL | Request;
  init?: RequestInit;
  timeoutMs: number;
  consume: (response: Response, signal: AbortSignal) => Promise<T> | T;
  fetchImpl?: FetchLike;
  timeoutMessage?: string;
};

export type FetchBufferedWithHardDeadlineOptions = Omit<
  FetchWithHardDeadlineOptions<Response>,
  "consume"
> & {
  maxResponseBytes?: number;
};

export const DEFAULT_MAX_BUFFERED_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Bounds the complete HTTP exchange, including response-body consumption.
 *
 * A plain fetch timeout only protects receipt of the response headers when the
 * caller reads the body later. Keeping `consume` inside the deadline also
 * handles peers that send headers and then leave the body stream open forever.
 * The Promise.race remains authoritative even when a test double or runtime
 * transport ignores AbortSignal.
 */
export async function fetchWithHardDeadline<T>(
  options: FetchWithHardDeadlineOptions<T>,
): Promise<T> {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.max(1, Math.floor(options.timeoutMs))
      : 1;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const upstreamSignal = options.init?.signal;
  let rejectUpstreamAbort: ((reason: unknown) => void) | null = null;
  const upstreamAbort = new Promise<never>((_resolve, reject) => {
    rejectUpstreamAbort = reject;
  });
  const abortFromUpstream = () => {
    controller.abort(upstreamSignal?.reason);
    rejectUpstreamAbort?.(
      upstreamSignal?.reason instanceof Error
        ? upstreamSignal.reason
        : new DOMException("The HTTP request was aborted", "AbortError"),
    );
  };
  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const operation = Promise.resolve().then(async () => {
    const response = await fetchImpl(options.input, {
      ...options.init,
      signal: controller.signal,
    });
    return await options.consume(response, controller.signal);
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(options.timeoutMessage ?? `HTTP request timed out after ${timeoutMs}ms`));
      controller.abort();
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

/**
 * Buffers a response while the hard deadline is active. The returned Response
 * can then be parsed by existing callers without leaving a live network stream.
 */
export async function fetchBufferedWithHardDeadline(
  options: FetchBufferedWithHardDeadlineOptions,
): Promise<Response> {
  const { maxResponseBytes: configuredMaxResponseBytes, ...requestOptions } = options;
  const maxResponseBytes =
    typeof configuredMaxResponseBytes === "number" &&
    Number.isFinite(configuredMaxResponseBytes) &&
    configuredMaxResponseBytes >= 0
      ? Math.floor(configuredMaxResponseBytes)
      : DEFAULT_MAX_BUFFERED_RESPONSE_BYTES;
  return fetchWithHardDeadline({
    ...requestOptions,
    consume: async (response, signal) => {
      const responseInit: ResponseInit = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      };
      if (!response.body) return new Response(null, responseInit);

      const reader = response.body.getReader();
      const sizeError = () =>
        new Error(`HTTP response exceeded ${maxResponseBytes} byte buffer limit`);
      const cancelReader = () => {
        try {
          void reader.cancel(signal.reason).catch(() => undefined);
        } catch {
          // The stream may already have completed while the abort was delivered.
        }
      };
      signal.addEventListener("abort", cancelReader, { once: true });
      // The transport may ignore AbortSignal and resolve only after the hard
      // deadline already fired. In that case registering an abort listener is
      // too late, so cancel the newly exposed body immediately as well.
      if (signal.aborted) cancelReader();

      try {
        const contentLengthHeader = response.headers.get("content-length");
        const contentLength = contentLengthHeader == null ? null : Number(contentLengthHeader);
        if (
          contentLength != null &&
          Number.isFinite(contentLength) &&
          contentLength > maxResponseBytes
        ) {
          const error = sizeError();
          await reader.cancel(error).catch(() => undefined);
          throw error;
        }

        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxResponseBytes) {
            const error = sizeError();
            await reader.cancel(error).catch(() => undefined);
            throw error;
          }
          chunks.push(value);
        }

        if (totalBytes === 0) return new Response(null, responseInit);
        const body = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new Response(body, responseInit);
      } finally {
        signal.removeEventListener("abort", cancelReader);
        try {
          reader.releaseLock();
        } catch {
          // A transport that ignores cancellation can leave a read pending.
        }
      }
    },
  });
}
