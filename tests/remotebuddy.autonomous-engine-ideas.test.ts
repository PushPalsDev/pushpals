import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildEngineFallbackCandidates,
  buildEngineInspirationContext,
  buildRepoVisionFallbackCandidates,
  containsPushPalsInternalUserRepoText,
  discoverRepoTargetProfiles,
  inferRepoValidationIdeas,
  normalizeTargetValidationIdeas,
  rankRepoTargetsForVision,
  resolveCompiledRepoObjectiveAttribution,
  resolveWorkerValidationExecutionPlatform,
  scopeIdeationSignalsToRepository,
  summarizeCommitHistoryHints,
  validationRepairCommandTargetCandidates,
} from "../apps/remotebuddy/src/autonomous_engine";

describe("RemoteBuddy autonomous engine idea generation", () => {
  const vision = {
    one_sentence:
      "Continuously improve autonomous repo delivery with safe, auditable, and high-confidence workflows.",
    key_items: {
      target_users: ["Engineering leads", "OSS maintainers"],
      priorities: [
        "Startup and environment stability",
        "Worker reliability under conflict/retry scenarios",
        "Activation: first PR in under 30 minutes",
      ],
      objectives: [
        "Reliable autonomous delivery loop",
        "High-confidence review and merge automation",
        "Workforce-grade delegation",
      ],
      guardrails: ["Safe by default", "Small reversible steps", "No silent scope escalation"],
      constraints: [
        "Predictable runtime behavior",
        "Audit trails",
        "Avoid operational toil expansion",
      ],
      non_goals: ["Unbounded autonomous architecture redesign"],
      metrics: ["Autonomous merge rate", "Rework rate", "Queue health", "Time-to-first-value"],
      testing_criteria: ["bun run test:root"],
      risk_policy: ["Low risk can ship autonomously", "High risk requires explicit approval"],
      operating_model: ["RemoteAgent delegates to specialized WorkerPals"],
      governance: ["RFC for high-risk architecture changes"],
    },
    section_numbers: ["0", "4", "6", "7", "8"],
  };

  const snapshot = {
    top_signals: [
      { signal_id: "sig_queue", type: "queue_health", value: 0.82, evidence: "queue_p95=210000" },
      { signal_id: "sig_regret", type: "regret_signal", value: 0.7, evidence: "reopened=4" },
      {
        signal_id: "sig_test",
        type: "test_failure",
        value: 0.45,
        evidence: "flaky tests recurring",
      },
    ],
    state_traits: [
      {
        trait_id: "queue_latency_high",
        category: "weakness",
        focus: "queue",
        score: 0.78,
        evidence: "request queue p95 above SLO",
      },
      {
        trait_id: "merge_rework_high",
        category: "risk",
        focus: "merge",
        score: 0.71,
        evidence: "review churn and conflict loops",
      },
      {
        trait_id: "policy_scope_ambiguity",
        category: "risk",
        focus: "policy",
        score: 0.62,
        evidence: "scope ambiguity across worker tasks",
      },
    ],
    open_objectives: Array.from({ length: 6 }).map((_, i) => ({
      objective_id: `obj_${i}`,
      pattern_key: `pattern_${i}`,
      status: "dispatched",
    })),
    dispatch_budget: {
      global_count_last_hour: 4,
      by_type_count_last_hour: {
        feature_small: 1,
        feature_medium: 0,
      },
    },
  };

  test("discovers behavior targets fairly across arbitrary repository layouts", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-generic-target-catalog-"));
    try {
      const files = [
        "studio/widgets/Editor.svelte",
        "ledger/reconcile/batches.py",
        "storage/migrations/001_init.sql",
        "gateway/routes/accounts.go",
        "infrastructure/modules/queue.tf",
        "cli/src/bin/daemon.rs",
        "web/src/main/java/com/example/catalog/search/Handler.java",
        "bin/console",
        "tests/gateway/accounts.test.ts",
        "docs/operations.md",
        "node_modules/hidden/generated.ts",
        "Pods/Generated/Client.swift",
        "DerivedData/cache/Generated.swift",
      ];
      for (const file of files) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), "fixture\n", "utf8");
      }

      const profiles = discoverRepoTargetProfiles(root, 8);
      const paths = profiles.flatMap((profile) => profile.target_paths);
      expect(paths).toHaveLength(8);
      expect(paths.some((path) => path.startsWith("studio/"))).toBe(true);
      expect(paths.some((path) => path.startsWith("ledger/"))).toBe(true);
      expect(paths.some((path) => path.startsWith("storage/"))).toBe(true);
      expect(paths.some((path) => path.startsWith("gateway/"))).toBe(true);
      expect(paths).toContain("cli/src/bin/daemon.rs");
      expect(paths).toContain("web/src/main/java/com/example/catalog/search/Handler.java");
      expect(paths).toContain("bin/console");
      expect(paths.some((path) => path.includes("node_modules"))).toBe(false);
      expect(paths.some((path) => path.startsWith("Pods/"))).toBe(false);
      expect(paths.some((path) => path.startsWith("DerivedData/"))).toBe(false);
      expect(paths.some((path) => path.startsWith("tests/"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repository discovery reserves traversal capacity for later top-level areas", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-generic-target-fairness-"));
    try {
      for (let area = 0; area < 5; area += 1) {
        for (let index = 0; index < 90; index += 1) {
          const file = join(
            root,
            `aaa-${area}`,
            `package-${String(index).padStart(3, "0")}`,
            "src.ts",
          );
          mkdirSync(join(file, ".."), { recursive: true });
          writeFileSync(file, "fixture\n", "utf8");
        }
      }
      mkdirSync(join(root, "zzz-late", "src"), { recursive: true });
      writeFileSync(join(root, "zzz-late", "src", "feature.go"), "package feature\n", "utf8");

      const paths = discoverRepoTargetProfiles(root, 6).flatMap((profile) => profile.target_paths);

      for (let area = 0; area < 5; area += 1) {
        expect(paths.some((path) => path.startsWith(`aaa-${area}/`))).toBe(true);
      }
      expect(paths).toContain("zzz-late/src/feature.go");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("single-file repositories prioritize executable source over root metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-single-file-targets-"));
    try {
      writeFileSync(join(root, "README.md"), "# Example\n", "utf8");
      writeFileSync(join(root, "package.json"), "{}\n", "utf8");
      writeFileSync(join(root, "main.py"), "print('hello')\n", "utf8");
      writeFileSync(join(root, "service.go"), "package main\n", "utf8");

      const paths = discoverRepoTargetProfiles(root, 2).flatMap((profile) => profile.target_paths);
      expect(paths).toEqual(["main.py", "service.go"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repo fallback rotates covered priorities, excludes recent paths, and uses native validation", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-generic-portfolio-"));
    try {
      writeFileSync(
        join(root, "pyproject.toml"),
        "[project]\nname='fixture'\n[tool.pytest.ini_options]\n",
        "utf8",
      );
      const portfolioVision = {
        one_sentence: "A knowledge service keeps search, setup, and imports predictable.",
        key_items: {
          target_users: ["Operations teams"],
          priorities: [
            "Improve search relevance for imported knowledge",
            "Simplify account onboarding and setup",
            "Preserve performance during large imports",
          ],
          objectives: [],
          guardrails: ["Keep changes reversible"],
          constraints: [],
          non_goals: [],
          metrics: [],
          testing_criteria: [],
          risk_policy: [],
          operating_model: [],
          governance: [],
        },
        section_numbers: ["2", "5"],
      };
      const repoTargets = [
        {
          component_area: "src/search",
          target_paths: ["src/search/rank.py"],
          write_globs: ["src/search/rank.py"],
          label: "src/search/rank.py",
          keywords: ["src", "search", "rank", "relevance", "knowledge"],
        },
        {
          component_area: "src/account",
          target_paths: ["src/account/setup.py"],
          write_globs: ["src/account/setup.py"],
          label: "src/account/setup.py",
          keywords: ["src", "account", "setup", "onboarding"],
        },
        {
          component_area: "src/imports",
          target_paths: ["src/imports/stream.py"],
          write_globs: ["src/imports/stream.py"],
          label: "src/imports/stream.py",
          keywords: ["src", "imports", "stream", "performance"],
        },
      ];
      const context = buildEngineInspirationContext({
        vision: portfolioVision,
        snapshot,
        repoTargets,
      });
      const candidates = buildRepoVisionFallbackCandidates({
        engineInspiration: context,
        snapshotTopSignals: snapshot.top_signals,
        visionSectionRefs: portfolioVision.section_numbers,
        repoTargets,
        repoRoot: root,
        maxCandidates: 2,
        excludedTargetPaths: ["src/search/rank.py"],
        coveredObjectiveTitles: [
          "Vision objective: Improve search relevance for imported knowledge",
        ],
      });

      expect(candidates).toHaveLength(2);
      expect(
        candidates.some((candidate) => String(candidate.title).includes("search relevance")),
      ).toBe(false);
      expect(
        new Set(candidates.flatMap((candidate) => candidate.target_paths as string[])).size,
      ).toBe(2);
      expect(
        candidates.every((candidate) =>
          (candidate.expected_validation as string[]).includes("python -m pytest"),
        ),
      ).toBe(true);
      expect(candidates.every((candidate) => Boolean(candidate.vision_objective_id))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repo fallback never reuses a target when every discovered target is excluded", () => {
    const allTargetsVision = {
      one_sentence: "Keep search and account setup predictable.",
      key_items: {
        target_users: ["Service operators"],
        priorities: ["Improve search relevance", "Simplify account setup"],
        objectives: [],
        guardrails: [],
        constraints: [],
        non_goals: [],
        metrics: [],
        testing_criteria: [],
        risk_policy: [],
        operating_model: [],
        governance: [],
      },
      section_numbers: ["1"],
    };
    const repoTargets = [
      {
        component_area: "src/search",
        target_paths: ["src/search/rank.ts"],
        write_globs: ["src/search/rank.ts"],
        label: "src/search/rank.ts",
        keywords: ["search", "rank"],
      },
      {
        component_area: "src/account",
        target_paths: ["src/account/setup.ts"],
        write_globs: ["src/account/setup.ts"],
        label: "src/account/setup.ts",
        keywords: ["account", "setup"],
      },
    ];
    const context = buildEngineInspirationContext({
      vision: allTargetsVision,
      snapshot,
      repoTargets,
    });
    const candidates = buildRepoVisionFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: ["1"],
      repoTargets,
      excludedTargetPaths: ["src/search/rank.ts", "src/account/setup.ts"],
    });
    expect(candidates).toHaveLength(0);
  });

  test("repo fallback defers an excluded priority instead of redirecting it to unrelated code", () => {
    const focusedVision = {
      one_sentence: "Make catalog search more accurate.",
      key_items: {
        target_users: ["Catalog users"],
        priorities: ["Improve catalog search ranking accuracy"],
        objectives: [],
        guardrails: [],
        constraints: [],
        non_goals: [],
        metrics: [],
        testing_criteria: [],
        risk_policy: [],
        operating_model: [],
        governance: [],
      },
      section_numbers: ["1"],
    };
    const repoTargets = [
      {
        component_area: "src/search",
        target_paths: ["src/search/catalogRank.ts"],
        write_globs: ["src/search/catalogRank.ts"],
        label: "src/search/catalogRank.ts",
        keywords: ["catalog", "search", "rank", "accuracy"],
      },
      {
        component_area: "src/billing",
        target_paths: ["src/billing/invoiceTotals.ts"],
        write_globs: ["src/billing/invoiceTotals.ts"],
        label: "src/billing/invoiceTotals.ts",
        keywords: ["billing", "invoice", "total"],
      },
    ];
    const context = buildEngineInspirationContext({
      vision: focusedVision,
      snapshot,
      repoTargets,
    });
    const candidates = buildRepoVisionFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: ["1"],
      repoTargets,
      excludedTargetPaths: ["src/search/catalogRank.ts"],
      maxCandidates: 1,
    });

    expect(candidates).toHaveLength(0);
  });

  test("repo fallback preserves package-manager and build-tool validation", () => {
    const cases = [
      {
        name: "npm",
        files: { "package.json": JSON.stringify({ scripts: { test: "node test.js" } }) },
        expected: "npm run test",
      },
      {
        name: "pnpm",
        files: {
          "package.json": JSON.stringify({
            packageManager: "pnpm@10.0.0",
            scripts: { test: "vitest" },
          }),
        },
        expected: "pnpm run test",
      },
      {
        name: "yarn",
        files: {
          "package.json": JSON.stringify({
            packageManager: "yarn@4.0.0",
            scripts: { test: "jest" },
          }),
        },
        expected: "yarn run test",
      },
      {
        name: "gradle-wrapper",
        files: { "build.gradle.kts": "plugins {}", gradlew: "#!/bin/sh\n" },
        expected: "./gradlew test",
      },
    ];

    for (const fixture of cases) {
      const root = mkdtempSync(join(tmpdir(), `pushpals-native-${fixture.name}-`));
      try {
        for (const [file, content] of Object.entries(fixture.files)) {
          writeFileSync(join(root, file), content, "utf8");
        }
        const nativeVision = {
          one_sentence: "Keep data imports correct.",
          key_items: {
            target_users: ["Operators"],
            priorities: ["Improve import correctness"],
            objectives: [],
            guardrails: [],
            constraints: [],
            non_goals: [],
            metrics: [],
            testing_criteria: ["Run unit tests"],
            risk_policy: [],
            operating_model: [],
            governance: [],
          },
          section_numbers: ["1"],
        };
        const repoTargets = [
          {
            component_area: "src/imports",
            target_paths: ["src/imports/parse.ts"],
            write_globs: ["src/imports/parse.ts"],
            label: "src/imports/parse.ts",
            keywords: ["import", "correctness"],
          },
        ];
        const context = buildEngineInspirationContext({
          vision: nativeVision,
          snapshot,
          repoTargets,
        });
        const candidates = buildRepoVisionFallbackCandidates({
          engineInspiration: context,
          snapshotTopSignals: snapshot.top_signals,
          visionSectionRefs: ["1"],
          repoTargets,
          repoRoot: root,
          maxCandidates: 1,
        });
        expect(candidates[0]?.expected_validation).toContain(fixture.expected);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("repo fallback selects validation from the nearest target manifest in a polyglot repo", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-polyglot-validation-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { test: "node --test" } }),
        "utf8",
      );
      mkdirSync(join(root, "services", "indexer", "src"), { recursive: true });
      writeFileSync(
        join(root, "services", "indexer", "pyproject.toml"),
        "[project]\nname='indexer'\n[tool.pytest.ini_options]\n",
        "utf8",
      );
      writeFileSync(join(root, "services", "indexer", "src", "rank.py"), "def rank(): pass\n");
      const polyglotVision = {
        one_sentence: "Keep indexed search results accurate.",
        key_items: {
          target_users: ["Search operators"],
          priorities: ["Improve index ranking accuracy"],
          objectives: [],
          guardrails: [],
          constraints: [],
          non_goals: [],
          metrics: [],
          testing_criteria: ["npm run test"],
          risk_policy: [],
          operating_model: [],
          governance: [],
        },
        section_numbers: ["1"],
      };
      const repoTargets = [
        {
          component_area: "services/indexer/src",
          target_paths: ["services/indexer/src/rank.py"],
          write_globs: ["services/indexer/src/rank.py"],
          label: "services/indexer/src/rank.py",
          keywords: ["index", "ranking", "accuracy"],
        },
      ];
      const context = buildEngineInspirationContext({
        vision: polyglotVision,
        snapshot,
        repoTargets,
      });
      const candidates = buildRepoVisionFallbackCandidates({
        engineInspiration: context,
        snapshotTopSignals: snapshot.top_signals,
        visionSectionRefs: ["1"],
        repoTargets,
        repoRoot: root,
        maxCandidates: 1,
      });

      expect(candidates[0]?.expected_validation).toEqual(["python -m pytest services/indexer"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validation inference handles workspaces, nested modules, placeholders, and safe paths", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-matrix-"));
    const extraRoots: string[] = [];
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "node --test" } }),
        "utf8",
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
      mkdirSync(join(root, "packages", "my app", "src"), { recursive: true });
      writeFileSync(
        join(root, "packages", "my app", "package.json"),
        JSON.stringify({ scripts: { test: "vitest" } }),
        "utf8",
      );
      writeFileSync(join(root, "packages", "my app", "src", "index.ts"), "export {};\n");
      mkdirSync(join(root, "services", "api"), { recursive: true });
      writeFileSync(join(root, "services", "api", "go.mod"), "module example.test/api\n", "utf8");
      writeFileSync(join(root, "services", "api", "handler.go"), "package api\n", "utf8");

      expect(inferRepoValidationIdeas(root, ["packages/my app/src/index.ts"])).toEqual([
        'pnpm --dir "packages/my app" run test',
      ]);
      expect(inferRepoValidationIdeas(root, ["services/api/handler.go"])).toEqual([
        "go -C services/api test ./...",
      ]);
      expect(
        inferRepoValidationIdeas(root, ["services/$(touch unexpected)/handler.go"])[0],
      ).not.toContain("$(touch");

      const placeholderRoot = mkdtempSync(join(tmpdir(), "pushpals-placeholder-package-"));
      extraRoots.push(placeholderRoot);
      writeFileSync(
        join(placeholderRoot, "package.json"),
        JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
        "utf8",
      );
      writeFileSync(join(placeholderRoot, "main.ts"), "export {};\n", "utf8");
      expect(inferRepoValidationIdeas(placeholderRoot, ["main.ts"])).toEqual([]);

      const makeRoot = mkdtempSync(join(tmpdir(), "pushpals-make-no-test-"));
      extraRoots.push(makeRoot);
      writeFileSync(join(makeRoot, "Makefile"), "build:\n\tcc main.c\n", "utf8");
      writeFileSync(join(makeRoot, "main.c"), "int main(void) { return 0; }\n", "utf8");
      expect(inferRepoValidationIdeas(makeRoot, ["main.c"])).toEqual([]);

      const genericHclRoot = mkdtempSync(join(tmpdir(), "pushpals-generic-hcl-"));
      extraRoots.push(genericHclRoot);
      writeFileSync(join(genericHclRoot, "service.hcl"), 'service { name = "sample" }\n');
      expect(inferRepoValidationIdeas(genericHclRoot, ["service.hcl"])).toEqual([
        "git diff --check",
      ]);

      const requirementsOnlyRoot = mkdtempSync(join(tmpdir(), "pushpals-python-requirements-"));
      extraRoots.push(requirementsOnlyRoot);
      writeFileSync(join(requirementsOnlyRoot, "requirements.txt"), "pytest==9.0.0\n");
      writeFileSync(join(requirementsOnlyRoot, "service.py"), "def ready(): return True\n");
      expect(inferRepoValidationIdeas(requirementsOnlyRoot, ["service.py"])).toEqual([
        "python -m pytest",
      ]);

      const syntaxOnlyRoot = mkdtempSync(join(tmpdir(), "pushpals-syntax-only-"));
      extraRoots.push(syntaxOnlyRoot);
      writeFileSync(join(syntaxOnlyRoot, "worker.py"), "def ready(): return True\n");
      writeFileSync(join(syntaxOnlyRoot, "worker.js"), "export const ready = true;\n");
      writeFileSync(join(syntaxOnlyRoot, "worker.ts"), "export const ready: boolean = true;\n");
      writeFileSync(join(syntaxOnlyRoot, "README.md"), "# Ready\n");
      expect(inferRepoValidationIdeas(syntaxOnlyRoot, ["worker.py"])).toEqual([
        "python -m compileall worker.py",
      ]);
      expect(inferRepoValidationIdeas(syntaxOnlyRoot, ["worker.js"])).toEqual([
        "node --check worker.js",
      ]);
      expect(inferRepoValidationIdeas(syntaxOnlyRoot, ["worker.ts"])).toEqual([]);
      expect(inferRepoValidationIdeas(syntaxOnlyRoot, ["README.md"])).toEqual(["git diff --check"]);

      const oversizedManifestRoot = mkdtempSync(join(tmpdir(), "pushpals-oversized-manifest-"));
      extraRoots.push(oversizedManifestRoot);
      writeFileSync(
        join(oversizedManifestRoot, "package.json"),
        JSON.stringify({
          padding: "x".repeat(2 * 1024 * 1024),
          scripts: { test: "run-a-command-hidden-after-the-read-boundary" },
        }),
      );
      writeFileSync(
        join(oversizedManifestRoot, "module.ts"),
        "export const bounded: boolean = true;\n",
      );
      expect(inferRepoValidationIdeas(oversizedManifestRoot, ["module.ts"])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      for (const extraRoot of extraRoots) {
        rmSync(extraRoot, { recursive: true, force: true });
      }
    }
  });

  test("validation wrapper selection follows the effective worker platform", () => {
    expect(resolveWorkerValidationExecutionPlatform("auto", true, "win32")).toBe("linux_docker");
    expect(resolveWorkerValidationExecutionPlatform("auto", false, "win32")).toBe("windows");

    const root = mkdtempSync(join(tmpdir(), "pushpals-wrapper-platform-"));
    try {
      writeFileSync(join(root, "build.gradle.kts"), "plugins {}\n", "utf8");
      writeFileSync(join(root, "gradlew.bat"), "@echo off\r\n", "utf8");
      writeFileSync(join(root, "Main.java"), "class Main {}\n", "utf8");

      expect(inferRepoValidationIdeas(root, ["Main.java"], "windows")).toEqual([
        "cmd /c ./gradlew.bat test",
      ]);
      expect(inferRepoValidationIdeas(root, ["Main.java"], "linux_docker")).toEqual([
        "gradle test",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validation inference covers common non-JavaScript repository ecosystems", () => {
    const cases: Array<{
      name: string;
      files: Record<string, string>;
      target: string;
      expected: string[];
    }> = [
      {
        name: "ruby",
        files: {
          Gemfile: "source 'https://rubygems.org'\n",
          ".rspec": "--format progress\n",
          "lib/job.rb": "class Job; end\n",
        },
        target: "lib/job.rb",
        expected: ["bundle exec rspec"],
      },
      {
        name: "php",
        files: {
          "composer.json": JSON.stringify({ scripts: { test: "phpunit" } }),
          "src/Job.php": "<?php class Job {}\n",
        },
        target: "src/Job.php",
        expected: ["composer test"],
      },
      {
        name: "swift",
        files: {
          "Package.swift": "// swift-tools-version: 6.0\n",
          "Sources/App.swift": "struct App {}\n",
        },
        target: "Sources/App.swift",
        expected: ["swift test"],
      },
      {
        name: "dart",
        files: {
          "pubspec.yaml": "name: sample\ndev_dependencies:\n  test: any\n",
          "lib/app.dart": "void main() {}\n",
        },
        target: "lib/app.dart",
        expected: ["dart test"],
      },
      {
        name: "elixir",
        files: {
          "mix.exs": "defmodule Sample.MixProject do\nend\n",
          "lib/sample.ex": "defmodule Sample do\nend\n",
        },
        target: "lib/sample.ex",
        expected: ["mix test"],
      },
      {
        name: "zig",
        files: {
          "build.zig": "pub fn build(b: *std.Build) void {}\n",
          "src/main.zig": "pub fn main() void {}\n",
        },
        target: "src/main.zig",
        expected: ["zig build test"],
      },
      {
        name: "terraform",
        files: { "infrastructure/main.tf": "terraform {}\n" },
        target: "infrastructure/main.tf",
        expected: ["terraform fmt -check infrastructure/main.tf"],
      },
      {
        name: "clojure",
        files: {
          "deps.edn": "{:aliases {:test {:exec-fn sample.test/run}}}\n",
          "src/sample/core.clj": "(ns sample.core)\n",
        },
        target: "src/sample/core.clj",
        expected: ["clojure -X:test"],
      },
      {
        name: "shell",
        files: { "scripts/check.sh": "#!/bin/sh\nexit 0\n" },
        target: "scripts/check.sh",
        expected: ["sh -n scripts/check.sh"],
      },
      {
        name: "r",
        files: { "analysis/report.r": "print('ok')\n" },
        target: "analysis/report.r",
        expected: ["Rscript -e \"parse(file='analysis/report.r')\""],
      },
      {
        name: "lua",
        files: { "src/main.lua": "return true\n" },
        target: "src/main.lua",
        expected: ["luac -p src/main.lua"],
      },
      {
        name: "proto",
        files: {
          "buf.yaml": "version: v2\n",
          "proto/item.proto": 'syntax = "proto3";\n',
        },
        target: "proto/item.proto",
        expected: ["buf lint"],
      },
      {
        name: "cmake",
        files: {
          "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\n",
          "src/main.cpp": "int main() {}\n",
        },
        target: "src/main.cpp",
        expected: [
          "cmake -S . -B build",
          "cmake --build build",
          "ctest --test-dir build --output-on-failure",
        ],
      },
      {
        name: "bazel",
        files: {
          "MODULE.bazel": 'module(name = "sample")\n',
          "src/BUILD.bazel": 'cc_test(name = "main_test", srcs = ["main.cpp"])\n',
          "src/main.cpp": "int main() {}\n",
        },
        target: "src/main.cpp",
        expected: ["bazel test //src/..."],
      },
    ];

    for (const fixture of cases) {
      const root = mkdtempSync(join(tmpdir(), `pushpals-${fixture.name}-validation-`));
      try {
        for (const [path, content] of Object.entries(fixture.files)) {
          mkdirSync(join(root, path, ".."), { recursive: true });
          writeFileSync(join(root, path), content, "utf8");
        }
        expect(inferRepoValidationIdeas(root, [fixture.target])).toEqual(fixture.expected);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("manifest ownership routes nested Bazel, CMake, Buf, and Make targets", () => {
    const roots: string[] = [];
    const fixture = (name: string, files: Record<string, string>): string => {
      const root = mkdtempSync(join(tmpdir(), `pushpals-owned-${name}-`));
      roots.push(root);
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), content, "utf8");
      }
      return root;
    };
    try {
      const bazel = fixture("bazel", {
        "MODULE.bazel": 'module(name = "workspace")\n',
        "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
        "modules/native/BUILD.bazel": 'cc_test(name = "codec_test", srcs = ["codec.cpp"])\n',
        "modules/native/codec.cpp": "int main() {}\n",
      });
      expect(inferRepoValidationIdeas(bazel, ["modules/native/codec.cpp"])).toEqual([
        "bazel test //modules/native/...",
      ]);

      const cmake = fixture("cmake", {
        "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
        "modules/codec/CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\n",
        "modules/codec/src/codec.cpp": "int codec() { return 1; }\n",
      });
      expect(inferRepoValidationIdeas(cmake, ["modules/codec/src/codec.cpp"])).toEqual([
        "cmake -S modules/codec -B modules/codec/build",
        "cmake --build modules/codec/build",
        "ctest --test-dir modules/codec/build --output-on-failure",
      ]);

      const proto = fixture("buf", {
        "schemas/buf.yaml": "version: v2\n",
        "schemas/catalog/v1/item.proto": 'syntax = "proto3";\n',
      });
      expect(inferRepoValidationIdeas(proto, ["schemas/catalog/v1/item.proto"])).toEqual([
        "sh -c 'cd -- schemas && exec buf lint'",
      ]);

      const make = fixture("make", {
        "native/Makefile": "test:\n\t./run-tests\n",
        "native/src/main.c": "int main(void) { return 0; }\n",
      });
      expect(inferRepoValidationIdeas(make, ["native/src/main.c"])).toEqual([
        "make -C native test",
      ]);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows validation declines unsafe nested shell wrappers for paths with spaces", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-windows-space-wrapper-"));
    try {
      mkdirSync(join(root, "modules", "my gem", "lib"), { recursive: true });
      mkdirSync(join(root, "modules", "my gem", "spec"), { recursive: true });
      writeFileSync(join(root, "modules", "my gem", "Gemfile"), "source 'https://example.test'\n");
      writeFileSync(join(root, "modules", "my gem", ".rspec"), "--format progress\n");
      writeFileSync(join(root, "modules", "my gem", "lib", "job.rb"), "class Job; end\n");

      expect(inferRepoValidationIdeas(root, ["modules/my gem/lib/job.rb"], "windows")).toEqual([
        'ruby -c "modules/my gem/lib/job.rb"',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unsupported targets do not retain an LLM-invented validation command", () => {
    expect(normalizeTargetValidationIdeas(["bun test"], [])).toEqual([]);
    expect(normalizeTargetValidationIdeas(["git diff --check"], [])).toEqual([]);
    expect(
      normalizeTargetValidationIdeas(["bun test"], [], {
        allowConfiguredIdeasWithoutInference: true,
      }),
    ).toEqual(["bun test"]);
  });

  test("vision attribution rejects a mismatched explicit objective id", () => {
    const context = buildEngineInspirationContext({ vision, snapshot });
    const startup = context.compiled_repo_objectives.find((objective) =>
      objective.title.includes("Startup and environment stability"),
    );
    const activation = context.compiled_repo_objectives.find((objective) =>
      objective.title.includes("Activation: first PR"),
    );
    expect(startup).toBeDefined();
    expect(activation).toBeDefined();

    const attributed = resolveCompiledRepoObjectiveAttribution({
      explicitObjectiveId: startup?.id,
      candidateText:
        "Reduce activation time so a new maintainer reaches the first PR in under 30 minutes.",
      objectives: context.compiled_repo_objectives,
    });

    expect(attributed?.id).toBe(activation?.id);
    expect(attributed?.id).not.toBe(startup?.id);
  });

  test("vision ranking keeps a relevant late-discovered target in the ideation window", () => {
    const searchVision = {
      ...vision,
      key_items: {
        ...vision.key_items,
        priorities: ["Improve semantic search ranking accuracy"],
        objectives: [],
      },
    };
    const context = buildEngineInspirationContext({ vision: searchVision, snapshot });
    const genericTargets = Array.from({ length: 12 }, (_, index) => ({
      component_area: `modules/utility-${index}`,
      target_paths: [`modules/utility-${index}/handler.ts`],
      write_globs: [`modules/utility-${index}/handler.ts`],
      label: `modules/utility-${index}/handler.ts`,
      keywords: ["module", "utility", "handler"],
    }));
    const relevantTarget = {
      component_area: "services/search",
      target_paths: ["services/search/semanticRanker.ts"],
      write_globs: ["services/search/semanticRanker.ts"],
      label: "services/search/semanticRanker.ts",
      keywords: ["search", "semantic", "rank", "accuracy"],
    };

    const ranked = rankRepoTargetsForVision(
      [...genericTargets, relevantTarget],
      context.compiled_repo_objectives,
    );

    expect(ranked[0]?.label).toBe(relevantTarget.label);
    expect(ranked.slice(0, 8).some((target) => target.label === relevantTarget.label)).toBe(true);
  });

  test("vision compilation skips structural headings and keeps colliding objective ids distinct", () => {
    const sharedPrefix = "Improve the customer-facing recovery workflow with a deterministic ";
    const collisionVision = {
      ...vision,
      key_items: {
        ...vision.key_items,
        priorities: [
          `${sharedPrefix}first completion signal for imports`,
          `${sharedPrefix}second completion signal for exports`,
        ],
        objectives: [],
        metrics: [],
      },
      sections: [
        { number: "1", title: "Priorities", markdown: "- First\n- Second", truncated: false },
        { number: "2", title: "Non-goals", markdown: "- A distraction", truncated: false },
        {
          number: "3",
          title: "Offline recovery",
          markdown: "Restore interrupted work.",
          truncated: false,
        },
      ],
    };

    const context = buildEngineInspirationContext({ vision: collisionVision, snapshot });
    const ids = context.compiled_repo_objectives.map((objective) => objective.id);
    const titles = context.compiled_repo_objectives.map((objective) => objective.title);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length <= 80)).toBe(true);
    expect(titles).not.toContain("Priorities");
    expect(titles).not.toContain("Non-goals");
    expect(titles).not.toContain("Offline recovery");
  });

  test("detects internal PushPals failure labels before user-repo dispatch", () => {
    expect(
      containsPushPalsInternalUserRepoText(
        "Treat artifact_only_no_publishable_patch as explicit delivery evidence.",
      ),
    ).toBe(true);
    expect(
      containsPushPalsInternalUserRepoText(
        "Add no-reviewable-patch coverage for QualityGate failures.",
      ),
    ).toBe(true);
    expect(
      containsPushPalsInternalUserRepoText(
        "Make the app review path expose selected player actions clearly.",
      ),
    ).toBe(false);
    expect(
      containsPushPalsInternalUserRepoText(
        "Improve the repository's source control manager and review agent workflow.",
      ),
    ).toBe(false);
  });

  test("discovery preserves legitimate source-control and review-agent product code", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-review-product-"));
    try {
      mkdirSync(join(root, "src", "source_control_manager"), { recursive: true });
      writeFileSync(
        join(root, "src", "source_control_manager", "reviewAgent.ts"),
        "export const review = true;\n",
        "utf8",
      );

      const paths = discoverRepoTargetProfiles(root, 4).flatMap((profile) => profile.target_paths);
      expect(paths).toContain("src/source_control_manager/reviewAgent.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovery preserves tracked product paths that happen to share an agent name", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-agent-name-product-"));
    try {
      mkdirSync(join(root, "src", "workerpals"), { recursive: true });
      writeFileSync(
        join(root, "src", "workerpals", "scheduler.py"),
        "def schedule(): return True\n",
        "utf8",
      );

      const paths = discoverRepoTargetProfiles(root, 4).flatMap((profile) => profile.target_paths);
      expect(paths).toContain("src/workerpals/scheduler.py");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validation repair targets follow the failing repository toolchain", () => {
    const targetsFor = (command: string) =>
      validationRepairCommandTargetCandidates({
        command,
        failure_class: "test_failure",
        sample_error: `${command} failed`,
      } as any);

    expect(targetsFor("ruff check .")[0]).toBe("pyproject.toml");
    expect(targetsFor("cargo clippy")[0]).toBe("Cargo.toml");
    expect(targetsFor("go test ./...")[0]).toBe("go.mod");
    expect(targetsFor("./gradlew test")).toContain("build.gradle.kts");
    expect(targetsFor("dotnet test")[0]).toBe("global.json");
  });

  test("buildEngineInspirationContext compiles weighted objectives, gaps, and sorted building blocks", () => {
    const context = buildEngineInspirationContext({ vision, snapshot });
    expect(context.compiled_objectives.length).toBeGreaterThan(0);
    expect(context.opportunity_gaps.length).toBeGreaterThan(0);
    expect(context.building_blocks.length).toBeGreaterThan(0);
    expect(
      context.compiled_objectives.some(
        (objective) => objective.id === "reliable_autonomous_delivery",
      ),
    ).toBe(true);
    expect(context.building_blocks.some((block) => block.algorithm === "portfolio_bandit")).toBe(
      true,
    );
    expect(context.building_blocks[0].score).toBeGreaterThanOrEqual(
      context.building_blocks[context.building_blocks.length - 1].score,
    );
  });

  test("buildEngineFallbackCandidates produces scoped actionable candidate seeds", () => {
    const context = buildEngineInspirationContext({ vision, snapshot });
    const candidates = buildEngineFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: vision.section_numbers,
      maxCandidates: 3,
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(3);

    for (const candidate of candidates) {
      const objectiveType = String(candidate.objective_type ?? "");
      const triggerType = String(candidate.trigger_type ?? "");
      const validation = Array.isArray(candidate.expected_validation)
        ? candidate.expected_validation.map((value) => String(value))
        : [];
      const targetPaths = Array.isArray(candidate.target_paths) ? candidate.target_paths : [];
      const sectionRefs = Array.isArray(candidate.vision_section_refs)
        ? candidate.vision_section_refs
        : [];
      expect(
        [
          "flaky_test",
          "lint_fix",
          "type_fix",
          "small_refactor",
          "feature_small",
          "feature_medium",
          "feature_large",
          "docs",
          "dep_bump",
        ].includes(objectiveType),
      ).toBe(true);
      expect(
        [
          "test_failure",
          "lint_failure",
          "typecheck_failure",
          "queue_health",
          "regret_signal",
        ].includes(triggerType),
      ).toBe(true);
      expect(targetPaths.length).toBeGreaterThan(0);
      expect(sectionRefs.length).toBeGreaterThan(0);
      expect(validation.length).toBeGreaterThan(0);
      expect(validation.every((command) => command.startsWith("bun "))).toBe(true);
    }
  });

  test("repo vision fallback preserves repo-native priority headings before meta engine work", () => {
    const billingVision = {
      one_sentence:
        "The service helps finance teams reconcile imported invoices quickly and accurately.",
      key_items: {
        target_users: ["Finance teams processing large invoice batches"],
        priorities: [
          "Improve invoice reconciliation during large imports",
          "Make approval controls clearer, faster, and harder to misuse",
          "Strengthen onboarding for review, approve, and export behavior",
          "Polish the workspace shell so it matches the reconciliation quality bar",
          "Make web delivery and navigation trustworthy",
          "Preserve performance while invoice volume and workspace detail increase",
          "Add the vision_compiler building block to the active repo autonomy loop",
        ],
        objectives: [
          "Sharpen the core reconciliation workflow",
          "Tighten approval decision surfaces",
          "Make the web review path easy to trust",
          "Use vision_compiler to keep autonomous delivery aligned",
        ],
        guardrails: [
          "Protect data clarity before adding visual density",
          "Keep critical approvals explicit and reversible",
        ],
        constraints: [
          "Desktop and smaller-screen usability both matter",
          "Browser validation is required for interface-affecting work",
        ],
        non_goals: ["Unrelated accounting modules that slow the core workflow"],
        metrics: [
          "Reconciliation remains readable during large imports",
          "Browser smoke coverage exercises the main shell path",
        ],
        testing_criteria: ["bun run test:root", "bun run smoke:web"],
        risk_policy: ["Do not ship changes that obscure invoice discrepancies"],
        operating_model: ["Changes should validate rendered interfaces when affected"],
        governance: ["Source of truth is the reconciliation-quality north star"],
      },
      section_numbers: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    };
    const repoTargets = [
      {
        component_area: "src",
        target_paths: ["src/internalDelivery.ts"],
        write_globs: ["src/internalDelivery.ts"],
        label: "src/internalDelivery.ts",
        keywords: ["src", "internal", "delivery"],
      },
      {
        component_area: "src",
        target_paths: ["src/reconcileInvoices.ts"],
        write_globs: ["src/reconcileInvoices.ts"],
        label: "src/reconcileInvoices.ts",
        keywords: ["src", "reconcile", "invoice", "import"],
      },
      {
        component_area: "tests",
        target_paths: ["tests/reconcileInvoices.test.ts"],
        write_globs: ["tests/reconcileInvoices.test.ts"],
        label: "tests/reconcileInvoices.test.ts",
        keywords: ["tests", "reconcile", "invoice"],
      },
    ];

    const context = buildEngineInspirationContext({
      vision: billingVision,
      snapshot,
      repoTargets,
    });
    const topRepoObjective = context.compiled_repo_objectives[0];
    expect(topRepoObjective.title).toBe("Improve invoice reconciliation during large imports");
    expect(topRepoObjective.category).toBe("product_core");

    const candidates = buildRepoVisionFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: billingVision.section_numbers,
      repoTargets,
      maxCandidates: 3,
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(String(candidates[0].title)).toContain("Improve invoice reconciliation");
    expect(candidates[0].target_paths).toEqual(["src/reconcileInvoices.ts"]);
    expect(candidates[0].component_area).toBe("src");
    expect(candidates[0].expected_validation).toContain("bun run test:root");
    expect(candidates[0].engine_trial).toBeUndefined();
    expect(String(candidates[0].vision_alignment_reason)).toContain("priority=1");
    expect(
      candidates.some((candidate) =>
        String(candidate.title).includes("vision_compiler building block"),
      ),
    ).toBe(false);
  });

  test("repo vision fallback uses generic heading categories without repo-specific blueprints", () => {
    const genericVision = {
      one_sentence:
        "DocPilot helps teams search, import, and validate shared knowledge with predictable workflows.",
      key_items: {
        target_users: ["Support teams", "Operations leads"],
        priorities: [
          "Improve query answer accuracy for imported documents",
          "Reduce onboarding mistakes in the first workspace setup",
          "Preserve performance during large document imports",
          "Strengthen validation for parser regressions",
        ],
        objectives: [
          "Make search results easier to trust",
          "Keep imports reversible and observable",
        ],
        guardrails: ["Do not hide source citations", "Avoid broad rewrites of parser behavior"],
        constraints: ["Validation must cover import and search flows"],
        non_goals: ["Do not add a new collaboration surface"],
        metrics: ["Answer accuracy improves", "Import validation catches malformed files"],
        testing_criteria: ["bun test tests/parser-regressions.test.ts"],
        risk_policy: ["Parser regressions are release blockers"],
        operating_model: ["Prefer small, test-backed changes"],
        governance: ["Document high-risk parser changes"],
      },
      section_numbers: ["1", "4", "6", "7", "9"],
    };
    const repoTargets = [
      {
        component_area: "src/search",
        target_paths: ["src/search/rankAnswers.ts"],
        write_globs: ["src/search/rankAnswers.ts"],
        label: "src/search/rankAnswers.ts",
        keywords: ["src", "search", "rank", "answers", "query", "accuracy", "documents"],
      },
      {
        component_area: "src/import",
        target_paths: ["src/import/parser.ts"],
        write_globs: ["src/import/parser.ts"],
        label: "src/import/parser.ts",
        keywords: ["src", "import", "parser", "documents", "large"],
      },
      {
        component_area: "tests",
        target_paths: ["tests/parser-regressions.test.ts"],
        write_globs: ["tests/parser-regressions.test.ts"],
        label: "tests/parser-regressions.test.ts",
        keywords: ["tests", "parser", "regressions", "validation"],
      },
    ];

    const context = buildEngineInspirationContext({
      vision: genericVision,
      snapshot,
      repoTargets,
    });
    const topRepoObjective = context.compiled_repo_objectives[0];
    expect(topRepoObjective.title).toBe("Improve query answer accuracy for imported documents");
    expect(topRepoObjective.category).toBe("product_core");

    const candidates = buildRepoVisionFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: genericVision.section_numbers,
      repoTargets,
      maxCandidates: 3,
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(String(candidates[0].title)).toContain("Improve query answer accuracy");
    expect(candidates[0].target_paths).toEqual(["src/search/rankAnswers.ts"]);
    expect(candidates[0].expected_validation).toContain(
      "bun test tests/parser-regressions.test.ts",
    );
    expect(String(candidates[0].problem_statement)).toContain("repo's own product/domain language");
    expect(candidates[0].engine_trial).toBeUndefined();
  });

  test("repo vision fallback keeps navigation work on behavior-owning targets", () => {
    const webVision = {
      one_sentence: "The app ships a trustworthy browser-playable product shell.",
      key_items: {
        target_users: ["People using the browser application"],
        priorities: ["Make web delivery and navigation trustworthy"],
        objectives: ["Make the web review path easy to trust"],
        guardrails: ["Keep user-repo work focused on app behavior"],
        constraints: ["Browser validation is required for UI-affecting work"],
        non_goals: ["Do not add orchestration internals to the application"],
        metrics: ["Browser smoke coverage exercises the main shell path"],
        testing_criteria: ["bun run web:e2e"],
        risk_policy: ["Low-risk shell validation changes can ship autonomously"],
        operating_model: ["Workers should use repo-native validation"],
        governance: ["Review coverage should describe product behavior"],
      },
      section_numbers: ["4", "6", "9"],
    };
    const repoTargets = [
      {
        component_area: "tests",
        target_paths: ["tests/navigation.test.ts"],
        write_globs: ["tests/navigation.test.ts"],
        label: "tests/navigation.test.ts",
        keywords: ["tests", "navigation"],
      },
      {
        component_area: "tools",
        target_paths: ["tools/browser-smoke.js"],
        write_globs: ["tools/browser-smoke.js"],
        label: "tools/browser-smoke.js",
        keywords: ["tools", "web", "browser", "smoke"],
      },
      {
        component_area: "src/navigation",
        target_paths: ["src/navigation/router.ts"],
        write_globs: ["src/navigation/router.ts"],
        label: "src/navigation/router.ts",
        keywords: ["src", "navigation", "router", "web"],
      },
    ];

    const context = buildEngineInspirationContext({
      vision: webVision,
      snapshot,
      repoTargets,
    });
    const candidates = buildRepoVisionFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: webVision.section_numbers,
      repoTargets,
      maxCandidates: 2,
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(String(candidates[0].title)).toContain("web delivery");
    expect(candidates[0].target_paths).toEqual(["src/navigation/router.ts"]);
    expect(candidates[0].expected_validation).toContain("bun run web:e2e");
    expect(JSON.stringify(candidates)).not.toContain("tests/navigation.test.ts");
  });

  test("buildEngineInspirationContext merges external inspiration patterns with source attribution", () => {
    const context = buildEngineInspirationContext({
      vision,
      snapshot,
      inspirationPatterns: [
        {
          id: "ext_repo_1",
          sourceType: "external_repo",
          sourceLabel: "acme/autonomy-lab",
          sourceUrl: "https://example.com/acme/autonomy-lab",
          sourceRefs: ["README#queue-bandit"],
          algorithm: "queue_portfolio_bandit",
          whenToUse: "queue backpressure and worker saturation are recurring",
          summary: "Allocate autonomous work across lanes using queue pressure + regret loops.",
          tags: ["queue", "backpressure", "worker", "portfolio"],
          qualityScore: 0.92,
          freshnessScore: 0.81,
          seenCount: 7,
          validationIdeas: ["bun run test:root"],
          metadata: {
            component_area: "apps/server",
            target_paths: ["apps/server/src/autonomy.ts"],
            write_globs: ["apps/server/src/*"],
          },
        },
      ],
    });
    expect(context.source_patterns.length).toBe(1);
    const externalBlock = context.building_blocks.find((entry) => entry.id.startsWith("insp_"));
    expect(externalBlock).toBeDefined();
    expect(externalBlock?.algorithm).toBe("queue_portfolio_bandit");
    expect(externalBlock?.source_type).toBe("external_repo");
    expect(externalBlock?.candidate_shape.component_area).toBe("apps/server");
    expect(externalBlock?.score ?? 0).toBeGreaterThan(0.2);
  });

  test("buildEngineInspirationContext adapts building blocks to generic repo targets", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-ideas-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src", "autonomy.ts"), "// fixture\n", "utf8");
    writeFileSync(join(root, "src", "queue.ts"), "// fixture\n", "utf8");
    writeFileSync(join(root, "tests", "autonomy.test.ts"), "// fixture\n", "utf8");
    writeFileSync(join(root, "README.md"), "# fixture\n", "utf8");

    try {
      const repoTargets = [
        {
          component_area: "src",
          target_paths: ["src/autonomy.ts"],
          write_globs: ["src/autonomy.ts"],
          label: "src/autonomy.ts",
          keywords: ["src", "autonomy", "queue"],
        },
        {
          component_area: "src",
          target_paths: ["src/queue.ts"],
          write_globs: ["src/queue.ts"],
          label: "src/queue.ts",
          keywords: ["src", "queue"],
        },
        {
          component_area: "tests",
          target_paths: ["tests/autonomy.test.ts"],
          write_globs: ["tests/autonomy.test.ts"],
          label: "tests/autonomy.test.ts",
          keywords: ["tests", "autonomy"],
        },
      ];
      const context = buildEngineInspirationContext({
        vision,
        snapshot,
        repoRoot: root,
        repoTargets,
        inspirationPatterns: [
          {
            id: "ext_repo_generic_1",
            sourceType: "external_repo",
            sourceLabel: "acme/autonomy-lab",
            sourceUrl: "https://example.com/acme/autonomy-lab",
            sourceRefs: ["README#queue-bandit"],
            algorithm: "queue_portfolio_bandit",
            whenToUse: "queue backpressure and worker saturation are recurring",
            summary: "Allocate autonomous work across lanes using queue pressure + regret loops.",
            tags: ["queue", "backpressure", "worker", "portfolio"],
            qualityScore: 0.92,
            freshnessScore: 0.81,
            seenCount: 7,
            validationIdeas: ["bun run test:root"],
            metadata: {
              component_area: "apps/server",
              target_paths: ["apps/server/src/autonomy.ts"],
              write_globs: ["apps/server/src/*"],
            },
          },
        ],
      });

      const opportunityGraphBlock = context.building_blocks.find(
        (entry) => entry.id === "opportunity_graph_pipeline",
      );
      expect(opportunityGraphBlock).toBeUndefined();

      const externalBlock = context.building_blocks.find((entry) => entry.id.startsWith("insp_"));
      expect(externalBlock?.candidate_shape.component_area).toBe("src");
      expect(externalBlock?.candidate_shape.target_paths[0]).toContain("src/");
      expect(externalBlock?.candidate_shape.target_paths[0]).not.toContain("apps/server");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("filters archived inspiration sources and boosts trusted sources into fallback objective seeds", () => {
    const context = buildEngineInspirationContext({
      vision,
      snapshot,
      inspirationPatterns: [
        {
          id: "ext_trusted_1",
          fingerprint: "fp_trusted_queue_strategy",
          sourceType: "external_repo",
          sourceLabel: "trusted/workforce-lab",
          sourceUrl: "https://example.com/trusted/workforce-lab",
          sourceRefs: ["README#adaptive-queue-scheduler"],
          algorithm: "trusted_queue_scheduler",
          whenToUse: "queue backpressure and worker throughput are unstable",
          summary:
            "Prioritize autonomous work by trust-weighted queue pressure and regret feedback.",
          tags: ["queue", "backpressure", "worker", "regret"],
          qualityScore: 0.56,
          freshnessScore: 0.48,
          seenCount: 4,
          validationIdeas: ["bun run test:root"],
          metadata: {
            component_area: "apps/server",
            target_paths: ["apps/server/src/autonomy.ts"],
            write_globs: ["apps/server/src/*"],
          },
        },
        {
          id: "ext_archived_1",
          fingerprint: "fp_archived_retry_loop",
          sourceType: "external_doc",
          sourceLabel: "archived/retry-notes",
          sourceUrl: "https://example.com/archived/retry-notes",
          sourceRefs: ["docs#retry-loop"],
          algorithm: "archived_retry_loop",
          whenToUse: "retry storms and queue retries keep cascading",
          summary: "A retry loop idea that previously caused churn and should be retired.",
          tags: ["retry", "queue", "storm"],
          qualityScore: 0.95,
          freshnessScore: 0.92,
          seenCount: 9,
          validationIdeas: ["bun run test:root"],
          metadata: {
            component_area: "apps/server",
            target_paths: ["apps/server/src/autonomy.ts"],
            write_globs: ["apps/server/src/*"],
          },
        },
      ],
      sourceInsights: [
        {
          sourceFingerprint: "fp_trusted_queue_strategy",
          sourceType: "external_repo",
          curationStatus: "trusted",
          curationReason: "strong real-world outcomes",
          trustScore: 0.93,
          freshnessScore: 0.86,
          sampleCount: 9,
        },
        {
          sourceFingerprint: "fp_archived_retry_loop",
          sourceType: "external_doc",
          curationStatus: "archived",
          curationReason: "low-performing source",
          trustScore: 0.14,
          freshnessScore: 0.22,
          sampleCount: 11,
        },
      ],
    });

    expect(
      context.source_patterns.some((pattern) => pattern.algorithm === "archived_retry_loop"),
    ).toBe(false);
    const trustedSourcePattern = context.source_patterns.find(
      (pattern) => pattern.algorithm === "trusted_queue_scheduler",
    );
    expect(trustedSourcePattern).toBeDefined();
    expect(trustedSourcePattern?.source_curation_status).toBe("trusted");
    const trustedBlock = context.building_blocks.find(
      (block) => block.algorithm === "trusted_queue_scheduler",
    );
    expect(trustedBlock).toBeDefined();
    expect(trustedBlock?.source_curation_status).toBe("trusted");
    expect(context.building_blocks.some((block) => block.algorithm === "archived_retry_loop")).toBe(
      false,
    );

    const fallback = buildEngineFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: vision.section_numbers,
      maxCandidates: 6,
    });
    expect(
      fallback.some((candidate) => {
        const trial = (candidate as Record<string, unknown>).engine_trial as
          | Record<string, unknown>
          | undefined;
        return (
          String(candidate.title ?? "")
            .toLowerCase()
            .includes("trusted_queue_scheduler") ||
          String(trial?.algorithm ?? "")
            .toLowerCase()
            .includes("trusted_queue_scheduler")
        );
      }),
    ).toBe(true);
    expect(
      fallback.some((candidate) =>
        String(candidate.title ?? "")
          .toLowerCase()
          .includes("archived_retry_loop"),
      ),
    ).toBe(false);
  });

  test("summarizeCommitHistoryHints extracts recurring local motifs", () => {
    const hints = summarizeCommitHistoryHints([
      "autonomy: queue backpressure guardrail for worker saturation",
      "server: queue p95 telemetry + dispatch throttling",
      "merge conflict retry handling for autonomous PRs",
      "policy: scope guardrail validation hardening",
      "tests: flaky retry stabilization for integration jobs",
    ]);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some((entry) => entry.motif_id === "queue_backpressure")).toBe(true);
    const queue = hints.find((entry) => entry.motif_id === "queue_backpressure");
    expect(queue?.count).toBe(2);
    expect((queue?.sample_subjects ?? []).length).toBeGreaterThan(0);
  });

  test("saturated test-only commit history does not emit another history test block", () => {
    const hints = summarizeCommitHistoryHints(
      Array.from({ length: 24 }, (_, index) => `feat(worker): expand app test coverage ${index}`),
    );
    const testHint = hints.find((entry) => entry.motif_id === "test_flake_reliability");
    expect(testHint?.count).toBe(24);
    expect(testHint?.signal).toBe(1);

    const context = buildEngineInspirationContext({
      vision,
      snapshot,
      commitHistoryHints: hints,
    });

    expect(
      context.building_blocks.some((block) => block.id === "history_test_flake_reliability"),
    ).toBe(false);
  });

  test("generic repositories omit PushPals-internal blueprints and gaps even under queue pressure", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-generic-inspiration-boundary-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "catalog.ts"), "export const catalog = true;\n", "utf8");
      const genericVision = {
        ...vision,
        one_sentence: "Help librarians keep a searchable community catalog.",
        key_items: {
          ...vision.key_items,
          priorities: ["Improve catalog search relevance for librarians"],
          objectives: [],
          metrics: ["Fewer empty search results"],
          testing_criteria: [],
          operating_model: [],
        },
      };
      const repoTargets = discoverRepoTargetProfiles(root, 8);

      const context = buildEngineInspirationContext({
        vision: genericVision,
        snapshot: {
          ...snapshot,
          top_signals: [
            { signal_id: "sig_queue", type: "queue_health", value: 0.99, evidence: "p95 high" },
          ],
          state_traits: [
            {
              trait_id: "queue_latency_high",
              category: "weakness",
              focus: "queue",
              score: 0.99,
              evidence: "request queue is saturated",
            },
          ],
        },
        repoRoot: root,
        repoTargets,
      });

      const internalObjectiveIds = new Set([
        "reliable_autonomous_delivery",
        "merge_conversion_and_rework",
        "mass_audience_activation",
        "policy_and_governance",
        "workforce_scaling",
      ]);
      const internalBuildingBlockIds = new Set([
        "vision_compiler_refresh",
        "opportunity_graph_pipeline",
        "workforce_orchestrator",
        "multi_agent_pr_collaboration",
      ]);
      expect(
        context.compiled_objectives.some((objective) => internalObjectiveIds.has(objective.id)),
      ).toBe(false);
      expect(context.opportunity_gaps).toEqual([]);
      expect(context.building_blocks.some((block) => internalBuildingBlockIds.has(block.id))).toBe(
        false,
      );
      expect(context.compiled_repo_objectives.map((objective) => objective.title)).toContain(
        "Improve catalog search relevance for librarians",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generic repositories ignore shared control-plane seeds and retain relevant external patterns", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-shared-inspiration-boundary-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "catalog.ts"), "export const catalog = true;\n", "utf8");
      const genericVision = {
        ...vision,
        one_sentence: "Help readers find relevant catalog entries.",
        key_items: {
          ...vision.key_items,
          priorities: ["Improve catalog search relevance"],
          objectives: [],
          metrics: [],
          testing_criteria: [],
        },
      };

      const context = buildEngineInspirationContext({
        vision: genericVision,
        snapshot,
        repoRoot: root,
        repoTargets: discoverRepoTargetProfiles(root, 8),
        inspirationPatterns: [
          {
            id: "shared_static_seed",
            source_type: "internal_doc",
            source_label: "pushpals:autonomy-engine",
            algorithm: "catalog_search_dispatch_guard",
            when_to_use: "when catalog search needs better relevance",
            summary: "Tune worker dispatch while improving catalog search relevance.",
            tags: ["catalog", "search"],
            metadata: { origin: "autonomy_engine_seed" },
          },
          {
            id: "shared_commit_motif",
            source_type: "internal_doc",
            source_label: "pushpals:commit-history",
            algorithm: "commit_history_catalog_search",
            when_to_use: "when catalog search commits recur",
            summary: "Repeat a motif learned from another repository's commits.",
            tags: ["catalog", "search"],
            metadata: { origin: "autonomy_engine_commit_history" },
          },
          {
            id: "external_search_pattern",
            source_type: "external_doc",
            source_label: "search-quality-guide",
            algorithm: "catalog_relevance_feedback",
            when_to_use: "when catalog search relevance needs improvement",
            summary: "Use empty-result feedback to improve catalog search relevance.",
            tags: ["catalog", "search", "relevance"],
          },
        ],
      });

      expect(context.source_patterns.map((pattern) => pattern.id)).toEqual([
        "external_search_pattern",
      ]);
      expect(context.building_blocks.some((block) => block.id.includes("shared_static_seed"))).toBe(
        false,
      );
      expect(
        context.building_blocks.some((block) => block.id.includes("shared_commit_motif")),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repository ideation excludes queue and worker health but keeps validation and regret", () => {
    const scoped = scopeIdeationSignalsToRepository(
      {
        top_signals: [
          { signal_id: "queue", type: "queue_health", value: 1, evidence: "pending jobs" },
          { signal_id: "test", type: "test_failure", value: 0.8, evidence: "unit test" },
          { signal_id: "regret", type: "regret_signal", value: 0.7, evidence: "reopened" },
        ],
        state_traits: [
          {
            trait_id: "worker_capacity_low",
            category: "weakness",
            focus: "worker queue",
            score: 1,
            evidence: "no idle workers",
          },
          {
            trait_id: "repo_validation_red",
            category: "risk",
            focus: "repository validation",
            score: 0.9,
            evidence: "required test failed",
          },
          {
            trait_id: "search_quality_opportunity",
            category: "opportunity",
            focus: "catalog relevance",
            score: 0.6,
            evidence: "empty results",
          },
        ],
      },
      false,
    );

    expect(scoped.top_signals.map((signal) => signal.signal_id)).toEqual(["test", "regret"]);
    expect(scoped.state_traits.map((trait) => trait.trait_id)).toEqual([
      "repo_validation_red",
      "search_quality_opportunity",
    ]);
  });

  test("target matching ignores noisy prose stopwords and selects the safety owner", () => {
    const safetyVision = {
      ...vision,
      key_items: {
        ...vision.key_items,
        priorities: ["Make it safe for all users to recover their work"],
        objectives: [],
        metrics: [],
        testing_criteria: [],
      },
    };
    const context = buildEngineInspirationContext({ vision: safetyVision, snapshot });
    const candidates = buildRepoVisionFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: vision.section_numbers,
      maxCandidates: 1,
      repoTargets: [
        {
          component_area: "src/it/to",
          target_paths: ["src/it/to/for.ts"],
          write_globs: ["src/it/to/for.ts"],
          label: "src/it/to/for.ts",
          keywords: ["src", "it", "to", "for"],
        },
        {
          component_area: "src/safe",
          target_paths: ["src/safe/recovery.ts"],
          write_globs: ["src/safe/recovery.ts"],
          label: "src/safe/recovery.ts",
          keywords: ["src", "safe", "recovery"],
        },
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.target_paths).toEqual(["src/safe/recovery.ts"]);
  });

  test("repository discovery samples late packages in a 200-package catalog", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-large-package-catalog-"));
    try {
      for (let index = 0; index < 200; index += 1) {
        const packageDirectory = join(
          root,
          "packages",
          `package-${String(index).padStart(3, "0")}`,
        );
        mkdirSync(packageDirectory, { recursive: true });
        writeFileSync(join(packageDirectory, "index.ts"), `export const id = ${index};\n`, "utf8");
      }

      const paths = discoverRepoTargetProfiles(root, 16).flatMap((profile) => profile.target_paths);
      const sampledIndexes = paths
        .map((path) => Number(path.match(/package-(\d{3})\//)?.[1] ?? -1))
        .filter((value) => value >= 0);

      expect(sampledIndexes).toHaveLength(16);
      expect(Math.max(...sampledIndexes)).toBeGreaterThanOrEqual(175);
      expect(sampledIndexes.some((index) => index < 50)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generic packages prefer the standard test script over a test:root convention", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-generic-package-scripts-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "generic-library",
          scripts: {
            test: "vitest run",
            "test:root": "echo repository-specific aggregate",
          },
        }),
        "utf8",
      );

      expect(inferRepoValidationIdeas(root, ["src/index.ts"])).toEqual(["npm run test"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("common explanatory and planning headings do not compile as objectives", () => {
    const structuralVision = {
      ...vision,
      key_items: {
        ...vision.key_items,
        priorities: [],
        objectives: [],
        metrics: [],
      },
      sections: [
        "Open questions",
        "Assumptions",
        "Dependencies",
        "Architecture",
        "Milestones",
        "Background",
        "Non-goals",
      ].map((title, index) => ({
        number: String(index + 1),
        title,
        markdown: `Context for ${title.toLowerCase()}.`,
        truncated: false,
      })),
    };

    const context = buildEngineInspirationContext({ vision: structuralVision, snapshot });

    expect(context.compiled_repo_objectives).toEqual([]);
  });

  test("actionable prose under a priority container compiles without treating the heading as work", () => {
    const proseVision = {
      ...vision,
      key_items: {
        ...vision.key_items,
        priorities: [],
        objectives: [],
        metrics: [],
      },
      sections: [
        {
          number: "4",
          title: "Priorities",
          markdown:
            "The current priority is to reduce checkout abandonment.\n\nBackground context explains the market.",
          truncated: false,
        },
      ],
    };

    const context = buildEngineInspirationContext({ vision: proseVision, snapshot });

    expect(context.compiled_repo_objectives.map((objective) => objective.title)).toEqual([
      "The current priority is to reduce checkout abandonment.",
    ]);
    expect(context.compiled_repo_objectives[0]?.section_ref).toBe("4");
  });

  test("repo fallback resolves auto Docker execution to the Linux project wrapper", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-auto-docker-wrapper-"));
    try {
      mkdirSync(join(root, "src", "main", "java", "example"), { recursive: true });
      writeFileSync(join(root, "build.gradle"), "plugins { id 'java' }\n", "utf8");
      writeFileSync(join(root, "gradlew"), '#!/bin/sh\nexec gradle "$@"\n', "utf8");
      writeFileSync(join(root, "gradlew.bat"), "@echo off\r\ngradle %*\r\n", "utf8");
      writeFileSync(
        join(root, "src", "main", "java", "example", "Safety.java"),
        "package example; final class Safety {}\n",
        "utf8",
      );
      const wrapperVision = {
        ...vision,
        key_items: {
          ...vision.key_items,
          priorities: ["Improve safety behavior"],
          objectives: [],
          metrics: [],
          testing_criteria: [],
        },
      };
      const repoTargets = discoverRepoTargetProfiles(root, 8);
      const context = buildEngineInspirationContext({
        vision: wrapperVision,
        snapshot,
        repoRoot: root,
        repoTargets,
      });

      const candidates = buildRepoVisionFallbackCandidates({
        engineInspiration: context,
        snapshotTopSignals: snapshot.top_signals,
        visionSectionRefs: vision.section_numbers,
        maxCandidates: 1,
        repoTargets,
        repoRoot: root,
        executionPlatform: "auto",
        workerpalDocker: true,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.expected_validation).toEqual(["./gradlew test"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
