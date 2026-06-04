# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.18`
- start_commit: `9c0f41ee9f323a9bb266f8130773cb2cbf3a2d8a`
- end_commit: `a117fe7be8594ce4471e80830f76ee90200dbbbf`
- commits_in_range: `1`

## Highlights

- Fix WorkerPal warm-container execution after the stdin-spec transport change by supporting both Web `WritableStream` and Bun `FileSink` stdin shapes.
- Keep `docker exec` stdin attached with `-i` so the in-container job runner receives the streamed job spec instead of an empty payload.
- Sync the packaged CLI sandbox WorkerPal runtime so installed CLI releases receive the same fix.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `bun test tests\workerpals.docker-executor.test.ts`

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
