# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.38`
- start_commit: `457594e419a469801cd297dd031aab6401fee297`
- end_commit: `65e16d402200b200783b45454b11156079261cbd`
- commits_in_range: `1`

## Highlights

- Fix the generic Python executor's quiet-progress timer so WorkerPals no longer crash with `Cannot access 'timedOut' before initialization` immediately after claiming a job.
- Preserve authoritative WorkerPal runtime failures end to end, distinguish them from artifact-only task failures, and defer a repeated normalized runtime signature after two failures instead of admitting an endless stream of doomed work.
- Keep delegated requests nonterminal until their exact WorkerPal handoff finishes, atomically repoint stale retries to their successor, and reconcile legacy retry chains on startup and watchdog ticks.
- Bound blocked queue scans while allowing later runnable user work to advance, and expose delegated/end-to-end request state consistently in LocalBuddy and the monitor UI.
- Build one immutable CLI tarball, checksum and test that exact tarball and its Linux worker image, then publish the same artifact without rebuilding in the publish job.

## Validation

- `bun run test:root` passed `1,399` tests with `12` intentional platform or opt-in skips and `0` failures in a resource-bounded Bun 1.3.14 Linux container with Node and npm present.
- All four release reliability phases passed with no timeouts or failures; the runtime-boundary phase passed `233` tests with `3` intentional integration skips.
- The affected diagnostic, queue, retry-chain, executor, and package suites passed `171` tests with `1` opt-in Docker skip and `0` failures before the exact-image gate.
- The exact packed WorkerPal runtime passed all `6` source-parity and Linux release-image tests, including the formerly crashing quiet-progress path.
- Client, LocalBuddy, RemoteBuddy, server, WorkerPal, and shared-package TypeScript checks passed.
- `bun run cli:bundle` completed and synchronized packaged runtime source and generated service bundles.
- `bun run cli:verify-package-payload` verified `260` package files with no external toolchain files.
- `git diff --check` passed.
- Release workflow and package contract coverage passed `20` tests with `0` failures, including immutable artifact promotion and full sandbox mirror enforcement.

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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled. `pushpals --clear` treats a stopped Docker daemon as a best-effort cleanup skip.
- Active runtimes started from an older release must be restarted after installing this release before the new lifecycle, publication, and timeout behavior takes effect.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
