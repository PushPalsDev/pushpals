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
    expect(plan.requirements.map((entry) => entry.tool)).not.toContain("expo");
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

  test("skips package-manager option values instead of treating them as scripts", () => {
    const repo = makeRepo();
    writeJson(join(repo, "package.json"), {
      scripts: { test: "vitest run" },
    });

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["pnpm --filter apps/client test"],
    });

    const tools = requirementsForValidationCommand(plan, "pnpm --filter apps/client test").map(
      (entry) => entry.tool,
    );
    expect(tools).toContain("pnpm");
    expect(tools).toContain("node");
    expect(plan.requirements.find((entry) => entry.tool === "node")?.detectedFrom).toContain(
      'package.json script "test"',
    );
  });

  test("keeps pnpm workspace-root flag from consuming the script name", () => {
    const repo = makeRepo();
    writeJson(join(repo, "package.json"), {
      scripts: { test: "vitest run" },
    });

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["pnpm -w test"],
    });

    expect(
      requirementsForValidationCommand(plan, "pnpm -w test").map((entry) => entry.tool),
    ).toContain("node");
    expect(plan.requirements.find((entry) => entry.tool === "node")?.detectedFrom).toContain(
      'package.json script "test"',
    );
  });

  test("supports npm -w workspace shorthand as a path option", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "apps", "client"), { recursive: true });
    writeJson(join(repo, "apps", "client", "package.json"), {
      scripts: { lint: "expo lint" },
    });

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["npm -w apps/client run lint"],
    });

    expect(plan.requirements.find((entry) => entry.tool === "node")?.detectedFrom).toContain(
      "apps/client/package.json",
    );
  });

  test("resolves npm workspace package names from root workspaces", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "packages", "client"), { recursive: true });
    writeJson(join(repo, "package.json"), {
      workspaces: ["packages/*"],
      scripts: { lint: "echo root" },
    });
    writeJson(join(repo, "packages", "client", "package.json"), {
      name: "@demo/client",
      scripts: { lint: "expo lint" },
    });

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["npm --workspace @demo/client run lint"],
    });

    expect(plan.requirements.find((entry) => entry.tool === "node")?.detectedFrom).toContain(
      "packages/client/package.json",
    );
  });

  test("resolves npm workspace path scripts from the target package", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "apps", "client"), { recursive: true });
    writeJson(join(repo, "package.json"), {
      workspaces: ["apps/*"],
      scripts: { lint: "echo root" },
    });
    writeJson(join(repo, "apps", "client", "package.json"), {
      scripts: { lint: "expo lint" },
    });

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["npm --workspace apps/client run lint"],
    });

    const nodeRequirement = requirementsForValidationCommand(
      plan,
      "npm --workspace apps/client run lint",
    ).find((entry) => entry.tool === "node");

    expect(nodeRequirement?.detectedFrom).toContain("apps/client/package.json");
  });

  test("resolves equals-form workspace and cwd options", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "apps", "client"), { recursive: true });
    writeJson(join(repo, "apps", "client", "package.json"), {
      scripts: { lint: "expo lint" },
    });

    const npmPlan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["npm --workspace=apps/client run lint"],
    });
    const bunPlan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["bun --cwd=apps/client run lint"],
    });

    expect(npmPlan.requirements.find((entry) => entry.tool === "node")?.detectedFrom).toContain(
      "apps/client/package.json",
    );
    expect(bunPlan.requirements.find((entry) => entry.tool === "node")?.detectedFrom).toContain(
      "apps/client/package.json",
    );
  });

  test("resolves yarn workspace path scripts from the target package", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "apps", "client"), { recursive: true });
    writeJson(join(repo, "package.json"), {
      workspaces: ["apps/*"],
    });
    writeJson(join(repo, "apps", "client", "package.json"), {
      scripts: { lint: "vite --host 127.0.0.1" },
    });

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["yarn workspace apps/client lint"],
    });

    const tools = requirementsForValidationCommand(plan, "yarn workspace apps/client lint").map(
      (entry) => entry.tool,
    );
    expect(tools).toContain("yarn");
    expect(tools).toContain("node");
    expect(plan.requirements.find((entry) => entry.tool === "node")?.detectedFrom).toContain(
      "apps/client/package.json",
    );
  });

  test("resolves yarn workspace package names from object workspaces", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "packages", "@scope", "client"), { recursive: true });
    writeJson(join(repo, "package.json"), {
      workspaces: { packages: ["packages/*/*"] },
    });
    writeJson(join(repo, "packages", "@scope", "client", "package.json"), {
      name: "@scope/client",
      scripts: { lint: "vite --host 127.0.0.1" },
    });

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["yarn workspace @scope/client lint"],
    });

    expect(plan.requirements.find((entry) => entry.tool === "node")?.detectedFrom).toContain(
      "packages/@scope/client/package.json",
    );
  });

  test("scans referenced validation scripts for hidden Node-backed CLIs", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeJson(join(repo, "package.json"), {
      scripts: { "web:e2e": "bun scripts/web-e2e.ts" },
    });
    writeFileSync(
      join(repo, "scripts", "web-e2e.ts"),
      'Bun.spawn(["bun", "x", "expo", "start", "--web"]);\n',
      "utf8",
    );

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["bun run web:e2e"],
    });

    const tools = requirementsForValidationCommand(plan, "bun run web:e2e").map(
      (entry) => entry.tool,
    );
    expect(tools).toContain("bun");
    expect(tools).toContain("node");
    expect(tools).not.toContain("expo");
    expect(plan.requirements.find((entry) => entry.tool === "node")?.detectedFrom).toContain(
      "scripts/web-e2e.ts",
    );
  });

  test("resolves referenced validation scripts relative to package cwd", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "apps", "client", "scripts"), { recursive: true });
    writeJson(join(repo, "apps", "client", "package.json"), {
      scripts: { "web:e2e": "bun scripts/web-e2e.ts" },
    });
    writeFileSync(
      join(repo, "apps", "client", "scripts", "web-e2e.ts"),
      'await Bun.spawn(["bun", "x", "expo", "start", "--web"]).exited;\n',
      "utf8",
    );

    const plan = buildToolchainPlan({
      repoRoot: repo,
      validationCommands: ["bun --cwd apps/client run web:e2e"],
    });

    const nodeRequirement = requirementsForValidationCommand(
      plan,
      "bun --cwd apps/client run web:e2e",
    ).find((entry) => entry.tool === "node");

    expect(nodeRequirement?.detectedFrom).toContain("apps/client/scripts/web-e2e.ts");
    expect(
      requirementsForValidationCommand(plan, "bun --cwd apps/client run web:e2e").map(
        (entry) => entry.tool,
      ),
    ).not.toContain("expo");
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
