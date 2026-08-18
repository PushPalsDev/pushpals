import { createHash, randomUUID } from "crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";

const COMPLETION_GC_VERSION = 1 as const;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SAFE_COMPLETION_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const SAFE_REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SAFE_PUSHPALS_REF_RE = /^refs\/pushpals\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_VALIDATION_REF_RE =
  /^refs\/pushpals\/validation\/[0-9a-f]{32}\/[1-9][0-9]*\/(?:baseline|candidate|validated)$/i;
const MAX_ADDITIONAL_VALIDATION_REFS = 24;

export type CompletionGcRecord = {
  version: typeof COMPLETION_GC_VERSION;
  completionId: string;
  completionBranch: string;
  commitSha: string;
  claimGeneration: number;
  remote: string | null;
  additionalValidationRefs: string[];
  createdAt: string;
};

export type CompletionProcessingAuthority = {
  id: string;
  status: string;
  commitSha: string | null;
  branch: string | null;
  claimGeneration: number;
};

export type CompletionGcReconciliationResult = {
  examined: number;
  cleaned: number;
  retained: number;
  uncertain: number;
};

function validationNamespace(completionId: string): string {
  const key = createHash("sha256").update(completionId).digest("hex").slice(0, 32);
  return `refs/pushpals/validation/${key}`;
}

function isSafePushpalsRef(value: string): boolean {
  return (
    SAFE_PUSHPALS_REF_RE.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.split("/").some((part) => part.endsWith(".lock"))
  );
}

function normalizeRecord(input: CompletionGcRecord): CompletionGcRecord {
  if (input?.version !== COMPLETION_GC_VERSION) {
    throw new Error("Completion GC record has an unsupported version.");
  }
  const completionId = String(input?.completionId ?? "").trim();
  if (!SAFE_COMPLETION_ID_RE.test(completionId)) {
    throw new Error("Completion GC record has an invalid completion ID.");
  }
  const completionBranch = String(input?.completionBranch ?? "").trim();
  if (
    !completionBranch ||
    completionBranch.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(completionBranch)
  ) {
    throw new Error(`Completion GC record ${completionId} has an invalid completion branch.`);
  }
  if (completionBranch.startsWith("refs/pushpals/") && !isSafePushpalsRef(completionBranch)) {
    throw new Error(`Completion GC record ${completionId} has an unsafe PushPals ref.`);
  }
  const commitSha = String(input?.commitSha ?? "")
    .trim()
    .toLowerCase();
  if (!SHA_RE.test(commitSha)) {
    throw new Error(`Completion GC record ${completionId} has an invalid commit SHA.`);
  }
  const claimGeneration = Number(input?.claimGeneration);
  if (!Number.isSafeInteger(claimGeneration) || claimGeneration < 1) {
    throw new Error(`Completion GC record ${completionId} has an invalid claim generation.`);
  }
  const remote = input?.remote === null ? null : String(input?.remote ?? "").trim();
  if (
    remote !== null &&
    (!SAFE_REMOTE_RE.test(remote) || remote.includes("..") || remote.includes("//"))
  ) {
    throw new Error(`Completion GC record ${completionId} has an invalid remote.`);
  }
  if (remote !== null && !isSafePushpalsRef(completionBranch)) {
    throw new Error(
      `Completion GC record ${completionId} cannot delete a non-PushPals remote ref.`,
    );
  }
  const additionalValidationRefs = [
    ...new Set(
      (Array.isArray(input?.additionalValidationRefs) ? input.additionalValidationRefs : []).map(
        (value) => String(value ?? "").trim(),
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
  if (additionalValidationRefs.length > MAX_ADDITIONAL_VALIDATION_REFS) {
    throw new Error(`Completion GC record ${completionId} has too many retained validation refs.`);
  }
  for (const ref of additionalValidationRefs) {
    if (!isSafePushpalsRef(ref) || !SAFE_VALIDATION_REF_RE.test(ref)) {
      throw new Error(
        `Completion GC record ${completionId} contains an invalid validation checkpoint ref.`,
      );
    }
  }
  const createdAt = String(input?.createdAt ?? "").trim();
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error(`Completion GC record ${completionId} has an invalid creation time.`);
  }
  return {
    version: COMPLETION_GC_VERSION,
    completionId,
    completionBranch,
    commitSha,
    claimGeneration,
    remote,
    additionalValidationRefs,
    createdAt,
  };
}

function sameRecord(left: CompletionGcRecord, right: CompletionGcRecord): boolean {
  return (
    left.completionId === right.completionId &&
    left.completionBranch === right.completionBranch &&
    left.commitSha === right.commitSha &&
    left.claimGeneration === right.claimGeneration &&
    left.remote === right.remote &&
    left.additionalValidationRefs.join("\n") === right.additionalValidationRefs.join("\n")
  );
}

export function createCompletionGcRecord(input: {
  completionId: string;
  completionBranch: string;
  commitSha: string;
  claimGeneration: number;
  remote?: string | null;
  additionalValidationRefs?: string[];
  createdAt?: string;
}): CompletionGcRecord {
  return normalizeRecord({
    version: COMPLETION_GC_VERSION,
    completionId: input.completionId,
    completionBranch: input.completionBranch,
    commitSha: input.commitSha,
    claimGeneration: input.claimGeneration,
    remote: input.remote ?? null,
    additionalValidationRefs: input.additionalValidationRefs ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export function completionGcValidationNamespace(record: CompletionGcRecord): string {
  return validationNamespace(record.completionId);
}

export function completionGcAuthorityConfirmsProcessed(
  record: CompletionGcRecord,
  authority: CompletionProcessingAuthority | null,
): boolean {
  if (!authority || authority.status !== "processed") return false;
  const authoritySha = String(authority.commitSha ?? "")
    .trim()
    .toLowerCase();
  const authorityGeneration = Number(authority.claimGeneration);
  return (
    authority.id === record.completionId &&
    authority.branch === record.completionBranch &&
    authoritySha === record.commitSha &&
    Number.isSafeInteger(authorityGeneration) &&
    authorityGeneration >= record.claimGeneration
  );
}

export function buildCompletionGcLocalDeleteArgs(
  record: CompletionGcRecord,
  resolvedSha: string | null,
): string[] | null {
  if (!record.completionBranch.startsWith("refs/pushpals/")) return null;
  const normalizedResolvedSha = String(resolvedSha ?? "")
    .trim()
    .toLowerCase();
  if (normalizedResolvedSha !== record.commitSha) return null;
  return ["update-ref", "-d", record.completionBranch, record.commitSha];
}

export function buildCompletionGcRemoteDeleteArgs(
  record: CompletionGcRecord,
  resolvedSha: string | null,
): string[] | null {
  if (!record.remote) return null;
  const normalizedResolvedSha = String(resolvedSha ?? "")
    .trim()
    .toLowerCase();
  if (normalizedResolvedSha !== record.commitSha) return null;
  return [
    "push",
    `--force-with-lease=${record.completionBranch}:${record.commitSha}`,
    record.remote,
    `:${record.completionBranch}`,
  ];
}

export class CompletionGcJournal {
  private readonly directory: string;
  private cursor = 0;

  constructor(stateDir: string) {
    this.directory = join(stateDir, "completion-ref-gc");
    mkdirSync(this.directory, { recursive: true });
  }

  private pathFor(record: Pick<CompletionGcRecord, "completionId" | "claimGeneration">): string {
    const key = createHash("sha256").update(record.completionId).digest("hex").slice(0, 32);
    return join(this.directory, `${key}-${record.claimGeneration}.json`);
  }

  enqueue(input: CompletionGcRecord): CompletionGcRecord {
    const record = normalizeRecord(input);
    const destination = this.pathFor(record);
    if (existsSync(destination)) {
      const existing = normalizeRecord(
        JSON.parse(readFileSync(destination, "utf8")) as CompletionGcRecord,
      );
      if (!sameRecord(existing, record)) {
        throw new Error(
          `Completion GC record ${record.completionId}/${record.claimGeneration} conflicts with an existing durable record.`,
        );
      }
      return existing;
    }

    const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    let fd: number | null = null;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temporary, destination);
      return record;
    } catch (error) {
      if (fd !== null) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may not have been created or may already be gone.
      }
      if (existsSync(destination)) {
        const existing = normalizeRecord(
          JSON.parse(readFileSync(destination, "utf8")) as CompletionGcRecord,
        );
        if (sameRecord(existing, record)) return existing;
      }
      throw error;
    }
  }

  list(limit = 4, onWarning: (message: string) => void = () => undefined): CompletionGcRecord[] {
    const names = readdirSync(this.directory)
      .filter((name) => /^[0-9a-f]{32}-[1-9][0-9]*\.json$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
    if (names.length === 0) {
      this.cursor = 0;
      return [];
    }
    const boundedLimit = Math.max(1, Math.min(32, Math.floor(limit)));
    const selectedCount = Math.min(boundedLimit, names.length);
    const start = this.cursor % names.length;
    const selected = Array.from(
      { length: selectedCount },
      (_unused, index) => names[(start + index) % names.length],
    );
    this.cursor = (start + selectedCount) % names.length;

    const records: CompletionGcRecord[] = [];
    for (const name of selected) {
      const path = join(this.directory, name);
      try {
        const record = normalizeRecord(
          JSON.parse(readFileSync(path, "utf8")) as CompletionGcRecord,
        );
        if (this.pathFor(record) !== path) {
          throw new Error("record identity does not match its journal filename");
        }
        records.push(record);
      } catch (error) {
        onWarning(
          `Ignoring invalid completion GC journal ${name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return records;
  }

  remove(record: CompletionGcRecord): void {
    try {
      unlinkSync(this.pathFor(normalizeRecord(record)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
}

export async function reconcileCompletionGcJournal(options: {
  journal: CompletionGcJournal;
  resolveAuthority: (record: CompletionGcRecord) => Promise<CompletionProcessingAuthority | null>;
  cleanup: (record: CompletionGcRecord) => Promise<boolean>;
  limit?: number;
  onWarning?: (message: string) => void;
}): Promise<CompletionGcReconciliationResult> {
  const onWarning = options.onWarning ?? (() => undefined);
  const records = options.journal.list(options.limit ?? 4, onWarning);
  const result: CompletionGcReconciliationResult = {
    examined: records.length,
    cleaned: 0,
    retained: 0,
    uncertain: 0,
  };
  const authorityResults = await Promise.all(
    records.map(async (record) => {
      try {
        return { record, authority: await options.resolveAuthority(record), error: null };
      } catch (error) {
        return { record, authority: null, error };
      }
    }),
  );

  for (const authorityResult of authorityResults) {
    const { record, authority, error } = authorityResult;
    if (error) {
      result.uncertain += 1;
      result.retained += 1;
      onWarning(
        `Completion ${record.completionId} cleanup authority is unreachable; retaining refs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    if (!completionGcAuthorityConfirmsProcessed(record, authority)) {
      result.retained += 1;
      continue;
    }
    try {
      const cleaned = await options.cleanup(record);
      if (!cleaned) {
        result.retained += 1;
        continue;
      }
      options.journal.remove(record);
      result.cleaned += 1;
    } catch (cleanupError) {
      result.retained += 1;
      onWarning(
        `Completion ${record.completionId} ref cleanup failed and will be retried: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
      );
    }
  }
  return result;
}

/**
 * Keep hygiene off the publication critical path. A pending completion is
 * always claimed first; bounded retained-ref reconciliation runs only when
 * that authoritative claim says the queue is idle.
 */
export async function claimBeforeCompletionGc<T>(options: {
  claim: () => Promise<T>;
  isIdle: (result: T) => boolean;
  reconcile: () => Promise<void>;
}): Promise<T> {
  const result = await options.claim();
  if (options.isIdle(result)) await options.reconcile();
  return result;
}
