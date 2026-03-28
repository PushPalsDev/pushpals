# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.28`
- start_commit: `7afbb45dd3b6a95527483275236ce4d917866cfc`
- end_commit: `cda84148b233ce59d44851c4aa375307ef558468`
- commits_in_range: `2`

## Highlights

- Make `source_control_manager.review_agent.enabled` a true live runtime toggle so ReviewAgent polling can start or stop without restarting SourceControlManager.
- Harden the live review-agent reconfiguration path with single-flight protection and per-tick config snapshots so completions cannot switch review modes or spawn duplicate reviewers mid-flight.
- Align shared config tests with the supported `configs/` runtime layout so temporary fixture roots match the current `loadPushPalsConfig()` contract and the full suite stays green.

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
- Tag and push: `git tag v1.0.28 && git push origin v1.0.28`.

