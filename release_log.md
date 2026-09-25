# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.53`
- start_commit: `e4e2cc9a260e7a36645c50c7218df74bdef4bab0`
- end_commit: `7526a6df332d80ae6151f54c259f6b85ef06c26b`
- commits_in_range: `3`

## Highlights

- Prevent premature WorkerPal restarts during cold Docker image preparation. The supervisor and worker now share phase-aware deadlines and one absolute startup ceiling; progress cannot extend it indefinitely, and only an online registration counts as readiness.
- Bound startup subprocesses, stream draining, cancellation, and cleanup. Verify exact worker-owned Docker containers are removed before replacement, retain ownership when cleanup cannot be confirmed, and prevent delayed prewarm from spawning workers after shutdown.
- Retain PR repair candidates across target-branch updates and restarts. Reconcile against the current target and rerun required trusted validation before publication instead of dropping useful candidates or treating stale evidence as current.
- Ground autonomous work in repository priorities, non-goals, and implementation evidence. Honor an explicit empty Repository Agent result and defer unavailable analysis rather than inventing unsupported implementation tasks.
- Hold repeated browser-capture capability failures for resolution, preserving genuine validation failures and repair limits. Distinguish validation outcomes from later publication failures without granting failed jobs a passing result.
- Harden embedded runtime readiness and recovery, bound server request-body handling and SQLite startup contention, and report failed requests even when no jobs were created. Preserve unknown or incomplete history instead of presenting it as successful execution.
- Refresh packaged runtime bundles and source mirrors, require the new startup helpers in the npm payload, and expand startup, cancellation, container ownership, durable recovery, and health-report regression coverage.

## Validation

- Bun 1.3.14 passed the full CLI bundle and actual npm payload check in an isolated container limited to one CPU, 768 MiB memory, and 512 PIDs. The package contains `276` files and no external toolchains.
- The final pre-release `bun run test:root` passed `2,561` tests, with `12` platform/opt-in skips, `0` failures, and `14,749` assertions across `188` files (240.57 seconds).
- Focused startup and recovery checks passed `180` tests with `3` skips and no failures. RemoteBuddy and WorkerPal TypeScript checks passed. Generated startup/shared mirrors were independently checked against their canonical sources; formatting and diff checks passed.
- The consolidated reliability harness passed all seven phases, including Python worker watchdog and bounded runtime/repair contracts. Its runtime-boundary phase passed `636` tests with `6` skips and no failures. Local Docker-dependent opt-ins remained skipped because the isolated container has no Docker socket.
- Product commit `7526a6df332d80ae6151f54c259f6b85ef06c26b` passed cross-platform CLI E2E run `36077188043`: Windows runtime paths, recovery, trusted validation and isolated startup; Linux WorkerPal control-plane E2E and dependency projection; and packaged CLI E2E. The separate manual-only Windows-host Docker job was skipped as configured.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.53
```

```bash
bun install -g @pushpalsdev/cli@1.2.53
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.53
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

- Astra still requires account access and a compatible Codex CLI. Explicit custom launcher pins are preserved; users retaining an older custom pin may need to upgrade it themselves. The compatibility fallback does not grant model access or bypass authentication failures.
- The patched live Windows-host Docker cold start and a long-duration SectorCommand job-quality soak have not been demonstrated. This release does not guarantee 100% uptime or job success; genuine validation failures and substantive critic findings must still block publication.
- Cold image builds and pulls retain separate ten-minute limits, startup self-checks have five minutes, and the default shared absolute startup ceiling is 27.5 minutes. These are upper bounds, not expected warm-start latency or a guarantee that unavailable dependencies will recover.
- Capability holds do not provision missing browsers or repair users' tests. Unconfirmed worker cleanup intentionally delays replacement rather than risking duplicate workers or removal of unrelated containers.
- The npm entrypoint requires Node.js 20+ and at least one Bun 1.3.14+ installation. Standalone GitHub release binaries remain available when installing Bun is not practical.
- `PUSHPALS_BUN_BIN` is authoritative when set; unset or correct it if it points to a removed or outdated runtime.
- The immutable `v1.2.44`, `v1.2.45`, and `v1.2.46` tags remain unpublished on npm; install `v1.2.47` or newer.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled. `pushpals --clear` treats a stopped Docker daemon as a best-effort cleanup skip.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
