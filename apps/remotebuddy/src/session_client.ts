export async function connectWithRetry(
  server: string,
  sessionId?: string | null,
  maxRetries = Infinity,
  baseDelay = 2000,
  maxDelay = 30000,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let attempt = 0;
  const normalizedSessionId =
    typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;

  while (true) {
    attempt += 1;
    try {
      const res = await fetchImpl(`${server}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(normalizedSessionId ? { sessionId: normalizedSessionId } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = (await res.json()) as { sessionId?: string | null };
      if (!data?.sessionId) {
        throw new Error("Response missing sessionId");
      }
      return data.sessionId;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      console.log(
        `[RemoteBuddy] Server unavailable (${message}), retrying in ${(delay / 1000).toFixed(1)} s... (attempt ${attempt})`,
      );
      await Bun.sleep(delay);
    }
  }
}
