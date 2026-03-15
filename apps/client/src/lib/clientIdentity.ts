import type { ClientRegistration } from "./pushpalsApi";

type StorageReader = (key: string) => Promise<string | null>;
type StorageWriter = (key: string, value: string) => Promise<void>;

async function defaultRead(key: string): Promise<string | null> {
  const storage = await import("./storage");
  return await storage.getItem(key);
}

async function defaultWrite(key: string, value: string): Promise<void> {
  const storage = await import("./storage");
  await storage.setItem(key, value);
}

function compactText(value: unknown, maxChars: number): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function defaultLabelForKind(kind: string): string {
  switch (kind) {
    case "cli_monitor":
      return "CLI Monitor";
    case "web":
      return "Web Client";
    case "vscode":
      return "VS Code";
    case "cli":
      return "CLI";
    default:
      return kind || "Client";
  }
}

export function normalizeClientKind(value: unknown): string {
  const text = compactText(value, 48).toLowerCase();
  if (!text) return "web";
  return text.replace(/[^a-z0-9._-]+/g, "_") || "web";
}

export function buildClientIdentityStorageKey(kind: string, sessionId: string): string {
  const normalizedKind = normalizeClientKind(kind);
  const normalizedSession = compactText(sessionId, 128) || "dev";
  return `pushpals:client-id:${normalizedKind}:${normalizedSession}`;
}

export function defaultClientIdFactory(kind: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${kind}-${globalThis.crypto.randomUUID()}`;
  }
  return `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function resolveClientRegistration(
  client: Partial<ClientRegistration> | undefined,
  sessionId: string,
  deps: {
    read?: StorageReader;
    write?: StorageWriter;
    createId?: (kind: string) => string;
  } = {},
): Promise<ClientRegistration> {
  const kind = normalizeClientKind(client?.kind);
  const explicitClientId = compactText(client?.clientId, 128);
  const read = deps.read ?? defaultRead;
  const write = deps.write ?? defaultWrite;
  const createId = deps.createId ?? defaultClientIdFactory;

  let clientId = explicitClientId;
  if (!clientId) {
    const storageKey = buildClientIdentityStorageKey(kind, sessionId);
    clientId = compactText(await read(storageKey), 128);
    if (!clientId) {
      clientId = createId(kind);
      await write(storageKey, clientId);
    }
  }

  const label = compactText(client?.label, 120) || defaultLabelForKind(kind);
  const version = compactText(client?.version, 64);
  const platform = compactText(client?.platform, 120);
  const repoRoot = compactText(client?.repoRoot, 400);

  return {
    clientId,
    kind,
    label,
    ...(version ? { version } : {}),
    ...(platform ? { platform } : {}),
    ...(repoRoot ? { repoRoot } : {}),
  };
}
