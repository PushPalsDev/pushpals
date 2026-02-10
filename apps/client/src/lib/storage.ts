/**
 * Platform-aware key-value persistence.
 *
 * Web:    synchronous localStorage (wrapped as async for uniform API).
 * Native: @react-native-async-storage/async-storage (truly async).
 *
 * Errors are swallowed in getItem/setItem — cursor persistence is
 * best-effort.  A console.warn is emitted once if the native storage
 * module is missing so the failure is diagnosable.
 */
import { Platform } from "react-native";

// ─── Native storage (lazy-loaded) ───────────────────────────────────────────

type NativeStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

let _native: NativeStorage | null | undefined; // undefined = not yet tried
let _warned = false;

function nativeStorage(): NativeStorage | null {
  if (_native) return _native;
  if (_native === null) return null; // already failed
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@react-native-async-storage/async-storage");
    const store = (mod.default ?? mod) as NativeStorage;
    if (!store?.getItem || !store?.setItem) {
      throw new Error("module loaded but getItem/setItem missing");
    }
    _native = store;
    return _native;
  } catch {
    _native = null;
    if (!_warned) {
      _warned = true;
      console.warn(
        "[PushPals] @react-native-async-storage/async-storage is not available. " +
          "Cursor persistence disabled on native. Install with: bun add @react-native-async-storage/async-storage",
      );
    }
    return null;
  }
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
