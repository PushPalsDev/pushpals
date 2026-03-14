export function resolveRequestAuthHeader(
  authorizationHeader: string | null,
  authTokenQueryValue: string | null,
): string | null {
  const headerText = String(authorizationHeader ?? "").trim();
  if (headerText) return headerText;

  // Browser EventSource and WebSocket transports cannot attach custom
  // Authorization headers, so allow an explicit query token fallback.
  const queryToken = String(authTokenQueryValue ?? "").trim();
  if (!queryToken) return null;
  return `Bearer ${queryToken}`;
}
