# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.17`
- start_commit: `08ac71abf15b95f57209da9cde90923363be8566`
- end_commit: `e02e2949fece262281ad34d8e385266c4246082c`
- commits_in_range: `1`

## Highlights

- Avoid blocking Windows CLI startup on foreground WorkerPal sandbox image builds; WorkerPal warmup prepares the image after the CLI becomes responsive.
- Add `PUSHPALS_BLOCKING_WORKERPAL_IMAGE_BUILD=1` as an explicit opt-in for the old foreground image-build behavior.
- Bound WorkerPal startup capacity probes to short two-second status fetches so a slow worker-status endpoint cannot make startup look frozen.
- Preserve Linux/source-checkout behavior where foreground image preparation remains enabled by default.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `bun test tests\cli.runtime-bootstrap.test.ts --filter "waitForWorkerpalCapacity|blocking WorkerPal image builds"`

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
