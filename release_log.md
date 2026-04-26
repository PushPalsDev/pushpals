# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.60`
- start_commit: `3cc70920dee7751184ebfb7958d0d20ee6dece30`
- end_commit: `a8f3dcff239cae2633c34f42b32538c6c56f24a8`
- commits_in_range: `1`

## Highlights

- Add a real installed-package smoke runner that verifies the published `@pushpalsdev/cli` package cold-starts the embedded runtime, survives `pushpals --clear`, and reaches `--status-once` readiness on both Windows and Linux.
- Extend packaged CLI end-to-end coverage to install the freshly packed CLI tarball into an isolated global Bun prefix and boot the installed `pushpals` entrypoint instead of only testing the source-tree bundle.
- Wire post-publish release canaries into the release workflow so every tagged release now validates the actual npm package install path on both `windows-2022` and `ubuntu-latest` after publish, closing the gap that let installed-package startup regressions escape earlier releases.

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

- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately and passes on native WSL Bun.
