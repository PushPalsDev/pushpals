# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.39`
- start_commit: `f9d617e9e6f2e6ab809b9c69c79bf7552d9ee957`
- end_commit: `51d328c825f3b24a7d9e28799a1afbb7ef56b3ba`
- commits_in_range: `5`

## Highlights

- On Windows, embedded runtime services now inherit a generated `NODE_EXTRA_CA_CERTS` bundle from the Windows root certificate store when no explicit CA bundle is configured. This lets Bun-based service fetches trust local corporate or antivirus TLS inspection roots without disabling TLS verification.
- Keep `pushpals --runtime-only` alive after stdin closes so headless monitoring runs do not immediately shut down the embedded runtime; explicit `exit`, SIGINT, or SIGTERM still stop it cleanly.
- Improve WorkerPal OpenAI Codex recovery by keeping watchdogs active across short remaining budgets and preserving time for validation/repair.
- Keep the repo workflow docs and Codex guardrails aligned around the direct-to-main commit sequence.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun run test:cli:integration`
- `bun run test:root`
- Source CLI live check in `SectorCommand`: verified embedded runtime stayed alive after stdin EOF, SourceControlManager started without the prior GitHub certificate error, and `/system/status` reported 1 idle worker with 0 failed jobs/requests.
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
- Docker-backed WorkerPal execution can use a stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; this release hardens budget preservation once Codex produces publishable changes, but the original Docker stall is still treated as a worker-recycle event.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
