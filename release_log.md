# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.65`
- start_commit: `aeba3f47f05a727c7c0bf032ffd8579115cb43ef`
- end_commit: `862e927fd6863b6d083c205c090bea9d40257d33`
- commits_in_range: `1`

## Highlights

- Fail true autonomy tasks honestly when their `targetPaths` span disjoint repo roots instead of deriving a fake single component root from the first path, while still allowing multi-root `review_fix` and `merge_conflict` tasks under the normal write-scope hygiene checks.
- Recover repeated OpenAI Codex wrapper-shell inspection loops by injecting backend-run, read-only direct-command bootstrap context on the strict retry, so simple `pwd` / `git branch --show-current` / `ls` wrapper retries do not keep dying on command-router policy rejections.
- Keep the packaged sandbox runtime in sync with both the autonomy-scope validation change and the stricter Codex wrapper recovery path, with regression coverage for disjoint-root validation and backend bootstrap-assisted recovery.

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
