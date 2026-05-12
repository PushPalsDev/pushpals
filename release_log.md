# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.71`
- start_commit: `3a00331826085622641c0583d51688ea559a813c`
- end_commit: `f2d964f698f41db2545105187c2034e8131196d8`
- commits_in_range: `1`

## Highlights

- Treat Docker command timeouts during `pushpals --clear` WorkerPal cleanup as best-effort skips instead of fatal errors.
- Keep warm-container inspection and removal cleanup useful when Docker responds, while avoiding installed CLI smoke failures when Docker is slow or wedged.
- Apply the same timeout skip behavior to WorkerPal sandbox image cleanup.
- Add regression coverage for Docker cleanup timeout classification and the affected clear helpers.

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
