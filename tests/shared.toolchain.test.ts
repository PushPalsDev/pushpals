import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildToolchainPlan,
  inferToolRequirementsForValidationCommand,
  requirementsForValidationCommand,
  tokenizeToolchainCommand,
} from "../packages/shared/src/toolchain";

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-toolchain-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("toolchain inference", () => {
  test("tokenizes validation commands without shell interpretation", () => {
    expect(tokenizeToolchainCommand('bun --cwd "apps/client" run lint')).toEqual([
      "bun",
      "--cwd",
      "apps/client",
      "run",
      "lint",
    ]);
    expect(tokenizeToolchainCommand("bun test && echo done")).toBeNull();
  });

  test("keeps bun test independent from node", () => {
    const repo = makeRepo();
    writeJson(join(repo, "package.json"), {
      scripts: { test: "bun test" },
    });

    const requirements = inferToolRequirementsForValidationCommand(repo, "bun test");

    expect(requirements.map((entry) => entry.tool)).toEqual(["bun"]);
  });

  test("infers node for package scripts backed by Node CLIs", () => {
    const repo = makeRepo();
    writeJson(join(repo, "package.json"), {
      scripts: {
        lint: "expo lint",
        "web:e2e": "node scripts/web-e2e.js",
      },
    });

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["bun run lint", "bun run web:e2e"],
    });

    expect(plan.requirements.map((entry) => entry.tool)).toContain("bun");
    expect(plan.requirements.map((entry) => entry.tool)).toContain("node");
    expect(
      requirementsForValidationCommand(plan, "bun run lint").map((entry) => entry.tool),
    ).toContain("node");
    expect(
      requirementsForValidationCommand(plan, "bun run web:e2e").map((entry) => entry.tool),
    ).toContain("node");
  });

  test("infers node for bun x tsc because tsc is a Node-backed CLI", () => {
    const repo = makeRepo();

    const requirements = inferToolRequirementsForValidationCommand(
      repo,
      "bun x tsc --noEmit",
    );

    expect(requirements.map((entry) => entry.tool)).toContain("bun");
    expect(requirements.map((entry) => entry.tool)).toContain("node");
  });

  test("infers direct Node-backed CLI executables when validation skips package managers", () => {
    const repo = makeRepo();

    const requirements = inferToolRequirementsForValidationCommand(repo, "tsc --noEmit");

    expect(requirements.map((entry) => entry.tool)).toContain("tsc");
    expect(requirements.map((entry) => entry.tool)).toContain("node");
  });

  test("resolves npm prefix scripts from the target package", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "apps", "client"), { recursive: true });
    writeJson(join(repo, "package.json"), {
      scripts: { lint: "echo root" },
    });
    writeJson(join(repo, "apps", "client", "package.json"), {
      scripts: { lint: "expo lint" },
    });

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["npm --prefix apps/client run lint"],
    });

    expect(plan.requirements.map((entry) => entry.tool)).toContain("npm");
    expect(
      requirementsForValidationCommand(plan, "npm --prefix apps/client run lint").map(
        (entry) => entry.tool,
      ),
    ).toContain("node");
    expect(plan.requirements.find((entry) => entry.tool === "node")?.detectedFrom).toContain(
      "apps/client/package.json",
    );
  });

  test("infers compiler requirements for native make validation", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "Makefile"), "test:\n\t$(CXX) main.cpp -o main\n", "utf8");
    writeFileSync(join(repo, "main.cpp"), "int main() { return 0; }\n", "utf8");

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["make test"],
    });

    expect(plan.requirements.map((entry) => entry.tool)).toContain("make");
    expect(plan.requirements.map((entry) => entry.tool)).toContain("cxx-compiler");
  });

  test("detects declared repo environments before default sandbox", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".devcontainer"));
    writeJson(join(repo, ".devcontainer", "devcontainer.json"), { image: "node:22" });

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["npm test"],
    });

    expect(plan.environmentSource).toBe("devcontainer");
  });
});
