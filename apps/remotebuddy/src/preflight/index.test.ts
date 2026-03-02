import { describe, expect, test } from "bun:test";
import {
  createBunVersionCheck,
  createDockerCheck,
  createEnvCheck,
  runPreflight,
  type EnvRequirement,
  type FailureTaxonomyEntry,
  type PreflightContext,
} from "./index.js";

function mockContext(overrides: Partial<PreflightContext> = {}): PreflightContext {
  return {
    env: {},
    bunVersion: "1.1.0",
    minBunVersion: "1.1.0",
    requiredEnvVars: [],
    detectBinary: () => null,
    runCommand: async () => ({
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }),
    now: () => new Date("2026-03-02T00:00:00.000Z"),
    telemetryComponent: "remotebuddy.preflight.test",
    ...overrides,
  };
}

describe("preflight checks", () => {
  test("Bun version check enforces minimum runtime version", async () => {
    const summary = await createBunVersionCheck("1.1.0").run(
      mockContext({ bunVersion: "1.0.5" }),
    );
    expect(summary.status).toBe("fail");
    expect(summary.failure?.taxonomyId).toBe(
      "remotebuddy.preflight.bun.version.unsupported",
    );
    expect(summary.detail).toContain("1.0.5");
  });

  test("env check lists missing variables with remediation", async () => {
    const requirements: EnvRequirement[] = [
      {
        name: "FOO_TOKEN",
        description: "Foo API token",
        remediation: "Set FOO_TOKEN in your .env file.",
      },
      {
        name: "BAR_URL",
        description: "Bar service URL",
        remediation: "Export BAR_URL to point at the Bar service.",
      },
    ];
    const summary = await createEnvCheck(requirements).run(
      mockContext({ env: { FOO_TOKEN: "ok" } }),
    );
    expect(summary.status).toBe("fail");
    expect(summary.detail).toContain("BAR_URL");
    expect(summary.failure?.taxonomyId).toBe("remotebuddy.preflight.env.missing");
    expect(summary.remediation).toContain("BAR_URL");
  });

  test("docker check surfaces CLI info when available", async () => {
    const summary = await createDockerCheck().run(
      mockContext({
        detectBinary: () => "/usr/bin/docker",
        runCommand: async () => ({
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            Client: { Version: "26.1.1" },
            Server: { Version: "26.0.0" },
          }),
          stderr: "",
          timedOut: false,
        }),
      }),
    );
    expect(summary.status).toBe("pass");
    expect(summary.observed?.clientVersion).toBe("26.1.1");
  });

  test("runPreflight emits telemetry and aggregates failures", async () => {
    const failures: FailureTaxonomyEntry[] = [
      {
        taxonomyId: "remotebuddy.preflight.internal_error",
        checkId: "fail-check",
        detail: "forced failure",
        remediation: "fix mock",
        severity: "fatal",
      },
    ];

    const result = await runPreflight({
      env: {},
      bunVersion: "1.1.0",
      detectBinary: () => null,
      runCommand: async () => ({
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
      now: () => new Date("2026-03-02T00:00:00.000Z"),
      telemetryComponent: "remotebuddy.preflight.test",
      checks: [
        {
          id: "pass-check",
          name: "pass-check",
          async run() {
            return { status: "pass", detail: "ok" };
          },
        },
        {
          id: "fail-check",
          name: "fail-check",
          async run() {
            return {
              status: "fail",
              detail: "forced failure",
              failure: failures[0],
            };
          },
        },
      ],
    });

    const completed = result.telemetry.filter((event) => event.event === "check_result");
    expect(completed).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  test("runPreflight default checks succeed when dependencies are satisfied", async () => {
    const dockerInvocations: string[][] = [];
    const result = await runPreflight({
      env: {
        PUSHPALS_AUTH_TOKEN: "token",
        REMOTE_STABLE_ID: "rb-dev",
        WORKERPALS_API_URL: "http://localhost:3002",
        SERVER_BASE_URL: "http://localhost:3001",
      },
      bunVersion: "1.1.2",
      detectBinary: () => "/usr/bin/docker",
      runCommand: async (args) => {
        dockerInvocations.push(args);
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            Client: { Version: "26.1.1" },
            Server: { Version: "26.0.0" },
          }),
          stderr: "",
          timedOut: false,
        };
      },
      now: () => new Date("2026-03-02T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.checks.map((check) => check.status)).toEqual(["pass", "pass", "pass"]);
    expect(result.telemetry.filter((event) => event.event === "check_result")).toHaveLength(3);
    expect(dockerInvocations[0]).toEqual([
      "/usr/bin/docker",
      "version",
      "--format",
      "{{json .}}",
    ]);
  });

  test("runPreflight synthesizes taxonomy entries when a check fails without one", async () => {
    const result = await runPreflight({
      env: {},
      bunVersion: "1.1.0",
      detectBinary: () => null,
      runCommand: async () => ({
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
      now: () => new Date("2026-03-02T00:00:00.000Z"),
      checks: [
        {
          id: "broken-check",
          name: "Broken check",
          async run() {
            return {
              status: "fail",
              detail: "custom failure detail",
            };
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      taxonomyId: "remotebuddy.preflight.internal_error",
      checkId: "broken-check",
      detail: "custom failure detail",
    });
    const telemetryEntry = result.telemetry.find(
      (event) => event.event === "check_result" && event.checkId === "broken-check",
    );
    expect(telemetryEntry?.failureTaxonomy).toBe("remotebuddy.preflight.internal_error");
  });
});
