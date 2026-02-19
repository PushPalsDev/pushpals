import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSessionId, sanitizeWorkspaceSlug, sessionStorageKeyForWorkspace } from "./session";

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
