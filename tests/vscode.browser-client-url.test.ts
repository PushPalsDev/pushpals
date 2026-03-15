import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBrowserClientPortCandidates,
  buildBrowserClientUrl,
  resolveBrowserClientPortBase,
  resolveBrowserClientUrl,
} from "../apps/vscode-client/src/browser_client_url";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    rmSync(root, { recursive: true, force: true });
  }
});

describe("vscode browser client url resolution", () => {
  test("prefers EXPO_DEV_SERVER_PORT over fallback defaults", () => {
    expect(
      resolveBrowserClientPortBase({
        EXPO_DEV_SERVER_PORT: "4901",
        PUSHPALS_CLIENT_PORT: "4902",
      } as NodeJS.ProcessEnv),
    ).toBe(4901);
  });

  test("builds port candidates from configured base + scan window", () => {
    expect(
      buildBrowserClientPortCandidates({
        PUSHPALS_CLIENT_PORT: "6200",
        PUSHPALS_CLIENT_PORT_SCAN_MAX: "3",
      } as NodeJS.ProcessEnv),
    ).toEqual([6200, 6201, 6202]);
  });

  test("resolves the first reachable PushPals web client port", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === buildBrowserClientUrl(6301)) {
        return new Response("<html><title>PushPals</title></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      throw new Error("ECONNREFUSED");
    };

    const resolved = await resolveBrowserClientUrl(
      {
        PUSHPALS_CLIENT_PORT: "6300",
        PUSHPALS_CLIENT_PORT_SCAN_MAX: "3",
      } as NodeJS.ProcessEnv,
      undefined,
      fetchImpl,
    );

    expect(resolved).toBe(buildBrowserClientUrl(6301));
  });

  test("prefers runtime state file URL when present and reachable", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-vscode-client-url-"));
    tempRoots.push(root);
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(
      join(root, ".git", "pushpals-client-state.json"),
      JSON.stringify({
        port: 6404,
        url: "http://127.0.0.1:6404",
      }),
      "utf8",
    );
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "http://127.0.0.1:6404") {
        return new Response("<html><title>PushPals</title></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      throw new Error("ECONNREFUSED");
    };

    const resolved = await resolveBrowserClientUrl(
      {
        PUSHPALS_CLIENT_PORT: "6400",
        PUSHPALS_CLIENT_PORT_SCAN_MAX: "2",
      } as NodeJS.ProcessEnv,
      root,
      fetchImpl,
    );

    expect(resolved).toBe("http://127.0.0.1:6404");
  });

  test("reads runtime state from worktree gitdir files", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-vscode-client-worktree-"));
    const metadataDir = join(root, "gitdir-store", "worktrees", "demo");
    tempRoots.push(root);
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${metadataDir}\n`, "utf8");
    writeFileSync(
      join(metadataDir, "pushpals-client-state.json"),
      JSON.stringify({
        port: 6505,
        url: "http://127.0.0.1:6505",
      }),
      "utf8",
    );
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "http://127.0.0.1:6505") {
        return new Response("<html><title>PushPals</title></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      throw new Error("ECONNREFUSED");
    };

    const resolved = await resolveBrowserClientUrl(
      {
        PUSHPALS_CLIENT_PORT: "6500",
        PUSHPALS_CLIENT_PORT_SCAN_MAX: "2",
      } as NodeJS.ProcessEnv,
      root,
      fetchImpl,
    );

    expect(resolved).toBe("http://127.0.0.1:6505");
  });

  test("finds runtime state when launched from a repo subdirectory", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-vscode-client-subdir-"));
    const nested = join(root, "apps", "client");
    tempRoots.push(root);
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(root, ".git", "pushpals-client-state.json"),
      JSON.stringify({
        port: 6606,
        url: "http://127.0.0.1:6606",
      }),
      "utf8",
    );
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "http://127.0.0.1:6606") {
        return new Response("<html><title>PushPals</title></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      throw new Error("ECONNREFUSED");
    };

    const resolved = await resolveBrowserClientUrl(
      {
        PUSHPALS_CLIENT_PORT: "6600",
        PUSHPALS_CLIENT_PORT_SCAN_MAX: "2",
      } as NodeJS.ProcessEnv,
      nested,
      fetchImpl,
    );

    expect(resolved).toBe("http://127.0.0.1:6606");
  });
});
