import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join, parse, sep } from "path";
import { completeCliStateClear, removeCliClearTarget } from "../scripts/pushpals-cli";
import { removeCliTreeBounded } from "../scripts/cli_clear_remove";

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

describe("CLI clear bounded subtree removal", () => {
  function dependencyFixture() {
    const target = fixture();
    for (let index = 0; index < 12; index += 1) {
      const packageRoot = join(
        target.path,
        "node_modules",
        ".bun",
        `dependency-${index}@1.0.0`,
        "node_modules",
        `dependency-${index}`,
      );
      mkdirSync(join(packageRoot, "dist", "nested"), { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), '{"version":"1.0.0"}\n');
      writeFileSync(join(packageRoot, "dist", "nested", "index.js"), "export default 1;\n");
    }
    return target;
  }

  test("removes an actual deep dependency-shaped tree and its empty parents", async () => {
    const target = dependencyFixture();
    const outside = join(target.root, "keep.txt");
    writeFileSync(outside, "unrelated fixture content\n");

    await removeCliTreeBounded(target.path);

    expect(existsSync(target.path)).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("unrelated fixture content\n");
  });

  test("allows a preexisting parent-directory alias without removing the alias or siblings", async () => {
    const target = dependencyFixture();
    const physicalParent = join(target.root, "physical-parent");
    mkdirSync(physicalParent);
    const physicalTarget = join(physicalParent, "runtime-data");
    renameSync(target.path, physicalTarget);
    const sentinel = join(physicalParent, "preserve.txt");
    writeFileSync(sentinel, "sibling contents survive parent alias resolution\n");
    const alias = join(target.root, "parent-alias");
    symlinkSync(physicalParent, alias, process.platform === "win32" ? "junction" : "dir");

    await removeCliTreeBounded(join(alias, "runtime-data"));

    expect(existsSync(physicalTarget)).toBe(false);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe(
      "sibling contents survive parent alias resolution\n",
    );
  });

  test("rejects a filesystem root before invoking native deletion", async () => {
    const target = fixture();
    let removalCalls = 0;
    await expect(
      removeCliTreeBounded(parse(target.path).root, {
        removePath: async () => {
          removalCalls += 1;
        },
      }),
    ).rejects.toThrow("Refusing to clear filesystem root");
    expect(removalCalls).toBe(0);
    expect(existsSync(target.path)).toBe(true);
  });

  test("missing roots and empty directory trees are idempotent", async () => {
    const target = fixture();
    const empty = join(target.root, "empty-tree");
    mkdirSync(join(empty, "nested", "empty"), { recursive: true });
    let removalCalls = 0;
    const options = {
      removePath: async () => {
        removalCalls += 1;
      },
    };

    await removeCliTreeBounded(join(target.root, "never-created"), options);
    await removeCliTreeBounded(empty, options);
    await removeCliTreeBounded(empty, options);

    expect(removalCalls).toBe(0);
    expect(existsSync(empty)).toBe(false);
    expect(readFileSync(join(target.path, "state.json"), "utf8")).toBe("{}\n");
  });

  test("refuses newly scheduled removals through an expanded parent replaced by a junction", async () => {
    const target = fixture();
    const expandedParent = join(target.path, "expanded-parent");
    const outside = join(target.root, "external-substitution-target");
    mkdirSync(expandedParent);
    mkdirSync(outside);
    for (let index = 0; index < 12; index += 1) {
      const name = `entry-${index}.txt`;
      writeFileSync(join(expandedParent, name), "original clear target\n");
      writeFileSync(join(outside, name), "external content must survive\n");
    }
    const initialBatch = latch();
    let started = 0;
    let completedFilesystemWork = 0;
    const pending = removeCliTreeBounded(target.path, {
      removePath: async (path) => {
        started += 1;
        await rm(path, { recursive: true, force: true });
        completedFilesystemWork += 1;
        // Hold the first pool batch after its filesystem operations, before
        // workers can schedule another path through the substituted ancestor.
        await initialBatch.promise;
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await waitUntil(() => completedFilesystemWork === 4);
      renameSync(expandedParent, join(target.root, "detached-original-parent"));
      symlinkSync(outside, expandedParent, process.platform === "win32" ? "junction" : "dir");
      initialBatch.release();

      const failure = await pending;
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain(
        "Refusing to clear a directory whose type or resolved path changed",
      );
      expect(started).toBe(4);
      expect(lstatSync(expandedParent).isSymbolicLink()).toBe(true);
      for (let index = 0; index < 12; index += 1) {
        expect(readFileSync(join(outside, `entry-${index}.txt`), "utf8")).toBe(
          "external content must survive\n",
        );
      }
    } finally {
      initialBatch.release();
      await pending;
    }
  });

  test("nested live and dangling links never traverse outside the clear target", async () => {
    const target = dependencyFixture();
    const outside = join(target.root, "external-dependencies");
    const vanished = join(outside, "vanished");
    mkdirSync(vanished, { recursive: true });
    const sentinel = join(outside, "keep.txt");
    writeFileSync(sentinel, "linked contents must survive\n");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    const deepParent = join(
      target.path,
      "node_modules",
      ".bun",
      "dependency-0@1.0.0",
      "node_modules",
    );
    // Exercise links the shallow planner sees and links left to native subtree removal.
    for (const parent of [target.path, deepParent]) {
      symlinkSync(outside, join(parent, "live-link"), linkType);
      symlinkSync(vanished, join(parent, "dangling-link"), linkType);
    }
    rmSync(vanished, { recursive: true });
    expect(lstatSync(join(deepParent, "dangling-link")).isSymbolicLink()).toBe(true);

    await removeCliTreeBounded(target.path);

    expect(existsSync(target.path)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("linked contents must survive\n");
  });

  test("limits native deletion to four disjoint subtrees and awaits every deletion", async () => {
    const target = dependencyFixture();
    const deletion = latch();
    const activePaths = new Set<string>();
    let peakActive = 0;
    let started = 0;
    let settled = false;
    const pending = removeCliTreeBounded(target.path, {
      removePath: async (path) => {
        for (const active of activePaths) {
          expect(path).not.toBe(active);
          expect(path.startsWith(`${active}${sep}`)).toBe(false);
          expect(active.startsWith(`${path}${sep}`)).toBe(false);
        }
        started += 1;
        activePaths.add(path);
        peakActive = Math.max(peakActive, activePaths.size);
        try {
          await deletion.promise;
          await rm(path, { recursive: true, force: true });
        } finally {
          activePaths.delete(path);
        }
      },
    }).then(() => {
      settled = true;
    });
    try {
      await waitUntil(() => activePaths.size === 4);
      await pause(20);
      expect(started).toBe(4);
      expect(peakActive).toBe(4);
      expect(settled).toBe(false);
      expect(existsSync(target.path)).toBe(true);
      deletion.release();
      await pending;
      expect(started).toBeGreaterThan(4);
      expect(peakActive).toBe(4);
      expect(activePaths.size).toBe(0);
      expect(existsSync(target.path)).toBe(false);
    } finally {
      deletion.release();
      await pending.catch(() => {});
    }
  });

  test("stops scheduling after a failure but drains in-flight removals before rejecting", async () => {
    const target = dependencyFixture();
    const failDeletion = latch();
    const siblingDeletion = latch();
    const failure = new Error("EACCES: injected subtree permission failure");
    let active = 0;
    let started = 0;
    let failureThrown = false;
    let settled = false;
    const pending = removeCliTreeBounded(target.path, {
      removePath: async (path) => {
        const ordinal = ++started;
        active += 1;
        try {
          if (ordinal === 1) {
            await failDeletion.promise;
            failureThrown = true;
            throw failure;
          }
          await siblingDeletion.promise;
          await rm(path, { recursive: true, force: true });
        } finally {
          active -= 1;
        }
      },
    }).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await waitUntil(() => active === 4);
      failDeletion.release();
      await waitUntil(() => failureThrown && active === 3);
      await pause(20);
      expect(started).toBe(4);
      expect(settled).toBe(false);
      expect(existsSync(target.path)).toBe(true);
      siblingDeletion.release();
      expect(await pending).toBe(failure);
      expect(active).toBe(0);
      expect(started).toBe(4);
      // Failure must leave expanded parents for the caller's bounded retry.
      expect(existsSync(target.path)).toBe(true);
    } finally {
      failDeletion.release();
      siblingDeletion.release();
      await pending;
    }
  });

  test("a transient lock retry starts only after all prior subtree deletions settle", async () => {
    const target = dependencyFixture();
    const failDeletion = latch();
    const siblingDeletion = latch();
    let attempts = 0;
    let active = 0;
    let firstAttemptStarted = 0;
    let failureThrown = false;
    const retryActiveCounts: number[] = [];
    const delays: number[] = [];
    const pending = removeCliClearTarget(target, {
      maxAttempts: 2,
      retryDelayMs: 7,
      sleep: async (ms) => {
        delays.push(ms);
      },
      removePath: async (path) => {
        const attempt = ++attempts;
        retryActiveCounts.push(active);
        await removeCliTreeBounded(path, {
          removePath: async (subtree) => {
            const ordinal = attempt === 1 ? ++firstAttemptStarted : 0;
            active += 1;
            try {
              if (attempt === 1 && ordinal === 1) {
                await failDeletion.promise;
                failureThrown = true;
                throw new Error(`EPERM: operation not permitted, rmdir '${subtree}'`);
              }
              if (attempt === 1) await siblingDeletion.promise;
              await rm(subtree, { recursive: true, force: true });
            } finally {
              active -= 1;
            }
          },
        });
      },
    });
    try {
      await waitUntil(() => active === 4);
      failDeletion.release();
      await waitUntil(() => failureThrown && active === 3);
      await pause(20);
      expect(attempts).toBe(1);
      expect(delays).toEqual([]);
      siblingDeletion.release();
      expect(await pending).toBe("removed");
      expect(attempts).toBe(2);
      expect(retryActiveCounts).toEqual([0, 0]);
      expect(delays).toEqual([7]);
      expect(active).toBe(0);
      expect(existsSync(target.path)).toBe(false);
    } finally {
      failDeletion.release();
      siblingDeletion.release();
      await pending;
    }
  });
});
