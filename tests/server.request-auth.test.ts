import { describe, expect, test } from "bun:test";
import { resolveRequestAuthHeader } from "../apps/server/src/request_auth";

describe("server request auth resolution", () => {
  test("prefers the Authorization header when present", () => {
    expect(resolveRequestAuthHeader("Bearer header-token", "query-token")).toBe(
      "Bearer header-token",
    );
  });

  test("falls back to the authToken query parameter for browser transports", () => {
    expect(resolveRequestAuthHeader(null, "query-token")).toBe("Bearer query-token");
  });

  test("returns null when no auth credentials are provided", () => {
    expect(resolveRequestAuthHeader(null, null)).toBeNull();
  });
});
