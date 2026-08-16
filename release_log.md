# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.34`
- start_commit: `afc99b94b068b34600720fc98c806a3905149366`
- end_commit: `2cbe75536f8c3cdcff5853f5027a8f564b97724b`
- commits_in_range: `1`

## Highlights

- Remove PushPals-managed `node_modules` projections before host-side Git finalization so valid Docker worker patches are not lost to Windows `git add -A` failures.
- Recognize Docker Desktop's opaque Linux symlinks when Windows exposes them as `EACCES` or `EINVAL` directory entries, and unlink only the worktree artifact without deleting the container-volume dependency snapshot.
- Fail finalization with a direct cleanup diagnostic if the managed artifact cannot be removed instead of continuing into an ambiguous Git staging error.
- Ship synchronized WorkerPal source, generated runtime bundles, native Windows-junction coverage, and an opt-in Windows-host/Linux-container regression test for the exact production boundary.

## Validation

- `bun run test:root` passed `1,165` tests with `5` intentional platform or opt-in skips and `0` failures on Windows with Bun 1.3.14.
- The focused Docker executor, review-finalization, and validation-command suites passed `102` tests with `1` intentional Linux-only skip and `0` failures.
- The opt-in Windows-host/Linux-container regression passed against a real Docker Desktop dependency projection and preserved the backing dependency snapshot after host cleanup.
- WorkerPals and shared-package TypeScript checks and packaged-runtime source parity passed.
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
- Active runtimes started from an older release must be restarted after installing this release before host-side dependency-projection cleanup takes effect.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
