# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.76`
- start_commit: `a4ab117d52c1970e65207aac59b21866a63d9fed`
- end_commit: `9c7982f28e5aae82e8c84ee1c37be4ce49071193`
- commits_in_range: `1`

## Highlights

- Sync the packaged RemoteBuddy fallback bundle with the source startup order so crash fallback warms initial WorkerPal capacity before starting autonomy.
- Preserve the v1.0.75 autonomy startup fix when the Windows packaged binary falls back to bundled source after a Bun runtime panic.
- Confirm Codex CLI `gpt-5.5` with `xhigh` reasoning works through the same `model_reasoning_effort` config shape PushPals passes to Codex.
- Re-run CLI E2E and integration coverage for packaged runtime boot, autonomy-enabled Windows boot, crash fallback, Docker guidance, supervisor restart, session-stream filtering, and runtime bootstrap behavior.

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
