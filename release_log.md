# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.39`
- start_commit: `457594e419a469801cd297dd031aab6401fee297`
- end_commit: `011011989c0c67edf220277222302838cc6c97a6`
- commits_in_range: `2`

## Highlights

- Fix the generic Python executor's quiet-progress timer and fail closed when a backend times out, exits nonzero, loses its structured-result boundary, or leaves inherited pipes open after exit.
- Preserve authoritative WorkerPal-owned runtime failures, stacks, and diagnostics end to end while keeping task-code and environment failures outside the systemic runtime circuit.
- Persist runtime-generation circuit state across server restarts, bound every deferral recheck to 30 seconds, admit exactly one leased half-open canary, and release deferred work only after authoritative canary success.
- Correct stale-claim activity by fencing logs to the current claim generation, deduplicate repeated circuit logs, recover already-deferred work on restart, and surface deferral persistence errors instead of silently losing ownership.
- Keep delegated requests nonterminal until their exact WorkerPal handoff finishes, atomically repoint stale retries to their successor, and reconcile legacy retry chains on startup and watchdog ticks.
- Promote one immutable CLI tarball and the exact same-run runtime candidates through reliability and publication, including Linux and Windows installed-package smoke coverage.

## Validation

- `bun run test:root` passed `1,445` tests with `12` intentional platform or opt-in skips and `0` failures in a resource-bounded Bun 1.3.14 Linux container with Node and npm present.
- All four release reliability phases passed on Linux with dependency-projection integration enabled and on Windows with the real packaged-image and Docker-volume integrations enabled; the final Windows runtime-boundary phase passed `259` tests with `3` intentional skips and `0` failures.
- The affected circuit, stale-recovery, request-projection, executor, transport, release-contract, and OpenHands suites passed `255` tests with `4` intentional skips and `0` failures before the full release gates.
- Server, RemoteBuddy, WorkerPal, SourceControlManager, shared-package, and protocol TypeScript checks passed in the resource-bounded Linux container.
- `bun run cli:bundle` completed and synchronized packaged runtime source and generated service bundles.
- `bun run cli:verify-package-payload` verified `260` package files with no external toolchain files.
- `git diff --check` passed.
- The exact `@pushpalsdev/cli@1.2.39` tarball and all five same-run Linux runtime candidates passed the installed-package cold-start smoke without downloading public runtime assets.

## Install

```bash
npm i -g @pushpalsdev/cli@1.2.39
```

```bash
bun install -g @pushpalsdev/cli@1.2.39
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
