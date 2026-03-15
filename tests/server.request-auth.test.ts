import { describe, expect, test } from "bun:test";
import { resolveRequestAuthHeader } from "../apps/server/src/request_auth";

describe("server request auth resolution", () => {
  test("returns the Authorization header when present", () => {
    expect(resolveRequestAuthHeader("Bearer header-token")).toBe("Bearer header-token");
  });

  test("returns null when no auth credentials are provided", () => {
    expect(resolveRequestAuthHeader(null)).toBeNull();
  });
});
