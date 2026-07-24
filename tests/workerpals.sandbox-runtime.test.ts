import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const sourceDockerfilePath = join(repoRoot, "apps", "workerpals", "Dockerfile.sandbox");
const packagedDockerfilePath = join(
  repoRoot,
  "packages",
  "cli",
  "runtime",
  "sandbox",
  "apps",
  "workerpals",
  "Dockerfile.sandbox",
);
const sourceCodexBackendPath = join(
  repoRoot,
  "apps",
  "workerpals",
  "src",
  "backends",
  "openai_codex_backend.ts",
);
const packagedCodexBackendPath = join(
  repoRoot,
  "packages",
  "cli",
  "runtime",
  "sandbox",
  "apps",
  "workerpals",
  "src",
  "backends",
  "openai_codex_backend.ts",
);

function readDockerfile(path: string): string {
  return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

describe("WorkerPal sandbox runtime", () => {
  test("uses a supported Node base and layers Bun into the sandbox", () => {
    const dockerfile = readDockerfile(sourceDockerfilePath);
    const nodeMajor = Number(dockerfile.match(/^FROM node:(\d+)-trixie AS base$/m)?.[1]);

    expect(nodeMajor).toBeGreaterThanOrEqual(24);
    expect(dockerfile).toContain("FROM oven/bun:1-debian AS bun-runtime");
    expect(dockerfile).toContain(
      "COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun",
    );
    expect(dockerfile).toContain("RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx");
    expect(dockerfile).toContain('ENV NODE_OPTIONS="--max-old-space-size=1536"');
    expect(dockerfile).toMatch(/^RUN apt-get update && apt-get install .* chromium \\$/m);
    expect(dockerfile).toContain("ln -sf /usr/bin/chromium /opt/google/chrome/chrome");
    expect(dockerfile).not.toMatch(/^\s+nodejs \\$/m);
    expect(dockerfile).not.toMatch(/^\s+npm \\$/m);
  });

  test("keeps the published CLI sandbox Dockerfile synchronized", () => {
    expect(readDockerfile(packagedDockerfilePath)).toBe(readDockerfile(sourceDockerfilePath));
  });

  test("uses the image-installed Codex binary before any registry-backed fallback", () => {
    for (const path of [sourceCodexBackendPath, packagedCodexBackendPath]) {
      const backend = readFileSync(path, "utf8");
      const directCodex = backend.indexOf("if command -v codex");
      const bunxFallback = backend.indexOf("elif command -v bunx");

      expect(directCodex).toBeGreaterThanOrEqual(0);
      expect(bunxFallback).toBeGreaterThan(directCodex);
    }
  });
});
