import { describe, expect, test } from "bun:test";
import { LmStudioClient, createLLMClient } from "../src/llm";
import { loadPushPalsConfig } from "shared";

const normalizeSuffix = (value: string | undefined | null): string => {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
  const collapsed = normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!collapsed) return "default";
  return collapsed.length <= 96 ? collapsed : collapsed.slice(0, 96);
};

describe("LocalBuddy LLM session handling", () => {
  test("sanitizes custom session ids when initializing LocalBuddy clients", () => {
    const client = new LmStudioClient({
      service: "localbuddy",
      sessionId: " Team Alpha/42  ",
    });

    const sessionTag = (client as { sessionTag: string }).sessionTag;

    expect(sessionTag).toBe("pushpals-localbuddy-team-alpha-42");
  });

  test("defaults to LocalBuddy-configured session id and isolates namespaces", () => {
    const config = loadPushPalsConfig();
    const localClient = createLLMClient({ service: "localbuddy" });
    const remoteClient = createLLMClient({ service: "remotebuddy" });

    const localTag = (localClient as { sessionTag?: string }).sessionTag;
    const remoteTag = (remoteClient as { sessionTag?: string }).sessionTag;

    expect(localTag).toBe(`pushpals-localbuddy-${normalizeSuffix(config.localbuddy.llm.sessionId)}`);
    expect(remoteTag).toBe(`pushpals-remotebuddy-${normalizeSuffix(config.remotebuddy.llm.sessionId)}`);
    expect(localTag).not.toBe(remoteTag);
  });
});
