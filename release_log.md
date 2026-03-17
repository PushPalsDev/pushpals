# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.13`
- start_commit: `6818f87eda320420ca20d376da5a3e4d61cd1f78`
- end_commit: `6818f87eda320420ca20d376da5a3e4d61cd1f78`
- commits_in_range: `1`

## Highlights

- Default `remotebuddy.autonomy.enabled` to `true` when unset so new local runtimes start with autonomy on.
- Keep CLI startup non-blocking when autonomy is explicitly disabled by config, with clear warning logs instead of hard-fail behavior.
- Add and update regression coverage for the new autonomy contract in CLI invocation logging and shared config parsing tests.

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
- Tag and push: `git tag v1.0.13 && git push origin v1.0.13`.
