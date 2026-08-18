# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.36`
- start_commit: `dcda53b35d0bbefc6cab24d4d91b929b50d33484`
- end_commit: `5db403f17649d4342069c7fe07241b6011fd0510`
- commits_in_range: `1`

## Highlights

- Bound HTTP response bodies, subprocess output, service startup and shutdown, Git operations, and Windows/Linux process-tree cleanup so stalled dependencies fail safely instead of freezing PushPals.
- Add durable completion leases, heartbeats, stale-claim recovery, startup reconciliation, SourceControlManager stall health, and publication-backlog backpressure so work resumes after crashes and finalization cannot deadlock.
- Validate and publish exact candidate SHAs with retained trusted-host evidence, disposable-worktree recovery, authoritative publication proof, and fail-closed browser and no-change outcomes.
- Improve execution speed and job quality with LF-safe Linux worktrees, container-native dependency projection, focused and cached validation, repeated-failure circuit breakers, and end-to-end reliability metrics.
- Pin the WorkerPal sandbox to Bun 1.3.14 and block release publication on the cross-platform reliability harness.

## Validation

- `bun run test:root` passed `1,367` tests with `11` intentional platform or opt-in skips and `0` failures in the Bun 1.3.14 release container.
- The release reliability harness passed `211` tests with `5` intentional integration skips and `0` failures across failure evidence, durable lifecycle, repair orchestration, and runtime boundaries.
- CLI bootstrap and invocation suites passed `173` tests with `2` platform skips and `0` failures on Windows.
- Windows-host/Linux-container worktree boundary, Docker executor, sandbox runtime, dependency-projection, and exact-SHA publication integrations passed.
- Client, VS Code, SourceControlManager, WorkerPal, RemoteBuddy, and shared-package TypeScript checks passed.
- `bun run cli:bundle` completed and synchronized packaged runtime source and generated service bundles.
- `bun run cli:verify-package-payload` verified `260` package files with no external toolchain files.
- `git diff --check` passed.

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
