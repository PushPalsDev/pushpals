# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.42`
- start_commit: `40a2a455940f2d1e0c996c33ebef3df2ba194c99`
- end_commit: `e437e27b50dba7d18cc8be941c9e7de13939bd6d`
- commits_in_range: `1`

## Highlights

- Add `pushpals --version` and `pushpals -V`, reporting the package, Bun runtime, and platform versions without requiring a Git repository or starting local services.
- Verify the exact installed-package and standalone-binary version during releases, with non-repository isolation, bounded output draining, and whole-process-tree timeout recovery.
- Replace the expired long-lived npm publication token with short-lived GitHub OIDC trusted publishing, while preserving immutable package checks and provenance.
- Require release publication from a real tag and build macOS artifacts on native, supported Intel and Arm runners.
- Add regression coverage for CLI early exit, installed version derivation, stuck descendant cleanup, OIDC workflow invariants, and standalone version injection.

## Validation

- `bun run test:root` passed `1,532` tests with `12` intentional platform or opt-in skips, `0` failures, and `8,203` assertions across `150` files in a resource-bounded Bun 1.3.14 Linux container with Node and npm present.
- The focused CLI, installed-release, release-workflow, and bounded-process regression suite passed all `41` tests.
- `bun run cli:bundle` completed in a clean Git checkout and produced no tracked runtime or monitor-UI changes.
- `bun run cli:verify-package-payload` verified `260` package files with no external toolchain files.
- A compiled Linux standalone CLI reported the injected `1.2.42` version and exited without repository discovery or runtime startup.
- Release workflow YAML parsing, Prettier, and `git diff --check` passed.

## Install

```bash
npm i -g @pushpalsdev/cli@1.2.42
```

```bash
bun install -g @pushpalsdev/cli@1.2.42
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
- `v1.2.41` was tagged but not published to npm; upgrade directly from `1.2.40` to `1.2.42`.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
