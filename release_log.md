# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.66`
- start_commit: `d242307c651b848010a5233bcb7b670fbdbc8695`
- end_commit: `31fdbdc843b280d45dda8c36f77a01a63ec62dfd`
- commits_in_range: `1`

## Highlights

- Harden the packaged CLI Docker-timeout E2E to verify the real recovery contract instead of brittle exact warning strings by recording timed-out inspect/build invocations and asserting startup still reaches ready/connected.
- Prevent the `Windows Host Docker E2E` workflow lane from sitting queued pointlessly when Linux is already red by making the self-hosted Windows lane depend on the two Linux CLI/WorkerPals E2E jobs.
- Sync the generated bundled RemoteBuddy fallback asset with the current autonomy-scope and ideation-timeout recovery behavior so packaged fallback runtime assets stay aligned with source logic.

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
