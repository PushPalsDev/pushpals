#!/usr/bin/env bun

import { createHash } from "node:crypto";

// Publication acceptance is not registry propagation. This read-only gate runs
// before the real installed-package smoke; it never republishes or replaces it.
export const NPM_PROPAGATION_LIMITS = {
  timeoutMs: 15 * 60_000,
  requestTimeoutMs: 30_000,
  pollIntervalMs: 15_000,
  attempts: 64,
  metadataBytes: 1024 * 1024,
  tarballBytes: 256 * 1024 * 1024,
} as const;

const REGISTRY = "https://registry.npmjs.org";
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type RequestResult =
  | { ok: true; text: string; digest: string; bytes: number }
  | { ok: false; reason: string };

export type NpmPropagationResult = {
  available: boolean;
  attempts: number;
  elapsedMs: number;
  reason: string;
};

function positiveBound(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value <= 0 || value > maximum)
    throw new Error("Propagation timing must be a positive integer within the fixed limit.");
  return value;
}

function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Cancellation is best effort and must not extend the request deadline.
  }
}

async function readRegistryResource(options: {
  url: string;
  fetcher: Fetcher;
  timeoutMs: number;
  byteLimit: number;
  algorithm?: "sha512" | "sha1";
}): Promise<RequestResult> {
  const controller = new AbortController();
  const deadline = performance.now() + options.timeoutMs;
  const expired = () => controller.signal.aborted || performance.now() >= deadline;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    controller.abort();
    try {
      void reader?.cancel().catch(() => {});
    } catch {
      // Do not await a potentially stalled stream cancel implementation.
    }
  };
  const operation = (async (): Promise<RequestResult> => {
    try {
      const response = await options.fetcher(options.url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: {
          Accept: options.algorithm ? "application/octet-stream" : "application/json",
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });
      if (expired()) {
        discardBody(response);
        return { ok: false, reason: "timeout" };
      }
      if (response.status !== 200) {
        discardBody(response);
        return { ok: false, reason: `http_${response.status}` };
      }
      if (Number(response.headers.get("content-length")) > options.byteLimit) {
        discardBody(response);
        return { ok: false, reason: "body_too_large" };
      }
      if (!response.body) return { ok: false, reason: "empty_body" };
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      const hash = options.algorithm ? createHash(options.algorithm) : null;
      let bytes = 0;
      while (!expired()) {
        const chunk = await reader.read();
        if (expired()) return { ok: false, reason: "timeout" };
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > options.byteLimit) return { ok: false, reason: "body_too_large" };
        if (hash) hash.update(chunk.value);
        else chunks.push(chunk.value);
      }
      if (expired()) return { ok: false, reason: "timeout" };
      if (!bytes) return { ok: false, reason: "empty_body" };
      return {
        ok: true,
        text: hash ? "" : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        digest: hash ? hash.digest(options.algorithm === "sha1" ? "hex" : "base64") : "",
        bytes,
      };
    } catch {
      // No remote bodies, URLs, auth configuration, or exception text in logs.
      return { ok: false, reason: expired() ? "timeout" : "transport_error" };
    }
  })();
  try {
    return await Promise.race([
      operation,
      new Promise<RequestResult>((resolve) => {
        timer = setTimeout(() => {
          cancel();
          resolve({ ok: false, reason: "timeout" });
        }, options.timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    cancel();
    try {
      reader?.releaseLock();
    } catch {
      // A read from a timed-out non-cooperating stream can still be pending.
    }
  }
}

function tarballDescriptor(
  text: string,
  packageName: string,
  version: string,
): { url: string; algorithm: "sha512" | "sha1"; digest: string } | null {
  try {
    const metadata = JSON.parse(text);
    if (metadata?.name !== packageName || metadata?.version !== version) return null;
    const dist = metadata.dist;
    if (typeof dist?.tarball !== "string" || dist.tarball.length > 2048) return null;
    const url = new URL(dist.tarball);
    // The public registry supplies its own tarballs. Never follow metadata to
    // another origin, credentials, signed queries, redirects, or local paths.
    if (url.origin !== REGISTRY || url.username || url.password || url.search || url.hash)
      return null;
    if (!url.pathname.endsWith(".tgz")) return null;
    if (typeof dist.integrity === "string") {
      const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(dist.integrity);
      if (!match) return null;
      return { url: url.href, algorithm: "sha512", digest: match[1]! };
    }
    if (typeof dist.shasum === "string" && /^[a-f0-9]{40}$/i.test(dist.shasum))
      return { url: url.href, algorithm: "sha1", digest: dist.shasum.toLowerCase() };
  } catch {
    // Malformed or mismatched metadata is not evidence of availability.
  }
  return null;
}

export async function waitForNpmPackage(options: {
  packageName: string;
  version: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  fetcher?: Fetcher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onAttempt?: (result: NpmPropagationResult) => void;
}): Promise<NpmPropagationResult> {
  if (
    options.packageName.length > 214 ||
    options.packageName.trim() !== options.packageName ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(options.packageName) ||
    options.version.length > 128 ||
    options.version.trim() !== options.version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      options.version,
    )
  )
    throw new Error("An exact public npm package name and version are required.");
  const timeoutMs = positiveBound(options.timeoutMs, NPM_PROPAGATION_LIMITS.timeoutMs);
  const requestTimeoutMs = positiveBound(
    options.requestTimeoutMs,
    NPM_PROPAGATION_LIMITS.requestTimeoutMs,
  );
  const pollIntervalMs = positiveBound(
    options.pollIntervalMs,
    NPM_PROPAGATION_LIMITS.pollIntervalMs,
  );
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const deadline = started + timeoutMs;
  const metadataUrl = `${REGISTRY}/${encodeURIComponent(options.packageName)}/${encodeURIComponent(options.version)}`;
  let attempts = 0;
  let reason = "deadline";
  const result = (available: boolean): NpmPropagationResult => ({
    available,
    attempts,
    elapsedMs: Math.max(0, Math.round(now() - started)),
    reason,
  });
  while (now() < deadline && attempts < NPM_PROPAGATION_LIMITS.attempts) {
    attempts++;
    const metadata = await readRegistryResource({
      url: metadataUrl,
      fetcher,
      timeoutMs: Math.max(1, Math.min(requestTimeoutMs, deadline - now())),
      byteLimit: NPM_PROPAGATION_LIMITS.metadataBytes,
    });
    if (metadata.ok === false) reason = `metadata_${metadata.reason}`;
    else {
      const descriptor = tarballDescriptor(metadata.text, options.packageName, options.version);
      if (!descriptor) reason = "metadata_invalid";
      else if (now() >= deadline) reason = "deadline";
      else {
        const tarball = await readRegistryResource({
          url: descriptor.url,
          fetcher,
          timeoutMs: Math.max(1, Math.min(requestTimeoutMs, deadline - now())),
          byteLimit: NPM_PROPAGATION_LIMITS.tarballBytes,
          algorithm: descriptor.algorithm,
        });
        reason =
          tarball.ok === false
            ? `tarball_${tarball.reason}`
            : tarball.digest !== descriptor.digest
              ? "tarball_integrity_mismatch"
              : now() >= deadline
                ? "deadline"
                : "ready";
      }
    }
    const observation = result(reason === "ready");
    try {
      options.onAttempt?.({ ...observation });
    } catch {
      // An observer cannot change the readiness result or reset any deadline.
    }
    if (observation.available) return observation;
    const remaining = deadline - now();
    if (remaining > 0 && attempts < NPM_PROPAGATION_LIMITS.attempts)
      await sleep(Math.min(pollIntervalMs, remaining));
  }
  return result(false);
}

export function parseNpmPropagationArgs(argv: string[]): { packageName: string; version: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!;
    const value = argv[index + 1];
    if (!["--package-name", "--version"].includes(key) || !value || values.has(key))
      throw new Error("Usage: release-wait-for-npm.ts --package-name NAME --version EXACT_VERSION");
    values.set(key, value);
  }
  if (values.size !== 2)
    throw new Error("Usage: release-wait-for-npm.ts --package-name NAME --version EXACT_VERSION");
  return { packageName: values.get("--package-name")!, version: values.get("--version")! };
}

if (import.meta.main) {
  try {
    const result = await waitForNpmPackage({
      ...parseNpmPropagationArgs(process.argv.slice(2)),
      onAttempt: (entry) =>
        console.log(
          `[npm-propagation] attempt=${entry.attempts} elapsedMs=${entry.elapsedMs} state=${entry.reason}`,
        ),
    });
    if (!result.available) {
      console.error(
        "[npm-propagation] Exact package metadata and tarball were not verified within the bounded wait; installed smoke cannot proceed.",
      );
      process.exitCode = 1;
    }
  } catch {
    console.error(
      "[npm-propagation] Availability check failed; an exact package name and version are required.",
    );
    process.exitCode = 1;
  }
}
