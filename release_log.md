# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.25`
- start_commit: `d6ffb6d1c1112be2d0a6bbac079895d22b5ec564`
- end_commit: `585b57a0ba94545fdcba27f3cfed32acb9669b84`
- commits_in_range: `4`

## Highlights

- Shorten no-edit recovery for stuck OpenAI Codex WorkerPal jobs so off-track tasks fail or recover faster instead of burning a full execution window.
- Skip low-value critic retries after deterministic fast validation failures, preserving remaining job budget for actionable repair attempts.
- Reduce duplicate cooldowns for narrow contract/test retry families so WorkerPals can respond to active validation noise without waiting through stale long cooldowns.
- Sanitize stale planner path hints before WorkerPal execution, including stale prose guidance, so workers do not chase nonexistent repo prefixes such as outdated client/app paths.
- Ship the updated WorkerPal sandbox mirror in the packaged CLI runtime assets.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`

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
- Active runtimes that were started from `v1.1.24` or earlier must be restarted after installing this release before stale-path sanitization and faster WorkerPal recovery behavior take effect.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
