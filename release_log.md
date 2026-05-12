# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.72`
- start_commit: `981e8d8333fd87b43005deef7ee845f75e433c48`
- end_commit: `aa2479d1c46dfc6d2514dde7b5c3843a146eb341`
- commits_in_range: `1`

## Highlights

- Honor an explicit `PUSHPALS_DOCKER_BIN_ABSOLUTE` or `PUSHPALS_DOCKER_BIN` override before resolving `docker` from `PATH` during WorkerPal Docker preflight.
- Preserve the configured Docker binary through the preflight environment so sandbox image checks, rebuilds, and runtime services use the intended executable.
- Add regression coverage for configured Docker probe binary precedence.

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
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal task execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
