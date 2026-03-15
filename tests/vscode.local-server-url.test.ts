import { describe, expect, test } from "bun:test";
import { normalizeVscodeServerUrl } from "../apps/vscode-client/src/local_server_url";

describe("vscode local server url normalization", () => {
  test("coerces configured remote hosts back to loopback", () => {
    expect(normalizeVscodeServerUrl("https://pushpals.example:4551/path")).toBe(
      "http://127.0.0.1:4551",
    );
  });

  test("falls back to the default local port when the setting is empty", () => {
    expect(normalizeVscodeServerUrl("")).toBe("http://127.0.0.1:3001");
  });
});
