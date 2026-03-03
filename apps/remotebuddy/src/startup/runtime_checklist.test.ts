import { describe, expect, test } from "bun:test";
import { runStartupChecklist, type StartupChecklistRunOptions } from "./runtime_checklist";

const baseOptions: StartupChecklistRunOptions = {
  repoPath: "/repo/example",
  serverUrl: "http://localhost:3001",
  checklist: {
    enabled: true,
    allowDirtyWorktree: false,
    alertsEndpoint: "",
    alertsLabelPrefix: "remote_",
    syntheticUrl: "",
    syntheticTimeoutMs: 1_000,
    syntheticProbeName: "probe.remote_startup",
  },
};

const cleanRepoGit = async (args: string[]) => {
  if (args.includes("--short")) {
    return { ok: true, stdout: "## main\n", stderr: "" };
  }
  if (args.includes("--abbrev-ref")) {
    return { ok: true, stdout: "main\n", stderr: "" };
  }
  if (args.includes("MERGE_HEAD")) {
    return { ok: false, stdout: "", stderr: "" };
  }
  return { ok: true, stdout: "", stderr: "" };
};

const dirtyRepoGit = async (args: string[]) => {
  if (args.includes("--short")) {
    return { ok: true, stdout: "## main\n M src/app.ts\n", stderr: "" };
  }
  if (args.includes("--abbrev-ref")) {
    return { ok: true, stdout: "main\n", stderr: "" };
  }
  if (args.includes("MERGE_HEAD")) {
    return { ok: false, stdout: "", stderr: "" };
  }
  return { ok: true, stdout: "", stderr: "" };
};

function makeSyntheticFetch(ok: boolean) {
  return async (url: string) => {
    if (url.includes("healthz")) {
      return ok
        ? new Response("ok", { status: 200 })
        : new Response("unhealthy", { status: 503 });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

describe("runStartupChecklist", () => {
  test("passes with clean repo and healthy endpoints", async () => {
    const logs: string[] = [];
    const result = await runStartupChecklist(baseOptions, {
      runGit: cleanRepoGit,
      fetchImpl: makeSyntheticFetch(true),
      now: (() => {
        let current = 0;
        return () => {
          current += 50;
          return current;
        };
      })(),
      log: (line) => logs.push(line),
    });
    expect(result?.ok).toBe(true);
    expect(logs.some((line) => line.includes("Startup checklist passed"))).toBe(true);
  });

  test("fails when repo is dirty and bypass is disabled", async () => {
    await expect(
      runStartupChecklist(baseOptions, {
        runGit: dirtyRepoGit,
        fetchImpl: makeSyntheticFetch(true),
        now: () => Date.now(),
        log: () => {},
      }),
    ).rejects.toThrow(/startup checklist blocked/i);
  });

  test("fails when alert endpoint reports active remote alerts", async () => {
    const options: StartupChecklistRunOptions = {
      ...baseOptions,
      checklist: {
        ...baseOptions.checklist,
        alertsEndpoint: "http://alerts.example/api/v2/alerts",
      },
    };
    const fetchCalls: string[] = [];
    const fetchImpl = async (url: string) => {
      fetchCalls.push(url);
      if (url.includes("alerts")) {
        return new Response(
          JSON.stringify([
            { labels: { alertname: "remote_queue_warning", severity: "warning" }, annotations: { summary: "queue pending high" } },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("ok", { status: 200 });
    };

    await expect(
      runStartupChecklist(options, {
        runGit: cleanRepoGit,
        fetchImpl,
        now: () => Date.now(),
        log: () => {},
      }),
    ).rejects.toThrow(/alerts/i);
    expect(fetchCalls.some((url) => url.includes("alerts"))).toBe(true);
  });

  test("skips entirely when disabled in config", async () => {
    const options: StartupChecklistRunOptions = {
      ...baseOptions,
      checklist: { ...baseOptions.checklist, enabled: false },
    };
    const logs: string[] = [];
    const result = await runStartupChecklist(options, {
      runGit: dirtyRepoGit,
      fetchImpl: makeSyntheticFetch(false),
      now: () => Date.now(),
      log: (line) => logs.push(line),
    });
    expect(result).toBeNull();
    expect(logs.some((line) => line.includes("disabled"))).toBe(true);
  });
});
