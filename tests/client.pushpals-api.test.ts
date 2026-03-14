import { describe, expect, test } from "bun:test";
import {
  buildSessionEventsUrl,
  buildSessionWebSocketUrl,
} from "../apps/client/src/lib/pushpalsApi";

describe("pushpals client session transport URLs", () => {
  test("encodes cursor and auth token into the SSE URL", () => {
    const url = buildSessionEventsUrl("http://localhost:3001", "dev/session", 42, "secret token");
    expect(url).toBe(
      "http://localhost:3001/sessions/dev%2Fsession/events?after=42&authToken=secret+token",
    );
  });

  test("omits query parameters when cursor and auth token are absent", () => {
    const url = buildSessionEventsUrl("http://localhost:3001", "dev");
    expect(url).toBe("http://localhost:3001/sessions/dev/events");
  });

  test("builds the WebSocket transport URL with auth fallback", () => {
    const url = buildSessionWebSocketUrl("https://pushpals.dev", "dev", 7, "topsecret");
    expect(url).toBe("wss://pushpals.dev/sessions/dev/ws?after=7&authToken=topsecret");
  });
});
