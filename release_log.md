# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.46`
- start_commit: `0ab97f613fb2e47d9ef52414c6294218c735ce22`
- end_commit: `9510350c4fad95d3ba72e3e9d7680a344e5fe9bf`
- commits_in_range: `1`

## Highlights

- Requeue Docker-backed WorkerPal jobs after persistent Codex startup stalls instead of marking the job terminally failed before RemoteBuddy can activate direct isolated-worktree fallback.
- Allow the server defer endpoint to explicitly clear `targetWorkerId` so replacement WorkerPals can claim infrastructure-retry jobs while preserving pinned maintenance defers by default.
- Add regression coverage for Docker Codex startup-stall handoff behavior and replacement-worker claiming of cleared-target deferred jobs.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun test tests/workerpals.session-events.test.ts`
- `bun test tests/server.jobs.stale-recovery.test.ts`
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
- The npm package still requires a working Bun runtime to launch the package entrypoint; PushPals does not vendor Bun or other external toolchains in the npm package.
- Direct GitHub release binaries are PushPals-built standalone artifacts. Removing embedded Bun runtime from those standalone artifacts would require a separate runtime distribution redesign.
- Active runtimes that were started from an older release must be restarted after installing this release before new startup or packaged-runtime behavior takes effect.
- Docker-backed WorkerPal execution can use a stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; if the replacement direct WorkerPal also cannot start Codex, that retry can still fail terminally and recycle the worker.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
