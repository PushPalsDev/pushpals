import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { completeCliStateClear, removeCliClearTarget } from "../scripts/pushpals-cli";

const tempDirs: string[] = [];
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pushpals-clear-progress-"));
  tempDirs.push(root);
  const path = join(root, "runtime-data");
  mkdirSync(path);
  writeFileSync(join(path, "state.json"), "{}\n");
  return { root, path, label: "runtime data" };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await pause(5);
  expect(predicate()).toBe(true);
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("CLI clear asynchronous deletion and progress", () => {
  test("does not report removal before a deferred asynchronous deletion completes", async () => {
    const target = fixture();
    const entered = latch();
    const deletion = latch();
    let settled = false;
    const pending = removeCliClearTarget(target, {
      removePath: async (path) => {
        entered.release();
        await deletion.promise;
        await rm(path, { recursive: true, force: true });
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    try {
      await entered.promise;
      await pause(15);
      expect(settled).toBe(false);
      expect(existsSync(target.path)).toBe(true);
      deletion.release();
      expect(await pending).toBe("removed");
      expect(existsSync(target.path)).toBe(false);
    } finally {
      deletion.release();
      await pending;
    }
  });

  test("awaits asynchronous rejection before retrying a transient Windows lock", async () => {
    const target = fixture();
    const entered = latch();
    const lockedAttempt = latch();
    const delays: number[] = [];
    let attempts = 0;
    const pending = removeCliClearTarget(target, {
      maxAttempts: 3,
      retryDelayMs: 7,
      sleep: async (ms) => {
        delays.push(ms);
      },
      removePath: async (path) => {
        attempts += 1;
        if (attempts === 1) {
          entered.release();
          await lockedAttempt.promise;
          throw new Error(`EPERM: operation not permitted, rmdir '${path}'`);
        }
        await rm(path, { recursive: true, force: true });
      },
    });
    try {
      await entered.promise;
      await pause(15);
      expect(attempts).toBe(1);
      expect(delays).toEqual([]);
      lockedAttempt.release();
      expect(await pending).toBe("removed");
      expect(attempts).toBe(2);
      expect(delays).toEqual([7]);
      expect(existsSync(target.path)).toBe(false);
    } finally {
      lockedAttempt.release();
      await pending;
    }
  });

  test("reports progress while pending, finishes each target before the next, and stops its timer", async () => {
    const first = fixture();
    const second = { ...fixture(), label: "SCM worktree" };
    const firstEntered = latch();
    const secondEntered = latch();
    const firstDeletion = latch();
    const secondDeletion = latch();
    const startedPaths: string[] = [];
    const lines: string[] = [];
    let settled = false;
    const pending = completeCliStateClear([first, second], [], (_level, line) => lines.push(line), {
      progressIntervalMs: 10,
      removeOptions: {
        removePath: async (path) => {
          startedPaths.push(path);
          if (path === first.path) {
            firstEntered.release();
            await firstDeletion.promise;
          } else {
            secondEntered.release();
            await secondDeletion.promise;
          }
          await rm(path, { recursive: true, force: true });
        },
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    try {
      await firstEntered.promise;
      // Start plus at least one heartbeat, without depending on progress wording.
      await waitUntil(() => lines.filter((line) => line.includes(first.label)).length >= 2);
      expect(startedPaths).toEqual([first.path]);
      expect(settled).toBe(false);
      expect(lines.some((line) => line.includes("Cleared runtime data:"))).toBe(false);
      expect(lines.some((line) => line.includes("Clear completed"))).toBe(false);

      firstDeletion.release();
      await secondEntered.promise;
      expect(lines.some((line) => line.includes("Cleared runtime data:"))).toBe(true);
      expect(startedPaths).toEqual([first.path, second.path]);
      expect(existsSync(first.path)).toBe(false);
      expect(existsSync(second.path)).toBe(true);
      await waitUntil(() => lines.filter((line) => line.includes(second.label)).length >= 2);
      expect(settled).toBe(false);
      expect(lines.some((line) => line.includes("Clear completed"))).toBe(false);

      secondDeletion.release();
      expect(await pending).toBe(0);
      expect(existsSync(second.path)).toBe(false);
      expect(lines.at(-1)).toBe("[pushpals] Clear completed.");
      const completedLineCount = lines.length;
      await pause(50);
      expect(lines).toHaveLength(completedLineCount);
    } finally {
      firstDeletion.release();
      secondDeletion.release();
      await pending;
    }
  });

  test("stops progress after asynchronous permission failure without claiming success", async () => {
    const target = fixture();
    const entered = latch();
    const deletion = latch();
    const lines: Array<{ level: string; line: string }> = [];
    let attempts = 0;
    const pending = completeCliStateClear(
      [target],
      [],
      (level, line) => lines.push({ level, line }),
      {
        progressIntervalMs: 10,
        removeOptions: {
          maxAttempts: 3,
          removePath: async () => {
            attempts += 1;
            entered.release();
            await deletion.promise;
            throw new Error("EACCES: permission denied");
          },
        },
      },
    );
    try {
      await entered.promise;
      await waitUntil(() => lines.filter(({ line }) => line.includes(target.label)).length >= 2);
      expect(lines.some(({ line }) => line.includes("Clear completed"))).toBe(false);
      deletion.release();
      expect(await pending).toBe(1);
      expect(attempts).toBe(1);
      expect(existsSync(target.path)).toBe(true);
      expect(lines.some(({ level, line }) => level === "error" && line.includes("EACCES"))).toBe(
        true,
      );
      expect(lines.some(({ line }) => line === "[pushpals] Clear completed.")).toBe(false);
      const completedLineCount = lines.length;
      await pause(50);
      expect(lines).toHaveLength(completedLineCount);
    } finally {
      deletion.release();
      await pending;
    }
  });

  test("removes live and dangling directory links without deleting their external fixture contents", async () => {
    const { root } = fixture();
    const outside = join(root, "outside-the-clear-target");
    const vanished = join(outside, "vanished");
    mkdirSync(vanished, { recursive: true });
    const sentinel = join(outside, "preserve.txt");
    writeFileSync(sentinel, "outside contents must survive\n");
    const liveLink = join(root, "live-link");
    const danglingLink = join(root, "dangling-link");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(outside, liveLink, linkType);
    symlinkSync(vanished, danglingLink, linkType);
    rmSync(vanished, { recursive: true });
    expect(existsSync(danglingLink)).toBe(false);
    expect(lstatSync(danglingLink).isSymbolicLink()).toBe(true);

    expect(await removeCliClearTarget({ label: "live state link", path: liveLink })).toBe(
      "removed",
    );
    expect(await removeCliClearTarget({ label: "dangling state link", path: danglingLink })).toBe(
      "removed",
    );
    expect(() => lstatSync(liveLink)).toThrow();
    expect(() => lstatSync(danglingLink)).toThrow();
    expect(readFileSync(sentinel, "utf8")).toBe("outside contents must survive\n");
  });

  test("an empty clear has no progress noise", async () => {
    const lines: string[] = [];
    expect(
      await completeCliStateClear([], [], (_level, line) => lines.push(line), {
        progressIntervalMs: 10,
      }),
    ).toBe(0);
    await pause(30);
    expect(lines).toEqual(["[pushpals] Clear completed."]);
  });
});
