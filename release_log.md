# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.27`
- start_commit: `e166836e6103a0b53e8415d667621d92d00c8b37`
- end_commit: `b814445246c729f952db70385b7c1303f85b944e`
- commits_in_range: `2`

## Highlights

- Recover OpenAI Codex WorkerPal jobs when the Codex subprocess stalls after only startup events, by restarting once with patch-first recovery guidance before failing the job.
- Classify repeated Codex startup stalls as `openai_codex stalled before first response` so diagnostics treat them as infrastructure/timeouts instead of no-publishable worker trajectories.
- Add regression coverage for both successful startup-stall recovery and repeated startup-stall cooldown behavior.
- Stabilize RemoteBuddy task enqueue failure coverage under full-suite load so release checks keep enforcing that failed enqueues do not emit orphan task lifecycle events.
- Ship the updated WorkerPal sandbox runtime mirror in the packaged CLI assets.

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
- Active runtimes that were started from `v1.1.26` or earlier must be restarted after installing this release before the new Codex startup-stall recovery behavior takes effect.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
