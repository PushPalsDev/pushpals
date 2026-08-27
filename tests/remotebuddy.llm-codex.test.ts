import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OpenAiCodexCliClient, __TEST_ONLY__ } from "../apps/remotebuddy/src/llm";
import { SCM_REPAIR_AUTHORITY_SECRET_ENV } from "../packages/shared/src/scm_repair_authority";

const tempDirs: string[] = [];

function quoteArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function createFakeCodexScript(invocationLogPath = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-fake-codex-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-codex.ts");
  writeFileSync(
    scriptPath,
    `
import { appendFileSync } from "fs";

const args = Bun.argv.slice(2);
const invocationLogPath = ${JSON.stringify(invocationLogPath)};
const authorityKeys = Object.keys(process.env).filter(
  (key) => key.toLowerCase() === ${JSON.stringify(
    "PUSHPALS_SCM_REPAIR_AUTHORITY_SECRET".toLowerCase(),
  )},
);
if (invocationLogPath) {
  appendFileSync(
    invocationLogPath,
    JSON.stringify({
      args,
      authorityKeys,
      authorityValues: authorityKeys.map((key) => process.env[key] ?? ""),
    }) + "\\n",
    "utf8",
  );
}
if (authorityKeys.length > 0) {
  console.error("SCM repair authority leaked into Codex child environment");
  process.exit(86);
}

if (args.includes("--version")) {
  console.log("codex-cli 0.104.0");
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  process.exit(0);
}

const modelFlag = args.indexOf("-m");
const model = modelFlag >= 0 ? args[modelFlag + 1] ?? "" : "";
const outputFlag = args.indexOf("--output-last-message");
const outputPath = outputFlag >= 0 ? args[outputFlag + 1] ?? "" : "";
await Bun.stdin.text();

if (model === "gpt-5.6-sol") {
  console.error("ERROR: {\\"detail\\":\\"The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.\\"}");
  process.exit(1);
}

if (outputPath) {
  await Bun.write(outputPath, "fallback:" + model);
}
console.log("completed:" + model);
process.exit(0);
`.trimStart(),
  );
  return scriptPath;
}

function isEffectivelyAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/, 1)[0];
      if (state === "Z") return false;
    } catch {
      return false;
    }
  }
  return true;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("RemoteBuddy OpenAI Codex CLI client", () => {
  test("hard-stops a Codex subprocess that never exits", async () => {
    const startedAt = Date.now();

    const result = await __TEST_ONLY__.runProcessWithBun(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 50,
      },
    );

    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(124);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test("aborting Codex provider work terminates its real descendant tree before rejecting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pushpals-codex-cancel-tree-"));
    tempDirs.push(dir);
    const pidPath = join(dir, "descendant.pid");
    const script = [
      `const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      `await Bun.write(${JSON.stringify(pidPath)}, String(child.pid));`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const controller = new AbortController();
    const reason = new Error("repository discovery timed out");
    const operation = __TEST_ONLY__.runProcessWithBun([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    let descendantPid = 0;
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(pidPath); attempt += 1) {
        await Bun.sleep(20);
      }
      expect(existsSync(pidPath)).toBe(true);
      descendantPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
      expect(descendantPid).toBeGreaterThan(0);

      controller.abort(reason);
      await expect(operation).rejects.toBe(reason);

      let alive = true;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!isEffectivelyAlive(descendantPid)) {
          alive = false;
          break;
        }
        await Bun.sleep(50);
      }
      expect(alive).toBe(false);
    } finally {
      controller.abort(reason);
      await operation.catch(() => undefined);
      if (descendantPid > 0) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Whole-tree cancellation already stopped it.
        }
      }
    }
  }, 15_000);

  test("chooses the newest Codex CLI probe for default launcher candidates", () => {
    const oldProbe = {
      command: ["old-codex"],
      version: __TEST_ONLY__.parseCodexCliVersion("codex-cli 0.104.0"),
      versionText: "codex-cli 0.104.0",
    };
    const newProbe = {
      command: ["new-codex"],
      version: __TEST_ONLY__.parseCodexCliVersion("codex-cli 0.130.0"),
      versionText: "codex-cli 0.130.0",
    };

    expect(
      __TEST_ONLY__.chooseCodexCommandProbe([oldProbe, newProbe], {
        preferNewestCompatible: true,
      })?.command,
    ).toEqual(["new-codex"]);
    expect(
      __TEST_ONLY__.chooseCodexCommandProbe([oldProbe, newProbe], {
        preferNewestCompatible: false,
      })?.command,
    ).toEqual(["old-codex"]);
  });

  test("builds a Codex launcher from the embedded Bun executable", () => {
    expect(
      __TEST_ONLY__.bunCodexCommandFromEnv({
        PUSHPALS_BUN_BIN: "C:/tools/bun/bin/bun.exe",
      } as NodeJS.ProcessEnv),
    ).toEqual(["C:/tools/bun/bin/bun.exe", "x", "--yes", "@openai/codex"]);
  });

  test("retries default gpt-5.6 Sol requests with the legacy model when Codex is too old", async () => {
    const scriptPath = createFakeCodexScript();
    const usageEvents: Array<{ modelId?: string | null }> = [];
    const client = new OpenAiCodexCliClient({
      service: "remotebuddy",
      sessionId: "test-session",
      model: "gpt-5.6-sol",
      codexAuthMode: "chatgpt",
      codexBin: `${quoteArg(process.execPath)} ${quoteArg(scriptPath)}`,
      reasoningEffort: "xhigh",
      usageReporter: {
        async reportUsage(event) {
          usageEvents.push(event);
        },
      },
    });

    const output = await client.generate({
      system: "Return a short answer.",
      messages: [{ role: "user", content: "Say hello." }],
      maxTokens: 64,
    });

    expect(output.text).toBe("fallback:gpt-5.5");
    expect(output.provider).toBe("openai_codex");
    expect(output.modelId).toBe("gpt-5.5");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.modelId).toBe("gpt-5.5");
  });

  test("keeps SCM repair authority out of Codex probes, login, isolated workspace, and exec", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-codex-secret-isolation-"));
    tempDirs.push(root);
    const invocationLogPath = join(root, "codex-invocations.jsonl");
    const gitTracePath = join(root, "git-trace.jsonl");
    const scriptPath = createFakeCodexScript(invocationLogPath);
    const secret = "test-remotebuddy-scm-repair-authority-secret-0123456789abcdef";
    const savedEnv = new Map<string, string | undefined>([
      [SCM_REPAIR_AUTHORITY_SECRET_ENV, process.env[SCM_REPAIR_AUTHORITY_SECRET_ENV]],
      ["GIT_TRACE2_EVENT", process.env.GIT_TRACE2_EVENT],
      ["GIT_TRACE2_ENV_VARS", process.env.GIT_TRACE2_ENV_VARS],
    ]);

    process.env[SCM_REPAIR_AUTHORITY_SECRET_ENV] = secret;
    process.env.GIT_TRACE2_EVENT = gitTracePath;
    process.env.GIT_TRACE2_ENV_VARS = SCM_REPAIR_AUTHORITY_SECRET_ENV;
    try {
      const client = new OpenAiCodexCliClient({
        service: "repository_agent",
        sessionId: "secret-isolation",
        model: "gpt-5.5",
        codexAuthMode: "chatgpt",
        codexBin: `${quoteArg(process.execPath)} ${quoteArg(scriptPath)}`,
      });

      const output = await client.generate({
        system: "Return a short answer.",
        messages: [{ role: "user", content: "Inspect the supplied evidence." }],
        maxTokens: 64,
        executionContext: { repositoryMode: "isolated-evidence" },
      });

      expect(output.text).toBe("fallback:gpt-5.5");
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const invocations = readFileSync(invocationLogPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            authorityKeys: string[];
            authorityValues: string[];
          },
      );
    expect(invocations.some(({ args }) => args.includes("--version"))).toBe(true);
    expect(invocations.some(({ args }) => args[0] === "login" && args[1] === "status")).toBe(true);
    expect(invocations.some(({ args }) => args.includes("exec"))).toBe(true);
    expect(invocations.every(({ authorityKeys }) => authorityKeys.length === 0)).toBe(true);
    expect(invocations.every(({ authorityValues }) => authorityValues.length === 0)).toBe(true);

    expect(existsSync(gitTracePath)).toBe(true);
    const gitTrace = readFileSync(gitTracePath, "utf8");
    expect(gitTrace).toContain('"event":"start"');
    expect(gitTrace).not.toContain(secret);
  });
});
