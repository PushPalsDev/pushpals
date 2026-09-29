import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  resolveTrustedDependencyArtifactCache,
  withTrustedDependencyArtifacts,
} from "../apps/source_control_manager/src/dependency_artifact_cache";
import {
  runProcessWithTreeTimeout,
  runTrustedValidationCommands,
} from "../apps/source_control_manager/src/trusted_validation";

describe("trusted native dependency artifacts", () => {
  test("keeps artifacts in the existing cache-clear boundary and scopes native toolchains", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-artifact-scope-"));
    try {
      mkdirSync(join(root, ".git"));
      const options = {
        repoRoot: root,
        env: { PUSHPALS_TRUSTED_ISOLATED_ARTIFACT_CACHE: "1" },
        globalConfigPaths: [],
        globalNpmrcPaths: [],
        platform: "win32",
        arch: "x64",
        bunVersion: "1.3.14",
        bunExecutable: "bun.exe",
      };
      const first = resolveTrustedDependencyArtifactCache(options)!;
      expect(
        first.startsWith(join(root, ".git", "pushpals", "dependencies", "trusted-packages")),
      ).toBe(true);
      expect(resolveTrustedDependencyArtifactCache(options)).toBe(first);
      expect(resolveTrustedDependencyArtifactCache({ ...options, env: {} })).toBeNull();
      expect(
        resolveTrustedDependencyArtifactCache({
          ...options,
          env: { PUSHPALS_TRUSTED_ISOLATED_ARTIFACT_CACHE: "0" },
        }),
      ).toBeNull();
      for (const change of [
        { platform: "linux" },
        { arch: "arm64" },
        { bunVersion: "1.3.15" },
        { bunExecutable: "other/bun.exe" },
      ]) {
        expect(resolveTrustedDependencyArtifactCache({ ...options, ...change })).not.toBe(first);
      }
      expect(
        resolveTrustedDependencyArtifactCache({
          ...options,
          env: { ...options.env, BUN_INSTALL_CACHE_DIR: "operator-selected" },
        }),
      ).toBeNull();
      expect(
        resolveTrustedDependencyArtifactCache({ ...options, repoRoot: join(root, "missing") }),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves project/global cache configuration and the actual selected executable", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-artifact-config-"));
    try {
      mkdirSync(join(root, ".git"));
      const options = {
        repoRoot: root,
        env: { PUSHPALS_TRUSTED_ISOLATED_ARTIFACT_CACHE: "1" },
        globalConfigPaths: [],
        globalNpmrcPaths: [],
      };
      const defaultCache = resolveTrustedDependencyArtifactCache(options);
      expect(
        resolveTrustedDependencyArtifactCache({
          ...options,
          env: { ...options.env, PUSHPALS_BUN_BIN: "alternate-bun" },
        }),
      ).not.toBe(defaultCache);
      const configPath = join(root, "bunfig.toml");
      for (const config of [
        '[install.cache]\ndir="offline-artifacts"',
        "[install.cache]\ndisable=true",
        '[install]\nbackend="hardlink"',
        "invalid = [",
      ]) {
        writeFileSync(configPath, config);
        expect(resolveTrustedDependencyArtifactCache(options)).toBeNull();
      }
      writeFileSync(configPath, "[test]\ncoverage=true");
      expect(resolveTrustedDependencyArtifactCache(options)).toBe(defaultCache);
      const globalConfig = join(root, "global.toml");
      writeFileSync(globalConfig, '[install.cache]\ndir="global-offline-artifacts"');
      expect(
        resolveTrustedDependencyArtifactCache({ ...options, globalConfigPaths: [globalConfig] }),
      ).toBeNull();
      const candidate = join(root, "candidate");
      mkdirSync(candidate);
      writeFileSync(join(candidate, "bunfig.toml"), '[install.cache]\ndir="candidate-specific"');
      expect(
        resolveTrustedDependencyArtifactCache({ ...options, configRoot: candidate }),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves npmrc cache ownership at the candidate/user boundary and explicit npm overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-npmrc-config-"));
    try {
      mkdirSync(join(root, ".git"));
      const options = {
        repoRoot: root,
        env: { PUSHPALS_TRUSTED_ISOLATED_ARTIFACT_CACHE: "1" },
        globalConfigPaths: [],
        globalNpmrcPaths: [],
      };
      const path = join(root, ".npmrc");
      const defaultCache = resolveTrustedDependencyArtifactCache(options);
      expect(defaultCache).not.toBeNull();
      for (const config of [
        "cache=/operator/warm-cache",
        "cache=false",
        '  cache = "${CUSTOM_CACHE}"',
        '\uFEFF"cache" = "warm cache"',
        "cache[]=warm-cache",
        "[install]\ncache=warm-cache",
        "ca\\che=warm-cache",
      ]) {
        writeFileSync(path, config);
        expect(resolveTrustedDependencyArtifactCache(options)).toBeNull();
      }
      writeFileSync(
        path,
        "# cache=ignored\n; cache=false\nregistry=https://example.invalid/\n//example.invalid/:_authToken=${OPERATOR_TOKEN}\nalways-auth=true\n",
      );
      expect(resolveTrustedDependencyArtifactCache(options)).toBe(defaultCache);
      const userConfig = join(root, "user.npmrc");
      writeFileSync(userConfig, "cache=warm-cache");
      expect(
        resolveTrustedDependencyArtifactCache({ ...options, globalNpmrcPaths: [userConfig] }),
      ).toBeNull();
      const xdgConfig = join(root, "xdg-config");
      mkdirSync(xdgConfig);
      writeFileSync(join(xdgConfig, ".npmrc"), "cache=xdg-offline-cache");
      expect(
        resolveTrustedDependencyArtifactCache({
          ...options,
          env: { ...options.env, XDG_CONFIG_HOME: xdgConfig },
        }),
      ).toBeNull();
      const candidate = join(root, "candidate");
      mkdirSync(candidate);
      writeFileSync(join(candidate, ".npmrc"), "cache=false");
      expect(
        resolveTrustedDependencyArtifactCache({ ...options, configRoot: candidate }),
      ).toBeNull();
      for (const key of [
        "npm_config_cache",
        "NPM_CONFIG_CACHE",
        "NPM_CONFIG_USERCONFIG",
        "npm_config_globalconfig",
      ]) {
        expect(
          resolveTrustedDependencyArtifactCache({
            ...options,
            env: { ...options.env, [key]: "operator-owned" },
          }),
        ).toBeNull();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("declines unsafe or oversized install configuration without reading it", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-unsafe-install-config-"));
    try {
      mkdirSync(join(root, ".git"));
      const options = {
        repoRoot: root,
        env: { PUSHPALS_TRUSTED_ISOLATED_ARTIFACT_CACHE: "1" },
        globalConfigPaths: [],
        globalNpmrcPaths: [],
      };
      for (const name of [".npmrc", "bunfig.toml"]) {
        const path = join(root, name);
        writeFileSync(path, "x".repeat(128 * 1024 + 1));
        expect(resolveTrustedDependencyArtifactCache(options)).toBeNull();
        rmSync(path);
        mkdirSync(path);
        expect(resolveTrustedDependencyArtifactCache(options)).toBeNull();
        rmSync(path, { recursive: true });
        if (process.platform !== "win32") {
          symlinkSync(join(root, "missing-config"), path);
          expect(resolveTrustedDependencyArtifactCache(options)).toBeNull();
          rmSync(path);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "does not block on a FIFO configuration file",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-fifo-install-config-"));
      try {
        mkdirSync(join(root, ".git"));
        const path = join(root, ".npmrc");
        expect(
          (await runProcessWithTreeTimeout(["mkfifo", path], { cwd: root, timeoutMs: 2000 })).ok,
        ).toBe(true);
        const options = {
          repoRoot: root,
          env: { PUSHPALS_TRUSTED_ISOLATED_ARTIFACT_CACHE: "1" },
          globalConfigPaths: [],
          globalNpmrcPaths: [],
        };
        const source = resolve(
          import.meta.dir,
          "../apps/source_control_manager/src/dependency_artifact_cache.ts",
        );
        const result = await runProcessWithTreeTimeout(
          [
            process.execPath,
            "-e",
            `import {resolveTrustedDependencyArtifactCache as cache} from ${JSON.stringify(source)}; console.log(JSON.stringify(cache(${JSON.stringify(options)})));`,
          ],
          { cwd: root, timeoutMs: 2000 },
        );
        expect(result.ok).toBe(true);
        expect(result.output.trim()).toBe("null");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("reuse never suppresses hooks, frozen-lock verification, or changes caller argv", () => {
    const argv = ["bun", "install", "--frozen-lockfile"];
    expect(withTrustedDependencyArtifacts(argv)).toEqual(argv);
    const cached = withTrustedDependencyArtifacts(argv, "artifact cache");
    expect(cached.slice(0, 3)).toEqual(argv);
    expect(cached.slice(-2)).toEqual(["--backend", "copyfile"]);
    expect(cached).not.toContain("--ignore-scripts");
    expect(cached).not.toContain("--dry-run");
    expect(argv).toHaveLength(3);
  });

  test("each new candidate runs install hooks and ordered gates, not just a dependency-cache hit", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-artifact-candidates-"));
    try {
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "bun.lock"), "locked fixture");
      const calls: string[][] = [];
      const options = {
        repoPath: root,
        commandsJson: JSON.stringify(["bun run first", "bun run second"]),
        artifactCacheDir: join(root, "artifacts"),
        runner: async (argv: string[]) => {
          calls.push(argv);
          mkdirSync(join(root, "node_modules"), { recursive: true });
          return { ok: true, output: "", exitCode: 0 };
        },
      };
      for (const candidateSha of ["b".repeat(40), "c".repeat(40)]) {
        await runTrustedValidationCommands({
          ...options,
          invariantContext: {
            baseSha: "a".repeat(40),
            candidateSha,
            affectedPaths: ["src/app.ts"],
          },
        });
      }
      expect(calls.map((argv) => argv[1])).toEqual([
        "install",
        "run",
        "run",
        "install",
        "run",
        "run",
      ]);
      expect(
        calls
          .filter((argv) => argv[1] === "install")
          .every((argv) => argv.includes("--cache-dir") && !argv.includes("--ignore-scripts")),
      ).toBe(true);
      expect(
        calls.filter((argv) => argv[1] === "run").every((argv) => !argv.includes("--cache-dir")),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opt-in preserves npmrc warm artifacts for offline candidate installs and hooks", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-npmrc-native-"));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const packageRoot = join(root, "tar-source", "package");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "npmrc-artifact-fixture", version: "1.0.0" }),
      );
      const archive = join(root, "fixture.tgz");
      expect(
        (
          await runProcessWithTreeTimeout(
            ["tar", "-czf", archive, "-C", join(root, "tar-source"), "package"],
            { cwd: root, timeoutMs: 10_000 },
          )
        ).ok,
      ).toBe(true);
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(Bun.file(archive)),
      });
      const cache = join(root, "operator-warm-cache");
      const candidates = [join(root, "first"), join(root, "second")];
      for (const [index, dir] of candidates.entries()) {
        mkdirSync(join(dir, ".git"), { recursive: true });
        writeFileSync(join(dir, ".npmrc"), `cache=${cache.replace(/\\/g, "/")}\n`);
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            name: "npmrc-consumer",
            dependencies: {
              "npmrc-artifact-fixture": `http://127.0.0.1:${server.port}/fixture.tgz`,
            },
            scripts: { postinstall: "bun hook.js", validate: "bun check.js" },
          }),
        );
        writeFileSync(join(dir, "candidate.txt"), `candidate-${index}`);
        writeFileSync(
          join(dir, "hook.js"),
          "const fs=require('fs'); fs.writeFileSync('hook-proof.txt',fs.readFileSync('candidate.txt')); ",
        );
        writeFileSync(
          join(dir, "check.js"),
          "const fs=require('fs'); if(fs.readFileSync('hook-proof.txt','utf8')!==fs.readFileSync('candidate.txt','utf8')) process.exit(1);",
        );
      }
      const seed = await runProcessWithTreeTimeout(
        [process.execPath, "install", "--ignore-scripts"],
        { cwd: candidates[0]!, timeoutMs: 20_000 },
      );
      expect(seed.ok).toBe(true);
      copyFileSync(join(candidates[0]!, "bun.lock"), join(candidates[1]!, "bun.lock"));
      await server.stop(true);
      for (const [index, repoPath] of candidates.entries()) {
        const artifactCacheDir = resolveTrustedDependencyArtifactCache({
          repoRoot: repoPath,
          env: { PUSHPALS_TRUSTED_ISOLATED_ARTIFACT_CACHE: "1" },
          globalConfigPaths: [],
          globalNpmrcPaths: [],
        });
        expect(artifactCacheDir).toBeNull();
        const results = await runTrustedValidationCommands({
          repoPath,
          artifactCacheDir,
          commandsJson: JSON.stringify(["bun run validate"]),
          bunExecutable: process.execPath,
          timeoutMs: 20_000,
        });
        expect(results.map(({ phase, ok }) => ({ phase, ok }))).toEqual([
          { phase: "dependency_install", ok: true },
          { phase: "validation", ok: true },
        ]);
        expect(readFileSync(join(repoPath, "hook-proof.txt"), "utf8")).toBe(`candidate-${index}`);
      }
    } finally {
      await server?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("real Bun reuses package artifacts across fresh candidates without reusing hook outputs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-artifact-native-"));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const packageRoot = join(root, "tar-source", "package");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "artifact-fixture", version: "1.0.0" }),
      );
      writeFileSync(join(packageRoot, "value.txt"), "pristine");
      const archive = join(root, "fixture.tgz");
      const tar = await runProcessWithTreeTimeout(
        ["tar", "-czf", archive, "-C", join(root, "tar-source"), "package"],
        { cwd: root, timeoutMs: 10_000 },
      );
      expect(tar.ok).toBe(true);
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(Bun.file(archive)),
      });
      const cacheDir = join(root, "native-cache");
      const manifest = JSON.stringify({
        name: "native-cache-consumer",
        version: "1.0.0",
        dependencies: { "artifact-fixture": `http://127.0.0.1:${server.port}/fixture.tgz` },
        scripts: { postinstall: "bun hook.js", validate: "bun check.js" },
      });
      const first = join(root, "first");
      const second = join(root, "second");
      for (const dir of [first, second]) {
        mkdirSync(dir);
        writeFileSync(join(dir, "package.json"), manifest);
        writeFileSync(
          join(dir, "hook.js"),
          `const fs=require('fs'); const candidate=fs.readFileSync('candidate.txt','utf8'); const before=fs.readFileSync('node_modules/artifact-fixture/value.txt','utf8'); fs.writeFileSync('hook-proof.json',JSON.stringify({candidate,before})); fs.writeFileSync('node_modules/artifact-fixture/value.txt',candidate);`,
        );
        writeFileSync(
          join(dir, "check.js"),
          `const fs=require('fs'); const proof=JSON.parse(fs.readFileSync('hook-proof.json','utf8')); if(proof.before!=='pristine'||proof.candidate!==fs.readFileSync('candidate.txt','utf8')) process.exit(1);`,
        );
      }
      writeFileSync(join(first, "candidate.txt"), "candidate-a");
      writeFileSync(join(second, "candidate.txt"), "candidate-b");
      // Seed native package artifacts without executing hooks; the real trusted
      // runs below must still execute them independently for both candidates.
      const seed = await runProcessWithTreeTimeout(
        withTrustedDependencyArtifacts([process.execPath, "install", "--ignore-scripts"], cacheDir),
        { cwd: first, timeoutMs: 20_000 },
      );
      expect(seed.ok).toBe(true);
      copyFileSync(join(first, "bun.lock"), join(second, "bun.lock"));
      for (const [index, repoPath] of [first, second].entries()) {
        const results = await runTrustedValidationCommands({
          repoPath,
          artifactCacheDir: cacheDir,
          commandsJson: JSON.stringify(["bun run validate"]),
          bunExecutable: process.execPath,
          timeoutMs: 20_000,
          invariantContext: {
            baseSha: "a".repeat(40),
            candidateSha: (index === 0 ? "b" : "c").repeat(40),
            affectedPaths: ["candidate.txt"],
          },
        });
        expect(
          results.map((result) => ({
            phase: result.phase,
            ok: result.ok,
            output: result.ok ? "" : result.output,
          })),
        ).toEqual([
          { phase: "dependency_install", ok: true, output: "" },
          { phase: "validation", ok: true, output: "" },
        ]);
        expect(JSON.parse(readFileSync(join(repoPath, "hook-proof.json"), "utf8"))).toEqual({
          candidate: index === 0 ? "candidate-a" : "candidate-b",
          before: "pristine",
        });
        // Subsequent installation must use existing artifacts without a live
        // registry, while still running candidate-specific root hooks.
        if (index === 0) await server.stop(true);
      }
    } finally {
      await server?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
