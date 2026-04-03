# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.33`
- start_commit: `4a315098561a4e25e397ab04689a2540172dead4`
- end_commit: `2ae0411f7e45d189d919a84ab19ff478b463ef88`
- commits_in_range: `4`

## Highlights

- Harden CLI startup and runtime readiness with better embedded Bun resolution coverage, startup diagnostics, and safer autonomous-engine guardrails around kill-switch and dirty-worktree conditions.
- Teach autonomy snapshots to pick up execution-health signals such as stalled objectives, blocked work, stale worker claims, and quality-gate revision churn so planning reacts to how work is actually progressing.
- Expand CLI and autonomy regression coverage to reduce startup, worker handoff, and runtime-policy regressions before publish.

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
- Tag and push: `git tag v1.0.33 && git push origin v1.0.33`.
