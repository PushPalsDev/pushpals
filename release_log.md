# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.19`
- start_commit: `17350c390e108bac71f0815c8c3d8cd17aa19112`
- end_commit: `17350c390e108bac71f0815c8c3d8cd17aa19112`
- commits_in_range: `1`

## Highlights

- Move embedded WorkerPal sandbox image preparation out of the cold-start-only path so the CLI also repairs or validates the local Docker image before attaching to an already-healthy same-repo runtime.
- Add a shared embedded WorkerPal image precheck helper that resolves the runtime tag once, reuses the Docker precheck environment, and keeps startup and attach behavior on the same contract.
- Propagate `PUSHPALS_RUNTIME_TAG` into embedded runtime child environments so WorkerPals can verify whether a local sandbox image matches the active runtime release.
- Teach DockerExecutor to rebuild the local WorkerPal sandbox image when the local image is missing, unlabeled, or stale for the current runtime tag before falling back to registry pulls.
- Stop treating `bun.lockb` as a text runtime asset in GitHub source-tag downloads to avoid corrupting binary lockfiles in the sandbox build context.
- Replace recursive sandbox source copying with tracked-file-only copies so packaged runtime assets do not pick up ignored local artifacts such as `__pycache__` or other machine-specific junk.
- Update `sync-cli-runtime-assets` to build the packaged sandbox tree from tracked repo files and only include `bun.lock` when present.
- Extend CLI runtime bootstrap coverage for runtime-tag propagation, tracked-only sandbox copying, embedded image prep on attached runtimes, and source-download behavior that skips `bun.lockb`.

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

- None.

## Release Checklist

- Confirm `release_log.md` content before tagging.
- Tag and push: `git tag v1.0.19 && git push origin v1.0.19`.

