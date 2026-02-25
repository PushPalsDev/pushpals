import * as Clipboard from "expo-clipboard";

type NavigatorClipboard = {
  writeText: (data: string) => Promise<void>;
};

function getNavigatorClipboard(): NavigatorClipboard | null {
  const maybeNavigator = (
    globalThis as {
      navigator?: {
        clipboard?: {
          writeText?: (data: string) => Promise<void>;
        };
      };
    }
  ).navigator;
  const writeText = maybeNavigator?.clipboard?.writeText;
  if (typeof writeText === "function") {
    return { writeText };
  }
  return null;
}

export function hasClipboardSupport(): boolean {
  if (getNavigatorClipboard()) return true;
  return typeof (Clipboard as { setStringAsync?: unknown }).setStringAsync === "function";
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  const value = String(text ?? "").trim();
  if (!value) return false;

  const navClipboard = getNavigatorClipboard();
  if (navClipboard) {
    try {
      await navClipboard.writeText(value);
      return true;
    } catch {
      // fall through to Expo clipboard fallback
    }
  }

  if (typeof Clipboard.setStringAsync === "function") {
    try {
      await Clipboard.setStringAsync(value);
      return true;
    } catch {
      // ignore
    }
  }

  return false;
}
