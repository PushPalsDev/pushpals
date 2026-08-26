import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  inferRepositoryValidationSteps,
  inferToolRequirementsForValidationCommand,
  mergeRepositoryValidationSteps,
  normalizeTrustedValidationCommands,
} from "shared";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pushpals-repo-validation-"));
  roots.push(root);
  return root;
}

function write(root: string, path: string, text: string): void {
  const target = join(root, ...path.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text, "utf8");
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("repository-native validation inference", () => {
  test("uses a focused Bun test for a changed JavaScript test", () => {
    const root = fixture();
    write(root, "package.json", JSON.stringify({ scripts: { test: "bun test" } }));
    write(root, "bun.lock", "");
    write(root, "tests/api/review.test.ts", "test('ok', () => {});");

    expect(
      inferRepositoryValidationSteps({
        repoRoot: root,
        changedPaths: ["tests/api/review.test.ts"],
      }),
    ).toEqual(["bun test ./tests/api/review.test.ts"]);
  });

  test("honors the declared JavaScript package manager without assuming Bun", () => {
    const cases = [
      ["pnpm@10.0.0", "pnpm --dir packages/web run test"],
      ["yarn@4.0.0", "yarn --cwd packages/web run test"],
      ["npm@11.0.0", "npm --prefix packages/web run test"],
    ] as const;
    for (const [packageManager, expected] of cases) {
      const root = fixture();
      write(root, "package.json", JSON.stringify({ packageManager }));
      write(root, "packages/web/package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
      write(root, "packages/web/src/page.ts", "export const page = true;");
      expect(
        inferRepositoryValidationSteps({
          repoRoot: root,
          changedPaths: ["packages/web/src/page.ts"],
        }),
      ).toEqual([expected]);
    }
  });

  test("infers Python, Go, and Rust checks from nearby manifests", () => {
    const python = fixture();
    write(python, "pyproject.toml", "[tool.pytest.ini_options]\ntestpaths = ['tests']\n");
    write(python, "tests/test_api.py", "def test_api(): pass\n");
    expect(
      inferRepositoryValidationSteps({ repoRoot: python, changedPaths: ["tests/test_api.py"] }),
    ).toEqual(["python -m pytest tests/test_api.py"]);

    const go = fixture();
    write(go, "services/api/go.mod", "module example.test/api\n");
    write(go, "services/api/handler_test.go", "package api\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: go,
        changedPaths: ["services/api/handler_test.go"],
      }),
    ).toEqual(["go -C services/api test ./..."]);

    const rust = fixture();
    write(rust, "crates/core/Cargo.toml", "[package]\nname='core'\nversion='0.1.0'\n");
    write(rust, "crates/core/src/lib.rs", "pub fn ok() -> bool { true }\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: rust,
        changedPaths: ["crates/core/src/lib.rs"],
      }),
    ).toEqual(["cargo test --manifest-path crates/core/Cargo.toml"]);
  });

  test("infers JVM and .NET checks as direct, shell-free commands", () => {
    const maven = fixture();
    write(maven, "services/api/pom.xml", "<project />");
    write(maven, "services/api/src/main/java/Api.java", "class Api {}");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: maven,
        changedPaths: ["services/api/src/main/java/Api.java"],
      }),
    ).toEqual(["mvn -f services/api/pom.xml test"]);

    const gradle = fixture();
    write(gradle, "build.gradle.kts", "plugins { java }");
    write(gradle, "src/main/kotlin/App.kt", "class App");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: gradle,
        changedPaths: ["src/main/kotlin/App.kt"],
      }),
    ).toEqual(["gradle test"]);

    const dotnet = fixture();
    write(dotnet, "src/App/App.csproj", "<Project />");
    write(dotnet, "src/App/Program.cs", "class Program {}");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: dotnet,
        changedPaths: ["src/App/Program.cs"],
      }),
    ).toEqual(["dotnet test src/App/App.csproj"]);
  });

  test("infers Ruby and PHP checks without shell wrappers", () => {
    const ruby = fixture();
    write(ruby, "Gemfile", "source 'https://rubygems.org'\ngem 'rspec'\n");
    write(ruby, "spec/widget_spec.rb", "RSpec.describe 'widget' do\nend\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: ruby,
        changedPaths: ["spec/widget_spec.rb"],
      }),
    ).toEqual(["bundle exec rspec spec/widget_spec.rb"]);

    const php = fixture();
    write(php, "service/composer.json", JSON.stringify({ scripts: { test: "phpunit" } }));
    write(php, "service/src/Widget.php", "<?php class Widget {}\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: php,
        changedPaths: ["service/src/Widget.php"],
      }),
    ).toEqual(["composer --working-dir service test"]);
  });

  test("falls back to whitespace validation and removes a stale Bun default", () => {
    const root = fixture();
    write(root, "docs/guide.md", "guide\n");
    expect(
      inferRepositoryValidationSteps({ repoRoot: root, changedPaths: ["docs/guide.md"] }),
    ).toEqual(["git diff --check"]);

    write(root, "pyproject.toml", "[tool.pytest.ini_options]\n");
    write(root, "tests/test_guide.py", "def test_guide(): pass\n");
    expect(
      mergeRepositoryValidationSteps({
        repoRoot: root,
        changedPaths: ["tests/test_guide.py"],
        existingSteps: ["bun test", "git status --porcelain"],
      }),
    ).toEqual(["python -m pytest tests/test_guide.py"]);
  });

  test("prefers a nearest CMake project over an unrelated root package and quotes spaces", () => {
    const root = fixture();
    write(root, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    write(root, "native module/CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\n");
    write(root, "native module/src/widget.cpp", "int widget() { return 1; }\n");

    expect(
      inferRepositoryValidationSteps({
        repoRoot: root,
        changedPaths: ["native module/src/widget.cpp"],
      }),
    ).toEqual([
      'cmake -S "native module" -B "native module/build"',
      'cmake --build "native module/build"',
      'ctest --test-dir "native module/build" --output-on-failure',
    ]);
  });

  test("infers only declared Make test targets and Bazel-owned native packages", () => {
    const makeRoot = fixture();
    write(makeRoot, "engine core/Makefile", "test:\n\t./unit-tests\n");
    write(makeRoot, "engine core/src/widget.c", "int widget(void) { return 1; }\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: makeRoot,
        changedPaths: ["engine core/src/widget.c"],
      }),
    ).toEqual(['make -C "engine core" test']);

    const noTestRoot = fixture();
    write(noTestRoot, "Makefile", "build:\n\tcc main.c\n");
    write(noTestRoot, "main.c", "int main(void) { return 0; }\n");
    expect(
      inferRepositoryValidationSteps({ repoRoot: noTestRoot, changedPaths: ["main.c"] }),
    ).toEqual([]);

    const bazelRoot = fixture();
    write(bazelRoot, "MODULE.bazel", 'module(name = "sample")\n');
    write(bazelRoot, "src/BUILD.bazel", 'cc_test(name = "widget_test", srcs = ["widget.cpp"])\n');
    write(bazelRoot, "src/widget.cpp", "int widget() { return 1; }\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: bazelRoot,
        changedPaths: ["src/widget.cpp"],
      }),
    ).toEqual(["bazel test //src/..."]);
  });

  test("infers Buf and Swift validation from nearest manifests", () => {
    const bufRoot = fixture();
    write(bufRoot, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    write(bufRoot, "api schema/buf.yaml", "version: v2\n");
    write(bufRoot, "api schema/user.proto", 'syntax = "proto3";\n');
    expect(
      inferRepositoryValidationSteps({
        repoRoot: bufRoot,
        changedPaths: ["api schema/user.proto"],
      }),
    ).toEqual(['buf lint "api schema"']);

    const swiftRoot = fixture();
    write(swiftRoot, "mobile client/Package.swift", "// swift-tools-version: 6.0\n");
    write(swiftRoot, "mobile client/Sources/App.swift", "struct App {}\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: swiftRoot,
        changedPaths: ["mobile client/Sources/App.swift"],
      }),
    ).toEqual(['swift test --package-path "mobile client"']);
  });

  test("infers Dart, Flutter, and Elixir test runners only from project evidence", () => {
    const dartRoot = fixture();
    write(
      dartRoot,
      "pubspec.yaml",
      "name: sample\n# sdk: flutter\ndev_dependencies:\n  test: any\n",
    );
    write(dartRoot, "test/model_test.dart", "void main() {}\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: dartRoot,
        changedPaths: ["test/model_test.dart"],
      }),
    ).toEqual(["dart test test/model_test.dart"]);

    const flutterRoot = fixture();
    write(
      flutterRoot,
      "pubspec.yaml",
      "name: sample\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    write(flutterRoot, "lib/app.dart", "void main() {}\n");
    expect(
      inferRepositoryValidationSteps({ repoRoot: flutterRoot, changedPaths: ["lib/app.dart"] }),
    ).toEqual(["flutter test"]);

    const elixirRoot = fixture();
    write(elixirRoot, "mix.exs", "defmodule Sample.MixProject do\nend\n");
    write(elixirRoot, "test/widget_test.exs", "ExUnit.start()\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: elixirRoot,
        changedPaths: ["test/widget_test.exs"],
      }),
    ).toEqual(["mix test test/widget_test.exs"]);

    const nestedRoot = fixture();
    write(
      nestedRoot,
      "tools/report/pubspec.yaml",
      "name: report\ndev_dependencies:\n  test: any\n",
    );
    write(nestedRoot, "tools/report/lib/report.dart", "String report() => 'ok';\n");
    write(nestedRoot, "services/auth/mix.exs", "defmodule Auth.MixProject do\nend\n");
    write(nestedRoot, "services/auth/lib/auth.ex", "defmodule Auth do\nend\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: nestedRoot,
        changedPaths: ["tools/report/lib/report.dart", "services/auth/lib/auth.ex"],
      }),
    ).toEqual(["dart --directory tools/report test", "mix --cd services/auth test"]);
  });

  test("infers Haskell and Clojure runners from explicit test manifests", () => {
    const stackRoot = fixture();
    write(stackRoot, "compiler app/stack.yaml", "resolver: lts-22.0\n");
    write(stackRoot, "compiler app/src/Main.hs", "main = pure ()\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: stackRoot,
        changedPaths: ["compiler app/src/Main.hs"],
      }),
    ).toEqual(['stack --stack-yaml "compiler app/stack.yaml" test']);

    const cabalRoot = fixture();
    write(cabalRoot, "sample.cabal", "name: sample\ntest-suite sample-test\n");
    write(cabalRoot, "src/Main.hs", "main = pure ()\n");
    expect(
      inferRepositoryValidationSteps({ repoRoot: cabalRoot, changedPaths: ["src/Main.hs"] }),
    ).toEqual(["cabal test all"]);

    const clojureRoot = fixture();
    write(
      clojureRoot,
      "deps.edn",
      [
        "{:aliases",
        " {:test",
        '  {:extra-deps {io.github.cognitect-labs/test-runner {:git/tag "v0.5.1"}}',
        "   :exec-fn cognitect.test-runner.api/test}}}\n",
      ].join("\n"),
    );
    write(clojureRoot, "src/sample/core.clj", "(ns sample.core)\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: clojureRoot,
        changedPaths: ["src/sample/core.clj"],
      }),
    ).toEqual(["clojure -X:test"]);

    const leinRoot = fixture();
    write(leinRoot, "project.clj", '(defproject sample "0.1.0")\n');
    write(leinRoot, "src/sample/core.clj", "(ns sample.core)\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: leinRoot,
        changedPaths: ["src/sample/core.clj"],
      }),
    ).toEqual(["lein test"]);
  });

  test("infers Zig, Terraform, R, and Lua validation without a JavaScript fallback", () => {
    const zigRoot = fixture();
    write(zigRoot, "native tool/build.zig", "pub fn build(b: *std.Build) void {}\n");
    write(zigRoot, "native tool/src/main.zig", "pub fn main() void {}\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: zigRoot,
        changedPaths: ["native tool/src/main.zig"],
      }),
    ).toEqual(['zig build --build-file "native tool/build.zig" test']);

    const scriptsRoot = fixture();
    write(scriptsRoot, "infrastructure/main.tf", "terraform {}\n");
    write(scriptsRoot, "analysis reports/report.r", "answer <- 42\n");
    write(scriptsRoot, "tools/check.lua", "return true\n");
    expect(
      inferRepositoryValidationSteps({
        repoRoot: scriptsRoot,
        changedPaths: ["infrastructure/main.tf", "analysis reports/report.r", "tools/check.lua"],
      }),
    ).toEqual([
      "terraform fmt -check infrastructure/main.tf",
      `Rscript -e "parse(file='analysis reports/report.r')"`,
      "luac -p tools/check.lua",
    ]);
  });

  test("returns validation for every detected ecosystem in a mixed-language diff", () => {
    const root = fixture();
    write(root, "services/api/go.mod", "module example.test/api\n");
    write(root, "services/api/handler.go", "package api\n");
    write(root, "tools/pyproject.toml", "[tool.pytest.ini_options]\n");
    write(root, "tools/tests/test_tool.py", "def test_tool(): pass\n");

    expect(
      inferRepositoryValidationSteps({
        repoRoot: root,
        changedPaths: ["services/api/handler.go", "tools/tests/test_tool.py"],
      }),
    ).toEqual(["go -C services/api test ./...", "python -m pytest tools/tests/test_tool.py"]);
  });

  test("validates every nearest project when one ecosystem has multiple owners", () => {
    const root = fixture();
    write(root, "package.json", JSON.stringify({ packageManager: "npm@11.0.0" }));
    write(root, "packages/api/package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    write(root, "packages/api/src/api.ts", "export const api = true;\n");
    write(root, "packages/web/package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    write(root, "packages/web/src/web.ts", "export const web = true;\n");

    expect(
      inferRepositoryValidationSteps({
        repoRoot: root,
        changedPaths: ["packages/api/src/api.ts", "packages/web/src/web.ts"],
      }),
    ).toEqual(["npm --prefix packages/api run test", "npm --prefix packages/web run test"]);
  });

  test("does not truncate a multi-command project gate into setup-only success", () => {
    const root = fixture();
    write(root, "native/one/CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\n");
    write(root, "native/one/src/one.cpp", "int one() { return 1; }\n");
    write(root, "native/two/CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\n");
    write(root, "native/two/src/two.cpp", "int two() { return 2; }\n");

    expect(
      inferRepositoryValidationSteps({
        repoRoot: root,
        changedPaths: ["native/one/src/one.cpp", "native/two/src/two.cpp"],
        maxSteps: 4,
      }),
    ).toEqual([
      "cmake -S native/one -B native/one/build",
      "cmake --build native/one/build",
      "ctest --test-dir native/one/build --output-on-failure",
    ]);
  });

  test("does not substitute whitespace validation or an unrelated package test for unknown source", () => {
    const root = fixture();
    write(root, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    write(root, "src/main.zig", "pub fn main() void {}\n");
    expect(
      inferRepositoryValidationSteps({ repoRoot: root, changedPaths: ["src/main.zig"] }),
    ).toEqual([]);
    expect(
      mergeRepositoryValidationSteps({
        repoRoot: root,
        changedPaths: ["src/main.zig"],
        existingSteps: ["bun test", "git diff --check"],
      }),
    ).toEqual([]);
  });

  test("rejects oversized JSON manifests instead of reading them without a bound", () => {
    const root = fixture();
    write(
      root,
      "package.json",
      JSON.stringify({ padding: "x".repeat(1_000_100), scripts: { test: "vitest run" } }),
    );
    write(root, "src/app.ts", "export const app = true;\n");
    expect(
      inferRepositoryValidationSteps({ repoRoot: root, changedPaths: ["src/app.ts"] }),
    ).toEqual([]);
  });

  test("all inferred non-fallback ecosystem commands are trusted single-process argv", () => {
    const commands = [
      "bun test ./tests/api.test.ts",
      "python -m pytest tests/test_api.py",
      "go test ./...",
      "cargo test",
      "mvn test",
      "gradle test",
      "dotnet test App.csproj",
      "bundle exec rspec",
      "composer test",
      "php -l src/App.php",
      "ruby -c lib/app.rb",
      "cmake -S . -B build",
      "cmake --build build",
      "ctest --test-dir build --output-on-failure",
      "bazel test //src/...",
      "buf lint proto",
      "swift test --package-path packages/core",
      "dart test test/app_test.dart",
      "dart --directory tools/report test",
      "flutter test",
      "mix test test/app_test.exs",
      "mix --cd services/auth test",
      "cabal test all",
      "stack --stack-yaml packages/core/stack.yaml test",
      "clojure -X:test",
      "lein test",
      'zig build --build-file "native tool/build.zig" test',
      "terraform fmt -check infrastructure/main.tf",
      `Rscript -e "parse(file='analysis reports/report.r')"`,
      "luac -p tools/check.lua",
      "git diff --check",
    ];
    for (let offset = 0; offset < commands.length; offset += 8) {
      expect(normalizeTrustedValidationCommands(commands.slice(offset, offset + 8)).ok).toBe(true);
    }
    expect(commands.some((command) => /(?:&&|\|\||[;|`])/.test(command))).toBe(false);
    for (const escapeCommand of [
      "ruby -e system('cmd')",
      "ruby -c ../outside.rb",
      "php -r system('cmd')",
      "php -l C:/outside.php",
      "bundle exec sh",
      "bundle exec rspec ../outside_spec.rb",
      "composer exec powershell",
      "composer --working-dir ../outside test",
      "dotnet run",
      "dotnet test ../outside.csproj",
      "mvn exec:exec",
      "mvn -f ../outside/pom.xml test",
      "gradle run",
      "cmake -P scripts/run.cmake",
      "ctest --test-dir ../outside --output-on-failure",
      "make install",
      "bazel run //tools:shell",
      "buf breaking --against https://example.test/repo.git",
      "swift run arbitrary-tool",
      "swift test --package-path .git/hooks",
      "dart run tool/codegen.dart",
      "dart --directory ../outside test",
      "flutter pub get",
      "mix run scripts/task.exs",
      "mix --cd ../outside test",
      "cabal exec sh",
      "stack exec sh",
      "clojure -M -m arbitrary.main",
      "lein run",
      "zig build run",
      "terraform apply -auto-approve",
      `Rscript -e "source('scripts/deploy.r')"`,
      "luac -p ../outside.lua",
      "git clean -fdx",
    ]) {
      expect(normalizeTrustedValidationCommands([escapeCommand]).ok).toBe(false);
    }
  });

  test("projects direct polyglot tools before worker execution", () => {
    const root = fixture();
    const cases = [
      ["bundle exec rspec", "bundle"],
      ["composer test", "composer"],
      ["dotnet test App.csproj", "dotnet"],
      ["gradle test", "gradle"],
      ["mvn test", "mvn"],
      ["php -l src/App.php", "php"],
      ["ruby -c lib/app.rb", "ruby"],
      ["cmake -S . -B build", "cmake"],
      ["ctest --test-dir build --output-on-failure", "ctest"],
      ["bazel test //src/...", "bazel"],
      ["buf lint", "buf"],
      ["swift test", "swift"],
      ["dart test", "dart"],
      ["flutter test", "flutter"],
      ["mix test", "mix"],
      ["cabal test all", "cabal"],
      ["stack test", "stack"],
      ["clojure -X:test", "clojure"],
      ["lein test", "lein"],
      ["zig build test", "zig"],
      ["terraform fmt -check infrastructure/main.tf", "terraform"],
      [`Rscript -e "parse(file='analysis/report.r')"`, "rscript"],
      ["luac -p tools/check.lua", "luac"],
      ["git diff --check", "git"],
    ] as const;
    for (const [command, expectedTool] of cases) {
      const requirements = inferToolRequirementsForValidationCommand(root, command);
      expect(requirements.some((requirement) => requirement.tool === expectedTool)).toBe(true);
    }
  });
});
