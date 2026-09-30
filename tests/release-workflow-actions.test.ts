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
  test("runs the full release preflight on Linux before tagging and captures only runtime changes", () => {
    const ci = readFileSync(join(workflowRoot, "cli-e2e.yml"), "utf8");
    const preflight = ci.split("  release_preflight_linux:")[1]?.split(/\n  [a-z_]+:/)[0] ?? "";
    expect(preflight).toContain("runs-on: ubuntu-latest");
    expect(preflight).toContain("timeout-minutes: 45");
    expect(preflight).toContain("bun run cli:bundle");
    expect(preflight).toContain("bun run cli:verify-package-payload");
    expect(preflight).toContain("bun run test:root");
    expect(preflight).toContain("git diff --binary -- packages/cli/runtime");
    expect(preflight).toContain("runtime-assets-${{ github.sha }}");
    expect(preflight).not.toContain("continue-on-error");
  });

  test("published platform smokes wait for exact npm propagation without repeating publication", () => {
    const release = readFileSync(join(workflowRoot, "release-cli.yml"), "utf8");
    for (const platform of ["linux", "windows"]) {
      const job =
        release.split(`  smoke_published_cli_${platform}:`)[1]?.split(/\n  [a-z_]+:/)[0] ?? "";
      const wait = job.indexOf("- name: Wait for exact published npm package");
      const smoke = job.indexOf("- name: Run installed-package");
      expect(wait).toBeGreaterThan(0);
      expect(smoke).toBeGreaterThan(wait);
      const step = job.slice(wait, smoke);
      expect(step).toContain("timeout-minutes: 16");
      expect(step).toContain("bun run scripts/release-wait-for-npm.ts");
      expect(step).toContain('--package-name "@pushpalsdev/cli"');
      expect(step).toContain('--version "${{ needs.meta.outputs.version }}"');
      expect(step).not.toContain("continue-on-error");
      expect(step).not.toContain("npm publish");
      expect(job.slice(smoke)).toContain("scripts/release-installed-cli-smoke.ts");
    }
    expect(release.match(/bun run scripts\/release-wait-for-npm\.ts/g)).toHaveLength(2);
  });

  test("gates aggregate health recovery in Linux/Windows CI and Windows release validation", () => {
    const ci = readFileSync(join(workflowRoot, "cli-e2e.yml"), "utf8");
    const release = readFileSync(join(workflowRoot, "release-cli.yml"), "utf8");
    const healthSteps = ci.split("- name: Verify health recovery reporting").slice(1);
    expect(ci.match(/- "tests\/cli\.shutdown-confirmation\.test\.ts"/g)).toHaveLength(2);
    expect(ci.match(/- "tests\/source-control-manager\.lock\.test\.ts"/g)).toHaveLength(2);
    expect(healthSteps).toHaveLength(2);
    for (const entry of healthSteps) {
      const step = entry.split("- name:")[0];
      expect(step).toContain("bun test");
      expect(step).toContain("tests/start.runtime-services.test.ts");
      expect(step).toContain("tests/cli.runtime-bootstrap.test.ts");
      expect(step).toContain("tests/cli.shutdown-confirmation.test.ts");
    }
    const windowsDeadlineStep = release
      .split("- name: Verify Windows deadline and process-tree contracts")[1]
      ?.split("- name:")[0];
    expect(windowsDeadlineStep).toContain("tests/start.runtime-services.test.ts");
    expect(windowsDeadlineStep).toContain("tests/cli.runtime-bootstrap.test.ts");
    expect(windowsDeadlineStep).toContain("tests/cli.shutdown-confirmation.test.ts");
  });

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
      expect(step).toContain("tests/source-control-manager.lock.test.ts");
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
