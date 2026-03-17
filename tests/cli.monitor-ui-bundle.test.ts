import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

function collectFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

describe("packaged CLI monitor bundle", () => {
  test("matches the server-native chat contract and does not ship stale LocalBuddy-first strings", () => {
    const bundleRoot = resolve(process.cwd(), "packages", "cli", "monitor-ui");
    const jsBundleRoot = join(bundleRoot, "_expo", "static", "js", "web");
    const bundleFiles = collectFiles(jsBundleRoot).filter((pathValue) => pathValue.endsWith(".js"));

    expect(bundleFiles.length).toBeGreaterThan(0);
    const bundleText = bundleFiles.map((pathValue) => readFileSync(pathValue, "utf8")).join("\n");

    expect(bundleText).not.toContain("localAgentUrl");
    expect(bundleText).not.toContain("Send Local");
    expect(bundleText).not.toContain("LocalBuddy has not delegated this to execution yet.");
    expect(bundleText).not.toContain("Requests from LocalBuddy will appear here with full lifecycle status.");
  });
});
