# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.12`
- start_commit: `1d1ad57cd1170350d4f9b8f02ca328980bf0f9d6`
- end_commit: `1d1ad57cd1170350d4f9b8f02ca328980bf0f9d6`
- commits_in_range: `1`

## Highlights

- Unify the server-side client message ingress so `/sessions/:id/message` and in-process `SessionManager.handleMessage()` share the same validation, enqueue, error, and event-emission contract.
- Route RemoteBuddy request processing, assistant replies, task/job events, context, and persistent memory by the claimed request session instead of leaking everything through the runtime default session.
- Add pooled multi-session RemoteBuddy event monitoring and regression coverage proving a request claimed for one session produces replies on that same session.

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
- Tag and push: `git tag v1.0.12 && git push origin v1.0.12`.
