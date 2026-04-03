import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __resetWorkspaceSessionCacheForTests,
  buildInstalledCliRuntimeArgs,
  buildSourceCheckoutRuntimeEnv,
  createSessionId,
  ensureWorkspaceSessionId,
  resolveWorkspaceSessionId,
  sanitizeWorkspaceSlug,
  sessionStorageKeyForWorkspace,
} from "./session";

afterEach(() => {
  __resetWorkspaceSessionCacheForTests();
});

describe("sanitizeWorkspaceSlug", () => {
  it("normalizes and strips unsupported characters", () => {
    assert.equal(sanitizeWorkspaceSlug("PushPals Main"), "pushpals-main");
    assert.equal(sanitizeWorkspaceSlug("  $$$  "), "workspace");
    assert.equal(sanitizeWorkspaceSlug(undefined), "workspace");
  });
});

describe("sessionStorageKeyForWorkspace", () => {
  it("is stable for same workspace identifier", () => {
    const keyA = sessionStorageKeyForWorkspace("file:///repo-a");
    const keyB = sessionStorageKeyForWorkspace("file:///repo-a");
    assert.equal(keyA, keyB);
    assert.match(keyA, /^pushpals\.vscode\.sessionId\.[a-f0-9]{12}$/);
  });

  it("differs across workspace identifiers", () => {
    const keyA = sessionStorageKeyForWorkspace("file:///repo-a");
    const keyB = sessionStorageKeyForWorkspace("file:///repo-b");
    assert.notEqual(keyA, keyB);
  });
});

describe("createSessionId", () => {
  it("includes workspace slug and stable suffix slice", () => {
    const sessionId = createSessionId("PushPals Main", "12345678-aaaa-bbbb-cccc-ddddeeeeffff");
    assert.equal(sessionId, "vscode-pushpals-main-12345678");
  });
});

describe("resolveWorkspaceSessionId", () => {
  it("reuses the stored session id when one already exists", () => {
    const store = {
      get: (key: string) =>
        key === sessionStorageKeyForWorkspace("file:///repo-a")
          ? "vscode-existing-1234"
          : undefined,
      update: () => undefined,
    };

    assert.equal(
      resolveWorkspaceSessionId(store, "file:///repo-a", "Repo A"),
      "vscode-existing-1234",
    );
  });

  it("creates and persists a new session id when missing", () => {
    const writes = new Map<string, string>();
    const store = {
      get: () => undefined,
      update: (key: string, value: string) => {
        writes.set(key, value);
      },
    };

    const sessionId = resolveWorkspaceSessionId(store, "file:///repo-a", "Repo A");
    assert.match(sessionId, /^vscode-repo-a-[a-f0-9]{8}$/);
    assert.equal(writes.get(sessionStorageKeyForWorkspace("file:///repo-a")), sessionId);
  });

  it("reuses the generated session id while persistence is still pending", () => {
    let resolveUpdate: (() => void) | null = null;
    const writes = new Map<string, string>();
    const store = {
      get: () => undefined,
      update: (key: string, value: string) => {
        writes.set(key, value);
        return new Promise<void>((resolvePromise) => {
          resolveUpdate = resolvePromise;
        });
      },
    };

    const first = resolveWorkspaceSessionId(store, "file:///repo-pending", "Repo Pending");
    const second = resolveWorkspaceSessionId(store, "file:///repo-pending", "Repo Pending");

    assert.equal(second, first);
    assert.equal(writes.get(sessionStorageKeyForWorkspace("file:///repo-pending")), first);
    resolveUpdate?.();
  });
});

describe("ensureWorkspaceSessionId", () => {
  it("waits for the generated session id to persist before resolving", async () => {
    let persisted = false;
    let resolveUpdate: (() => void) | null = null;
    const store = {
      get: () => undefined,
      update: () =>
        new Promise<void>((resolvePromise) => {
          resolveUpdate = () => {
            persisted = true;
            resolvePromise();
          };
        }),
    };

    const pending = ensureWorkspaceSessionId(store, "file:///repo-async", "Repo Async");
    assert.equal(persisted, false);

    resolveUpdate?.();
    const sessionId = await pending;

    assert.equal(persisted, true);
    assert.match(sessionId, /^vscode-repo-async-[a-f0-9]{8}$/);
  });
});

describe("buildSourceCheckoutRuntimeEnv", () => {
  it("injects the shared session id into source-checkout runtime services", () => {
    assert.deepEqual(buildSourceCheckoutRuntimeEnv("vscode-demo-12345678"), {
      PUSHPALS_SESSION_ID: "vscode-demo-12345678",
    });
  });

  it("merges extra env values without inventing a session id", () => {
    assert.deepEqual(
      buildSourceCheckoutRuntimeEnv("", { WORKERPALS_DOCKER_IMAGE: "demo:latest" }),
      {
        WORKERPALS_DOCKER_IMAGE: "demo:latest",
      },
    );
  });
});

describe("buildInstalledCliRuntimeArgs", () => {
  it("always enables runtime-only mode and appends a shared session id when provided", () => {
    assert.deepEqual(buildInstalledCliRuntimeArgs("vscode-demo-12345678"), [
      "--runtime-only",
      "--session-id",
      "vscode-demo-12345678",
    ]);
  });

  it("omits the session override when no value is available", () => {
    assert.deepEqual(buildInstalledCliRuntimeArgs(""), ["--runtime-only"]);
  });
});
