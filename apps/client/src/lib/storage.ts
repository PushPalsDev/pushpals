/**
 * Platform-aware key-value persistence.
 *
 * Web:    synchronous localStorage (wrapped as async for uniform API).
 * Native: @react-native-async-storage/async-storage (truly async).
 *
 * All errors are swallowed — cursor persistence is best-effort.
 */
import { Platform } from "react-native";

// ─── Native storage (lazy-loaded) ───────────────────────────────────────────

type NativeStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

let _native: NativeStorage | null | undefined; // undefined = not yet tried

function nativeStorage(): NativeStorage {
  if (_native) return _native;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@react-native-async-storage/async-storage");
  const store = (mod.default ?? mod) as NativeStorage;
  if (!store?.getItem || !store?.setItem) {
    throw new Error(
      "[PushPals] @react-native-async-storage/async-storage is required for cursor persistence on native. " +
        "Run: bun add @react-native-async-storage/async-storage",
    );
  }
  _native = store;
  return _native;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      return window.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  try {
    return (await nativeStorage()?.getItem(key)) ?? null;
  } catch {
    return null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      window.localStorage?.setItem(key, value);
    } catch {
      // ignore
    }
    return;
  }
  try {
    await nativeStorage()?.setItem(key, value);
  } catch {
    // ignore
  }
}
