# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.81`
- start_commit: `8afe2d4b404e3ec4a066281bf9472c28574b5181`
- end_commit: `95ae513d9c1791292b91f8c2f4cbe99e3d469124`
- commits_in_range: `3`

## Highlights

- Defer SourceControlManager ReviewAgent polling until the runtime is fully ready so startup no longer begins Codex reviews before dependent services and environment setup have settled.
- Move RemoteBuddy WorkerPal prewarming into a non-blocking startup path and keep the packaged sandbox fallback in sync, avoiding duplicate startup stalls while preserving worker capacity warmup.
- Fix the Mission Control Jobs & Traces refresh path by hydrating trace cards from durable job snapshots and persisted `/jobs/:id/logs` rows when live SSE events are no longer replayed.
- Preserve live trace state when available while filling refresh gaps from snapshots, including completed, failed, abandoned, and publish-blocked job diagnostics.
- Add focused monitor hydration and job-log API coverage so refresh-visible running jobs, persisted logs, and parsed result/error summaries stay regression-tested.

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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
