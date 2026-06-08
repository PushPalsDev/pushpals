# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.24`
- start_commit: `8a4f44050d49c0b1a7185e9815a89d143145f3e5`
- end_commit: `08d87215b101579bcdf74e1ccf2267c58a7c74a4`
- commits_in_range: `2`

## Highlights

- Add a 6-hour cooldown for repeated autonomy jobs that target the same file, preventing unhealthy retry storms on one narrow objective.
- Shorten OpenAI Codex no-edit and rollout watchdogs for narrow contract/test tasks so stuck jobs recover or fail faster instead of burning full execution windows.
- Strengthen no-edit recovery guidance with a patch-first contract that tells workers to make a publishable edit before repeating discovery.
- Mark no-edit watchdog and rollout-coach terminal diagnostics correctly so job investigations show watchdog-triggered failures instead of hiding them as generic terminal failures.
- Ship the updated RemoteBuddy and WorkerPal sandbox mirrors in the packaged CLI runtime assets.

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
- Active runtimes that were started from `v1.1.23` or earlier must be restarted after installing this release before autonomy dedupe cooldowns and faster narrow-task watchdogs take effect.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
