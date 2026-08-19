# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.40`
- start_commit: `ab044b7b80150915e9636a101f3a5e0a4c4b310c`
- end_commit: `c60bd300072617790719327cf94f784fd8ac5272`
- commits_in_range: `1`

## Highlights

- Exclude WorkerPal-managed dependency artifacts from both API and Codex critic prompts, including the root `node_modules` reparse point that Windows Git reports without a trailing slash.
- Keep quality-critic scoring and revision guidance focused on publishable source and test changes while preserving the separate hygiene gate for genuine dependency-file churn.
- Apply the publishable-path boundary defensively inside critic diff construction and keep the source, packaged runtime mirror, and generated WorkerPal bundle synchronized.

## Validation

- `bun run test:root` passed `1,445` tests with `12` intentional platform or opt-in skips, `0` failures, and `7,002` assertions in a resource-bounded Bun 1.3.14 Linux container with Node and npm present.
- All four release reliability phases passed under the release limits on Linux and on Windows with the real packaged-image and Docker-volume integrations enabled; the final Windows runtime-boundary phase passed `259` tests with `3` intentional skips and `0` failures.
- The focused WorkerPal quality-gate regression suite passed `62` tests with `0` failures and `205` assertions, including root and nested dependency-artifact critic exclusions.
- Server, RemoteBuddy, WorkerPal, SourceControlManager, shared-package, and protocol TypeScript checks passed in the resource-bounded Linux container.
- `bun run cli:bundle` completed and synchronized packaged runtime source and generated service bundles.
- `bun run cli:verify-package-payload` verified `260` package files with no external toolchain files.
- `git diff --check` passed.
- The exact `@pushpalsdev/cli@1.2.40` tarball (`sha256:8525cb86f15bdf01354e2e31f597b5c09e9abe0bd79472510b8a9ac11eb26b8a`) and all five same-run Linux runtime candidates passed the installed-package cold-start smoke without downloading public runtime assets.

## Install

```bash
npm i -g @pushpalsdev/cli@1.2.40
```

```bash
bun install -g @pushpalsdev/cli@1.2.40
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
