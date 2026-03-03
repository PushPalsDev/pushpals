import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  notifyDependencyPreflightBlock,
  runPreflightChecks,
  type DependencyConfigOverrides,
} from "./preflight.js";

const bunExec = process.execPath;
const PREFLIGHT_OVERRIDES_ENV = "PUSHPALS_PREFLIGHT_TEST_OVERRIDES";
const PREFLIGHT_FORCE_SNAPSHOT_ERROR_ENV = "PUSHPALS_PREFLIGHT_TEST_FORCE_SNAPSHOT_ERROR";
const PREFLIGHT_FORCE_RUN_ERROR_ENV = "PUSHPALS_PREFLIGHT_TEST_FORCE_RUN_ERROR";
const PREFLIGHT_FORCE_HEALTHY_ERROR_ENV = "PUSHPALS_PREFLIGHT_TEST_FORCE_HEALTHY_ERROR";
const originalFetch = globalThis.fetch;

function createTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "preflight-test-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tmp", version: "1.0.0" }));
  return root;
}

function ensureModule(root: string, name: string): void {
  const moduleDir = join(root, "node_modules", name);
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  writeFileSync(join(moduleDir, "index.js"), "module.exports = {};\n");
}

function buildOverrides(root: string, moduleName = "example"): DependencyConfigOverrides {
  return {
    probes: [
      {
        label: `${moduleName} module`,
        fromDir: root,
        moduleSpecifier: moduleName,
      },
    ],
    rootLinks: [
      {
        path: join(root, "node_modules", moduleName),
        label: `${moduleName} workspace link`,
      },
    ],
    nodeModules: [
      {
        nodeModulesPath: join(root, "node_modules"),
        resolveFromDir: root,
        moduleSpecifier: moduleName,
        label: "root node_modules",
        moduleLabel: `${moduleName} module`,
      },
    ],
  };
}

function buildEnv(
  overrides: DependencyConfigOverrides,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    [PREFLIGHT_OVERRIDES_ENV]: JSON.stringify(overrides),
    ...extra,
  };
}

afterEach(() => {
  delete process.env[PREFLIGHT_OVERRIDES_ENV];
  delete process.env[PREFLIGHT_FORCE_SNAPSHOT_ERROR_ENV];
  delete process.env[PREFLIGHT_FORCE_RUN_ERROR_ENV];
  delete process.env[PREFLIGHT_FORCE_HEALTHY_ERROR_ENV];
  globalThis.fetch = originalFetch;
});

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [bunExec, "run", "apps/remotebuddy/src/preflight.ts", ...args],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("runPreflightChecks", () => {
  test("returns ok when dependency overrides are satisfied", async () => {
    const root = createTempRepo();
    ensureModule(root, "example");
    const overrides = buildOverrides(root);

    const result = await runPreflightChecks({ repoRoot: root, configOverrides: overrides });
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.checks).toHaveLength(1);
  });

  test("surfaces dependency issues when modules are missing", async () => {
    const root = createTempRepo();
    const overrides = buildOverrides(root, "missing-module");

    const result = await runPreflightChecks({ repoRoot: root, configOverrides: overrides });
    expect(result.ok).toBe(false);
    expect(result.failure?.issues?.length ?? 0).toBeGreaterThan(0);
    const issue = result.failure?.issues?.[0];
    expect(issue?.category).toBe("module_probe");
    expect(issue?.detail).toContain("missing-module");
  });

  test("returns deterministic failure when snapshot collection throws", async () => {
    const root = createTempRepo();
    process.env[PREFLIGHT_FORCE_SNAPSHOT_ERROR_ENV] = "1";

    const result = await runPreflightChecks({ repoRoot: root });
    expect(result.ok).toBe(false);
    expect(result.failure?.detail).toContain("Forced dependency snapshot failure");
  });

  test("returns deterministic failure when dependency health evaluation throws", async () => {
    const root = createTempRepo();
    ensureModule(root, "example");
    const overrides = buildOverrides(root);
    process.env[PREFLIGHT_FORCE_HEALTHY_ERROR_ENV] = "1";

    const result = await runPreflightChecks({ repoRoot: root, configOverrides: overrides });
    expect(result.ok).toBe(false);
    expect(result.failure?.detail).toContain("dependencyPreflight.healthy() failed");
  });
});

describe("preflight CLI", () => {
  test("prints human-readable PASS output and exits zero when dependencies are healthy", async () => {
    const root = createTempRepo();
    ensureModule(root, "example");
    const overrides = buildOverrides(root);
    const { exitCode, stdout, stderr } = await runCli(["--repo", root], buildEnv(overrides));

    expect(exitCode).toBe(0);
    expect(stderr.trim()).toBe("");
    expect(stdout).toContain("[PASS] Workspace dependency health");
  });

  test("prints FAIL output and exits 2 when dependencies are missing", async () => {
    const root = createTempRepo();
    const overrides = buildOverrides(root, "missing-module");
    const { exitCode, stdout } = await runCli(["--repo", root], buildEnv(overrides));

    expect(exitCode).toBe(2);
    expect(stdout).toContain("[FAIL] Workspace dependency health");
    expect(stdout).toContain("missing-module");
  });

  test("emits JSON when checks pass", async () => {
    const root = createTempRepo();
    ensureModule(root, "example");
    const overrides = buildOverrides(root);
    const { exitCode, stdout } = await runCli(["--json", "--repo", root], buildEnv(overrides));

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.checks?.[0]?.status).toBe("pass");
  });

  test("emits JSON and exits 2 when dependencies fail", async () => {
    const root = createTempRepo();
    const overrides = buildOverrides(root, "missing-module");
    const { exitCode, stdout } = await runCli(["--json", "--repo", root], buildEnv(overrides));

    expect(exitCode).toBe(2);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.failure?.detail).toContain("missing-module");
  });

  test("exits with code 1 and reports crash details when the runner throws", async () => {
    const root = createTempRepo();
    ensureModule(root, "example");
    const overrides = buildOverrides(root);
    const env = buildEnv(overrides, { [PREFLIGHT_FORCE_RUN_ERROR_ENV]: "1" });
    const { exitCode, stdout, stderr } = await runCli(["--repo", root], env);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Preflight checks crashed");
    expect(stderr).toContain("[preflight]");
  });

  test("prints usage text for --help and exits zero", async () => {
    const { exitCode, stdout, stderr } = await runCli(["--help"], {});
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: bun run apps/remotebuddy/src/preflight.ts");
    expect(stderr.trim()).toBe("");
  });

  test("fails fast when --repo is missing a path argument", async () => {
    const { exitCode, stderr } = await runCli(["--repo"], {});
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--repo flag requires a path argument");
  });

  test("warns about unknown flags but still runs checks", async () => {
    const root = createTempRepo();
    ensureModule(root, "example");
    const overrides = buildOverrides(root);
    const { exitCode, stdout, stderr } = await runCli(
      ["--unknown", "--repo", root],
      buildEnv(overrides),
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[PASS]");
    expect(stderr).toContain("Ignoring unknown flag: --unknown");
  });
});

describe("notifyDependencyPreflightBlock", () => {
  const failure = {
    id: "dependency",
    label: "Workspace dependency health",
    detail: "Dependencies missing",
  };

  test("logs an error when the API responds with a non-2xx status", async () => {
    const errors: string[] = [];
    const warnings: string[] = [];
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => "upstream error",
      })) as typeof fetch;

    const result = await notifyDependencyPreflightBlock({
      server: "https://example.com",
      requestId: "req-123",
      failure,
      logger: {
        log: () => {},
        warn: (msg: string) => warnings.push(msg),
        error: (msg: string) => errors.push(msg),
      },
    });

    expect(errors.join(" ")).toContain("HTTP 502");
    expect(result.delivered).toBe(false);
    expect(result.status).toBe(502);
    expect(warnings).toHaveLength(0);
  });

  test("logs an error when fetch throws", async () => {
    const errors: string[] = [];
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const result = await notifyDependencyPreflightBlock({
      server: "https://example.com",
      requestId: "req-456",
      failure,
      logger: {
        log: () => {},
        warn: () => {},
        error: (msg: string) => errors.push(msg),
      },
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("network down");
    expect(errors.join(" ")).toContain("network down");
  });

  test("sends expected payload and headers when notification succeeds", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const warnings: string[] = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const result = await notifyDependencyPreflightBlock({
      server: "https://example.com",
      requestId: "req-789",
      failure: { ...failure, issues: [{ category: "module_probe", label: "tsc", detail: "missing" }] },
      authHeaders: { Authorization: "Bearer secret" },
      logger: {
        log: () => {},
        warn: (msg: string) => warnings.push(msg),
        error: () => {},
      },
    });

    expect(result.delivered).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://example.com/requests/req-789/fail");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    const parsed = JSON.parse(String(requests[0]?.init?.body ?? "{}"));
    expect(parsed.detail).toBe(failure.detail);
    expect(Array.isArray(parsed.issues)).toBe(true);
    expect(warnings[0]).toContain("blocked due to dependency preflight failure");
  });
});
