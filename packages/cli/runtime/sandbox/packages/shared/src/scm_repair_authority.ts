import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";

export const SCM_REPAIR_AUTHORITY_HEADER = "x-pushpals-scm-repair-authority";
export const SCM_REPAIR_AUTHORITY_SECRET_ENV = "PUSHPALS_SCM_REPAIR_AUTHORITY_SECRET";

const SCM_REPAIR_AUTHORITY_VERSION = "v1";
const SCM_REPAIR_AUTHORITY_MAX_AGE_MS = 2 * 60_000;
const SCM_REPAIR_AUTHORITY_MAX_FUTURE_SKEW_MS = 15_000;
const SCM_REPAIR_AUTHORITY_MIN_SECRET_CHARS = 32;
const SCM_REPAIR_AUTHORITY_CREATE_RETRY_MS = 5_000;
const SCM_REPAIR_AUTHORITY_INVALID_STABILITY_MS = 2_000;
const SCM_REPAIR_AUTHORITY_CREATE_RETRY_MIN_DELAY_MS = 10;
const SCM_REPAIR_AUTHORITY_CREATE_RETRY_MAX_DELAY_MS = 100;
const SCM_REPAIR_AUTHORITY_RETRYABLE_IO_CODES = new Set([
  "EACCES",
  "EAGAIN",
  "EBUSY",
  "EEXIST",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "EPERM",
  "ETXTBSY",
]);
const SCM_REPAIR_AUTHORITY_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));

export type ScmRepairAuthorityVerification =
  | { ok: true; issuedAtMs: number; nonce: string }
  | { ok: false; reason: string };

type AuthoritySecretInspection =
  | { state: "valid"; secret: string }
  | { state: "missing" }
  | { state: "invalid"; fingerprint: string }
  | { state: "transient"; code: string };

function normalizeAuthoritySecret(value: unknown): string {
  const secret = String(value ?? "").trim();
  if (secret.length < SCM_REPAIR_AUTHORITY_MIN_SECRET_CHARS) return "";
  return secret;
}

function filesystemErrorCode(error: unknown): string {
  return String((error as { code?: unknown })?.code ?? "").toUpperCase();
}

function isRetryableAuthorityIoError(error: unknown): boolean {
  return SCM_REPAIR_AUTHORITY_RETRYABLE_IO_CODES.has(filesystemErrorCode(error));
}

function waitForAuthorityCreationRetry(delayMs: number): void {
  Atomics.wait(SCM_REPAIR_AUTHORITY_RETRY_WAIT, 0, 0, Math.max(1, Math.floor(delayMs)));
}

export function scrubScmRepairAuthoritySecretFromEnv(
  env: Record<string, string | undefined>,
): void {
  const target = SCM_REPAIR_AUTHORITY_SECRET_ENV.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === target) delete env[key];
  }
}

/**
 * Move an optional operator override out of a process environment before any
 * unrelated child command can inherit it. Environment-key matching is kept
 * case-insensitive for Windows callers.
 */
export function takeScmRepairAuthoritySecretFromEnv(
  env: Record<string, string | undefined>,
): string {
  const target = SCM_REPAIR_AUTHORITY_SECRET_ENV.toLowerCase();
  let secret = "";
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== target) continue;
    if (!secret) secret = String(env[key] ?? "").trim();
    delete env[key];
  }
  return secret;
}

export function copyEnvWithoutScmRepairAuthoritySecret(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const copy: Record<string, string> = {};
  const target = SCM_REPAIR_AUTHORITY_SECRET_ENV.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === target || typeof value !== "string") continue;
    copy[key] = value;
  }
  return copy;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return "null";
}

function authorityMessage(body: unknown, issuedAtMs: number, nonce: string): string {
  return `${SCM_REPAIR_AUTHORITY_VERSION}\n${issuedAtMs}\n${nonce}\n${canonicalJson(body)}`;
}

function authoritySignature(
  body: unknown,
  secret: string,
  issuedAtMs: number,
  nonce: string,
): string {
  return createHmac("sha256", secret)
    .update(authorityMessage(body, issuedAtMs, nonce), "utf8")
    .digest("base64url");
}

/**
 * Resolve the private Server <-> SourceControlManager signing key. The key is
 * deliberately stored outside HTTP-visible state and is readable only by the
 * local runtime account where the platform supports file modes.
 */
export function resolveScmRepairAuthoritySecret(options: {
  dataDir: string;
  env?: Readonly<Record<string, string | undefined>>;
}): string {
  const env = options.env ?? process.env;
  const configured = String(env[SCM_REPAIR_AUTHORITY_SECRET_ENV] ?? "").trim();
  if (configured) {
    const valid = normalizeAuthoritySecret(configured);
    if (!valid) {
      throw new Error(`${SCM_REPAIR_AUTHORITY_SECRET_ENV} must contain at least 32 characters`);
    }
    return valid;
  }

  const authorityDir = resolve(options.dataDir, "control-plane");
  const secretPath = join(authorityDir, "scm-repair-authority.key");
  mkdirSync(authorityDir, { recursive: true, mode: 0o700 });

  let lastRetryableIssue = `SCM repair authority key at ${secretPath} was not ready`;
  const inspectExisting = (): AuthoritySecretInspection => {
    try {
      const raw = readFileSync(secretPath, "utf8");
      const existing = normalizeAuthoritySecret(raw);
      if (existing) return { state: "valid", secret: existing };
      const stats = statSync(secretPath);
      lastRetryableIssue = `SCM repair authority key at ${secretPath} was incomplete`;
      return {
        state: "invalid",
        fingerprint: `${stats.size}:${Math.floor(stats.mtimeMs)}:${raw}`,
      };
    } catch (error) {
      if (!isRetryableAuthorityIoError(error)) throw error;
      const code = filesystemErrorCode(error);
      lastRetryableIssue = `SCM repair authority key at ${secretPath} was not readable${code ? ` (${code})` : ""}`;
      return code === "ENOENT" ? { state: "missing" } : { state: "transient", code };
    }
  };

  const initial = inspectExisting();
  if (initial.state === "valid") return initial.secret;

  const generated = randomBytes(32).toString("base64url");
  const temporaryPath = join(
    authorityDir,
    `.scm-repair-authority.${process.pid}.${randomBytes(9).toString("hex")}.tmp`,
  );
  writeFileSync(temporaryPath, `${generated}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const retryDeadlineMs = Date.now() + SCM_REPAIR_AUTHORITY_CREATE_RETRY_MS;
  let retryCount = 0;
  let stableInvalidFingerprint = "";
  let stableInvalidSinceMs = 0;
  try {
    while (true) {
      const nowMs = Date.now();
      const existing = inspectExisting();
      if (existing.state === "valid") return existing.secret;
      if (existing.state === "invalid") {
        if (existing.fingerprint !== stableInvalidFingerprint) {
          stableInvalidFingerprint = existing.fingerprint;
          stableInvalidSinceMs = nowMs;
        } else if (nowMs - stableInvalidSinceMs >= SCM_REPAIR_AUTHORITY_INVALID_STABILITY_MS) {
          const confirmed = inspectExisting();
          if (confirmed.state === "invalid" && confirmed.fingerprint === stableInvalidFingerprint) {
            try {
              unlinkSync(secretPath);
              stableInvalidFingerprint = "";
              stableInvalidSinceMs = 0;
              continue;
            } catch (error) {
              if (!isRetryableAuthorityIoError(error)) throw error;
            }
          }
        }
      } else {
        stableInvalidFingerprint = "";
        stableInvalidSinceMs = 0;
      }

      if (existing.state === "missing") {
        try {
          // A hard-link publishes an already complete file atomically. Losers
          // observe EEXIST and read the winner instead of seeing partial bytes.
          linkSync(temporaryPath, secretPath);
          try {
            chmodSync(secretPath, 0o600);
          } catch {
            // Windows ACLs are inherited from the private runtime directory.
          }
          return generated;
        } catch (error) {
          if (!isRetryableAuthorityIoError(error)) throw error;
          const code = filesystemErrorCode(error);
          lastRetryableIssue = `SCM repair authority key creation at ${secretPath} is still in progress${code ? ` (${code})` : ""}`;
        }
      }

      const remainingMs = retryDeadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `${lastRetryableIssue}; timed out after ${SCM_REPAIR_AUTHORITY_CREATE_RETRY_MS}ms waiting for a concurrent first-start writer`,
        );
      }
      retryCount += 1;
      const delayMs = Math.min(
        remainingMs,
        SCM_REPAIR_AUTHORITY_CREATE_RETRY_MAX_DELAY_MS,
        SCM_REPAIR_AUTHORITY_CREATE_RETRY_MIN_DELAY_MS * retryCount,
      );
      waitForAuthorityCreationRetry(delayMs);
    }
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // A crash can leave only a non-authoritative temp file; ignore cleanup failures.
    }
  }
}

export function createScmRepairAuthorityProof(
  body: unknown,
  secret: string,
  options: { nowMs?: number; nonce?: string } = {},
): string {
  const normalizedSecret = normalizeAuthoritySecret(secret);
  if (!normalizedSecret) throw new Error("SCM repair authority secret must contain 32 characters");
  const issuedAtMs = Math.floor(options.nowMs ?? Date.now());
  const nonce = String(options.nonce ?? randomBytes(18).toString("base64url")).trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error("SCM repair authority nonce is invalid");
  }
  const signature = authoritySignature(body, normalizedSecret, issuedAtMs, nonce);
  return `${SCM_REPAIR_AUTHORITY_VERSION}.${issuedAtMs}.${nonce}.${signature}`;
}

export function verifyScmRepairAuthorityProof(options: {
  body: unknown;
  proof: string | null | undefined;
  secret: string | null | undefined;
  nowMs?: number;
}): ScmRepairAuthorityVerification {
  const secret = normalizeAuthoritySecret(options.secret);
  if (!secret) return { ok: false, reason: "SCM repair authority is unavailable" };
  const proof = String(options.proof ?? "").trim();
  const match = proof.match(/^v1\.(\d{10,16})\.([A-Za-z0-9_-]{16,128})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return { ok: false, reason: "SCM repair authority proof is missing or malformed" };

  const issuedAtMs = Number(match[1]);
  const nonce = match[2];
  const suppliedSignature = match[3];
  const nowMs = Math.floor(options.nowMs ?? Date.now());
  if (!Number.isSafeInteger(issuedAtMs)) {
    return { ok: false, reason: "SCM repair authority timestamp is invalid" };
  }
  if (
    issuedAtMs < nowMs - SCM_REPAIR_AUTHORITY_MAX_AGE_MS ||
    issuedAtMs > nowMs + SCM_REPAIR_AUTHORITY_MAX_FUTURE_SKEW_MS
  ) {
    return { ok: false, reason: "SCM repair authority proof expired" };
  }

  const expectedSignature = authoritySignature(options.body, secret, issuedAtMs, nonce);
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: "SCM repair authority signature is invalid" };
  }
  return { ok: true, issuedAtMs, nonce };
}
