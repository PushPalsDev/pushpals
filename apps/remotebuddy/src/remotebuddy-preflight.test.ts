import { describe, expect, test } from "bun:test";
import {
  buildPreflightFailureLogPayload,
  buildPreflightFailureSignature,
  formatPreflightFailureContext,
  runRemoteBuddyPreflight,
  type RemoteBuddyPreflightConfig,
  type RemoteBuddyPreflightOptions,
  type RemoteBuddyPreflightFailure,
  REMOTEBUDDY_PREFLIGHT_REMEDIATION_FALLBACK,
} from "./remotebuddy_preflight.js";

function buildConfig(overrides: Partial<RemoteBuddyPreflightConfig> = {}): RemoteBuddyPreflightConfig {
  const base: RemoteBuddyPreflightConfig = {
    sessionId: "dev-session",
    authToken: "token-123",
    server: {
      url: "http://localhost:3001",
    },
    paths: {
      remotebuddyDbPath: "/tmp/remotebuddy.db",
    },
  };
  return { ...base, ...overrides };
}

function okEnv(): NodeJS.ProcessEnv {
  return {
    PUSHPALS_SERVER_URL: "http://localhost:3001",
    PUSHPALS_SESSION_ID: "session-alpha",
    PUSHPALS_AUTH_TOKEN: "token-from-env",
  };
}

function okGitRunner(): RemoteBuddyPreflightOptions["gitRunner"] {
  return async (_repo, args) => {
    if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "fatal: Needed a single revision" };
  };
}

const alwaysExists = async (): Promise<boolean> => true;
const alwaysWritable = async (): Promise<boolean> => true;
const neverWritable = async (): Promise<boolean> => false;
const repoWithGitExists = async (path: string): Promise<boolean> =>
  path === "/repo" || path === "/repo/.git";
const repoWithoutGitDir = async (path: string): Promise<boolean> => {
  if (path === "/repo") return true;
  return false;
};
const repoWithSequencerIndicator =
  (indicator: string): RemoteBuddyPreflightOptions["pathExists"] =>
  async (path: string) => {
    if (path === "/repo" || path === "/repo/.git") return true;
    if (path === `/repo/.git/${indicator}`) return true;
    return false;
  };

describe("remotebuddy-preflight runner", () => {
  test("remotebuddy-preflight: success path returns summary", async () => {
    const result = await runRemoteBuddyPreflight({
      env: okEnv(),
      config: buildConfig(),
      repoRoot: "/repo",
      gitRunner: okGitRunner(),
      pathExists: repoWithGitExists,
      ensureDirWritable: alwaysWritable,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.serverUrl).toBe("http://localhost:3001/");
      expect(result.summary.sessionId).toBe("session-alpha");
    }
  });

  test("remotebuddy-preflight: missing env is reported with remediation", async () => {
    const result = await runRemoteBuddyPreflight({
      env: {
        PUSHPALS_SERVER_URL: "",
        PUSHPALS_SESSION_ID: "",
        PUSHPALS_AUTH_TOKEN: "secret",
      },
      config: buildConfig(),
      repoRoot: "/repo",
      gitRunner: okGitRunner(),
      pathExists: alwaysExists,
      ensureDirWritable: alwaysWritable,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("missing_env");
      expect(result.failure.remediation).toContain("Export the missing variables");
    }
  });

  test("remotebuddy-preflight: dirty worktree blocks execution", async () => {
    const result = await runRemoteBuddyPreflight({
      env: okEnv(),
      config: buildConfig(),
      repoRoot: "/repo",
      gitRunner: async (_repo, args) => {
        if (args[0] === "status") {
          return { exitCode: 0, stdout: "M apps/remotebuddy/src/remotebuddy_main.ts\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "fatal: Needed a single revision" };
      },
      pathExists: alwaysExists,
      ensureDirWritable: alwaysWritable,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("sandbox_worktree_dirty");
      expect(result.failure.remediation).toMatch(/Commit|stash|reset/i);
    }
  });

  test("remotebuddy-preflight: missing auth token produces credential failure", async () => {
    const result = await runRemoteBuddyPreflight({
      env: {
        PUSHPALS_SERVER_URL: "http://localhost:3001",
        PUSHPALS_SESSION_ID: "session-alpha",
      },
      config: buildConfig({ authToken: "" }),
      repoRoot: "/repo",
      gitRunner: okGitRunner(),
      pathExists: repoWithGitExists,
      ensureDirWritable: alwaysWritable,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("missing_auth_token");
      expect(result.failure.category).toBe("credential");
      expect(result.failure.remediation.length).toBeGreaterThan(10);
    }
  });

  test("remotebuddy-preflight: invalid server URL is rejected", async () => {
    const result = await runRemoteBuddyPreflight({
      env: {
        ...okEnv(),
        PUSHPALS_SERVER_URL: "://bad",
      },
      config: buildConfig(),
      repoRoot: "/repo",
      gitRunner: okGitRunner(),
      pathExists: repoWithGitExists,
      ensureDirWritable: alwaysWritable,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_server_url");
      expect(result.failure.remediation).toMatch(/reachable http/);
    }
  });

  test("remotebuddy-preflight: non-http server schemes are rejected", async () => {
    const result = await runRemoteBuddyPreflight({
      env: {
        ...okEnv(),
        PUSHPALS_SERVER_URL: "ftp://localhost:2121",
      },
      config: buildConfig(),
      repoRoot: "/repo",
      gitRunner: okGitRunner(),
      pathExists: repoWithGitExists,
      ensureDirWritable: alwaysWritable,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_server_url");
      expect(result.failure.reason).toContain("http:// or https://");
      expect(result.failure.details?.protocol).toBe("ftp:");
    }
  });

  test("remotebuddy-preflight: rebase indicators block dispatch", async () => {
    const result = await runRemoteBuddyPreflight({
      env: okEnv(),
      config: buildConfig(),
      repoRoot: "/repo",
      gitRunner: okGitRunner(),
      pathExists: repoWithSequencerIndicator("rebase-apply"),
      ensureDirWritable: alwaysWritable,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("sandbox_merge_in_progress");
      expect(result.failure.reason).toContain("rebase");
      expect(result.failure.details?.indicator).toBe("rebase-apply");
      expect(result.failure.details?.operation).toBe("rebase");
    }
  });

  test("remotebuddy-preflight: unwritable db directory fails fast", async () => {
    const result = await runRemoteBuddyPreflight({
      env: okEnv(),
      config: buildConfig({ paths: { remotebuddyDbPath: "/tmp/remotebuddy/state.db" } }),
      repoRoot: "/repo",
      gitRunner: okGitRunner(),
      pathExists: repoWithGitExists,
      ensureDirWritable: neverWritable,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("sandbox_not_writable");
      expect(result.failure.details?.dbDir).toBe("/tmp/remotebuddy");
    }
  });

  test("remotebuddy-preflight: missing git directory is surfaced", async () => {
    const result = await runRemoteBuddyPreflight({
      env: okEnv(),
      config: buildConfig(),
      repoRoot: "/repo",
      gitRunner: okGitRunner(),
      pathExists: repoWithoutGitDir,
      ensureDirWritable: alwaysWritable,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("sandbox_git_missing");
      expect(result.failure.reason).toContain("not a git repository");
    }
  });

  test("remotebuddy-preflight: git unavailable surfaces failure payload", async () => {
    const gitRunner: RemoteBuddyPreflightOptions["gitRunner"] = async () => ({
      exitCode: 127,
      stdout: "",
      stderr: "git: command not found",
    });
    const result = await runRemoteBuddyPreflight({
      env: okEnv(),
      config: buildConfig(),
      repoRoot: "/repo",
      gitRunner,
      pathExists: repoWithGitExists,
      ensureDirWritable: alwaysWritable,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("git_unavailable");
      expect(result.failure.details?.stderr).toContain("git: command not found");
    }
  });

  test("remotebuddy-preflight: package script enforces deterministic filter", async () => {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const raw = await Bun.file(packageJsonUrl).text();
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["remotebuddy:preflight"]).toBeDefined();
    const script = pkg.scripts?.["remotebuddy:preflight"] ?? "";
    expect(script.startsWith("bun run test")).toBe(true);
    expect(script).toContain("--filter remotebuddy-preflight");
  });

  test("remotebuddy-preflight: failure payload exposes remediation fallback", () => {
    const payload = buildPreflightFailureLogPayload({
      code: "sandbox_git_missing",
      category: "sandbox",
      reason: "repo missing",
      remediation: "   ",
    });
    expect(payload.schemaVersion).toBeGreaterThan(0);
    expect(payload.remediation).toBe(REMOTEBUDDY_PREFLIGHT_REMEDIATION_FALLBACK);
    const context = formatPreflightFailureContext(payload);
    expect(context).toContain(payload.code);
    expect(context).toContain(payload.remediation);
  });

  test("remotebuddy-preflight: failure signature includes detail hash", () => {
    const failure: RemoteBuddyPreflightFailure = {
      code: "sandbox_not_writable",
      category: "sandbox",
      reason: "db dir locked",
      remediation: "fix perms",
      details: { dbDir: "/tmp/cache", attempt: true },
    };
    const payload = buildPreflightFailureLogPayload(failure);
    const reorderedPayload = {
      ...payload,
      details: { attempt: payload.details.attempt, dbDir: payload.details.dbDir },
    };
    const baseline = buildPreflightFailureSignature(payload);
    const reordered = buildPreflightFailureSignature(reorderedPayload);
    expect(baseline).toBe(reordered);
  });

  test("remotebuddy-preflight: failure signature shifts when details differ", () => {
    const missingAuth = buildPreflightFailureLogPayload({
      code: "missing_env",
      category: "env",
      reason: "Missing env",
      remediation: "set env",
      details: { missing: "PUSHPALS_AUTH_TOKEN" },
    });
    const missingServer = buildPreflightFailureLogPayload({
      code: "missing_env",
      category: "env",
      reason: "Missing env",
      remediation: "set env",
      details: { missing: "PUSHPALS_SERVER_URL" },
    });
    expect(buildPreflightFailureSignature(missingAuth)).not.toBe(
      buildPreflightFailureSignature(missingServer),
    );
  });
});
