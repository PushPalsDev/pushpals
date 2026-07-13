import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OpenAiCodexCliClient, __TEST_ONLY__ } from "../apps/remotebuddy/src/llm";

const tempDirs: string[] = [];

function quoteArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function createFakeCodexScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-fake-codex-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-codex.ts");
  writeFileSync(
    scriptPath,
    `
const args = Bun.argv.slice(2);

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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("RemoteBuddy OpenAI Codex CLI client", () => {
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
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.modelId).toBe("gpt-5.5");
  });
});
