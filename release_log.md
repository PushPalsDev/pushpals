# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.26`
- start_commit: `e1a5ba4910e4020590a6386d638071eda62d0dd9`
- end_commit: `2b586c0976968d3f064ff6f5e58ace21e19c404f`
- commits_in_range: `2`

## Highlights

- Add an autonomy WorkerPal failure circuit for repeated no-publishable/no-edit outcomes so background autonomy stops creating new jobs during unhealthy windows.
- Suppress repeated autonomy jobs that match recent no-publishable failures by pattern key or overlapping target paths, with structured retry metadata instead of another long WorkerPal attempt.
- Teach RemoteBuddy autonomy dispatch to honor structured enqueue rejections with a timed backoff, reducing repeat dispatch loops after safety gates fire.
- Add bounded WorkerPal cooldown metadata for OpenAI Codex no-publishable and broad/off-track timeout failures so retry storms pause after exhausted attempts.
- Ship the updated RemoteBuddy and WorkerPal sandbox runtime mirror in the packaged CLI assets.

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
- Active runtimes that were started from `v1.1.25` or earlier must be restarted after installing this release before the new autonomy failure circuits, dispatch backoff, and WorkerPal cooldown behavior take effect.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
