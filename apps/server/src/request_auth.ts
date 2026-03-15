export function resolveRequestAuthHeader(
  authorizationHeader: string | null,
): string | null {
  const headerText = String(authorizationHeader ?? "").trim();
  return headerText || null;
}
