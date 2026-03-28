# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.30`
- start_commit: `52a653b558994cfcc31bff76369079e9706d3662`
- end_commit: `7060604fbbaf0716175db309ee50d0b945e71dd2`
- commits_in_range: `1`

## Highlights

- Extend narrow file-targeted `task.execute` dedupe to autonomy-origin WorkerPal jobs so background autonomy work reuses an active same-file task instead of dispatching overlapping edits to the same target path.
- Add a stateful CLI session-event replay filter that suppresses duplicated `status` events during SSE reconnect/replay so RemoteBuddy and SourceControlManager status lines are not re-rendered repeatedly in the interactive CLI.
- Fix the WorkerPal quality-gate revision loop so deterministic validation failures independently trigger revision, and enrich revision guidance with critic `must_fix`, fallback `findings`, and `revision_guidance` details.

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
- Tag and push: `git tag v1.0.30 && git push origin v1.0.30`.

