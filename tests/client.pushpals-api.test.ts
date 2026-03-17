import { describe, expect, test } from "bun:test";
import {
  buildSessionEventsUrl,
  buildSessionMessageUrl,
  buildSessionWebSocketUrl,
} from "../apps/client/src/lib/pushpalsApi";

describe("pushpals client session transport URLs", () => {
  test("encodes cursor into the SSE URL without leaking auth tokens", () => {
    const url = buildSessionEventsUrl("http://localhost:3001", "dev/session", 42, "secret token");
    expect(url).toBe("http://localhost:3001/sessions/dev%2Fsession/events?after=42");
  });

  test("omits query parameters when cursor is absent", () => {
    const url = buildSessionEventsUrl("http://localhost:3001", "dev");
    expect(url).toBe("http://localhost:3001/sessions/dev/events");
  });

  test("builds the WebSocket transport URL without auth query fallback", () => {
    const url = buildSessionWebSocketUrl("https://pushpals.dev", "dev", 7, "topsecret");
    expect(url).toBe("wss://pushpals.dev/sessions/dev/ws?after=7");
  });

  test("builds the session message URL against the local server session endpoint", () => {
    const url = buildSessionMessageUrl("http://127.0.0.1:3001", "dev/session");
    expect(url).toBe("http://127.0.0.1:3001/sessions/dev%2Fsession/message");
  });

  test("encodes client presence metadata into session transport URLs", () => {
    const client = {
      clientId: "web-123",
      kind: "web",
      label: "Web Client",
      version: "1.2.3",
      platform: "web",
      repoRoot: "C:/repo/demo",
    };

    expect(buildSessionEventsUrl("http://localhost:3001", "dev", 0, undefined, client)).toBe(
      "http://localhost:3001/sessions/dev/events?clientId=web-123&clientKind=web&clientLabel=Web+Client&clientVersion=1.2.3&clientPlatform=web&clientRepoRoot=C%3A%2Frepo%2Fdemo",
    );
    expect(buildSessionWebSocketUrl("http://localhost:3001", "dev", 2, undefined, client)).toBe(
      "ws://localhost:3001/sessions/dev/ws?after=2&clientId=web-123&clientKind=web&clientLabel=Web+Client&clientVersion=1.2.3&clientPlatform=web&clientRepoRoot=C%3A%2Frepo%2Fdemo",
    );
  });
});
