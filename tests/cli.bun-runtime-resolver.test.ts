import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";

type BunCandidate = {
  command: string;
  source: string;
  shell: boolean;
};

type ProbeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error & { code?: string };
};

type BunSelection = {
  ok: boolean;
  compatible: boolean;
  timedOut: boolean;
  budgetExhausted: boolean;
  command: string;
  shell: boolean;
  version: string;
  attempts: Array<
    BunCandidate & {
      runnable: boolean;
      timedOut: boolean;
      version: string;
      detail: string;
      timeoutMs: number;
    }
  >;
};

const require = createRequire(import.meta.url);
const resolver = require(
  join(import.meta.dir, "..", "packages", "cli", "bin", "bun-runtime.cjs"),
) as {
  buildBunVersionProbeInvocation: (candidate: BunCandidate) => {
    command: string;
    args: string[];
    shell: boolean;
  };
  enumerateWindowsBunCandidates: (
    whereOutput: string,
    options?: {
      explicitBunBin?: string;
      pathExists?: (path: string) => boolean;
    },
  ) => BunCandidate[];
  selectCompatibleBunRuntime: (
    candidates: BunCandidate[],
    options: {
      minimumVersion: string;
      timeoutMs: number;
      probe: (candidate: BunCandidate, timeoutMs: number) => ProbeResult;
      now?: () => number;
    },
  ) => BunSelection;
  versionAtLeast: (actual: string, minimum: string) => boolean;
};

const {
  buildBunVersionProbeInvocation,
  enumerateWindowsBunCandidates,
  selectCompatibleBunRuntime,
  versionAtLeast,
} = resolver;

describe("CLI Bun runtime resolver", () => {
  test("compares stable Bun versions numerically", () => {
    expect(versionAtLeast("1.3.14", "1.3.14")).toBe(true);
    expect(versionAtLeast("1.4.0", "1.3.14")).toBe(true);
    expect(versionAtLeast("1.3.8", "1.3.14")).toBe(false);
    expect(versionAtLeast("not-a-version", "1.3.14")).toBe(false);
  });

  test("enumerates PATH executables and deduplicates npm shim targets", () => {
    const legacyBun = String.raw`C:\Users\dev\.bun\bin\bun.exe`;
    const npmShim = String.raw`C:\Users\dev\AppData\Roaming\npm\bun`;
    const npmCmdShim = String.raw`C:\Users\dev\AppData\Roaming\npm\bun.cmd`;
    const npmBun = String.raw`C:\Users\dev\AppData\Roaming\npm\node_modules\bun\bin\bun.exe`;
    const existing = new Set([legacyBun, npmBun].map((path) => path.toLowerCase()));

    const candidates = enumerateWindowsBunCandidates(
      [legacyBun, npmShim, npmCmdShim].join("\r\n"),
      { pathExists: (path) => existing.has(path.toLowerCase()) },
    );

    expect(candidates).toEqual([
      { command: legacyBun, source: "PATH", shell: false },
      { command: npmBun, source: "npm-shim", shell: false },
    ]);
  });

  test("resolves a project-local npm shim to its package executable", () => {
    const localShim = String.raw`C:\repo\node_modules\.bin\bun.cmd`;
    const localBun = String.raw`C:\repo\node_modules\bun\bin\bun.exe`;

    const candidates = enumerateWindowsBunCandidates(localShim, {
      pathExists: (path) => path.toLowerCase() === localBun.toLowerCase(),
    });

    expect(candidates).toEqual([{ command: localBun, source: "npm-shim", shell: false }]);
  });

  test("uses a Windows shell only for the unresolved PATH fallback", () => {
    const [fallback] = enumerateWindowsBunCandidates("", { pathExists: () => false });

    expect(fallback).toEqual({ command: "bun", source: "PATH-fallback", shell: true });
    expect(buildBunVersionProbeInvocation(fallback!)).toEqual({
      command: "bun --version",
      args: [],
      shell: true,
    });
    expect(
      buildBunVersionProbeInvocation({
        command: "C:\\tools\\bun.exe",
        source: "PATH",
        shell: false,
      }),
    ).toEqual({
      command: "C:\\tools\\bun.exe",
      args: ["--version"],
      shell: false,
    });
  });

  test("uses an explicit PUSHPALS_BUN_BIN without consulting PATH candidates", () => {
    const explicitBun = String.raw`D:\tools\bun-1.3.14\bun.exe`;
    const candidates = enumerateWindowsBunCandidates(String.raw`C:\old\bun.exe`, {
      explicitBunBin: explicitBun,
      pathExists: () => true,
    });

    expect(candidates).toEqual([
      { command: explicitBun, source: "PUSHPALS_BUN_BIN", shell: false },
    ]);

    const result = selectCompatibleBunRuntime(candidates, {
      minimumVersion: "1.3.14",
      timeoutMs: 10_000,
      probe: () => ({ status: 0, stdout: "1.3.8" }),
    });
    expect(result.compatible).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.command).toBe(explicitBun);
  });

  test("skips an outdated PATH Bun and selects a later compatible npm Bun", () => {
    const candidates: BunCandidate[] = [
      { command: "C:\\legacy\\bun.exe", source: "PATH", shell: false },
      { command: "C:\\npm\\bun.exe", source: "npm-shim", shell: false },
    ];
    const versions: Record<string, string> = {
      "C:\\legacy\\bun.exe": "1.3.8",
      "C:\\npm\\bun.exe": "1.3.14",
    };

    const result = selectCompatibleBunRuntime(candidates, {
      minimumVersion: "1.3.14",
      timeoutMs: 10_000,
      probe: (candidate) => ({ status: 0, stdout: versions[candidate.command] }),
    });

    expect(result.compatible).toBe(true);
    expect(result.command).toBe("C:\\npm\\bun.exe");
    expect(result.version).toBe("1.3.14");
    expect(result.attempts.map((attempt) => attempt.version)).toEqual(["1.3.8", "1.3.14"]);
  });

  test("preserves PATH precedence once the first candidate is compatible", () => {
    const probes: string[] = [];
    const candidates: BunCandidate[] = [
      { command: "C:\\preferred\\bun.exe", source: "PATH", shell: false },
      { command: "C:\\later\\bun.exe", source: "PATH", shell: false },
    ];

    const result = selectCompatibleBunRuntime(candidates, {
      minimumVersion: "1.3.14",
      timeoutMs: 10_000,
      probe: (candidate) => {
        probes.push(candidate.command);
        return { status: 0, stdout: "1.3.14" };
      },
    });

    expect(result.command).toBe("C:\\preferred\\bun.exe");
    expect(probes).toEqual(["C:\\preferred\\bun.exe"]);
  });

  test("shares one bounded timeout budget across all candidate probes", () => {
    let clockMs = 0;
    const observedTimeouts: number[] = [];
    const timeoutError = Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" });
    const candidates: BunCandidate[] = [
      { command: "C:\\legacy\\bun.exe", source: "PATH", shell: false },
      { command: "C:\\npm\\bun.exe", source: "npm-shim", shell: false },
    ];

    const result = selectCompatibleBunRuntime(candidates, {
      minimumVersion: "1.3.14",
      timeoutMs: 1_000,
      now: () => clockMs,
      probe: (candidate, timeoutMs) => {
        observedTimeouts.push(timeoutMs);
        if (candidate.command.includes("legacy")) {
          clockMs += 800;
          return { status: 0, stdout: "1.3.8" };
        }
        clockMs += timeoutMs;
        return { status: null, error: timeoutError };
      },
    });

    expect(observedTimeouts).toEqual([1_000, 200]);
    expect(result.compatible).toBe(false);
    expect(result.version).toBe("1.3.8");
    expect(result.timedOut).toBe(true);
    expect(result.budgetExhausted).toBe(true);
    expect(result.attempts[1]?.detail).toContain("probe timed out");
  });

  test("retains every incompatible candidate for actionable diagnostics", () => {
    const candidates: BunCandidate[] = [
      { command: "C:\\one\\bun.exe", source: "PATH", shell: false },
      { command: "C:\\two\\bun.exe", source: "PATH", shell: false },
    ];

    const result = selectCompatibleBunRuntime(candidates, {
      minimumVersion: "1.3.14",
      timeoutMs: 10_000,
      probe: (candidate) => ({
        status: 0,
        stdout: candidate.command.includes("one") ? "1.3.8" : "1.3.9",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.compatible).toBe(false);
    expect(result.version).toBe("1.3.8");
    expect(result.attempts.map(({ command, version }) => ({ command, version }))).toEqual([
      { command: "C:\\one\\bun.exe", version: "1.3.8" },
      { command: "C:\\two\\bun.exe", version: "1.3.9" },
    ]);
  });
});
