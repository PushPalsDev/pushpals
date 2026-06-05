# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.20`
- start_commit: `5bc4702073bab2677b888a742b24818e8028b272`
- end_commit: `992614ad77155e7c7ebee567b3bc449461996033`
- commits_in_range: `2`

## Highlights

- Prevent WorkerPal jobs from starting from stale integration-branch checkouts when the configured source base has newer commits, avoiding missing-file validation failures caused by outdated `main_agents` worktrees.
- Keep custom WorkerPal base refs respected, while safely falling back from stale integration refs to the configured source base for normal jobs.
- Use cached local source-base refs when a best-effort fetch fails, so Windows Git certificate-store issues do not force workers back onto stale refs.
- Improve cold-start autonomy and WorkerPal readiness so startup leaves capacity for user work and avoids blocking foreground startup on sandbox image preparation.
- Ship the updated WorkerPal runtime and sandbox mirror in the packaged CLI assets.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `bun test tests\workerpals.worktree-base-ref.test.ts tests\workerpals.docker-executor.test.ts`

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
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
