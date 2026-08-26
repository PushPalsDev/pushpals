import { describe, expect, test } from "bun:test";
import {
  buildLocalCorsHeaders,
  isLoopbackOrigin,
  resolveLocalServerConnection,
} from "../packages/shared/src/local_network";

describe("shared local network helpers", () => {
  test("coerces direct daemon server overrides back to loopback and ignores auth tokens", () => {
    const resolved = resolveLocalServerConnection({
      serverUrl: "https://pushpals.example:4551/path",
      authToken: "secret-token",
      fallbackPort: 3001,
    });

    expect(resolved.serverUrl).toBe("http://127.0.0.1:4551");
    expect(resolved.authToken).toBeNull();
    expect(resolved.serverWasNormalized).toBe(true);
    expect(resolved.authTokenWasIgnored).toBe(true);
  });

  test("preserves loopback ports while normalizing localhost hostnames", () => {
    const resolved = resolveLocalServerConnection({
      serverUrl: "http://localhost:3991",
      authToken: null,
      fallbackPort: 3001,
    });

    expect(resolved.serverUrl).toBe("http://127.0.0.1:3991");
    expect(resolved.serverWasNormalized).toBe(true);
    expect(resolved.authTokenWasIgnored).toBe(false);
  });

  test("accepts only loopback origins for CORS", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:8081")).toBe(true);
    expect(isLoopbackOrigin("https://localhost:3001")).toBe(true);
    expect(isLoopbackOrigin("https://pushpals.example")).toBe(false);
  });

  test("buildLocalCorsHeaders emits allow-origin only for loopback origins", () => {
    expect(
      buildLocalCorsHeaders({
        origin: "http://127.0.0.1:8081",
        allowAuthorizationHeader: true,
        additionalAllowedHeaders: ["X-PushPals-Memory-Caller", "invalid header"],
      })["Access-Control-Allow-Origin"],
    ).toBe("http://127.0.0.1:8081");

    expect(
      buildLocalCorsHeaders({
        origin: "https://pushpals.example",
        allowAuthorizationHeader: true,
      })["Access-Control-Allow-Origin"],
    ).toBeUndefined();

    const headers = buildLocalCorsHeaders({
      origin: "http://127.0.0.1:8081",
      allowAuthorizationHeader: true,
      additionalAllowedHeaders: ["X-PushPals-Memory-Caller", "x-pushpals-memory-caller"],
    });
    expect(headers["Access-Control-Allow-Methods"]).toContain("PUT");
    expect(headers["Access-Control-Allow-Headers"]).toBe(
      "content-type, authorization, x-pushpals-memory-caller",
    );
  });
});
