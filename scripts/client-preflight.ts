#!/usr/bin/env bun

import { resolve } from "path";
import {
  evaluateClientRuntimePreflight,
  formatClientRuntimePreflightLines,
} from "../packages/shared/src/client_preflight.js";

type Options = {
  clientName: string;
  projectRoot: string;
  runtimeRoot?: string;
};

function parseArgs(argv: string[]): Options {
  let clientName = "client";
  let projectRoot = process.cwd();
  let runtimeRoot: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--client") {
      clientName = String(argv[++i] ?? "").trim() || clientName;
      continue;
    }
    if (arg === "--project-root") {
      projectRoot = String(argv[++i] ?? "").trim() || projectRoot;
      continue;
    }
    if (arg === "--runtime-root") {
      runtimeRoot = String(argv[++i] ?? "").trim() || runtimeRoot;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: bun run scripts/client-preflight.ts [--client <name>] [--project-root <path>] [--runtime-root <path>]",
      );
      process.exit(0);
    }
    console.error(`[preflight] Unknown argument: ${arg}`);
    process.exit(2);
  }

  return {
    clientName,
    projectRoot: resolve(projectRoot),
    runtimeRoot: runtimeRoot ? resolve(runtimeRoot) : undefined,
  };
}

const options = parseArgs(process.argv.slice(2));
const result = evaluateClientRuntimePreflight({
  projectRoot: options.projectRoot,
  runtimeRoot: options.runtimeRoot,
});
const prefix = `[preflight:${options.clientName}]`;
for (const line of formatClientRuntimePreflightLines(result, prefix)) {
  console.log(line);
}

if (!result.ok) {
  process.exit(1);
}
