# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.40`
- start_commit: `60f3bdf9fc0d7d04583c55b13c6d376dc39d74ca`
- end_commit: `a09ed11fb10395e52f8739967bfc1688c4187b34`
- commits_in_range: `1`

## Highlights

- Move merge-conflict Docker image refresh out of claimed-job lifetime by deferring the job, performing maintenance under idle heartbeats, and reclaiming only after the environment is ready.
- Retarget deferred maintenance jobs to the worker actually performing prep, add guarded deferred-failure handling, and prevent reclaim races when the original worker comes back.
- Add real-Docker integration coverage for the full `claim -> defer -> rebuild -> reclaim -> execute` WorkerPal flow so the merge-conflict path is pinned down end to end.

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
- Tag and push: `git tag v1.0.40 && git push origin v1.0.40`.
