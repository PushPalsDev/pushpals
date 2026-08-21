# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.41`
- start_commit: `e6fc7370814902cdc5e15bba9e7d22b6f29481b1`
- end_commit: `d7c9e025fcca76744b859ea898129bd978e37a0e`
- commits_in_range: `4`

## Highlights

- Fence every WorkerPal job mutation with exact claim authority, require a confirmed execution-start boundary, and recover pre-start work without replaying already-started side effects.
- Keep runtime-failure circuits bounded and restart-safe with a single half-open canary, durable backlog release, corrected activity timestamps, and deduplicated diagnostics.
- Preserve completion ownership and durable request/autonomy links across legacy dedupe migrations, ambiguous callbacks, heartbeat recovery, and large deferred backlogs.
- Reconcile successful source-control publication when authoritative remote proof is briefly delayed instead of falsely marking the job `publish_blocked`.
- Improve WorkerPal convergence with docs-aware scope classification, recursive Docker dependency detection, stable failure identities, useful late failure excerpts, and one bounded near-threshold critic revision.
- Add focused lifecycle, migration, response-loss, publication, quality-gate, packaged-runtime, and process-boundary regressions, with concise component contracts in the wiki and app READMEs.

## Validation

- `bun run test:root` passed `1,528` tests with `12` intentional platform or opt-in skips, `0` failures, and `8,155` assertions across `150` files in a resource-bounded Bun 1.3.14 Linux container with Node and npm present.
- The OpenAI Codex executor Python suite passed all `119` tests, including the documentation-inspection and test-harness authority matrix.
- WorkerPal and SourceControlManager TypeScript builds passed, along with the focused publication-recovery, quality-gate, validation-safety, runtime-mirror, launch, and session suites.
- `bun run cli:bundle` completed and synchronized packaged runtime source and generated service bundles.
- `bun run cli:verify-package-payload` verified `260` package files with no external toolchain files.
- Changed WorkerPal source mirrors were byte-identical to their packaged copies, and both generated runtime bundles passed Node syntax checks and isolated packaged startup.
- `git diff --check` passed.

## Install

```bash
npm i -g @pushpalsdev/cli@1.2.41
```

```bash
bun install -g @pushpalsdev/cli@1.2.41
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
