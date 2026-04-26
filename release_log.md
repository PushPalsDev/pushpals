# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.55`
- start_commit: `a0f6d18600f9880e5bb91f2961e783784c5b66f3`
- end_commit: `3e94b41e61a9c4a26d643bf9528d4b7303453f29`
- commits_in_range: `1`

## Highlights

- Harden cross-platform CLI Docker timeout recovery coverage so the timed-out inspect rebuild path still triggers when Docker inspect command shape changes between environments.
- Pin the merge-conflict WorkerPals end-to-end lane to deterministic Codex API-key auth so Linux and Windows CI no longer depend on interactive login state inside Docker-backed test runs.
- Revalidate the packaged CLI and WorkerPals control-plane E2E suites on both Windows and Linux to reduce stuck-job regressions before release.

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
