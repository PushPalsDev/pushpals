import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  evaluateClientRuntimePreflight,
  formatClientRuntimePreflightLines,
} from "../packages/shared/src/client_preflight";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pushpals-client-preflight-"));
  tempRoots.push(root);
  return root;
}

function writeRuntimeConfig(runtimeRoot: string, autonomyEnabled: boolean): void {
  mkdirSync(join(runtimeRoot, "configs"), { recursive: true });
  writeFileSync(join(runtimeRoot, ".env"), "PUSHPALS_PROFILE=dev\n", "utf8");
  writeFileSync(join(runtimeRoot, "configs", "local.toml"), "# local overrides\n", "utf8");
  writeFileSync(
    join(runtimeRoot, "configs", "default.toml"),
    `profile = "dev"
session_id = "dev"

[server]
url = "http://127.0.0.1:3001"

[localbuddy]
port = 3003

[remotebuddy.autonomy]
enabled = ${autonomyEnabled ? "true" : "false"}
`,
    "utf8",
  );
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("client runtime preflight", () => {
  test("requires vision.md when autonomy is enabled for an external repo runtime", () => {
    const root = makeTempRoot();
    const projectRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    writeRuntimeConfig(runtimeRoot, true);
    writeFileSync(
      join(runtimeRoot, "vision.example.md"),
      "# Vision\n\n> **One sentence:** Ship better automation.\n",
      "utf8",
    );

    const result = evaluateClientRuntimePreflight({
      projectRoot,
      runtimeRoot,
      configDir: join(runtimeRoot, "configs"),
      visionTemplateRoot: runtimeRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.autonomyEnabled).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toContain("missing_vision_doc");

    const lines = formatClientRuntimePreflightLines(result, "[pushpals]");
    expect(lines.some((line) => line.includes("Missing required autonomy vision file: vision.md"))).toBe(true);
    expect(lines.some((line) => line.includes("vision.example.md"))).toBe(true);
  });

  test("does not require vision.md when autonomy is disabled", () => {
    const root = makeTempRoot();
    const projectRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    writeRuntimeConfig(runtimeRoot, false);

    const result = evaluateClientRuntimePreflight({
      projectRoot,
      runtimeRoot,
      configDir: join(runtimeRoot, "configs"),
    });

    expect(result.ok).toBe(true);
    expect(result.autonomyEnabled).toBe(false);
    expect(result.visionSummary).toBeNull();
  });

  test("resolves legacy config/ runtime layout before evaluating autonomy vision requirements", () => {
    const root = makeTempRoot();
    const projectRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(runtimeRoot, "config"), { recursive: true });
    writeFileSync(join(runtimeRoot, ".env"), "PUSHPALS_PROFILE=dev\n", "utf8");
    writeFileSync(join(runtimeRoot, "config", "local.toml"), "# local overrides\n", "utf8");
    writeFileSync(
      join(runtimeRoot, "config", "default.toml"),
      `profile = "dev"
session_id = "dev"

[server]
url = "http://127.0.0.1:3001"

[localbuddy]
port = 3003

[remotebuddy.autonomy]
enabled = true
`,
      "utf8",
    );
    writeFileSync(
      join(runtimeRoot, "vision.example.md"),
      "# Vision\n\n> **One sentence:** Ship better automation.\n",
      "utf8",
    );

    const result = evaluateClientRuntimePreflight({
      projectRoot,
      runtimeRoot,
      visionTemplateRoot: runtimeRoot,
    });

    expect(result.autonomyEnabled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("missing_vision_doc");
  });

  test("accepts a populated vision.md when autonomy is enabled", () => {
    const root = makeTempRoot();
    const projectRoot = join(root, "repo");
    mkdirSync(projectRoot, { recursive: true });
    writeRuntimeConfig(projectRoot, true);
    writeFileSync(
      join(projectRoot, "vision.md"),
      "# PushPals Vision\n\n> **One sentence:** Build a reliable agentic repo operating system.\n\n## 1) Goals\n- Keep work observable.\n",
      "utf8",
    );

    const result = evaluateClientRuntimePreflight({
      projectRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.autonomyEnabled).toBe(true);
    expect(result.visionSummary).not.toBeNull();
    expect(result.visionSummary?.path).toBe("vision.md");
    expect(result.visionSummary?.sectionCount).toBe(1);
  });
});
