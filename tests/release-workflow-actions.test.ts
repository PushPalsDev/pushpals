import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const workflowRoot = join(import.meta.dir, "..", ".github", "workflows");

function workflowText(): string {
  return readdirSync(workflowRoot)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => readFileSync(join(workflowRoot, name), "utf8"))
    .join("\n");
}

describe("release workflow action runtimes", () => {
  test("gates worker readiness in Linux/Windows CI and Windows release validation", () => {
    const ci = readFileSync(join(workflowRoot, "cli-e2e.yml"), "utf8");
    const release = readFileSync(join(workflowRoot, "release-cli.yml"), "utf8");
    expect(ci.match(/run: bun test tests\/cli\.worker-startup-readiness\.test\.ts/g)).toHaveLength(
      2,
    );
    expect(ci.match(/- "tests\/cli\.worker-startup-readiness\.test\.ts"/g)).toHaveLength(2);
    const windowsDeadlineStep = release
      .split("- name: Verify Windows deadline and process-tree contracts")[1]
      ?.split("- name:")[0];
    expect(windowsDeadlineStep).toContain("tests/cli.worker-startup-readiness.test.ts");
  });

  test.each(["cli-e2e.yml", "release-cli.yml"])(
    "%s gates Windows timeout-candidate recovery and real Bun wrapper retries",
    (filename) => {
      const text = readFileSync(join(workflowRoot, filename), "utf8");
      const step = text
        .split("- name: Verify Windows worker recovery and trusted-validation contracts")[1]
        ?.split("- name:")[0];
      expect(step).toContain("bun test");
      expect(step).toContain("tests/workerpals.executor-timeout-recovery.test.ts");
      expect(step).toContain("tests/source-control-manager.trusted-validation.test.ts");
      expect(step).toContain("tests/source-control-manager.http.test.ts");
      expect(step).toContain("tests/source-control-manager.runtime-helpers.test.ts");
      expect(step).toContain("tests/source-control-manager.review-agent.test.ts");
      expect(step).toContain("tests/source-control-manager.review-journal.test.ts");
      expect(step).toContain("tests/source-control-manager.github-pr.test.ts");
      expect(step).toContain("tests/source-control-manager.review-publication.test.ts");
      expect(step).toContain("tests/source-control-manager.review-publication-recovery.test.ts");
      expect(step).toContain("tests/shared.review-publication-validation.test.ts");
    },
  );

  test("uses Node-24-native action generations", () => {
    const text = workflowText();

    expect(text).not.toMatch(/actions\/checkout@v(?:[1-6])\b/);
    expect(text).not.toMatch(/actions\/setup-node@v(?:[1-6])\b/);
    expect(text).not.toMatch(/actions\/upload-artifact@v(?:[1-6])\b/);
    expect(text).not.toMatch(/actions\/download-artifact@v(?:[1-7])\b/);
    expect(text).not.toMatch(/softprops\/action-gh-release@v(?:1|2)\b/);

    expect(text).toContain("actions/checkout@v7");
    expect(text).toContain("actions/setup-node@v7");
    expect(text).toContain("actions/upload-artifact@v7");
    expect(text).toContain("actions/download-artifact@v8");
    expect(text).toContain("softprops/action-gh-release@v3");
  });
});
