/**
 * Optional bounded synthetic benchmark (no arguments or user paths accepted):
 *   bun run scripts/benchmark-cli-clear.ts
 *   node scripts/benchmark-cli-clear.ts   # Node 24+ TypeScript stripping
 * Fixture creation and final cleanup are excluded from reported removal times.
 * Run only in an approved test environment; timings are not speed assertions.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { removeCliTreeBounded } from "./cli_clear_remove.ts";

const FIXTURE_PREFIX = "pushpals-cli-clear-benchmark-";
const PACKAGES = 40;
const FILES_PER_PACKAGE = 30;
const REPETITIONS = 3;
const SENTINEL_CONTENT = "External fixture content must survive deletion of the tree.\n";
type Variant = "native" | "bounded";

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const absolute = resolve(value);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return normalize(left) === normalize(right);
}

async function assertOwnedRoot(root: string, temporaryParent: string): Promise<void> {
  if (
    !isAbsolute(root) ||
    !samePath(dirname(root), temporaryParent) ||
    !basename(root).startsWith(FIXTURE_PREFIX)
  ) {
    throw new Error(`Refusing benchmark cleanup outside its generated temporary root: ${root}`);
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(root), root)) {
    throw new Error(`Refusing benchmark cleanup after temporary-root identity changed: ${root}`);
  }
}

async function assertRemoved(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Benchmark removal returned before the target disappeared: ${path}`);
}

async function measure(variant: Variant, repetition: number, temporaryParent: string) {
  const root = await mkdtemp(join(temporaryParent, FIXTURE_PREFIX));
  try {
    await assertOwnedRoot(root, temporaryParent);
    const tree = join(root, "tree");
    const external = join(root, "external-sentinel");
    const sentinel = join(external, "keep.txt");
    await mkdir(external);
    await writeFile(sentinel, SENTINEL_CONTENT);
    for (let packageIndex = 0; packageIndex < PACKAGES; packageIndex += 1) {
      const directory = join(
        tree,
        "node_modules",
        ".bun",
        `package-${packageIndex}@1.0.0`,
        "node_modules",
        `package-${packageIndex}`,
        "dist",
      );
      await mkdir(directory, { recursive: true });
      for (let fileIndex = 0; fileIndex < FILES_PER_PACKAGE; fileIndex += 1) {
        await writeFile(join(directory, `file-${fileIndex}.js`), "export const value = 1;\n");
      }
    }
    await symlink(
      external,
      join(tree, "external-directory-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assertOwnedRoot(root, temporaryParent);
    const treeStat = await lstat(tree);
    if (
      !samePath(dirname(tree), root) ||
      !treeStat.isDirectory() ||
      treeStat.isSymbolicLink() ||
      !samePath(await realpath(tree), tree)
    ) {
      throw new Error("Benchmark target is not its owned direct-child directory.");
    }

    const startedAt = performance.now();
    if (variant === "native") {
      await rm(tree, { recursive: true, force: true, maxRetries: 0 });
    } else {
      await removeCliTreeBounded(tree);
    }
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    await assertRemoved(tree);
    if ((await readFile(sentinel, "utf8")) !== SENTINEL_CONTENT) {
      throw new Error(`${variant} removal changed the external fixture sentinel.`);
    }
    const result = {
      type: "case",
      variant,
      repetition,
      durationMs,
      externalSentinelPreserved: true,
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    // The sentinel is outside the measured tree but still inside this owned
    // fixture. Never clean tmpdir itself or a caller-supplied path.
    await assertOwnedRoot(root, temporaryParent);
    await rm(root, { recursive: true, force: true, maxRetries: 0 });
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error(
      "This benchmark accepts no arguments; it only creates owned temporary fixtures.",
    );
  }
  const temporaryParent = await realpath(tmpdir());
  const durations: Record<Variant, number[]> = { native: [], bounded: [] };
  console.log(
    JSON.stringify({
      type: "configuration",
      platform: process.platform,
      arch: process.arch,
      runtime: process.versions.bun ? "bun" : "node",
      runtimeVersion: process.versions.bun ?? process.versions.node,
      packages: PACKAGES,
      filesPerPackage: FILES_PER_PACKAGE,
      filesPerFixture: PACKAGES * FILES_PER_PACKAGE,
      pairedRepetitions: REPETITIONS,
      timingIncludes: "awaited tree removal only",
    }),
  );
  for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
    const order: Variant[] = repetition % 2 === 1 ? ["native", "bounded"] : ["bounded", "native"];
    for (const variant of order) {
      const result = await measure(variant, repetition, temporaryParent);
      durations[variant].push(result.durationMs);
    }
  }
  console.log(
    JSON.stringify({
      type: "summary",
      nativeMedianMs: median(durations.native),
      boundedMedianMs: median(durations.bounded),
      externalSentinelPreserved: true,
      note: "Synthetic fixture timings only; no performance threshold or live-repository claim.",
    }),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
