# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.43`
- start_commit: `09c40ae7756616de6929b73cd691ff700adffd4c`
- end_commit: `a578abef20aa27df407d489168114875f7210940`
- commits_in_range: `1`

## Highlights

- Build Windows CLI and embedded runtime binaries natively on `windows-2022` instead of cross-compiling them on Ubuntu before release.
- Add a release-blocking Windows smoke test that boots the compiled `server` and `remotebuddy` binaries with autonomy enabled against a temp repo containing `vision.md`.
- Expand packaged CLI Windows E2E coverage to verify autonomy-enabled startup and ensure the release workflow consistently reads `release_log.md` when publishing GitHub Releases.

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
- Tag and push: `git tag v1.0.43 && git push origin v1.0.43`.
