export interface EnsureSessionOptions {
  serverUrl: string;
  sessionId?: string | null;
  authToken?: string | null;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetchImpl?: typeof fetch;
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  signal?: AbortSignal;
}

export interface SessionRetryNotice {
  attempt: number;
  delayMs: number;
  error: Error;
}

export interface ConnectSessionWithRetryOptions {
  serverUrl: string;
  sessionId?: string | null;
  authToken?: string | null;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  shouldAbort?: () => boolean;
  abortMessage?: string;
  onRetryNotice?: (notice: SessionRetryNotice) => void;
}

export class SessionConnectionAbortedError extends Error {
  constructor(message = "session connection aborted") {
    super(message);
    this.name = "SessionConnectionAbortedError";
  }
}

function normalizedServerUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("Server URL cannot be empty");
  return trimmed.replace(/\/+$/, "");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureSessionExists(opts: EnsureSessionOptions): Promise<string> {
  const {
    serverUrl,
    sessionId,
    authToken = null,
    maxAttempts,
    baseDelayMs = 2_000,
    maxDelayMs = 30_000,
    fetchImpl = fetch,
    onRetry,
    signal,
  } = opts;

  const trimmedServer = normalizedServerUrl(serverUrl);
  const desiredSessionId = sessionId && sessionId.trim() ? sessionId.trim() : null;
  const requestBody = desiredSessionId ? { sessionId: desiredSessionId } : {};

  const attemptLimit =
    typeof maxAttempts === "number" && maxAttempts > 0
      ? maxAttempts
      : Number.POSITIVE_INFINITY;

  let attempt = 0;
  let lastError: unknown = null;

  while (attempt < attemptLimit) {
    attempt += 1;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const response = await fetchImpl(`${trimmedServer}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }
      const data = (await response.json()) as { sessionId?: string };
      if (!data?.sessionId) {
        throw new Error("Server response missing sessionId");
      }
      return data.sessionId;
    } catch (err) {
      lastError = err;
      if (attempt >= attemptLimit) break;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      if (onRetry) {
        const errorObject = err instanceof Error ? err : new Error(String(err));
        onRetry(attempt, delay, errorObject);
      }
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  const error =
    lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "failed to connect to session"));
  throw error;
}

export async function connectSessionWithRetry(
  opts: ConnectSessionWithRetryOptions,
): Promise<string> {
  const {
    serverUrl,
    sessionId,
    authToken,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    fetchImpl,
    signal,
    shouldAbort,
    abortMessage,
    onRetryNotice,
  } = opts;

  return ensureSessionExists({
    serverUrl,
    sessionId,
    authToken,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    fetchImpl,
    signal,
    onRetry: (attempt, delay, error) => {
      if (shouldAbort?.()) {
        throw new SessionConnectionAbortedError(abortMessage ?? "session connection aborted");
      }
      if (onRetryNotice) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        onRetryNotice({ attempt, delayMs: delay, error: normalizedError });
      }
    },
  });
}
