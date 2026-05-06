# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.63`
- start_commit: `78645d04f8b1458d671ef727a5742f1e515ef7f4`
- end_commit: `ad4aeb8afe9b4f6c0747e358dcbf7d23c6c6cd59`
- commits_in_range: `4`

## Highlights

- Harden the CLI integration suite with installed-runtime reuse coverage and a `--no-auto-start` unavailable-runtime path so reconnect and cold-status behavior are exercised the way users actually invoke the packaged CLI.
- Mirror the Codex command-router policy prompt into packaged runtime prompt directories so the source prompt, embedded runtime, and sandbox runtime all ship the same wrapper-shell guidance text.
- Add stronger WorkerPals Codex wrapper-shell recovery so repeated `/bin/bash -lc ...` style rejections escalate into a stricter second retry instead of failing immediately in a rejection loop.
- Make RemoteBuddy autonomy ideation more resilient under Codex latency by expanding the effective ideation timeout for Codex-backed runs, logging prompt-size and phase-duration metrics, and adding a one-shot “fit within the time budget” recovery instruction on the next ideation round after a timeout.

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
