# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.61`
- start_commit: `d6a3750cc903aebff16de37df09d0b40179799f8`
- end_commit: `93c51bc177e9e36177bc51b2edfc0639ea267fe7`
- commits_in_range: `1`

## Highlights

- Preserve successful local WorkerPal task commits as a distinct `publish_blocked` terminal state when final branch sync or push fails, instead of misreporting them as generic commit-creation failures.
- Surface branch-finalization diagnostics through the worker, Docker job runner, server API, and dashboard so stuck publish races now report the exact sync/push failure along with the saved hidden ref and commit SHA.
- Harden rebase-based branch sync to resolve add/add and delete-vs-modify conflicts in worker favor without accidentally staging unrelated untracked files, and add regression coverage for those finalization races.

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
- Per-app `tsc --noEmit` still trips over the existing unrelated shared-config typing issue in `packages/shared/src/config.ts`; release validation for this change relied on WorkerPals/server compile checks and targeted end-to-end suites instead.
