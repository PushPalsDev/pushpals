import { describe, expect, test } from "bun:test";
import {
  buildHarnessWindowsTreeKillArgv,
  terminateHarnessProcessTree,
} from "../scripts/reliability-harness";

describe("reliability harness process cleanup", () => {
  test("uses taskkill tree termination on Windows and confirms target exit", async () => {
    const spawned: string[][] = [];
    const target = {
      pid: 4321,
      exited: Promise.resolve(124),
      kill() {},
    };
    const settled = await terminateHarnessProcessTree(target, {
      platform: "win32",
      graceMs: 20,
      spawn: (argv) => {
        spawned.push(argv);
        return { pid: 999, exited: Promise.resolve(0), kill() {} };
      },
    });

    expect(spawned).toEqual([buildHarnessWindowsTreeKillArgv(4321)]);
    expect(settled).toBe(true);
  });

  test("reports an unsettled timeout process instead of silently continuing", async () => {
    let directKills = 0;
    const never = new Promise<number>(() => {});
    const settled = await terminateHarnessProcessTree(
      {
        pid: 4322,
        exited: never,
        kill() {
          directKills += 1;
        },
      },
      {
        platform: "win32",
        graceMs: 5,
        spawn: () => ({ pid: 998, exited: Promise.resolve(0), kill() {} }),
      },
    );

    expect(settled).toBe(false);
    expect(directKills).toBe(1);
  });

  test("terminates the detached POSIX process group before falling back to the root", async () => {
    const groupSignals: Array<[number, NodeJS.Signals]> = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const settled = await terminateHarnessProcessTree(
      {
        pid: 4323,
        exited,
        kill() {
          throw new Error("root-only kill must not be needed");
        },
      },
      {
        platform: "linux",
        graceMs: 20,
        killGroup: (pid, signal) => {
          groupSignals.push([pid, signal]);
          if (signal === "SIGTERM") resolveExit(143);
        },
      },
    );

    expect(settled).toBe(true);
    expect(groupSignals).toEqual([[4323, "SIGTERM"]]);
  });
});
