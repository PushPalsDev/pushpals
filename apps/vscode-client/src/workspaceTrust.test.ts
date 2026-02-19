import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertWorkspaceTrusted, WORKSPACE_TRUST_ERROR } from "./workspaceTrust";

describe("assertWorkspaceTrusted", () => {
  it("passes when workspace is trusted", () => {
    assert.doesNotThrow(() => assertWorkspaceTrusted(true));
  });

  it("throws the expected error when workspace is untrusted", () => {
    assert.throws(() => assertWorkspaceTrusted(false), new RegExp(WORKSPACE_TRUST_ERROR));
  });
});
