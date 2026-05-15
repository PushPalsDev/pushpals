# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.78`
- start_commit: `305a2bfc53770db5bac50a6a917b82d15fe9bfe9`
- end_commit: `6aa7e4fa818bdea73c88ea0481c3173dcdfd73f9`
- commits_in_range: `2`

## Highlights

- Resolve the actual Codex CLI command/version used by RemoteBuddy and startup preflight, avoiding stale Windows shim/package resolution when `gpt-5.5` is enabled.
- Prefer the newest compatible Codex CLI probe for default launchers and log the selected command/version for future diagnosis.
- Add a one-shot RemoteBuddy fallback from default `gpt-5.5` to `gpt-5.4` only when Codex reports that the model requires a newer CLI.
- Add RemoteBuddy Codex regression tests and document Windows service-launcher checks in the AI model upgrade playbook.

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
