import { afterEach, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsDir, "..");
const bunExecPath = (process.execPath ?? "").trim() || "bun";

const servers: Array<{ stop: (closeAll?: boolean) => void }> = [];

afterEach(() => {
  while (servers.length > 0) {
    const server = servers.pop();
    try {
      server?.stop(true);
    } catch {
      // best effort
    }
  }
});

describe("localbuddy --validate-config", () => {
  test("fails fast when the configured model is unavailable", async () => {
    const modelServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "gpt-4.1-mini" }],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(modelServer);

    const proc = Bun.spawn(
      [
        bunExecPath,
        "run",
        resolve(repoRoot, "apps/localbuddy/src/localbuddy_main.ts"),
        "--validate-config",
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          LOCALBUDDY_LLM_BACKEND: "openai",
          LOCALBUDDY_LLM_ENDPOINT: `http://127.0.0.1:${modelServer.port}/v1/chat/completions`,
          LOCALBUDDY_LLM_API_KEY: "test-key",
          LOCALBUDDY_LLM_MODEL: "gpt-5-codex",
          LOCALBUDDY_LLM_CODEX_AUTH_MODE: "api_key",
        },
      },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain(
      'Configured OpenAI model "gpt-5-codex" is unavailable',
    );
  });
});
