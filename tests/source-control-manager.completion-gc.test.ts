import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CompletionGcJournal,
  buildCompletionGcLocalDeleteArgs,
  buildCompletionGcRemoteDeleteArgs,
  claimBeforeCompletionGc,
  completionGcAuthorityConfirmsProcessed,
  createCompletionGcRecord,
  reconcileCompletionGcJournal,
  type CompletionGcRecord,
  type CompletionProcessingAuthority,
} from "../apps/source_control_manager/src/completion_gc";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-completion-gc-"));
  tempDirs.push(dir);
  return dir;
}

function record(
  suffix = "one",
  overrides: Partial<Parameters<typeof createCompletionGcRecord>[0]> = {},
): CompletionGcRecord {
  return createCompletionGcRecord({
    completionId: `completion-${suffix}`,
    completionBranch: `refs/pushpals/review/${suffix}`,
    commitSha: "a".repeat(40),
    claimGeneration: 1,
    remote: "origin",
    createdAt: "2026-08-17T12:00:00.000Z",
    ...overrides,
  });
}

function authority(
  candidate: CompletionGcRecord,
  overrides: Partial<CompletionProcessingAuthority> = {},
): CompletionProcessingAuthority {
  return {
    id: candidate.completionId,
    status: "processed",
    commitSha: candidate.commitSha,
    branch: candidate.completionBranch,
    claimGeneration: candidate.claimGeneration,
    ...overrides,
  };
}

describe("SourceControlManager completion ref GC", () => {
  test("claims pending publication before hygiene and skips GC on a busy queue", async () => {
    const events: string[] = [];
    const claimed = await claimBeforeCompletionGc({
      claim: async () => {
        events.push("claim");
        return { completion: { id: "pending" } };
      },
      isIdle: (result) => !result.completion,
      reconcile: async () => {
        events.push("gc");
      },
    });

    expect(claimed).toEqual({ completion: { id: "pending" } });
    expect(events).toEqual(["claim"]);

    await claimBeforeCompletionGc({
      claim: async () => {
        events.push("idle-claim");
        return { completion: null };
      },
      isIdle: (result) => !result.completion,
      reconcile: async () => {
        events.push("idle-gc");
      },
    });
    expect(events).toEqual(["claim", "idle-claim", "idle-gc"]);
  });

  test("persists an immutable idempotent cleanup record across journal instances", () => {
    const stateDir = createStateDir();
    const first = new CompletionGcJournal(stateDir);
    const candidate = record("durable", {
      additionalValidationRefs: [`refs/pushpals/validation/${"b".repeat(32)}/2/candidate`],
    });

    expect(first.enqueue(candidate)).toEqual(candidate);
    expect(first.enqueue(candidate)).toEqual(candidate);
    expect(new CompletionGcJournal(stateDir).list()).toEqual([candidate]);
    expect(() =>
      first.enqueue(
        record("durable", {
          commitSha: "c".repeat(40),
          additionalValidationRefs: candidate.additionalValidationRefs,
        }),
      ),
    ).toThrow("conflicts with an existing durable record");
  });

  test("requires exact processed identity and accepts a later successful claim generation", () => {
    const candidate = record("authority", { claimGeneration: 2 });

    expect(completionGcAuthorityConfirmsProcessed(candidate, authority(candidate))).toBe(true);
    expect(
      completionGcAuthorityConfirmsProcessed(
        candidate,
        authority(candidate, { claimGeneration: 3 }),
      ),
    ).toBe(true);
    expect(
      completionGcAuthorityConfirmsProcessed(
        candidate,
        authority(candidate, { status: "claimed" }),
      ),
    ).toBe(false);
    expect(
      completionGcAuthorityConfirmsProcessed(
        candidate,
        authority(candidate, { commitSha: "b".repeat(40) }),
      ),
    ).toBe(false);
    expect(
      completionGcAuthorityConfirmsProcessed(
        candidate,
        authority(candidate, { branch: "refs/pushpals/review/moved" }),
      ),
    ).toBe(false);
    expect(
      completionGcAuthorityConfirmsProcessed(
        candidate,
        authority(candidate, { claimGeneration: 1 }),
      ),
    ).toBe(false);
    expect(completionGcAuthorityConfirmsProcessed(candidate, null)).toBe(false);
  });

  test("deletes completion refs only with exact local and remote SHA leases", () => {
    const candidate = record("leased-delete");

    expect(buildCompletionGcLocalDeleteArgs(candidate, candidate.commitSha)).toEqual([
      "update-ref",
      "-d",
      candidate.completionBranch,
      candidate.commitSha,
    ]);
    expect(buildCompletionGcRemoteDeleteArgs(candidate, candidate.commitSha)).toEqual([
      "push",
      `--force-with-lease=${candidate.completionBranch}:${candidate.commitSha}`,
      "origin",
      `:${candidate.completionBranch}`,
    ]);
    expect(buildCompletionGcLocalDeleteArgs(candidate, "b".repeat(40))).toBeNull();
    expect(buildCompletionGcRemoteDeleteArgs(candidate, "b".repeat(40))).toBeNull();
    expect(buildCompletionGcLocalDeleteArgs(candidate, null)).toBeNull();
    expect(buildCompletionGcRemoteDeleteArgs(candidate, null)).toBeNull();
  });

  test("never cleans or removes refs when server authority is unreachable", async () => {
    const stateDir = createStateDir();
    const journal = new CompletionGcJournal(stateDir);
    const candidate = journal.enqueue(record("unreachable"));
    let cleanupCalls = 0;

    const result = await reconcileCompletionGcJournal({
      journal,
      resolveAuthority: async () => {
        throw new Error("status response body timed out");
      },
      cleanup: async () => {
        cleanupCalls += 1;
        return true;
      },
    });

    expect(result).toEqual({ examined: 1, cleaned: 0, retained: 1, uncertain: 1 });
    expect(cleanupCalls).toBe(0);
    expect(new CompletionGcJournal(stateDir).list()).toEqual([candidate]);
  });

  test("retains pending and identity-mismatched records without invoking cleanup", async () => {
    const stateDir = createStateDir();
    const journal = new CompletionGcJournal(stateDir);
    const pending = journal.enqueue(record("pending"));
    const mismatched = journal.enqueue(record("mismatch"));
    let cleanupCalls = 0;

    const result = await reconcileCompletionGcJournal({
      journal,
      limit: 4,
      resolveAuthority: async (candidate) =>
        candidate.completionId === pending.completionId
          ? authority(candidate, { status: "claimed" })
          : authority(candidate, { commitSha: "f".repeat(40) }),
      cleanup: async () => {
        cleanupCalls += 1;
        return true;
      },
    });

    expect(result).toEqual({ examined: 2, cleaned: 0, retained: 2, uncertain: 0 });
    expect(cleanupCalls).toBe(0);
    expect(new CompletionGcJournal(stateDir).list(4)).toHaveLength(2);
  });

  test("removes the journal only after idempotent cleanup succeeds", async () => {
    const stateDir = createStateDir();
    const journal = new CompletionGcJournal(stateDir);
    const candidate = journal.enqueue(record("retry"));
    let cleanupCalls = 0;

    const first = await reconcileCompletionGcJournal({
      journal,
      resolveAuthority: async () => authority(candidate),
      cleanup: async () => {
        cleanupCalls += 1;
        return false;
      },
    });
    expect(first).toEqual({ examined: 1, cleaned: 0, retained: 1, uncertain: 0 });
    expect(new CompletionGcJournal(stateDir).list()).toEqual([candidate]);

    const second = await reconcileCompletionGcJournal({
      journal,
      resolveAuthority: async () => authority(candidate),
      cleanup: async () => {
        cleanupCalls += 1;
        return true;
      },
    });
    expect(second).toEqual({ examined: 1, cleaned: 1, retained: 0, uncertain: 0 });
    expect(cleanupCalls).toBe(2);
    expect(new CompletionGcJournal(stateDir).list()).toEqual([]);
  });

  test("bounds each pass and rotates retained records instead of starving later cleanup", async () => {
    const stateDir = createStateDir();
    const journal = new CompletionGcJournal(stateDir);
    for (let index = 0; index < 6; index += 1) journal.enqueue(record(`bounded-${index}`));
    const observed: string[] = [];
    const runPass = () =>
      reconcileCompletionGcJournal({
        journal,
        limit: 2,
        resolveAuthority: async (candidate) => {
          observed.push(candidate.completionId);
          return authority(candidate, { status: "pending" });
        },
        cleanup: async () => true,
      });

    expect((await runPass()).examined).toBe(2);
    expect((await runPass()).examined).toBe(2);
    expect(new Set(observed).size).toBe(4);
  });
});
