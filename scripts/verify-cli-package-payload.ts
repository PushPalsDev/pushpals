#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

export type PackagePayloadFile = {
  path: string;
  size?: number;
};

export type PackagePayloadIssue = {
  path: string;
  reason: string;
};

const REQUIRED_CLI_PACKAGE_PATHS = new Set(["bin/pushpals.cjs", "dist/pushpals-cli.js"]);

const DISALLOWED_DIRECTORY_SEGMENTS = new Set([
  ".bun",
  ".venv",
  "node_modules",
  "venv",
]);

const EXTERNAL_TOOL_NAME_PATTERN =
  /^(bun|bunx|node|npm|npx|pnpm|yarn|git|docker|codex|uv|python|python3|pip|pip3)(\.(exe|cmd|bat|ps1|sh))?$/i;

const EXECUTABLE_OR_NATIVE_LIBRARY_PATTERN =
  /\.(exe|dll|dylib|node|pyd|jar)$|\.so(\.\d+)*$/i;

const RELEASE_ARTIFACT_ALLOW_PATTERN =
  /^(pushpals-(linux-x64|windows-x64\.exe|macos-x64|macos-arm64)|pushpals-runtime-(server|localbuddy|remotebuddy|workerpals|source-control-manager)-(linux-x64|windows-x64\.exe|macos-x64|macos-arm64)|SHA256SUMS\.txt)(\.asc)?$/;

function normalizePackagePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function splitPackagePath(path: string): string[] {
  return normalizePackagePath(path)
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isDisallowedDirectorySegment(segment: string): boolean {
  return DISALLOWED_DIRECTORY_SEGMENTS.has(segment.toLowerCase());
}

function isExternalToolBasename(path: string): boolean {
  return EXTERNAL_TOOL_NAME_PATTERN.test(basename(path));
}

function isExecutableOrNativeLibrary(path: string): boolean {
  return EXECUTABLE_OR_NATIVE_LIBRARY_PATTERN.test(basename(path));
}

export function findDisallowedCliPackageEntries(
  files: PackagePayloadFile[],
): PackagePayloadIssue[] {
  const issues: PackagePayloadIssue[] = [];
  const normalizedPaths = new Set(files.map((file) => normalizePackagePath(file.path)));

  for (const requiredPath of REQUIRED_CLI_PACKAGE_PATHS) {
    if (!normalizedPaths.has(requiredPath)) {
      issues.push({
        path: requiredPath,
        reason: "required CLI package entry is missing",
      });
    }
  }

  for (const file of files) {
    const path = normalizePackagePath(file.path);
    const segments = splitPackagePath(path);
    const disallowedSegment = segments.find(isDisallowedDirectorySegment);
    if (disallowedSegment) {
      issues.push({
        path,
        reason: `package payload includes disallowed directory segment '${disallowedSegment}'`,
      });
      continue;
    }

    if (isExternalToolBasename(path)) {
      issues.push({
        path,
        reason: "package payload includes an external toolchain executable name",
      });
      continue;
    }

    if (isExecutableOrNativeLibrary(path)) {
      issues.push({
        path,
        reason: "package payload includes an executable or native binary artifact",
      });
    }
  }

  return issues;
}

export function findDisallowedReleaseArtifactEntries(paths: string[]): PackagePayloadIssue[] {
  return paths
    .map(normalizePackagePath)
    .filter((path) => path && !RELEASE_ARTIFACT_ALLOW_PATTERN.test(path))
    .map((path) => ({
      path,
      reason:
        "release artifact name is not an expected PushPals binary/checksum/signature artifact",
    }));
}

function runNpmPackDryRun(packageDir: string): PackagePayloadFile[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `npm pack --dry-run failed with exit ${result.status ?? "(signal)"}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const parsed = JSON.parse(result.stdout) as Array<{ files?: PackagePayloadFile[] }>;
  const files = parsed[0]?.files;
  if (!Array.isArray(files)) {
    throw new Error("npm pack --dry-run did not return package file metadata");
  }
  return files;
}

function collectReleaseArtifactPaths(releaseDir: string): string[] {
  return readdirSync(releaseDir)
    .map((name) => resolve(releaseDir, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => normalizePackagePath(relative(releaseDir, path)));
}

function printIssues(kind: string, issues: PackagePayloadIssue[]): void {
  console.error(`[pushpals] ${kind} payload contains disallowed file(s):`);
  for (const issue of issues) {
    console.error(`[pushpals] - ${issue.path}: ${issue.reason}`);
  }
}

function parseArgs(argv: string[]): {
  packageDir: string;
  releaseDir: string | null;
  verifyPackage: boolean;
} {
  let packageDir = resolve("packages/cli");
  let releaseDir: string | null = null;
  let verifyPackage = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--skip-package":
        verifyPackage = false;
        break;
      case "--package-dir":
        packageDir = resolve(String(argv[++index] ?? ""));
        break;
      case "--release-dir":
        releaseDir = resolve(String(argv[++index] ?? ""));
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { packageDir, releaseDir, verifyPackage };
}

if (import.meta.main) {
  try {
    const { packageDir, releaseDir, verifyPackage } = parseArgs(process.argv.slice(2));
    if (verifyPackage) {
      const packageFiles = runNpmPackDryRun(packageDir);
      const packageIssues = findDisallowedCliPackageEntries(packageFiles);
      if (packageIssues.length > 0) {
        printIssues("npm package", packageIssues);
        process.exit(1);
      }
      console.log(
        `[pushpals] verified npm package payload: ${packageFiles.length} file(s), no external toolchain files`,
      );
    }

    if (releaseDir) {
      const releasePaths = collectReleaseArtifactPaths(releaseDir);
      const releaseIssues = findDisallowedReleaseArtifactEntries(releasePaths);
      if (releaseIssues.length > 0) {
        printIssues("GitHub release artifact", releaseIssues);
        process.exit(1);
      }
      console.log(
        `[pushpals] verified release artifact names: ${releasePaths.length} file(s), no external tool artifacts`,
      );
    }
  } catch (err) {
    console.error(`[pushpals] package payload verification failed: ${String(err)}`);
    process.exit(1);
  }
}
