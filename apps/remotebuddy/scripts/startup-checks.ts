#!/usr/bin/env bun
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight, type PreflightResult } from "../src/preflight/index.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(SCRIPT_DIR, "..");
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const PREFLIGHT_ENV_FILE =
  (process.env.REMOTEBUDDY_PREFLIGHT_ENV_FILE ?? "").trim() ||
  join(REPO_ROOT, ".env");
const FALLBACK_ENV_FILE = join(APP_ROOT, ".env");

type CliFlags = {
  json: boolean;
  help: boolean;
};

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { json: false, help: false };
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
  }
  return flags;
}

function printUsage(): void {
  console.log(`RemoteBuddy startup diagnostics

Usage:
  bun run remotebuddy:preflight [--json]

Flags:
  --json    Emit machine-readable JSON (with telemetry + failure taxonomy)
  --help    Show this help message
`);
}

function printHuman(result: PreflightResult): void {
  console.log("RemoteBuddy Preflight Diagnostics");
  console.log("---------------------------------");
  for (const check of result.checks) {
    const status = check.status === "pass" ? "PASS" : "FAIL";
    console.log(`- [${status}] ${check.name}: ${check.detail}`);
    if (check.remediation && check.status === "fail") {
      console.log(`    Remediation: ${check.remediation}`);
    }
    if (check.failure) {
      console.log(
        `    Taxonomy: ${check.failure.taxonomyId} (${check.failure.severity})`,
      );
    }
  }

  console.log("");
  console.log("Failure Taxonomy Entries:");
  if (result.failures.length === 0) {
    console.log("  (none)");
  } else {
    for (const failure of result.failures) {
      console.log(
        `  - ${failure.taxonomyId} (${failure.checkId}): ${failure.detail} → ${failure.remediation}`,
      );
    }
  }

  console.log("");
  console.log("Telemetry stream:");
  for (const event of result.telemetry) {
    const parts = [`  - ${event.ts}`, event.event];
    if (event.checkId) parts.push(`check=${event.checkId}`);
    if (event.status) parts.push(`status=${event.status}`);
    if (event.failureTaxonomy) parts.push(`taxonomy=${event.failureTaxonomy}`);
    console.log(parts.join(" "));
  }

  console.log("");
  console.log(
    result.ok
      ? "All RemoteBuddy prerequisites satisfied."
      : "RemoteBuddy prerequisites failed. Resolve the items above before starting RemoteBuddy.",
  );
}

async function main(): Promise<void> {
  await ensureEnvLoaded();
  const flags = parseFlags(Bun.argv.slice(2));
  if (flags.help) {
    printUsage();
    return;
  }

  const result = await runPreflight({ env: { ...process.env } });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  if (!result.ok) {
    process.exit(1);
  }
}

await main();

async function ensureEnvLoaded(): Promise<void> {
  const candidates = dedupe([PREFLIGHT_ENV_FILE, FALLBACK_ENV_FILE]);
  for (const candidate of candidates) {
    try {
      const file = Bun.file(candidate);
      if (!(await file.exists())) continue;
      const text = await file.text();
      const parsed = parseEnvContent(text);
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
      break;
    } catch {
      // Ignore parse/load errors and continue. runPreflight will surface missing env vars.
    }
  }
}

function parseEnvContent(content: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = rawLine.indexOf("=");
    if (eqIndex === -1) continue;
    let key = rawLine.slice(0, eqIndex).trim();
    if (key.startsWith("export ")) {
      key = key.slice("export ".length).trim();
    }
    if (!key) continue;
    let value = rawLine.slice(eqIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
      value = value
        .replace(/\\\\/g, "\\")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const commentIndex = value.search(/\s+#/);
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trimEnd();
      }
    }
    entries[key] = value;
  }
  return entries;
}

function dedupe(items: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!item) continue;
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}
