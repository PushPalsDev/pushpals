# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.33`
- start_commit: `dbdf9f6a9dbbe63f1104f40c31d89132966b55c1`
- end_commit: `eeef91d4bb0e045a6d0c145a9ce175b463b872d6`
- commits_in_range: `1`

## Highlights

- Preserve current validation-safe container-native dependency projections during Expo Router browser validation instead of discarding them and rebuilding `node_modules` inside every worktree.
- Tell CriticGate exactly which validation commands are pending trusted-host execution so it does not send workers through impossible Docker-dependent revision loops.
- Prevent critic-only budget exhaustion from soft-passing candidates while trusted-host validation is still pending; those jobs must retain a real validation handoff or fail closed.
- Ship synchronized WorkerPal source, generated runtime bundles, and focused regression coverage for projection reuse, critic handoff context, and budget-exhaustion safety.

## Validation

- `bun run test` passed `1,164` tests with `5` intentional platform or opt-in skips and `0` failures on Windows with Bun 1.3.14.
- The focused validation-command and quality-gate suites passed `119` tests with `0` failures.
- WorkerPals TypeScript checks and packaged-runtime source parity passed.
- `bun run cli:bundle` completed and synchronized packaged runtime source and generated service bundles.
- `bun run cli:verify-package-payload` verified `257` package files with no external toolchain files.
- The opt-in Windows-host/Linux-container integration suite passed `35` tests with `1` intentional skip and `0` failures.
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
- Active runtimes started from an older release must be restarted after installing this release before dependency-projection reuse and trusted-validation handoff safeguards take effect.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
