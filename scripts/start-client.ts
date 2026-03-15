#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { Socket, createServer } from "node:net";
import { dirname } from "node:path";
import { findGitRepoRoot, resolveGitStateFilePath } from "../packages/shared/src/repo.js";

const DEFAULT_CLIENT_PORT = 8081;
const DEFAULT_MAX_PORT_SCAN = 200;

function parsePositiveInt(value: string | null | undefined): number | null {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function splitClientArgs(argv: string[]): { forwarded: string[]; requestedPort: number | null } {
  const forwarded: string[] = [];
  let requestedPort: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      const next = argv[i + 1];
      if (next != null) {
        requestedPort = parsePositiveInt(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--port=")) {
      requestedPort = parsePositiveInt(arg.slice("--port=".length));
      continue;
    }
    if (arg === "--host") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      continue;
    }
    forwarded.push(arg);
  }

  return { forwarded, requestedPort };
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ port, host: "127.0.0.1", exclusive: true });
  });
}

function isPortListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {}
      resolve(value);
    };

    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", (err: unknown) => {
      const code = String((err as { code?: unknown })?.code ?? "");
      if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
        finish(false);
        return;
      }
      if (code === "EADDRNOTAVAIL" || code === "EINVAL") {
        finish(false);
        return;
      }
      finish(true);
    });

    socket.connect(port, host);
  });
}

async function portAvailable(port: number): Promise<boolean> {
  if (await isPortListening("127.0.0.1", port)) return false;
  if (await isPortListening("::1", port)) return false;
  return canBindPort(port);
}

async function findAvailablePort(startPort: number, maxScan: number): Promise<number | null> {
  for (let p = startPort; p < startPort + maxScan; p++) {
    if (await portAvailable(p)) return p;
  }
  return null;
}

const { forwarded, requestedPort } = splitClientArgs(process.argv.slice(2));
const basePort =
  requestedPort ??
  parsePositiveInt(process.env.EXPO_DEV_SERVER_PORT) ??
  parsePositiveInt(process.env.PUSHPALS_CLIENT_PORT) ??
  DEFAULT_CLIENT_PORT;
const maxScan =
  parsePositiveInt(process.env.PUSHPALS_CLIENT_PORT_SCAN_MAX) ?? DEFAULT_MAX_PORT_SCAN;
const selectedPort = (await findAvailablePort(basePort, maxScan)) ?? basePort;

if (selectedPort !== basePort) {
  console.warn(
    `[client:start] Port ${basePort} unavailable; using ${selectedPort} (set PUSHPALS_CLIENT_PORT to override).`,
  );
}

const selectedUrl = `http://127.0.0.1:${selectedPort}`;
try {
  const repoRoot = findGitRepoRoot(process.cwd());
  const statePath = repoRoot
    ? resolveGitStateFilePath(repoRoot, "pushpals-client-state.json")
    : null;
  if (statePath) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          port: selectedPort,
          url: selectedUrl,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(`[client:start] stateFile=${statePath}`);
  } else {
    console.warn("[client:start] No git repo root detected; skipping client state file.");
  }
} catch (error) {
  console.warn(`[client:start] Failed to write client state file: ${String(error)}`);
}

const bunBin = process.execPath || "bun";
const child = Bun.spawn(
  [
    bunBin,
    "--cwd",
    "apps/client",
    "start",
    "--",
    "--port",
    String(selectedPort),
    "--host",
    "localhost",
    ...forwarded,
  ],
  {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, EXPO_NO_INTERACTIVE: process.env.EXPO_NO_INTERACTIVE ?? "1" },
  },
);

const code = await child.exited;
process.exit(code);
