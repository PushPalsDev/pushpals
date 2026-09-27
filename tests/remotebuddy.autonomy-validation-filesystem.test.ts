import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { inferRepoValidationIdeas } from "../apps/remotebuddy/src/autonomous_engine";
import {
  createValidationSnapshotFileSystem,
  ValidationSnapshotUnavailableError,
  validationManifestReadLimit,
  type ValidationSnapshotFile,
} from "../apps/remotebuddy/src/autonomy_validation_filesystem";

const snapshotRoot = resolve(tmpdir(), "pushpals-immutable-validation-snapshot");

function infer(
  targets: string[],
  entries: ValidationSnapshotFile[] = [],
  platform: "windows" | "linux_docker" = "linux_docker",
): string[] {
  return inferRepoValidationIdeas(
    snapshotRoot,
    targets,
    platform,
    false,
    createValidationSnapshotFileSystem(snapshotRoot, entries),
  );
}

describe("immutable validation snapshot inference", () => {
  const cases: Array<{
    name: string;
    target: string;
    entries: ValidationSnapshotFile[];
    expected: string[];
  }> = [
    {
      name: "JavaScript syntax fallback",
      target: "src/app.js",
      entries: [],
      expected: ["node --check src/app.js"],
    },
    {
      name: "documentation fallback",
      target: "docs/design.md",
      entries: [],
      expected: ["git diff --check"],
    },
    {
      name: "unsupported source without manifests",
      target: "src/app.wat",
      entries: [],
      expected: [],
    },
    {
      name: "TypeScript without an owned toolchain",
      target: "src/app.ts",
      entries: [],
      expected: [],
    },
    {
      name: "package manager lockfile",
      target: "src/app.ts",
      entries: [
        { path: "package.json", text: '{"scripts":{"test":"vitest run"}}' },
        { path: "pnpm-lock.yaml" },
      ],
      expected: ["pnpm run test"],
    },
    {
      name: "nested package inherits ancestor manager",
      target: "packages/widget/src/app.ts",
      entries: [
        { path: "packages/widget/package.json", text: '{"scripts":{"check":"tsc --noEmit"}}' },
        { path: "package.json", text: '{"packageManager":"yarn@4.0.0"}' },
      ],
      expected: ["yarn --cwd packages/widget run check"],
    },
    {
      name: "Python pytest evidence",
      target: "src/app.py",
      entries: [
        { path: "pyproject.toml", text: '[project.optional-dependencies]\ntest = ["pytest"]' },
      ],
      expected: ["python -m pytest"],
    },
    {
      name: "Python syntax fallback",
      target: "src/app.py",
      entries: [],
      expected: ["python -m compileall src/app.py"],
    },
    {
      name: "Rust metadata-only manifest",
      target: "src/lib.rs",
      entries: [{ path: "Cargo.toml" }],
      expected: ["cargo test"],
    },
    {
      name: "Go metadata-only manifest",
      target: "src/app.go",
      entries: [{ path: "go.mod" }],
      expected: ["go test ./..."],
    },
    {
      name: ".NET immediate directory listing",
      target: "src/app.cs",
      entries: [{ path: "Widget.csproj" }],
      expected: ["dotnet test Widget.csproj"],
    },
    {
      name: "Ruby task content",
      target: "lib/app.rb",
      entries: [{ path: "Gemfile" }, { path: "Rakefile", text: "task :test do\nend" }],
      expected: ["bundle exec rake test"],
    },
    {
      name: "Ruby derived spec directory",
      target: "lib/app.rb",
      entries: [{ path: "Gemfile" }, { path: "spec/app_spec.rb" }],
      expected: ["bundle exec rspec"],
    },
    {
      name: "PHP composer script",
      target: "src/app.php",
      entries: [{ path: "composer.json", text: '{"scripts":{"test":"phpunit"}}' }],
      expected: ["composer test"],
    },
    {
      name: "Flutter SDK evidence",
      target: "lib/app.dart",
      entries: [{ path: "pubspec.yaml", text: "dependencies:\n  flutter:\n    sdk: flutter" }],
      expected: ["flutter test"],
    },
    {
      name: "Clojure test alias",
      target: "src/app.clj",
      entries: [{ path: "deps.edn", text: "{:aliases {:test {:exec-fn tests/run}}}" }],
      expected: ["clojure -X:test"],
    },
    {
      name: "Make owned validation",
      target: "src/app.c",
      entries: [{ path: "Makefile", text: "test:\n\t./run-tests" }],
      expected: ["make test"],
    },
    {
      name: "protobuf metadata-only manifest",
      target: "proto/app.proto",
      entries: [{ path: "buf.yaml" }],
      expected: ["buf lint"],
    },
    {
      name: "CMake metadata-only manifest",
      target: "src/app.cc",
      entries: [{ path: "CMakeLists.txt" }],
      expected: [
        "cmake -S . -B build",
        "cmake --build build",
        "ctest --test-dir build --output-on-failure",
      ],
    },
    {
      name: "Bazel tracked package metadata",
      target: "src/app.cc",
      entries: [{ path: "MODULE.bazel" }, { path: "src/BUILD.bazel" }],
      expected: ["bazel test //src/..."],
    },
  ];
  for (const fixture of cases) {
    test(fixture.name, () => {
      expect(infer([fixture.target], fixture.entries)).toEqual(fixture.expected);
    });
  }

  test("worker execution platform selects the snapshot's matching JVM wrapper", () => {
    const entries = [{ path: "pom.xml" }, { path: "mvnw" }, { path: "mvnw.cmd" }];
    expect(infer(["src/App.java"], entries, "windows")).toEqual(["cmd /c ./mvnw.cmd test"]);
    expect(infer(["src/App.java"], entries, "linux_docker")).toEqual(["./mvnw test"]);
  });

  test("directory targets are recognized solely from tracked descendants", () => {
    expect(
      infer(
        ["packages/widget"],
        [
          { path: "packages/widget/package.json", text: '{"scripts":{"test":"vitest"}}' },
          { path: "packages/widget/bun.lock" },
        ],
      ),
    ).toEqual(["bun --cwd packages/widget run test"]);
  });

  test("only snapshot ownership markers enable PushPals-specific script preference", () => {
    const manifest = {
      path: "package.json",
      text: '{"scripts":{"test":"vitest","test:root":"bun test tests"}}',
    };
    expect(infer(["src/app.ts"], [manifest])).toEqual(["npm run test"]);
    expect(
      infer(
        ["src/app.ts"],
        [
          manifest,
          { path: "apps/remotebuddy/src/autonomous_engine.ts" },
          { path: "apps/workerpals/src/workerpals_main.ts" },
          { path: "packages/shared/src/autonomy_policy.ts" },
        ],
      ),
    ).toEqual(["npm run test:root"]);
  });

  for (const fixture of [
    { target: "app.ts", manifest: "package.json" },
    { target: "app.py", manifest: "pyproject.toml" },
    { target: "app.rb", manifest: "Rakefile" },
    { target: "app.php", manifest: "composer.json" },
    { target: "app.dart", manifest: "pubspec.yaml" },
    { target: "app.clj", manifest: "deps.edn" },
    { target: "app.c", manifest: "Makefile" },
  ]) {
    for (const state of ["missing", "truncated"] as const) {
      test(`${fixture.manifest} ${state} content defers instead of inferring false absence`, () => {
        const entry: ValidationSnapshotFile =
          state === "missing"
            ? { path: fixture.manifest }
            : { path: fixture.manifest, text: "partial", truncated: true };
        expect(() => infer([fixture.target], [entry])).toThrow(ValidationSnapshotUnavailableError);
      });
    }
  }

  test("missing ancestor package content cannot silently change the selected manager", () => {
    expect(() =>
      infer(
        ["packages/widget/app.ts"],
        [
          { path: "packages/widget/package.json", text: '{"scripts":{"test":"vitest"}}' },
          { path: "package.json" },
        ],
      ),
    ).toThrow(ValidationSnapshotUnavailableError);
  });

  test("default checkout inference stays compatible while snapshot inference ignores host files", () => {
    const root = mkdtempSync(resolve(tmpdir(), "pushpals-validation-adapter-"));
    try {
      const manifest = '{"packageManager":"pnpm@9.0.0","scripts":{"test":"vitest run"}}';
      writeFileSync(resolve(root, "package.json"), manifest);
      const snapshot = createValidationSnapshotFileSystem(root, [
        { path: "package.json", text: manifest },
      ]);
      expect(inferRepoValidationIdeas(root, ["app.ts"])).toEqual(["pnpm run test"]);
      expect(inferRepoValidationIdeas(root, ["app.ts"], "linux_docker", false, snapshot)).toEqual(
        inferRepoValidationIdeas(root, ["app.ts"]),
      );
      const withoutHostManifest = createValidationSnapshotFileSystem(root, []);
      expect(
        inferRepoValidationIdeas(root, ["app.ts"], "linux_docker", false, withoutHostManifest),
      ).toEqual([]);
      writeFileSync(
        resolve(root, "package.json"),
        '{"scripts":{"test":"changed"},"packageManager":"bun@1.0.0"}',
      );
      expect(inferRepoValidationIdeas(root, ["app.ts"], "linux_docker", false, snapshot)).toEqual([
        "pnpm run test",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("validation snapshot view boundary", () => {
  test("only exact supplied files and their parent directories are visible", () => {
    const snapshot = createValidationSnapshotFileSystem(snapshotRoot, [
      { path: "src/nested/app.cs" },
    ]);
    expect(snapshot.isDirectory(resolve(snapshotRoot, "src/nested"))).toBe(true);
    expect(snapshot.isDirectory(resolve(snapshotRoot, "src/nested/app.cs"))).toBe(false);
    expect(snapshot.fileNames(resolve(snapshotRoot, "src"))).toEqual([]);
    expect(snapshot.fileNames(resolve(snapshotRoot, "src/nested"))).toEqual(["app.cs"]);
    expect(snapshot.exists(resolve(snapshotRoot, "untracked.json"))).toBe(false);
    expect(snapshot.exists(resolve(snapshotRoot, "../package.json"))).toBe(false);
    expect(snapshot.exists("src/nested/app.cs")).toBe(false);
    expect(() => snapshot.readText(resolve(snapshotRoot, "../package.json"), 100)).toThrow(
      "absent",
    );
  });

  test("caller mutation cannot alter the view or its directory listing", () => {
    const entries = [{ path: "package.json", text: "first" }];
    const snapshot = createValidationSnapshotFileSystem(snapshotRoot, entries);
    entries[0]!.text = "second";
    entries.push({ path: "extra.json", text: "extra" });
    snapshot.fileNames(snapshotRoot).push("injected.json");
    expect(snapshot.fileNames(snapshotRoot)).toEqual(["package.json"]);
    expect(snapshot.readText(resolve(snapshotRoot, "package.json"), 10)).toEqual({
      text: "first",
      truncated: false,
    });
  });

  test("read bounds are byte-based and overflow remains a typed deferral", () => {
    const snapshot = createValidationSnapshotFileSystem(snapshotRoot, [
      { path: "package.json", text: "éé" },
    ]);
    expect(snapshot.readText(resolve(snapshotRoot, "package.json"), 4).text).toBe("éé");
    expect(() => snapshot.readText(resolve(snapshotRoot, "package.json"), 3)).toThrow(
      ValidationSnapshotUnavailableError,
    );
    expect(() =>
      snapshot.readText(resolve(snapshotRoot, "package.json"), Number.POSITIVE_INFINITY),
    ).toThrow(TypeError);
  });

  for (const path of [
    "",
    "../secret",
    "src/../secret",
    "/outside",
    "C:/outside",
    "src//app",
    "src/./app",
    "src/app\nsecret",
  ]) {
    test(`rejects noncanonical metadata path ${JSON.stringify(path)}`, () => {
      expect(() => createValidationSnapshotFileSystem(snapshotRoot, [{ path }])).toThrow(TypeError);
    });
  }

  test("duplicate metadata is not silently overwritten", () => {
    expect(() =>
      createValidationSnapshotFileSystem(snapshotRoot, [
        { path: "package.json", text: "first" },
        { path: "package.json", text: "second" },
      ]),
    ).toThrow(TypeError);
  });

  test("loader limits cover every content-bearing inference manifest", () => {
    for (const path of ["package.json", "composer.json"])
      expect(validationManifestReadLimit(`nested/${path}`)).toBe(512 * 1024);
    expect(validationManifestReadLimit("Makefile")).toBe(300_000);
    for (const path of [
      "pyproject.toml",
      "setup.cfg",
      "setup.py",
      "pytest.ini",
      "tox.ini",
      "requirements.txt",
      "requirements-dev.txt",
      "dev-requirements.txt",
      "Rakefile",
      "pubspec.yaml",
      "deps.edn",
    ]) {
      expect(validationManifestReadLimit(path)).toBe(200_000);
    }
    for (const path of [
      "Cargo.toml",
      "go.mod",
      "Widget.csproj",
      "Gemfile",
      "mvnw",
      "MODULE.bazel",
      "buf.yaml",
      "src/app.ts",
    ]) {
      expect(validationManifestReadLimit(path)).toBeNull();
    }
  });
});
