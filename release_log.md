# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.40`
- start_commit: `56d552bcd4e6c17e6ca182b994a1ebdc5982ed81`
- end_commit: `8c7e75f4ca9f57e74863c3a157352b76457d1657`
- commits_in_range: `1`

## Highlights

- Fix Windows installed-package shutdown so `pushpals --status-once` exits after printing its status snapshot instead of hanging after local runtime shutdown is accepted.
- Bound the Windows embedded-service `taskkill` path with an async timeout and direct-kill fallback, avoiding packaged CLI stalls when Windows process-tree termination wedges.
- Cancel managed service stdout/stderr readers during forced shutdown or service replacement so stopped child processes cannot leave the CLI event loop open.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun run test:cli:integration`
- `bun run test:root`
- Local packed npm tarball smoke on Windows: `scripts/release-installed-cli-smoke.ts` passed against a freshly packed `@pushpalsdev/cli@0.0.0-dev`, covering the installed `pushpals --status-once` shutdown path that failed in the `v1.1.39` release workflow.
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
