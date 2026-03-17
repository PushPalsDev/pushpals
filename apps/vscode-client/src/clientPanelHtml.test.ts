import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderClientPanelHtml } from "./clientPanelHtml";

describe("renderClientPanelHtml", () => {
  it("removes the dead direct-remote toggle and includes send-result draft restoration", () => {
    const html = renderClientPanelHtml({
      cspSource: "vscode-resource:",
      nonce: "test-nonce",
    });

    assert.match(html, /placeholder="Ask PushPals anything\.\.\."/);
    assert.equal(html.includes("direct-remote"), false);
    assert.equal(html.includes("Send Remote"), false);
    assert.match(html, /msg\.type === "sendResult"/);
    assert.match(html, /pendingSendDrafts/);
    assert.match(html, /prompt\.value = attemptedText/);
  });
});
