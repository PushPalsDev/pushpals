import * as crypto from "node:crypto";

const SESSION_KEY_PREFIX = "pushpals.vscode.sessionId";
const DEFAULT_WORKSPACE_SLUG = "workspace";

export function sanitizeWorkspaceSlug(name: string | undefined): string {
  const cleaned = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || DEFAULT_WORKSPACE_SLUG;
}

export function sessionStorageKeyForWorkspace(workspaceIdentifier: string | undefined): string {
  const stableId = workspaceIdentifier?.trim() || DEFAULT_WORKSPACE_SLUG;
  const fingerprint = crypto.createHash("sha256").update(stableId).digest("hex").slice(0, 12);
  return `${SESSION_KEY_PREFIX}.${fingerprint}`;
}

export function createSessionId(workspaceName: string | undefined, uuid: string = crypto.randomUUID()): string {
  return `vscode-${sanitizeWorkspaceSlug(workspaceName)}-${uuid.slice(0, 8)}`;
}
