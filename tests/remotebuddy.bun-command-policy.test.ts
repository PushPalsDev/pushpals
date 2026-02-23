import { describe, expect, test } from "bun:test";
import {
  canonicalizeInstructionTextForBun,
  canonicalizeValidationCommandForBun,
} from "../apps/remotebuddy/src/command_policy";

describe("remotebuddy bun command policy", () => {
  test("rewrites npx and npm validation commands to bun forms", () => {
    expect(
      canonicalizeValidationCommandForBun("npx prettier --check apps/remotebuddy/README.md"),
    ).toBe("bunx prettier --check apps/remotebuddy/README.md");
    expect(canonicalizeValidationCommandForBun("npm run lint")).toBe("bun run lint");
    expect(canonicalizeValidationCommandForBun("npm test -- --runInBand")).toBe(
      "bun test -- --runInBand",
    );
  });

  test("rewrites prefix and alternate package manager command forms", () => {
    expect(canonicalizeValidationCommandForBun("npm --prefix apps/client run test")).toBe(
      "bun --cwd apps/client run test",
    );
    expect(canonicalizeValidationCommandForBun("npm --prefix apps/client test -- --watch")).toBe(
      "bun --cwd apps/client test -- --watch",
    );
    expect(canonicalizeValidationCommandForBun("pnpm dlx prettier --check README.md")).toBe(
      "bunx prettier --check README.md",
    );
    expect(canonicalizeValidationCommandForBun("yarn test apps/localbuddy")).toBe(
      "bun test apps/localbuddy",
    );
  });

  test("rewrites command references inside freeform worker instructions", () => {
    const instruction =
      "Update docs, then run npx prettier --check apps/remotebuddy/README.md and `npm run lint`.";
    const canonical = canonicalizeInstructionTextForBun(instruction);
    expect(canonical).toContain("bunx prettier --check apps/remotebuddy/README.md");
    expect(canonical).toContain("`bun run lint`");
    expect(canonical).not.toContain("npx");
    expect(canonical).not.toContain("npm run");
  });

  test("keeps bun commands intact", () => {
    expect(canonicalizeValidationCommandForBun("bun --cwd apps/localbuddy test")).toBe(
      "bun --cwd apps/localbuddy test",
    );
    expect(canonicalizeInstructionTextForBun("Run `bunx prettier --check README.md`")).toContain(
      "`bunx prettier --check README.md`",
    );
  });
});
