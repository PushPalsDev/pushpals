#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const thisFilePath = fileURLToPath(import.meta.url);
const scriptsDir = dirname(thisFilePath);
const repoRoot = resolve(scriptsDir, "..");
const cliScriptPath = resolve(repoRoot, "scripts", "pushpals-cli.ts");

type CliIntegrationOptions = {
  keepTemp: boolean;
  withVision: boolean;
  cliArgs: string[];
};

function parseArgs(argv: string[]): CliIntegrationOptions {
  const cliArgs: string[] = [];
  let keepTemp = false;
  let withVision = true;
  let passthrough = false;

  for (const arg of argv) {
    if (passthrough) {
      cliArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--keep-temp") {
      keepTemp = true;
      continue;
    }
    if (arg === "--without-vision") {
      withVision = false;
      continue;
    }
    if (arg === "--with-vision") {
      withVision = true;
      continue;
    }
    cliArgs.push(arg);
  }

  return { keepTemp, withVision, cliArgs };
}

function writeRuntimeConfig(runtimeRoot: string): void {
  mkdirSync(join(runtimeRoot, "configs"), { recursive: true });
  writeFileSync(join(runtimeRoot, ".env"), "PUSHPALS_PROFILE=dev\n", "utf8");
  writeFileSync(join(runtimeRoot, ".env.example"), "PUSHPALS_PROFILE=dev\n", "utf8");
  writeFileSync(join(runtimeRoot, "configs", "local.toml"), "# local overrides\n", "utf8");
  writeFileSync(
    join(runtimeRoot, "configs", "default.toml"),
    `profile = "dev"
session_id = "dev"

[server]
url = "http://127.0.0.1:3901"
port = 3901

[localbuddy]
port = 3903

[source_control_manager]
port = 3902

[remotebuddy.autonomy]
enabled = true
`,
    "utf8",
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = mkdtempSync(join(tmpdir(), "pushpals-cli-integration-"));
  const sandboxRepoRoot = join(root, "repo");
  const runtimeRoot = join(root, "runtime");

  mkdirSync(sandboxRepoRoot, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  writeRuntimeConfig(runtimeRoot);
  writeFileSync(join(sandboxRepoRoot, "README.md"), "# CLI integration sandbox\n", "utf8");

  if (options.withVision) {
    writeFileSync(
      join(sandboxRepoRoot, "vision.md"),
      "# PushPals Sandbox Vision\n\n> **One sentence:** Exercise the CLI against an isolated repo.\n\n## 1) Goals\n- Keep the runtime debuggable.\n",
      "utf8",
    );
  }

  const init = Bun.spawnSync(["git", "init"], {
    cwd: sandboxRepoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (init.exitCode !== 0) {
    console.error("[cli-integration] git init failed.");
    process.exit(init.exitCode || 1);
  }

  const cliArgs = [
    cliScriptPath,
    "--runtime-root",
    runtimeRoot,
    ...options.cliArgs,
  ];

  console.log(`[cli-integration] repoRoot=${sandboxRepoRoot}`);
  console.log(`[cli-integration] runtimeRoot=${runtimeRoot}`);
  console.log(`[cli-integration] command=${process.execPath} ${cliArgs.join(" ")}`);
  if (!options.keepTemp) {
    console.log("[cli-integration] Temp sandbox will be removed after the CLI exits.");
  }

  const child = Bun.spawn([process.execPath, ...cliArgs], {
    cwd: sandboxRepoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PUSHPALS_CLI_PACKAGE_VERSION:
        String(process.env.PUSHPALS_CLI_PACKAGE_VERSION ?? "").trim() || "repo-dev",
      EXPO_PUBLIC_LOCAL_AGENT_URL: "",
      PUSHPALS_SERVER_URL: "",
      PUSHPALS_CONFIG_DIR_OVERRIDE: "",
      PUSHPALS_PROJECT_ROOT_OVERRIDE: "",
      PUSHPALS_REPO_ROOT_OVERRIDE: "",
    },
  });

  const exitCode = await child.exited;
  if (!options.keepTemp) {
    rmSync(root, { recursive: true, force: true });
  } else {
    console.log(`[cli-integration] Preserved sandbox at ${root}`);
  }
  process.exit(exitCode);
}

await main();
