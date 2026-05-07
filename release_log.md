# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.64`
- start_commit: `c8ad6017bbce79e1ba15cac84385827ad8f8a7e1`
- end_commit: `7dd9406dd34c98c7d3e821ac349758f07708cd05`
- commits_in_range: `1`

## Highlights

- Preserve tracked `.codex` sentinel files during WorkerPals rebase-based branch sync by restoring them to `HEAD` and continuing publish retries instead of treating every tracked `.codex` path as a terminal publish blocker.
- Keep the packaged sandbox runtime in sync with the source WorkerPals branch-finalization fix so released CLI builds handle tracked `.codex` PR branches the same way as source-tree tests.
- Add regression coverage for the exact tracked-`.codex` retry path: a remote branch that introduces `.codex` plus a content conflict now completes sync successfully while preserving the tracked sentinel.

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
- Per-app `tsc --noEmit` still trips over the existing unrelated shared-config typing issue in `packages/shared/src/config.ts`; release validation for this change relied on targeted WorkerPals regressions and end-to-end suites instead.
