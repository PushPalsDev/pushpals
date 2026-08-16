# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.35`
- start_commit: `78a1e5f760df66f75b609178e9310626059cfac5`
- end_commit: `4f976a59fea4846d870d0236003836e884af0f0c`
- commits_in_range: `1`

## Highlights

- Stop unrelated successful candidates from repeatedly reopening retained trusted-validation failures. Recovery now requires the same command, the same baseline, a transient failure class, and no named failed-test evidence.
- Limit automatic trusted-host recovery to one retry, preventing unchanged candidates from cycling through publication for hours while preserving one retry after a demonstrable host recovery.
- Classify named test failures as `test_failure` even when their test names or teardown diagnostics mention timeouts; process exit code `124` remains an authoritative timeout signal.
- Reduce the default trusted-host command ceiling from 15 minutes to 8 minutes and ship the synchronized server, SourceControlManager, and shared runtime bundles.

## Validation

- `bun run test:root` passed `1,168` tests with `5` intentional platform or opt-in skips and `0` failures on Windows with Bun 1.3.14 after bundling.
- Focused completion-recovery and trusted-validation suites passed `39` tests with `0` failures, including same-baseline transient recovery, named-test blocking, cross-baseline blocking, the one-retry cap, startup reconciliation, and timeout-word classification.
- Server, SourceControlManager, and shared-package TypeScript checks passed.
- Protocol integration passed `44` checks with `0` failures.
- `bun run cli:bundle` completed and synchronized packaged runtime source and generated service bundles.
- `bun run cli:verify-package-payload` verified `257` package files with no external toolchain files.
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
- Active runtimes started from an older release must be restarted after installing this release before trusted-validation recovery and timeout behavior changes take effect.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
