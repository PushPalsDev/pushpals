export type CompletionCallbackResponse = {
  ok: boolean;
  status: number;
};

export type CompletionCallbackResult = {
  confirmed: boolean;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
};

export async function withHardDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage = "operation timed out",
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new Error(timeoutMessage));
      },
      Math.max(1, Math.floor(timeoutMs)),
    );
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Retries the same token-fenced completion callback with a deadline on every
 * attempt. Processed callbacks are idempotent with the winning token, so a
 * response lost after the SQLite transaction commits is safe to replay.
 */
export async function postCompletionCallbackWithRetry(options: {
  request: (signal: AbortSignal) => Promise<CompletionCallbackResponse>;
  attempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<CompletionCallbackResult> {
  const attempts = Math.max(1, Math.min(5, Math.floor(options.attempts ?? 3)));
  const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 5_000));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 200));
  const wait = options.wait ?? ((delayMs: number) => Bun.sleep(delayMs));
  let lastStatus: number | null = null;
  let lastError: string | null = null;
  let attempted = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attempted = attempt;
    try {
      const response = await withHardDeadline(
        options.request,
        timeoutMs,
        `completion callback timed out after ${timeoutMs}ms`,
      );
      lastStatus = response.status;
      lastError = null;
      if (response.ok) {
        return { confirmed: true, attempts: attempt, lastStatus, lastError };
      }
      // Authentication, fencing, and validation failures are deterministic.
      // Retrying them only holds the queue lease for longer.
      if (response.status >= 400 && response.status < 500 && response.status !== 408) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts && retryDelayMs > 0) {
      await wait(retryDelayMs * attempt);
    }
  }

  return { confirmed: false, attempts: attempted, lastStatus, lastError };
}

export const postCompletionProcessedWithRetry = postCompletionCallbackWithRetry;
