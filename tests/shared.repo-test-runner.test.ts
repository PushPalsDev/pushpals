import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { inferRepositoryValidationSteps, routeRepositoryFocusedTestCommand } from "shared";
import { collectQualityGateValidationCommands } from "../apps/workerpals/src/execute_job";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pushpals-test-runner-routing-"));
  roots.push(root);
  return root;
}
function write(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}
function manifest(root: string, scripts: Record<string, string>, extra = {}): void {
  write(root, "package.json", JSON.stringify({ packageManager: "bun@1.3.14", scripts, ...extra }));
}
function mixedFixture(): string {
  const root = fixture();
  manifest(root, {
    test: "bun test --isolate",
    "test:billing": "vitest run --config vitest.billing.config.mts",
    "test:search": "vitest run --config vitest.search.config.mts",
    validate: "bun run test:billing && bun run test:search",
  });
  write(root, "services/billing/charges.vitest.ts", 'import { test } from "vitest";');
  write(root, "services/search/index.vitest.ts", 'import { test } from "vitest";');
  write(root, "tests/render.test.ts", 'import { test } from "bun:test";');
  write(
    root,
    "vitest.billing.config.mts",
    "export default { test: { include: ['services/billing/**/*.vitest.ts'] } };",
  );
  write(
    root,
    "vitest.search.config.mts",
    "export default { test: { include: ['services/search/**/*.vitest.ts'] } };",
  );
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("evidence-backed repository test runner routing", () => {
  test("selects the matching custom-config suite in a mixed Bun/Vitest repository", () => {
    const root = mixedFixture();
    expect(
      routeRepositoryFocusedTestCommand(root, "bun test ./services/billing/charges.vitest.ts"),
    ).toEqual(["bun run test:billing"]);
    expect(
      inferRepositoryValidationSteps({
        repoRoot: root,
        changedPaths: ["services/billing/charges.vitest.ts"],
      }),
    ).toEqual(["bun run test:billing"]);
  });

  test("splits mixed runners without losing Bun-owned tests or duplicating suites", () => {
    const root = mixedFixture();
    write(root, "services/billing/refund.vitest.ts", 'import { test } from "vitest";');
    expect(
      routeRepositoryFocusedTestCommand(
        root,
        "bun test ./services/billing/charges.vitest.ts ./services/billing/refund.vitest.ts ./tests/render.test.ts ./services/search/index.vitest.ts",
      ),
    ).toEqual(["bun run test:billing", "bun run test:search", "bun test ./tests/render.test.ts"]);
  });

  test.each([
    '-t "rejects a malformed request"',
    '--test-name-pattern "rejects a malformed request"',
    '--test-name-pattern="rejects a malformed request"',
    '--timeout 30000 -t "rejects a malformed request"',
  ])("runs the complete owning suite for a synthesized Bun filter (%s)", (flags) => {
    const root = mixedFixture();
    expect(
      routeRepositoryFocusedTestCommand(
        root,
        `bun test ./services/billing/charges.vitest.ts ${flags}`,
      ),
    ).toEqual(["bun run test:billing"]);
    const result = collectQualityGateValidationCommands({
      repo: root,
      instruction: "add regression coverage",
      changedTestPaths: [],
      isTestTask: false,
      planning: {
        validationSteps: [`bun test ./services/billing/charges.vitest.ts ${flags}`],
        requiredValidationSteps: ["bun run required:publish"],
      } as any,
    });
    expect(result.commandsToRun).toContain("bun run test:billing");
    expect(result.commandsToRun).toContain("bun run required:publish");
    expect(result.commandsToRun.some((command) => command.startsWith("bun test"))).toBe(false);
  });

  test("preserves the original name filter and timeout for unmatched Bun files", () => {
    const root = mixedFixture();
    expect(
      routeRepositoryFocusedTestCommand(
        root,
        'bun test ./services/billing/charges.vitest.ts ./tests/render.test.ts -t "renders safely" --timeout 10000',
      ),
    ).toEqual([
      "bun run test:billing",
      'bun test ./tests/render.test.ts -t "renders safely" --timeout 10000',
    ]);
  });

  test("rejects a prefiltered script even when its broad config includes the requested test", () => {
    const root = mixedFixture();
    manifest(root, {
      "test:other":
        "vitest run ./services/billing/other.vitest.ts --config vitest.billing.config.mts",
    });
    expect(
      routeRepositoryFocusedTestCommand(root, "bun test ./services/billing/charges.vitest.ts"),
    ).toEqual(["bun test ./services/billing/charges.vitest.ts"]);
  });

  test.each(["bun", "npm", "pnpm", "yarn"])(
    "honors the nearest manifest and inherited %s manager",
    (manager) => {
      const root = fixture();
      manifest(root, {}, { packageManager: `${manager}@1.0.0` });
      write(
        root,
        "packages/worker/package.json",
        JSON.stringify({ scripts: { "test:api": "vitest run --config test.config.ts" } }),
      );
      write(
        root,
        "packages/worker/test.config.ts",
        "export default { test: { include: ['tests/**/*.test.ts'] } };",
      );
      write(root, "packages/worker/tests/api.test.ts", 'import { test } from "vitest";');
      const flag = manager === "npm" ? "--prefix" : manager === "pnpm" ? "--dir" : "--cwd";
      expect(
        routeRepositoryFocusedTestCommand(
          root,
          "bun --cwd packages/worker test ./tests/api.test.ts",
        ),
      ).toEqual([`${manager} ${flag} packages/worker run test:api`]);
    },
  );

  test("preserves explicit Bun imports even when another config broadly matches", () => {
    const root = mixedFixture();
    write(
      root,
      "vitest.search.config.mts",
      "export default { test: { include: ['**/*.test.ts'] } };",
    );
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/render.test.ts")).toEqual([
      "bun test ./tests/render.test.ts",
    ]);
  });

  test("routes runner-global tests by an explicit include rather than package name", () => {
    const root = mixedFixture();
    write(root, "services/billing/globals.test.ts", "test('charges', () => {});");
    write(
      root,
      "vitest.billing.config.mts",
      "export default { test: { include: ['services/billing/**/*.{test,spec}.ts'] } };",
    );
    expect(
      routeRepositoryFocusedTestCommand(root, "bun test ./services/billing/globals.test.ts"),
    ).toEqual(["bun run test:billing"]);
  });

  test("retains all explicitly matching configurations instead of silently choosing one environment", () => {
    const root = mixedFixture();
    write(
      root,
      "vitest.search.config.mts",
      "export default { test: { include: ['services/billing/**/*.vitest.ts'] } };",
    );
    expect(
      routeRepositoryFocusedTestCommand(root, "bun test ./services/billing/charges.vitest.ts"),
    ).toEqual(["bun run test:billing", "bun run test:search"]);
  });

  test("does not guess between ambiguous scripts with no config selectors", () => {
    const root = fixture();
    manifest(root, { "test:one": "vitest run", "test:two": "vitest run --pool=forks" });
    write(root, "tests/api.test.ts", 'import { test } from "vitest";');
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test("does not treat installing Vitest as proof that it owns every test", () => {
    const root = fixture();
    manifest(root, { test: "vitest run" }, { devDependencies: { vitest: "4.0.0" } });
    write(root, "tests/api.test.ts", "test('api', () => {});");
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test("uses unique explicit runner imports and default file patterns", () => {
    const root = fixture();
    manifest(root, { "test:unit": "vitest run" });
    write(root, "tests/api.test.ts", 'import { test } from "vitest";');
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun run test:unit",
    ]);
    write(root, "tests/api.vitest.ts", 'import { test } from "vitest";');
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.vitest.ts")).toEqual([
      "bun test ./tests/api.vitest.ts",
    ]);
  });

  test("supports Jest imports and a literal testMatch config", () => {
    const root = fixture();
    manifest(
      root,
      { "test:unit": "jest --config jest.config.json" },
      { packageManager: "npm@11.0.0" },
    );
    write(root, "jest.config.json", JSON.stringify({ testMatch: ["**/tests/**/*.test.ts"] }));
    write(root, "tests/api.test.ts", 'import { test } from "@jest/globals";');
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "npm run test:unit",
    ]);
  });

  test.each([
    "export default { test: { include: ['elsewhere/**/*.test.ts'] } };",
    "export default { test: { include: ['tests/**/*.test.ts'], exclude: ['tests/api.test.ts'] } };",
    "export default { test: { include: discoverTests() } };",
    "export default { test: { include: ['tests/**/*.test.ts', ...other] } };",
    "export default { root: process.env.ROOT, test: { include: ['tests/**/*.test.ts'] } };",
    "export default { test: { include: ['tests/**/*.test.ts'], exclude: exclusions } };",
    "export default { test: { include: ['tests/**/*.test.ts'], projects: ['another-project'] } };",
    "export default { test: { include: ['tests/**/*.test.ts'], ...shared } };",
    "export default mergeConfig({ test: { include: ['tests/**/*.test.ts'] } }, shared);",
    "export default Object.assign({ test: { include: ['tests/**/*.test.ts'] } }, shared);",
  ])("does not route excluded, mismatched, or dynamically selected tests (%#)", (config) => {
    const root = fixture();
    manifest(root, { "test:unit": "vitest run --config vitest.config.ts" });
    write(root, "tests/api.test.ts", 'import { test } from "vitest";');
    write(root, "vitest.config.ts", config);
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test("does not treat a Jest relative selector as ownership when only an unrelated suite matches", () => {
    const root = fixture();
    manifest(root, { "test:unit": "jest --config jest.config.json" });
    write(root, "tests/api.test.ts", 'import { test } from "@jest/globals";');
    write(root, "other/safe.test.ts", 'import { test } from "@jest/globals";');
    write(
      root,
      "jest.config.json",
      JSON.stringify({ testMatch: ["tests/**/*.test.ts", "**/other/**/*.test.ts"] }),
    );
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./other/safe.test.ts")).toEqual([
      "bun run test:unit",
    ]);
  });

  test("does not treat an explicitly selected package manifest as empty Jest configuration", () => {
    const root = fixture();
    manifest(
      root,
      { "test:unit": "jest --config ./package.json" },
      { jest: { testMatch: ["**/other/**/*.test.ts"] } },
    );
    write(root, "tests/api.test.ts", 'import { test } from "@jest/globals";');
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test("respects Jest's config-directory default root independently of package cwd", () => {
    const root = fixture();
    manifest(root, { "test:unit": "jest --config config/jest.config.json" });
    write(root, "tests/api.test.ts", 'import { test } from "@jest/globals";');
    write(root, "config/tests/api.test.ts", 'import { test } from "@jest/globals";');
    write(root, "config/jest.config.json", JSON.stringify({ testMatch: ["**/*.test.ts"] }));
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./config/tests/api.test.ts")).toEqual([
      "bun run test:unit",
    ]);
  });

  test.each([
    { filter: "./filter.js" },
    { testSequencer: "./sequencer.js" },
    { modulePathIgnorePatterns: ["tests/"] },
    { moduleFileExtensions: ["js"] },
    { runner: "./runner.js" },
  ])("does not infer coverage through opaque Jest selection overrides (%#)", (extra) => {
    const root = fixture();
    manifest(root, { "test:unit": "jest --config jest.config.json" });
    write(root, "tests/api.test.ts", 'import { test } from "@jest/globals";');
    write(
      root,
      "jest.config.json",
      JSON.stringify({ testMatch: ["**/tests/**/*.test.ts"], ...extra }),
    );
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test.each([
    "export default { plugins: [{ name: 'narrow', config(config) { config.test.include = ['other/**']; } }], test: { include: ['tests/**/*.test.ts'] } };",
    "import narrow from './plugin'; export default { plugins: [narrow()], test: { include: ['tests/**/*.test.ts'] } };",
    "import { cloudflareTest } from './plugin'; export default { plugins: [cloudflareTest({})], test: { include: ['tests/**/*.test.ts'] } };",
    "import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; export default { plugins: [cloudflareTest({}), other], test: { include: ['tests/**/*.test.ts'] } };",
    "import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; export default { plugins: [cloudflareTest(() => ({}))], test: { include: ['tests/**/*.test.ts'] } };",
    "import { cloudflareTest } from '@cloudflare/vitest-pool-workers'; export default { plugins: [...other, cloudflareTest({})], test: { include: ['tests/**/*.test.ts'] } };",
  ])("does not allow opaque plugins to replace the inferred selectors (%#)", (config) => {
    const root = fixture();
    manifest(root, { "test:unit": "vitest run" });
    write(root, "tests/api.test.ts", 'import { test } from "vitest";');
    write(root, "vitest.config.ts", config);
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test.each(["**/[!a]*.test.ts", "**/[ab]*.test.ts", "**/+(b).test.ts"])(
    "does not approximate runner-specific character classes or extglobs (%s)",
    (pattern) => {
      const root = fixture();
      manifest(root, { "test:unit": "vitest run" });
      write(root, "tests/b.test.ts", 'import { test } from "vitest";');
      write(root, "vitest.config.ts", `export default { test: { include: ['${pattern}'] } };`);
      expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/b.test.ts")).toEqual([
        "bun test ./tests/b.test.ts",
      ]);
    },
  );

  test("declines runner-specific excludes instead of dropping an exclusion", () => {
    const root = fixture();
    manifest(root, { "test:unit": "vitest run" });
    write(root, "tests/slow/api.test.ts", 'import { test } from "vitest";');
    write(
      root,
      "vitest.config.ts",
      "export default { test: { include: ['tests/**/*.test.ts'], exclude: ['**/@(slow|integration)/**'] } };",
    );
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/slow/api.test.ts")).toEqual([
      "bun test ./tests/slow/api.test.ts",
    ]);
  });

  test("resolves literal config roots relative to package cwd", () => {
    const root = fixture();
    manifest(root, { "test:unit": "vitest run --config config/vitest.config.ts" });
    write(
      root,
      "config/vitest.config.ts",
      "export default { root: 'service', test: { include: ['tests/**/*.test.ts'] } };",
    );
    write(root, "service/tests/api.test.ts", 'import { test } from "vitest";');
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./service/tests/api.test.ts")).toEqual(
      ["bun run test:unit"],
    );
  });

  test.each([
    "import shared from './other-config'; export default shared;",
    "export { default } from './other-config';",
    "export { shared as default } from './other-config';",
    "export default () => ({ test: { include: ['tests/**/*.test.ts'] } });",
    "export default async function () { return { test: { include: ['tests/**/*.test.ts'] } }; }",
    "import { defineConfig } from 'vitest/config'; export default defineConfig(() => ({ test: { include: ['tests/**/*.test.ts'] } }));",
    "import { defineConfig } from './other-config'; export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });",
    "function defineConfig(value) { return { test: { include: ['other/**'] } }; } export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });",
    "const example = { test: { include: ['tests/**/*.test.ts'] } }; export default imported;",
    "export default { test: shared };",
    "export default { ...shared, test: { include: ['tests/**/*.test.ts'] } };",
    "export default { test: { ...shared, include: ['tests/**/*.test.ts'] } };",
    "export default { test: { include: ['tests/**/*.test.ts'], ...shared } };",
    "export default { test: { include: ['tests/**/*.test.ts'] }, ...shared };",
    "export default { test: { ['include']: ['tests/**/*.test.ts'] } };",
    "export default { get test() { return { include: ['tests/**/*.test.ts'] }; } };",
    "export default { test: { include: ['tests/**/*.test.ts'], include: ['other/**'] } };",
    "export default { test: { include: ['tests/**/*.test.ts'] }, test: { include: ['other/**'] } };",
    "export default { test: { include: ['tests/**/*.test.ts'] } }; imported.test.include = ['other/**'];",
    "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } }, other);",
    "export default { test: { include: ['tests/**/*.test.ts'], dir: 'other' } };",
    "export default { test: { include: ['tests/**/*.test.ts'] ? ['other/**'] : [] } };",
    "export default { test: { include: [`tests/**/*.test.ts`] } };",
  ])("keeps opaque effective configuration unresolved (%#)", (config) => {
    const root = fixture();
    manifest(root, { "test:unit": "vitest run --config vitest.config.ts" });
    write(root, "tests/api.test.ts", 'import { test } from "vitest";');
    write(root, "other-config.ts", "export default { test: { include: ['other/**'] } };");
    write(root, "vitest.config.ts", config);
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test.each([
    "export default { test: { /* include: ['tests/**/*.vitest.ts'] */ } };",
    "export default { test: { // include: ['tests/**/*.vitest.ts']\n } };",
    "export default { test: { // include: ['tests/**/*.vitest.ts']\r\n } };",
    "export default { test: { // include: ['tests/**/*.vitest.ts']\u2028 } };",
    "export default { note: \"include: ['tests/**/*.vitest.ts']\", test: {} };",
    'export default { note: "escaped quote \\\" include: [\'tests/**/*.vitest.ts\']", test: {} };',
    "export default { test: { coverage: { include: ['tests/**/*.vitest.ts'] } } };",
    "export default { include: ['tests/**/*.vitest.ts'], test: {} };",
  ])(
    "cannot manufacture discovery selectors from comments, strings, or another scope (%#)",
    (config) => {
      const root = fixture();
      manifest(root, { "test:unit": "vitest run --config vitest.config.ts" });
      write(root, "tests/api.vitest.ts", 'import { test } from "vitest";');
      write(root, "vitest.config.ts", config);
      expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.vitest.ts")).toEqual([
        "bun test ./tests/api.vitest.ts",
      ]);
    },
  );

  test.each([
    "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['tests/**/*.vitest.ts'] } });",
    "import { defineConfig as configure } from 'vitest/config'; export default configure({ test: { include: ['tests/**/*.vitest.ts'] } });",
    "import { defineConfig } from 'vite'; export default defineConfig({ test: { include: ['tests/**/*.vitest.ts'] } });",
    "import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'; export default defineWorkersConfig({ test: { include: ['tests/**/*.vitest.ts'], poolOptions: { workers: { wrangler: { configPath: './worker.jsonc' } } } } });",
    "import { cloudflareTest } from '@cloudflare/vitest-pool-workers'\nimport { defineConfig } from 'vitest/config'\nexport default defineConfig({ plugins: [cloudflareTest({ wrangler: { configPath: './worker.jsonc' }, miniflare: { bindings: { API_ORIGIN: 'https://example.test/* not a comment */' } } })], test: { include: ['tests/**/*.vitest.ts'] } })",
    "import { cloudflareTest as workers } from '@cloudflare/vitest-plugin'; import { defineConfig } from 'vitest/config'; export default defineConfig({ plugins: [workers({ wrangler: { configPath: './worker.jsonc' } })], test: { include: ['tests/**/*.vitest.ts'] } });",
    "export default { test: { /* exclude: ['tests/**'] */ include: [/* prefix */ 'tests/**/*.vitest.ts', /* suffix */], note: 'workspace: [other], include: [other]' } };",
    "module.exports = { test: { include: ['tests/**/*.vitest.ts'] } };",
  ])("preserves proven literal selectors and standard configuration helpers (%#)", (config) => {
    const root = fixture();
    manifest(root, { "test:unit": "vitest run --config vitest.config.ts" });
    write(root, "tests/api.vitest.ts", 'import { test } from "vitest";');
    write(root, "vitest.config.ts", config);
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.vitest.ts")).toEqual([
      "bun run test:unit",
    ]);
  });

  test("uses default discovery only when the exported config proves selectors are absent", () => {
    const root = fixture();
    manifest(root, { "test:unit": "vitest run" });
    write(root, "tests/api.test.ts", 'import { test } from "vitest";');
    write(
      root,
      "vitest.config.ts",
      "export default { test: { /* include: ['other/**'] */ globals: true } };",
    );
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun run test:unit",
    ]);
    write(root, "vitest.config.ts", "import shared from './other'; export default shared;");
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test.each(["dist", ".cache", "node_modules"])(
    "does not claim default discovery of an excluded %s directory",
    (directory) => {
      const root = fixture();
      manifest(root, { "test:unit": "vitest run" });
      write(root, `${directory}/api.test.ts`, 'import { test } from "vitest";');
      const command = `bun test ./${directory}/api.test.ts`;
      expect(routeRepositoryFocusedTestCommand(root, command)).toEqual([command]);
    },
  );

  test("a literal exclude replacement can intentionally include normally excluded directories", () => {
    const root = fixture();
    manifest(root, { "test:unit": "vitest run" });
    write(root, "dist/api.test.ts", 'import { test } from "vitest";');
    write(
      root,
      "vitest.config.ts",
      "export default { test: { include: ['dist/**/*.test.ts'], exclude: [] } };",
    );
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./dist/api.test.ts")).toEqual([
      "bun run test:unit",
    ]);
  });

  test.each(["tests/api.TEST.ts", "tests/api.test.TS", "vite.config.test.ts"])(
    "does not claim native default discovery for %s",
    (path) => {
      const root = fixture();
      manifest(root, { "test:unit": "vitest run" });
      write(root, path, 'import { test } from "vitest";');
      const command = `bun test ./${path}`;
      expect(routeRepositoryFocusedTestCommand(root, command)).toEqual([command]);
    },
  );

  test("does not assume default discovery when an external workspace selects other projects", () => {
    const root = fixture();
    manifest(root, { "test:unit": "vitest run" });
    write(root, "tests/api.test.ts", 'import { test } from "vitest";');
    write(root, "vitest.workspace.ts", "export default ['other/vitest.config.ts'];");
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test("does not approximate inherited Jest preset discovery", () => {
    const root = fixture();
    manifest(root, { "test:unit": "jest --config jest.config.json" });
    write(root, "tests/api.test.ts", 'import { test } from "@jest/globals";');
    write(
      root,
      "jest.config.json",
      JSON.stringify({ preset: "other", testMatch: ["tests/**/*.test.ts"] }),
    );
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test.each([
    "vitest",
    "vitest --watch",
    "vitest run --watch",
    "echo vitest run",
    "vitest run && echo ok",
    "vitest run different.test.ts",
    "vitest run --project other",
    "vitest run --dir another-directory",
    "vitest run --root elsewhere",
    "vitest run --testNamePattern unrelated",
    "vitest run --passWithNoTests",
  ])("never synthesizes watch mode or unrelated/chained entrypoints (%s)", (script) => {
    const root = fixture();
    manifest(root, { test: script });
    write(root, "tests/api.test.ts", 'import { test } from "vitest";');
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test.each([
    "bun run test:billing",
    "bun test --preload ./setup.ts ./services/billing/charges.vitest.ts",
    "bun test",
    "bun test ./services/billing/charges.vitest.ts && echo passed",
  ])(
    "leaves explicit scripts, filtered/flagged commands, and unsupported shell input unchanged (%s)",
    (command) => {
      expect(routeRepositoryFocusedTestCommand(mixedFixture(), command)).toEqual([command]);
    },
  );

  test("does not borrow a parent suite across a nested package boundary", () => {
    const root = fixture();
    manifest(root, { test: "vitest run" });
    write(root, "packages/app/package.json", JSON.stringify({ scripts: {} }));
    write(root, "packages/app/api.test.ts", 'import { test } from "vitest";');
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./packages/app/api.test.ts")).toEqual([
      "bun test ./packages/app/api.test.ts",
    ]);
  });

  test("does not cross a malformed owning package boundary", () => {
    const root = fixture();
    manifest(root, { test: "vitest run" });
    write(root, "packages/app/package.json", "{ malformed");
    write(root, "packages/app/api.test.ts", 'import { test } from "vitest";');
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./packages/app/api.test.ts")).toEqual([
      "bun test ./packages/app/api.test.ts",
    ]);
  });

  test("reads Vite fallback configuration and respects its excluded paths", () => {
    const root = fixture();
    manifest(root, { test: "vitest run" });
    write(root, "tests/api.test.ts", 'import { test } from "vitest";');
    write(
      root,
      "vite.config.ts",
      "export default { test: { include: ['tests/**/*.test.ts'], exclude: ['tests/api.test.ts'] } };",
    );
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
    write(
      root,
      "vitest.config.ts",
      "export default { test: { include: ['tests/**/*.test.ts'] } };",
    );
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun run test",
    ]);
  });

  test.each([
    "--config first.ts --config second.ts",
    "--config first.ts --config=second.ts",
    "-c first.ts -c=second.ts",
  ])("declines duplicate config selection (%s)", (flags) => {
    const root = fixture();
    manifest(root, { test: `vitest run ${flags}` });
    write(root, "tests/api.test.ts", 'import { test } from "vitest";');
    write(root, "first.ts", "export default { test: { include: ['tests/**/*.test.ts'] } };");
    write(root, "second.ts", "export default { test: { include: ['different/**/*.test.ts'] } };");
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test("does not ignore Jest package-level configuration or negated testMatch selectors", () => {
    const root = fixture();
    manifest(root, { test: "jest" }, { jest: { testMatch: ["elsewhere/**/*.test.ts"] } });
    write(root, "tests/api.test.ts", 'import { test } from "@jest/globals";');
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
    manifest(root, { test: "jest --config jest.config.json" });
    write(
      root,
      "jest.config.json",
      JSON.stringify({ testMatch: ["**/tests/**/*.test.ts", "!**/tests/api.test.ts"] }),
    );
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test("declines multiple implicit config files instead of guessing loader precedence", () => {
    const root = fixture();
    manifest(root, { test: "vitest run" });
    write(root, "tests/api.test.ts", 'import { test } from "vitest";');
    write(
      root,
      "vitest.config.ts",
      "export default { test: { include: ['tests/**/*.test.ts'] } };",
    );
    write(
      root,
      "vitest.config.mts",
      "export default { test: { include: ['elsewhere/**/*.test.ts'] } };",
    );
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./tests/api.test.ts")).toEqual([
      "bun test ./tests/api.test.ts",
    ]);
  });

  test("does not follow test symlinks outside the repository", () => {
    const root = fixture();
    const outside = fixture();
    manifest(root, { test: "vitest run" });
    write(outside, "api.test.ts", 'import { test } from "vitest";');
    // Directory junctions do not require Windows symlink privileges.
    symlinkSync(outside, join(root, "external"), process.platform === "win32" ? "junction" : "dir");
    expect(routeRepositoryFocusedTestCommand(root, "bun test ./external/api.test.ts")).toEqual([
      "bun test ./external/api.test.ts",
    ]);
  });

  test.each([false, true])(
    "WorkerPal routes %s planner/fallback commands and retains every mandatory gate",
    (useFallback) => {
      const root = mixedFixture();
      const path = "services/billing/charges.vitest.ts";
      const wrongCommand = `bun test ./${path}`;
      const result = collectQualityGateValidationCommands({
        repo: root,
        instruction: "add regression coverage",
        targetPath: path,
        changedTestPaths: [path],
        isTestTask: true,
        planning: {
          scope: { readAnywhere: true, writeAllowed: true, writeGlobs: [path] },
          validationSteps: useFallback ? [] : [wrongCommand],
          requiredValidationSteps: ["bun run lint", "bun run required:publish"],
        } as any,
      });
      expect(result.requiredRunnableSteps).toEqual(["bun run lint", "bun run required:publish"]);
      expect(result.commandsToRun).toContain("bun run test:billing");
      expect(result.commandsToRun).toContain("bun run lint");
      expect(result.commandsToRun).toContain("bun run required:publish");
      expect(result.commandsToRun).not.toContain(wrongCommand);
      expect(result.commandsToRun).not.toContain("bun test");
    },
  );

  test("does not silently rewrite a user-mandated direct test command", () => {
    const root = mixedFixture();
    const command = "bun test ./services/billing/charges.vitest.ts";
    const result = collectQualityGateValidationCommands({
      repo: root,
      instruction: "add coverage",
      changedTestPaths: [],
      isTestTask: false,
      planning: { validationSteps: [], requiredValidationSteps: [command] } as any,
    });
    expect(result.requiredRunnableSteps).toEqual([command]);
    expect(result.commandsToRun).toEqual([command]);
  });
});
