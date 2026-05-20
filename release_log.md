# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.90`
- start_commit: `72215fc85d6e3330537129b7ec00dca6db2c4129`
- end_commit: `8c9741cd09affd30f7b3e7c59d5ac72e7ce5c855`
- commits_in_range: `1`

## Highlights

- Gate GitHub release asset publication behind a successful npm publish, so a bad `NPM_TOKEN` or npm authorization issue no longer creates a half-published GitHub release.
- Keep binary builds and the Windows runtime smoke ahead of npm publish, preventing npm publication when runtime artifacts or the Windows autonomy smoke are broken.
- Keep installed-package Linux and Windows smokes after both npm publish and GitHub release asset publication, matching the real installed CLI path that may download runtime binaries from the release.

## Validation

- `bun x prettier --check .github/workflows/release-cli.yml`
- `bun test tests/release-windows-runtime-smoke.test.ts`
- `git diff --check`

## Install

```bash
npm i -g @pushpalsdev/cli
```

```bash
bun install -g @pushpalsdev/cli
```

## Artifacts

- `pushpals-linux-x64`
- `pushpals-windows-x64.exe`
- `pushpals-macos-x64`
- `pushpals-macos-arm64`
- `SHA256SUMS.txt`

## Breaking Changes

- None.

## Known Issues

- `v1.0.87`, `v1.0.88`, and `v1.0.89` were tagged but did not publish to npm; `v1.0.89` did publish GitHub release assets before the npm token failure.
- npm publication still requires the repository `NPM_TOKEN` secret to have publish rights for `@pushpalsdev/cli` under the `@pushpalsdev` scope.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
