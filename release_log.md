# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.67`
- start_commit: `905aed55f14782f9ac73dde447f3e9a5e51ae139`
- end_commit: `ce1e9d28c0739949717c67c93e3f177816c63b6a`
- commits_in_range: `1`

## Highlights

- Default the OpenAI Codex WorkerPal backend and shipped CLI/runtime configs to `gpt-5.5`.
- Keep older Codex CLI installs from hard-failing by retrying once on `gpt-5.4` only when Codex reports that `gpt-5.5` requires a newer CLI.
- Fix Windows Codex command launching by resolving configured `bun`/`bunx` command prefixes to executable paths before Python subprocess execution.
- Add source and packaged runtime regression coverage for `gpt-5.5` reasoning behavior, model-compatibility fallback, and Windows command-prefix resolution.

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

- Codex may still emit non-fatal local state/plugin sync warnings on Windows, including local state DB migration warnings and plugin sync certificate/403 warnings; WorkerPal execution continues when Codex itself succeeds.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
- Per-app `tsc --noEmit` still trips over the existing unrelated shared-config typing issue in `packages/shared/src/config.ts`; release validation for this change used focused WorkerPal backend tests and live Codex smoke coverage.
