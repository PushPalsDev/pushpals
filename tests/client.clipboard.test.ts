import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

const clipboardStub: { setStringAsync?: (value: string) => Promise<void> } = {};
mock.module("expo-clipboard", () => clipboardStub);

let copyTextToClipboard: typeof import("../apps/client/src/lib/clipboard").copyTextToClipboard;
let hasClipboardSupport: typeof import("../apps/client/src/lib/clipboard").hasClipboardSupport;

beforeAll(async () => {
  const module = await import("../apps/client/src/lib/clipboard");
  copyTextToClipboard = module.copyTextToClipboard;
  hasClipboardSupport = module.hasClipboardSupport;
});

const originalNavigator = globalThis.navigator;

afterEach(() => {
  if (originalNavigator === undefined) {
    delete (globalThis as Record<string, unknown>).navigator;
  } else {
    (globalThis as Record<string, unknown>).navigator = originalNavigator as unknown;
  }
  delete clipboardStub.setStringAsync;
});

describe("clipboard fallbacks", () => {
  test("hasClipboardSupport returns false when no APIs are available", () => {
    delete (globalThis as Record<string, unknown>).navigator;
    delete clipboardStub.setStringAsync;
    expect(hasClipboardSupport()).toBe(false);
  });

  test("copyTextToClipboard falls back and reports failure when APIs reject", async () => {
    (globalThis as Record<string, unknown>).navigator = {
      clipboard: {
        writeText: () => Promise.reject(new Error("navigator clipboard not available")),
      },
    };
    clipboardStub.setStringAsync = async () => {
      throw new Error("expo clipboard unavailable");
    };
    const didCopy = await copyTextToClipboard("jobId=abc123");
    expect(didCopy).toBe(false);
  });
});
