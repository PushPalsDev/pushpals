# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.70`
- start_commit: `2967baf6f4adc82a389d5a64d3ab5cefe764fcff`
- end_commit: `3cf93a5473e9a960612dc46c5bbbed1c078d87b7`
- commits_in_range: `1`

## Highlights

- Default OpenAI Codex-backed LocalBuddy, RemoteBuddy, and WorkerPal config to `gpt-5.5`.
- Default Codex reasoning effort to `xhigh` for `gpt-5.5` and newer models.
- Preserve the legacy `gpt-5.4` compatibility fallback, including automatic reasoning downgrade to `high` when needed.
- Keep the packaged CLI runtime and WorkerPal sandbox copies in sync with the new Codex defaults.
- Strip UTF-8 BOMs before TOML parsing so Windows-edited config files do not silently fall back to older defaults.

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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal task execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
