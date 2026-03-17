import { describe, expect, test } from "bun:test";
import {
  buildSendFailureMessage,
  restoreComposerDraft,
} from "../apps/client/src/lib/composerSendState";

describe("client composer send failure handling", () => {
  test("restores the attempted draft when the composer was cleared before a failed send", () => {
    expect(restoreComposerDraft("", "ship the fix")).toBe("ship the fix");
  });

  test("preserves any newer in-progress draft while surfacing the session failure message", () => {
    expect(restoreComposerDraft("new draft", "ship the fix")).toBe("new draft");
    expect(buildSendFailureMessage("session")).toBe(
      "Message was not accepted. Your draft was restored.",
    );
  });

  test("surfaces remote-request failure copy without changing the restored draft contract", () => {
    expect(restoreComposerDraft("", "please delegate this")).toBe("please delegate this");
    expect(buildSendFailureMessage("remote")).toBe(
      "Remote request was not accepted. Your draft was restored.",
    );
  });
});
