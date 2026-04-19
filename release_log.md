# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.46`
- start_commit: `b373c6021edec61ad446d2c8075854f378e75c58`
- end_commit: `2e747aa4682987ef35b5d56082230fcc50576e56`
- commits_in_range: `1`

## Highlights

- Add a real `min_workerpals` warm-pool floor and raise the shipped autoscale ceiling to 4 workers.
- Expose a lightweight autoscale snapshot so RemoteBuddy can scale WorkerPals from queued `task.execute` backlog, including jobs enqueued directly by ReviewAgent and SourceControlManager.
- Preserve PR worker affinity by excluding jobs pinned to healthy workers from autoscale pressure while still counting them once the pinned worker becomes stale.

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
- Tag and push: `git tag v1.0.46 && git push origin v1.0.46`.
