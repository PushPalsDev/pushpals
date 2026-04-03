import * as crypto from "node:crypto";

const SESSION_KEY_PREFIX = "pushpals.vscode.sessionId";
const DEFAULT_WORKSPACE_SLUG = "workspace";
const sessionIdCache = new Map<string, string>();
const pendingSessionPersists = new Map<string, Promise<string>>();

export type SessionStateStore = {
  get<T>(key: string): T | undefined;
  update(key: string, value: string): Thenable<void> | Promise<void> | void;
};

function normalizeSessionId(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || "";
}

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

export function createSessionId(
  workspaceName: string | undefined,
  uuid: string = crypto.randomUUID(),
): string {
  return `vscode-${sanitizeWorkspaceSlug(workspaceName)}-${uuid.slice(0, 8)}`;
}

export function __resetWorkspaceSessionCacheForTests(): void {
  sessionIdCache.clear();
  pendingSessionPersists.clear();
}

export function resolveWorkspaceSessionId(
  store: SessionStateStore,
  workspaceIdentifier: string | undefined,
  workspaceName: string | undefined,
): string {
  const key = sessionStorageKeyForWorkspace(workspaceIdentifier);
  const cached = sessionIdCache.get(key);
  if (cached) return cached;
  const existing = normalizeSessionId(store.get<string>(key));
  if (existing) {
    sessionIdCache.set(key, existing);
    return existing;
  }

  const next = createSessionId(workspaceName);
  sessionIdCache.set(key, next);
  if (!pendingSessionPersists.has(key)) {
    const persist = Promise.resolve(store.update(key, next))
      .then(() => next)
      .catch((error) => {
        if (sessionIdCache.get(key) === next) {
          sessionIdCache.delete(key);
        }
        throw error;
      })
      .finally(() => {
        pendingSessionPersists.delete(key);
      });
    pendingSessionPersists.set(key, persist);
  }
  return next;
}

export async function ensureWorkspaceSessionId(
  store: SessionStateStore,
  workspaceIdentifier: string | undefined,
  workspaceName: string | undefined,
): Promise<string> {
  const key = sessionStorageKeyForWorkspace(workspaceIdentifier);
  const existing = normalizeSessionId(store.get<string>(key));
  if (existing) {
    sessionIdCache.set(key, existing);
    return existing;
  }

  const cached = sessionIdCache.get(key);
  if (cached) {
    const pending = pendingSessionPersists.get(key);
    if (pending) {
      await pending;
    }
    return cached;
  }

  const next = resolveWorkspaceSessionId(store, workspaceIdentifier, workspaceName);
  const pending = pendingSessionPersists.get(key);
  if (pending) {
    await pending;
  }
  return next;
}

export function buildSourceCheckoutRuntimeEnv(
  sessionId: string | undefined,
  extraEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  const value = normalizeSessionId(sessionId);
  if (!value && !extraEnv) return undefined;
  return {
    ...(extraEnv ?? {}),
    ...(value ? { PUSHPALS_SESSION_ID: value } : {}),
  };
}

export function buildInstalledCliRuntimeArgs(sessionId: string | undefined): string[] {
  const args = ["--runtime-only"];
  const value = normalizeSessionId(sessionId);
  if (value) {
    args.push("--session-id", value);
  }
  return args;
}
